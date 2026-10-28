import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test("Frontend scripts end with startup calls and pass syntax checks", () => {
  const app = readFileSync(resolve('public/app.js'), 'utf8').trimEnd();
  assert.ok(app.endsWith('void boot();'), "app.js must end with void boot();");
  assert.ok(app.split('\n').length > 300, "app.js must not be truncated to a short file");
  for (const file of readdirSync(resolve('public')).filter(name => name.endsWith('.js') && !name.includes('vendor'))) {
    execFileSync(process.execPath, ['--check', resolve('public', file)], { stdio: 'pipe' });
  }
  for (const file of readdirSync(resolve('lib')).filter(name => name.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', resolve('lib', file)], { stdio: 'pipe' });
  }
});

test("Main script contains no isolated single-character truncation statements", () => {
  const app = readFileSync(resolve('public/app.js'), 'utf8');
  const lines = app.split('\n').map(line => line.trim()).filter(Boolean);
  assert.deepEqual(lines.filter(line => /^[a-zA-Z]$/.test(line)), [], "Isolated identifier lines are forbidden");
});

test("Every key function referenced during startup is defined", () => {
  const app = readFileSync(resolve('public/app.js'), 'utf8');
  for (const name of ['api', 'xhrJson', 'boot', 'showLogin', 'refreshChats', 'loadTasks', 'loadPushes', 'loadWebSettings', 'renderWebSettings', 'renderCustomChips', 'toggleNewsLike', 'renderBriefingSettings']) {
    const defined = new RegExp('function\\s+' + name + '\\s*\\(').test(app) || new RegExp('(const|let)\\s+' + name + '\\s*=').test(app);
    assert.ok(defined, `${name} \u5fc5\u987b\u6709\u5b9a\u4e49`);
    assert.ok(app.includes(name), `${name} \u5fc5\u987b\u88ab\u5f15\u7528`);
  }
});