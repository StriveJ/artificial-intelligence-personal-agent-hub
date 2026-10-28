import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installTaskHooks } from '../install-task-hooks.mjs';
import { detectTools, dshMountEntry, TOOL_TARGETS } from '../lib/tool-integration.mjs';
import { handleTaskHook } from '../lib/task-bridge.mjs';
import { createTaskGate } from '../lib/task-gate.mjs';

const TMP = resolve('aipa-test-tmp'); mkdirSync(TMP, { recursive: true });
function temp(t) { const path = mkdtempSync(join(TMP, 'tool-hooks-')); t.after(() => { assert.ok(path.startsWith(TMP + sep)); rmSync(path, { recursive: true, force: true }); }); return path; }
function instance(base, name = 'instance') {
  const root = join(base, name); mkdirSync(join(root, '.git/info'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'owner: synthetic-test\nversion: 1\n');
  const runtimeDir = join(base, 'runtime'); mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(base, 'config.json'), JSON.stringify({ root, runtimeDir }));
  return { root, runtimeDir, configFile: join(base, 'config.json') };
}
const present = (...paths) => path => paths.includes(path);

test("Six tool kinds report actual native-hook, plugin-mount, or wrapper integration separately", () => {
  const home = 'C:\\home\\tester';
  const tools = detectTools({ home, env: { APPDATA: 'C:\\home\\tester\\AppData\\Roaming' }, exists: present(join(home, '.codex'), join(home, '.trae-cn'), join(home, '.dsh')) });
  const byId = Object.fromEntries(tools.map(tool => [tool.id, tool]));
  assert.equal(byId.codex.detected, true); assert.equal(byId.codex.mode, 'project-hook');
  assert.ok(byId.codex.events.includes('Interrupt'));
  assert.equal(byId.codebuddy.detected, false); assert.deepEqual(byId.codebuddy.evidence, []);
  assert.equal(byId.trae.detected, true); assert.deepEqual(byId.trae.events, ['UserPromptSubmit', 'PreToolUse', 'Stop']);
  assert.equal(byId.deepseek.mode, 'bridge-mount'); assert.equal(byId.deepseek.detected, true);
  assert.deepEqual(tools.map(tool => tool.hookFile), ['.codex/hooks.json', '.claude/settings.local.json', '.codebuddy/settings.local.json', '.trae/hooks.json', '.dsh/hooks.json']);
});

test("Only detected tools count as integrated and duplicate candidate paths do not inflate counts", () => {
  const home = 'C:\\home\\tester';
  const tools = detectTools({ home, env: { DSH_HOME: join(home, '.dsh') }, exists: present(join(home, '.dsh')) });
  const dsh = tools.find(tool => tool.id === 'deepseek');
  assert.deepEqual(dsh.searched, [join(home, '.dsh')]); assert.equal(dsh.detected, true);
  assert.equal(tools.filter(tool => tool.detected).length, 1);
});

test("Installation merges project-local hooks only and preserves definitions with backups and ignore rules", async t => {
  const { root, runtimeDir, configFile } = instance(temp(t));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo original' }] }] } }));
  const result = installTaskHooks(configFile, { env: {} });
  const claude = JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(claude.permissions.allow, ['Bash(ls)']);
  assert.equal(claude.hooks.Stop.find(group => group.hooks.some(hook => hook.command === 'echo original')).hooks[0].type, 'command');
  assert.equal(claude.hooks.Stop.length, 2);
  const trae = JSON.parse(readFileSync(join(root, '.trae/hooks.json'), 'utf8'));
  assert.equal(trae.version, 1); assert.equal(trae.hooks.Stop[0].loop_limit, 1);
  assert.equal(trae.hooks.SessionEnd, undefined); // Compatibility and safety behavior is covered by contract tests.
  assert.match(result.hooks.find(hook => hook.tool === 'trae').path, /\.trae\/hooks\.json$/);
  const excludes = readFileSync(join(root, '.git/info/exclude'), 'utf8');
  for (const target of TOOL_TARGETS) assert.match(excludes, new RegExp('/' + target.hookFile.replace('.', '\\.')));
  assert.equal(existsSync(runtimeDir), true);
  assert.ok(result.hooks.every(hook => hook.requiresToolTrustReview));
  const codex = JSON.parse(readFileSync(join(root, '.codex/hooks.json'), 'utf8'));
  assert.equal(codex.hooks.Interrupt[0].hooks[0].timeout, 3);
  assert.equal(codex.hooks.SessionEnd[0].hooks[0].timeout, 3);
});

test("Repeated installation never duplicates commands and dry-run writes nothing", t => {
  const { root, configFile } = instance(temp(t));
  installTaskHooks(configFile, { env: {} }); const once = readFileSync(join(root, '.codex/hooks.json'), 'utf8');
  installTaskHooks(configFile, { env: {} }); assert.equal(readFileSync(join(root, '.codex/hooks.json'), 'utf8'), once);
  const dryRoot = instance(temp(t), 'dry'); const before = existsSync(join(dryRoot.root, '.dsh/hooks.json'));
  installTaskHooks(dryRoot.configFile, { dryRun: true, env: {} });
  assert.equal(before, false); assert.equal(existsSync(join(dryRoot.root, '.dsh/hooks.json')), false);
});

test("DeepSeek Harness prepares bridge entries without editing global plugin lists", t => {
  const { root, configFile } = instance(temp(t));
  const result = installTaskHooks(configFile, { env: {} });
  const dsh = result.hooks.find(hook => hook.tool === 'deepseek');
  assert.equal(dsh.status, 'requires-mount'); assert.equal(dsh.mount.file, '.dsh/bridge-entry.yml');
  const entry = readFileSync(join(root, '.dsh/bridge-entry.yml'), 'utf8');
  assert.match(entry, /^- name: '@deepseek-ai\/dsh-hooks-claude-code'$/m);
  assert.match(entry, /configPath: .*\/\.dsh\/hooks\.json$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.dsh/hooks.json'), 'utf8')).hooks.Stop.length, 1);
  const mount = dshMountEntry({ hookFile: join(root, '.dsh/hooks.json'), projectDir: root });
  assert.equal(mount.yaml, entry);
  assert.equal(existsSync(join(root, 'cordis.yml')), false);
  assert.match(readFileSync(join(root, '.git/info/exclude'), 'utf8'), /\/\.dsh\/bridge-entry\.yml/);
});

test("Selected tools alone receive gates; uninstalled tools get no configuration", t => {
  const { root, configFile } = instance(temp(t));
  const result = installTaskHooks(configFile, { tools: ['codex', 'claude', 'trae', 'deepseek'] });
  assert.equal(result.hooks.length, 4); assert.equal(existsSync(join(root, '.codebuddy/settings.local.json')), false);
  assert.throws(() => installTaskHooks(configFile, { tools: ['unknown'] }), /Invalid tool selection/);
});

test("Gate allows one session per instance and ignores nonowner stop signals", t => {
  const { root } = instance(temp(t), 'gate'); const config = { root };
  const inside = { cwd: root };
  assert.deepEqual(handleTaskHook(config, 'codex', { ...inside, hook_event_name: 'UserPromptSubmit', session_id: 'a' }), { acquired: true });
  assert.equal(handleTaskHook(config, 'codex', { ...inside, hook_event_name: 'PreToolUse', session_id: 'a' }).acquired, true);
  assert.throws(() => handleTaskHook(config, 'trae', { ...inside, hook_event_name: 'UserPromptSubmit', session_id: 'b' }), /other.*session|another session/i);
  assert.deepEqual(handleTaskHook(config, 'deepseek', { ...inside, hook_event_name: 'Stop', session_id: 'b' }), { ended: false, ownedByOther: true });
  assert.deepEqual(handleTaskHook(config, 'codex', { ...inside, hook_event_name: 'Stop', session_id: 'a' }), { ended: true });
  assert.deepEqual(handleTaskHook(config, 'trae', { ...inside, hook_event_name: 'task-start', session_id: 'b' }), { acquired: true });
  assert.deepEqual(handleTaskHook(config, 'trae', { ...inside, hook_event_name: 'task-end', session_id: 'b' }), { ended: true });
  assert.equal(createTaskGate(config.root).state(), null);
});

test("Gate distinguishes maintenance and out-of-scope events and rejects missing session IDs", t => {
  const { root } = instance(temp(t), 'scope'); const config = { root };
  const gate = createTaskGate(root); gate.pause('update-operation', 'update');
  assert.throws(() => handleTaskHook(config, 'codex', { cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'a' }), /maintenance/i);
  assert.deepEqual(handleTaskHook(config, 'codex', { cwd: 'C:\\elsewhere', hook_event_name: 'UserPromptSubmit', session_id: 'a' }), { ignored: true });
  assert.deepEqual(handleTaskHook(config, 'codex', { cwd: root, hook_event_name: 'Notification', session_id: 'a' }), { ignored: true });
  assert.throws(() => handleTaskHook(config, 'codex', { cwd: root, hook_event_name: 'UserPromptSubmit' }), /session ID/i);
  assert.throws(() => handleTaskHook(config, 'unknown-tool', { cwd: root, hook_event_name: 'Stop', session_id: 'a' }), /Invalid tool kind/);
});

test("Hook CLI returns zero on acquisition and exit two to block competing prompts", t => {
  const { root, configFile } = instance(temp(t), 'contract');
  installTaskHooks(configFile, { env: {} });
  const payload = (session, cwd = root) => JSON.stringify({ session_id: session, cwd, hook_event_name: 'UserPromptSubmit' });
  const run = (tool, stdin) => execFileSync(process.execPath, [resolve('task-hook.mjs'), '--config', configFile, '--tool', tool], { input: stdin, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(run('codex', payload('first')).trim(), '');
  assert.throws(() => run('trae', payload('second')), error => error.status === 2 && /other.*session|another session/i.test(String(error.stderr)));
  execFileSync(process.execPath, [resolve('task-hook.mjs'), '--config', configFile, '--tool', 'codex'], { input: JSON.stringify({ session_id: 'first', cwd: root, hook_event_name: 'Stop' }), encoding: 'utf8' });
  assert.equal(createTaskGate(root).state(), null);
  run('codex', payload('cancelled'));
  run('codex', JSON.stringify({ session_id: 'cancelled', cwd: root, hook_event_name: 'Interrupt' }));
  assert.equal(createTaskGate(root).state(), null);
});
