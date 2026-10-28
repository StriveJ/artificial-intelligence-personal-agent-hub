import { connect, createServer } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson } from './storage.mjs';
import {localSocket,filesystemSocket} from './local-socket.mjs';

const hash = v => createHash('sha256').update(String(v)).digest();
export const updateSocket = runtimeDir => localSocket(runtimeDir,'updater');
export async function updateCommand(runtimeDir, action, body = {}, key) {
  const access = readJson(join(runtimeDir, 'updater-access.json'), null);
  if (!access) throw Object.assign(new Error("Local version maintenance service is not installed"), { status: 503 });
  return new Promise((yes, no) => {
    const socket = connect(updateSocket(runtimeDir)); let raw = '', done = false;
    const settle = (error, value) => {
      if (done) return; done = true;
      if (!socket.destroyed) socket.end();
      error ? no(error) : yes(value);
    };
    socket.setTimeout(30_000, () => settle(Object.assign(new Error("Updater response timed out"), { status: 504 })));
    socket.on('connect', () => socket.write(JSON.stringify({ action, body, key, token: access.token }) + '\n'));
    socket.on('data', bytes => { raw += bytes; if (raw.length > 2_000_000) settle(Object.assign(new Error("Updater response too large"), { status: 502 })); });
    socket.on('end', () => {
      if (!raw) return settle(Object.assign(new Error("Updater returned no result. The action may have run; retry with the same idempotency key or inspect operation history."), { status: 504 }));
      try {
        const r = JSON.parse(raw);
        if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status || 400 });
        settle(null, r.result);
      } catch (error) { settle(error); }
    });
    socket.on('error', error => settle(error));
  });
}
export async function serveUpdates(runtimeDir, manager) {
  const file = join(runtimeDir, 'updater-access.json'), access = readJson(file, null) || { token: randomBytes(32).toString('base64url') }; writeJson(file, access);
  const mutating = new Set(['check', 'plan', 'prepare', 'apply', 'cancel']);
  const server = createServer({ allowHalfOpen: true }, socket => {
    let raw = '', handled = false; socket.setTimeout(30_000, () => socket.destroy());
    socket.on('data', async bytes => {
      raw += bytes; if (raw.length > 40_000) return socket.destroy(); if (!raw.includes('\n') || handled) return; handled = true;
      try {
        const { token, action, body = {}, key } = JSON.parse(raw.slice(0, raw.indexOf('\n')));
        if (!timingSafeEqual(hash(token), hash(access.token))) throw Object.assign(new Error("Invalid local maintenance credentials"), { status: 401 });
        if (action === 'recover') { await manager.recover(); socket.end(JSON.stringify({ ok: true, result: manager.status() }) + '\n'); return; }
        const perform = () => {
          if (action === 'status') return manager.status();
          if (action === 'releases') return manager.listReleases();
          if (action === 'check') return manager.check();
          if (action === 'plan') return manager.createPlan(body);
          if (action === 'get-plan') return manager.getPlan(body.id);
          if (action === 'prepare') return manager.prepare(body.id);
          if (action === 'apply') return manager.apply(body.id, body.expectedPlanRevision);
          if (action === 'operation') return manager.operation(body.id);
          if (action === 'cancel') return manager.cancel(body.id);
          if (action === 'history') return manager.history();
          throw new Error("Invalid maintenance operation");
        };
        const result = mutating.has(action) ? manager.idempotent(key, { action, body }, perform) : perform();
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message, status: error.status || 400 }) + '\n'); }
    }); socket.on('error', () => {});
  });
  const path = updateSocket(runtimeDir);
  if (filesystemSocket(path) && existsSync(path)) unlinkSync(path); // Compatibility and safety behavior is covered by contract tests.
  await new Promise((yes, no) => { server.once('error', no); server.listen(path, yes); });
  if (filesystemSocket(path)) chmodSync(path, 0o600); return server;
}
