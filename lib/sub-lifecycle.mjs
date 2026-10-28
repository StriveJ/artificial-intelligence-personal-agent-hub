import { realpathSync, existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, sep, relative, isAbsolute } from 'node:path';
import { readJson, writeJson } from './storage.mjs';

const key = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
const within = (parent, child) => { const rel = relative(parent, child); return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };

export function registerExternalInstance({ managedBase, root, installationId, bindingId }) {
  const base = realpathSync(managedBase), instance = realpathSync(root);
  if (!/^[a-f0-9-]{36}$/i.test(bindingId || '') || !installationId || within(base, instance) || key(base) === key(instance) || within(instance, base)) throw new Error("Invalid external-instance binding parameters");
  if (key(root) !== key(instance) || lstatSync(root).isSymbolicLink() || !lstatSync(join(root, '.git')).isDirectory() || lstatSync(join(root, '.git')).isSymbolicLink() || !existsSync(join(root, 'AIPA-MANIFEST.yaml'))) throw new Error("External instance must be a real personal repository directory");
  const file = join(root, '.git/aipa-hub-installation.json');
  const record = { version: 1, installationId, bindingId, root: resolve(root), managedBase: base };
  if (existsSync(file)) throw new Error("External instance already belongs to an installation");
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { root: resolve(root), bindingId };
}

export function createSubLifecycle({ managedBase, root, runtimeDir, installationId, programDir, externalInstance }) {
  if (!managedBase) return null;
  const base = realpathSync(managedBase), tombstone = join(base, 'cleared.json');
  const paths = [root, runtimeDir, ...(programDir ? [programDir] : [])].map(p => resolve(p));
  if (new Set(paths.map(key)).size !== paths.length || paths.some((a, i) => paths.some((b, j) => i !== j && within(b, a)))) throw new Error("Managed installation paths cannot overlap or nest");
  const external = !within(base, resolve(root));
  const manifestPath = join(base, 'installation.json');
  const existing = readJson(manifestPath, null);
  const binding = external && externalInstance ? { root: resolve(root), bindingId: externalInstance.bindingId } : null;
  const manifest = { installationId, paths, ...(binding ? { externalInstance: binding } : {}) };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function validateBinding() {
    if (!external) return;
    if (!binding || key(externalInstance.root) !== key(root) || !/^[a-f0-9-]{36}$/i.test(binding.bindingId || '') || key(root) === key(base) || within(root, base)) throw new Error("Clear target must be a real subdirectory of the dedicated installation or an explicitly bound external instance");
    if (!existsSync(root)) {
      const frozen = readJson(tombstone, null);
      if (frozen?.installationId === installationId && same(readJson(manifestPath, null), manifest)) return;
      throw new Error("External-instance binding directory not found");
    }
    const file = join(root, '.git/aipa-hub-installation.json');
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || key(realpathSync(file)) !== key(file)) throw new Error("External-instance binding missing or changed");
    const expected = { version: 1, installationId, bindingId: binding.bindingId, root: resolve(root), managedBase: base };
    if (!same(readJson(file, null), expected)) throw new Error("External-instance binding does not belong to this installation");
  }
  validateBinding();
  for (const path of paths) {
    if ((!within(base, path) && !(external && key(path) === key(root))) || (existsSync(path) && key(realpathSync(path)) !== key(path))) throw new Error("Clear target must be a real subdirectory of the dedicated installation");
    if (programDir && key(programDir) === key(process.cwd())) throw new Error("Cannot clear the current development workspace");
  }
  if (existing && JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error("Installation directory belongs to another installation");
  writeJson(manifestPath, manifest);
  const frozen = () => existsSync(tombstone);
  function freeze(operationId) {
    if (!frozen()) writeJson(tombstone, { installationId, operationId, phase: 'frozen', createdAt: new Date().toISOString() });
    const saved = readJson(tombstone, null); if (saved.installationId !== installationId) throw new Error("Freeze record does not belong to this installation");
  }
  function validateTree(path, anchor) {
    if (!existsSync(path)) return;
    if ((key(path) !== key(anchor) && !within(anchor, path)) || key(realpathSync(path)) !== key(path) || lstatSync(path).isSymbolicLink()) throw new Error("Clear path verification failed");
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Installation contains links; freeze preserved pending review");
      if (entry.isDirectory()) validateTree(p, anchor);
    }
  }
  function clear(operationId) {
    freeze(operationId);
    if (!same(readJson(manifestPath, null), manifest)) throw new Error("Installation registration changed before clearing");
    validateBinding();
    for (const path of paths) validateTree(path, path);
    for (const path of paths) if (existsSync(path)) rmSync(path, { recursive: true, force: false });
    writeJson(tombstone, { installationId, operationId, phase: 'cleared', completedAt: new Date().toISOString() });
    return { status: 'success', code: 'cleared' };
  }
  return { frozen, freeze, clear, tombstone: () => readJson(tombstone, null) };
}
