import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DSH_BRIDGE = '@deepseek-ai/dsh-hooks-claude-code';

const npmBin = env => join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm');

export const TOOL_TARGETS = [
  {
    id: 'codex', label: 'Codex CLI', mode: 'project-hook',
    hookFile: '.codex/hooks.json', events: ['UserPromptSubmit', 'PreToolUse', 'Stop', 'Interrupt', 'SessionEnd'],
    search: ({ home, env }) => [join(home, '.codex'), env.AIPA_CODEX_ENTRY, join(npmBin(env), 'codex.cmd')].filter(Boolean),
  },
  {
    id: 'claude', label: 'Claude Code', mode: 'project-hook',
    hookFile: '.claude/settings.local.json', events: ['UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'],
    search: ({ home, env }) => [join(home, '.claude'), env.AIPA_CLAUDE_ENTRY, join(npmBin(env), 'claude.cmd')].filter(Boolean),
  },
  {
    id: 'codebuddy', label: 'CodeBuddy', mode: 'project-hook',
    hookFile: '.codebuddy/settings.local.json', events: ['UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'],
    search: ({ home }) => [join(home, '.codebuddy'), join(home, 'AppData', 'Roaming', 'CodeBuddy')],
  },
  {
    id: 'trae', label: 'TRAE', mode: 'project-hook',
    hookFile: '.trae/hooks.json', events: ['UserPromptSubmit', 'PreToolUse', 'Stop'], schemaVersion: 1,
    search: ({ home }) => [join(home, '.trae-cn'), join(home, '.trae'), join(home, 'AppData', 'Roaming', 'Trae CN')],
  },
  {
    id: 'deepseek', label: 'DeepSeek Harness', mode: 'bridge-mount',
    hookFile: '.dsh/hooks.json', events: ['UserPromptSubmit', 'PreToolUse', 'Stop'],
    search: ({ home, env }) => [join(home, '.dsh'), env.DSH_HOME && join(env.DSH_HOME), env.DSH_ENTRY].filter(Boolean),
  },
];

export const WRAPPER_TOOLS = [
  { id: 'vscode', label: 'VS Code', mode: 'wrapper-only', note: "Agents running inside the editor use their hooks or run-instance-task.mjs for terminal tasks. A reused process launch command does not represent the complete task lifetime." },
  { id: 'script', label: "Scripts / other GUIs", mode: 'wrapper-only', note: "Wrap the actual command with run-instance-task.mjs; the wrapper holds the task gate until the child command exits." },
];

export function detectTools({ home = homedir(), env = process.env, exists = existsSync } = {}) {
  return TOOL_TARGETS.map(target => {
    const searched = [...new Set(target.search({ home, env }))];
    const found = searched.filter(path => exists(path));
    return { id: target.id, label: target.label, mode: target.mode, hookFile: target.hookFile, events: target.events, detected: found.length > 0, evidence: found, searched };
  });
}

export function dshMountEntry({ hookFile, projectDir }) {
  return {
    plugin: DSH_BRIDGE,
    file: '.dsh/bridge-entry.yml',
    yaml: ['- name: \'' + DSH_BRIDGE + '\'', '  config:', `    configPath: ${hookFile.replaceAll('\\', '/')}`, `    projectDir: ${projectDir.replaceAll('\\', '/')}`].join('\n') + '\n',
    note: "DeepSeek Harness reads hooks from its plugin list, not workspace configuration. Add this entry to that installation plugin list, restart, and validate. Until mounted, wrap actual tasks with run-instance-task.mjs.",
  };
}
