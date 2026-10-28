import { openSync, closeSync, writeSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const KINDS = new Set(['task', 'device', 'sync', 'system', 'maintenance']);
const STATUSES = new Set(['started', 'success', 'partial', 'blocked', 'deferred', 'failed', 'error', 'info']);
const plain = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const int = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
const oneOf = (allowed, max) => value => typeof value === 'string' && value.length <= max && allowed(value) ? value : undefined;
const name = max => oneOf(value => /^[a-zA-Z0-9._-]+$/.test(value), max);
const token = max => oneOf(value => /^[a-z0-9][a-z0-9_-]*$/.test(value), max);

const DETAIL = {
  commit: value => typeof value === 'string' && /^[a-f0-9]{7,12}$/.test(value) ? value : undefined,
  releaseId: name(96),
  deviceId: name(80),
  runId: name(40),
  platform: token(16),
  arch: token(16),
  code: token(40),
  reason: oneOf(value => ['scheduled', 'manual'].includes(value), 16),
  changedFiles: value => int(value, 100000),
  pulled: value => int(value, 100000),
  count: value => int(value, 100000),
  durationMs: value => int(value, 86_400_000),
  pushed: value => typeof value === 'boolean' ? value : undefined,
  pushSuppressed: value => typeof value === 'boolean' ? value : undefined,
};

export function describeTask(id, label, result, { manual = false } = {}) {
  const status = result?.status || 'success';
  const prefix = manual ? "Manual " : "Automatic ";
  if (status === 'deferred') return `${label} deferred: ${plain(result?.summary, 80) || "Retry when idle"}`;
  if (status === 'blocked') return `${label} needs attention: ${plain(result?.summary, 80) || "Check runtime status"}`;
  if (status === 'error' || status === 'failed') return `${label} failed: ${plain(result?.summary, 80) || "Check Hub runtime status"}`;
  if (id === 'repo-sync') {
    const pushed = result?.pushed === true ? "Pushed" : result?.pushSuppressed === true ? "Push suppressed in test mode" : "No push needed";
    return `${prefix}repository sync (${pushed} / pulled ${int(result?.changedFiles, 100000) ?? 0} files)`;
  }
  if (id === 'daily-briefing') return `${prefix}daily news generated (added to inbox)`;
  if (id === 'main-day-start') return plain(result?.summary, 80) || "Main Hub workday started";
  if (id === 'main-day-close') return `${prefix}workday closed and daily report generated`;
  if (id === 'main-report-maintenance') return `${prefix}historical reports backfilled and late revisions applied`;
  if (id === 'main-day-cycle') return `${prefix}main Hub daily workflow (start, close, and report checks)`;
  if (id === 'main-distillation') return `${prefix}central distillation (candidates handled under confirmation rules)`;
  return `${prefix}${label}: ${plain(result?.summary, 90) || "Completed"}`;
}

export function createActivityLog({ runtimeDir, now = Date.now, retention = 1000, trimTo = 800 } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) throw new Error("Activity logging requires a runtime directory");
  if (!Number.isSafeInteger(retention) || !Number.isSafeInteger(trimTo) || trimTo < 1 || retention <= trimTo) throw new Error("Invalid activity log retention configuration");
  const file = join(runtimeDir, 'activity.jsonl');
  let cache = { key: null, items: [] };

  const keyOf = () => { try { const stats = statSync(file); return `${stats.size}:${stats.mtimeMs}`; } catch { return ''; } };
  function load() {
    const key = keyOf();
    if (key && key === cache.key) return cache.items;
    const items = [];
    if (existsSync(file)) {
      let raw = '';
      try { raw = readFileSync(file, 'utf8'); } catch { raw = ''; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (!item?.id || !item?.at || typeof item.summary !== 'string') continue;
          items.push({ id: String(item.id), at: String(item.at), kind: KINDS.has(item.kind) ? item.kind : 'system', action: String(item.action || 'unknown'), status: STATUSES.has(item.status) ? item.status : 'info', summary: item.summary.slice(0, 240), ...(item.detail && typeof item.detail === 'object' ? { detail: item.detail } : {}) });
        } catch {  }
      }
    }
    cache = { key, items };
    return items;
  }
  const sanitize = record => {
    const detail = {};
    if (record?.detail && typeof record.detail === 'object') for (const [key, check] of Object.entries(DETAIL)) { const value = check(record.detail[key]); if (value !== undefined) detail[key] = value; }
    return {
      kind: KINDS.has(record?.kind) ? record.kind : 'system',
      action: token(64)(record?.action) || 'unknown',
      status: STATUSES.has(record?.status) ? record.status : 'info',
      summary: plain(record?.summary, 200) || "Unnamed event",
      ...(Object.keys(detail).length ? { detail } : {}),
    };
  };
  const makeId = time => `${new Date(time).toISOString().replace(/\D/g, '').slice(0, 17)}-${randomBytes(4).toString('hex')}`;
  function trim(items) {
    const keep = items.slice(-trimTo), temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, keep.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    renameSync(temporary, file);
    cache = { key: '', items: keep };
  }
  function append(record) {
    const at = now(), entry = { id: makeId(at), at: new Date(at).toISOString(), ...sanitize(record) };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const fd = openSync(file, 'a', 0o600);
      try { writeSync(fd, JSON.stringify(entry) + '\n'); } finally { closeSync(fd); }
      cache = { key: null, items: [] };
      const items = load();
      if (items.length > retention) trim(items);
      return { ...entry, stored: true };
    } catch {
      return { ...entry, stored: false };
    }
  }
  function list({ limit = 100, offset = 0, kinds = [], statuses = [], actions = [], before = '' } = {}) {
    const items = load(), kindSet = kinds.length ? new Set(kinds) : null, statusSet = statuses.length ? new Set(statuses) : null, actionSet = actions.length ? new Set(actions) : null;
    const matched = items.filter(item => (kindSet ? kindSet.has(item.kind) : true) && (statusSet ? statusSet.has(item.status) : true) && (actionSet ? actionSet.has(item.action) : true)).reverse();
    let start = Math.max(0, Math.floor(offset) || 0);
    if (before) { const index = matched.findIndex(item => item.id === before); if (index >= 0) start = index + 1; }
    const page = matched.slice(start, start + limit);
    return { items: page, total: matched.length, totalAll: items.length, offset: start, limit };
  }
  const stats = () => { const items = load(); return { total: items.length, lastAt: items.length ? items[items.length - 1].at : null }; };
  return { file, retention, append, list, stats };
}
