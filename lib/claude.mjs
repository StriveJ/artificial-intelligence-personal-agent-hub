import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

export function findClaudeEntry(explicit = process.env.AIPA_CLAUDE_ENTRY) {
  if (explicit) return resolve(explicit);
  if (process.platform === 'win32' && process.env.APPDATA) {
    const base = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    for (const rel of [join('bin', 'claude.exe'), 'cli.js']) { const path = join(base, rel); if (existsSync(path)) return path; }
  }
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    const path = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (existsSync(path)) return path;
  }
  return null;
}

export function createClaudeRunner({ entry = findClaudeEntry(), workDir, timeoutMs = 180_000 } = {}) {
  workDir = resolve(workDir);
  mkdirSync(workDir, { recursive: true });
  const active = new Set();
  async function run(prompt) {
    if (!entry || !existsSync(entry)) throw new Error("Claude Code not found. Install and sign in, or set AIPA_CLAUDE_ENTRY.");
    const js = ['.js', '.mjs'].includes(extname(entry));
    const args = [...(js ? [entry] : []), '--print', '--bare', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'];
    return new Promise((resolveRun, reject) => {
      const child = spawn(js ? process.execPath : entry, args, { cwd: workDir, env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = '', stderr = '', bytes = 0, settled = false;
      function stop() {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill('SIGTERM');
      }
      active.add(stop);
      const finish = (error, answer) => {
        if (settled) return;
        settled = true; clearTimeout(timer); active.delete(stop);
        if (error) reject(error); else resolveRun(answer);
      };
      const timer = setTimeout(() => { stop(); finish(new Error("Conversation engine timed out. Input saved; retry is available.")); }, timeoutMs);
      child.stdout.on('data', data => {
        bytes += Buffer.byteLength(data);
        if (bytes > 2_000_000) { stop(); finish(new Error("Conversation engine returned too much content")); return; }
        stdout += data;
      });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
      child.on('error', () => finish(new Error("Cannot start Claude Code. Check the local installation.")));
      child.on('close', code => {
        let data; try { data = JSON.parse(stdout); } catch {  }
        run.lastDiagnostic = { exitCode: code, stderr };
        if (code === 0 && !data?.is_error && typeof data?.result === 'string' && data.result.trim()) finish(null, data.result.trim());
        else {
          const auth = /401|403|unauthorized|login|authentication/i.test(stderr + (data?.result || ''));
          finish(new Error(auth ? "Claude Code authentication or service permissions unavailable. Check sign-in on the Hub device." : "Claude Code did not complete this turn. Check network and quota on the Hub device, then retry."));
        }
      });
      child.stdin.on('error', () => {}); child.stdin.end(prompt, 'utf8');
    });
  }
  run.available = Boolean(entry && existsSync(entry));
  run.identity = { executor:'claude-cli',entry };
  run.close = () => { for (const stop of active) stop(); };
  return run;
}
