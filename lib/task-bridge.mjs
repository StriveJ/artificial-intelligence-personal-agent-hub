import { resolve, sep } from 'node:path';
import { createTaskGate } from './task-gate.mjs';

const START = ['UserPromptSubmit', 'PreToolUse', 'task-start'];
const END = ['Stop', 'Interrupt', 'SessionEnd', 'task-end'];

export function handleTaskHook(config, tool, input) {
  if (!['codex', 'claude', 'codebuddy', 'trae', 'deepseek', 'manual'].includes(tool)) throw new Error("Invalid tool kind");
  const cwd = resolve(input.cwd || config.root), root = resolve(config.root);
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalized(cwd) !== normalized(root) && !normalized(cwd).startsWith(normalized(root) + sep)) return { ignored: true };
  const event = input.hook_event_name || input.event;
  if (![...START, ...END].includes(event)) return { ignored: true };
  const id = `${tool}:${input.session_id || input.sessionId || ''}`;
  if (id.endsWith(':')) throw new Error("Task session ID is required");
  const gate = createTaskGate(root);
  if (START.includes(event)) {
    if (gate.startSession(id)) return { acquired: true };
    const maintenance = gate.maintenance();
    throw new Error(maintenance ? `Instance is under ${maintenance.reason} maintenance; task deferred. Retry later.` : "Instance is synchronizing or running another session; this task is deferred. Retry later.");
  }
  try { return { ended: gate.endSession(id) }; }
  catch { return { ended: false, ownedByOther: true }; }
}
