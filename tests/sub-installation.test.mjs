import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, resolve, sep, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSubLifecycle, registerExternalInstance } from '../lib/sub-lifecycle.mjs';

function fixture(t) {
  const parent = resolve('aipa-test-tmp'); mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, 'external-install-'));
  t.after(() => { assert.ok(realpathSync(work).startsWith(realpathSync(parent) + sep)); rmSync(work, { recursive: true, force: true }); });
  const root = join(work, 'existing-instance'), managedBase = join(work, 'hub'), programDir = join(managedBase, 'program'), runtimeDir = join(managedBase, 'runtime');
  for (const p of [root, join(root, '.git'), programDir, runtimeDir]) mkdirSync(p, { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'synthetic: true\n');
  writeFileSync(join(work, 'keep.txt'), 'keep');
  const config = { managedBase, root, runtimeDir, programDir, installationId: randomUUID() };
  return { work, config, bind: () => (config.externalInstance = registerExternalInstance({ ...config, bindingId: randomUUID() })) };
}

test("External instances bind explicitly; clearing affects registered paths and supports post-clear recovery", t => {
  const { work, config, bind } = fixture(t); bind();
  const c = createSubLifecycle(config); c.clear('local-clear');
  for (const p of [config.root, config.programDir, config.runtimeDir]) assert.equal(existsSync(p), false);
  assert.equal(readFileSync(join(work, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(createSubLifecycle(config).frozen(), true);
  assert.equal(createSubLifecycle(config).clear('local-clear').code, 'cleared');
});

test("External instances are never implicitly adopted and mismatched or tampered bindings reject clearing", t => {
  const { config, bind } = fixture(t);
  assert.throws(() => createSubLifecycle(config), /explicitly bound/i); bind();
  assert.throws(() => registerExternalInstance({ ...config, bindingId: randomUUID() }), /already belongs/i);
  assert.throws(() => createSubLifecycle({ ...config, installationId: randomUUID() }), /does not belong/i);
  const c = createSubLifecycle(config), file = join(config.root, '.git/aipa-hub-installation.json');
  const binding = JSON.parse(readFileSync(file)); binding.bindingId = randomUUID(); writeFileSync(file, JSON.stringify(binding));
  assert.throws(() => c.clear('test-clear'), /does not belong/i);
  assert.equal(existsSync(config.root), true); assert.equal(existsSync(config.programDir), true);
});

test("External instances and Hub directories cannot nest and directory links cannot bypass clear boundaries", t => {
  const { work, config, bind } = fixture(t);
  assert.throws(() => registerExternalInstance({ ...config, managedBase: join(config.root, '.git'), bindingId: randomUUID() }), /invalid.*parameters/i);
  bind(); const c = createSubLifecycle(config);
  const unrelated = join(work, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep.txt'), 'keep');
  symlinkSync(unrelated, join(config.root, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => c.clear('test-link-clear'), /links/i);
  assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'keep'); assert.equal(existsSync(config.runtimeDir), true);
});

test("Changed registered paths preserve instance and program before clearing", t => {
  const { config, bind } = fixture(t); bind(); const c = createSubLifecycle(config);
  const path = join(config.managedBase, 'installation.json'), record = JSON.parse(readFileSync(path)); record.paths.push(resolve('other')); writeFileSync(path, JSON.stringify(record));
  assert.throws(() => c.clear('test-manifest-clear'), /registration|registered/i); assert.equal(existsSync(config.root), true);
});

test("Cross-drive Hub and instance installations clear only according to explicit bindings", { skip: parse(resolve('aipa-test-tmp')).root.toLowerCase() === parse(tmpdir()).root.toLowerCase() }, t => {
  const { config } = fixture(t), tempParent = realpathSync(tmpdir());
  const managedBase = mkdtempSync(join(tempParent, 'aipa-cross-drive-'));
  t.after(() => { assert.ok(realpathSync(managedBase).startsWith(tempParent + sep)); rmSync(managedBase, { recursive: true, force: true }); });
  config.managedBase = managedBase; config.runtimeDir = join(managedBase, 'runtime'); config.programDir = join(managedBase, 'program');
  for (const p of [config.runtimeDir, config.programDir]) mkdirSync(p);
  config.externalInstance = registerExternalInstance({ ...config, bindingId: randomUUID() });
  assert.notEqual(parse(config.root).root.toLowerCase(), parse(config.managedBase).root.toLowerCase());
  createSubLifecycle(config).clear('cross-drive-clear'); assert.equal(existsSync(config.root), false); assert.equal(existsSync(config.runtimeDir), false);
});
