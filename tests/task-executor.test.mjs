import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHarnessExecutor } from '../lib/task-executor.mjs';

const TMP = resolve('aipa-test-tmp');
mkdirSync(TMP, { recursive: true });
function temp(t) {
  const path = mkdtempSync(join(TMP, 'task-executor-'));
  t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return path;
}
// Stand-in for the Harness CLI: reads the prompt from stdin and behaves per marker.
const STUB = `
import { readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (prompt.includes('FAIL')) { console.error('stub failure'); process.exit(1); }
if (prompt.includes('SLEEP')) { setTimeout(() => {}, 60_000); }
else { writeFileSync('out.txt', 'done\\n'); console.log('handled: ' + prompt.trim()); }
`;
function instance(t) {
  const root = join(temp(t), 'instance');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@example.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T'], { stdio: 'pipe' });
  return root;
}
function stub(dir) {
  const path = join(dir, 'stub.mjs');
  writeFileSync(path, STUB);
  return path;
}

test("the executor runs the agent in the task directory and reports changed files", async t => {
  const root = instance(t), entry = stub(root);
  const executor = createHarnessExecutor({ root, entry, env: { PATH: process.env.PATH } });
  const result = await executor.run({ prompt: "Add the file", cwd: '', timeoutMs: 10_000 });
  assert.equal(result.code, 'ok');
  assert.match(result.summary, /handled: Add the file/);
  assert.ok(existsSync(join(root, 'out.txt')));
  assert.ok(result.artifacts.includes('out.txt'));
  assert.equal(executor.driver, 'deepseek-harness');
});

test("a non-zero exit becomes a failed result with stderr kept", async t => {
  const root = instance(t), entry = stub(root);
  const executor = createHarnessExecutor({ root, entry, env: { PATH: process.env.PATH } });
  const result = await executor.run({ prompt: "FAIL now", timeoutMs: 10_000 });
  assert.equal(result.code, 'exit-1');
  assert.match(result.stderr, /stub failure/);
});

test("a task that runs too long is killed and reports a timeout", async t => {
  const root = instance(t), entry = stub(root);
  const executor = createHarnessExecutor({ root, entry, env: { PATH: process.env.PATH } });
  await assert.rejects(() => executor.run({ prompt: "SLEEP", timeoutMs: 400 }), err => err.code === 'timeout');
});

test("an aborted task stops promptly", async t => {
  const root = instance(t), entry = stub(root);
  const executor = createHarnessExecutor({ root, entry, env: { PATH: process.env.PATH } });
  const controller = new AbortController();
  const running = executor.run({ prompt: "SLEEP", timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(() => running, err => ['aborted', 'timeout'].includes(err.code));
});

test("task directories cannot escape the instance root", async t => {
  const root = instance(t), entry = stub(root);
  const executor = createHarnessExecutor({ root, entry, env: { PATH: process.env.PATH } });
  await assert.rejects(() => executor.run({ prompt: "x", cwd: '../outside' }), err => err.code === 'cwd-outside-root');
  await assert.rejects(() => executor.run({ prompt: "x", cwd: 'missing-dir' }), err => err.code === 'cwd-missing');
});

test("a missing Harness entry fails before running anything", async t => {
  const root = instance(t);
  const executor = createHarnessExecutor({ root, entry: join(root, 'not-installed.mjs'), env: { PATH: process.env.PATH } });
  await assert.rejects(() => executor.run({ prompt: "x" }), err => err.code === 'executor-missing');
});
