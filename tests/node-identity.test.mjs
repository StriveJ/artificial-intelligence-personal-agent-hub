import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createNodeControl } from '../lib/node-control.mjs';

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
