import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMainReports } from '../lib/main-reports.mjs';
import { createMainHub } from '../main-server.mjs';

const base = resolve(process.env.AIPA_TEST_TMP || 'aipa-test-tmp');
mkdirSync(base, { recursive: true });
function fixture(t) {
  const work = mkdtempSync(join(base, 'report-sync-policy-'));
  t.after(() => { assert.ok(work.startsWith(base + sep)); rmSync(work, { recursive: true, force: true }); });
  const root = join(work, 'instance'), runtimeDir = join(work, 'runtime');
  mkdirSync(root); mkdirSync(join(root, 'user-space'));
  return { root, runtimeDir };
}
function control() {
  const operations = []; let requests = 0;
  return { operations: () => operations, list: () => [{ id: 'synthetic-node' }],
    request(nodeId, kind) { requests++; const op = { id: 'synthetic-operation-' + requests, nodeId, kind, status: 'queued' }; operations.push(op); return op; },
    requests: () => requests };
}

test('Disabled report synchronization closes locally without collecting Git or requesting Sub operations', async t => {
  const f = fixture(t), nodes = control(); let collected = 0;
  const reports = createMainReports({ ...f, nodes, syncEnabled: false, now: () => Date.parse('2026-10-21T08:00:00Z'), collect: async () => { collected++; return { status: 'success' }; } });
  const result = await reports.close('2026-10-20');
  assert.equal(result.status, 'success'); assert.equal(collected, 0); assert.equal(nodes.requests(), 0);
  const saved = reports.read('daily', '2026-10-20').metadata;
  assert.equal(saved.collection.mainSync.status, 'skipped'); assert.equal(saved.collection.mainSync.code, 'repo_sync_disabled');
});

test('Disabling synchronization after restart preserves queued request history without waiting or recollecting', async t => {
  const f = fixture(t), nodes = control(); let collected = 0;
  const now = () => Date.parse('2026-10-21T08:00:00Z');
  const common = { ...f, nodes, now, collect: async () => { collected++; return { status: 'success' }; } };
  const first = createMainReports({ ...common, syncEnabled: true });
  assert.equal((await first.close('2026-10-20')).status, 'deferred'); assert.equal(nodes.requests(), 1);
  const original = JSON.stringify(nodes.operations());
  const restarted = createMainReports({ ...common, syncEnabled: false });
  assert.equal((await restarted.close('2026-10-20')).status, 'success');
  assert.equal(collected, 0); assert.equal(nodes.requests(), 1); assert.equal(JSON.stringify(nodes.operations()), original);
  assert.equal(restarted.status().days['2026-10-20'].closing.requests.length, 1);
  await restarted.tick(); assert.equal(collected, 0); assert.equal(nodes.requests(), 1);
});

test('Enabled report synchronization retains collection and device request behavior', async t => {
  const f = fixture(t), nodes = control(); let collected = 0;
  const reports = createMainReports({ ...f, nodes, syncEnabled: true, closeWindowMs: 0, now: () => Date.parse('2026-10-21T08:00:00Z'), collect: async () => { collected++; return { status: 'success', pushed: true }; } });
  assert.equal((await reports.close('2026-10-20')).status, 'success');
  assert.equal(collected, 1); assert.equal(nodes.requests(), 1);
  assert.equal(reports.read('daily', '2026-10-20').metadata.collection.mainSync.pushed, true);
});

test('Main Hub passes the disabled repository policy to scheduled workday closing', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  execFileSync('git', ['init', f.root], { stdio: 'pipe' });
  const adapter = { owner: 'synthetic-test', version: '1', requiresConsent: () => false, begin: async () => null, record: async () => null, context: async () => ({ prompt: '', sources: [], omitted: 0 }), search: async () => [], allowedContent: () => false };
  const hub = await createMainHub({ ...f, adapter, tasks: { 'repo-sync': { enabled: false } }, main: { closeWindowMs: 0, modelConsent: false }, runner: async () => { throw Error('No model requests allowed'); } });
  t.after(() => hub.close());
  hub.nodes.enroll('synthetic-node');
  const closed = await hub.scheduler.runNow('main-day-close');
  assert.equal(closed.status, 'success'); assert.equal(hub.nodes.operations().length, 0);
  const saved = Object.values(hub.reports.status().days).find(day => day.closedAt);
  assert.ok(saved);
});
