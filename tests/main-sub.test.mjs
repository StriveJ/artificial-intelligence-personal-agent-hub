import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createNodeControl } from '../lib/node-control.mjs';
import { createTaskGate } from '../lib/task-gate.mjs';
import { createEventOutbox } from '../lib/event-outbox.mjs';
import { createMainReports, logicalDay,addDay } from '../lib/main-reports.mjs';
import { createMainDistillation } from '../lib/main-distillation.mjs';
import { createSubLifecycle } from '../lib/sub-lifecycle.mjs';
import { createMainHub } from '../main-server.mjs';
import { createSubHub, subCommand } from '../sub-server.mjs';
import { createCaptureInbox } from '../lib/capture-inbox.mjs';
import { createStore } from '../lib/storage.mjs';
const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });
function temp(t) { const path = mkdtempSync(join(TMP, 'main-sub-')); t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); }); return path; }
function instance(base, name = 'instance') {
  const root = join(base, name); mkdirSync(root); mkdirSync(join(root, 'user-space'));
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  execFileSync('git', ['init', root], { stdio: 'pipe' }); return root;
}
const adapter = { owner: 'test', version: '1', requiresConsent: () => false, begin: async () => null, record: async () => null, context: async () => ({ prompt: 'test', sources: [], omitted: 0 }), search: async () => [], allowedContent: () => true };

test("Closing is partial when the report completes but distillation is unknown; repeated checks do not replay models",async t=>{
 const base=temp(t),root=instance(base),runtimeDir=join(base,'runtime');let calls=0;
 const stamp=Date.now(),today=logicalDay(stamp),hour=new Date(stamp+8*3600_000).getUTCHours(),day=hour<6?today:addDay(today,-1);
 mkdirSync(join(root,'state/events'),{recursive:true});writeFileSync(join(root,'state/events',day+'@synthetic.jsonl'),JSON.stringify({event_id:'synthetic-close',host:'synthetic',sid:'synthetic',type:'user_message',data:'Synthetic durable observation',ts:day+'T08:00:00Z'})+'\n');
 const hub=await createMainHub({root,runtimeDir,adapter,main:{modelConsent:true},tasks:{'repo-sync':{enabled:false}},runner:async prompt=>{if(prompt.includes('Return only a JSON array of {type,text}')){calls++;throw Error('Synthetic model result lost');}return 'Synthetic report';}});t.after(()=>hub.close());
 await hub.reports.daily(day);await hub.reports.start(day);hub.reports.status().days[day].closedAt=new Date().toISOString();
 const first=await hub.scheduler.runNow('main-day-close');assert.equal(first.status,'partial');assert.equal(first.distillation.status,'blocked');assert.equal(first.distillation.jobStatus,'model-unknown');
 const second=await hub.scheduler.runNow('main-day-close');assert.equal(second.status,'partial');assert.equal(calls,1);
 const task=hub.scheduler.list().find(t=>t.id==='main-day-close');assert.equal(task.lastSuccessAt,undefined);assert.equal(task.result.code,'distillation_incomplete');
});

test("Device credentials are isolated and operations and receipts durable; expired heartbeats affect presence only", t => {
  const runtimeDir = temp(t); let clock = 100_000;
  let nodes = createNodeControl({ runtimeDir, now: () => clock }); const a = nodes.enroll('node-a'), b = nodes.enroll('node-b');
  assert.throws(() => nodes.poll(a.id, b.token, a), /credentials/i);
  nodes.poll(a.id, a.token, a); assert.equal(nodes.list()[0].status, 'online');
  const op = nodes.request(a.id, 'sync', 'operation-001'); assert.equal(nodes.request(a.id, 'sync', 'operation-001').id, op.id);
  assert.throws(() => nodes.ack(b.id, b.token, { id: op.id, status: 'success' }), /does not belong/i);
  nodes.ack(a.id, a.token, { id: op.id, status: 'deferred' }); assert.equal(nodes.poll(a.id, a.token, a).operations.length, 1);
  nodes.ack(a.id, a.token, { id: op.id, status: 'success', pushed: false });
  nodes = createNodeControl({ runtimeDir, now: () => clock }); assert.equal(nodes.poll(a.id, a.token, a).operations.length, 0);
  clock += 91_000; assert.equal(nodes.list()[0].status, 'offline'); assert.doesNotMatch(JSON.stringify(nodes.list()), new RegExp(a.token));
});

test("Instance tasks and synchronization share an atomic gate with ownership checks and dead-process recovery", async t => {
  const root = instance(temp(t)), a = createTaskGate(root), b = createTaskGate(root);
  const task = a.acquire('task'); assert.ok(task); assert.equal(b.acquire('sync'), null);
  assert.equal((await b.run('sync', async () => assert.fail())).status, 'deferred');
  assert.throws(() => b.release('wrong-token'), /ownership/i); a.release(task.token);
  assert.equal(await b.run('sync', async () => 'ok'), 'ok'); assert.equal(a.state(), null);
  a.acquire('task', 2147483647);
  assert.equal(a.state(), null); const recovered = b.acquire('sync'); assert.ok(recovered); b.release(recovered.token);
});

test("Incompatible protocols retain heartbeats without dispatching operations; compatibility recovery preserves queued work", t => {
  const nodes = createNodeControl({ runtimeDir: temp(t) }), node = nodes.enroll('node-protocol');
  const op = nodes.request(node.id, 'sync');
  const bad = nodes.poll(node.id, node.token, { ...node, capabilities: { protocolMin: 2, protocolMax: 3 } });
  assert.equal(bad.compatible, false); assert.equal(bad.operations.length, 0); assert.equal(nodes.list()[0].status, 'online');
  const good = nodes.poll(node.id, node.token, { ...node, capabilities: { protocolMin: 1, protocolMax: 2, releaseId: 'verified-release', deploymentGeneration: 3, testMode: true } });
  assert.equal(good.compatible, true); assert.equal(good.operations[0].id, op.id); assert.equal(nodes.list()[0].capabilities.releaseId, 'verified-release');
});

test("Failed event delivery recovers registration without repeating acknowledged steps or replacing duplicate-ID content", async t => {
  const runtimeDir = temp(t); let calls = 0;
  let box = createEventOutbox(runtimeDir, async () => { calls++; return 'failed'; });
  await box.record('user_message', 'original', 'chat', 'stable-id'); assert.equal(box.pending(), 1);
  box = createEventOutbox(runtimeDir, async () => { calls++; return null; }); await box.flush(); await box.flush();
  assert.equal(calls, 2); assert.equal(box.pending(), 0); assert.throws(() => box.enqueue('user_message', 'changed', 'chat', 'stable-id'), /mismatch|different|differs/i);
});

test("Cross-day delivery preserves occurrence time and reports use event time instead of delivery day or old filenames", async t => {
  const base = temp(t), root = instance(base), runtimeDir = join(base, 'runtime'), delivered = [];
  let box = createEventOutbox(runtimeDir, async () => 'offline');
  await box.record('user_message', 'yesterday input', 'chat', 'yesterday-event', '2026-10-16T08:00:00Z');
  box = createEventOutbox(runtimeDir, async (...args) => { delivered.push(args); }); await box.flush();
  assert.equal(delivered[0][4], '2026-10-16T08:00:00Z');
  mkdirSync(join(root, 'state/events'), { recursive: true });
  writeFileSync(join(root, 'state/events/2026-10-17@legacy.jsonl'), JSON.stringify({ id: 'one', ts: '2026-10-16T08:00:00Z', data: 'original day' }) + '\n');
  const reports = createMainReports({ root, runtimeDir, nodes: createNodeControl({ runtimeDir }) });
  assert.equal(reports.sources('2026-10-16').events.length, 1); assert.equal(reports.sources('2026-10-17').events.length, 0);
});

test("Maintenance queues preserve input and time; restart archival avoids model replay and duplicate IDs check content", async t => {
  const base = temp(t), root = instance(base), runtimeDir = join(base, 'runtime'), store = createStore(root), chat = store.createChat(), starts = [];
  let inbox = createCaptureInbox({ runtimeDir, store, schedule: (...args) => starts.push(args), record: async () => null });
  inbox.enqueue('note', 'saved-note-001', { text: 'saved while report' }); inbox.enqueue('turn', 'saved-turn-001', { chatId: chat.id, text: 'saved question', engine: 'codex', consent: true, allowWeb: true, searchQuery: 'public keywords', webProfileVersion: 'original-profile' });
  assert.equal(store.listNotes().length, 0); assert.equal(inbox.virtualChat(chat.id).turns[0].input, 'saved question');
  assert.equal(inbox.virtualChat(chat.id).turns[0].allowWeb,true);
  assert.equal(inbox.virtualChat(chat.id).turns[0].searchQuery,'public keywords');
  assert.throws(() => inbox.enqueue('note', 'saved-note-001', { text: 'changed' }), /mismatch|different|differs/i);
  inbox = createCaptureInbox({ runtimeDir, store, schedule: () => assert.fail('\u91cd\u542f\u4e0d\u80fd\u81ea\u52a8\u8c03\u7528\u6a21\u578b'), record: async () => null }); await inbox.flush();
  assert.equal(store.listNotes()[0].text, 'saved while report'); assert.equal(store.readChat(chat.id).turns[0].status, 'interrupted'); assert.equal(inbox.pending(), false); assert.equal(starts.length, 0);
  assert.equal(store.readChat(chat.id).turns[0].allowWeb,true);
  assert.equal(store.readChat(chat.id).turns[0].webProfileVersion,'original-profile');
});

test("Main synchronization queues automatic-search input and consent without planning until the gate is released", async t => {
  const base=temp(t),root=instance(base),calls=[];
  let plans=0;
  const main=await createMainHub({root,runtimeDir:join(base,'runtime'),port:0,adapter,runner:async prompt=>{if(prompt.startsWith('Generate one minimal public-topic search query')){plans++;return '{"query":"public words"}';}return 'answered';},tasks:{'repo-sync':{enabled:false}},webFetcher:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({results:[{title:'source',url:'https://example.org/a',snippet:'evidence'}]}));}});
  const origin=await main.listen(); let cookie='';
  const request=async(path,body)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;};
  let gate,lease;
  try {
    assert.equal((await request('/api/main/retry-report',{key:'daily/2026-10-24'})).status,401);
    await request('/api/local-login',{});
    assert.equal((await request('/status.js')).status,200);assert.equal((await(await request('/api/main/status')).json()).capabilities.reportRetry,true);
    assert.equal((await request('/api/main/retry-report',{key:'daily/../../outside'})).status,400);
    assert.equal((await (await request('/api/main/retry-report',{key:'daily/2026-10-24'})).json()).code,'already-recovered');
    const settings=await (await request('/api/web-search/settings',{provider:'deepseek',apiKey:'synthetic'})).json();
    const chat=await (await request('/api/chats',{})).json();
    gate=createTaskGate(root); lease=gate.acquire('sync'); assert.ok(lease);
    const body={id:'deferred-turn-001',text:'private model context',engine:'codex',consent:true,allowWeb:true,webProfileVersion:settings.settings.revision};
    const response=await request(`/api/chats/${chat.id}/turns`,body);assert.equal(response.status,202);assert.equal((await response.json()).deferred,true);
    const virtual=await (await request(`/api/chats/${chat.id}`)).json();assert.equal(virtual.turns[0].allowWeb,true);assert.equal(virtual.turns[0].webProfileVersion,settings.settings.revision);
    assert.equal((await request(`/api/chats/${chat.id}/turns`,{...body,allowWeb:false})).status,409);assert.equal(calls.length,0);assert.equal(plans,0);
    gate.release(lease.token);lease=null;
    let turn;
    for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,100));const view=await request(`/api/chats/${chat.id}`);if(!view.ok)continue;turn=(await view.json()).turns[0];if(turn?.status==='completed')break;}
    assert.equal(turn?.status,'completed');assert.equal(calls.length,1);assert.equal(calls[0].body.query,'public words');assert.equal(turn.allowWeb,true);assert.equal(plans,1);assert.equal(turn.searchQuery,'');
  } finally {if(lease)gate.release(lease.token);await main.close();}
});

test("Backfill and late revisions are independently rate limited without committing on every minute check", async t => {
  const base = temp(t), root = instance(base), runtimeDir = join(base, 'runtime');
  mkdirSync(join(root, 'user-space/logs/daily'), { recursive: true });
  writeFileSync(join(root, 'user-space/logs/daily/DAILY-NOTE_2026-10-01.md'), '# \u5386\u53f2\u65e5\u62a5\n');
  let clock = Date.parse('2026-10-17T02:00:00Z'), collects = 0;
  const nodes = createNodeControl({ runtimeDir, now: () => clock });
  const reports = createMainReports({ root, runtimeDir, nodes, now: () => clock, backfillIntervalMs: 600_000, revisionIntervalMs: 600_000, collect: async () => { collects++; return { status: 'success', commit: 'abcdef1', changedFiles: 1, pushed: false }; } });
  const first = await reports.tick();
  assert.equal(first.worked, true, "The first maintenance pass backfills historical dates");
  assert.equal(collects, 0, "Historical backfill uses scheduled sync commits rather than per-day commits");
  assert.equal(nodes.operations().length, 0, "Historical dates do not request new sub Hub synchronization");
  const second = await reports.tick();
  assert.equal(second.worked, false, "No repeated backfill or revision within one interval");
  assert.equal(collects, 0);
  clock += 600_001;
  const third = await reports.tick();
  assert.equal(third.worked, true, "Backfill continues after the interval expires");
  assert.equal(collects, 0, "Still no per-day commits");
});

test("Bounded main Hub closing generates empty reports and revises late web/conflict data while preserving manual text", async t => {
  const base = temp(t), root = instance(base), runtimeDir = join(base, 'runtime'); let clock = Date.parse('2026-10-17T10:00:00Z'), calls = 0;
  const nodes = createNodeControl({ runtimeDir, now: () => clock }); nodes.enroll('offline-node');
  const reports = createMainReports({ root, runtimeDir, nodes, now: () => clock, closeWindowMs: 1000, runner: async () => { calls++; }, modelConsent: true, allowed: () => true });
  assert.equal(logicalDay(Date.parse('2026-10-17T21:59:00Z')), '2026-10-17');
  assert.equal(logicalDay(Date.parse('2026-10-17T22:00:00Z')), '2026-10-18');
  assert.equal((await reports.close('2026-10-17')).status, 'deferred'); clock += 1001;
  assert.equal((await reports.close('2026-10-17')).status, 'success'); assert.equal(calls, 0);
  const daily = join(root, 'user-space/logs/daily/DAILY-NOTE_2026-10-17.md');
  assert.match(readFileSync(daily, 'utf8'), /No artifacts collected for this day/i); writeFileSync(daily, '\u4eba\u5de5\u5907\u6ce8\n' + readFileSync(daily, 'utf8'));
  mkdirSync(join(root, 'user-space/logs/hub/conversations'), { recursive: true });
  writeFileSync(join(root, 'user-space/logs/hub/conversations/chat.json'), JSON.stringify({ turns: [{ id: 'turn', input: 'web question', answer: 'web answer', created: '2026-10-17T08:00:00Z', status: 'completed' }] }));
  const r = await reports.daily('2026-10-17'); assert.equal(r.revision, 2); assert.equal(r.empty, false); assert.equal(r.sourceCounts.web, 1);
  assert.match(readFileSync(daily, 'utf8'), /^\u4eba\u5de5\u5907\u6ce8/); assert.match(readFileSync(daily, 'utf8'), /web answer/);
  assert.equal((await reports.period('monthly', '2026-10')).missing.length, 30);
  assert.equal((await reports.period('yearly', '2026')).missing.length, 364);
});

test("Central distillation is independent of reports; candidates deduplicate, decisions await confirmation, and unknown models do not replay", async t => {
  const base = temp(t), root = instance(base), runtimeDir = join(base, 'runtime'), nodes = createNodeControl({ runtimeDir });
  const reports = createMainReports({ root, runtimeDir, nodes });
  mkdirSync(join(root, 'state/events'), { recursive: true }); writeFileSync(join(root, 'state/events/2026-10-17.jsonl'), '{"event_id":"e","type":"user_message","data":"fact"}\n');
  await reports.daily('2026-10-17'); let calls = 0, added = 0, confirmed = 0;
  const a = { allowedContent: () => true, distillAdd: async () => { added++; return 'candidate-1'; }, distillConfirm: async () => { confirmed++; } };
  const d = createMainDistillation({ root, runtimeDir, reports, adapter: () => a, consent: true, runner: async () => { calls++; return '[{"type":"method","text":"m"},{"type":"decision","text":"d"}]'; } });
  await d.run('2026-10-17'); await d.run('2026-10-17'); assert.equal(calls, 1); assert.equal(added, 2); assert.equal(confirmed, 1);
  assert.equal(Object.values(d.status().jobs)[0].candidates[1].phase, 'awaiting-user');
  writeFileSync(join(root, 'state/events/2026-10-17.jsonl'), '{"event_id":"e","type":"user_message","data":"fact"}\n{"event_id":"late","type":"user_message","data":"new evidence"}\n');
  await reports.daily('2026-10-17'); await d.run('2026-10-17');
  assert.equal(calls, 2); assert.equal(added, 2); assert.equal(confirmed, 1);
  const failedRuntime = join(base, 'failed-runtime'); let failedCalls = 0;
  const makeFailed = () => createMainDistillation({ root, runtimeDir: failedRuntime, reports, adapter: () => a, consent: true, runner: async () => { failedCalls++; throw new Error('unknown-result'); } });
  assert.equal((await makeFailed().run('2026-10-17')).jobStatus, 'model-unknown');
  const failedAgain = await makeFailed().run('2026-10-17');
  assert.equal(failedAgain.jobStatus, 'model-unknown'); assert.equal(failedAgain.status, 'blocked'); assert.equal(failedCalls, 1);
});

test("Missing consent and privacy blocks retain distinct distillation reasons instead of reporting no candidates", async t => {
  const base = temp(t), root = instance(base), nodes = createNodeControl({ runtimeDir: join(base, 'nodes') });
  const reports = createMainReports({ root, runtimeDir: join(base, 'reports'), nodes });
  mkdirSync(join(root, 'state/events'), { recursive: true });
  writeFileSync(join(root, 'state/events/2026-10-17.jsonl'), '{"event_id":"synthetic","type":"user_message","data":"fact"}\n');
  await reports.daily('2026-10-17');
  reports.status().days['2026-10-17'] = { closedAt: new Date().toISOString() };
  let calls = 0;
  for (const consent of [false, true]) {
    const runtimeDir = join(base, consent ? 'privacy-denied' : 'no-consent');
    const d = createMainDistillation({ root, runtimeDir, reports, consent, adapter: () => ({ allowedContent: () => false }), runner: async () => { calls++; return '[]'; } });
    const result = await d.tick();
    assert.equal(result.status, 'blocked'); assert.equal(result.code, consent ? 'privacy_blocked' : 'model_consent_required');
    assert.match(result.summary, consent ? /privacy/i : /consent|authorized/i); assert.equal(result.worked, false);
    assert.equal(d.status().lastRun.code, result.code); assert.equal(calls, 0);
  }
});

test("Clear boundaries cover registered subdirectories only; durable freeze leaves neighboring instances and remotes untouched", t => {
  const base = temp(t), managedBase = join(base, 'managed'); mkdirSync(managedBase);
  const root = instance(managedBase), runtimeDir = join(managedBase, 'runtime'); mkdirSync(runtimeDir); const sibling = instance(base, 'other');
  const config = { managedBase, root, runtimeDir, installationId: 'install-1' };
  const c = createSubLifecycle(config); c.freeze('operation-1'); assert.equal(createSubLifecycle(config).frozen(), true);
  c.clear('operation-1'); assert.equal(existsSync(root), false); assert.equal(existsSync(runtimeDir), false); assert.equal(existsSync(sibling), true);
  assert.throws(() => createSubLifecycle({ ...config, root: sibling }), /dedicated installation/i);
});

test("Lost clear receipts retry safely; cleared credentials cannot reconnect or affect other nodes", t => {
  const nodes = createNodeControl({ runtimeDir: temp(t) }), a = nodes.enroll('clear-test');
  const op = nodes.request(a.id, 'clear', 'clear-operation');
  nodes.ack(a.id, a.token, { id: op.id, status: 'success', code: 'cleared' });
  assert.equal(nodes.ack(a.id, a.token, { id: op.id, status: 'success', code: 'cleared' }).status, 'success');
  assert.throws(() => nodes.poll(a.id, a.token, a), /credentials/i);
  assert.equal(nodes.list().length, 0);
  const reinstalled = nodes.enroll(a.id); assert.notEqual(reinstalled.installationId, a.installationId);
  assert.throws(() => nodes.poll(a.id, a.token, a), /credentials/i);
  assert.equal(nodes.poll(reinstalled.id, reinstalled.token, reinstalled).operations.length, 0);
});

test("Frozen sub Hubs recover clearing only without synchronization setup or instance recloning", async t => {
  const base = temp(t), managedBase = join(base, 'managed'); mkdirSync(managedBase);
  const root = instance(managedBase), runtimeDir = join(managedBase, 'runtime'); mkdirSync(runtimeDir);
  const config = { managedBase, root, runtimeDir, nodeId: 'recovery-sub', installationId: 'installation', token: 'test-token', mainUrl: 'http://127.0.0.1:1', testMode: true };
  createSubLifecycle(config).freeze('local-clear');
  const sub = await createSubHub(config); assert.equal(sub.status().phase, 'cleared-recovery'); await sub.listen(); await sub.close();
  assert.equal(existsSync(root), false); assert.equal(existsSync(runtimeDir), false);
});

test("Main Web and sub IPC communicate; node credentials cannot access Web and reconnect actions have stable receipts", async t => {
  const base = temp(t), root = instance(base), subRoot = instance(base, 'sub-instance');
  const main = await createMainHub({ root, runtimeDir: join(base, 'main-runtime'), adapter, runner: async () => 'test', port: 0, tasks: { 'repo-sync': { enabled: false } } });
  let sub; t.after(async () => { await sub?.close(); await main.close(); });
  const origin = await main.listen(), enrollment = main.nodes.enroll('test-sub');
  sub = await createSubHub({ root: subRoot, runtimeDir: join(base, 'sub-runtime'), mainUrl: origin, nodeId: enrollment.id, ...enrollment, testMode: true });
  await sub.listen(); await sub.cycle(); assert.equal(main.nodes.list()[0].status, 'online');
  assert.equal((await subCommand(join(base, 'sub-runtime'), 'status')).role, 'sub');
  const response = await fetch(origin + '/api/nodes', { headers: { Authorization: `Bearer ${enrollment.token}` } }); assert.equal(response.status, 401);
  const op = main.nodes.request(enrollment.id, 'sync', 'end-to-end-op'); await sub.cycle();
  assert.equal(main.nodes.operations().find(o => o.id === op.id).status, 'error'); // Compatibility and safety behavior is covered by contract tests.
  assert.equal(sub.status().testMode, true);
});
