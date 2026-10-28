import { createHash, sign, verify, createPublicKey, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { readJson, writeJson, safeInstancePath } from './storage.mjs';

export const UPDATER_VERSION = 1;
export const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const releaseIdOK = id => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(id) && !id.includes('..');
const fail = message => { throw new Error(message); };
const validPath = p => typeof p === 'string' && p.length < 200 && p.split('/').every(s => /^[a-zA-Z0-9_.-]+$/.test(s) && !['.', '..', '.git'].includes(s) && !s.endsWith('.') && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s));

export const releaseSourcePath = path => /^(?:lib|public)(?:\/|$)/.test(path) || /^(?:server|main-server|sub-server|run-instance-task|task-hook)\.mjs$|^package(?:-lock)?\.json$|^LICENSE$/.test(path);
export function buildReleasePayload({ source, manifest, sourceFiles }) {
  const files = {}; let total = 0;
  function add(path,bytes) {
    if(!validPath(path)||!releaseSourcePath(path)||!Buffer.isBuffer(bytes))fail("Unsafe release file path or content");
    total+=bytes.length;
    if(bytes.length>2_000_000||total>32_000_000||Object.keys(files).length>=1000)fail("Too many or oversized release files");
    files[path]={size:bytes.length,sha256:sha256(bytes),content:bytes.toString('base64')};
  }
  function walk(relative='') {
    for(const entry of readdirSync(join(source,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      const path=[relative,entry.name].filter(Boolean).join('/');
      if(!relative&&!releaseSourcePath(path))continue;
      if(!validPath(path)||entry.isSymbolicLink())fail("Unsafe release source path");
      if(entry.isDirectory())walk(path);else if(entry.isFile())add(path,readFileSync(join(source,path)));
    }
  }
  if(sourceFiles)for(const [path,bytes]of [...sourceFiles].sort(([a],[b])=>a<b?-1:a>b?1:0))add(path,bytes);
  else walk();
  return {manifest:{...manifest,packageFormat:1,files:Object.fromEntries(Object.entries(files).map(([p,{size,sha256}])=>[p,{size,sha256}]))},contents:Object.fromEntries(Object.entries(files).map(([p,{content}])=>[p,content]))};
}
export function buildRelease({ source, manifest, privateKey, keyId, sourceFiles }) {
  const payload = buildReleasePayload({source,manifest,sourceFiles});
  return { payload, keyId, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') };
}

export function verifyRelease(packageFile, trust, options = {}) {
  if (lstatSync(packageFile).size > 48_000_000) fail("Release package too large");
  return verifyReleaseEnvelope(readJson(packageFile,null),trust,options);
}
export function verifyReleaseEnvelope(envelope, trust, { role, platform = process.platform, arch = process.arch, allowExpired = false, now = Date.now() } = {}) {
  if (Buffer.byteLength(JSON.stringify(envelope)) > 48_000_000) fail("Release package too large");
  const publicKey = trust?.keys?.[envelope?.keyId];
  if (!publicKey || createPublicKey(publicKey).asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(envelope.payload)), publicKey, Buffer.from(envelope.signature || '', 'base64'))) fail("Untrusted release signature");
  const m = envelope.payload.manifest;
  if (m.packageFormat !== 1 || !releaseIdOK(m.releaseId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(m.sourceCommit) || typeof m.version !== 'string' || m.version.length > 80 || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Number.isFinite(Date.parse(m.expiresAt)) || !Number.isFinite(Date.parse(m.createdAt)) || Date.parse(m.createdAt) > now + 300_000 || !allowExpired && Date.parse(m.expiresAt) <= now) fail("Invalid or expired release metadata");
  if (!['main', 'sub'].includes(role) || !m.roles?.includes(role) || !m.platforms?.includes(platform) || !m.architectures?.includes(arch) || m.minNodeMajor > Number(process.versions.node.split('.')[0]) || m.minUpdaterVersion > UPDATER_VERSION || m.hubProtocol !== 1 || m.writeRuntimeSchema !== 1 || !m.readRuntimeSchemas?.includes(1) || m.writeInstanceFormat !== 1 || !m.readInstanceFormats?.includes(1) || m.maintenanceBoot !== true) fail("Release is incompatible with this platform, protocol, or data format");
  const paths = Object.keys(m.files || {}), contents = envelope.payload.contents;
  if (!paths.length || paths.length > 1000 || paths.length !== Object.keys(contents || {}).length || !paths.includes(`${role}-server.mjs`)) fail("Incomplete release file manifest");
  const names = new Set(); let size = 0;
  for (const path of paths) {
    if (!validPath(path) || path === 'release.json' || names.has(path.toLowerCase())) fail("Release file path or case collision"); names.add(path.toLowerCase());
    const bytes = Buffer.from(contents[path] || '', 'base64'), expected = m.files[path]; size += bytes.length;
    if (bytes.length > 2_000_000 || bytes.length !== expected.size || sha256(bytes) !== expected.sha256 || size > 32_000_000) fail("Release file verification failed");
  }
  return { manifest: m, contents, digest: sha256(canonical(envelope)), envelope };
}

export function stageRelease(releasesDir, checked) {
  const path = resolve(releasesDir, checked.manifest.releaseId); mkdirSync(releasesDir, { recursive: true });
  safeInstancePath(releasesDir, path);
  const proof = join(releasesDir, `${checked.manifest.releaseId}.hubpkg.json`);
  if (existsSync(proof)) { if (sha256(canonical(readJson(proof))) !== checked.digest) fail("Staged signed package was modified"); }
  else writeJson(proof, checked.envelope);
  if (existsSync(path)) {
    if (readJson(join(path, 'release.json'), null)?.digest !== checked.digest) fail("Cannot overwrite an existing release ID");
    verifyInstalled(path, checked.manifest); return path;
  }
  const staging = path + '.staging-' + randomUUID(); mkdirSync(staging, { mode: 0o700 });
  for (const [relative, bytes] of Object.entries(checked.contents)) {
    const file = safeInstancePath(staging, join(staging, relative)); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(bytes, 'base64'), { mode: 0o600, flag: 'wx' });
  }
  writeJson(join(staging, 'release.json'), { manifest: checked.manifest, digest: checked.digest }); renameSync(staging, path); return path;
}
export function verifyInstalled(path, manifest) {
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = safeInstancePath(path, join(path, relative)); if (!lstatSync(file).isFile() || sha256(readFileSync(file)) !== expected.sha256) fail("Staged release was modified");
  }
}
