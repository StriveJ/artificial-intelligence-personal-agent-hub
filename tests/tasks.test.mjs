import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduler } from '../lib/scheduler.mjs';
import { createRepoSync } from '../lib/repo-sync.mjs';
import { resolveConflicts } from '../lib/conflict-resolution.mjs';
import { inspectTreePaths } from '../lib/repo-preflight.mjs';
import { createCoreRuntime } from '../lib/core-runtime.mjs';

const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });
function temporary(t) {
  const base = mkdtempSync(join(TMP, 'hub-tasks-'));
  t.after(() => { assert.ok(resolve(base).startsWith(TMP + sep)); rmSync(base, { recursive: true, force: true }); });
  return base;
}
const timers = { setTimer: () => ({ unref() {} }), clearTimer() {} };
test("Scheduler persists next run, catches up once after restart, and does not replay every missed interval", async t => {
  const path = join(temporary(t), 'tasks.json'); let clock = 100_000, count = 0;
  const make = () => createScheduler({ path, now: () => clock, ...timers });
  let s = make(); s.register({ id: 'example', label: '\u793a\u4f8b', intervalMs: 3600_000, run: async () => { count++; return { status: 'success', summary: "complete" }; } });
  s.start(); await s.tick(); assert.equal(count, 1); const next = s.list()[0].nextRunAt; await s.stop();
  clock += 60_000;
  s = make(); s.register({ id: 'example', label: '\u793a\u4f8b', intervalMs: 3600_000, run: async () => { count++; } });
  s.start(); await s.tick(); assert.equal(count, 1); assert.equal(s.list()[0].nextRunAt, next); await s.stop();
  clock += 12 * 3600_000;
  s = make(); s.register({ id: 'example', label: '\u793a\u4f8b', intervalMs: 3600_000, run: async () => { count++; } });
  s.start(); await s.tick(); await s.tick(); assert.equal(count, 2); await s.stop();
});
test("Tasks do not reenter, stop waits for persistence, deferral is not success, and failures do not block other tasks", async t => {
  let release, count = 0, clock = 100_000;
  const s = createScheduler({ path: join(temporary(t), 'tasks.json'), now: () => clock, ...timers });
  s.register({ id: 'slow', label: '\u6162\u4efb\u52a1', intervalMs: 3600_000, run: async () => { count++; await new Promise(r => release = r); return { status: 'deferred', summary: '\u5fd9\u788c' }; } });
  s.register({ id: 'failed', label: '\u5931\u8d25\u4efb\u52a1', intervalMs: 3600_000, run: async () => { throw new Error('secret-token-must-not-leak'); } });
  const p = s.runNow('slow'); assert.equal(s.runNow('slow'), p); await delay(0); assert.equal(count, 1);
  await s.runNow('failed'); assert.equal(s.list()[1].status, 'error'); assert.doesNotMatch(JSON.stringify(s.list()), /secret-token/);
  let stopped = false; const stop = s.stop().then(() => stopped = true); await delay(0); assert.equal(stopped, false);
  release(); await p; await stop;
  const state = s.list()[0]; assert.equal(state.status, 'deferred'); assert.equal(state.lastSuccessAt, undefined); assert.equal(Date.parse(state.nextRunAt), clock + 60_000);
});
test("Previously running tasks show interrupted after restart and disabled tasks reject manual runs", async t => {
  const path = join(temporary(t), 'tasks.json');
  writeFileSync(path, JSON.stringify({ tasks: { example: { status: 'running', nextRunAt: new Date(0).toISOString() } } }));
  const s = createScheduler({ path, ...timers }); s.register({ id: 'example', label: '\u793a\u4f8b', intervalMs: 1000, enabled: false, run() {} });
  assert.equal(s.list()[0].status, 'unknown'); assert.equal(s.list()[0].result.code, 'interrupted'); assert.equal(s.list()[0].nextRunAt, null);
  assert.throws(() => s.runNow('example'), /disabled/i); await s.stop();
});

function repository(t, { deep = false } = {}) {
  const temp = temporary(t);
  const base = deep ? join(temp, 'nested-installation-'.padEnd(Math.max(24, 180-temp.length), 'x')) : temp;
  mkdirSync(base, { recursive: true });
  const origin = join(base, 'origin.git'), writer = join(base, 'writer'), root = join(base, 'hub'), runtimeDir = join(base, 'runtime');
  const git = (cwd, ...args) => {
    try{return execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 15_000 }).trim();}
    catch(error){throw new Error('Synthetic Git fixture failed: '+JSON.stringify({args,status:error.status,signal:error.signal,code:error.code,stderr:String(error.stderr||'').slice(-3000)}),{cause:error});}
  };
  git(base, 'init', '--bare', '--initial-branch=master', origin); git(base, 'clone', origin, writer);
  for (const cwd of [writer]) { git(cwd, 'config', 'user.name', 'Hub Test'); git(cwd, 'config', 'user.email', 'hub-test@example.invalid'); git(cwd, 'config', 'core.autocrlf', 'false'); }
  writeFileSync(join(writer, 'memory.txt'), 'initial\n'); git(writer, 'add', '.'); git(writer, 'commit', '-m', 'initial'); git(writer, 'push', '-u', 'origin', 'master');
  git(base, 'clone', origin, root); git(root, 'config', 'user.name', 'Hub Test'); git(root, 'config', 'user.email', 'hub-test@example.invalid'); git(root, 'config', 'core.autocrlf', 'false');
  const advance = (file = 'remote.txt', content = 'yesterday record\n') => { writeFileSync(join(writer, file), content); git(writer, 'add', '.'); git(writer, 'commit', '-m', 'remote record'); git(writer, 'push'); };
  return { base, root, writer, origin, runtimeDir, git, advance, sync: (afterUpdate, options = {}) => {
    const sync=createRepoSync({ root, runtimeDir, afterUpdate, ...options });
    return async(...args)=>{try{return await sync(...args);}catch(error){const cause=error.cause;error.message+=' Synthetic Git cause: '+JSON.stringify({code:cause?.code,killed:cause?.killed,signal:cause?.signal,stderr:String(cause?.stderr||'').slice(-3000)});throw error;}};
  } };
}
test("Core dependency synchronization blocks mixed code while preserving pulled commits and personal sentinels; explicit rollback resumes", async t => {
  const f=repository(t),rel='core-space/scripts/lib/leaf.mjs';
  mkdirSync(join(f.writer,'core-space/scripts/lib'),{recursive:true});
  writeFileSync(join(f.writer,'AIPA-MANIFEST.yaml'),'aipa:\n  version: synthetic\n');
  writeFileSync(join(f.writer,rel),'export const value="original";\n');
  f.git(f.writer,'add','.');f.git(f.writer,'commit','-m','synthetic Core');f.git(f.writer,'push');
  await f.sync()();
  const runtime=createCoreRuntime(f.root);assert.equal((await runtime.lib('leaf.mjs')).value,'original');
  writeFileSync(join(f.root,'memory.txt'),'SYNTHETIC_PRIVATE_SENTINEL');
  f.advance(rel,'export const value="updated";\n');
  const sync=f.sync(async()=>{createCoreRuntime(f.root);});
  const result=await sync();assert.equal(result.status,'blocked');assert.equal(result.code,'core_restart_required');
  assert.equal(result.pushed,false);assert.equal(f.git(f.root,'rev-parse','HEAD'),f.git(f.writer,'rev-parse','HEAD'));
  assert.equal(runtime.status().status,'blocked');assert.equal(readFileSync(join(f.root,'memory.txt'),'utf8'),'SYNTHETIC_PRIVATE_SENTINEL');
  // Only this from-zero repository is reverted, never a real instance.
  f.git(f.root,'revert','--no-edit','HEAD');
  assert.equal(runtime.status().status,'ready');assert.equal((await sync()).status,'success');
  assert.equal(readFileSync(join(f.root,'memory.txt'),'utf8'),'SYNTHETIC_PRIVATE_SENTINEL');
});

test("Real Git pull preserves nonoverlapping tracked edits and new mobile notes with merge hooks disabled", async t => {
  const f = repository(t);
  writeFileSync(join(f.root, 'memory.txt'), 'local edit\n'); writeFileSync(join(f.root, 'phone-note.txt'), 'phone idea\n');
  const hook = join(f.root, '.git', 'hooks', 'post-merge'); writeFileSync(hook, '#!/bin/sh\necho called > hook-ran.txt\n', { mode: 0o755 });
  f.advance(); let refresh = 0;
  const result = await f.sync(async () => refresh++)();
  assert.equal(result.code, 'updated'); assert.equal(refresh, 1); assert.equal(readFileSync(join(f.root, 'remote.txt'), 'utf8'), 'yesterday record\n');
  assert.equal(readFileSync(join(f.root, 'memory.txt'), 'utf8'), 'local edit\n'); assert.equal(readFileSync(join(f.root, 'phone-note.txt'), 'utf8'), 'phone idea\n');
  assert.equal(existsSync(join(f.root, 'hook-ran.txt')), false);
  assert.equal((await f.sync()()).code, 'current');
});
test("Remote conflicts with local, staged, or untracked files stop without overwriting or hiding changes", async t => {
  for (const mode of ['tracked', 'staged', 'untracked', 'ignored']) {
    const f = repository(t); const file = ['untracked', 'ignored'].includes(mode) ? 'remote.txt' : 'memory.txt';
    if (mode === 'ignored') writeFileSync(join(f.root, '.gitignore'), 'remote.txt\n');
    writeFileSync(join(f.root, file), 'phone original\n'); if (mode === 'staged') f.git(f.root, 'add', file);
    const before = f.git(f.root, 'rev-parse', 'HEAD'); f.advance(file, 'remote different\n');
    const result = await f.sync()(); assert.equal(result.code, 'local_changes'); assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(f.root, file), 'utf8'), 'phone original\n'); assert.equal(f.git(f.root, 'stash', 'list'), '');
    if (mode === 'staged') assert.equal(f.git(f.root, 'diff', '--cached', '--name-only'), file);
  }
});
test("Diverged branches or active external Git operations stop without automatic merge or push", async t => {
  const f = repository(t); writeFileSync(join(f.root, 'local.txt'), 'local\n'); f.git(f.root, 'add', '.'); f.git(f.root, 'commit', '-m', 'local');
  const before = f.git(f.root, 'rev-parse', 'HEAD'); f.advance(); assert.equal((await f.sync()()).code, 'diverged'); assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), before);
  const lock = join(f.root, '.git', 'index.lock'); writeFileSync(lock, ''); assert.equal((await f.sync()()).code, 'git_busy');
});

test("Bidirectional mode commits web records then merges remotely in isolation without committing unrelated untracked data", async t => {
  const f = repository(t);
  mkdirSync(join(f.root, 'hub')); writeFileSync(join(f.root, 'hub', 'chat.json'), '{"input":"phone question","answer":"answer"}\n');
  writeFileSync(join(f.root, 'other-private.txt'), 'do not automatically stage this\n'); f.advance();
  const result = await f.sync(undefined, { push: true, capturePaths: ['hub'] })();
  assert.equal(result.status, 'success'); assert.equal(result.checkpoint, true); assert.equal(result.pushed, true);
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), f.git(f.origin, 'rev-parse', 'master'));
  assert.match(f.git(f.origin, 'show', 'master:hub/chat.json'), /phone question/);
  assert.equal(f.git(f.origin, 'show', 'master:remote.txt'), 'yesterday record');
  assert.throws(() => f.git(f.origin, 'show', 'master:other-private.txt'));
  assert.ok(existsSync(join(f.root, 'other-private.txt')));
  assert.equal(f.git(f.root, 'worktree', 'list', '--porcelain').match(/worktree /g).length, 1);
});

test("Bidirectional text conflicts remain in isolated worktrees without conflict markers in live or remote files", async t => {
  const f = repository(t);
  writeFileSync(join(f.root, 'memory.txt'), 'phone different\n'); f.advance('memory.txt', 'desktop different\n');
  const remoteBefore = f.git(f.origin, 'rev-parse', 'master');
  const result = await f.sync(undefined, { push: true, capturePaths: ['memory.txt'] })();
  assert.equal(result.code, 'merge_conflict'); assert.equal(readFileSync(join(f.root, 'memory.txt'), 'utf8'), 'phone different\n');
  assert.equal(f.git(f.origin, 'rev-parse', 'master'), remoteBefore);
  assert.equal(f.git(f.root, 'status', '--short'), '');
  assert.equal(f.git(f.root, 'worktree', 'list', '--porcelain').match(/worktree /g).length, 1);
  assert.equal(f.git(f.root, 'show', 'HEAD:memory.txt'), 'phone different');
});

test("Bidirectional mode never commits unrelated manually staged user files", async t => {
  const f = repository(t); writeFileSync(join(f.root, 'other.txt'), 'manual\n'); f.git(f.root, 'add', 'other.txt');
  const before = f.git(f.root, 'rev-parse', 'HEAD');
  const result = await f.sync(undefined, { push: true, capturePaths: ['hub'] })();
  assert.equal(result.code, 'staged_changes'); assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(f.git(f.root, 'diff', '--cached', '--name-only'), 'other.txt');
});

test("Remote advancement after fetch triggers another normal merge and preserves new local and remote records", async t => {
  const f = repository(t); writeFileSync(join(f.root, 'memory.txt'), 'local record\n'); let raced = false;
  const result = await f.sync(async () => { if (!raced) { raced = true; f.advance('race.txt', 'remote after fetch\n'); } }, { push: true, capturePaths: ['memory.txt'] })();
  assert.equal(result.status, 'success'); assert.equal(result.pushed, true);
  assert.equal(f.git(f.origin, 'show', 'master:memory.txt'), 'local record'); assert.equal(f.git(f.origin, 'show', 'master:race.txt'), 'remote after fetch');
});

test("Cross-platform preflight detects case, Unicode, reserved Windows names, and path-segment collisions", () => {
  assert.equal(inspectTreePaths(['user-space/a.md', 'state/events/2026-10-17.jsonl']).length, 0);
  assert.ok(inspectTreePaths(['user-space/A.md', 'user-space/a.md']).some(i => i.code === 'case_or_unicode_collision'));
  assert.ok(inspectTreePaths(['user-space/é.md', 'user-space/e\u0301.md']).length);
  assert.ok(inspectTreePaths(['user-space/CON.txt', 'user-space/trailing.']).every(i => i.code === 'nonportable_path'));
  assert.ok(inspectTreePaths(['a', 'A/b']).some(i => i.code === 'file_directory_collision'));
});

test("Test mode permits local saves and merges but never pushes on first, repeated, or rebuilt sync", async t => {
  const f = repository(t);
  mkdirSync(join(f.root, 'hub')); writeFileSync(join(f.root, 'hub', 'note.txt'), 'local only\n');
  f.advance(); const remoteBefore = f.git(f.origin, 'rev-parse', 'master');
  const options = { push: true, testMode: true, capturePaths: ['hub'] };
  for (let i = 0; i < 3; i++) {
    const result = await f.sync(undefined, options)();
    assert.equal(result.code, 'local_only'); assert.equal(result.pushed, false); assert.equal(result.pushSuppressed, true);
    assert.equal(f.git(f.origin, 'rev-parse', 'master'), remoteBefore);
  }
  assert.match(f.git(f.root, 'show', 'HEAD:hub/note.txt'), /local only/);
  const afterMisconfiguration = await f.sync(undefined, { ...options, testMode: false })();
  assert.equal(afterMisconfiguration.pushSuppressed, true);
  assert.equal(f.git(f.origin, 'rev-parse', 'master'), remoteBefore);
});

test("Automatic conflict handling preserves both evidence and pending records without live markers or test-mode pushes", async t => {
  const f = repository(t);
  writeFileSync(join(f.root, 'memory.txt'), 'local uncertain fact\n'); f.advance('memory.txt', 'upstream fact\n');
  const remoteBefore = f.git(f.origin, 'rev-parse', 'master');
  const result = await f.sync(undefined, { push: true, testMode: true, autoResolve: true, capturePaths: ['memory.txt'] })();
  assert.equal(result.code, 'local_only'); assert.equal(f.git(f.origin, 'rev-parse', 'master'), remoteBefore);
  assert.ok(['local uncertain fact\n', 'upstream fact\n'].includes(readFileSync(join(f.root, 'memory.txt'), 'utf8')));
  const audits = f.git(f.root, 'ls-files', 'user-space/logs/hub/conflicts').split('\n');
  const audit = JSON.parse(readFileSync(join(f.root, audits.find(p => p.endsWith('audit.json'))), 'utf8'));
  assert.equal(audit.status, 'pending-review'); assert.equal(audit.entries[0].path, 'memory.txt');
  assert.equal(audit.entries[0].evidence.length, 3); assert.equal(f.git(f.root, 'status', '--porcelain'), '');
});

test("Agenda reschedule/cancel conflicts preserve both versions and pause disputed reminders",async t=>{
  const f=repository(t),file='user-space/reminders/agenda-conflict.json';
  mkdirSync(join(f.writer,'user-space','reminders'),{recursive:true});mkdirSync(join(f.root,'user-space','reminders'),{recursive:true});
  const base={schema:1,id:'agenda-conflict',title:'\u5408\u6210\u4f1a\u8bae',event_at:'2035-10-25T14:00:00+08:00',remind_at:'2035-10-25T13:00:00+08:00',status:'open'};
  f.advance(file,JSON.stringify(base));await f.sync()();
  writeFileSync(join(f.root,file),JSON.stringify({...base,event_at:'2035-10-26T14:00:00+08:00',updated_at:'2030-01-01T00:00:00Z'}));
  f.advance(file,JSON.stringify({...base,event_at:'2035-10-27T14:00:00+08:00',status:'cancelled',updated_at:'2030-01-02T00:00:00Z'}));
  const before=f.git(f.origin,'rev-parse','master');const result=await f.sync(undefined,{push:true,testMode:true,autoResolve:true,capturePaths:['user-space']})();
  assert.equal(result.pushSuppressed,true);assert.equal(f.git(f.origin,'rev-parse','master'),before);
  const record=JSON.parse(readFileSync(join(f.root,file),'utf8'));assert.equal(record.status,'conflicted');assert.ok(record.conflict_evidence);
});

test("Deep installation paths support automatic conflict handling, worktree cleanup, and repeated synchronization", async t => {
  const f = repository(t, { deep: true });
  writeFileSync(join(f.root, 'memory.txt'), 'local fact\n'); f.advance('memory.txt', 'remote fact\n');
  const sync = f.sync(undefined, { push: true, testMode: true, autoResolve: true, capturePaths: ['memory.txt'] });
  assert.equal((await sync()).status, 'success');
  assert.equal(readdirSync(f.runtimeDir).some(name => name.startsWith('m-')), false);
  assert.equal((await sync()).status, 'success');
  assert.equal(f.git(f.root, 'worktree', 'list', '--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length, 1);
});

test("Event JSONL merges by stable identity and preserves disjoint events with mechanical-resolution markers", async t => {
  const f = repository(t);
  f.advance('events.jsonl', '{"event_id":"base","data":"base"}\n'); await f.sync()();
  writeFileSync(join(f.root, 'events.jsonl'), '{"event_id":"local","data":"one"}\n'); f.advance('events.jsonl', '{"event_id":"remote","data":"two"}\n');
  const r = await f.sync(undefined, { push: true, testMode: true, autoResolve: true, capturePaths: ['events.jsonl'] })();
  assert.equal(r.status, 'success');
  const rows = readFileSync(join(f.root, 'events.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(rows.map(v => v.event_id), ['local', 'remote']);
});

test("Swapped conflict directions produce identical text, binary, same-ID event, and modify/delete trees with complete evidence", async t => {
  const f = repository(t);
  for (const [file, value] of Object.entries({ 'binary.dat': Buffer.from([0, 1]), 'delete.txt': 'base', 'events.jsonl': '{"id":"same","x":0}\n' })) writeFileSync(join(f.writer, file), value);
  f.git(f.writer, 'add', '.'); f.git(f.writer, 'commit', '-m', 'base'); f.git(f.writer, 'push'); await f.sync()();
  writeFileSync(join(f.root, 'memory.txt'), 'left'); writeFileSync(join(f.root, 'binary.dat'), Buffer.from([0, 2]));
  writeFileSync(join(f.root, 'delete.txt'), 'retained modification'); writeFileSync(join(f.root, 'events.jsonl'), '{"id":"same","x":1}\n');
  f.git(f.root, 'add', '.'); f.git(f.root, 'commit', '-m', 'left');
  writeFileSync(join(f.writer, 'binary.dat'), Buffer.from([0, 3])); writeFileSync(join(f.writer, 'events.jsonl'), '{"id":"same","x":2}\n');
  f.git(f.writer, 'rm', 'delete.txt'); f.advance('memory.txt', 'right');
  const a = f.git(f.root, 'rev-parse', 'HEAD'), b = f.git(f.writer, 'rev-parse', 'HEAD');
  f.git(f.root, 'fetch', 'origin'); const trees = [];
  for (const [before, target] of [[a, b], [b, a]]) {
    const preview = join(f.base, `direction-${trees.length}`); f.git(f.base, 'clone', f.root, preview);
    f.git(preview, 'config', 'user.name', 'Test'); f.git(preview, 'config', 'user.email', 'test@example.invalid'); f.git(preview, 'checkout', '--detach', before);
    assert.throws(() => f.git(preview, 'merge', '--no-edit', target));
    const paths = f.git(preview, 'diff', '--name-only', '--diff-filter=U').split('\n');
    await resolveConflicts({ preview, paths, before, target, git: async (args, { cwd }) => ({ text: f.git(cwd, ...args) }) });
    trees.push(f.git(preview, 'rev-parse', 'HEAD^{tree}'));
    assert.equal(readFileSync(join(preview, 'delete.txt'), 'utf8'), 'retained modification');
    const auditPath = f.git(preview, 'ls-files', 'user-space/logs/hub/conflicts').split('\n').find(p => p.endsWith('audit.json'));
    const audit = JSON.parse(readFileSync(join(preview, auditPath), 'utf8'));
    assert.equal(audit.entries.length, 4); assert.equal(audit.status, 'pending-review');
    for (const entry of audit.entries) for (const evidence of entry.evidence) assert.ok(existsSync(join(preview, auditPath, '..', evidence)));
  }
  assert.equal(trees[0], trees[1]);
});

test("Structured JSON merges preserve independent fields without disguising field conflicts as mechanical resolution", async t => {
  const f = repository(t);
  f.advance('profile.json', '{"a":1,"b":1}\n'); await f.sync()();
  writeFileSync(join(f.root, 'profile.json'), '{"a":2,"b":1}\n'); f.advance('profile.json', '{"a":1,"b":2}\n');
  const r = await f.sync(undefined, { push: true, testMode: true, autoResolve: true, capturePaths: ['profile.json'] })();
  assert.equal(r.status, 'success'); assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'profile.json'), 'utf8')), { a: 2, b: 2 });
  const auditPath = f.git(f.root, 'ls-files', 'user-space/logs/hub/conflicts').split('\n').find(p => p.endsWith('audit.json'));
  const audit = JSON.parse(readFileSync(join(f.root, auditPath), 'utf8')); assert.equal(audit.entries[0].strategy, 'json-three-way'); assert.equal(audit.status, 'resolved');
});

test("Legacy tracked local-session bindings retain original bytes after pulls and never push local bindings", async t => {
  const f = repository(t);
  mkdirSync(join(f.writer, 'state')); writeFileSync(join(f.writer, '.gitignore'), 'state/session-context.json\n');
  writeFileSync(join(f.writer, 'state', 'session-context.json'), '{"host":"initial"}\n');
  f.git(f.writer, 'add', '.'); f.git(f.writer, 'add', '-f', 'state/session-context.json'); f.git(f.writer, 'commit', '-m', 'legacy tracked local state'); f.git(f.writer, 'push');
  assert.equal((await f.sync()()).status, 'success');
  writeFileSync(join(f.root, 'state', 'session-context.json'), '{"host":"linux-private"}\n');
  mkdirSync(join(f.root, 'hub')); writeFileSync(join(f.root, 'hub', 'chat.json'), '{"input":"question"}\n');
  f.advance('state/session-context.json', '{"host":"desktop-new"}\n');
  const result = await f.sync(undefined, { push: true, capturePaths: ['hub'] })();
  assert.equal(result.status, 'success'); assert.equal(readFileSync(join(f.root, 'state', 'session-context.json'), 'utf8'), '{"host":"linux-private"}\n');
  assert.equal(f.git(f.origin, 'show', 'master:state/session-context.json'), '{"host":"desktop-new"}');
  assert.equal(existsSync(join(f.runtimeDir, 'repo-sync-local-overlay.json')), false);
  const privatePath = 'state/session-context.json';
  writeFileSync(join(f.runtimeDir, 'repo-sync-local-overlay.json'), JSON.stringify({ root: f.root, files: [{ path: privatePath, base64: Buffer.from('recovered-private\n').toString('base64') }] }));
  f.sync(); assert.equal(readFileSync(join(f.root, privatePath), 'utf8'), 'recovered-private\n');
  assert.equal(existsSync(join(f.runtimeDir, 'repo-sync-local-overlay.json')), false);
});

test("Private local files retain bytes even without local edits, ignore rules, or remote copies", async t => {
  for (const mode of ['clean-ignored', 'clean-unignored', 'remote-delete']) {
    const f = repository(t), file = 'state/session-context.json';
    mkdirSync(join(f.writer, 'state'));
    writeFileSync(join(f.writer, file), 'local-private-bytes\n');
    if (mode === 'clean-ignored') writeFileSync(join(f.writer, '.gitignore'), file + '\n');
    f.git(f.writer, 'add', '-f', file); f.git(f.writer, 'add', '.'); f.git(f.writer, 'commit', '-m', 'legacy private'); f.git(f.writer, 'push');
    await f.sync()();
    f.git(f.root, 'restore', '--source=HEAD', '--worktree', '--', file);
    assert.equal(f.git(f.root, 'diff', '--name-only', '--', file), '');
    if (mode === 'remote-delete') f.git(f.writer, 'rm', file);
    else { writeFileSync(join(f.writer, file), 'other-device\n'); f.git(f.writer, 'add', '-f', file); }
    f.git(f.writer, 'commit', '-m', 'remote private change'); f.git(f.writer, 'push');
    const result = await f.sync()();
    assert.equal(result.status, 'success'); assert.equal(readFileSync(join(f.root, file), 'utf8'), 'local-private-bytes\n', mode);
    assert.equal(existsSync(join(f.runtimeDir, 'repo-sync-local-overlay.json')), false);
  }
});

test("Missing private files are not created from remotes and recovery journals preserve absence", async t => {
  const f = repository(t), file = 'state/session-context.json';
  mkdirSync(join(f.writer, 'state')); writeFileSync(join(f.writer, file), 'remote-device-only\n');
  f.git(f.writer, 'add', file); f.git(f.writer, 'commit', '-m', 'remote private state'); f.git(f.writer, 'push');
  assert.equal((await f.sync()()).status, 'success'); assert.equal(existsSync(join(f.root, file)), false);
  writeFileSync(join(f.root, file), 'interrupted-merge\n');
  writeFileSync(join(f.runtimeDir, 'repo-sync-local-overlay.json'), JSON.stringify({ root: f.root, files: [{ path: file, absent: true }] }));
  f.sync(); assert.equal(existsSync(join(f.root, file)), false);
});
