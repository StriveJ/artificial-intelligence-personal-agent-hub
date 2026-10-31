import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

// Task executor (T3). Runs a coding agent for one task and returns a summary plus the
// files it changed. The DeepSeek Harness CLI is the first supported driver: with the
// headless profile its permission mode defaults to `workspace-write`, so the agent can
// edit files under the task directory and nothing outside it.
//
// Isolation: every task gets its own HOME/DSH_HOME and a private temporary job directory,
// so a task cannot read the owner's credentials, sessions or IDE instructions. The task's
// `cwd` is resolved under the instance root and re-checked after realpath.

const MAX_OUTPUT = 2_000_000;
const tail = (text, limit = 4000) => {
  const value = String(text || '').trim();
  return value.length > limit ? value.slice(-limit) : value;
};

export function createHarnessExecutor({ root, entry = process.env.AIPA_HARNESS_ENTRY, model = null, baseUrl = null, apiKey = null, env = process.env, maxChangedFiles = 20, now = Date.now } = {}) {
  if (!root) throw new Error("Task executor requires the instance root");
  const base = realpathSync(root);

  function taskDirectory(cwd) {
    const target = resolve(base, String(cwd || '.'));
    const rel = relative(base, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Object.assign(new Error("Task directory is outside the instance"), { code: 'cwd-outside-root' });
    if (!existsSync(target)) throw Object.assign(new Error(`Task directory does not exist: ${rel || '.'}`), { code: 'cwd-missing' });
    const real = realpathSync(target);
    const realRel = relative(base, real);
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw Object.assign(new Error("Task directory resolves outside the instance"), { code: 'cwd-outside-root' });
    return real;
  }

  function changedFiles(directory) {
    try {
      const output = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return output.split(/\r?\n/).map(line => line.slice(3).trim()).filter(Boolean).slice(0, maxChangedFiles);
    } catch { return []; }
  }

  function patchFile(job) {
    if (!model) return null;
    const path = join(job, 'model.patch.yml');
    writeFileSync(path, ['- id: agent-default-model', '  config:', '    provider: deepseek-official', `    model: ${JSON.stringify(model)}`].join('\n') + '\n');
    return path;
  }

  async function run({ prompt, cwd = '', timeoutMs = 600_000, signal } = {}) {
    const directory = taskDirectory(cwd);
    if (!entry || !existsSync(entry)) throw Object.assign(new Error("DeepSeek Harness CLI is not installed for task execution"), { code: 'executor-missing' });
    const job = mkdtempSync(join(tmpdir(), 'aipa-task-'));
    const patch = patchFile(job);
    const childEnv = {
      PATH: env.PATH || '',
      LANG: 'C.UTF-8',
      HOME: job,
      DSH_HOME: join(job, '.dsh'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TOOLS_MODE: 'native',
      DSH_PERMISSION_MODE: 'workspace-write',
      DEEPSEEK_API_KEY: apiKey || env.DEEPSEEK_API_KEY || '',
      ...(baseUrl || env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: baseUrl || env.DEEPSEEK_BASE_URL } : {}),
      ...(env.SYSTEMROOT ? { SYSTEMROOT: env.SYSTEMROOT } : {}),
      ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    };
    const args = [entry, '--profile', 'headless', ...(patch ? ['--patch', patch] : []), '-'];
    const started = now();
    try {
      return await new Promise((resolveRun, rejectRun) => {
        let output = '', errors = '', bytes = 0, settled = false, timer = null;
        const onAbort = () => stop(Object.assign(new Error("Task was aborted"), { code: 'aborted' }));
        const child = spawn(process.execPath, args, { cwd: directory, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          if (error) rejectRun(error); else resolveRun(value);
        };
        let stopping = false;
        const stop = reason => {
          if (settled || stopping) return;
          stopping = true;
          // Wait for the process to exit (bounded) so it releases the working directory
          // before the caller cleans up; report the reason we stopped for regardless.
          const fallback = setTimeout(() => finish(reason), 2000);
          child.once('close', () => { clearTimeout(fallback); finish(reason); });
          try {
            if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else process.kill(-child.pid, 'SIGTERM');
          } catch { clearTimeout(fallback); finish(reason); }
        };
        timer = setTimeout(() => stop(Object.assign(new Error("Task exceeded its timeout"), { code: 'timeout' })), Math.max(1_000, timeoutMs));
        if (signal) {
          if (signal.aborted) return stop(Object.assign(new Error("Task was aborted"), { code: 'aborted' }));
          signal.addEventListener?.('abort', onAbort, { once: true });
        }
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_OUTPUT) stop(Object.assign(new Error("Task output is too large"), { code: 'output-too-large' }));
          else output += chunk;
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { errors = tail(errors + chunk, 8_000); });
        child.on('error', error => finish(Object.assign(error, { code: 'executor-error' })));
        child.on('close', code => {
          if (settled || stopping) return;
          finish(null, {
            code: code === 0 ? 'ok' : `exit-${code}`,
            summary: tail(output) || (code === 0 ? '' : tail(errors)),
            stderr: errors,
            durationMs: now() - started,
            artifacts: changedFiles(directory),
          });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(String(prompt || ''));
      });
    } finally {
      rmSync(job, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  return { run, driver: 'deepseek-harness' };
}
