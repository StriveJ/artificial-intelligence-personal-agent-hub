import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRepoSync } from './repo-sync.mjs';
import { createTaskGate } from './task-gate.mjs';
import { readJson, writeJson } from './storage.mjs';

export function createInstanceSync({ root, runtimeDir, testMode = true, intervalMs = 30 * 60_000, afterUpdate }) {
  if (!existsSync(join(root, 'AIPA-MANIFEST.yaml'))) throw new Error("Only personal AIPA instance repositories may be managed");
  if (typeof testMode !== 'boolean' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error("Invalid synchronization configuration");
  const gate = createTaskGate(root), path = join(runtimeDir, 'instance-sync.json');
  const state = readJson(path, { pending: false, nextAt: 0, result: null });
  const sync = createRepoSync({ root, runtimeDir, testMode, autoResolve: true, push: true, capturePaths: ['user-space', 'state'], afterUpdate });
  let running, stopped = false;
  const save = () => writeJson(path, state);
  async function request() {
    if (stopped) return { status: 'deferred', code: 'stopped' };
    state.pending = true; save();
    if (running) return running;
    running = Promise.resolve().then(() => gate.run('sync', sync)).then(result => {
      state.result = result; state.pending = result.status === 'deferred';
      state.nextAt = Date.now() + intervalMs; save(); return result;
    }, () => {
      state.result = { status: 'error', code: 'sync_failed', summary: "Synchronization incomplete; local information preserved for retry" };
      state.pending = true; state.nextAt = Date.now() + 60_000; save(); return state.result;
    }).finally(() => { running = null; });
    return running;
  }
  return { gate, request, status: () => ({ ...state }),
    async tick() { if (!stopped && ((state.pending && state.result?.status !== 'error') || Date.now() >= state.nextAt)) return request(); },
    async stop() { stopped = true; await running; },
  };
}
