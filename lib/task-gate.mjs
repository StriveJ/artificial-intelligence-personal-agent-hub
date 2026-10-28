import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function ownsTaskLease(held,{leaseToken,sessionId}={}){
  return Boolean(held?.kind==='task'&&(typeof leaseToken==='string'&&leaseToken===held.token||typeof sessionId==='string'&&sessionId.length>0&&sessionId.length<=512&&held.token==='session-'+createHash('sha256').update(sessionId).digest('hex')));
}

export function createTaskGate(root) {
  const path = join(realpathSync(root), '.git', 'aipa-hub-gate.sqlite');
  function transaction(operation) {
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS gate (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL, kind TEXT NOT NULL, startedAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK(id=1), operationId TEXT NOT NULL, reason TEXT NOT NULL, createdAt TEXT NOT NULL)');
      db.exec('BEGIN IMMEDIATE');
      try {
        let value = db.prepare('SELECT token,pid,kind,startedAt FROM gate WHERE id=1').get() || null;
        if (value && value.pid > 0) {
          try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') { db.exec('DELETE FROM gate WHERE id=1'); value = null; } }
        }
        const result = operation(db, value); db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  const state = () => transaction((db, value) => value);
  function acquire(kind = 'task', pid = process.pid) {
    if (!['task', 'sync', 'main'].includes(kind) || !Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid task gate parameters");
    return transaction((db, previous) => {
      if (previous || db.prepare('SELECT id FROM maintenance WHERE id=1').get()) return null;
      const value = { token: randomUUID(), pid, kind, startedAt: new Date().toISOString() };
      db.prepare('INSERT INTO gate (id,token,pid,kind,startedAt) VALUES (1,?,?,?,?)').run(value.token, pid, kind, value.startedAt);
      return value;
    });
  }
  function release(token) {
    transaction((db, value) => { if (!value || value.token !== token) throw new Error("Task gate ownership mismatch"); db.exec('DELETE FROM gate WHERE id=1'); });
  }
  async function run(kind, operation) {
    const lock = acquire(kind);
    if (!lock) return { status: 'deferred', code: 'instance_busy', summary: "Personal instance task is active; synchronization will follow when it ends" };
    try { return await operation(); } finally { release(lock.token); }
  }
  const maintenance = () => transaction(db => db.prepare('SELECT operationId,reason,createdAt FROM maintenance WHERE id=1').get() || null);
  function pause(operationId, reason = 'update') {
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId) || !['update', 'clear', 'rebind', 'manual'].includes(reason)) throw new Error("Invalid maintenance ID");
    return transaction((db, active) => {
      const previous = db.prepare('SELECT operationId FROM maintenance WHERE id=1').get();
      if (previous && previous.operationId !== operationId) throw new Error("Another maintenance operation is active");
      if (!previous) db.prepare('INSERT INTO maintenance VALUES (1,?,?,?)').run(operationId, reason, new Date().toISOString());
      return { idle: !active, active };
    });
  }
  function resume(operationId) {
    return transaction(db => {
      const previous = db.prepare('SELECT operationId FROM maintenance WHERE id=1').get();
      if (!previous || previous.operationId !== operationId) throw new Error("Maintenance operation ownership mismatch");
      db.exec('DELETE FROM maintenance WHERE id=1');
    });
  }
  const sessionToken = id => {
    if (typeof id !== 'string' || id.length < 1 || id.length > 512) throw new Error("Invalid session ID");
    return 'session-' + createHash('sha256').update(id).digest('hex');
  };
  function startSession(id) {
    const token = sessionToken(id);
    return transaction((db, active) => {
      if (db.prepare('SELECT id FROM maintenance WHERE id=1').get()) return null;
      if (active) return active.token === token ? active : null;
      const value = { token, pid: -1, kind: 'task', startedAt: new Date().toISOString() };
      db.prepare('INSERT INTO gate VALUES (1,?,?,?,?)').run(value.token, value.pid, value.kind, value.startedAt); return value;
    });
  }
  function endSession(id) {
    const token = sessionToken(id);
    return transaction((db, active) => { if (!active) return false; if (active.token !== token) throw new Error("Cannot end another session task"); db.exec('DELETE FROM gate WHERE id=1'); return true; });
  }
  return { state, acquire, release, run, maintenance, pause, resume, startSession, endSession };
}
