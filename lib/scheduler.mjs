import { readJson, writeJson } from './storage.mjs';
import { taskResult } from './task-result.mjs';

import { localDay, dailyTime, dailyDue, timeZone as validateTimeZone } from './time-zone.mjs';
export { localDay, dailyTime } from './time-zone.mjs';
function validDaily(at, zone) { try { validateTimeZone(zone); return /^([01]\d|2[0-3]):[0-5]\d$/.test(at); } catch { return false; } }

export function createScheduler({ path, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, timeZone: sharedTimeZone } = {}) {
  const saved = readJson(path, { tasks: {} });
  const tasks = new Map(), running = new Map();
  let timer, started = false, stopped = false;
  const persist = () => writeJson(path, { version: 1, tasks: Object.fromEntries([...tasks].map(([id, task]) => [id, task.state])) });
  const view = task => ({ ...task.state, id: task.id, label: task.label, enabled: task.enabled, intervalMinutes: task.intervalMs ? task.intervalMs / 60_000 : null, dailyAt: task.dailyAt, timeZone: task.timeZone });
  function refreshZones() {
    if (!sharedTimeZone) return;
    const zone = validateTimeZone(sharedTimeZone());
    for (const task of tasks.values()) if (task.dailyAt && task.timeZone !== zone) {
      task.timeZone = zone; task.state.scheduleKey = `${zone}/${task.dailyAt}`;
      if (!running.has(task.id) && task.state.status !== 'unknown') task.state.nextRunAt = new Date(dailyDue(now(), task.dailyAt, true, zone)).toISOString();
      persist();
    }
  }
  function arm() {
    refreshZones();
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!started || stopped) return;
    const due = [...tasks.values()].filter(t => t.enabled && !running.has(t.id) && Number.isFinite(Date.parse(t.state.nextRunAt))).map(t => Date.parse(t.state.nextRunAt));
    if (!due.length) return;
    timer = setTimer(() => { timer = undefined; void tick(); }, Math.max(0, Math.min(2_147_483_647, Math.min(...due) - now())));
    timer?.unref?.();
  }
  function register({ id, label, intervalMs, dailyAt, timeZone = sharedTimeZone ? sharedTimeZone() : 'Asia/Shanghai', run, enabled = true }) {
    if (started || !/^[a-z][a-z0-9-]{1,63}$/.test(id) || tasks.has(id) || (dailyAt ? !validDaily(dailyAt, timeZone) || intervalMs !== undefined : !Number.isSafeInteger(intervalMs) || intervalMs < 1000) || typeof run !== 'function') throw new Error("Invalid scheduled task registration");
    if (dailyAt && sharedTimeZone && timeZone !== validateTimeZone(sharedTimeZone())) throw Error('Daily task timezone differs from the shared instance timezone');
    const previous = saved.tasks?.[id] || {};
    const scheduleKey = dailyAt ? `${timeZone}/${dailyAt}` : `interval/${intervalMs}`;
    const preserve = !previous.scheduleKey || previous.scheduleKey === scheduleKey;
    const initial = dailyAt ? dailyTime(localDay(now(), timeZone), dailyAt, timeZone) : now();
    const interrupted = ['running', 'interrupted'].includes(previous.status);
    const status = interrupted ? 'unknown' : previous.status || 'waiting';
    const result = interrupted ? { status: 'unknown', code: 'interrupted', summary: "Task process interrupted; outcome unknown. Review before taking action." } : previous.result;
    const nextRunAt = status === 'unknown' ? null : preserve && Number.isFinite(Date.parse(previous.nextRunAt)) ? previous.nextRunAt : new Date(initial).toISOString();
    const history = [...(previous.history || []), ...(interrupted ? [{ status: 'unknown', startedAt: previous.lastStartedAt, detectedAt: new Date(now()).toISOString(), reason: 'restart', summary: result.summary }] : [])].slice(-20);
    tasks.set(id, { id, label, intervalMs, dailyAt, timeZone, run, enabled, state: { ...previous, scheduleKey, status, result, nextRunAt, history } });
    persist();
  }
  function runNow(id, reason = 'manual') {
    const task = tasks.get(id);
    if (!task || !task.enabled || stopped) throw Object.assign(new Error("Task disabled or missing"), { status: 409 });
    if (running.has(id)) return running.get(id);
    const begun = new Date(now()).toISOString();
    const scheduledFor = task.dailyAt ? new Date(reason === 'scheduled' ? dailyDue(now(), task.dailyAt, false, task.timeZone) : now()).toISOString() : begun;
    const attemptDay = localDay(Date.parse(scheduledFor), task.timeZone);
    if (task.state.attemptDay !== attemptDay) { task.state.attemptDay = attemptDay; task.state.failures = 0; }
    task.state.status = 'running'; task.state.lastStartedAt = begun; task.state.lastReason = reason; persist();
    const promise = Promise.resolve().then(() => task.run({ reason, scheduledFor })).then(result => {
      result = taskResult(result);
      const status = result.status;
      Object.assign(task.state, { status, result });
      if (status === 'success') { task.state.lastSuccessAt = new Date(now()).toISOString(); task.state.failures = 0; }
      else if (['error', 'partial'].includes(status)) task.state.failures = (task.state.failures || 0) + 1;
      if (Number.isSafeInteger(result.delivered) && result.delivered > 0) task.state.lastDeliveredAt = new Date(now()).toISOString();
      return result;
    }, error => {
      task.state.status = 'error'; task.state.result = { status: 'error', summary: error.publicMessage || "Task failed. Check runtime status on the Hub device." };
      task.state.failures = (task.state.failures || 0) + 1;
      return task.state.result;
    }).finally(() => {
      const finished = new Date(now()).toISOString();
      task.state.lastFinishedAt = finished;
      const next = task.state.status === 'deferred' ? now() + Math.min(60_000, task.intervalMs || 60_000)
        : task.dailyAt ? (['error', 'partial'].includes(task.state.status) && task.state.failures < 3 ? now() + 15 * 60_000 : dailyDue(now(), task.dailyAt, true, task.timeZone)) : now() + task.intervalMs;
      task.state.nextRunAt = task.state.status === 'unknown' ? null : new Date(next).toISOString();
      task.state.history = [...task.state.history, { startedAt: begun, finishedAt: finished, status: task.state.status, reason, summary: task.state.result?.summary }].slice(-20);
      running.delete(id); persist(); arm();
    });
    running.set(id, promise); arm(); return promise;
  }
  async function tick() {
    refreshZones();
    if (stopped) return;
    const due = [...tasks.values()].filter(t => t.enabled && !running.has(t.id) && Number.isFinite(Date.parse(t.state.nextRunAt)) && Date.parse(t.state.nextRunAt) <= now());
    await Promise.all(due.map(t => runNow(t.id, 'scheduled'))); arm();
  }
  return { register, runNow, tick, list: () => { refreshZones(); return [...tasks.values()].map(view); },
    configure(id, { enabled, dailyAt, timeZone }) {
      const task = tasks.get(id);
      if (!task?.dailyAt || typeof enabled !== 'boolean' || !validDaily(dailyAt, task.timeZone)) throw new Error("Invalid daily schedule configuration");
      timeZone = timeZone ?? (sharedTimeZone ? sharedTimeZone() : task.timeZone);
      if (!validDaily(dailyAt, timeZone) || sharedTimeZone && timeZone !== validateTimeZone(sharedTimeZone())) throw Error('Daily task timezone differs from the shared instance timezone');
      const changed = task.dailyAt !== dailyAt || task.enabled !== enabled || task.timeZone !== timeZone;
      task.timeZone = timeZone;
      task.enabled = enabled; task.dailyAt = dailyAt; task.state.scheduleKey = `${task.timeZone}/${dailyAt}`;
      if (changed && !running.has(id) && task.state.status !== 'unknown') task.state.nextRunAt = new Date(dailyDue(now(), dailyAt, true, task.timeZone)).toISOString();
      persist(); arm();
    },
    start() { if (stopped) throw new Error("Scheduler stopped"); started = true; arm(); },
    async stop() { stopped = true; if (timer !== undefined) clearTimer(timer); await Promise.all([...running.values()]); },
  };
}
