import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/storage.mjs';
import { createHub } from './server.mjs';
import { bindManagedRuntime } from './lib/managed-runtime.mjs';

export const createMainHub = config => createHub({ ...config, testMode: config.testMode ?? true, tasks: { 'repo-sync': { enabled: true, intervalMinutes: 30, mode: 'bidirectional', ...config.tasks?.['repo-sync'] } }, main: { ...config.main, enabled: true } });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const i = process.argv.indexOf('--config'); if (i < 0) throw new Error("--config <configuration-file> is required");
    const config = readJson(resolve(process.argv[i + 1]), null);
    const hub = await createMainHub(config), url = await hub.listen();
    bindManagedRuntime({ role: 'main', root: config.root, testMode: config.testMode !== false, idle: () => hub.readiness().idle, close: () => hub.close() });
    console.log(JSON.stringify({ status: 'ready', role: 'main', testMode: config.testMode !== false, url, pid: process.pid }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void hub.close().then(() => process.exit(0)); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
