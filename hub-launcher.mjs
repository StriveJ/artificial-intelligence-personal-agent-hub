import { fork } from 'node:child_process';
import { openSync, closeSync, existsSync, unlinkSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson } from './lib/storage.mjs';
import { createTaskGate } from './lib/task-gate.mjs';
import { createUpdateManager } from './lib/update-manager.mjs';
import { serveUpdates } from './lib/update-ipc.mjs';
import { verifyInstalled, verifyRelease } from './lib/release-package.mjs';

export async function createLauncher(options) {
  const { base, configFile, role, installationId } = options, config = readJson(configFile, null);
  mkdirSync(join(base, 'control'), { recursive: true }); const lockFile = join(base, 'control/launcher.lock');
  if (existsSync(lockFile)) {
    const old = readJson(lockFile, null); let alive = true;
    if (!Number.isSafeInteger(old?.pid)) throw new Error("Invalid launcher runtime lock");
    try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error("A launcher is already running for this installation"); unlinkSync(lockFile);
  }
  const lock = openSync(lockFile, 'wx', 0o600); closeSync(lock); writeJson(lockFile, { pid: process.pid });
  const childRecord = join(base, 'control/child.json'); let child, health, ipc, closing = false, restart;
  const gate = createTaskGate(config.root);
  const driver = {
    async start(current) {
      if (child && child.exitCode === null && !child.signalCode) return;
      const old = readJson(childRecord, null);
      if (old?.pid) { try { process.kill(old.pid, 0); throw new Error("Previous child process remains alive; maintenance waits for exit without killing by PID"); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
      const dir = join(base, 'releases', current.releaseId), release = verifyRelease(join(base, 'releases', current.releaseId + '.hubpkg.json'), readJson(join(base, 'control/trust.json')), { role, allowExpired: true });
      if (release.digest !== current.digest) throw new Error("Runtime pointer does not match the trusted package"); verifyInstalled(dir, release.manifest);
      const fd = openSync(join(config.runtimeDir, 'managed-hub.log'), 'a', 0o600);
      try {
        child = fork(join(dir, `${role}-server.mjs`), ['--config', configFile], { cwd: dir, execArgv: [], windowsHide: true, stdio: ['ignore', fd, fd, 'ipc'], env: { ...process.env, AIPA_HUB_RELEASE_ID: current.releaseId, AIPA_HUB_DEPLOYMENT_GENERATION: String(current.deploymentGeneration) } });
      } finally { closeSync(fd); }
      health = null; const owned = child; writeJson(childRecord, { pid: owned.pid, releaseId: current.releaseId });
      owned.on('message', message => {
        if (child !== owned) return;
        if (message?.type === 'hub-ready') health = { ...message, seen: Date.now() };
        if (message?.type === 'hub-cleared' && message.installationId === installationId && readJson(join(config.managedBase || base, 'cleared.json'), null)?.installationId === installationId) {
          closing = true; clearTimeout(restart); ipc?.close(); owned.disconnect();
        }
      });
      owned.once('exit', () => {
        if (child !== owned) return; child = null; health = null;
        if (readJson(childRecord, null)?.pid === owned.pid) unlinkSync(childRecord);
        if (!closing && !manager.status().active && existsSync(config.root) && !existsSync(join(config.managedBase || base, 'cleared.json'))) restart = setTimeout(() => { void driver.start(manager.current()).catch(() => {}); }, 3000);
      });
    },
    async stop() {
      clearTimeout(restart); if (!child) return;
      const owned = child;
      if (gate.state()) throw new Error("Instance tasks are active; cannot stop");
      owned.send({ type: 'hub-stop' });
      await new Promise(resolveExit => owned.once('exit', resolveExit));
    },
    async ready(current) {
      const deadline = Date.now() + 30_000;
      do {
        if (health && Date.now() - health.seen < 3000) return health.releaseId === current.releaseId && health.deploymentGeneration === current.deploymentGeneration && health.role === role && realpathSync(health.root) === realpathSync(config.root) && health.testMode === (config.testMode !== false) && health.protocol === 1 && health.runtimeSchema === 1;
        if (!child) return false; await delay(100);
      } while (Date.now() < deadline); return false;
    },
  };
  const manager = createUpdateManager({ ...options, driver });
  async function listen() {
    try {
      ipc = await serveUpdates(config.runtimeDir, manager);
      try {
        await manager.recover(); await driver.start(manager.current());
        if (!manager.status().knownGood.includes(manager.current().releaseId)) await manager.acceptBaseline();
      } catch {  }
      return manager.status();
    } catch (error) { if (existsSync(lockFile)) unlinkSync(lockFile); throw error; }
  }
  async function close() {
    closing = true; clearTimeout(restart); await manager.wait();
    if (manager.status().active) throw new Error("Maintenance requires recovery; independent recovery endpoint remains available");
    gate.pause('launcher-stop', 'manual');
    while (gate.state()) await delay(100);
    await driver.stop(); if (ipc) await new Promise(r => ipc.close(r));
    gate.resume('launcher-stop'); if (existsSync(lockFile)) unlinkSync(lockFile);
  }
  return { listen, close, manager };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--installation'); if (at < 0) throw new Error("--installation <installation-config> is required");
    const launcher = await createLauncher(readJson(resolve(process.argv[at + 1]), null));
    const state = await launcher.listen(); console.log(JSON.stringify({ role: 'launcher', ready: !state.active, maintenance: state.maintenance !== null, pid: process.pid }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void launcher.close().then(() => process.exit(0)).catch(error => console.error(error.message)); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
