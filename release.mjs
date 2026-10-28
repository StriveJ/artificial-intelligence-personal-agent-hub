import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildReleasePayload, releaseSourcePath, canonical, sha256, verifyRelease, verifyReleaseEnvelope } from './lib/release-package.mjs';
import { readJson } from './lib/storage.mjs';

function committedFiles(root,commit) {
  const run=(args,options={})=>execFileSync('git',['-C',root,...args],{stdio:'pipe',maxBuffer:64*1024*1024,...options});
  const rows=run(['ls-tree','-rz','--full-tree',commit]).toString('utf8').split('\0').filter(Boolean).filter(line=>releaseSourcePath(line.slice(line.indexOf('\t')+1))).map(line=>{
    const m=line.match(/^(100644|100755) blob ([a-f0-9]+)\t(.+)$/);if(!m)throw Error("Release objects must be regular files");return {oid:m[2],path:m[3]};
  });
  if(!rows.length||rows.length>1000)throw Error("Invalid release file set");
  const bytes=run(['cat-file','--batch'],{input:rows.map(row=>row.oid).join('\n')+'\n'}),files=new Map();let offset=0;
  for(const row of rows){const end=bytes.indexOf(10,offset),m=bytes.subarray(offset,end).toString('ascii').match(/^([a-f0-9]+) blob (\d+)$/);if(end<0||!m||m[1]!==row.oid)throw Error("Invalid release object response");const size=Number(m[2]),start=end+1,finish=start+size;if(!Number.isSafeInteger(size)||finish>=bytes.length||bytes[finish]!==10)throw Error("Release object truncated");files.set(row.path,bytes.subarray(start,finish));offset=finish+1;}
  if(offset!==bytes.length)throw Error("Unexpected trailing release object content");return files;
}
const fingerprint=key=>sha256(createPublicKey(key).export({type:'spki',format:'der'}));

try {
  const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  if (args[0] === 'keygen') {
    if (!option('--out')) throw new Error("--out <offline-signing-directory> is required"); const out = resolve(option('--out')); mkdirSync(out, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'), keyId = option('--key-id', 'personal-release-1');
    writeFileSync(join(out, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(out, 'trust.json'), JSON.stringify({ keys: { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }) } }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log("Signing key saved. Distribute only trust.json to installation devices.");
  } else if (['pack','prepare'].includes(args[0])) {
    const root = resolve(option('--source', '.')), git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (git('status', '--porcelain')) throw new Error("Source is not frozen. Review and commit local changes before packaging.");
    const releaseId = option('--id'), version = option('--version'), sequence = Number(option('--sequence'));
    if (!releaseId || !version || !Number.isSafeInteger(sequence) || sequence < 1 || args[0]==='pack'&&!option('--key') || !option('--out')) throw new Error("--id, --version, --sequence, and --out are required; pack also requires --key");
    const createdAt = new Date().toISOString();
    const manifest = { releaseId, version, sequence, sourceCommit: git('rev-parse', 'HEAD'), createdAt, expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), roles: ['main', 'sub'], platforms: ['win32', 'linux'], architectures: ['x64'], minNodeMajor: 24, minUpdaterVersion: 1, minGitVersion: '2.31.0', hubProtocol: 1, readRuntimeSchemas: [1], writeRuntimeSchema: 1, readInstanceFormats: [1], writeInstanceFormat: 1, maintenanceBoot: true };
    const sourceFiles=committedFiles(root,manifest.sourceCommit);
    if(JSON.parse(sourceFiles.get('package.json')).version!==version)throw Error("Release version differs from package.json at the fixed commit");
    const payload=buildReleasePayload({source:root,manifest,sourceFiles}),payloadSha256=sha256(canonical(payload));
    if(git('rev-parse','HEAD')!==manifest.sourceCommit||git('status','--porcelain'))throw Error("Source changed while packaging");
    let output={schema:1,kind:'aipa-hub-signing-request',payload,payloadSha256};
    if(args[0]==='pack'){const privateKey=readFileSync(resolve(option('--key')));output={payload,keyId:option('--key-id','personal-release-1'),signature:sign(null,Buffer.from(canonical(payload)),privateKey).toString('base64')};}
    writeFileSync(resolve(option('--out')),JSON.stringify(output),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({releaseId,sourceCommit:manifest.sourceCommit,files:Object.keys(payload.manifest.files).length,payloadSha256,kind:args[0]==='prepare'?'unsigned-request':'signed-package'}));
  } else if(args[0]==='sign') {
    if(!option('--request')||!option('--key')||!option('--out')||!option('--key-id')||!option('--expected-payload-sha256'))throw Error("--request, --key, --key-id, --expected-payload-sha256, and --out are required");
    const request=readJson(resolve(option('--request'))),payload=request?.payload;
    if(request?.schema!==1||request.kind!=='aipa-hub-signing-request'||request.payloadSha256!==sha256(canonical(payload))||request.payloadSha256!==option('--expected-payload-sha256'))throw Error("Signing request digest mismatch");
    const privateKey=readFileSync(resolve(option('--key'))),keyId=option('--key-id'),keyFingerprint=fingerprint(privateKey);
    if(option('--expected-key-sha256')&&option('--expected-key-sha256')!==keyFingerprint)throw Error("Signing public key fingerprint mismatch");
    const envelope={payload,keyId,signature:sign(null,Buffer.from(canonical(payload)),privateKey).toString('base64')};
    const output=resolve(option('--out')),trust={keys:{[keyId]:createPublicKey(privateKey).export({type:'spki',format:'pem'})}};
    if(payload?.manifest?.version!==JSON.parse(Buffer.from(payload?.contents?.['package.json']||'','base64')).version)throw Error("Signing request version differs from program version");
    for(const role of ['main','sub'])for(const platform of ['win32','linux'])verifyReleaseEnvelope(envelope,trust,{role,platform,arch:'x64'});
    writeFileSync(output,JSON.stringify(envelope),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({releaseId:payload.manifest.releaseId,payloadSha256:request.payloadSha256,keyId,keyFingerprint,packageSha256:sha256(readFileSync(output))}));
  } else if(args[0]==='verify') {
    if(!option('--package')||!option('--trust'))throw Error("--package and --trust are required");
    const packageFile=resolve(option('--package')),trust=readJson(resolve(option('--trust'))),checked=verifyRelease(packageFile,trust,{role:'main'});
    for(const role of ['main','sub'])for(const platform of ['win32','linux'])verifyRelease(packageFile,trust,{role,platform,arch:'x64'});
    const keyId=checked.envelope.keyId,keyFingerprint=fingerprint(trust.keys[keyId]);
    if(option('--expected-key-sha256')&&option('--expected-key-sha256')!==keyFingerprint)throw Error("Trust public key fingerprint mismatch");
    console.log(JSON.stringify({releaseId:checked.manifest.releaseId,sourceCommit:checked.manifest.sourceCommit,version:checked.manifest.version,digest:checked.digest,packageSha256:sha256(readFileSync(packageFile)),payloadSha256:sha256(canonical(checked.envelope.payload)),keyId,keyFingerprint}));
  } else throw new Error("Usage: node release.mjs <keygen|prepare|sign|pack|verify> ...");
} catch (error) { console.error(error.message); process.exitCode = 1; }
