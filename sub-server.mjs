import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, unlinkSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import {createCoreRuntime} from './lib/core-runtime.mjs';
import { createInstanceSync } from './lib/instance-sync.mjs';
import { readJson, writeJson } from './lib/storage.mjs';
import { createCodexRunner } from './lib/codex.mjs';
import { createClaudeRunner } from './lib/claude.mjs';
import { createHarnessRunner } from './lib/harness.mjs';
import { createSubLifecycle } from './lib/sub-lifecycle.mjs';
import { removeSubStartup } from './lib/sub-startup.mjs';
import { bindManagedRuntime } from './lib/managed-runtime.mjs';
import { ipcPath, subCommand } from './lib/sub-ipc.mjs';
import {filesystemSocket} from './lib/local-socket.mjs';
import {createAgendaActions} from './lib/agenda-actions.mjs';
import {assertAgendaWritable} from './lib/agenda-capability.mjs';
import {ownsTaskLease} from './lib/task-gate.mjs';
import {modelProfile} from './lib/model-profile.mjs';
import {hubSupport,HUB_PROTOCOL,HUB_RUNTIME_SCHEMA} from './lib/support-contract.mjs';
import {createTaskWorker} from './lib/task-worker.mjs';
import {createHarnessExecutor} from './lib/task-executor.mjs';
export { ipcPath, subCommand } from './lib/sub-ipc.mjs';

const digest = value => createHash('sha256').update(value).digest();
function mainURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error("Sub Hubs connect only to HTTPS main Hubs or loopback HTTP through SSH tunnels");
  return url.origin;
}
export async function createSubHub(config) {
  const { root, runtimeDir, nodeId, installationId, token, engine = 'codex', testMode = true } = config;
  if (!root || !runtimeDir || !nodeId || !installationId || typeof token !== 'string') throw new Error("Incomplete sub Hub configuration");
  if (!['codex', 'claude', 'harness'].includes(engine)) throw new Error("Invalid model engine");
  if (testMode === false && existsSync(join(root, '.git/aipa-hub-no-push.json'))) throw new Error("A permanent test instance cannot start as a production instance");
  const lifecycle = createSubLifecycle({ ...config, installationId });
  if (lifecycle?.frozen()) return createClearedRecovery(config, lifecycle);
  mkdirSync(runtimeDir, { recursive: true });
  const origin = mainURL(config.mainUrl);
  const runner = typeof config.runner==='function'?config.runner:(engine === 'harness' ? createHarnessRunner : engine === 'claude' ? createClaudeRunner : createCodexRunner)({ workDir: join(runtimeDir, 'engine-work') });
  const sync = createInstanceSync({ root, runtimeDir, testMode });
  // Task execution is opt-in: without an injected executor the Sub Hub never claims work,
  // so a Main Hub simply sees a device that does not accept tasks.
  const taskRunner = (() => {
    if (typeof config.taskRunner === 'function') return config.taskRunner;
    if (config.tasks?.enabled !== true) return null;
    const entry = config.tasks.entry || process.env.AIPA_HARNESS_ENTRY;
    if (!entry) return null;
    const executor = createHarnessExecutor({
      root, entry,
      model: config.tasks.model || null,
      baseUrl: config.tasks.baseUrl || process.env.DEEPSEEK_BASE_URL || null,
      apiKey: config.tasks.apiKey || process.env.DEEPSEEK_API_KEY || null,
    });
    return input => executor.run(input);
  })();
  const taskWorker = createTaskWorker({
    post,
    runner: taskRunner,
    enabled: config.tasks?.enabled === true,
    intervalMs: Number(config.tasks?.intervalMs) || 5000,
  });
  let agendaService,agendaPromise,modelQueue=Promise.resolve();
  function executeModel(prompt){const result=modelQueue.then(()=>runner(prompt));modelQueue=result.catch(()=>{});return result;}
  const agendaProfile=()=>modelProfile({engine,runner});
  async function agenda(){
    if(!agendaService&&!agendaPromise)agendaPromise=(async()=>{
      const privacy=await import(pathToFileURL(join(root,'core-space','scripts','lib','privacy-policy.mjs')).href);
      const clockPath=join(root,'core-space/scripts/lib/day-clock.mjs');
      let timeZone=()=> 'Asia/Shanghai';
      if(existsSync(clockPath)){const runtime=createCoreRuntime(root),clock=await runtime.lib('day-clock.mjs');if(clock.BUSINESS_CLOCK_SCHEMA===1)timeZone=()=>{runtime.assertCurrent();return clock.clockSettings(root).timeZone;};}
      agendaService=createAgendaActions({root,runtimeDir,timeZone,runner:executeModel,profile:agendaProfile,beforeWrite:()=>assertAgendaWritable({root,runtimeDir,enabled:config.agenda?.writable!==false}),allowed:(text,tags)=>privacy.privacyDecision(privacy.loadPrivacyPolicy(root),text,tags)!=='block'});return agendaService;
    })().catch(error=>{agendaPromise=null;throw error;});
    return agendaService||agendaPromise;
  }
  async function agendaOperation(body){
    const run=async()=>{
      const service=await agenda();
      if(body.action==='agenda-list')return service.agenda.list({preview:body.preview===true,offset:body.offset||0,limit:body.limit||50});
      if(body.action==='agenda-confirm')return service.confirm({id:body.id,owner:'local',confirmed:body.confirmed===true});
      const host=body.hostProposal&&['codex','claude','codebuddy','trae','deepseek'].includes(body.hostModel);
      if(body.hostProposal&&!host)throw Object.assign(new Error("Invalid host model identifier; nothing applied"),{status:400});
      return service.propose({id:body.id,text:body.text,owner:'local',source:{messageId:body.id||'',at:body.at||new Date().toISOString(),interpretedBy:host?body.hostModel:'hub-model'},consent:body.consent===true,modelProfileVersion:body.modelProfileVersion,targetId:body.targetId,action:body.agendaAction,...(host?{interpret:async()=>JSON.stringify(body.hostProposal)}:{})});
    };
    const held=sync.gate.state();
    const owns=ownsTaskLease(held,body);
    if(owns&&!sync.gate.maintenance())return run();
    return sync.gate.run('task',run);
  }
  const receiptPath = join(runtimeDir, 'receipts.json'), receipts = readJson(receiptPath, {});
  const accessPath = join(runtimeDir, 'ipc-access.json'), access = readJson(accessPath, null) || { token: randomBytes(32).toString('base64url') }; writeJson(accessPath, access);
  let stopped = false, timer, cycling, connection = { status: 'offline' };
  async function clear(id) {
    if (!lifecycle) return { status: 'error', code: 'managed_install_required' };
    if (sync.gate.state()) return { status: 'deferred', code: 'instance_busy' };
    const result = await sync.request();
    if (result.status !== 'success' || (testMode === false && result.pushSuppressed)) return { status: 'deferred', code: 'preserve_unsynced' };
    if (result.pushSuppressed) return { status: 'deferred', code: 'test_unpushed_preserved' };
    const lease = sync.gate.acquire('sync');
    if (!lease) return { status: 'deferred', code: 'instance_busy' };
    sync.gate.pause(id, 'clear');
    lifecycle.freeze(id); stopped = true; clearInterval(timer); await sync.stop(); runner.close?.();
    await removeSubStartup(nodeId);
    return lifecycle.clear(id);
  }
  async function post(path, body) {
    const response = await fetch(origin + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, nodeId, installationId }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Main/sub communication incomplete");
    return response.json();
  }
  // The Main Hub owns the display name. Keep the assigned name in this device's own
  // configuration so it survives a restart and still describes itself while offline.
  function persistConfig() {
    if (!config.configFile) return;
    try {
      const { configFile, runner, ...rest } = config;
      writeFileSync(configFile, JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
    } catch { /* the name still applies in memory; the next poll retries */ }
  }
  async function cycle() {
    if (stopped || cycling) return cycling;
    cycling = (async () => {
      void sync.tick();
      try {
        const { operations, protocol, compatible, name: assignedName } = await post('/api/nodes/poll', { sync: sync.status().result, taskBusy: Boolean(sync.gate.state()), capabilities: { protocolMin:HUB_PROTOCOL.min, protocolMax:HUB_PROTOCOL.max, releaseId: process.env.AIPA_HUB_RELEASE_ID || 'development', deploymentGeneration: Number(process.env.AIPA_HUB_DEPLOYMENT_GENERATION || 0), runtimeSchema:HUB_RUNTIME_SCHEMA, updaterVersion: process.send ? 1 : null, platform: process.platform, arch: process.arch, testMode, tasks: taskWorker.status().enabled } });
        if (compatible === false || protocol !== undefined && (protocol<HUB_PROTOCOL.min||protocol>HUB_PROTOCOL.max)) throw new Error("Main/sub protocol incompatible");
        connection = { status: 'online', lastSeen: new Date().toISOString() };
        if (assignedName && assignedName !== config.name) { config.name = assignedName; persistConfig(); }
        for (const op of operations) {
          if (op.installationId !== installationId) continue;
          let result = receipts[op.id];
          if (!result) {
            result = op.kind === 'sync' ? await sync.request() : await clear(op.id);
            if (result.status !== 'deferred' && result.code !== 'cleared') { receipts[op.id] = result; writeJson(receiptPath, receipts); }
          }
          await post('/api/nodes/ack', { id: op.id, ...result, status: result.status === 'blocked' ? 'error' : result.status });
          if (result.code === 'cleared') { removeConfig(config); setImmediate(() => { server.close(); process.send?.({ type: 'hub-cleared', installationId }); }); break; }
        }
      } catch { connection = { ...connection, status: 'offline' }; if (lifecycle?.frozen()) setTimeout(() => { void createClearedRecovery(config, lifecycle).then(r => r.listen()).then(() => server.close()); }, 5000).unref(); }
    })().finally(() => { cycling = null; });
    return cycling;
  }
  const status = () => ({ role: 'sub', nodeId, name: config.name || nodeId, testMode, releaseId: process.env.AIPA_HUB_RELEASE_ID || 'development', deploymentGeneration: Number(process.env.AIPA_HUB_DEPLOYMENT_GENERATION || 0), protocol:HUB_PROTOCOL.max, runtimeSchema:HUB_RUNTIME_SCHEMA,support:hubSupport(),coreDiagnostics:'not-checked', maintenance: sync.gate.maintenance(), connection, engine, engineAvailable: runner.available !== false, model:agendaProfile(),agenda:true,sync: sync.status(), task: sync.gate.state(), tasks: taskWorker.status() });
  const server = createServer(socket => {
    socket.setTimeout(5000, () => socket.destroy()); let raw = '';
    socket.on('data', async bytes => {
      raw += bytes.toString('utf8'); if (raw.length > 16_000) return socket.destroy();
      if (!raw.includes('\n')) return;
      socket.pause(); socket.setTimeout(300_000, () => socket.destroy());
      try {
        const body = JSON.parse(raw.slice(0, raw.indexOf('\n')));
        if (typeof body.token !== 'string' || !timingSafeEqual(digest(body.token), digest(access.token))) throw new Error("Invalid local credentials");
        let result;
        if (stopped && body.action !== 'status') throw new Error("Sub Hub frozen");
        if (body.action === 'status') result = status();
        else if(['agenda-list','agenda-propose','agenda-confirm'].includes(body.action))result=await agendaOperation(body);
        else if (body.action === 'stop') { result = { status: 'stopping' }; setImmediate(() => { void close(); }); }
        else if (body.action === 'engine-check') { const answer = await executeModel("Reply only HUB_ENGINE_OK. Do not call tools or access files."); result = { engine, ok: answer.includes('HUB_ENGINE_OK') }; }
        else if (body.action === 'sync') result = await sync.request();
        else if (body.action === 'task-wake') { void sync.request(); result = { status: 'accepted' }; }
        else if (body.action === 'task-start') result = sync.gate.acquire('task', body.pid);
        else if (body.action === 'task-end') { sync.gate.release(body.lockToken); result = await sync.request(); }
        else if (body.action === 'clear') { result = await clear('local-clear'); if (result.code === 'cleared') { removeConfig(config); setImmediate(() => { server.close(); process.send?.({ type: 'hub-cleared', installationId }); }); } }
        else throw new Error("Invalid local action");
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch(error) { socket.end(JSON.stringify({ ok: false, error: error.status?error.message:"Local action incomplete" }) + '\n'); }
    });
    socket.on('error', () => {});
  });
  async function close() { stopped = true; clearInterval(timer); taskWorker.stop(); await cycling; await sync.stop(); await modelQueue;runner.close?.(); if (server.listening) await new Promise(r => server.close(r)); }
  return { status, cycle, sync, taskWorker, async listen() {
    const path = ipcPath(runtimeDir);
    if (filesystemSocket(path) && existsSync(path)) throw new Error("IPC path already exists. Verify the previous process first.");
    await new Promise((yes, no) => { server.once('error', no); server.listen(path, yes); });
    if (filesystemSocket(path)) chmodSync(path, 0o600);
    timer = setInterval(() => { void cycle(); }, 5000); timer.unref(); void cycle(); taskWorker.start(); return status();
  }, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--config'); if (at < 0) throw new Error("--config <configuration-file> is required");
    const configFile = resolve(process.argv[at + 1]), config = { ...readJson(configFile, null), configFile }, action = process.argv[at + 2] || 'start';
    if (action !== 'start') console.log(JSON.stringify(await subCommand(config.runtimeDir, action)));
    else {
      const hub = await createSubHub(config); await hub.listen(); console.log(JSON.stringify({ status: 'ready', role: 'sub', nodeId: config.nodeId, testMode: config.testMode !== false, pid: process.pid }));
      bindManagedRuntime({ role: 'sub', root: config.root, testMode: config.testMode !== false, idle: () => !hub.status().task, close: () => hub.close() });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void hub.close().then(() => process.exit(0)); });
    }
  } catch { console.error("Sub Hub not running or action failed. Check configuration, IPC, and runtime status."); process.exitCode = 1; }
}

function removeConfig(config) {
  if (config.configFile && config.managedBase && resolve(config.configFile) === join(realpathSync(config.managedBase), 'sub-config.json') && existsSync(config.configFile)) unlinkSync(config.configFile);
}
async function createClearedRecovery(config, lifecycle) {
  let timer, busy = false;
  const origin = mainURL(config.mainUrl);
  async function retry() {
    if (busy) return; busy = true;
    try {
      const tombstone = lifecycle.tombstone();
      await removeSubStartup(config.nodeId);
      lifecycle.clear(tombstone.operationId);
      if (tombstone.operationId !== 'local-clear') {
        const r = await fetch(origin + '/api/nodes/ack', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ nodeId: config.nodeId, installationId: config.installationId, id: tombstone.operationId, status: 'success', code: 'cleared' }), signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error("Clear receipt awaiting retry");
      }
      removeConfig(config); clearInterval(timer); return true;
    } catch { return false; } finally { busy = false; }
  }
  return { status: () => ({ role: 'sub', nodeId: config.nodeId, phase: 'cleared-recovery', testMode: config.testMode !== false }),
    async listen() { if (!await retry()) timer = setInterval(() => { void retry(); }, 15_000); },
    async close() { clearInterval(timer); } };
}
