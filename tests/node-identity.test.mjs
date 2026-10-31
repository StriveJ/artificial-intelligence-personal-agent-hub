import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createNodeControl } from '../lib/node-control.mjs';
import { createMainHub } from '../main-server.mjs';

const TMP = resolve('aipa-test-tmp');
mkdirSync(TMP, { recursive: true });
function temp(t) {
  const path = mkdtempSync(join(TMP, 'node-identity-'));
  t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); });
  return path;
}
const poll = (nodes, node, body) => nodes.poll(node.id, node.token, { installationId: node.installationId, ...body });

test("member identity is advertised, addressable by name or alias, and survives restart", t => {
  const runtimeDir = temp(t);
  let nodes = createNodeControl({ runtimeDir, now: () => 1000 });
  const a = nodes.enroll('sub-lan-1');
  poll(nodes, a, { member: { name: '\u5c0f\u52a9\u624b', aliases: ['assistant'], persona: { tone: 'direct', initiative: 'high' } } });
  const [node] = nodes.list();
  assert.equal(node.member.name, '\u5c0f\u52a9\u624b');
  assert.deepEqual(node.member.aliases, ['assistant']);
  assert.equal(node.member.persona.initiative, 'high');
  assert.equal(node.member.persona.tone, 'direct');
  assert.equal(nodes.resolve('\u5c0f\u52a9\u624b'), 'sub-lan-1');
  assert.equal(nodes.resolve('ASSISTANT'), 'sub-lan-1');
  assert.equal(nodes.resolve('sub-lan-1'), 'sub-lan-1');
  assert.equal(nodes.resolve('unknown-member'), null);
  nodes = createNodeControl({ runtimeDir, now: () => 1000 });
  assert.equal(nodes.list()[0].member.name, '\u5c0f\u52a9\u624b');
});

test("a device that never advertises a member keeps working", t => {
  const runtimeDir = temp(t);
  const nodes = createNodeControl({ runtimeDir, now: () => 1000 });
  const a = nodes.enroll('legacy-node');
  poll(nodes, a, { sync: { status: 'success', code: 'current' }, capabilities: { protocolMin: 1, protocolMax: 1 } });
  assert.equal(nodes.list()[0].member, undefined);
  assert.equal(nodes.resolve('legacy-node'), 'legacy-node');
});

test("duplicate member names are rejected while the first device is live", t => {
  const runtimeDir = temp(t);
  const nodes = createNodeControl({ runtimeDir, now: () => 1000 });
  const a = nodes.enroll('node-a'), b = nodes.enroll('node-b');
  poll(nodes, a, { member: { name: 'helper' } });
  assert.throws(() => poll(nodes, b, { member: { name: 'Helper' } }), err => err.status === 409);
  assert.throws(() => poll(nodes, b, { member: { name: 'other', aliases: ['helper'] } }), err => err.status === 409);
  poll(nodes, b, { member: { name: 'other', aliases: ['assistant'] } });
  assert.equal(nodes.resolve('assistant'), 'node-b');
});

test("names and persona are validated, and unknown persona fields are refused", t => {
  const runtimeDir = temp(t);
  const nodes = createNodeControl({ runtimeDir, now: () => 1000 });
  const a = nodes.enroll('node-a');
  assert.throws(() => poll(nodes, a, { member: { name: '' } }), err => err.status === 400);
  assert.throws(() => poll(nodes, a, { member: { name: 'x'.repeat(41) } }), err => err.status === 400);
  assert.throws(() => poll(nodes, a, { member: { name: 'bad/name' } }), err => err.status === 400);
  assert.throws(() => poll(nodes, a, { member: { name: 'ok', persona: { mood: 'happy' } } }), err => err.status === 400);
  assert.throws(() => poll(nodes, a, { member: { name: 'ok', persona: { initiative: 'always' } } }), err => err.status === 400);
  assert.throws(() => poll(nodes, a, { member: { name: 'ok', aliases: ['a', 'b', 'c', 'd', 'e', 'f'] } }), err => err.status === 400);
  poll(nodes, a, { member: { name: 'ok', persona: { tone: 'terse' } } });
  assert.equal(nodes.list()[0].member.persona.initiative, undefined);
});

test("a removed device releases its member name", t => {
  const runtimeDir = temp(t);
  const nodes = createNodeControl({ runtimeDir, now: () => 1000 });
  const a = nodes.enroll('node-a'), b = nodes.enroll('node-b');
  poll(nodes, a, { member: { name: 'helper' } });
  const op = nodes.request(a.id, 'clear', 'clear-1');
  nodes.ack(a.id, a.token, { id: op.id, status: 'success', code: 'cleared' });
  poll(nodes, b, { member: { name: 'helper' } });
  assert.equal(nodes.resolve('helper'), 'node-b');
});

test("the Main Hub resolves a device operation addressed by member name", async t => {
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
  const enrolled = await (await fetch(origin + '/api/nodes/enroll', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, body: JSON.stringify({ id: 'lan-1' }) })).json();
  const poll = extra => fetch(origin + '/api/nodes/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolled.token}` }, body: JSON.stringify({ nodeId: 'lan-1', installationId: enrolled.installationId, ...extra }) });
  await poll({ member: { name: 'Lan Helper' } });
  const list = await (await fetch(origin + '/api/nodes', { headers: { Cookie } })).json();
  assert.equal(list.nodes[0].member.name, 'Lan Helper');
  const byName = await fetch(origin + '/api/nodes/' + encodeURIComponent('Lan Helper') + '/sync', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, body: JSON.stringify({ id: 'op-by-name-1' }) });
  assert.equal(byName.status, 202);
  const polled = await (await poll({})).json();
  assert.equal(polled.operations[0].id, 'op-by-name-1');
  const missing = await fetch(origin + '/api/nodes/nobody/sync', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie }, body: '{}' });
  assert.equal(missing.status, 404);
});