import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createTaskQueue } from '../lib/task-queue.mjs';

const TMP = resolve('aipa-test-tmp');
mkdirSync(TMP, { recursive: true });
function temp(t) {
  const path = mkdtempSync(join(TMP, 'task-queue-'));
  t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); });
  return path;
}
function clock(start = 1_000_000) {
  const state = { value: start };
  return { now: () => state.value, advance: ms => { state.value += ms; } };
}

test("submission validates input and is idempotent for the same id", t => {
  const runtimeDir = temp(t);
  const queue = createTaskQueue({ runtimeDir, now: () => 1000 });
  const task = queue.submit({ id: 'task-0001', prompt: "  Inspect the build  ", cwd: './projects/x', timeoutMs: 60_000 });
  assert.equal(task.state, 'queued');
  assert.equal(task.prompt, "Inspect the build");
  assert.equal(task.cwd, 'projects/x');
  assert.equal(task.attempts, 0);
  assert.equal(task.leaseSeconds, 180);
  assert.equal(queue.submit({ id: 'task-0001', prompt: "Inspect the build", cwd: 'projects/x' }).id, 'task-0001');
  assert.throws(() => queue.submit({ id: 'task-0001', prompt: "Different work" }), err => err.status === 409);
  assert.throws(() => queue.submit({ prompt: "" }), err => err.status === 400);
  assert.throws(() => queue.submit({ prompt: "x".repeat(8001) }), err => err.status === 400);
  assert.throws(() => queue.submit({ prompt: "ok", cwd: "/etc" }), err => err.status === 400);
  assert.throws(() => queue.submit({ prompt: "ok", cwd: "a/../../b" }), err => err.status === 400);
  assert.throws(() => queue.submit({ prompt: "ok", cwd: "C:/Windows" }), err => err.status === 400);
  assert.throws(() => queue.submit({ prompt: "ok", budgetUsd: -1 }), err => err.status === 400);
  assert.throws(() => queue.submit({ prompt: "ok", timeoutMs: 120_000, leaseSeconds: 60 }), err => err.status === 400);
});

test("claim leases the oldest queued task exactly once and records an attempt", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "first", timeoutMs: 30_000, leaseSeconds: 60 });
  time.advance(10);
  queue.submit({ id: 'task-0002', prompt: "second", timeoutMs: 30_000, leaseSeconds: 60 });
  const claimed = queue.claim({ nodeId: 'sub-a' });
  assert.equal(claimed.id, 'task-0001');
  assert.equal(claimed.attempt, 1);
  assert.ok(claimed.leaseId);
  assert.equal(queue.claim({ nodeId: 'sub-b' }).id, 'task-0002');
  assert.equal(queue.claim({ nodeId: 'sub-b' }), null);
  assert.equal(queue.get('task-0001').state, 'leased');
  assert.equal(queue.get('task-0001').claimedBy, 'sub-a');
});

test("heartbeat extends the lease and refuses after expiry", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "work", timeoutMs: 30_000, leaseSeconds: 60 });
  const claimed = queue.claim({ nodeId: 'sub-a' });
  time.advance(30_000);
  const renewed = queue.beat({ nodeId: 'sub-a', id: 'task-0001', leaseId: claimed.leaseId });
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(claimed.leaseExpiresAt));
  time.advance(61_000);
  assert.throws(() => queue.beat({ nodeId: 'sub-a', id: 'task-0001', leaseId: claimed.leaseId }), err => err.code === 'lease-expired' || err.code === 'not-leased');
});

test("ack closes the task once and repeats return the stored result", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "work", timeoutMs: 30_000, leaseSeconds: 60 });
  const claimed = queue.claim({ nodeId: 'sub-a' });
  const done = queue.ack({ nodeId: 'sub-a', id: 'task-0001', leaseId: claimed.leaseId, status: 'done', code: 'ok', summary: "Built 12 files", artifacts: ["out/build.log"] });
  assert.equal(done.state, 'done');
  assert.equal(done.result.summary, "Built 12 files");
  assert.equal(done.result.attempt, 1);
  const repeat = queue.ack({ nodeId: 'sub-a', id: 'task-0001', leaseId: claimed.leaseId, status: 'done', summary: "ignored" });
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.result.summary, "Built 12 files");
  assert.throws(() => queue.ack({ nodeId: 'sub-b', id: 'task-0001', leaseId: 'other-lease', status: 'done' }), err => err.status === 409);
});

test("a lease held by one worker cannot be acked by another", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "work", timeoutMs: 30_000, leaseSeconds: 60 });
  const claimed = queue.claim({ nodeId: 'sub-a' });
  assert.throws(() => queue.ack({ nodeId: 'sub-b', id: 'task-0001', leaseId: claimed.leaseId, status: 'done' }), err => err.status === 403);
  assert.throws(() => queue.ack({ nodeId: 'sub-a', id: 'task-0001', leaseId: 'wrong-lease', status: 'done' }), err => err.code === 'stale-lease');
});

test("an expired lease requeues with backoff and times out after the retry limit", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now, maxAttempts: 2 });
  queue.submit({ id: 'task-0001', prompt: "work", timeoutMs: 30_000, leaseSeconds: 60 });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claimed = queue.claim({ nodeId: 'sub-a' });
    assert.equal(claimed.attempt, attempt);
    time.advance(61_000);
    queue.sweep();
    assert.equal(queue.get('task-0001').state, attempt === 2 ? 'timeout' : 'queued');
    time.advance(6_000);
  }
  const task = queue.get('task-0001');
  assert.equal(task.result.code, 'lease-expired');
  assert.equal(queue.claim({ nodeId: 'sub-a' }), null);
});

test("a late result from the expired attempt is kept instead of being discarded", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "work", timeoutMs: 30_000, leaseSeconds: 60 });
  const claimed = queue.claim({ nodeId: 'sub-a' });
  time.advance(61_000);
  queue.sweep();
  assert.equal(queue.get('task-0001').state, 'queued');
  const late = queue.ack({ nodeId: 'sub-a', id: 'task-0001', attempt: claimed.attempt, status: 'done', summary: "Finished after the lease expired" });
  assert.equal(late.state, 'done');
  assert.equal(late.result.late, true);
  assert.equal(queue.claim({ nodeId: 'sub-a' }), null);
});

test("a failed worker is deprioritised for the same task, keeping fairness across workers", t => {
  const runtimeDir = temp(t), time = clock();
  const queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "work", timeoutMs: 30_000, leaseSeconds: 60 });
  const first = queue.claim({ nodeId: 'sub-a' });
  assert.equal(first.id, 'task-0001');
  time.advance(61_000);
  queue.sweep();
  time.advance(6_000);
  const second = queue.claim({ nodeId: 'sub-b' });
  assert.equal(second.id, 'task-0001');
  assert.equal(second.attempt, 2);
});

test("the queue survives a restart and lists by state", t => {
  const runtimeDir = temp(t), time = clock();
  let queue = createTaskQueue({ runtimeDir, now: time.now });
  queue.submit({ id: 'task-0001', prompt: "first", timeoutMs: 30_000, leaseSeconds: 60 });
  queue.submit({ id: 'task-0002', prompt: "second", timeoutMs: 30_000, leaseSeconds: 60 });
  queue.claim({ nodeId: 'sub-a' });
  queue = createTaskQueue({ runtimeDir, now: time.now });
  assert.equal(queue.list({ states: 'queued' }).length, 1);
  assert.equal(queue.list({ states: 'leased' }).length, 1);
  assert.equal(queue.list({ limit: 1 }).length, 1);
  assert.equal(queue.get('task-0002').state, 'queued');
});
