import { resolve } from 'node:path';
import { readJson } from './lib/storage.mjs';
import { handleTaskHook } from './lib/task-bridge.mjs';
import { subCommand } from './lib/sub-ipc.mjs';
import { writeJson } from './lib/storage.mjs';
import { join } from 'node:path';

try {
  const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
  if (!args.includes('--config') || !args.includes('--tool')) throw new Error("--config and --tool are required");
  const config = readJson(resolve(option('--config')), null); let raw = '';
  for await (const part of process.stdin) { raw += part; if (raw.length > 1_000_000) throw new Error("Hook input too large"); }
  const result = handleTaskHook(config, option('--tool'), JSON.parse(raw));
  if (result.ended && config.nodeId) await subCommand(config.runtimeDir, 'task-wake').catch(() => {});
  if (result.ended && !config.nodeId) writeJson(join(config.runtimeDir, 'task-wake.json'), { requestedAt: new Date().toISOString() });
} catch (error) { console.error(error.message); process.exitCode = 2; }
