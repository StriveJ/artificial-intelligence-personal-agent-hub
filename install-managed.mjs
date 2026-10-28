import { mkdirSync, copyFileSync, existsSync, readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, safeInstancePath } from './lib/storage.mjs';
import { verifyRelease, sha256 } from './lib/release-package.mjs';
import { createUpdateManager } from './lib/update-manager.mjs';

export function installManaged({ installation, packageFile, trustFile }) {
  const options = readJson(installation, null), config = readJson(options.configFile, null);
  if (!config || !existsSync(config.root) || !existsSync(config.runtimeDir)) throw new Error("Verified instance configuration and runtime directory are required");
  if (existsSync(join(config.runtimeDir, 'host.lock'))) {
    const lock = readJson(join(config.runtimeDir, 'host.lock'), null); let active = true;
    try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') active = false; }
    if (active) throw new Error("Stop the previous Hub normally before bootstrapping the fixed launcher");
  }
  if (existsSync(join(config.runtimeDir, 'sub-process.json'))) {
    const processInfo = readJson(join(config.runtimeDir, 'sub-process.json'), null); let active = true;
    try { process.kill(processInfo.pid, 0); } catch (e) { if (e.code === 'ESRCH') active = false; }
    if (active) throw new Error("Stop the previous sub Hub normally before bootstrapping the fixed launcher");
  }
  const base = resolve(options.base), bootstrap = join(base, 'bootstrap'), control = join(base, 'control');
  if (existsSync(bootstrap) || existsSync(join(control, 'current.json'))) throw new Error("Installation already bootstrapped; use the updater for subsequent changes");
  const trust = readJson(trustFile), checked = verifyRelease(packageFile, trust, { role: options.role });
  mkdirSync(control, { recursive: true, mode: 0o700 }); writeJson(join(control, 'trust.json'), trust);
  const manager = createUpdateManager({ ...options, driver: {} }); manager.bootstrap(checked);
  mkdirSync(bootstrap, { mode: 0o700 }); const here = dirname(fileURLToPath(import.meta.url)), hashes = {};
  for (const relative of ['hub-launcher.mjs', 'hubctl.mjs', 'task-hook.mjs', 'run-instance-task.mjs', 'install-task-hooks.mjs', ...readdirSync(join(here, 'lib')).filter(n => n.endsWith('.mjs')).map(n => 'lib/' + n)]) {
    const source = join(here, relative); if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error("Invalid bootstrap source path");
    const dest = safeInstancePath(bootstrap, join(bootstrap, relative)); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, readFileSync(source), { flag: 'wx', mode: 0o600 }); hashes[relative] = sha256(readFileSync(source));
  }
  writeJson(join(bootstrap, 'bootstrap.json'), { version: 1, files: hashes });
  return { launcher: join(bootstrap, 'hub-launcher.mjs'), installation: resolve(installation), releaseId: checked.manifest.releaseId };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
    if (['--installation', '--package', '--trust'].some(key => !args.includes(key))) throw new Error("--installation, --package, and --trust are required");
    console.log(JSON.stringify(installManaged({ installation: resolve(option('--installation')), packageFile: resolve(option('--package')), trustFile: resolve(option('--trust')) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
