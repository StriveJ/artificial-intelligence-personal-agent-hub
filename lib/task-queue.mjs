import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './storage.mjs';

// Task dispatch queue (T2). One Main Hub owns the queue; Sub Hubs claim a task, hold a
// lease while they work, renew it with heartbeats, and report one result.
//
// Delivery is at-least-once: a worker that dies after doing the work but before acking
// will see the task again once the lease expires, so executors must tolerate a repeated
// prompt. A late result from the attempt that expired is still accepted while the task
// has not been claimed again (the work happened), and is marked `late`.
//
// Every mutation below is synchronous and the in-memory state is authoritative, so one
// claim/beat/ack cannot interleave with another inside this process. Persistence goes
// through atomicWrite, one file per concern (`tasks.json`).

const ID = /^[a-zA-Z0-9_-]{8,80}$/;
const THREAD = /^[a-zA-Z0-9._:-]{1,80}$/;
const STATES = new Set(['queued', 'leased', 'done', 'failed', 'timeout']);
const MAX_QUEUED = 200;
const MAX_FINISHED = 500;
const FINISHED_TTL_MS = 7 * 24 * 3600_000;
const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${name} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}
function relativePath(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 240) throw fail("Task cwd must be a short relative path");
  const path = value.replaceAll('\\', '/').trim();
  if (!path) return '';
  if (path.startsWith('/') || path.startsWith('//') || /^[a-zA-Z]:/.test(path)) throw fail("Task cwd must be relative to the instance root");
  if (path.split('/').some(part => part === '..')) throw fail("Task cwd must stay inside the instance root");
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}
function amount(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`${name} must be a number between ${min} and ${max}`);
  return value;
}

export function createTaskQueue({ runtimeDir, now = Date.now, maxAttempts = 3, defaultTimeoutMs = 600_000, leaseGraceMs = 120_000 } = {}) {
  const path = join(runtimeDir, 'task-queue.json');
  const loaded = readJson(path, null);
  // The scheduler owns tasks.json; keep this queue in its own file and never trust a
  // file written for a different purpose. Refuse to start on a foreign file rather than
  // silently rewriting it with an empty queue.
  if (loaded && loaded.kind !== 'task-queue') throw new Error(`Task queue file was written by something else: ${path}`);
  const state = loaded || { version: 1, kind: 'task-queue', tasks: {} };
  state.tasks ||= {};
  const save = () => writeJson(path, state);
  const iso = milliseconds => new Date(milliseconds).toISOString();
  const view = task => ({ ...task });
  const backoffMs = attempts => Math.min(60_000, 5_000 * 3 ** Math.max(0, attempts - 1));

  function prune(stamp) {
    const finished = Object.values(state.tasks)
      .filter(task => task.state !== 'queued' && task.state !== 'leased' && task.completedAt)
      .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    const stale = finished.filter(task => stamp - Date.parse(task.completedAt) > FINISHED_TTL_MS);
    const over = finished.slice(0, Math.max(0, finished.length - stale.length - MAX_FINISHED));
    for (const task of [...stale, ...over]) delete state.tasks[task.id];
  }

  function submit(input = {}) {
    const prompt = text(input.prompt, "Task prompt", 8000);
    const cwd = relativePath(input.cwd);
    const timeoutMs = amount(input.timeoutMs, "Task timeoutMs", 1_000, 3_600_000, defaultTimeoutMs);
    const leaseSeconds = amount(input.leaseSeconds, "Task leaseSeconds", 30, 3600, Math.ceil((timeoutMs + leaseGraceMs) / 1000));
    if (leaseSeconds * 1000 < timeoutMs) throw fail("Task leaseSeconds must not be shorter than timeoutMs");
    const budgetUsd = amount(input.budgetUsd, "Task budgetUsd", 0, 100, null);
    const id = input.id === undefined || input.id === null || input.id === '' ? randomUUID() : String(input.id);
    if (!ID.test(id)) throw fail("Task id must be 8-80 letters, digits, hyphens or underscores");
    const existing = state.tasks[id];
    if (existing) {
      if (existing.prompt === prompt && existing.cwd === cwd) return view(existing);
      throw fail("Task id already used for a different request", 409);
    }
    if (Object.values(state.tasks).filter(task => task.state === 'queued').length >= MAX_QUEUED) throw fail("Task queue is full", 429);
    if (input.thread !== undefined && input.thread !== null && input.thread !== '' && !THREAD.test(String(input.thread))) throw fail("Thread id must be 1-80 letters, digits, dots, colons, underscores or hyphens");
    const stamp = now();
    prune(stamp);
    const task = {
      id, prompt, cwd, timeoutMs, leaseSeconds, budgetUsd, targetNode: input.nodeId ? String(input.nodeId) : null,
      thread: input.thread ? String(input.thread) : `thr-${new Date(stamp).toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`,
      state: 'queued', attempts: 0, createdAt: iso(stamp), createdBy: String(input.createdBy || 'local').slice(0, 60),
      leaseId: null, leaseExpiresAt: null, claimedBy: null, claimedAt: null, lastLeaseNode: null, notBefore: null,
      result: null, completedAt: null,
    };
    state.tasks[id] = task; save(); return view(task);
  }

  function list({ limit = 50, states: filter, thread: threadFilter } = {}) {
    const wanted = filter ? new Set(String(filter).split(',').filter(name => STATES.has(name))) : null;
    return Object.values(state.tasks)
      .filter(task => !threadFilter || task.thread === String(threadFilter))
      .filter(task => !wanted || wanted.has(task.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map(view);
  }

  const get = id => (state.tasks[id] ? view(state.tasks[id]) : null);

  function sweep() {
    const stamp = now(); let changed = 0;
    for (const task of Object.values(state.tasks)) {
      if (task.state !== 'leased' || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) > stamp) continue;
      // Remember the lease that expired: a late result must prove it came from that
      // attempt, otherwise any caller could inject a summary into a requeued task.
      task.lastLeaseId = task.leaseId;
      task.lastLeaseNode = task.claimedBy;
      task.leaseId = null; task.leaseExpiresAt = null; task.claimedBy = null; task.claimedAt = null;
      if (task.attempts >= maxAttempts) {
        task.state = 'timeout'; task.completedAt = iso(stamp);
        task.result = { status: 'timeout', code: 'lease-expired', attempt: task.attempts, summary: "Worker did not report a result before the retry limit", finishedAt: iso(stamp) };
      } else {
        task.state = 'queued'; task.notBefore = iso(stamp + backoffMs(task.attempts));
      }
      changed += 1;
    }
    if (changed) save();
    return changed;
  }

  function threadTail(task) {
    // Results from the same thread travel with the task, so a follow-up can continue
    // instead of starting cold. Prompts are truncated because the executor only shows a
    // slice, and the summary is labelled as untrusted by the executor.
    return Object.values(state.tasks)
      .filter(item => item.id !== task.id && item.thread === task.thread && item.completedAt && item.result?.summary)
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)))
      .slice(-3)
      .map(item => ({ prompt: String(item.prompt).slice(0, 200), summary: String(item.result.summary).slice(0, 600), state: item.state }));
  }

  function leaseView(task) {
    return {
      id: task.id, prompt: task.prompt, cwd: task.cwd, timeoutMs: task.timeoutMs, budgetUsd: task.budgetUsd,
      thread: { id: task.thread, tail: threadTail(task) },
      leaseId: task.leaseId, leaseSeconds: task.leaseSeconds, leaseExpiresAt: task.leaseExpiresAt, attempt: task.attempts,
    };
  }

  function claim({ nodeId, resume = false }) {
    sweep();
    const stamp = now();
    const worker = String(nodeId);
    // A claim whose response was lost can be replayed: the worker asks to resume and gets
    // the same live lease back instead of burning an attempt. A normal claim never does,
    // so "the queue is empty" still means empty.
    if (resume === true) {
      const held = Object.values(state.tasks).find(task => task.state === 'leased' && task.claimedBy === worker && Date.parse(task.leaseExpiresAt) > stamp);
      if (held) return leaseView(held);
    }
    const ready = Object.values(state.tasks).filter(task => task.state === 'queued' && task.attempts < maxAttempts && (!task.notBefore || Date.parse(task.notBefore) <= stamp) && (!task.targetNode || task.targetNode === worker));
    // Prefer work this node did not already fail, so one bad worker cannot burn every attempt.
    const next = ready.find(task => task.lastLeaseNode !== worker) || ready[0];
    if (!next) return null;
    const before = { ...next };
    next.state = 'leased'; next.attempts += 1; next.leaseId = randomUUID();
    next.leaseExpiresAt = iso(stamp + next.leaseSeconds * 1000);
    next.claimedBy = worker; next.claimedAt = iso(stamp); next.lastLeaseNode = worker; next.notBefore = null;
    try { save(); } catch (error) { Object.assign(next, before); throw error; }
    return leaseView(next);
  }

  function owned(id, nodeId, leaseId) {
    const task = state.tasks[id];
    if (!task) throw fail("Task not found", 404);
    if (task.state !== 'leased') throw fail("Task is not leased", 409, 'not-leased');
    if (task.claimedBy !== String(nodeId)) throw fail("Task is leased by another worker", 403);
    if (task.leaseId !== leaseId) throw fail("Task lease is stale", 409, 'stale-lease');
    return task;
  }

  function beat({ nodeId, id, leaseId }) {
    const task = owned(id, nodeId, leaseId);
    const stamp = now();
    if (Date.parse(task.leaseExpiresAt) <= stamp) { sweep(); throw fail("Task lease expired", 409, 'lease-expired'); }
    task.leaseExpiresAt = iso(stamp + task.leaseSeconds * 1000); save();
    return { id: task.id, leaseId: task.leaseId, leaseExpiresAt: task.leaseExpiresAt };
  }

  function ack({ nodeId, id, leaseId, attempt, status, code = '', summary = '', artifacts = [] }) {
    if (!['done', 'failed'].includes(status)) throw fail("Task result status must be done or failed");
    const task = state.tasks[id];
    if (!task) throw fail("Task not found", 404);
    if (!Array.isArray(artifacts) || artifacts.length > 20) throw fail("Task artifacts must be an array of at most 20 entries");
    const attemptNo = Number(attempt);
    const lateOwner = task.lastLeaseId && task.lastLeaseId === leaseId && task.lastLeaseNode === String(nodeId) && Number.isInteger(attemptNo) && attemptNo === task.attempts;
    // The final attempt's genuine result must not be thrown away just because the lease
    // expired before the ack arrived.
    const lateTimeout = task.state === 'timeout' && task.result?.code === 'lease-expired' ? lateOwner : false;
    if (['done', 'failed', 'timeout'].includes(task.state) && !lateTimeout) {
      if (task.result && (task.result.leaseId === leaseId || (Number.isInteger(attemptNo) && task.result.attempt === attemptNo))) return { ...view(task), duplicate: true };
      throw fail("Task already completed", 409, 'already-completed');
    }
    let late = false;
    if (lateTimeout) late = true;
    else if (task.state === 'queued') {
      // The worker finished after its lease expired but before anyone claimed it again:
      // the work exists, so keep it, but only the worker that held that lease may report it.
      if (!lateOwner) throw fail("Task lease is stale", 403, 'stale-lease');
      late = true;
    } else owned(id, nodeId, leaseId);
    const stamp = now();
    task.state = status;
    task.completedAt = iso(stamp);
    task.result = {
      status, code: String(code).slice(0, 80), summary: String(summary).slice(0, 4000), leaseId,
      attempt: task.attempts, late, artifacts: artifacts.map(item => String(item).slice(0, 300)), finishedAt: iso(stamp),
    };
    task.leaseId = null; task.leaseExpiresAt = null; task.notBefore = null;
    save(); return view(task);
  }

  return { submit, list, get, claim, beat, ack, sweep, path };
}
