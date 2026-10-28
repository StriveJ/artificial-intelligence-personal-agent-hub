import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createActivityLog, describeTask } from '../lib/activity-log.mjs';
import { createRuntimeStatus } from '../lib/runtime-status.mjs';
import { createMainHub } from '../main-server.mjs';

const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });
function temp(t) { const path = mkdtempSync(join(TMP, 'status-')); t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); }); return path; }

test("Activity logs append chronologically and filter limits, kinds, statuses, actions, and cursors", t => {
  let clock = Date.parse('2026-10-17T15:00:00Z');
  const log = createActivityLog({ runtimeDir: temp(t), now: () => (clock += 1000) });
  log.append({ kind: 'task', action: 'repo-sync', status: 'started', summary: '\u5f00\u59cb\u540c\u6b65' });
  log.append({ kind: 'task', action: 'repo-sync', status: 'success', summary: 'Automatic repository sync (Pushed / pulled 4 files)', detail: { pushed: true, changedFiles: 4, commit: 'add48d6' } });
  log.append({ kind: 'device', action: 'node-sync', status: 'info', summary: '\u5411 sub-main-server \u8bf7\u6c42\u7acb\u5373\u540c\u6b65', detail: { deviceId: 'sub-main-server' } });
  log.append({ kind: 'task', action: 'daily-briefing', status: 'failed', summary: '\u751f\u6210\u6bcf\u65e5\u8d44\u8baf\u5931\u8d25' });
  assert.equal(log.list({ limit: 10 }).items.length, 4);
  assert.equal(log.list({ limit: 2 }).items[0].action, 'daily-briefing', "Newest records first");
  assert.deepEqual(log.list({ kinds: ['device'] }).items.map(item => item.action), ['node-sync']);
  assert.deepEqual(log.list({ actions: ['repo-sync'] }).items.map(item => item.status), ['success', 'started']);
  assert.deepEqual(log.list({ statuses: ['failed', 'error', 'blocked'] }).items.map(item => item.action), ['daily-briefing']);
  const page = log.list({ limit: 2 });
  assert.deepEqual(log.list({ limit: 5, before: page.items[1].id }).items.map(item => item.status), ['success', 'started']);
  assert.equal(log.stats().total, 4);
});

test("Log retention keeps recent records and ignores damaged partial lines", t => {
  let clock = Date.parse('2026-10-17T15:00:00Z');
  const log = createActivityLog({ runtimeDir: temp(t), now: () => (clock += 1000), retention: 5, trimTo: 3 });
  for (let i = 0; i < 8; i++) log.append({ kind: 'task', action: 'repo-sync', status: 'success', summary: `Request ${i}` });
  const kept = log.list({ limit: 10 }).items;
  assert.equal(kept.length, 5, "Trim when exceeding retention and continue appending");
  assert.equal(kept[0].summary, 'Request 7');
  appendFileSync(log.file, '{"broken":\n');
  const after = log.list({ limit: 10 });
  assert.equal(after.total, 5);
  assert.equal(after.items[0].summary, 'Request 7');
});

test("Log redaction drops unlisted fields, truncates summaries, and excludes body content", t => {
  const log = createActivityLog({ runtimeDir: temp(t) });
  const entry = log.append({
    kind: 'task', action: 'repo-sync', status: 'success', summary: 'x'.repeat(500),
    detail: { pushed: true, commit: 'add48d6', changedFiles: 4, token: 'secret-token', path: '/srv/aipa-instance', note: '\u7528\u6237\u968f\u624b\u8bb0\u539f\u6587', nested: { apiKey: 'k' }, code: 'updated', durationMs: 1200, pushedAgain: 'yes' },
  });
  assert.equal(entry.summary.length, 200);
  assert.deepEqual(Object.keys(entry.detail).sort(), ['changedFiles', 'code', 'commit', 'durationMs', 'pushed']);
  const stored = JSON.parse(readFileSync(log.file, 'utf8').trim());
  assert.equal(stored.detail.token, undefined);
  assert.doesNotMatch(readFileSync(log.file, 'utf8'), /secret-token|\u7528\u6237\u968f\u624b\u8bb0\u539f\u6587|apiKey/);
});

test("Task log wording clearly describes synchronization, news, deferral, and failure", () => {
  assert.equal(describeTask('repo-sync', "Bidirectional repository sync", { status: 'success', pushed: true, changedFiles: 4 }), 'Automatic repository sync (Pushed / pulled 4 files)');
  assert.equal(describeTask('repo-sync', "Bidirectional repository sync", { status: 'success', pushSuppressed: true, changedFiles: 0 }, { manual: true }), 'Manual repository sync (Push suppressed in test mode / pulled 0 files)');
  assert.equal(describeTask('daily-briefing', "Daily news notification", { status: 'success' }), 'Automatic daily news generated (added to inbox)');
  assert.equal(describeTask('repo-sync', "Bidirectional repository sync", { status: 'deferred', summary: 'Conversation in progress' }), 'Bidirectional repository sync deferred: Conversation in progress');
  assert.equal(describeTask('repo-sync', "Bidirectional repository sync", { status: 'blocked', summary: 'Conflicts exist' }), 'Bidirectional repository sync needs attention: Conflicts exist');
  assert.match(describeTask('main-day-cycle', '\u4e3b Hub \u5f00\u5de5、\u6536\u5de5\u4e0e\u62a5\u8868', { status: 'success' }), /daily workflow/i);
  assert.equal(describeTask('main-day-start', "Main Hub workday start", { status: 'success', summary: '\u4e3b Hub \u5df2\u5f00\u5de5（2026-10-18），\u5df2\u8bf7\u6c42\u4ece\u7aef\u540c\u6b65' }), '\u4e3b Hub \u5df2\u5f00\u5de5（2026-10-18），\u5df2\u8bf7\u6c42\u4ece\u7aef\u540c\u6b65');
  assert.equal(describeTask('main-day-start', "Main Hub workday start", { status: 'success' }), "Main Hub workday started");
  assert.match(describeTask('main-day-close', "Main Hub workday close and reports", { status: 'success' }), /^Automatic workday closed and daily report generated/i);
  assert.match(describeTask('main-report-maintenance', "Report backfill and late revisions", { status: 'success' }), /historical reports backfilled and late revisions applied/);
});

test("Runtime snapshots include complete main Hub fields and sub Hub online, busy, and incompatible states", t => {
  const activity = createActivityLog({ runtimeDir: temp(t) });
  const status = createRuntimeStatus({
    startedAt: new Date(Date.now() - 3_600_000).toISOString(), role: 'main', label: "Main Hub",
    endpoints: { port: 4317, publicPort: 4319, publicOrigins: ['https://example.ts.net'] }, activity,
    getReadiness: () => ({ releaseId: '0.3.0', deploymentGeneration: 2, testMode: false, protocol: 1, runtimeSchema: 1, idle: true, maintenance: false, closing: false }),
    getTasks: () => [{ id: 'repo-sync', label: "Bidirectional repository sync", enabled: true, status: 'success', nextRunAt: '2026-10-18T00:00:00Z', lastSuccessAt: '2026-10-17T23:00:00Z', result: { summary: '\u5df2\u540c\u6b65' } }],
    getNodes: () => [
      { id: 'sub-main-server', status: 'online', lastSeen: '2026-10-17T23:00:00Z', taskBusy: true, protocolCompatible: true, capabilities: { platform: 'win32', arch: 'x64', releaseId: 'development', testMode: false }, sync: { status: 'success', code: 'updated', commit: 'add48d6', pushed: false } },
      { id: 'old-node', status: 'offline', protocolCompatible: false, capabilities: { platform: 'linux', arch: 'arm64' }, sync: null },
    ],
  });
  const snapshot = status.snapshot();
  assert.equal(snapshot.main.status, 'online');
  assert.equal(snapshot.main.releaseId, '0.3.0');
  assert.equal(snapshot.main.testMode, false);
  assert.equal(snapshot.main.maintenance, null);
  assert.ok(snapshot.main.uptimeMs >= 3_500_000);
  assert.equal(snapshot.main.endpoints.publicPort, 4319);
  assert.deepEqual(snapshot.main.endpoints.publicOrigins, ['https://example.ts.net']);
  assert.equal(snapshot.tasks[0].summary, '\u5df2\u540c\u6b65');
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.devices[0].status, 'online');
  assert.equal(snapshot.devices[0].taskBusy, true);
  assert.equal(snapshot.devices[0].sync.commit, 'add48d6');
  assert.equal(snapshot.devices[1].status, 'offline');
  assert.equal(snapshot.devices[1].protocolCompatible, false);
  assert.equal(snapshot.activity.retention, 1000);
});

test("Finished tasks hide start entries while active tasks remain visible once", async () => {
  const { visibleActivity } = await import('../public/status.js');
  const items = [
    { id: '1', status: 'started', detail: { runId: 'done' }, summary: '\u6309\u8ba1\u5212\u6267\u884c\u540c\u6b65' },
    { id: '2', status: 'success', detail: { runId: 'done' }, summary: 'Automatic repository sync (Pushed / pulled 4 files)' },
    { id: '3', status: 'started', detail: { runId: 'running' }, summary: '\u6309\u8ba1\u5212\u6267\u884c\u8d44\u8baf' },
    { id: '4', status: 'info', summary: "Automatic sign-in through local entry" },
  ];
  assert.deepEqual(visibleActivity(items).map(item => item.id), ['2', '3', '4']);
});

test("Device presence logs only transitions and operation receipts log one result", async t => {
  const base = temp(t), root = join(base, 'instance'), runtimeDir = join(base, 'runtime');
  mkdirSync(root); mkdirSync(runtimeDir, { recursive: true }); mkdirSync(join(root, 'user-space'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  const adapter = { owner: 'test', version: '1', requiresConsent: () => false, begin: async () => null, record: async () => null, context: async () => ({ prompt: 'test', sources: [], omitted: 0 }), search: async () => [], allowedContent: () => true };
  const hub = await createMainHub({ root, runtimeDir, port: 0, testMode: true, tasks: { 'repo-sync': { enabled: false } }, adapter, runner: async () => 'unused' });
  t.after(async () => { await hub.close(); });
  const origin = await hub.listen();
  const login = await fetch(origin + '/api/local-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  const Cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const enrolled = await (await fetch(origin + '/api/nodes/enroll', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, body: JSON.stringify({ id: 'test-sub' }) })).json();
  const poll = extra => fetch(origin + '/api/nodes/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolled.token}` }, body: JSON.stringify({ nodeId: 'test-sub', installationId: enrolled.installationId, ...extra }) });
  const deviceLog = async () => (await (await fetch(origin + '/api/activity?kind=device&limit=20', { headers: { Cookie } })).json()).items;
  await poll({}); await poll({});
  const presence = (await deviceLog()).filter(item => item.action === 'node-presence');
  assert.equal(presence.length, 1, "Repeated heartbeats do not create extra records");
  assert.match(presence[0].summary, /test-sub Online/);
  const requested = await (await fetch(origin + '/api/nodes/test-sub/sync', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, body: JSON.stringify({ id: 'operation-status-1' }) })).json();
  const polled = await (await poll({})).json();
  assert.equal(polled.operations[0].id, requested.id);
  await fetch(origin + '/api/nodes/ack', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolled.token}` }, body: JSON.stringify({ nodeId: 'test-sub', installationId: enrolled.installationId, id: requested.id, status: 'success', code: 'updated', pushed: true, commit: 'add48d6' }) });
  const result = (await deviceLog()).find(item => item.action === 'node-result');
  assert.match(result.summary, /test-sub Sync complete \(pushed, updated\)/);
  assert.equal(result.detail.commit, 'add48d6');
  assert.equal(result.detail.deviceId, 'test-sub');
  assert.doesNotMatch(JSON.stringify(result), /Bearer|token/i);
});

test("Main daily workflow runs fixed start 08:00, close 02:00, and distillation 02:30 schedules", async t => {
  const base = temp(t), root = join(base, 'instance'), runtimeDir = join(base, 'runtime');
  mkdirSync(root); mkdirSync(runtimeDir, { recursive: true }); mkdirSync(join(root, 'user-space'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  const adapter = { owner: 'test', version: '1', requiresConsent: () => false, begin: async () => null, record: async () => null, context: async () => ({ prompt: 'test', sources: [], omitted: 0 }), search: async () => [], allowedContent: () => true };
  const hub = await createMainHub({ root, runtimeDir, port: 0, testMode: true, tasks: { 'repo-sync': { enabled: false } }, adapter, runner: async () => 'unused' });
  t.after(async () => { await hub.close(); });
  const origin = await hub.listen();
  const login = await fetch(origin + '/api/local-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  const Cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const tasks = (await (await fetch(origin + '/api/tasks', { headers: { Cookie } })).json()).tasks;
  const byId = Object.fromEntries(tasks.map(task => [task.id, task]));
  assert.equal(byId['main-day-start'].dailyAt, '08:00');
  assert.equal(byId['main-day-start'].intervalMinutes, null);
  assert.equal(byId['main-day-close'].dailyAt, '02:00');
  assert.equal(byId['main-distillation'].dailyAt, '02:30');
  assert.equal(byId['main-report-maintenance'].intervalMinutes, 10);
  assert.equal(byId['main-day-cycle'], undefined, "Daily workflow no longer runs on every minute tick");
  assert.equal(byId['main-day-close'].timeZone, 'Asia/Shanghai');
});

test("Every page ID referenced by scripts exists", () => {
  const html = readFileSync(resolve('public/index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  const scripts = ['public/app.js', 'public/navigation.js', 'public/status.js', 'public/task-list.js'];
  const referenced = new Set();
  for (const file of scripts) for (const match of readFileSync(resolve(file), 'utf8').matchAll(/\$\('([a-zA-Z0-9_-]+)'\)|getElementById\('([a-zA-Z0-9_-]+)'\)/g)) referenced.add(match[1] || match[2]);
  const missing = [...referenced].filter(id => !ids.has(id) && !['status', 'notes', 'memory', 'tasks', 'pushes', 'chat'].includes(id));
  assert.deepEqual(missing, [], "Script references an ID absent from HTML");
  for (const id of ['status-view', 'status-devices', 'status-activity', 'status-activity-empty', 'status-filters', 'status-summary', 'status-refresh']) assert.ok(ids.has(id), `\u7f3a\u5c11 ${id}`);
  assert.match(readFileSync(resolve('public/index.html'), 'utf8'), /href="\/status.css"/);
});

test("Status API requires connected sessions; activity API bounds limits and reports accurate totals", async t => {
  const base = temp(t), root = join(base, 'instance'), runtimeDir = join(base, 'runtime');
  mkdirSync(root); mkdirSync(runtimeDir, { recursive: true }); mkdirSync(join(root, 'user-space'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  const adapter = { owner: 'test', version: '1', requiresConsent: () => false, begin: async () => null, record: async () => null, context: async () => ({ prompt: 'test', sources: [], omitted: 0 }), search: async () => [], allowedContent: () => true };
  const hub = await createMainHub({ root, runtimeDir, port: 0, testMode: true, tasks: { 'repo-sync': { enabled: false } }, adapter, runner: async () => 'unused' });
  t.after(async () => { await hub.close(); });
  const origin = await hub.listen();
  const query = (path, options = {}) => fetch(origin + path, { ...options, headers: { Connection: 'close', ...options.headers } });
  assert.equal((await query('/api/runtime/status')).status, 401);
  assert.equal((await query('/api/activity')).status, 401);
  const login = await query('/api/local-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  const Cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(Cookie);
  const status = await (await query('/api/runtime/status', { headers: { Cookie } })).json();
  assert.equal(status.main.role, 'main');
  assert.equal(status.main.endpoints.port, origin.split(':').pop() * 1);
  for (let i = 0; i < 220; i++) hub.activity.append({ kind: 'task', action: 'repo-sync', status: 'success', summary: `Record ${i}` });
  const page = await (await query('/api/activity?limit=999', { headers: { Cookie } })).json();
  assert.equal(page.items.length, 200, "limit is capped at 200");
  assert.equal(page.retention, 1000);
  assert.ok(page.total >= 220);
  const filtered = await (await query('/api/activity?kind=device&limit=5', { headers: { Cookie } })).json();
  assert.ok(filtered.items.every(item => item.kind === 'device'));
  const failed = await (await query('/api/activity?status=failed&limit=5', { headers: { Cookie } })).json();
  assert.ok(failed.items.every(item => ['failed', 'error', 'blocked'].includes(item.status)));
  const sync = await (await query('/api/activity?kind=task&action=repo-sync&limit=3', { headers: { Cookie } })).json();
  assert.ok(sync.items.every(item => item.kind === 'task' && item.action === 'repo-sync'));
  assert.equal(sync.items[0].summary, 'Record 219');
  assert.equal((await query('/api/activity?limit=abc&kind=nope', { headers: { Cookie } })).status, 200, "Invalid parameters use defaults rather than HTTP 500");
  assert.equal(existsSync(join(runtimeDir, 'activity.jsonl')), true);
  const firstPage = await (await query('/api/activity?kind=task&action=repo-sync&limit=100&offset=0', { headers: { Cookie } })).json();
  assert.equal(firstPage.limit, 100);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.total, 220, "Filtered totals count only repo-sync tasks");
  assert.ok(firstPage.totalAll >= 220 + filtered.total, "Return the unfiltered total separately");
  const secondPage = await (await query('/api/activity?kind=task&action=repo-sync&limit=100&offset=100', { headers: { Cookie } })).json();
  assert.equal(secondPage.offset, 100);
  assert.equal(secondPage.items.length, 100);
  assert.equal(secondPage.items[0].summary, 'Record 119');
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id, "Pages must not duplicate records");
  const lastPage = await (await query('/api/activity?kind=task&action=repo-sync&limit=100&offset=200', { headers: { Cookie } })).json();
  assert.equal(lastPage.items.length, 20);
  const failedTotal = (await (await query('/api/activity?status=failed', { headers: { Cookie } })).json()).total;
  assert.ok(failedTotal < firstPage.total, "Different filters have different totals");
  assert.equal((await (await query('/api/activity?kind=device', { headers: { Cookie } })).json()).total, filtered.total);
});
