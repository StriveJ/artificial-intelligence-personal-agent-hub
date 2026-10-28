import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// This composition is pinned to @deepseek-ai/dsh 0.2.1-rc.2; upgrades require the
// real CLI contract test, including a zero-tool request and malicious tool call.
export const HARNESS_VERSION = '0.2.1-rc.2';
const disabled = ['session-title-llm','agent-instructions','skill-filesystem','plugin-manager',
  'tool-plugin-manager','tool-working-directory','tool-bash','tool-pwsh','tool-jobs','tool-fs',
  'tool-fs-search','tool-skill','tool-subagent-control','tool-subagent-list-agents','tool-subagent',
  'tool-subagent-fork','tool-workflow','tool-result-pruner','tool-todo','tool-goal','tool-web','mcp-resources','plan-mode'];
export function harnessPatch(model = 'deepseek-flash') {
  return disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') +
    '- id: tools\n  config:\n    mode: native\n' +
    '- id: session-telemetry-otel\n  disabled: true\n' +
    '- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    thinking: disabled\n    maxTokens: 8192\n' +
    `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${JSON.stringify(model)}\n` +
    `- insert:\n    - id: aipa-no-tools\n      name: ${JSON.stringify(fileURLToPath(new URL('./harness-guard.mjs', import.meta.url)))}\n`;
}

export function createHarnessRunner({ entry = process.env.AIPA_HARNESS_ENTRY, workDir, timeoutMs = 180_000, env = process.env } = {}) {
  workDir = resolve(workDir); mkdirSync(workDir, { recursive:true, mode:0o700 });
  entry = entry ? resolve(entry) : null;
  const model = env.AIPA_HARNESS_MODEL || 'deepseek-flash', patch = harnessPatch(model), active = new Set();
  let closed = false;
  async function run(prompt) {
    if (closed) throw new Error("Hub model engine stopped");
    if (!entry || !existsSync(entry)) throw new Error("Controlled DeepSeek Harness CLI is not installed");
    const job = mkdtempSync(join(workDir,'job-')), patchFile = join(job,'hub.patch.yml');
    writeFileSync(patchFile,patch,{mode:0o600});
    // An isolated home prevents loading IDE instructions, credentials or sessions.
    // Each job is removed on close; only Hub retains the authorized conversation.
    const childEnv = { PATH:env.PATH || '', SYSTEMROOT:env.SYSTEMROOT || env.SystemRoot || process.env.SYSTEMROOT || process.env.SystemRoot || '',
      LANG:'C.UTF-8', HOME:job, USERPROFILE:job, DSH_HOME:join(job,'.dsh'),
      DSH_TELEMETRY_DISABLED:'1', DSH_TOOLS_MODE:'native', DSH_PERMISSION_MODE:'read-only',
      DEEPSEEK_BASE_URL:env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic',
      DEEPSEEK_API_KEY:env.DEEPSEEK_API_KEY || '' };
    return new Promise((yes,no) => {
      let output = '', bytes = 0, error, killTimer, settled = false;
      const child = spawn(process.execPath,[entry,'--profile','headless','--patch',patchFile,'-'],
        {cwd:job,env:childEnv,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
      function stop(reason = new Error("Conversation aborted; input saved")) {
        error ||= reason;
        if (child.pid) {
          if (process.platform==='win32') {
            const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
            killer.on('error',()=>child.kill());
          } else {
            try { process.kill(-child.pid,'SIGTERM'); } catch {}
            killTimer ||= setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);
          }
        }
      }
      const timer = setTimeout(()=>stop(new Error("DeepSeek Harness timed out; input saved. Retry is available.")),timeoutMs);
      active.add(stop);
      function finish(code) {
        if (settled) return; settled=true; clearTimeout(timer);clearTimeout(killTimer);active.delete(stop);
        rmSync(job,{recursive:true,force:true});
        run.lastDiagnostic={exitCode:code};
        if (error) no(error);
        else if (code===0 && output.trim()) yes(output.trim());
        else no(new Error("DeepSeek Harness did not complete this turn. Check main Hub network, credentials, and quota."));
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', b=>{bytes+=Buffer.byteLength(b);if(bytes>2_000_000)stop(new Error("Model response is too large"));else output+=b;});
      // Consume diagnostics without persisting provider responses or credentials.
      child.stderr.on('data',()=>{});
      child.stdin.on('error',()=>{});
      child.once('error',()=>{error=new Error("Cannot start DeepSeek Harness");finish(null);});
      child.once('close',finish);child.stdin.end(prompt,'utf8');
    });
  }
  run.available=Boolean(entry && existsSync(entry) && env.DEEPSEEK_API_KEY);
  run.identity={executor:'deepseek-harness',version:HARNESS_VERSION,entry,model,composition:createHash('sha256').update(patch).digest('hex')};
  run.close=()=>{closed=true;for(const stop of active)stop();};
  return run;
}
