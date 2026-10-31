import { createServer } from 'node:http';
import { readFileSync, mkdirSync, realpathSync, openSync, writeFileSync, closeSync, unlinkSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createStore, readJson, writeJson, assertId, titleForTurn, displayChatTitle } from './lib/storage.mjs';
import { createAipaAdapter } from './lib/aipa.mjs';
import { contextBudgetBytes as validateContextBudget } from './lib/context-budget.mjs';
import { taskResult } from './lib/task-result.mjs';
import { createCodexRunner } from './lib/codex.mjs';
import { createClaudeRunner } from './lib/claude.mjs';
import { createHarnessRunner } from './lib/harness.mjs';
import { createScheduler } from './lib/scheduler.mjs';
import { createRepoSync } from './lib/repo-sync.mjs';
import {readResponseLanguage} from './lib/language-preference.mjs';
import { createBriefingService, validateBriefingSettings } from './lib/briefings.mjs';
import { createWebSearch, resolveWebCitations } from './lib/web-search.mjs';
import { createPushService } from './lib/pushes.mjs';
import {createAgendaActions,mayManageAgenda} from './lib/agenda-actions.mjs';
import {agendaWriteState,assertAgendaWritable} from './lib/agenda-capability.mjs';
import {ownsTaskLease} from './lib/task-gate.mjs';
import {createDailyDigest} from './lib/daily-digest.mjs';
import { createChatVisibility } from './lib/chat-visibility.mjs';
import { localDay, timeZone as validateTimeZone } from './lib/time-zone.mjs';
import { createNodeControl } from './lib/node-control.mjs';
import { createTaskQueue } from './lib/task-queue.mjs';
import { createInstanceSync } from './lib/instance-sync.mjs';
import { createMainReports, logicalDay, addDay } from './lib/main-reports.mjs';
import {createConflictReview} from './lib/conflict-review.mjs';
import { createEventOutbox } from './lib/event-outbox.mjs';
import {createMemoryReceipts,receiptIntent,RECEIPT_WARNING} from './lib/memory-receipts.mjs';
import { createMainDistillation } from './lib/main-distillation.mjs';
import { handleUpdateRoute } from './lib/update-routes.mjs';
import { createCaptureInbox } from './lib/capture-inbox.mjs';
import { turnOptions, sameTurnRequest,projectId } from './lib/turn-request.mjs';
import { modelProfile, deepseekModelCredential } from './lib/model-profile.mjs';
import {createDeepSeekVision} from './lib/deepseek-vision.mjs';
import {runImageWeb} from './lib/image-web.mjs';
import {createAttachments, attachmentIds, attachmentEventTextV1} from './lib/attachments.mjs';
import { generateWebQuery, validateWebQuery } from './lib/web-query.mjs';
import { createActivityLog, describeTask } from './lib/activity-log.mjs';
import { createRuntimeStatus } from './lib/runtime-status.mjs';
import { createSiteSettings, renderSiteFooter } from './lib/site-settings.mjs';
import { LANGUAGES } from './public/languages.js';
import { localeAssetEntries } from './lib/ui-locale-validation.mjs';
import {supportDiagnostics,contextDiagnostic,HUB_PROTOCOL,HUB_RUNTIME_SCHEMA} from './lib/support-contract.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const executeFile = promisify(execFile);
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const textOf = value => {
  if (typeof value !== 'string' || !value.trim()) throw problem("Enter some content first");
  if (value.length > 8000) throw problem("Limit each entry to 8000 characters");
  return value.trim();
};
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/attachments.js', ['attachments.js', 'text/javascript; charset=utf-8']],
  ['/agenda.js', ['agenda.js', 'text/javascript; charset=utf-8']],
  ['/agenda.css', ['agenda.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/languages.js', ['languages.js', 'text/javascript; charset=utf-8']],
  ...localeAssetEntries(LANGUAGES),
  ['/json-api.js', ['json-api.js', 'text/javascript; charset=utf-8']],
  ['/navigation.js', ['navigation.js', 'text/javascript; charset=utf-8']],
  ['/task-list.js', ['task-list.js', 'text/javascript; charset=utf-8']],
  ['/updates.js', ['updates.js', 'text/javascript; charset=utf-8']],
  ['/status.js', ['status.js', 'text/javascript; charset=utf-8']],
  ['/conflict-review.js', ['conflict-review.js', 'text/javascript; charset=utf-8']],
  ['/status.css', ['status.css', 'text/css; charset=utf-8']],
  ['/navigation.css', ['navigation.css', 'text/css; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/vendor/marked.esm.js', ['vendor/marked.esm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/purify.es.mjs', ['vendor/purify.es.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/pushes.css', ['pushes.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
]);

function lockRuntime(runtimeDir) {
  const path = join(runtimeDir, 'host.lock');
  const identity = randomUUID();
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readJson(path, null);
    if (!previous || !Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error("Hub runtime lock is damaged. Check the local runtime directory.");
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`Hub is already running for this instance (PID ${previous.pid})`);
    unlinkSync(path); fd = openSync(path, 'wx', 0o600);
  }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, identity }), 'utf8'); } finally { closeSync(fd); }
  const release = () => {
    try { if (readJson(path, null)?.identity === identity) unlinkSync(path); } catch {  }
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}

function normalizePublicOrigins(values) {
  if (!Array.isArray(values) || values.length > 8) throw new Error("publicOrigins must be an array of up to 8 HTTPS origins");
  return [...new Set(values.map(value => {
    let url;
    try { if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error(); url = new URL(value); }
    catch { throw new Error("Public entry requires a complete HTTPS URL"); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        url.hostname.includes('*') || ['localhost', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname) || url.hostname.endsWith('.localhost')) {
      throw new Error("Public entry requires an HTTPS domain or IP with optional port, without paths, wildcards, or local addresses");
    }
    return url.origin;
  }))];
}

export async function createHub({ root, runtimeDir, adapter, runner, hostname = '', port = 4317, publicOrigins = [], publicPort, advertisedOrigin = '', site = {}, engine = 'codex', tasks = {}, briefing = {}, agenda:agendaDefaults = {}, newsFetcher, webFetcher, visionFetcher, testMode = false, main = {}, contextBudgetBytes } = {}) {
  contextBudgetBytes = validateContextBudget(contextBudgetBytes);
  if (!root) throw new Error("--root <personal-instance-directory> is required");
  if (!['codex', 'claude', 'harness'].includes(engine)) throw new Error("engine must be codex or claude");
  publicOrigins = normalizePublicOrigins(publicOrigins);
  advertisedOrigin = advertisedOrigin ? normalizePublicOrigins([advertisedOrigin])[0] : '';
  const publicEnabled = publicPort !== undefined;
  if (publicEnabled !== Boolean(publicOrigins.length)) throw new Error("Public access requires both publicOrigins and publicPort");
  if (publicEnabled && (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535 || (publicPort !== 0 && publicPort === port))) {
    throw new Error("publicPort must be a valid port different from the management port");
  }
  const publicOriginSet = new Set(publicOrigins);
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks) || Object.keys(tasks).some(id => id !== 'repo-sync')) throw new Error("Invalid scheduled task configuration");
  const syncOptions = { enabled: false, intervalMinutes: 30, mode: 'pull', ...tasks['repo-sync'] };
  if (typeof syncOptions.enabled !== 'boolean' || !Number.isInteger(syncOptions.intervalMinutes) || syncOptions.intervalMinutes < 5 || syncOptions.intervalMinutes > 10080) throw new Error("Repository synchronization interval must be 5 to 10080 minutes");
  if (!['pull', 'bidirectional'].includes(syncOptions.mode)) throw new Error("Repository synchronization mode must be pull or bidirectional");
  let engineName = engine === 'harness' ? 'DeepSeek Harness CLI' : engine === 'claude' ? 'Claude Code' : 'Codex CLI';
  if (engine === 'claude') {
    try {
      if (new URL(process.env.ANTHROPIC_BASE_URL || '').hostname === 'api.deepseek.com') engineName = "DeepSeek (via Claude Code)";
    } catch {  }
  }
  root = realpathSync(resolve(root));
  if (testMode === false && existsSync(join(root, '.git/aipa-hub-no-push.json'))) throw new Error("A permanent test instance cannot start as a production instance");
  runtimeDir ||= join(HERE, '.aipa-hub', digest(root).slice(0, 12));
  mkdirSync(runtimeDir, { recursive: true });
  const release = lockRuntime(runtimeDir);
  try {
  const store = createStore(root);
  const siteSettings = createSiteSettings(runtimeDir, site);
  const attachments = createAttachments({root,runtimeDir,store});
  if(main.enabled && !attachments.available) throw new Error("Image dependency sharp@0.35.5 unavailable. Install main Hub dependencies from the lockfile first.");
  const chatVisibility = createChatVisibility(runtimeDir);
  const authPath = join(runtimeDir, 'access.json');
  const auth = readJson(authPath, null) || { pairingCode: randomBytes(18).toString('base64url'), sessions: [] };
  writeJson(authPath, auth);
  const injectedAdapter = Boolean(adapter);
  adapter ||= await createAipaAdapter(store.root, { contextBudgetBytes });
  const coreStatus = () => adapter.coreRuntimeStatus?.() || { status: 'ready', code: 'injected' };
  let lastContextDiagnostic=null;
  const diagnostics=core=>supportDiagnostics({role:main.enabled?'main':'legacy',core:core||coreStatus(),coreSupport:adapter.coreSupport,coreVersion:adapter.version,context:lastContextDiagnostic,engine,engineAvailable:runner?.available!==false});
  function requireCurrentCore() {
    const value = coreStatus();
    if (value.status !== 'ready') throw Object.assign(problem(value.summary, 503), { code: value.code, publicMessage: value.summary });
  }
  runner ||= (engine === 'harness' ? createHarnessRunner : engine === 'claude' ? createClaudeRunner : createCodexRunner)({ workDir: join(runtimeDir, 'engine-work') });
  const responseLanguage=()=>adapter.responseLanguage?.()??readResponseLanguage(root);
  let lastClockSettings=null;
  const sharedClock=()=>{const clock=adapter.clockFor?.({dayStartHour:main.dayStartHour,timeZone:main.timeZone})||adapter.clock||null;lastClockSettings=clock?.settings||lastClockSettings;return clock;};
  const sharedTimeZone=()=>{
    try{return validateTimeZone(sharedClock()?.settings.timeZone||main.timeZone||'Asia/Shanghai');}
    catch(error){if(error.code!=='core_restart_required')throw error;return validateTimeZone(lastClockSettings?.timeZone||main.timeZone||'Asia/Shanghai');}
  };
  sharedTimeZone();
  const vision=createDeepSeekVision({engine,fetcher:visionFetcher,responseLanguage});
  const nodes = main.enabled ? createNodeControl({ runtimeDir }) : null;
  const taskQueue = main.enabled ? createTaskQueue({ runtimeDir }) : null;
  let dailyDigest=null;
  const instanceSync = main.enabled ? createInstanceSync({ root, runtimeDir, testMode, afterUpdate: async () => {
    if (!injectedAdapter) adapter = await createAipaAdapter(root, { contextBudgetBytes });
    refreshAgendaDigest();
  } }) : null;
  const outbox = createEventOutbox(runtimeDir, (...args) => adapter.record(...args));
  const memoryReceipts=createMemoryReceipts({store,deliver:(...args)=>{requireCurrentCore();if(!adapter.recordMemoryUse)throw Error("This Core does not support memory usage receipts");return adapter.recordMemoryUse(...args);}});
  for (const chat of store.listChats()) for (const turn of chat.turns) {
    outbox.enqueue('user_message', turn.input, chat.id, `hub-user-${turn.id}`, turn.created,turn.project??chat.project??'');
    if(turn.attachmentIds?.length)outbox.enqueue('tool_result',attachmentEventTextV1('',turn.attachmentIds,turn.analyzeImages),chat.id,`hub-attachments-${turn.id}`,turn.created,turn.project??chat.project??'');
    if (turn.answer) outbox.enqueue('assistant_message', turn.answer, chat.id, `hub-answer-${turn.id}`, turn.completed || turn.updated || turn.created,turn.project??chat.project??'');
  }
  for (const note of store.listNotes()) {
    outbox.enqueue('user_message', note.text, 'notes', `hub-note-${note.id}`, note.created || note.updated);
    if(note.attachmentIds?.length)outbox.enqueue('tool_result',attachmentEventTextV1('',note.attachmentIds),'notes',`hub-note-attachments-${note.id}`,note.created||note.updated);
  }
  let mainLease, mainUsers = 0;
  function enterMain() {
    requireCurrentCore();
    if (!instanceSync) return;
    if (!mainUsers) { mainLease = instanceSync.gate.acquire('main'); if (!mainLease) throw problem("Personal instance task or synchronization active. Retry later.", 503); }
    mainUsers++;
  }
  function leaveMain() { if (instanceSync && --mainUsers === 0) { instanceSync.gate.release(mainLease.token); mainLease = null; } }
  if (hostname && !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname)) throw new Error("--hostname must be this device Tailscale .ts.net domain");
  hostname = hostname.toLowerCase();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(hostname ? [hostname] : [])]);
  const attempts = new Map();
  const queue = [];
  let busy = false, closing = false, draining = Promise.resolve(), maintenance = false, activeRequests = 0, wakeTimer;
  let modelQueue = Promise.resolve();
  const imageWebControllers=new Set();
  const currentModelProfile = () => modelProfile({engine,runner});
  function executeModel(prompt, { expectedProfileVersion } = {}) {
    const result = modelQueue.then(() => {
      if (closing) throw problem("Hub is stopping", 503);
      requireCurrentCore();
      if (expectedProfileVersion && expectedProfileVersion !== currentModelProfile().version) throw problem("Model configuration changed. Reconfirm this turn information scope.",428);
      return runner(prompt);
    });
    modelQueue = result.catch(() => {}); return result;
  }
  const agendaWriteOptions={root,runtimeDir,enabled:agendaDefaults.writable!==false};
  const agendaActions=createAgendaActions({root,runtimeDir,runner:executeModel,responseLanguage,timeZone:sharedTimeZone,allowed:(value,tags)=>adapter.allowedContent?.(value,tags)!==false,profile:currentModelProfile,beforeWrite:()=>assertAgendaWritable(agendaWriteOptions),
    audit:(action,id)=>outbox.enqueue('tool_result',`Agenda operation ${action} saved; see the personal instance agenda audit for details`,'agenda',`hub-agenda-${id}`)});
  function executeVision(turn) {
    const result=modelQueue.then(()=>{
      if(closing)throw problem("Hub is stopping; images saved",503);
      if(adapter.allowedContent?.(turn.input)===false)throw problem("Privacy rules blocked this turn text; no images sent externally",428);
      return vision.run({text:turn.input,images:turn.attachmentIds.map(id=>attachments.get(id,'').bytes),consent:turn.visionConsent,expectedProfileVersion:turn.visionProfileVersion});
    });
    modelQueue=result.catch(()=>{});return result;
  }
  function executeVisionText(prompt,turn){
    const result=modelQueue.then(()=>{
      if(closing)throw problem("Hub is stopping; completed image analysis steps preserved",503);
      if(adapter.allowedContent?.(prompt)===false)throw problem("Privacy rules blocked derived materials; not sent to the model",428);
      return vision.runText({text:prompt,consent:turn.visionConsent&&turn.imageWebConsent,expectedProfileVersion:turn.visionProfileVersion});
    });modelQueue=result.catch(()=>{});return result;
  }
  async function withRepository(operation) {
    if (closing || maintenance || instanceSync?.gate.maintenance()) throw problem("Instance synchronization or maintenance active. Keep your input and retry later.", 503);
    enterMain();
    activeRequests++;
    try { return await operation(); } finally { activeRequests--; leaveMain(); }
  }
  async function withAgendaRepository(req,localAccess,operation){
    requireCurrentCore();
    const leaseToken=req.headers['x-aipa-task-lease'],sessionId=req.headers['x-aipa-task-session'];
    if(leaseToken===undefined&&sessionId===undefined)return withRepository(operation);
    if(!localAccess)throw problem("Task lease is allowed only for the local agenda interface",403);
    if(closing||maintenance||instanceSync?.gate.maintenance())throw problem("Instance synchronization or maintenance active. Keep your input and retry later.",503);
    if(!instanceSync||!ownsTaskLease(instanceSync.gate.state(),{leaseToken,sessionId}))throw problem("Agenda task lease ownership mismatch",409);
    activeRequests++;
    try{return await operation();}finally{activeRequests--;}
  }
  function saveAuth() { auth.sessions = auth.sessions.filter(s => s.expires > Date.now()).slice(-30); writeJson(authPath, auth); }
  function login(res, secure) {
    const key = randomBytes(32).toString('base64url');
    auth.sessions.push({ hash: digest(key), expires: Date.now() + 30 * 86400_000 }); saveAuth();
    res.setHeader('Set-Cookie', `aipa_hub=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
  }
  function authenticated(req) {
    const key = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('aipa_hub='))?.slice(9);
    return Boolean(key && auth.sessions.some(s => s.expires > Date.now() && equal(s.hash, digest(key))));
  }
  function send(res, value, status = 200) {
    if (res.hubOperation) outbox.enqueue('tool_result', `Web action result: ${res.hubOperation.path} HTTP ${status} ${status >= 400 ? "Failed" : status === 202 ? "Accepted; awaiting execution receipt" : "Completed"}`, 'operations', `hub-web-result-${res.hubOperation.id}-${status}`);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  }
  async function bodyOf(req) {
    if (req.hubBody !== undefined) return req.hubBody;
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw problem("JSON request required", 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 40_000) throw problem("Request too large", 413); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); req.hubBody = body; return body; } catch { throw problem("Invalid request format"); }
  }
  function requireConsent(body) {
    const ids=attachmentIds(body.attachmentIds);
    if(body.analyzeImages===true&&!ids.length)throw problem("Image analysis requires at least one image");
    if(ids.length) {
      if(body.allowWeb===true && (body.analyzeImages!==true || body.imageWebConsent!==true))throw problem("Explicitly select and consent to image plus web processing: images go to DeepSeek; necessary public queries go to the current search provider",428);
      if(body.allowWeb===true && body.searchQuery!==undefined && (typeof body.searchQuery!=='string'||body.searchQuery.trim()))throw problem("Image plus web mode generates public queries automatically; specify a topic in your question");
      if(body.analyzeImages===true){
        const profile=vision.profile();
        if(!profile.available)throw problem(profile.reason,503);
        if(body.visionConsent!==true)throw problem("Explicitly allow sending this turn text and images to DeepSeek for analysis",428);
        if(body.visionProfileVersion!==profile.version)throw problem("Image analysis configuration changed. Refresh and renew consent.",428);
      }
      return;
    }

    if (body.engine !== engine) throw problem("Conversation engine changed. Refresh and reconfirm the information scope.", 428);
    if (adapter.requiresConsent() && body.consent !== true) throw problem(`First allow this conversation information to be processed by ${engineName}; alternatively save it only in Notes`, 428);
    if (body.modelProfileVersion && body.modelProfileVersion !== currentModelProfile().version) throw problem("Model configuration changed. Refresh and reconfirm the information scope.",428);
  }
  const acceptedOptions = (body,project='') => {const options={...turnOptions({...body,project:body.project===undefined?project:body.project}),modelProfileVersion:body.modelProfileVersion||currentModelProfile().version};if(options.project&&!adapter.projectScope)throw problem("This Core does not support project context. Upgrade and restart Hub.",409);return options;};
  function requireWebOptions(options) {
    if (!options.allowWeb) return;
    if ([...options.searchQuery].length > 128) throw problem('Manual queries may contain up to 128 characters. Leave blank to generate one automatically.', 400);
    if (options.webProfileVersion !== webSearch.metadata().settings.revision) throw problem("Search settings changed. Refresh and reconfirm the web scope.", 428);
    if(options.analyzeImages && !webSearch.metadata().ready)throw problem("Search service is not ready; image-only analysis is available",409);
  }
  function schedule(chatId, turnId) {
    queue.push([chatId, turnId]);
    if (!busy) draining = drain();
  }
  const captureInbox = createCaptureInbox({ runtimeDir, store, schedule, attachments, record: (...args) => outbox.record(...args) });
  attachments.gc();
  function updateTurn(chatId, turnId, update) {
    const chat = store.readChat(chatId);
    if (!chat) return;
    const turn = chat.turns.find(t => t.id === turnId);
    if (turn) Object.assign(turn, update);
    chat.updated = new Date().toISOString(); store.saveChat(chat);
  }
  async function drain() {
    busy = true;
    while (queue.length && !closing) {
      const [chatId, turnId] = queue.shift();
      const chat = store.readChat(chatId);
      const turn = chat?.turns.find(t => t.id === turnId);
      if (!turn || turn.status !== 'queued') continue;
      let entered = false;
      try {
        enterMain(); entered = true;
        const warnings = [];
        if (!turn.analyzeImages && turn.modelProfileVersion && turn.modelProfileVersion !== currentModelProfile().version) throw problem("Model configuration changed; nothing sent externally. Reconfirm and retry.",428);
        updateTurn(chatId, turnId, { status: 'running' });
        if (adapter.allowedContent?.(turn.input) === false) throw new Error("Privacy rules blocked this input. It is saved locally and was not sent to a model or web search; use Notes to capture it.");
        await adapter.assertContextReady?.({project:turn.project??chat.project??''});
        lastContextDiagnostic=adapter.assertContextReady?{status:'ready'}:null;
        if (!chat.aipaStarted) {
          const warning = await adapter.begin(chat); if (warning) warnings.push(warning);
          const current = store.readChat(chatId); current.aipaStarted = true; store.saveChat(current);
        }
        const captureWarning = await outbox.record('user_message', turn.input, chatId, `hub-user-${turn.id}`,turn.created,turn.project??chat.project??'');
        if(turn.attachmentIds?.length)await outbox.record('tool_result',attachmentEventTextV1('',turn.attachmentIds,turn.analyzeImages),chatId,`hub-attachments-${turn.id}`,turn.created,turn.project??chat.project??'');
        if (captureWarning) warnings.push(captureWarning);
        const previousAgenda=chat.turns.filter(t=>t.id!==turn.id&&t.status==='completed').at(-1)?.agendaOperation;
        const confirmingAgenda=previousAgenda?.status==='pending'&&/^(\u786e\u8ba4|\u786e\u5b9a|\u662f\u7684|\u53ef\u4ee5|\u597d\u7684|\u6267\u884c|\u6ca1\u95ee\u9898)[。！!\s]*$/.test(turn.input.trim());
        if((dailyDigest?.settings().enabled||agendaDefaults.actions===true)&&!turn.attachmentIds?.length&&!turn.allowWeb&&(mayManageAgenda(turn.input)||confirmingAgenda)){
          const operation=confirmingAgenda?agendaActions.confirm({id:previousAgenda.operationId,owner:'web',confirmed:true}):await agendaActions.propose({id:turn.id,text:turn.input,owner:'web',source:{chatId,messageId:turn.id,at:turn.created},
            history:chat.turns.filter(t=>t.id!==turn.id&&t.status==='completed').slice(-3).flatMap(t=>[{role:'user',text:t.input},{role:'assistant',text:t.answer}]),consent:turn.consent,modelProfileVersion:turn.modelProfileVersion||currentModelProfile().version});
          if(operation.status!=='no_action'){
            if(confirmingAgenda&&operation.source?.messageId)updateTurn(chatId,operation.source.messageId,{agendaOperation:operation});
            if(operation.status==='applied')refreshAgendaDigest();
            updateTurn(chatId,turnId,{status:'completed',answer:operation.message,agendaOperation:operation,recall:null,sources:[],model:currentModelProfile(),completed:new Date().toISOString()});
            await outbox.record('assistant_message',operation.message,chatId,`hub-answer-${turn.id}`,undefined,turn.project??chat.project??'');continue;
          }
        }
        if(turn.analyzeImages){
          let result;
          if(turn.allowWeb){
            const controller=new AbortController();imageWebControllers.add(controller);
            try{result=await runImageWeb({turn,identify:()=>executeVision(turn),runText:prompt=>executeVisionText(prompt,turn),search:(query,options)=>webSearch.run(query,{...options,signal:controller.signal}),webRevision:()=>webSearch.settings().revision,allowed:value=>adapter.allowedContent?.(value)!==false,save:patch=>updateTurn(chatId,turnId,patch),guard:()=>{if(closing||controller.signal.aborted)throw problem("This turn was interrupted; completed steps preserved. Retry explicitly.",503);if(turn.visionProfileVersion!==vision.profile().version)throw problem("Image analysis configuration changed. Refresh and renew consent.",428);},audit:(stage,status)=>outbox.record('tool_result',`Image and web step ${stage}: ${status}`,chatId,`hub-imageweb-${turn.id}-${turn.attempts}-${stage}-${status}`)});}
            finally{imageWebControllers.delete(controller);}
          }else result=await executeVision(turn);
          updateTurn(chatId,turnId,{status:'completed',processing:turn.allowWeb?'vision-web':'vision',answer:result.answer,model:result.model,warnings:[...warnings,...result.warnings],...(turn.allowWeb?{sources:result.sources,webSources:result.sources,webQuery:result.webQuery}:{}),completed:new Date().toISOString()});
          const warning=await outbox.record('assistant_message',result.answer,chatId,`hub-answer-${turn.id}`,undefined,turn.project??chat.project??'');
          if(warning)updateTurn(chatId,turnId,{warnings:[...warnings,...result.warnings,warning]});
          continue;
        }
        let web = null;
        if (turn.allowWeb === true) {
          try {
            if (!turn.webProfileVersion || turn.webProfileVersion !== webSearch.settings().revision) throw new Error("Search configuration changed. Refresh and reconfirm web access.");
            const query = turn.searchQuery ? validateWebQuery(turn.searchQuery) : await generateWebQuery(turn.input, prompt => executeModel(prompt,{expectedProfileVersion:turn.modelProfileVersion}), value => adapter.allowedContent?.(value) !== false);
            updateTurn(chatId, turnId, { webQuery:{mode:turn.searchQuery?'manual':'automatic',query,status:'searching'} });
            web = await webSearch.run(query, { expectedRevision: turn.webProfileVersion });
            updateTurn(chatId, turnId, { webQuery:{mode:turn.searchQuery?'manual':'automatic',query,status:'completed',resultCount:web.results.length} });
            activity.append({ kind: 'system', action: 'web-search', status: 'success', summary: `Web search returned ${web.results.length} results (${[...new Set(web.results.map(row => row.domain))].slice(0, 3).join(', ')})` });
          } catch (error) {
            updateTurn(chatId, turnId, { webQuery:{mode:turn.searchQuery?'manual':'automatic',status:'failed'} });
            warnings.push(`Web search incomplete: ${error.message}; this turn uses local materials.`);
            activity.append({ kind: 'system', action: 'web-search', status: 'failed', summary: `Web search incomplete: ${String(error.message).slice(0, 80)}` });
          }
        }
        const context = await adapter.context(chat, turn, store.listNotes(), { web });
        const intent=receiptIntent(chatId,turn.id,context);
        if(!intent&&context.memoryUse?.length)warnings.push("This Core lacks body-version receipts; memory usage statistics not registered");
        updateTurn(chatId, turnId, { sources: context.sources, omitted: context.omitted, recall: context.recall, warnings, webSources: context.webSources || [],memoryReceipt:intent });
        const executionProfile = currentModelProfile();
        const imageNotice=chat.turns.some(t=>t.analyzeImages&&t.status==='completed')?"No image pixels are provided in this turn. Historical image analysis is labeled reference material, not evidence that you saw the original image or that the user confirmed the result.\n":chat.turns.some(t=>t.attachmentIds?.length)?"Note: conversation images are archived only. They were not provided to you or analyzed. Do not claim to see their contents.\n":'';
        const rawAnswer = await executeModel(imageNotice + context.prompt,{expectedProfileVersion:turn.modelProfileVersion});
        if (typeof rawAnswer !== 'string' || !rawAnswer.trim()) throw new Error("Model returned no answer; input saved");
        const answer = resolveWebCitations(rawAnswer, context.sources);
        updateTurn(chatId, turnId, { status: 'completed', answer, model: executionProfile, completed: new Date().toISOString(),warnings:intent?[...warnings,RECEIPT_WARNING]:warnings,memoryReceipt:intent?{...intent,status:'pending'}:null });
        await memoryReceipts.flush();
        const answerWarning = await outbox.record('assistant_message', answer, chatId, `hub-answer-${turn.id}`,undefined,turn.project??chat.project??'');
        if (answerWarning) updateTurn(chatId, turnId, { warnings: [...(store.readChat(chatId).turns.find(t=>t.id===turnId).warnings||[]), answerWarning] });
      } catch (error) {
        if(contextDiagnostic(error).status==='blocked')lastContextDiagnostic={code:error.code};
        updateTurn(chatId, turnId, { status: closing ? 'interrupted' : 'error', error: error.message || 'This turn did not complete. Your input is saved.',...(error.code?{errorCode:error.code}:{}),...(error.contextIssues?{contextIssues:error.contextIssues}:{}) });
      } finally { if (entered) leaveMain(); }
    }
    busy = false;
  }
  const scheduler = createScheduler({ path: join(runtimeDir, 'tasks.json'), timeZone:sharedTimeZone });
  const startedAt = new Date().toISOString();
  const activity = createActivityLog({ runtimeDir });
  const webSearch = createWebSearch({ runtimeDir, timeZone:sharedTimeZone, fetcher: webFetcher, modelCredential:()=>deepseekModelCredential({engine}), allowed: material => adapter.allowedContent?.(material) !== false });
  const withActivity = spec => ({
    ...spec,
    run: async context => {
      const manual = context?.reason === 'manual', label = spec.label || spec.id, begun = Date.now(), runId = randomUUID().slice(0, 8), quiet = spec.quiet === true;
      if (!quiet) activity.append({ kind: 'task', action: spec.id, status: 'started', summary: `${manual ? "Manually triggered" : "Scheduled execution"}${label}`, detail: { reason: manual ? 'manual' : 'scheduled', runId } });
      try {
        const core = coreStatus();
        const result = taskResult(spec.id !== 'repo-sync' && core.status !== 'ready'
          ? { status: 'blocked', code: core.code, summary: core.summary }
          : await spec.run(context));
        const status = result.status;
        const silent = result?.silent === true || (quiet && status === 'deferred');
        if (!silent) activity.append({ kind: 'task', action: spec.id, status, summary: describeTask(spec.id, label, result, { manual }),
          detail: { runId, changedFiles: result?.changedFiles, pushed: result?.pushed, pushSuppressed: result?.pushSuppressed, commit: result?.commit, code: result?.code, durationMs: Date.now() - begun } });
        return result;
      } catch (error) {
        activity.append({ kind: 'task', action: spec.id, status: 'failed', summary: `${label}Execution failed: ${error?.publicMessage || "Check Hub runtime status"}`, detail: { runId, durationMs: Date.now() - begun } });
        throw error;
      }
    },
  });
  const registerTask = spec => scheduler.register(withActivity(spec));
  function refreshAgendaDigest(day=localDay(Date.now(),sharedTimeZone()),options){
    if(!dailyDigest?.settings().enabled)return null;
    try{return dailyDigest.snapshot(day,options);}catch{activity.append({kind:'system',action:'agenda-refresh',status:'failed',summary:"Agenda briefing refresh incomplete; original record preserved"});return null;}
  }
  const publicEntryFile = join(runtimeDir, 'public-entry.json');
  const readPublicEntry = () => {
    let entry;
    try { entry = readJson(publicEntryFile, null); } catch { return null; }
    if (!entry?.url) return null;
    let check = null;
    try { check = readJson(join(runtimeDir, 'entry-check.json'), null); } catch { check = null; }
    return { url: String(entry.url).slice(0, 120), claimed: entry.claimed === true, accepted: publicOrigins.includes(entry.url), expiresAt: entry.expiresAt || null, verifyCode: Boolean(entry.verifyCode), updatedAt: entry.updatedAt || null,
      lastCheck: check ? { state: String(check.lastState || '').slice(0, 20), checkedAt: check.checkedAt || null, failures: Number(check.failures) || 0 } : null };
  };
  const runtimeStatus = createRuntimeStatus({
    startedAt, role: main.enabled ? 'main' : 'legacy', label: main.enabled ? "Main Hub" : 'Hub',
    endpoints: {
      get port() { return server.listening ? server.address().port : port; },
      publicPort: publicPort === undefined ? null : publicPort, publicOrigins,
    }, activity, getPublicEntry: readPublicEntry,
    getReadiness: () => readiness(), getTasks: () => scheduler.list(), getNodes: () => nodes ? nodes.list() : [],
  });
  const hostId = (() => { try { return readFileSync(join(root, 'state', 'host-id'), 'utf8').trim(); } catch { return ''; } })();
  const capturePaths = ['user-space/logs/hub', ...(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(hostId) ? [`state/hosts/${hostId}/events`] : [])];
  const syncRepository = createRepoSync({ root, runtimeDir, testMode, autoResolve: main.enabled === true, push: syncOptions.mode === 'bidirectional', capturePaths: main.enabled ? ['user-space', 'state'] : capturePaths, afterUpdate: async () => {
    if (!injectedAdapter) adapter = await createAipaAdapter(root, { contextBudgetBytes });
    refreshAgendaDigest();
  } });
  const reportClock=sharedClock;
  const reports = nodes ? createMainReports({ root, runtimeDir, nodes, runner: executeModel, responseLanguage, eventContract:()=>adapter.eventContract, clock:reportClock, timeZone:sharedTimeZone(), modelConsent: main.modelConsent === true, syncEnabled: syncOptions.enabled, allowed: material => adapter.allowedContent?.(material) === true, dayStartHour: main.dayStartHour, closeWindowMs: main.closeWindowMs ?? 30 * 60_000, closeAt: main.closeAt || '02:00', backfillIntervalMs: (main.backfillIntervalMinutes ?? 10) * 60_000, revisionIntervalMs: (main.revisionIntervalMinutes ?? 10) * 60_000, collect: syncRepository, hasCommit: async commit => { try { await executeFile('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'], { windowsHide: true, timeout: 10_000 }); return true; } catch { return false; } } }) : null;
  const distillation = reports ? createMainDistillation({ root, runtimeDir, runner: executeModel, adapter: () => adapter, reports, consent: main.modelConsent === true }) : null;
  const briefings = createBriefingService({ store, runtimeDir, runner: executeModel, responseLanguage, defaults: briefing, timeZone:sharedTimeZone, fetcher: newsFetcher });
  const pushes = createPushService({ store, runtimeDir });
  pushes.register({ id: 'daily-briefing', label: "Daily news", description: "Summarizes selected public sources by interest category and includes original links.", run: async context => {
    const day = localDay(Date.parse(context.scheduledFor || new Date().toISOString()),sharedTimeZone());
    refreshAgendaDigest(day);
    let result;
    try { result = await briefings.generate(context); }
    catch (error) {
      const partial = store.readBriefing(day);
      if(dailyDigest?.settings().enabled)refreshAgendaDigest(day,{newsStatus:partial?.status||'failed',newsError:"News temporarily unavailable; agenda remains available"});
      else if (partial?.status === 'sources-only') pushes.publish('daily-briefing', { id: `daily-briefing-${day}`, title: `${day} Daily news`, summary: partial.intro, payload: { day, generatedAt: partial.generatedAt } });
      throw error;
    }
    const item = store.readBriefing(day);
    if(dailyDigest?.settings().enabled&&refreshAgendaDigest(day,{newsStatus:item?.status||'complete'}))return result;
    return { ...result, push: { id: `daily-briefing-${day}`, title: `${day} Daily news`, summary: item.intro, payload: { day, generatedAt: item.generatedAt } } };
  } });
  dailyDigest=createDailyDigest({root,runtimeDir,agenda:agendaActions.agenda,store,pushes,defaults:{enabled:main.enabled===true,dailyAt:briefings.settings().dailyAt,...agendaDefaults},timeZone:sharedTimeZone});
  const startAt = main.startAt || '08:00', closeAt = main.closeAt || '02:00', distillAt = main.distillAt || '02:30';
  if (distillation) registerTask({ id: 'main-distillation', label: "Main Hub memory distillation (after workday close)", dailyAt: distillAt, timeZone: sharedTimeZone(), quiet: true, run: async () => {
    if (closing || busy || queue.length || activeRequests || maintenance) return { status: 'deferred', summary: "Distillation waits for the current task to finish" };
    maintenance = true;
    try {
      return await instanceSync.gate.run('main', async () => {
        const result = await distillation.tick();
        return { ...result, silent: result.status === 'success' && !result.worked };
      });
    }
    finally { maintenance = false; }
  } });
  registerTask({ id: 'repo-sync', label: syncOptions.mode === 'bidirectional' ? "Bidirectional repository sync" : "Repository pull", enabled: syncOptions.enabled, intervalMs: syncOptions.intervalMinutes * 60_000, run: async () => {
    if (closing || busy || queue.length || activeRequests || maintenance) return { status: 'deferred', summary: "Conversation or save active; retry synchronization in one minute" };
    maintenance = true;
    try { return await (instanceSync ? instanceSync.request() : syncRepository()); } finally { maintenance = false; }
  } });
  if (reports) registerTask({ id: 'main-day-start', label: "Main Hub workday start", dailyAt: startAt, timeZone: sharedTimeZone(), quiet: true, run: async () => {
    if (closing || busy || queue.length || activeRequests || maintenance) return { status: 'deferred', summary: "Waiting for the current personal instance task to finish" };
    maintenance = true;
    try {
      return await instanceSync.gate.run('main', async () => {
        await outbox.flush();
        const day = reports.logicalDay(Date.now());
        await reports.start(day);
        return { status: 'success', summary: `Main Hub workday started (${day}); sub Hub synchronization requested` };
      });
    }
    finally { maintenance = false; }
  } });
  if (reports) registerTask({ id: 'main-day-close', label: "Main Hub workday close and reports", dailyAt: closeAt, timeZone: sharedTimeZone(), run: async () => {
    if (closing || busy || queue.length || activeRequests || maintenance) return { status: 'deferred', summary: "Waiting for the current personal instance task to finish" };
    maintenance = true;
    try {
      return await instanceSync.gate.run('main', async () => {
        await outbox.flush();
        const stamp = Date.now(), dayStart = reports.clockSettings().dayStartHour, today = reports.logicalDay(stamp);
        const localHour = reports.localHour(stamp);
        const day = localHour < dayStart ? today : addDay(today, -1);
        const alreadyClosed=Boolean(reports.status().days?.[day]?.closedAt);
        if(alreadyClosed&&main.modelConsent!==true)return { status: 'success', silent: true, summary: `${day} already closed; no repeat needed` };
        const closed = alreadyClosed?{status:'success'}:await reports.close(day);
        if (closed.status !== 'success') return { ...closed, summary: closed.summary || "Workday close waits for sub Hub synchronization" };
        let distilled;
        if (distillation) {
          try { distilled = await distillation.run(day); }
          catch { distilled = { status: 'error', summary: "Memory distillation incomplete. Check job status." }; }
        }
        const incomplete=main.modelConsent===true&&distilled&&distilled.status!=='success';
        return {status:incomplete?'partial':'success',...(incomplete?{code:'distillation_incomplete'}:{}),distillation:distilled,summary:`${day} Daily report saved${distilled?'；'+distilled.summary:''}`};
      });
    }
    finally { maintenance = false; }
  } });
  if (reports) registerTask({ id: 'main-report-maintenance', label: "Report backfill and late revisions", intervalMs: 10 * 60_000, quiet: true, run: async () => {
    if (closing || busy || queue.length || activeRequests || maintenance) return { status: 'deferred', summary: "Waiting for the current personal instance task to finish" };
    maintenance = true;
    try {
      return await instanceSync.gate.run('main', async () => {
        await outbox.flush();
        const result = await reports.tick();
        return { status: 'success', worked: result.worked, silent: !result.worked, summary: result.summary };
      });
    }
    finally { maintenance = false; }
  } });
  registerTask({ id: 'daily-briefing', label: "Daily news notification", ...briefings.settings(), run: async context => {
    if (closing || maintenance || busy || queue.length) return { status: 'deferred', summary: "Conversation or synchronization active; prepare news in one minute" };
    return withRepository(() => pushes.run('daily-briefing', context));
  } });
  registerTask({id:'daily-agenda',label:"Daily agenda notification",...dailyDigest.settings(),run:async context=>{
    if(closing||maintenance)return {status:'deferred',summary:"Agenda display waits for synchronization or maintenance to finish"};
    return withRepository(async()=>{const day=localDay(Date.parse(context.scheduledFor||new Date().toISOString()),sharedTimeZone());dailyDigest.snapshot(day,{newsStatus:briefings.settings().enabled?store.readBriefing(day)?.status||'pending':'disabled'});return {status:'success',summary:"Next three agenda items added to daily briefing"};});
  }});
  registerTask({id:'memory-receipts',label:"Memory usage receipt recovery",intervalMs:5*60_000,quiet:true,run:async()=>{
    if(closing||maintenance||busy||queue.length||activeRequests)return {status:'deferred',code:closing?'closing':maintenance?'maintenance':'instance_busy',summary:closing?"Hub is closing; receipt delivery deferred":maintenance?"Receipt delivery waits for synchronization or maintenance to finish":"Receipt delivery waits for the current task to finish"};
    return withRepository(async()=>{
      const result=await memoryReceipts.flush();
      return {...result,status:result.pending?'partial':'success',code:result.pending?'receipts_pending':result.delivered?'receipts_delivered':'no_pending_receipts',summary:result.pending?`Delivered ${result.delivered}; remaining ${result.pending} receipts awaiting delivery`:result.delivered?`Delivered ${result.delivered} memory usage receipts`:"Check passed; no pending receipts",silent:!result.pending&&!result.delivered};
    });
  }});
  const accessLogPath = join(runtimeDir, 'access-log.jsonl');
  const noteAccess = (req, status) => {
    try {
      if (status < 400 && !String(req.url || '').includes('/api/login')) return;
      const line = JSON.stringify({ at: new Date().toISOString(), method: req.method, path: String(req.url || '').split('?')[0].slice(0, 80), status, ip: String(req.socket?.remoteAddress || '').slice(0, 40), ua: String(req.headers?.['user-agent'] || '').slice(0, 120) });
      appendFileSync(accessLogPath, line + '\n');
      const lines = readFileSync(accessLogPath, 'utf8').trimEnd().split('\n');
      if (lines.length > 300) writeFileSync(accessLogPath, lines.slice(-300).join('\n') + '\n');
    } catch {  }
  };
  const handler = remoteOnly => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      let authority;
      try {
        if (!req.headers.host || /[\s/\\?#@]/.test(req.headers.host)) throw new Error();
        authority = new URL(`http://${req.headers.host}`);
      } catch { throw problem("Invalid access URL", 403); }
      const host = authority.hostname.toLowerCase();
      const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(host);
      const origin = new URL(`${localHost ? 'http' : 'https'}://${authority.host}`).origin;
      if (remoteOnly ? !publicOriginSet.has(origin) : !allowedHosts.has(host)) throw problem("This access domain is not configured", 403);
      const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const proxied = Boolean(req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'] || req.headers['tailscale-user-login']);
      const localAccess = !remoteOnly && localHost && localPeer && !proxied;
      const remoteUrl = remoteOnly ? origin : advertisedOrigin || publicOrigins[0] || (hostname ? `https://${hostname}` : null);
      const connectionMode = remoteOnly || (localAccess && publicEnabled) ? 'public' : hostname ? 'tailscale' : 'local';
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;
      if (!['GET', 'POST'].includes(req.method)) throw problem("Unsupported request method", 405);
      if (closing && req.method === 'POST') throw problem("Hub is stopping. Preserve your input and retry.", 503);
      const nodeChannel = nodes && ['/api/nodes/poll', '/api/nodes/ack', '/api/nodes/tasks/claim', '/api/nodes/tasks/beat', '/api/nodes/tasks/ack'].includes(pathname);
      if (req.method === 'POST' && !nodeChannel) {
        if (req.headers.origin !== origin) throw problem("Request origin mismatch", 403);
      }
      if (req.method === 'GET' && pathname === '/healthz') return send(res, { ok: true, product: 'AIPA Hub' });
      if (req.method === 'POST' && pathname === '/api/client-error') {
        const body = await bodyOf(req);
        try {
          appendFileSync(join(runtimeDir, 'access-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), method: 'CLIENT', path: String(body?.where || '').slice(0, 60), status: 0, ip: String(req.socket?.remoteAddress || '').slice(0, 40), ua: String(body?.message || '').slice(0, 300), detail: String(body?.stack || '').slice(0, 400) }) + '\n');
        } catch {  }
        return send(res, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/readyz') {
        const r = readiness(); return send(res, { ready: !r.closing && !r.maintenance, role: r.role, releaseId: r.releaseId, core: r.core }, r.closing || r.maintenance ? 503 : 200);
      }
      if (req.method === 'POST' && nodeChannel && !pathname.startsWith('/api/nodes/tasks/')) {
        const body = await bodyOf(req);
        const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
        if (pathname.endsWith('/poll')) {
          taskQueue?.sweep();
          const before = nodes.list().find(node => node.id === body.nodeId)?.status;
          const polled = nodes.poll(body.nodeId, token, body);
          const after = nodes.list().find(node => node.id === body.nodeId)?.status;
          if (before !== after) activity.append({ kind: 'device', action: 'node-presence', status: after === 'online' ? 'success' : 'blocked',
            summary: `${body.nodeId} ${after === 'online' ? "Online" : "Offline (no heartbeat for over 90 seconds)"}`, detail: { deviceId: body.nodeId } });
          return send(res, polled);
        }
        const op = nodes.ack(body.nodeId, token, body);
        activity.append({ kind: 'device', action: 'node-result', status: op.result.status === 'success' ? 'success' : op.result.status === 'deferred' ? 'deferred' : 'failed',
          summary: `${op.nodeId} ${op.kind === 'clear' ? "Clear" : "Sync"} ${op.result.status === 'success' ? "complete" : op.result.status === 'deferred' ? "deferred" : "incomplete"} (${op.result.pushed ? "pushed" : "not pushed"}${op.result.code ? ", " + op.result.code : ""})`,
          detail: { deviceId: op.nodeId, code: op.result.code, commit: op.result.commit, pushed: op.result.pushed, pushSuppressed: op.result.pushSuppressed } });
        outbox.enqueue('tool_result', `Device operation receipt: ${op.nodeId} ${op.kind} ${op.result.status} ${op.result.code}`, 'operations', `hub-node-result-${op.id}-${op.result.status}-${op.result.code}`);
        return send(res, op);
      }
      if (taskQueue && req.method === 'POST' && ['/api/nodes/tasks/claim', '/api/nodes/tasks/beat', '/api/nodes/tasks/ack'].includes(pathname)) {
        const body = await bodyOf(req);
        const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
        const node = nodes.authenticate(body.nodeId, token);
        if (body.installationId !== node.installationId) throw problem("Installation binding mismatch", 409);
        if (pathname.endsWith('/claim')) {
          const task = taskQueue.claim({ nodeId: body.nodeId });
          if (task) activity.append({ kind: 'task', action: 'task-claim', status: 'info', summary: `${body.nodeId} claimed task ${task.id}`, detail: { deviceId: body.nodeId, taskId: task.id } });
          return send(res, { task });
        }
        if (pathname.endsWith('/beat')) return send(res, taskQueue.beat({ nodeId: body.nodeId, id: body.id, leaseId: body.leaseId }));
        const result = taskQueue.ack({ nodeId: body.nodeId, id: body.id, leaseId: body.leaseId, attempt: body.attempt, status: body.status, code: body.code, summary: body.summary, artifacts: body.artifacts });
        activity.append({ kind: 'task', action: 'task-result', status: result.state === 'done' ? 'success' : 'blocked',
          summary: `${body.nodeId} task ${result.id} ${result.state}`, detail: { deviceId: body.nodeId, taskId: result.id, code: result.result?.code || '', late: result.result?.late === true } });
        outbox.enqueue('tool_result', `Task ${result.id} ${result.state}: ${String(result.result?.summary || '').slice(0, 200)}`, 'tasks', `hub-task-result-${result.id}-${result.state}`);
        return send(res, result);
      }
      if (req.method === 'GET' && assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        if (pathname === '/') {
          const html = readFileSync(join(HERE, 'public', file), 'utf8').replace('<footer id="site-footer" class="site-footer" hidden><!-- site-footer --></footer>', () => renderSiteFooter(siteSettings.get()));
          res.writeHead(200, { 'Content-Type': type }); return res.end(html);
        }
        res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(join(HERE, 'public', file)));
      }
      if (req.method === 'POST' && pathname === '/api/local-login') {
        await bodyOf(req);
        if (!localAccess) throw problem("Connect using the pairing code", 403);
        login(res, false);
        activity.append({ kind: 'system', action: 'login', status: 'success', summary: "Automatic sign-in through local entry" });
        return send(res, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/login') {
        const body = await bodyOf(req);
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) || { count: 0, until: Date.now() + 900_000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 900_000; }
        if (attempt.count >= 10) throw problem("Too many pairing attempts. Retry later.", 429);
        if (typeof body.code !== 'string' || !equal(body.code, auth.pairingCode)) {
          attempt.count++; attempts.set(ip, attempt);
          activity.append({ kind: 'system', action: 'pairing', status: 'failed', summary: "Incorrect pairing code (rejected)" });
          noteAccess(req, 401); throw problem("Incorrect pairing code", 401);
        }
        attempts.delete(ip); login(res, !localHost);
        activity.append({ kind: 'system', action: 'pairing', status: 'success', summary: localHost ? "Local pairing successful" : "New device paired successfully" });
        return send(res, { ok: true });
      }
      if (!authenticated(req)) throw problem("Connect to your AIPA first", 401);
      if (req.method === 'GET' && pathname === '/api/site-settings') return send(res, siteSettings.get());
      if (req.method === 'POST' && pathname === '/api/site-settings') return send(res, siteSettings.update(await bodyOf(req)));
      // Keep diagnostics available while Core is blocked, without invoking it.
      if (req.method === 'GET' && pathname === '/api/status') {
        const core = coreStatus();
        return send(res, {
          attachments:{available:attachments.available,vision:vision.profile().available,imageWeb:true,visionProfile:vision.profile(),...attachments.limits}, model: currentModelProfile(), modelProfileVersion: currentModelProfile().version,
          timeZone:sharedTimeZone(),clockSource:lastClockSettings?.source||'compatibility-default',owner: adapter.owner, version: adapter.version, instance: basename(store.root), engine: engineName, engineId: engine,
          engineAvailable: runner.available !== false, core, diagnostics:diagnostics(core), consentRequired: core.status !== 'ready' || adapter.requiresConsent(),
          remoteUrl, connectionMode, local: localAccess,
        });
      }
      const attachmentOwner = digest(req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('aipa_hub=')) || '');
      if (pathname === '/api/attachments' && req.method === 'POST') {
        if(maintenance || instanceSync?.gate.maintenance()) throw problem("Hub is under maintenance. Preserve images and retry.",503);
        activeRequests++;
        try { return send(res, await attachments.upload(req,{owner:attachmentOwner,scope:req.headers['x-aipa-draft'],key:req.headers['idempotency-key']}),201); }
        finally {activeRequests--;}
      }
      const imageRoute=pathname.match(/^\/api\/attachments\/([a-f0-9]{64})(?:\/(content|delete))?$/);
      if(imageRoute) {
        if(req.method==='POST' && imageRoute[2]==='delete')return await withRepository(async()=>{const body=await bodyOf(req);attachments.remove(imageRoute[1],attachmentOwner,body.draftId,body);return send(res,{ok:true});});
        if(req.method==='GET' && imageRoute[2]!=='delete') {
          const value=attachments.get(imageRoute[1],attachmentOwner);
          if(imageRoute[2]==='content'){res.writeHead(200,{'Content-Type':'image/webp','Content-Length':value.bytes.length,'Cache-Control':'private, no-store'});return res.end(value.bytes);}
          return send(res,{...value.meta,status:value.status});
        }
      }
      if (nodes && req.method === 'POST') {
        const body = await bodyOf(req);
        const requestId = req.headers['idempotency-key'] || req.headers['x-aipa-operation-id'];
        const identity = typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(requestId) ? requestId : typeof body.id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(body.id) ? body.id : randomUUID();
        const operationId = digest(`${pathname}:${identity}`).slice(0, 32);
        outbox.enqueue('tool_call', `Web action request: POST ${pathname}`, 'operations', `hub-web-${operationId}`);
        res.hubOperation = { id: operationId, path: pathname };
        res.setHeader('X-Aipa-Operation-Id', identity);
      }
      if (nodes && await handleUpdateRoute({ pathname, method: req.method, body: req.method === 'POST' ? await bodyOf(req) : undefined, query: url.searchParams, key: req.headers['idempotency-key'], runtimeDir, send: (value, status) => send(res, value, status) })) return;
      if (nodes && req.method === 'GET' && pathname === '/api/search') {
        const query = String(url.searchParams.get('q') || '').slice(0, 1000);
        outbox.enqueue('user_message', `Web search: ${query}`, 'operations', `hub-search-${randomUUID()}`);
      }
      if (nodes && req.method === 'GET' && pathname === '/api/nodes') return send(res, { nodes: nodes.list(), operations: nodes.operations() });
      if (taskQueue && req.method === 'GET' && pathname === '/api/task-queue') return send(res, { tasks: taskQueue.list({ limit: Number(url.searchParams.get('limit') || 50), states: url.searchParams.get('states') || undefined }) });
      if (taskQueue && req.method === 'POST' && pathname === '/api/task-queue') {
        if (!localAccess) throw problem("Submit tasks from the local Main Hub page", 403);
        const body = await bodyOf(req);
        const task = taskQueue.submit({ ...body, id: body.id || body.requestId, createdBy: 'web' });
        activity.append({ kind: 'task', action: 'task-submit', status: 'info', summary: `Queued task ${task.id}: ${task.prompt.slice(0, 80)}`, detail: { taskId: task.id } });
        outbox.enqueue('user_message', `Task ${task.id}: ${task.prompt.slice(0, 200)}`, 'tasks', `hub-task-${task.id}`);
        return send(res, task, 201);
      }
      if (nodes && req.method === 'POST' && pathname === '/api/nodes/enroll') {
        if (!localAccess) throw problem("Register devices through the local main Hub page", 403);
        const body = await bodyOf(req);
        const enrolled = nodes.enroll(body.id);
        activity.append({ kind: 'device', action: 'node-enroll', status: 'success', summary: `Register sub Hub ${enrolled.id}`, detail: { deviceId: enrolled.id } });
        return send(res, enrolled, 201);
      }
      const nodeAction = pathname.match(/^\/api\/nodes\/([a-zA-Z0-9_-]{3,80})\/(sync|clear|offline)$/);
      if (nodes && req.method === 'POST' && nodeAction) {
        const body = await bodyOf(req), [, id, kind] = nodeAction;
        const op = kind === 'offline' ? (nodes.offline(id), { status: 'success' }) : nodes.request(id, kind, body.id);
        const action = kind === 'sync' ? "Immediate synchronization requested" : kind === 'clear' ? "Clear and remove from device list requested" : "Marked offline";
        activity.append({ kind: 'device', action: 'node-' + kind, status: 'info', summary: `${id} ${action}`, detail: { deviceId: id } });
        outbox.enqueue('user_message', `Web device action: ${id} ${kind}`, 'operations', `hub-op-${op.id || randomUUID()}`);
        return send(res, op, 202);
      }
      if (req.method === 'GET' && pathname === '/api/runtime/status') return send(res, runtimeStatus.snapshot());
      if(req.method==='GET'&&pathname==='/api/agenda')return await withAgendaRepository(req,localAccess,async()=>send(res,{...agendaActions.agenda.list({preview:url.searchParams.get('mode')==='preview',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50),status:url.searchParams.get('status')||'',priority:url.searchParams.get('priority')||'',from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||''}),sync:instanceSync?.status()||null}));
      if(req.method==='GET'&&pathname==='/api/agenda-settings')return send(res,{settings:dailyDigest.settings(),model:currentModelProfile(),capability:agendaWriteState(agendaWriteOptions)});
      const agendaOperationMatch=pathname.match(/^\/api\/agenda\/actions\/([a-zA-Z0-9_-]{8,80})$/);
      if(req.method==='GET'&&agendaOperationMatch)return send(res,agendaActions.get(agendaOperationMatch[1],'web'));
      if(req.method==='POST'&&pathname==='/api/agenda-settings')return await withRepository(async()=>{const result=dailyDigest.configure(await bodyOf(req));scheduler.configure('daily-agenda',result);return send(res,{settings:result});});
      if(req.method==='POST'&&pathname==='/api/agenda/actions')return await withAgendaRepository(req,localAccess,async()=>{
        const body=await bodyOf(req);
        body.id||=randomUUID();
        if(typeof body.text==='string')outbox.enqueue('user_message',body.text,'agenda',`hub-agenda-input-${body.id}`);
        const host=body.hostProposal!==undefined;
        if(host&&(!localAccess||!['codex','claude','codebuddy','trae','deepseek'].includes(body.hostModel)))throw problem("Host proposals require a bound local session",403);
        const result=await agendaActions.propose({id:body.id,text:body.text,owner:'web',source:{messageId:body.id||'',at:new Date().toISOString(),interpretedBy:host?body.hostModel:'hub-model'},consent:body.consent,modelProfileVersion:body.modelProfileVersion,targetId:body.targetId,action:body.action,...(host?{interpret:async()=>JSON.stringify(body.hostProposal)}:{})});
        if(result.status==='applied')refreshAgendaDigest();
        return send(res,result,result.status==='pending'?202:200);
      });
      if(req.method==='POST'&&pathname==='/api/agenda/confirm')return await withAgendaRepository(req,localAccess,async()=>{
        const body=await bodyOf(req),result=agendaActions.confirm({id:body.id,owner:'web',confirmed:body.confirmed});
        if(result.source?.chatId&&result.source?.messageId)updateTurn(result.source.chatId,result.source.messageId,{agendaOperation:result});
        refreshAgendaDigest();
        return send(res,result);
      });
      const digestMatch=pathname.match(/^\/api\/digests\/(\d{4}-\d{2}-\d{2})$/);
      if(req.method==='GET'&&digestMatch)return await withRepository(async()=>send(res,dailyDigest.report(digestMatch[1])));
      if (req.method === 'GET' && pathname === '/api/activity') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const kinds = url.searchParams.getAll('kind').filter(kind => ['task', 'device', 'sync', 'system', 'maintenance'].includes(kind));
        const requested = (url.searchParams.get('status') || '').split(',').map(value => value.trim()).filter(Boolean);
        const statuses = requested.includes('failed') ? [...new Set([...requested.filter(value => value !== 'failed'), 'failed', 'error', 'blocked'])] : requested;
        const page = activity.list({ limit, offset, kinds, statuses, actions: url.searchParams.getAll('action').filter(action => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(action)), before: url.searchParams.get('before') || '' });
        return send(res, { ...page, retention: activity.retention });
      }
      if (reports && req.method === 'GET' && pathname === '/api/main/status') return send(res, { role: 'main', testMode,capabilities:{reportRetry:true,distillationPhases:1,conflictReview:1}, reports: reports.status(), distillation: distillation.status(), eventOutboxPending: outbox.pending() });
      if(reports&&req.method==='GET'&&pathname==='/api/main/conflict-reviews')return send(res,{conflicts:createConflictReview({root,runtimeDir,gate:instanceSync.gate}).list()});
      const reviewMatch=pathname.match(/^\/api\/main\/conflict-reviews\/([a-f0-9]{24})(\/decisions)?$/);
      if(reports&&reviewMatch){
        const review=createConflictReview({root,runtimeDir,gate:instanceSync.gate});
        if(req.method==='GET'&&!reviewMatch[2])return send(res,review.detail(reviewMatch[1]));
        if(req.method==='POST'&&reviewMatch[2]){
          requireCurrentCore();if(closing||maintenance)throw problem("Hub is under maintenance. Preserve the decision and retry.",503);
          const body=await bodyOf(req);activeRequests++;
          try{const result=await review.decide(reviewMatch[1],body);return send(res,result,result.status==='deferred'?409:200);}finally{activeRequests--;}
        }
      }
      const reportMatch = pathname.match(/^\/api\/main\/reports\/(daily|monthly|yearly)\/([0-9-]+)$/);
      if (reports && req.method === 'GET' && reportMatch) return send(res, reports.read(reportMatch[1], reportMatch[2]));
      const conflictsMatch = pathname.match(/^\/api\/main\/conflicts\/(\d{4}-\d{2}-\d{2})$/);
      if (reports && req.method === 'GET' && conflictsMatch) return send(res, { conflicts: reports.sources(conflictsMatch[1]).conflicts });
      if (reports && req.method === 'POST' && ['/api/main/start', '/api/main/close','/api/main/retry-report'].includes(pathname)) {
        const body = await bodyOf(req);
        if (maintenance || busy || activeRequests) throw problem("Daily workflow waits for the current instance task to finish", 409);
        maintenance = true;
        try { enterMain(); try { return send(res, pathname.endsWith('/retry-report')?await reports.retryFailure(body.key):pathname.endsWith('/start') ? await reports.start(body.day) : await reports.close(body.day)); } finally { leaveMain(); } }
        finally { maintenance = false; }
      }
      if (req.method === 'GET' && pathname === '/api/tasks') return send(res, { tasks: scheduler.list() });
      const manualTask=pathname.match(/^\/api\/tasks\/(repo-sync|memory-receipts|main-distillation)\/run$/);
      if (req.method === 'POST' && manualTask) {
        await bodyOf(req);
        void scheduler.runNow(manualTask[1]);
        return send(res, { tasks: scheduler.list() }, 202);
      }
      const captureTurn = pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/turns$/);
      if (nodes && req.method === 'POST' && (maintenance || instanceSync?.gate.state()) && !instanceSync?.gate.maintenance() && (pathname === '/api/notes' || captureTurn)) {
        const body = await bodyOf(req), id = assertId(body.id), ids=attachmentIds(body.attachmentIds), text = ids.length ? (typeof body.text==='string' && body.text.trim() ? textOf(body.text) : '') : textOf(body.text);
        if (captureTurn) {
          requireConsent(body); const chat = captureInbox.virtualChat(assertId(captureTurn[1])); if (!chat) throw problem("Conversation not found", 404);
          const options=acceptedOptions(body,chat.project||'');
          const same = chat.turns.find(t => t.id === id);
          if (same) { if (!sameTurnRequest(same, text, options)) throw problem("Repeated message content or web consent differs", 409); return send(res, { id, status: same.status, duplicate: true }); }
          requireWebOptions(options);
          if (chat.turns.some(t => ['queued', 'running'].includes(t.status)) || chat.turns.length >= 100) throw problem("Wait for the current answer or start a new conversation", 409);
          attachments.prepare(ids,attachmentOwner,id);
          captureInbox.enqueue('turn', id, { chatId: chat.id, text, ...options });
          return send(res, { id, status: 'queued', deferred: true }, 202);
        }
        attachments.prepare(ids,attachmentOwner,id);
        const r = captureInbox.enqueue('note', id, { text, attachmentIds:ids }); return send(res, { id, text, created: r.createdAt, warning: "Original input saved; awaiting current operation completion before instance archival" }, 202);
      }
      const captureRead = pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)$/);
      if (nodes && req.method === 'GET' && captureRead && captureInbox.pending()) {
        const chat = captureInbox.virtualChat(assertId(captureRead[1])); if (chat) return send(res, chat);
      }
      return await withRepository(async () => {
      if (req.method === 'GET' && pathname === '/api/briefing-settings') return send(res, briefings.metadata());
      if (req.method === 'GET' && pathname === '/api/web-search/settings') return send(res, webSearch.metadata());
      if (req.method === 'POST' && pathname === '/api/web-search/settings') return send(res, webSearch.configure(await bodyOf(req)));
      if (req.method === 'POST' && pathname === '/api/web-search/check') {
        const body=await bodyOf(req);
        try {
          return send(res,await webSearch.check({live:body.live===true,consent:body.consent===true,expectedRevision:body.webProfileVersion}));
        } catch (error) {
          if (error.code?.startsWith('upstream_')) error.status = 502;
          throw error;
        }
      }
      if (req.method === 'POST' && pathname === '/api/briefing-settings') {
        const result = briefings.configure(await bodyOf(req));
        scheduler.configure('daily-briefing', result.settings);
        return send(res, result);
      }
      if (req.method === 'POST' && pathname === '/api/briefing/like') {
        const input = await bodyOf(req);
        const result = briefings.toggleLike(input.tags, input.action === 'unlike' ? 'unlike' : 'like');
        activity.append({ kind: 'system', action: 'briefing-like', status: 'success', summary: `${input.action === 'unlike' ? "cancel" : "Record"}News preferences (${result.tags.length} tags)` });
        return send(res, result);
      }
      if (req.method === 'GET' && pathname === '/api/pushes') {
        const list = pushes.list();
        return send(res, { pushes: list, unread: list.filter(p => p.unread).length, producers: pushes.producers(), tasks: scheduler.list() });
      }
      if (req.method === 'POST' && pathname === '/api/pushes/daily-briefing/run') {
        await bodyOf(req); void scheduler.runNow('daily-briefing');
        return send(res, { ok: true }, 202);
      }
      const pushMatch = pathname.match(/^\/api\/pushes\/([a-zA-Z0-9_-]{8,80})(\/read)?$/);
      if (pushMatch) {
        if (req.method === 'POST' && pushMatch[2]) { await bodyOf(req); pushes.markRead(pushMatch[1]); return send(res, { ok: true }); }
        if (req.method === 'GET' && !pushMatch[2]) {
          const push = store.readPush(pushMatch[1]); if (!push) throw problem("Notification not found", 404);
          return send(res, push);
        }
      }
      const briefingMatch = pathname.match(/^\/api\/briefings\/(\d{4}-\d{2}-\d{2})(\/read)?$/);
      if (briefingMatch) {
        const day = briefingMatch[1];
        if (req.method === 'GET' && !briefingMatch[2]) {
          const result = store.readBriefing(day);
          if (!result) throw problem("Briefing not found", 404);
          return send(res, result);
        }
      }
      if (req.method === 'GET' && pathname === '/api/pairing') {
        if (!localAccess) throw problem("View the pairing code on the local Hub page, or use SSH local forwarding", 403);
        return send(res, { code: auth.pairingCode, remoteUrl, connectionMode });
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        await bodyOf(req);
        const key = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('aipa_hub='))?.slice(9);
        auth.sessions = auth.sessions.filter(s => !equal(s.hash, digest(key))); saveAuth();
        res.setHeader('Set-Cookie', 'aipa_hub=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return send(res, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/chats') {
        const mode = url.searchParams.get('visibility') || 'visible';
        if (!['visible', 'hidden'].includes(mode)) throw problem("Invalid conversation list kind");
        const hidden = chatVisibility.hiddenIds();
        const chats = store.listChats();
        return send(res, { chats: chats.filter(c => hidden.has(c.id) === (mode === 'hidden')).map(chat => ({ id: chat.id, title: displayChatTitle(chat), updated: chat.updated, count: chat.turns.length })), hiddenCount: chats.filter(c => hidden.has(c.id)).length });
      }
      if(req.method==='GET'&&pathname==='/api/projects')return send(res,{supported:adapter.projectScope===true,projects:adapter.projectScope?adapter.projects?.()||[]:[]});
      if (req.method === 'POST' && pathname === '/api/chats') { const body=await bodyOf(req),project=projectId(body.project);if(project&&!adapter.projectScope)throw problem("This Core does not support project context. Upgrade and restart Hub.",409);return send(res, store.createChat({project}), 201); }
      const match = pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)(?:\/(turns|retry|visibility))?$/);
      if (match) {
        const chat = store.readChat(assertId(match[1]));
        if (!chat) throw problem("Conversation not found", 404);
        if (req.method === 'GET' && !match[2]) return send(res, chat);
        if (req.method === 'POST' && match[2] === 'visibility') {
          const body = await bodyOf(req); chatVisibility.setHidden(chat.id, body.hidden);
          return send(res, { id: chat.id, hidden: body.hidden });
        }
        if (req.method === 'POST' && match[2]) {
          const body = await bodyOf(req); requireConsent(body);
          const id = assertId(body.id);
          const existing = chat.turns.find(t => t.id === id);
          const options=acceptedOptions(body,match[2]==='retry'?(existing?.project??chat.project??''):(chat.project||''));
          if (match[2] === 'retry') {
            if (!existing) throw problem("Retry message not found", 404);
            if (!['error', 'interrupted'].includes(existing.status)) throw problem("This message does not need a retry", 409);
            if((existing.project||'')!==options.project)throw problem("Retries must preserve the original project. Start a new message to change projects.",409);
            if (chat.turns.some(t => ['queued', 'running'].includes(t.status))) throw problem("Wait for the current answer to finish", 409);
            if(JSON.stringify(existing.attachmentIds||[])!==JSON.stringify(options.attachmentIds)||Boolean(existing.analyzeImages)!==options.analyzeImages||(existing.analyzeImages&&Boolean(existing.allowWeb)!==options.allowWeb))throw problem("Retries must preserve original images and processing mode. Start a new message to change content.",409);
            for(const image of options.attachmentIds)attachments.get(image,'');
            requireWebOptions(options);
            existing.status = 'queued'; existing.error = ''; delete existing.errorCode; delete existing.contextIssues; existing.attempts = (existing.attempts || 1) + 1;
            Object.assign(existing, options); existing.consentedAt = new Date().toISOString();
          } else {
            const input = options.attachmentIds.length ? (typeof body.text==='string' && body.text.trim() ? textOf(body.text) : '') : textOf(body.text);
            if (existing) {
              if (!sameTurnRequest(existing, input, options)) throw problem("Repeated message content or web consent differs", 409);
              return send(res, { id: existing.id, status: existing.status, duplicate: true });
            }
            requireWebOptions(options);
            if (chat.turns.some(t => ['queued', 'running'].includes(t.status))) throw problem("Wait for the current answer to finish", 409);
            if (chat.turns.length >= 100) throw problem("This conversation is long. Start a new conversation to continue.", 409);
            attachments.prepare(options.attachmentIds,attachmentOwner,id);attachments.archive(options.attachmentIds);
            const storageOnly=options.attachmentIds.length&&!options.analyzeImages;
            chat.turns.push({ id, input, ...options, status: storageOnly?'completed':'queued', ...(storageOnly?{processing:'storage-only',answer:"Images and descriptions saved without analysis or sending to a model."}:options.analyzeImages?{processing:'vision'}:{}), created: new Date().toISOString(), consentedAt: new Date().toISOString(), attempts: 1 });
            if (chat.turns.length === 1) chat.title = titleForTurn({ input, ...options });
          }
          chat.updated = new Date().toISOString(); store.saveChat(chat);
          if(options.attachmentIds.length&&!options.analyzeImages){await outbox.record('user_message',body.text?.trim()||'',chat.id,`hub-user-${id}`,undefined,options.project);await outbox.record('tool_result',attachmentEventTextV1('',options.attachmentIds),chat.id,`hub-attachments-${id}`,undefined,options.project);return send(res,{id,status:'stored'},201);}
          send(res, { id, status: 'queued' }, 202); schedule(chat.id, id); return;
        }
      }
      if (req.method === 'GET' && pathname === '/api/notes') return send(res, { notes: store.listNotes().slice(0, 100) });
      if (req.method === 'POST' && pathname === '/api/notes') {
        const body = await bodyOf(req);
        const id=assertId(body.id), ids=attachmentIds(body.attachmentIds), text=ids.length?(typeof body.text==='string'&&body.text.trim()?textOf(body.text):''):textOf(body.text);
        const previous=store.listNotes().find(n=>n.id===id);
        if(!previous){attachments.prepare(ids,attachmentOwner,id);attachments.archive(ids);}
        const note = store.saveNote(id,text,undefined,ids);
        const beginWarning = await adapter.begin({ id: 'notes' });
        const warning = await outbox.record('user_message', note.text, 'notes', `hub-note-${note.id}`) || beginWarning;
        if(note.attachmentIds?.length)await outbox.record('tool_result',attachmentEventTextV1('',note.attachmentIds),'notes',`hub-note-attachments-${note.id}`,note.created);
        return send(res, { ...note, warning });
      }
      if (req.method === 'GET' && pathname === '/api/search') {
        const query = String(url.searchParams.get('q') || '').slice(0, 1000);
        return send(res, { hits: await adapter.search(query, store.listNotes()) });
      }

      throw problem("Page not found", 404);
      });
    } catch (error) {
      if (!res.headersSent) {
        const message = error.status ? error.message : "Local records cannot be processed right now. Check Hub runtime status.";
        send(res, req.url?.startsWith('/api/admin/updates/') ? { code: `HTTP_${error.status || 500}`, message } : { error: message }, error.status || 500);
        noteAccess(req, error.status || 500);
      }
      else res.end();
    }
  };
  const server = createServer(handler(false));
  const publicServer = publicEnabled ? createServer(handler(true)) : null;
  const servers = [server, publicServer].filter(Boolean);
  for (const listener of servers) { listener.requestTimeout = 30_000; listener.headersTimeout = 10_000; }
  const stopServers = () => Promise.all(servers.filter(listener => listener.listening).map(listener => new Promise(resolveClose => listener.close(resolveClose))));
  const readiness = () => {
    const core = coreStatus();
    return { timeZone:sharedTimeZone(), role: main.enabled ? 'main' : 'legacy', releaseId: process.env.AIPA_HUB_RELEASE_ID || 'development', deploymentGeneration: Number(process.env.AIPA_HUB_DEPLOYMENT_GENERATION || 0), protocol:HUB_PROTOCOL.max, runtimeSchema:HUB_RUNTIME_SCHEMA, testMode, idle: !busy && !queue.length && !activeRequests && !instanceSync?.gate.state(), maintenance: Boolean(maintenance || instanceSync?.gate.maintenance() || core.status !== 'ready'), closing, core,diagnostics:diagnostics(core) };
  };
  const listenOn = (listener, listenPort) => new Promise((resolveListen, reject) => {
    listener.once('error', reject);
    listener.listen(listenPort, '127.0.0.1', () => { listener.removeListener('error', reject); resolveListen(); });
  });
  return {
    server, publicServer, store, runtimeDir, scheduler, briefings, pushes, nodes, reports, readiness, activity, runtimeStatus,agendaActions,dailyDigest,
    async listen() {
      try { await listenOn(server, port); if (publicServer) await listenOn(publicServer, publicPort); }
      catch (error) { await stopServers(); runner.close?.(); release(); throw error; }
      if(memoryReceipts.pending()&&coreStatus().status==='ready')try{await withRepository(()=>memoryReceipts.flush());}catch{}
      scheduler.start();
      activity.append({ kind: 'system', action: 'start', status: 'success',
        summary: `${main.enabled ? "Main Hub" : 'Hub'} started (${process.env.AIPA_HUB_RELEASE_ID || 'development'}, port ${server.address().port}${publicServer ? '/' + publicPort : ''})`,
        detail: { releaseId: process.env.AIPA_HUB_RELEASE_ID || 'development' } });
      if (instanceSync) {
        wakeTimer = setInterval(() => {
          const path = join(runtimeDir, 'task-wake.json');
          if (closing || maintenance || busy || activeRequests || instanceSync.gate.maintenance()) return;
          if (captureInbox.pending() && !instanceSync.gate.state()) { void withRepository(() => captureInbox.flush()).catch(() => {}); return; }
          if (!existsSync(path)) return;
          unlinkSync(path);
          if (syncOptions.enabled) void scheduler.runNow('repo-sync');
        }, 1000); wakeTimer.unref();
      }
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      closing = true;
      vision.close();
      for(const controller of imageWebControllers)controller.abort();
      clearInterval(wakeTimer);
      activity.append({ kind: 'system', action: 'stop', status: 'info', summary: `${main.enabled ? "Main Hub" : 'Hub'} stopping (saved information preserved)` });
      const stopped = stopServers();
      await scheduler.stop();
      await instanceSync?.stop();
      await draining;
      await modelQueue;
      runner.close?.();
      for (const [chatId, turnId] of queue.splice(0)) updateTurn(chatId, turnId, { status: 'interrupted', error: "Hub stopped; input saved. Retry to continue." });
      await stopped;
      if(captureInbox.pending() && instanceSync && existsSync(join(root,'.git')) && instanceSync.gate.maintenance()?.reason==='update' && !instanceSync.gate.state())await captureInbox.flush({interruptModels:true});
      release();
    },
  };
  } catch (error) { release(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? '' : process.argv[i + 1]; };
  try {
    const config = arg('config') ? readJson(resolve(arg('config')), {}) : {};
    const root = arg('root') || config.root || process.env.AIPA_ROOT;
    const hub = await createHub({ root, port: Number(arg('port') || config.port || 4317), hostname: arg('hostname') || config.hostname || '', publicOrigins: config.publicOrigins, publicPort: config.publicPort, advertisedOrigin: config.advertisedOrigin, site: config.site, runtimeDir: config.runtimeDir, engine: arg('engine') || config.engine || process.env.AIPA_HUB_ENGINE || 'codex', tasks: config.tasks, briefing: config.briefing, testMode: config.testMode, main: config.main, contextBudgetBytes: config.contextBudgetBytes });
    const url = await hub.listen();
    console.log(JSON.stringify({ status: 'ready', url, pid: process.pid, instance: basename(resolve(root)) }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void hub.close().then(() => process.exit(0)); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
