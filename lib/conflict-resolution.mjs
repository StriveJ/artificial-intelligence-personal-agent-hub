import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, lstatSync, existsSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {eventIdentity,eventContentHash} from './event-semantics.mjs';
import { writeJson, safeInstancePath } from './storage.mjs';
const execute = promisify(execFile);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = result => typeof result === 'string' ? result : result.text;
function mergeJSON(base, local, remote) {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  if ([local, remote].every(v => v && typeof v === 'object' && !Array.isArray(v)) && (base === undefined || base && typeof base === 'object' && !Array.isArray(base))) {
    const result = {};
    for (const key of [...new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])].sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error("Special JSON fields require review");
      const value = mergeJSON(base?.[key], local[key], remote[key]); if (value !== undefined) result[key] = value;
    }
    return result;
  }
  if (Array.isArray(local) && Array.isArray(remote) && (base === undefined || Array.isArray(base))) {
    const indexed = rows => { const map = new Map(); for (const row of rows || []) { if (!row || typeof row.id !== 'string' || map.has(row.id)) throw new Error("Arrays require unique stable IDs"); map.set(row.id, row); } return map; };
    const maps = [base, local, remote].map(indexed), values = [];
    for (const id of [...new Set(maps.flatMap(m => [...m.keys()]))].sort()) { const row = mergeJSON(...maps.map(m => m.get(id))); if (row !== undefined) values.push(row); }
    return values;
  }
  throw new Error("Field semantics conflict");
}

export async function resolveConflicts({ preview, paths, before, target, git }) {
  const auditId = createHash('sha256').update([before, target].sort().join(':')).digest('hex').slice(0, 24);
  const auditRelative = `user-space/logs/hub/conflicts/${auditId}`;
  const auditDir = safeInstancePath(preview, join(preview, auditRelative)); mkdirSync(auditDir, { recursive: true });
  const parents = [before, target].sort();
  const times = await Promise.all(parents.map(async commit => Number(output(await git(['show', '-s', '--format=%ct', commit], { cwd: preview })).trim())));
  if (times.some(time => !Number.isSafeInteger(time))) throw new Error("Cannot determine conflict source time");
  const entries = [], attachmentRepairs = new Map(), repairedAssets = new Map();
  for (const path of [...paths].sort()) {
    const full = resolve(preview, path);
    if (!full.startsWith(resolve(preview) + sep) || path.split('/').some(p => p === '..' || p === '.git')) throw new Error("Conflict path escapes its root");
    let parent = dirname(full);
    while (parent !== resolve(preview)) { if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("Conflict paths cannot traverse links"); parent = dirname(parent); }
    if (existsSync(full) && (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink())) throw new Error("Automatic link-conflict resolution is unsupported");
    const versions = {};
    const stages = output(await git(['ls-files', '-u', '--', path], { cwd: preview })).split('\n').filter(Boolean);
    for (const [name, stage] of [['base', 1], ['local', 2], ['remote', 3]]) {
      if (stages.some(line => line.match(/^\d+ [a-f0-9]+ (\d)\t/)?.[1] === String(stage))) {
        const { stdout } = await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-C', preview, 'show', `:${stage}:${path}`], { encoding: 'buffer', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
        versions[name] = stdout;
      }
    }
    for (const bytes of Object.values(versions)) writeFileSync(join(auditDir, `${hash(bytes)}.bin`), bytes, { mode: 0o600 });
    const imagePath=path.match(/^user-space\/logs\/hub\/attachments\/([a-f0-9]{64})\/image\.webp$/);
    if(imagePath) {
      const old=imagePath[1], replacements=[];
      for(const [name,commit] of [['local',before],['remote',target]]) {
        const bytes=versions[name];if(!bytes)continue;
        const id=hash(bytes);replacements.push(id);
        let meta={};try{meta=JSON.parse(output(await git(['show',`${commit}:user-space/logs/hub/attachments/${old}/metadata.json`],{cwd:preview})));}catch{}
        repairedAssets.set(id,{bytes,meta:{version:1,id,sha256:id,mime:'image/webp',width:meta.width||null,height:meta.height||null,bytes:bytes.length}});
      }
      if(replacements.some(id=>id!==old))attachmentRepairs.set(old,[...new Set(replacements)].sort());
    }
    const heads = [versions.local, versions.remote].filter(Boolean).sort((a, b) => hash(a).localeCompare(hash(b), 'en'));
    let selected = heads[0], strategy = 'content-hash-with-evidence', review = 'pending';
    const shardHost=path.match(/^state\/hosts\/([^/]+)\/events\//)?.[1],fileHost=shardHost||path.match(/^state\/events\/\d{4}-\d{2}-\d{2}@([^/]+)\.jsonl$/)?.[1]||'';
    const eventOptions={fileHost,shard:Boolean(shardHost)};
    if (path.endsWith('.jsonl') && versions.local && versions.remote) {
      try {
        const rows = [versions.local, versions.remote].flatMap(b => b.toString('utf8').split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s)));
        const map = new Map();
        for (const row of rows) {
          const id = row.event_id?eventIdentity(row,fileHost,eventOptions):row.id||row.eventId;
          if(typeof id!=='string')throw Error("Ambiguous event identity");
          const prior=map.get(id),sameContent=prior&&(row.event_id?eventContentHash(prior)===eventContentHash(row):same(prior,row));
          if(prior&&!sameContent)throw Error("Ambiguous event identity");
          if(!prior||JSON.stringify(stable(row))<JSON.stringify(stable(prior)))map.set(id,row);
        }
        selected = Buffer.from([...map.keys()].sort().map(id => JSON.stringify(stable(map.get(id)))).join('\n') + '\n');
        strategy = 'event-id-union'; review = 'resolved';
      } catch {  }
    }
    if (path.endsWith('.json') && versions.local && versions.remote) {
      try {
        selected = Buffer.from(JSON.stringify(stable(mergeJSON(versions.base ? JSON.parse(versions.base.toString('utf8')) : undefined, JSON.parse(versions.local.toString('utf8')), JSON.parse(versions.remote.toString('utf8')))), null, 2) + '\n');
        strategy = 'json-three-way'; review = 'resolved';
      } catch {  }
    }
    if (path === 'user-space/memory/memory-meta.json' && (versions.local || versions.remote)) {
      const merged = mergeMemoryMetadata(versions.base, versions.local, versions.remote, auditId);
      selected = Buffer.from(JSON.stringify(stable(merged.value), null, 2) + '\n');
      strategy = 'memory-metadata-with-revocation'; review = merged.pending ? 'pending' : 'resolved';
    }
    if (review === 'pending' && /^user-space\/memory\/[^/]+\.md$/.test(path)) {
      selected = Buffer.from(quarantineMemoryText(existsSync(full) ? readFileSync(full, 'utf8') : '', auditId));
      strategy = 'memory-conflict-quarantined';
    }
    if (review === 'pending' && /^state\/(?:events\/|hosts\/[^/]+\/events\/).+\.jsonl$/.test(path)) {
      selected = Buffer.from(quarantineEventRows(versions.local, versions.remote,eventOptions));
      strategy = 'event-conflict-quarantined';
    }
    if (review === 'pending' && /^user-space\/(?:profile|privacy|values)\.yaml$/.test(path)) {
      const failure = new Error("Personal profile or rules have semantic conflicts. Automatic sync paused; commits on both sides preserved.");
      failure.publicMessage = failure.message; throw failure;
    }
    if(review==='pending'&&/^user-space\/reminders\/[a-zA-Z0-9_-]+\.json$/.test(path)&&selected){
      try{const record=JSON.parse(selected.toString('utf8'));record.status='conflicted';record.conflict_evidence=auditId;selected=Buffer.from(JSON.stringify(stable(record),null,2)+'\n');strategy='agenda-preserved-conflict';}catch{}
    }
    if (selected) { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, selected); }
    else if (existsSync(full)) unlinkSync(full);
    entries.push({ path, strategy, review, base: versions.base ? hash(versions.base) : null, heads: [versions.local, versions.remote].map(bytes => bytes ? hash(bytes) : null).sort(), evidence: [...new Set(Object.values(versions).map(bytes => `${hash(bytes)}.bin`))].sort() });
  }
  if(attachmentRepairs.size) {
    for(const [id,{bytes,meta}] of repairedAssets) {
      const dir=safeInstancePath(preview,join(preview,'user-space/logs/hub/attachments',id));mkdirSync(dir,{recursive:true});
      writeFileSync(safeInstancePath(preview,join(dir,'image.webp')),bytes);writeJson(safeInstancePath(preview,join(dir,'metadata.json')),meta);
    }
    const rewrite=value=>Array.isArray(value)?value.map(rewrite):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='attachmentIds'&&Array.isArray(v)?[...new Set(v.flatMap(id=>attachmentRepairs.get(id)||[id]))]:rewrite(v)])):value;
    for(const section of ['notes','conversations']) {
      const dir=safeInstancePath(preview,join(preview,'user-space/logs/hub',section));if(!existsSync(dir))continue;
      for(const file of readdirSync(dir).filter(n=>/^[a-zA-Z0-9_-]{8,80}\.(json|md)$/.test(n))) {
        const path=safeInstancePath(preview,join(dir,file)),text=readFileSync(path,'utf8');
        if(file.endsWith('.json'))writeJson(path,rewrite(JSON.parse(text)));
        else {let next=text;for(const [old,ids] of attachmentRepairs)next=next.replaceAll(old,ids.join(', '));writeFileSync(path,next);}
      }
    }
    for(const [old,ids] of attachmentRepairs)entries.push({path:`user-space/logs/hub/attachments/${old}`,strategy:'attachment-content-address-repair',review:'pending',replacementIds:ids});
  }
  writeJson(join(auditDir, 'audit.json'), { id: auditId, parents, createdAt: new Date(Math.max(...times) * 1000).toISOString(), status: entries.some(e => e.review === 'pending') ? 'pending-review' : 'resolved', entries });
  await git(['add', '--all', '--', ...paths, auditRelative, ...(attachmentRepairs.size?['user-space/logs/hub/attachments','user-space/logs/hub/notes','user-space/logs/hub/conversations'].filter(p=>existsSync(join(preview,p))):[])], { cwd: preview });
  await git(['-c', 'user.name=AIPA Hub', '-c', 'user.email=aipa-hub@localhost', 'commit', '--no-edit'], { cwd: preview });
  return auditId;
}

export function quarantineMemoryText(merged, auditId) {
  const kept = []; let stage = 'outside', blocks = 0;
  for (const line of merged.split(/\r?\n/)) {
    if (/^<<<<<<< /.test(line)) { if (stage !== 'outside') return `<!-- aipa-memory-conflict:${auditId} -->\n`; stage = 'local'; blocks++; }
    else if (/^=======$/.test(line)) { if (stage !== 'local') return `<!-- aipa-memory-conflict:${auditId} -->\n`; stage = 'remote'; }
    else if (/^>>>>>>> /.test(line)) { if (stage !== 'remote') return `<!-- aipa-memory-conflict:${auditId} -->\n`; stage = 'outside'; }
    else if (stage === 'outside') kept.push(line);
  }
  const agreed = blocks && stage === 'outside' ? kept.join('\n') : '';
  return `<!-- aipa-memory-conflict:${auditId} -->\n${agreed}\n> Disputed content is not active. Both originals and decision evidence are preserved in conflict audits.\n`;
}
export function quarantineEventRows(local, remote,{fileHost='',shard=false}={}) {
  const groups = new Map();
  try {
    for (const bytes of [local, remote].filter(Boolean)) for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line), id = row.event_id?eventIdentity(row,fileHost,{shard}):row.eventId||row.id;
      if (typeof id !== 'string' || !id) throw Error('event identity unknown');
      if (!groups.has(id)) groups.set(id, new Map());
      const digest=row.event_id?eventContentHash(row):JSON.stringify(stable(row)),prior=groups.get(id).get(digest);
      if(!prior||JSON.stringify(stable(row))<JSON.stringify(stable(prior)))groups.get(id).set(digest, row);
    }
  } catch { return ''; }
  return [...groups.keys()].sort().filter(id => groups.get(id).size === 1).map(id => JSON.stringify(stable([...groups.get(id).values()][0]))).join('\n') + '\n';
}
export function mergeMemoryMetadata(baseBytes, localBytes, remoteBytes, auditId) {
  const parse = bytes => bytes ? JSON.parse(bytes.toString('utf8')) : { version: 1, entries: {} };
  const [base, local, remote] = [baseBytes, localBytes, remoteBytes].map(parse);
  if ([base, local, remote].some(v => v.version !== 1 || !v.entries || Array.isArray(v.entries))) throw Error("Memory metadata cannot be merged automatically");
  const entries = {}; let pending = false;
  for (const id of [...new Set([...Object.keys(base.entries), ...Object.keys(local.entries), ...Object.keys(remote.entries)])].sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) throw Error("Invalid memory identity");
    const a = local.entries[id], b = remote.entries[id], revoked = [a, b].find(e => e?.confirmation?.status === 'revoked');
    if (revoked) { entries[id] = revoked; if (!same(a, b)) pending = true; continue; }
    try { const value = mergeJSON(base.entries[id], a, b); if (value !== undefined) entries[id] = value; }
    catch { pending = true; entries[id] = { ...(base.entries[id] || a || b), confirmation: { status: 'conflicted', actor: 'sync', reason: "Factual states on both sides need verification" }, conflict_evidence: auditId }; }
  }
  return { value: { version: 1, entries }, pending };
}
