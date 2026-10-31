import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskWorker } from '../lib/task-worker.mjs';

function fakeMain(tasks = []) {
  const queue = [...tasks], calls = { claim: 0, beat: 0, ack: [] };
  return {
    calls, queue,
    post: async (path, body) => {
      if (path.endsWith('/claim')) { calls.claim += 1; return { task: queue.shift() || null }; }
      if (path.endsWith('/beat')) { calls.beat += 1; return { ok: true }; }
      if (path.endsWith('/ack')) { calls.ack.push(body); return { ...body, duplicate: false }; }
      throw new Error(`unexpected path ${path}`);
    },
  };
}
const task = (overrides = {}) => ({ id: 'task-0001', prompt: "Do the work", cwd: '', timeoutMs: 5_000, budgetUsd: 1, leaseId: 'lease-1', leaseSeconds: 30, attempt: 1, ...overrides });

test("a worker without an executor never claims", async () => {
  const main = fakeMain([task()]);
  const worker = createTaskWorker({ post: main.post, enabled: true });
  assert.equal(worker.status().enabled, false);
  assert.equal(await worker.drain(), 0);
  assert.equal(main.calls.claim, 0);
});

test("the worker claims, runs the executor and reports one result", async () => {
  const main = fakeMain([task()]);
  const seen = [];
  const worker = createTaskWorker({ post: main.post, enabled: true, runner: async input => { seen.push(input); return { summary: "Built 3 files", artifacts: ["out/log.txt"], code: 'ok' }; } });
  assert.equal(await worker.drain(), 1);
  assert.equal(seen[0].taskId, 'task-0001');
  assert.equal(seen[0].prompt, "Do the work");
  assert.equal(main.calls.ack.length, 1);
  assert.equal(main.calls.ack[0].status, 'done');
  assert.equal(main.calls.ack[0].summary, "Built 3 files");
  assert.deepEqual(main.calls.ack[0].artifacts, ["out/log.txt"]);
  assert.equal(main.calls.ack[0].leaseId, 'lease-1');
  assert.equal(worker.status().last.status, 'done');
});

test("a failing executor reports a failed result instead of throwing", async () => {
  const main = fakeMain([task()]);
  const worker = createTaskWorker({ post: main.post, enabled: true, runner: async () => { throw Object.assign(new Error("Model refused"), { code: 'refused' }); } });
  assert.equal(await worker.drain(), 1);
  assert.equal(main.calls.ack[0].status, 'failed');
  assert.equal(main.calls.ack[0].code, 'refused');
  assert.match(main.calls.ack[0].summary, /Model refused/);
});

test("a task that runs past its timeout is aborted and reported", async () => {
  const main = fakeMain([task({ timeoutMs: 40 })]);
  let aborted = false;
  const worker = createTaskWorker({ post: main.post, enabled: true, runner: input => new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error("aborted"), { code: 'aborted' })); }); }) });
  assert.equal(await worker.drain(), 1);
  assert.equal(aborted, true);
  assert.equal(main.calls.ack[0].status, 'failed');
  assert.equal(main.calls.ack[0].code, 'timeout');
});

test("long work renews the lease while running", async () => {
  const main = fakeMain([task()]);
  const worker = createTaskWorker({ post: main.post, enabled: true, beatEveryMs: 10, runner: () => new Promise(resolve => setTimeout(() => resolve({ summary: "slow but fine" }), 60)) });
  assert.equal(await worker.drain(), 1);
  assert.ok(main.calls.beat >= 2, `expected heartbeats, saw ${main.calls.beat}`);
  assert.equal(main.calls.ack[0].status, 'done');
});

test("drain keeps working through several queued tasks", async () => {
  const main = fakeMain([task({ id: 'task-0001' }), task({ id: 'task-0002', attempt: 1 })]);
  const worker = createTaskWorker({ post: main.post, enabled: true, runner: async () => ({ summary: "ok" }) });
  assert.equal(await worker.drain(), 2);
  assert.deepEqual(main.calls.ack.map(item => item.id), ['task-0001', 'task-0002']);
});

test("an ack failure does not crash the worker; the lease simply expires", async () => {
  const calls = [];
  const post = async (path, body) => {
    if (path.endsWith('/claim')) return { task: calls.some(item => item === 'claim') ? null : task() };
    calls.push('claim');
    if (path.endsWith('/beat')) return {};
    if (path.endsWith('/ack')) throw new Error("network down");
    return {};
  };
  const worker = createTaskWorker({ post, enabled: true, runner: async () => ({ summary: "ok" }) });
  assert.equal(await worker.drain(), 1);
});
