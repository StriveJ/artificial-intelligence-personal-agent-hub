import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCoreRuntime } from '../lib/core-runtime.mjs';

const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });
function fixture(t) {
  const root = mkdtempSync(join(TMP, 'core-runtime-'));
  t.after(() => { assert.ok(resolve(root).startsWith(TMP + sep)); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'core-space/scripts/lib'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'aipa:\n  version: synthetic\n');
  const leaf = join(root, 'core-space/scripts/lib/leaf.mjs');
  writeFileSync(leaf, 'export const value = "original";\n');
  writeFileSync(join(root, 'core-space/scripts/lib/entry.mjs'), 'import {value} from "./leaf.mjs"; export const read = () => value;\n');
  return { root, leaf };
}
test("Transitive program changes require restart; restored original programs can continue without mixed dependencies", async t => {
  const f = fixture(t), runtime = createCoreRuntime(f.root), entry = runtime.guard(await runtime.lib('entry.mjs'));
  assert.equal(entry.read(), 'original');
  const original = readFileSync(f.leaf);
  writeFileSync(f.leaf, 'export const value = "updated";\n');
  assert.equal(runtime.status().code, 'core_restart_required');
  assert.throws(() => entry.read(), { code: 'core_restart_required', status: 503 });
  await assert.rejects(() => runtime.lib('entry.mjs'), { code: 'core_restart_required' });
  assert.throws(() => createCoreRuntime(f.root), { code: 'core_restart_required' });
  const moduleUrl = new URL('../lib/core-runtime.mjs', import.meta.url).href;
  const program = `import {createCoreRuntime} from ${JSON.stringify(moduleUrl)}; const r=createCoreRuntime(${JSON.stringify(f.root)}); console.log((await r.lib('entry.mjs')).read());`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', windowsHide: true }).trim(), 'updated');
  writeFileSync(f.leaf, original);
  assert.equal(runtime.status().status, 'ready'); assert.equal(entry.read(), 'original');
});
test("Data and configuration changes preserve code identity while instance module caches remain independent", async t => {
  const f = fixture(t), other = fixture(t), runtime = createCoreRuntime(f.root);
  const entry = await runtime.lib('entry.mjs'), identity = runtime.status().sourceSha256;
  mkdirSync(join(f.root, 'user-space'));
  writeFileSync(join(f.root, 'user-space/synthetic.txt'), 'SYNTHETIC_PRIVATE_SENTINEL');
  assert.equal(runtime.status().sourceSha256, identity);
  assert.equal(await runtime.lib('entry.mjs'), entry);
  writeFileSync(other.leaf, 'export const value = "other";\n');
  assert.equal((await createCoreRuntime(other.root).lib('entry.mjs')).read(), 'other');
  assert.equal(entry.read(), 'original');
  assert.equal(readFileSync(join(f.root, 'user-space/synthetic.txt'), 'utf8'), 'SYNTHETIC_PRIVATE_SENTINEL');
});
test("Incomplete programs block conservatively and asynchronous results are rechecked before delivery", async t => {
  const f = fixture(t), runtime = createCoreRuntime(f.root);
  let finish;
  const pending = runtime.wrap(() => new Promise(resolve => { finish = resolve; }))();
  rmSync(f.leaf);
  finish('must-not-deliver');
  await assert.rejects(() => pending, { code: 'core_restart_required' });
  assert.equal(runtime.status().status, 'blocked');
});

test("Changes during module loading contaminate the process cache and require restart even after file restoration", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'core-space/scripts/lib/delayed.mjs'), 'await new Promise(r=>setTimeout(r,80)); export const loaded=true;\n');
  const runtime = createCoreRuntime(f.root), original = readFileSync(f.leaf);
  const loading = runtime.lib('delayed.mjs');
  const rejected = assert.rejects(() => loading, { code: 'core_restart_required' });
  await new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(f.leaf, 'export const value="changed-during-import";\n');
  await rejected;
  writeFileSync(f.leaf, original);
  assert.equal(runtime.status().status, 'blocked');
  assert.throws(() => createCoreRuntime(f.root), { code: 'core_restart_required' });
});
