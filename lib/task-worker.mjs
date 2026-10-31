// Task worker (T2). Runs inside a Sub Hub: claim one task, hold the lease with
// heartbeats, run the injected executor, report exactly one result.
//
// The executor is injected so this slice can be tested without a coding-agent CLI; the
// real executor lands in a later ticket. With no executor the worker is inert: it never
// claims, so a Main Hub simply sees a node that does not accept work.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createTaskWorker({ post, runner = null, enabled = false, intervalMs = 5_000, beatEveryMs = null, now = Date.now } = {}) {
  const active = enabled === true && typeof runner === 'function';
  let stopped = false, busy = false, timer = null, current = null;
  const history = [];
  const status = () => ({
    enabled: active, busy, current: current ? { id: current.id, attempt: current.attempt, startedAt: current.startedAt } : null,
    last: history[0] || null,
  });

  async function execute(task) {
    const controller = new AbortController();
    const beatEvery = beatEveryMs || Math.max(5_000, Math.floor((task.leaseSeconds * 1000) / 3));
    const heartbeat = setInterval(() => {
      post('/api/nodes/tasks/beat', { id: task.id, leaseId: task.leaseId }).catch(() => {});
    }, beatEvery);
    let timerId;
    try {
      const timeout = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          // Reject before aborting: an executor that rejects on abort must not win the race.
          reject(Object.assign(new Error("Task timed out"), { code: 'timeout' }));
          controller.abort();
        }, task.timeoutMs);
      });
      return await Promise.race([
        runner({ taskId: task.id, attempt: task.attempt, prompt: task.prompt, cwd: task.cwd, timeoutMs: task.timeoutMs, budgetUsd: task.budgetUsd, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearInterval(heartbeat); clearTimeout(timerId);
    }
  }

  async function runOne() {
    const claimed = await post('/api/nodes/tasks/claim', {});
    const task = claimed?.task;
    if (!task) return false;
    current = { ...task, startedAt: new Date(now()).toISOString() };
    let payload;
    try {
      const result = await execute(task);
      payload = {
        id: task.id, leaseId: task.leaseId, attempt: task.attempt, status: 'done',
        code: String(result?.code || 'ok').slice(0, 80),
        summary: String(result?.summary ?? result ?? '').slice(0, 4000),
        artifacts: Array.isArray(result?.artifacts) ? result.artifacts : [],
      };
    } catch (error) {
      payload = {
        id: task.id, leaseId: task.leaseId, attempt: task.attempt, status: 'failed',
        code: String(error?.code || 'executor-error').slice(0, 80),
        summary: String(error?.message || error || 'Executor failed').slice(0, 4000),
        artifacts: [],
      };
    }
    try { await post('/api/nodes/tasks/ack', payload); }
    catch { /* the lease expires and the Main Hub retries; nothing else to do here */ }
    history.unshift({ id: task.id, attempt: task.attempt, status: payload.status, code: payload.code, at: new Date(now()).toISOString() });
    history.length = Math.min(history.length, 20);
    current = null;
    return true;
  }

  async function loop() {
    if (!active || stopped || busy) return;
    busy = true;
    try { while (!stopped && await runOne()) { /* keep draining until the queue is empty */ } }
    catch { /* network or authentication problem: retry on the next tick */ }
    finally { busy = false; }
  }

  return {
    status,
    start() { if (!active || timer) return; void loop(); timer = setInterval(() => { void loop(); }, intervalMs); timer.unref?.(); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = null; while (busy) await sleep(10); },
    async drain() { if (!active) return 0; let count = 0; while (await runOne()) count += 1; return count; },
  };
}
