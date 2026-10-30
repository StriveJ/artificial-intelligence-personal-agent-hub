import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {verifyRelease,buildReleasePayload} from '../lib/release-package.mjs';
import {posix} from 'node:path';

test('Runtime release payload includes all static program imports and the locale registry while excluding development tools',()=>{
 const source=resolve('.'),payload=buildReleasePayload({source,manifest:{}}),paths=new Set(Object.keys(payload.contents));
 for(const path of ['public/i18n.js','public/languages.js','public/locales/en.js','public/locales/zh-CN.js','lib/site-settings.mjs','lib/ui-locale-validation.mjs'])assert.ok(paths.has(path),path);
 for(const path of ['config.main.example.json','aipa-test-tmp','scripts/ui-locales.mjs'])assert.equal(paths.has(path),false,path);
 const modules=Object.fromEntries([...paths].filter(path=>/\.(?:mjs|js)$/.test(path)).map(path=>[path,Buffer.from(payload.contents[path],'base64').toString('utf8')]));
 const parsed=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',"import {SourceTextModule} from 'node:vm'; let input=''; for await(const chunk of process.stdin)input+=chunk; console.log(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(input)).map(([path,source])=>[path,new SourceTextModule(source).dependencySpecifiers]))));"],{input:JSON.stringify(modules),encoding:'utf8',windowsHide:true});
 assert.equal(parsed.status,0,parsed.stderr);
 for(const [path,imports] of Object.entries(JSON.parse(parsed.stdout))){
  for(const specifier of imports){
   if(!specifier.startsWith('.'))continue;
   const target=posix.resolve('/',posix.dirname(path),specifier).slice(1);
   assert.ok(paths.has(target),`${path} imports ${target}, which must exist in the runtime package`);
  }
 }
});

test("Release CLI declares accepted Windows/Linux x64 only, binds source commits, and rejects dirty source",t=>{
  const parent=resolve('aipa-test-tmp');mkdirSync(parent,{recursive:true});
  const work=mkdtempSync(join(parent,'release-cli-'));
  t.after(()=>{assert.ok(realpathSync(work).startsWith(realpathSync(parent)+sep));rmSync(work,{recursive:true,force:true});});
  const source=join(work,'source');mkdirSync(source);
  for(const name of ['main-server.mjs','sub-server.mjs'])writeFileSync(join(source,name),'// Synthetic public entry\n');
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'synthetic-release',version:'0.0.0-test',type:'module'}));
  writeFileSync(join(source,'LICENSE'),'Synthetic Apache-2.0 license fixture\n');
  writeFileSync(join(source,'INTERNAL-DESIGN.md'),'Synthetic internal draft; excluded from runtime package\n');
  const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-C',source,...args],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
  git(['init']);git(['add','--all']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic release source']);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),key=join(work,'synthetic-private.pem'),keyId='synthetic-only',trust={keys:{[keyId]:publicKey.export({type:'spki',format:'pem'})}};
  writeFileSync(key,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const entry=fileURLToPath(new URL('../release.mjs',import.meta.url)),output=join(work,'synthetic.hubpkg.json');
  const args=['pack','--source',source,'--id','synthetic-release-policy','--version','0.0.0-test','--sequence','1','--key',key,'--key-id',keyId,'--out',output];
  execFileSync(process.execPath,[entry,...args],{stdio:'pipe',windowsHide:true});
  const envelope=JSON.parse(readFileSync(output)),manifest=envelope.payload.manifest;
  assert.equal(Buffer.from(envelope.payload.contents.LICENSE,'base64').toString(),'Synthetic Apache-2.0 license fixture\n');
  assert.equal(envelope.payload.contents['INTERNAL-DESIGN.md'],undefined);
  assert.equal(manifest.sourceCommit,git(['rev-parse','HEAD']));
  assert.deepEqual([...manifest.platforms].sort(),['linux','win32']);
  assert.deepEqual(manifest.architectures,['x64']);
  for(const platform of ['win32','linux'])verifyRelease(output,trust,{role:'main',platform,arch:'x64'});
  for(const [platform,arch] of [['darwin','x64'],['linux','arm64']])assert.throws(()=>verifyRelease(output,trust,{role:'main',platform,arch}),/incompatible/i);
  writeFileSync(join(source,'main-server.mjs'),'// Changed synthetic source\n');
  const rejected=spawnSync(process.execPath,[entry,...args.slice(0,-1),join(work,'dirty.hubpkg.json')],{encoding:'utf8',windowsHide:true});
  assert.equal(rejected.status,1);assert.match(rejected.stderr,/not frozen/i);
});

test("Different line-ending checkouts of one commit produce identical signed payload files without binary conversion",t=>{
 const parent=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(parent,{recursive:true});const work=mkdtempSync(join(parent,'release-eol-'));
 t.after(()=>{assert.ok(realpathSync(work).startsWith(realpathSync(parent)+sep));rmSync(work,{recursive:true,force:true});});
 const source=join(work,'source');mkdirSync(source);mkdirSync(join(source,'public'));
 for(const name of ['main-server.mjs','sub-server.mjs'])writeFileSync(join(source,name),'// Synthetic LF public entry\n');
 writeFileSync(join(source,'public','binary.dat'),Buffer.from([0,255,13,10,128]));
 writeFileSync(join(source,'package.json'),JSON.stringify({name:'synthetic-release',version:'0.0.0-test',type:'module'})+'\n');
 const git=(cwd,args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-C',cwd,...args],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
 git(source,['init']);git(source,['config','core.autocrlf','false']);git(source,['add','--all']);git(source,['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic source']);
 const pair=generateKeyPairSync('ed25519'),key=join(work,'synthetic-key.pem');writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const entry=fileURLToPath(new URL('../release.mjs',import.meta.url)),packages=[];
 for(const setting of ['false','true']){
  const clone=join(work,'clone-'+setting),output=join(work,'package-'+setting+'.json');git(work,['clone','--config','core.autocrlf='+setting,'--no-local',source,clone]);assert.equal(git(clone,['status','--porcelain']),'');
  execFileSync(process.execPath,[entry,'pack','--source',clone,'--id','synthetic-eol','--version','0.0.0-test','--sequence','1','--key',key,'--key-id','synthetic-only','--out',output],{stdio:'pipe',windowsHide:true});
  packages.push(JSON.parse(readFileSync(output)).payload);
 }
 assert.deepEqual(packages[0].contents,packages[1].contents);assert.deepEqual(packages[0].manifest.files,packages[1].manifest.files);
 assert.deepEqual(Buffer.from(packages[0].contents['public/binary.dat'],'base64'),Buffer.from([0,255,13,10,128]));
});

test("Offline signing requests bind frozen digests; bad fingerprints or tampering produce no package and valid signatures reverify",t=>{
 const parent=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(parent,{recursive:true});const work=mkdtempSync(join(parent,'release-offline-'));
 t.after(()=>{assert.ok(realpathSync(work).startsWith(realpathSync(parent)+sep));rmSync(work,{recursive:true,force:true});});
 const source=join(work,'source');mkdirSync(source);
 for(const name of ['main-server.mjs','sub-server.mjs'])writeFileSync(join(source,name),'// Synthetic public entry\n');
 writeFileSync(join(source,'package.json'),JSON.stringify({version:'0.0.0-test'}));
 const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-C',source,...args],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
 git(['init']);git(['add','--all']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic source']);
 const entry=fileURLToPath(new URL('../release.mjs',import.meta.url)),request=join(work,'request.json');
 const run=args=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8',windowsHide:true});
 const prepared=run(['prepare','--source',source,'--id','synthetic-offline','--version','0.0.0-test','--sequence','1','--out',request]);
 assert.equal(prepared.status,0,prepared.stderr);
 const input=JSON.parse(readFileSync(request)),keyDir=join(work,'keys');assert.equal(run(['keygen','--out',keyDir,'--key-id','synthetic-only']).status,0);
 const output=join(work,'signed.json'),signArgs=['sign','--request',request,'--key',join(keyDir,'private.pem'),'--key-id','synthetic-only','--expected-payload-sha256',input.payloadSha256,'--out',output];
 const badFingerprint=run([...signArgs,'--expected-key-sha256','0'.repeat(64)]);
 assert.equal(badFingerprint.status,1);assert.equal(existsSync(output),false);
 const signed=run(signArgs);assert.equal(signed.status,0,signed.stderr);const identity=JSON.parse(signed.stdout);
 const verified=run(['verify','--package',output,'--trust',join(keyDir,'trust.json'),'--expected-key-sha256',identity.keyFingerprint]);
 assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).payloadSha256,input.payloadSha256);
 const repeat=join(work,'repeat.json');assert.equal(run([...signArgs.slice(0,-1),repeat]).status,0);assert.deepEqual(readFileSync(output),readFileSync(repeat));
 const changed=structuredClone(input);changed.payload.contents['main-server.mjs']=Buffer.from('// Changed public entry\n').toString('base64');
 writeFileSync(request,JSON.stringify(changed));const rejected=run([...signArgs.slice(0,-1),join(work,'rejected.json')]);
 assert.equal(rejected.status,1);assert.match(rejected.stderr,/digest mismatch/i);assert.equal(existsSync(join(work,'rejected.json')),false);
});
