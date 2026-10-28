import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createTaskGate } from '../lib/task-gate.mjs';
import { handleTaskHook } from '../lib/task-bridge.mjs';
import { buildRelease, verifyRelease } from '../lib/release-package.mjs';
import { createUpdateManager } from '../lib/update-manager.mjs';
import { readJson, writeJson } from '../lib/storage.mjs';
import { createLauncher } from '../hub-launcher.mjs';
import { updateCommand } from '../lib/update-ipc.mjs';
import { serveUpdates, updateSocket } from '../lib/update-ipc.mjs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createMainHub } from '../main-server.mjs';
import { snapshotInstallation } from '../lib/update-snapshot.mjs';
import { readdirSync } from 'node:fs';
import { setInterval as repeat, clearInterval as cancelRepeat } from 'node:timers';

const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });

test("Snapshots yield during copying and ignore external runtime logs while preserving event JSONL", async t => {
  const path = mkdtempSync(join(TMP, 'cooperative-snapshot-'));
  t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); });
  const root = join(path, 'instance'), runtimeDir = join(path, 'runtime'), destination = join(path, 'snapshot'), configFile = join(path, 'config.json');
  mkdirSync(root); execFileSync('git', ['init', root], { stdio: 'pipe' }); mkdirSync(runtimeDir);
  createTaskGate(root).state();
  for (let i = 0; i < 96; i++) writeFileSync(join(root, `data-${String(i).padStart(3, '0')}.txt`), 'synthetic only');
  writeJson(configFile, { root, runtimeDir });
  writeFileSync(join(runtimeDir, 'hsk-main.log'), 'external daemon diagnostics');
  writeFileSync(join(runtimeDir, 'activity.jsonl'), '{"synthetic":true}\n');
  let observedPartial = false;
  const timer = repeat(() => {
    if (!existsSync(join(destination, 'instance'))) return;
    const count = readdirSync(join(destination, 'instance')).filter(name => name.startsWith('data-')).length;
    if (count > 0 && count < 96) observedPartial = true;
  }, 1);
  try { await snapshotInstallation({ root, runtimeDir, configFile, destination }); }
  finally { cancelRepeat(timer); }
  assert.equal(observedPartial, true, "Maintenance IPC must remain responsive while copying the directory tree");
  assert.equal(existsSync(join(destination, 'runtime/hsk-main.log')), false);
  assert.equal(readFileSync(join(destination, 'runtime/activity.jsonl'), 'utf8'), '{"synthetic":true}\n');
});
function fixture(t) {
  const cleanup = [];
  const path = mkdtempSync(join(TMP, 'updates-')); t.after(async () => { for (const close of cleanup) await close(); assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); });
  const root = join(path, 'instance'), runtimeDir = join(path, 'runtime'), base = join(path, 'program'), source = join(path, 'source'), catalogDir = join(path, 'catalog'), configFile = join(path, 'config.json');
  for (const p of [root, runtimeDir, base, source, catalogDir, join(base, 'control')]) mkdirSync(p, { recursive: true });
  execFileSync('git', ['init', root], { stdio: 'pipe' }); writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic\n');
  writeFileSync(join(root, '.git/aipa-hub-no-push.json'), '{"reason":"test"}');
  const installationId = randomUUID(); writeJson(configFile, { root, runtimeDir, installationId, testMode: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), trust = { keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } }; writeJson(join(base, 'control/trust.json'), trust);
  function release(id, sequence, { bad = false, overrides = {} } = {}) {
    const code = `import{readFileSync}from'node:fs';const c=JSON.parse(readFileSync(process.argv[3]));const timer=setInterval(()=>process.send?.({type:'hub-ready',role:'main',root:c.root,testMode:c.testMode,releaseId:${bad ? "'wrong-release'" : 'process.env.AIPA_HUB_RELEASE_ID'},deploymentGeneration:Number(process.env.AIPA_HUB_DEPLOYMENT_GENERATION),protocol:1,runtimeSchema:1,idle:true}),25);process.on('message',m=>{if(m.type==='hub-stop')process.exit(0)});process.on('disconnect',()=>process.exit(0));`;
    writeFileSync(join(source, 'main-server.mjs'), code);
    const envelope = buildRelease({ source, privateKey, keyId: 'test', manifest: { releaseId: id, version: `0.2.${sequence}`, sequence, sourceCommit: 'a'.repeat(40), roles: ['main', 'sub'], platforms: [process.platform], architectures: [process.arch], createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z', minNodeMajor: 24, minUpdaterVersion: 1, hubProtocol: 1, readRuntimeSchemas: [1], writeRuntimeSchema: 1, readInstanceFormats: [1], writeInstanceFormat: 1, maintenanceBoot: true, ...overrides } });
    const file = join(catalogDir, id + '.hubpkg.json'); writeJson(file, envelope); return verifyRelease(file, trust, { role: 'main' });
  }
  const options = { base, configFile, catalogDir, role: 'main', installationId, probationMs: 0 };
  return { path, root, runtimeDir, base, configFile, catalogDir, trust, release, options, cleanup };
}
const planBody = (manager, id, action = 'upgrade') => ({ target: { kind: 'main', nodeId: 'main', installationId: manager.status().installationId }, action, releaseId: id, expectedCurrentReleaseId: manager.current().releaseId, expectedDeploymentGeneration: manager.current().deploymentGeneration, when: 'idle', waitTimeoutSeconds: 2 });

test("Program updates disclose snapshot/startup scope and reject plans under no-personal-data policy",t=>{
 const f=fixture(t);let starts=0,stops=0;const manager=createUpdateManager({...f.options,driver:{start:async()=>{starts++;},stop:async()=>{stops++;},ready:async()=>true}});manager.bootstrap(f.release('v1',1));f.release('v2',2);
 for(const dataAccess of ['no-personal-data','framework-only'])assert.throws(()=>manager.createPlan({...planBody(manager,'v2'),dataAccess}),e=>e.code==='personal_data_access_required');
 assert.equal(starts,0);assert.equal(stops,0);assert.deepEqual(readJson(join(f.base,'control/updates.json')).plans,{});
 const plan=manager.createPlan(planBody(manager,'v2'));assert.equal(plan.dataAccess,'instance-snapshot');assert.ok(plan.access.reads.includes('instance/**'));assert.equal(plan.access.startsHub,true);assert.equal(plan.access.restoresPersonalData,false);assert.deepEqual(manager.status().updateAccess,plan.access);
 assert.equal(readdirSync(join(f.base,'snapshots')).length,0);
});

test("Native sessions block synchronization until ending; durable maintenance excludes task starts and survives gate rebuilding", async t => {
  const f = fixture(t), config = { root: f.root }, gate = createTaskGate(f.root);
  for (const tool of ['codex', 'claude', 'codebuddy', 'trae', 'deepseek', 'manual']) {
    handleTaskHook(config, tool, { session_id: 'one', hook_event_name: 'UserPromptSubmit' });
    assert.equal(gate.acquire('sync'), null);
    assert.equal(handleTaskHook(config, tool, { session_id: 'one', hook_event_name: 'PreToolUse' }).acquired, true);
    assert.throws(() => handleTaskHook(config, tool, { session_id: 'other', hook_event_name: 'UserPromptSubmit' }), /deferred/i);
    assert.equal(gate.pause('update-test').idle, false); assert.equal(createTaskGate(f.root).maintenance().operationId, 'update-test');
    handleTaskHook(config, tool, { session_id: 'one', hook_event_name: 'Stop' }); assert.equal(gate.acquire('task'), null);
    assert.throws(() => gate.resume('wrong'), /ownership/i); gate.resume('update-test');
  }
});

test("Release signatures, file digests, platforms, schemas, and immutable IDs verify before switching", t => {
  const f = fixture(t); f.release('v1', 1);
  const file = join(f.catalogDir, 'v1.hubpkg.json'), packageData = readJson(file);
  packageData.payload.contents['main-server.mjs'] = Buffer.from('changed').toString('base64'); writeJson(file, packageData);
  assert.throws(() => verifyRelease(file, f.trust, { role: 'main' }), /signature/i);
  assert.throws(() => f.release('schema2', 2, { overrides: { writeRuntimeSchema: 2 } }), /incompatible/i);
  assert.throws(() => f.release('expired', 3, { overrides: { expiresAt: '2000-01-01T00:00:00Z' } }), /expired/i);
});

test("Updates await tasks, enforce idempotency, and roll back failed candidates while preserving new data, no-push markers, and high-water sequences", async t => {
  const f = fixture(t); let active, reject = false;
  const driver = { start: async c => { active = c; }, stop: async () => { active = null; }, ready: async c => active?.releaseId === c.releaseId && !(reject && c.releaseId === 'v3') };
  const manager = createUpdateManager({ ...f.options, driver }); manager.bootstrap(f.release('v1', 1)); await driver.start(manager.current()); await manager.acceptBaseline();
  f.release('v2', 2); f.release('v3', 3);
  const body = planBody(manager, 'v2'), p = manager.idempotent('same-key-0001', body, () => manager.createPlan(body));
  assert.equal(manager.idempotent('same-key-0001', body, () => assert.fail()).id, p.id);
  assert.throws(() => manager.idempotent('same-key-0001', { ...body, releaseId: 'v3' }, () => assert.fail()), /idempotenc/i);
  manager.prepare(p.id); const prepared = manager.getPlan(p.id); const gate = createTaskGate(f.root), lock = gate.acquire('task');
  const op = manager.apply(p.id, prepared.revision); await new Promise(r => setTimeout(r, 50));
  assert.equal(manager.operation(op.id).phase, 'waiting_idle'); assert.equal(active.releaseId, 'v1'); gate.release(lock.token);
  await manager.wait(); assert.equal(manager.operation(op.id).result, 'installed'); assert.equal(manager.current().releaseId, 'v2');
  writeFileSync(join(f.root, 'new-record.txt'), 'new after upgrade');
  const p3 = manager.createPlan(planBody(manager, 'v3')); manager.prepare(p3.id); reject = true;
  const bad = manager.apply(p3.id, manager.getPlan(p3.id).revision); await manager.wait();
  assert.equal(manager.operation(bad.id).status, 'failed'); assert.equal(manager.operation(bad.id).recovered, true); assert.equal(manager.current().releaseId, 'v2');
  assert.equal(readFileSync(join(f.root, 'new-record.txt'), 'utf8'), 'new after upgrade'); assert.ok(existsSync(join(f.root, '.git/aipa-hub-no-push.json'))); assert.equal(gate.maintenance(), null);
  const back = manager.createPlan(planBody(manager, 'v1', 'rollback')); manager.prepare(back.id); manager.apply(back.id, manager.getPlan(back.id).revision); await manager.wait();
  assert.equal(manager.current().releaseId, 'v1'); assert.throws(() => manager.createPlan(planBody(manager, 'v1')), /already running/i);
  f.release('older', 1); assert.throws(() => manager.createPlan(planBody(manager, 'older')), /older release/i);
  assert.equal(readFileSync(join(f.root, 'new-record.txt'), 'utf8'), 'new after upgrade');
});

test("Independent launcher switches real Node children and keeps maintenance IPC available after main shutdown", async t => {
  const f = fixture(t), driver = { start: async () => {}, stop: async () => {}, ready: async () => true };
  const manager = createUpdateManager({ ...f.options, driver }); manager.bootstrap(f.release('v1', 1));
  const launcher = await createLauncher(f.options); f.cleanup.push(() => launcher.close()); await launcher.listen();
  assert.equal((await updateCommand(f.runtimeDir, 'status')).current.releaseId, 'v1');
  f.release('v2', 2);
  const p = await updateCommand(f.runtimeDir, 'plan', planBody(launcher.manager, 'v2'), 'launcher-plan-key');
  await updateCommand(f.runtimeDir, 'prepare', { id: p.id }, 'launcher-prepare-key');
  const prepared = await updateCommand(f.runtimeDir, 'get-plan', { id: p.id });
  const op = await updateCommand(f.runtimeDir, 'apply', { id: p.id, expectedPlanRevision: prepared.revision }, 'launcher-apply-key');
  await launcher.manager.wait(); assert.equal((await updateCommand(f.runtimeDir, 'operation', { id: op.id })).status, 'succeeded');
  assert.equal((await updateCommand(f.runtimeDir, 'status')).current.releaseId, 'v2');
});

test("Stale generations, wrong installations, expired plans, staged tampering, and cancellation never switch releases", async t => {
  const f = fixture(t); let clock = Date.now(), active;
  const driver = { start: async c => { active = c; }, stop: async () => { active = null; }, ready: async () => true };
  const manager = createUpdateManager({ ...f.options, driver, now: () => clock }); manager.bootstrap(f.release('v1', 1)); await driver.start(manager.current()); await manager.acceptBaseline(); f.release('v2', 2);
  assert.throws(() => manager.createPlan({ ...planBody(manager, 'v2'), expectedDeploymentGeneration: 0 }), /generation/i);
  assert.throws(() => manager.createPlan({ ...planBody(manager, 'v2'), target: { kind: 'main', installationId: 'other' } }), /generation/i);
  const stale = manager.createPlan(planBody(manager, 'v2')); clock += 86400_001; assert.throws(() => manager.prepare(stale.id), /expired/i); clock -= 86400_001;
  const p = manager.createPlan(planBody(manager, 'v2')); manager.prepare(p.id);
  const op = manager.apply(p.id, manager.getPlan(p.id).revision); manager.cancel(op.id); await manager.wait(); assert.equal(manager.operation(op.id).status, 'cancelled');
  const p2 = manager.createPlan(planBody(manager, 'v2')); manager.prepare(p2.id);
  writeFileSync(join(f.base, 'releases/v2/main-server.mjs'), 'modified after verify');
  const bad = manager.apply(p2.id, manager.getPlan(p2.id).revision); await manager.wait(); assert.equal(manager.operation(bad.id).status, 'failed'); assert.equal(manager.current().releaseId, 'v1'); assert.equal(active.releaseId, 'v1');
});

test("Failed rollback keeps durable pause and recovery restores accepted code without overwriting new records from old snapshots", async t => {
  const f = fixture(t); let failAll = false, active;
  const driver = { start: async c => { active = c; }, stop: async () => { active = null; }, ready: async () => !failAll };
  let manager = createUpdateManager({ ...f.options, driver }); manager.bootstrap(f.release('v1', 1)); await driver.start(manager.current()); await manager.acceptBaseline(); f.release('v2', 2);
  const p = manager.createPlan(planBody(manager, 'v2')); manager.prepare(p.id); failAll = true;
  const op = manager.apply(p.id, manager.getPlan(p.id).revision); await manager.wait();
  assert.equal(manager.operation(op.id).status, 'recovery_required'); assert.equal(createTaskGate(f.root).maintenance().operationId, op.id);
  writeFileSync(join(f.root, 'preserved.txt'), 'new data requiring preservation'); failAll = false;
  manager = createUpdateManager({ ...f.options, driver }); await manager.recover();
  assert.equal(manager.current().releaseId, 'v1'); assert.equal(manager.status().active, null); assert.equal(createTaskGate(f.root).maintenance(), null);
  assert.equal(readFileSync(join(f.root, 'preserved.txt'), 'utf8'), 'new data requiring preservation');
});

test("Inconsistent snapshot failure preserves the old process and release without starting a candidate", async t => {
  const f = fixture(t), starts = []; const driver = { start: async c => { starts.push(c.releaseId); }, stop: async () => {}, ready: async () => true };
  const manager = createUpdateManager({ ...f.options, driver }); manager.bootstrap(f.release('v1', 1)); await manager.acceptBaseline(); f.release('v2', 2);
  const p = manager.createPlan(planBody(manager, 'v2')); manager.prepare(p.id);
  const op = manager.apply(p.id, manager.getPlan(p.id).revision); mkdirSync(join(f.base, 'snapshots', op.id)); await manager.wait();
  assert.equal(manager.operation(op.id).status, 'failed'); assert.equal(manager.current().releaseId, 'v1'); assert.ok(!starts.includes('v2'));
});

test("Slow updater responses are delivered and missing responses are never treated as success", async t => {
  const runtimeDir = mkdtempSync(join(TMP, 'ipc-')); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  writeJson(join(runtimeDir, 'updater-access.json'), { token: 't'.repeat(32) });
  let received;
  const server = createServer({ allowHalfOpen: true }, socket => {
    let raw = '';
    socket.on('error', () => {});
    socket.on('data', async bytes => {
      raw += bytes; if (!raw.includes('\n')) return;
      received = JSON.parse(raw.slice(0, raw.indexOf('\n')));
      await delay(300); socket.end(JSON.stringify({ ok: true, result: { prepared: true } }) + '\n');
    });
  });
  await new Promise(r => server.listen(updateSocket(runtimeDir), r));
  try {
    assert.deepEqual(await updateCommand(runtimeDir, 'prepare', { id: 'slow-plan' }, 'slow-key-0001'), { prepared: true });
    assert.equal(received.key, 'slow-key-0001'); assert.equal(received.action, 'prepare');
  } finally { await new Promise(r => server.close(r)); }

  const silent = createServer({ allowHalfOpen: true }, socket => { socket.on('error', () => {}); socket.on('data', () => socket.destroy()); });
  await new Promise(r => silent.listen(updateSocket(runtimeDir), r));
  try {
    await assert.rejects(updateCommand(runtimeDir, 'prepare', { id: 'silent-plan' }, 'silent-key-0001'), /returned no result.*idempotency key/i);
  } finally { await new Promise(r => silent.close(r)); }
});

test("Ten maintenance endpoints require owner Cookie, Origin, and idempotency; node tokens cannot update and queries/cancel remain available during maintenance", async t => {
  const f = fixture(t), driver = { start: async () => {}, stop: async () => {}, ready: async () => true };
  const manager = createUpdateManager({ ...f.options, driver }); manager.bootstrap(f.release('v1', 1)); await manager.acceptBaseline(); f.release('v2', 2);
  const ipc = await serveUpdates(f.runtimeDir, manager); f.cleanup.push(() => new Promise(r => ipc.close(r)));
  const adapter = { owner: 'test', version: '1', requiresConsent: () => false, record: async () => null, allowedContent: () => false };
  const hub = await createMainHub({ root: f.root, runtimeDir: f.runtimeDir, port: 0, testMode: true, tasks: { 'repo-sync': { enabled: false } }, adapter, runner: async () => 'unused' });
  f.cleanup.unshift(() => hub.close()); const origin = await hub.listen();
  const call = (suffix, body, extra = {}) => fetch(origin + '/api/admin/updates/' + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call('status')).status, 401);
  const login = await fetch(origin + '/api/local-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }); const Cookie = login.headers.get('set-cookie').split(';')[0];
  const owner = { Cookie, 'Idempotency-Key': 'owner-operation-key' };
  assert.equal((await call('check', { target: 'main' }, { ...owner, Origin: 'https://wrong.example' })).status, 403);
  const missingKey = await call('check', { target: planBody(manager, 'v2').target, channel: 'stable' }, { Cookie }); assert.equal(missingKey.status, 400); assert.match((await missingKey.json()).message, /Idempotency/);
  assert.equal((await call('check', { target: planBody(manager, 'v2').target, channel: 'stable' }, owner)).status, 200);
  assert.equal((await call('releases', undefined, { Cookie })).status, 200);
  const p = await (await call('plans', planBody(manager, 'v2'), { ...owner, 'Idempotency-Key': 'owner-plan-key' })).json(); assert.ok(p.planId);
  assert.equal((await call(`plans/${p.planId}`, undefined, { Cookie })).status, 200);
  assert.equal((await call(`plans/${p.planId}/prepare`, {}, { ...owner, 'Idempotency-Key': 'owner-prepare-key' })).status, 202);
  const gate = createTaskGate(f.root); let task;
  for (let attempt = 0; attempt < 100 && !task; attempt++) { task = gate.acquire('task'); if (!task) await new Promise(r => setTimeout(r, 10)); }
  assert.ok(task);
  try {
    const revision = manager.getPlan(p.planId).revision;
    const response = await call(`plans/${p.planId}/apply`, { expectedPlanRevision: revision }, { ...owner, 'Idempotency-Key': 'owner-apply-key' }); assert.equal(response.status, 202); const op = await response.json();
    assert.equal((await call('status', undefined, { Cookie })).status, 200); assert.equal((await fetch(origin + '/readyz')).status, 503);
    assert.equal((await call(`operations/${op.operationId}`, undefined, { Cookie })).status, 200);
    assert.equal((await call(`operations/${op.operationId}/cancel`, {}, { ...owner, 'Idempotency-Key': 'owner-cancel-key' })).status, 202);
    await manager.wait(); assert.equal(manager.operation(op.operationId).status, 'cancelled');
  } finally { gate.release(task.token); }
  assert.equal((await call('history', undefined, { Cookie })).status, 200);
  const node = hub.nodes.enroll('cannot-update'); assert.equal((await call('status', undefined, { Authorization: `Bearer ${node.token}` })).status, 401);
  assert.equal((await call('status?target=node:cannot-update', undefined, { Cookie })).status, 409);
});
