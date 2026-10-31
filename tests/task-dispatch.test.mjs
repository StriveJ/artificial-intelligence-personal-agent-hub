import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMainHub } from '../main-server.mjs';

const TMP = resolve('aipa-test-tmp');
mkdirSync(TMP, { recursive: true });
function temp(t) {
  const path = mkdtempSync(join(TMP, 'task-dispatch-'));
  t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); });
  return path;
}
const adapter = { owner: 'test', version: '1', requiresConsent: () => false, begin: async () => null, record: async () => null, context: async () => ({ prompt: 'test', sources: [], omitted: 0 }), search: async () => [], allowedContent: () => true };

async function hubWithNode(t) {
  const base = temp(t), root = join(base, 'instance'), runtimeDir = join(base, 'runtime');
  mkdirSync(root); mkdirSync(runtimeDir, { recursive: true }); mkdirSync(join(root, 'user-space'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  const hub = await createMainHub({ root, runtimeDir, port: 0, testMode: true, tasks: { 'repo-sync': { enabled: false } }, adapter, runner: async () => 'unused' });
  t.after(async () => { await hub.close(); });
  const origin = await hub.listen();
  const login = await fetch(origin + '/api/local-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  const Cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const enrolled = await (await fetch(origin + '/api/nodes/enroll', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, body: JSON.stringify({ id: 'lan-1' }) })).json();
  const node = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolled.token}` }, body: JSON.stringify({ nodeId: 'lan-1', installationId: enrolled.installationId, ...body }) });
  const session = (path, body, method = 'POST') => fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { origin, Cookie, enrolled, node, session };
}

test("a submitted task is claimed, reported and listed end to end", async t => {
  const { session, node, enrolled } = await hubWithNode(t);
  const submitted = await session('/api/task-queue', { prompt: "Inspect the build", cwd: 'projects/x', timeoutMs: 60_000 });
  assert.equal(submitted.status, 201);
  const task = await submitted.json();
  assert.equal(task.state, 'queued');
  const claimed = await (await node('/api/nodes/tasks/claim', {})).json();
  assert.equal(claimed.task.id, task.id);
  assert.equal(claimed.task.attempt, 1);
  assert.equal((await node('/api/nodes/tasks/beat', { id: task.id, leaseId: claimed.task.leaseId })).status, 200);
  const acked = await (await node('/api/nodes/tasks/ack', { id: task.id, leaseId: claimed.task.leaseId, attempt: 1, status: 'done', code: 'ok', summary: "Checked 4 packages" })).json();
  assert.equal(acked.state, 'done');
  const listed = await (await session('/api/task-queue?states=done', null, 'GET')).json();
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].result.summary, "Checked 4 packages");
  const nodes = await (await session('/api/nodes', null, 'GET')).json();
  assert.equal(nodes.nodes[0].id, 'lan-1');
  assert.ok(enrolled.token);
});

test("task endpoints refuse an unauthenticated device and a mismatched installation", async t => {
  const { origin, node, session } = await hubWithNode(t);
  await session('/api/task-queue', { prompt: "Inspect" });
  const badToken = await fetch(origin + '/api/nodes/tasks/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: JSON.stringify({ nodeId: 'lan-1', installationId: 'x' }) });
  assert.equal(badToken.status, 401);
  const badInstallation = await node('/api/nodes/tasks/claim', { installationId: 'other-installation' });
  assert.equal(badInstallation.status, 409);
});

test("task submission requires a signed-in session and validates the payload", async t => {
  const { origin, session } = await hubWithNode(t);
  const anonymous = await fetch(origin + '/api/task-queue', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: "Inspect" }) });
  assert.equal(anonymous.status, 401);
  const invalid = await session('/api/task-queue', { prompt: "" });
  assert.equal(invalid.status, 400);
  const traversal = await session('/api/task-queue', { prompt: "Inspect", cwd: '../outside' });
  assert.equal(traversal.status, 400);
});

test("claim returns an empty slot when nothing is queued", async t => {
  const { node } = await hubWithNode(t);
  const claimed = await (await node('/api/nodes/tasks/claim', {})).json();
  assert.equal(claimed.task, null);
});
