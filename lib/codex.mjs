import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

export function findCodexEntry(explicit = process.env.AIPA_CODEX_ENTRY) {
  if (explicit) return resolve(explicit);
  if (process.platform === 'win32' && process.env.APPDATA) {
    const js = join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(js)) return js;
  }
  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const name of names) { const path = join(dir, name); if (existsSync(path)) return path; }
  }
  return null;
}

export function createCodexRunner({ entry = findCodexEntry(), workDir, timeoutMs = 180_000, model = process.env.AIPA_CODEX_MODEL || '' } = {}) {
  if (!workDir) throw new Error("Engine working directory is required");
  workDir = resolve(workDir);
  mkdirSync(workDir, { recursive: true });
  const children = new Set();
  async function run(prompt) {
    if (!entry || !existsSync(entry)) throw new Error("Codex CLI not found. Install and sign in, or set AIPA_CODEX_ENTRY.");
    const js = extname(entry) === '.js';
    const args = [...(js ? [entry] : []), 'exec', '--json', '--color', 'never', '--ephemeral',
      '--ignore-user-config', ...(model ? ['--model', model] : []),
      '--sandbox', 'read-only', '--skip-git-repo-check', '-C', workDir, '-'];
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    return new Promise((resolveRun, reject) => {
      const child = spawn(js ? process.execPath : entry, args, {
        cwd: workDir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      children.add(child);
      let buffer = '', answer = '', failed = false, stderr = '', bytes = 0, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); children.delete(child);
        if (error) reject(error); else resolveRun(answer.trim());
      };
      function stop() {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill('SIGTERM');
      }
      child.hubStop = stop;
      const timer = setTimeout(() => { failed = true; run.lastDiagnostic = { exitCode: null, stderr }; stop(); finish(new Error("Conversation engine timed out. Input saved; retry is available.")); }, timeoutMs);
      const parse = line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer += (answer ? '\n\n' : '') + event.item.text;
          if (['turn.failed', 'error'].includes(event.type)) failed = true;
        } catch {  }
      };
      child.stdout.on('data', data => {
        bytes += data.length;
        if (bytes > 2_000_000) { failed = true; stop(); finish(new Error("Conversation engine returned too much content")); return; }
        buffer += data.toString('utf8');
        const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(parse);
      });
      child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-3000); });
      child.on('error', () => finish(new Error("Cannot start Codex CLI. Check the local installation.")));
      child.on('close', code => {
        run.lastDiagnostic = { exitCode: code, stderr };
        if (buffer.trim()) parse(buffer);
        if (failed || code !== 0 || !answer.trim()) {
          const auth = /401|403|unauthorized|login|authentication/i.test(stderr);
          finish(new Error(auth ? "Codex authentication expired. Run codex login on the Hub device again." : "Codex did not complete this turn. Check CLI network and configuration on the Hub device, then retry."));
        } else finish();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt, 'utf8');
    });
  }
  run.available = Boolean(entry && existsSync(entry));
  run.identity = { executor:'codex-cli',entry,model };
  run.close = () => { for (const child of children) child.hubStop?.(); };
  return run;
}
