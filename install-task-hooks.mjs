import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, safeInstancePath, atomicWrite } from './lib/storage.mjs';
import { randomUUID } from 'node:crypto';
import { detectTools, dshMountEntry, TOOL_TARGETS, WRAPPER_TOOLS } from './lib/tool-integration.mjs';

export function installTaskHooks(configFile, { dryRun = false, env = process.env, tools } = {}) {
  configFile = resolve(configFile); const config = readJson(configFile), root = resolve(config.root), here = dirname(fileURLToPath(import.meta.url));
  const bridge = join(here, 'task-hook.mjs').replaceAll('\\', '/'), node = process.execPath.replaceAll('\\', '/'), fileArg = configFile.replaceAll('\\', '/');
  if ([bridge, node, fileArg, root].some(v => /["`$%\r\n]/.test(v))) throw new Error("Gate script or configuration path contains shell metacharacters; use a plain installation path");
  const detected = detectTools({ env }), command = `"${node}" "${bridge}" --config "${fileArg}" --tool`;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.length || tools.some(id => !TOOL_TARGETS.some(target => target.id === id)))) throw new Error("Invalid tool selection");
  const targets = TOOL_TARGETS.filter(target => !tools || tools.includes(target.id));
  const changed = [];
  for (const target of targets) {
    const tool = target.id, path = safeInstancePath(root, join(root, target.hookFile)), data = readJson(path, {}), hooks = data.hooks || (data.hooks = {});
    if (target.schemaVersion && data.version === undefined) data.version = target.schemaVersion;
    for (const event of target.events) {
      hooks[event] ||= [];
      if (!Array.isArray(hooks[event])) throw new Error("Existing hook configuration is invalid and has been preserved");
      const toolCommand = `${command} ${tool}`;
      if (!hooks[event].some(group => group.hooks?.some(hook => hook.command === toolCommand))) {
        const timeout = tool === 'codex' && ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 10;
        const group = { ...(event === 'PreToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command: toolCommand, timeout }] };
        if (event === 'Stop' && tool === 'trae') group.loop_limit = 1;
        hooks[event].push(group);
      }
    }
    const detectedTool = detected.find(entry => entry.id === tool);
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) { const backup = join(config.runtimeDir, `hooks-backup-${tool}-${randomUUID()}.json`); mkdirSync(dirname(backup), { recursive: true }); copyFileSync(path, backup); }
      writeJson(path, data);
    }
    const record = { tool, label: target.label, path: target.hookFile, mode: target.mode, events: target.events, detected: detectedTool.detected, evidence: detectedTool.evidence, requiresToolTrustReview: true };
    if (target.mode === 'bridge-mount') {
      const mount = dshMountEntry({ hookFile: join(root, target.hookFile), projectDir: root });
      if (!dryRun) {
        const mountFile = safeInstancePath(root, join(root, mount.file));
        if (existsSync(mountFile)) copyFileSync(mountFile, join(config.runtimeDir, `bridge-backup-${randomUUID()}.yml`));
        atomicWrite(mountFile, mount.yaml);
      }
      record.status = 'requires-mount'; record.mount = { ...mount, yaml: undefined, path: mount.file };
    } else record.status = detectedTool.detected ? 'configured' : 'configured-tool-not-detected';
    changed.push(record);
  }
  const notDetected = changed.filter(entry => !entry.detected).map(entry => entry.label);
  if (!dryRun) {
    const excludes = join(root, '.git/info/exclude'), before = existsSync(excludes) ? readFileSync(excludes, 'utf8') : '';
    const rules = [...targets.map(target => target.hookFile), ...changed.filter(entry => entry.mount).map(entry => entry.mount.file)].filter((path, index, all) => all.indexOf(path) === index).map(path => '/' + path).filter(path => !before.split(/\r?\n/).includes(path));
    if (rules.length) { mkdirSync(dirname(excludes), { recursive: true }); writeFileSync(excludes, before + "\n# AIPA Hub local task gate\n" + rules.join('\n') + '\n'); }
  }
  return {
    dryRun, hooks: changed, wrapperTools: WRAPPER_TOOLS,
    detection: { detected: detected.filter(entry => entry.detected).map(entry => entry.label), notDetected },
    note: "Generating configuration does not mean the IDE trusts execution. Review and trust local definitions in each tool hook panel, then validate. DeepSeek Harness also needs its bridge entry and run-instance-task.mjs fallback.",
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--config');
    if (args.includes('--probe')) { console.log(JSON.stringify({ tools: detectTools(), wrapperTools: WRAPPER_TOOLS }, null, 2)); }
    else {
      if (at < 0) throw new Error("--config <hub-config> [--dry-run] or --probe is required");
      const toolsAt = args.indexOf('--tools');
      console.log(JSON.stringify(installTaskHooks(args[at + 1], { dryRun: args.includes('--dry-run'), tools: toolsAt < 0 ? undefined : (args[toolsAt + 1] || '').split(',') }), null, 2));
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
