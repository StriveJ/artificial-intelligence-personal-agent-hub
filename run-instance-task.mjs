import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readJson } from './lib/storage.mjs';
import { subCommand } from './lib/sub-ipc.mjs';

const configAt = process.argv.indexOf('--config'), split = process.argv.indexOf('--');
try {
  if (configAt < 0 || split < 0 || !process.argv[split + 1]) throw new Error("Task configuration or command missing");
  const config = readJson(resolve(process.argv[configAt + 1]), null);
  const lock = await subCommand(config.runtimeDir, 'task-start', { pid: process.pid });
  if (!lock) throw new Error("Instance is synchronizing or running another task. Start later.");
  try {
    const child = spawn(process.argv[split + 1], process.argv.slice(split + 2), { shell: false, windowsHide: true, stdio: 'inherit',env:{...process.env,AIPA_HUB_TASK_TOKEN:lock.token} });
    process.exitCode = await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => yes(code ?? 1)); });
  } finally { await subCommand(config.runtimeDir, 'task-end', { lockToken: lock.token }); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
