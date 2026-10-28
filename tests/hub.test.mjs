import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { createHub } from '../server.mjs';
import { createStore } from '../lib/storage.mjs';
import { createAipaAdapter, termsOf } from '../lib/aipa.mjs';
import {createMainReports} from '../lib/main-reports.mjs';
import { createCodexRunner } from '../lib/codex.mjs';
import { createClaudeRunner } from '../lib/claude.mjs';
import { resolveRecallRange } from '../lib/recall.mjs';
import { createChatVisibility } from '../lib/chat-visibility.mjs';
import {installAgendaIntegration,restoreAgendaIntegration} from '../lib/agenda-integration.mjs';
import {agendaCapability} from '../lib/agenda-capability.mjs';
import * as eventMirror from '../lib/event-semantics.mjs';
import {quarantineEventRows} from '../lib/conflict-resolution.mjs';
import { normalisePins, DEFAULT_PINS } from '../public/navigation.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = resolve(process.env.AIPA_ORIGIN_ROOT || join(REPO, '..', 'artificial-intelligence-origin-agent'));
const FRAMEWORK = join(ORIGIN, 'product', 'core-space', 'scripts');
const hasFramework = existsSync(join(FRAMEWORK, 'lib', 'privacy-policy.mjs')) && existsSync(join(FRAMEWORK, 'lib', 'event-store.mjs'));
if (process.env.AIPA_ORIGIN_ROOT && !hasFramework) throw new Error('AIPA_ORIGIN_ROOT must point to public Origin source containing product/core-space/scripts');
const frameworkTest = (name, run) => test(name, { skip: hasFramework ? false : 'Set AIPA_ORIGIN_ROOT to run Core integration tests' }, run);
frameworkTest("1 MiB preserves complete multilingual required rules; small budgets report actual bytes and reach the host",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());
 const body='\u9075\u5b88\u672c\u6761\u89c4\u5219。'.repeat(1600)+'\u5b8c\u6574\u89c4\u5219\u7ed3\u675f';
 writeFileSync(join(f.root,'user-space/memory/instructions.md'),'## \u5927\u89c4\u5219\n'+body+'\n');
 const adapter=await createAipaAdapter(f.root);
 const projection=adapter.assertContextReady();
 assert.equal(projection.status,'ready');assert.ok(Buffer.byteLength(JSON.stringify(projection))>16000);
 assert.ok(projection.sections.some(section=>section.body===body));
 const limited=await createAipaAdapter(f.root,{contextBudgetBytes:16000});
 assert.throws(()=>limited.assertContextReady(),error=>error.code==='required_context_exceeds_budget'&&error.requiredBytes>16000&&error.budget===16000&&error.message.includes(String(error.requiredBytes))&&error.message.includes('16000'));
 let calls=0;
 const hub=await createHub({root:f.root,runtimeDir:join(f.base,'budget-runtime'),port:0,contextBudgetBytes:16000,runner:async()=>{calls++;return 'must not run';}});
 t.after(()=>hub.close());const origin=await hub.listen();
 const login=await fetch(origin+'/api/local-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
 const headers={Origin:origin,'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]};
 const request=(path,body)=>fetch(origin+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 const chat=await(await request('/api/chats',{})).json();
 await request(`/api/chats/${chat.id}/turns`,{id:randomUUID(),text:'Synthetic input',engine:'codex',consent:true});
 const turn=(await completed(request,chat.id)).turns[0];
 assert.equal(turn.errorCode,'required_context_exceeds_budget');assert.equal(calls,0);
});
frameworkTest("Missing required files and privacy blocks have distinct errors; unsupported completeness contracts reject explicitly",async t=>{
 for(const variant of ['missing','private','old']){
  const f=fixture(true);t.after(()=>f.cleanup());
  if(variant==='missing')fs.unlinkSync(join(f.root,'core-space/policy.md'));
  if(variant==='private')writeFileSync(join(f.root,'user-space/values.yaml'),'sensitive: true\nrule: SYNTHETIC_PRIVATE_RULE');
  if(variant==='old'){const file=join(f.root,'core-space/scripts/lib/context-projection.mjs');writeFileSync(file,readFileSync(file,'utf8').replace('export const CONTEXT_COMPLETENESS_SCHEMA=1;',''));}
  const adapter=await createAipaAdapter(f.root),code=variant==='missing'?'required_context_unavailable':variant==='private'?'required_context_private':'context_contract_unsupported';
  await assert.rejects(()=>adapter.context({turns:[]},{input:'Synthetic input'},[]),error=>error.code===code&&!error.message.includes('SYNTHETIC_PRIVATE_RULE'));
 }
});
frameworkTest("Real Core privacy rules filter distillation record by record and withhold private tags and credentials",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());
 const day='2026-10-26',runtimeDir=join(f.base,'distillation-runtime');
 mkdirSync(join(f.root,'user-space/logs/hub/reports/daily'),{recursive:true});
 writeFileSync(join(f.root,'user-space/logs/hub/reports/daily',day+'.json'),JSON.stringify({fingerprint:'synthetic-core-policy'}));
 const adapter=await createAipaAdapter(f.root),events=[{data:'Synthetic permitted method'},{data:'token technical description'},{data:{api_key:'SYNTHETIC_CREDENTIAL'}},{data:'Tagged private',tags:['private']}];
 const {createMainDistillation}=await import('../lib/main-distillation.mjs');let prompt;
 const d=createMainDistillation({root:f.root,runtimeDir,consent:true,adapter:()=>adapter,reports:{sources:()=>({events,web:[]})},runner:async value=>{prompt=value;return '[]';}});
 const result=await d.run(day);
 assert.equal(result.privacy.accepted,1);assert.equal(result.privacy.blocked,3);
 assert.match(prompt,/Synthetic permitted method/);assert.doesNotMatch(prompt,/token technical|SYNTHETIC_CREDENTIAL|Tagged private/);
});
test("Required-context failures block before retrieval or model calls and preserve input and reasons",async t=>{
 let searches=0,models=0,contexts=0,blocked=true;
 const adapter={...fakeAdapter(),assertContextReady:()=>{if(blocked)throw Object.assign(Error('\u5fc5\u8fbe\u89c4\u5219\u6587\u4ef6\u7f3a\u5931；\u672c\u8f6e\u672a\u5916\u53d1'),{code:'required_context_unavailable',contextIssues:[{id:'file:core-space/policy.md',reason:'missing'}]});},context:async()=>{contexts++;return {prompt:'Synthetic',sources:[],omitted:0};}};
 const f=await running(t,{adapter,runner:async()=>{models++;return 'Must not run';},webFetcher:async()=>{searches++;throw Error('Must not search');}});await f.login();
 const chat=await(await f.request('/api/chats',{})).json(),profile=await(await f.request('/api/web-search/settings')).json();
 const response=await f.request(`/api/chats/${chat.id}/turns`,{id:randomUUID(),text:'Synthetic public input',consent:true,engine:'codex',allowWeb:true,searchQuery:'synthetic',webProfileVersion:profile.settings.revision});assert.equal(response.status,202);
 const turn=(await completed(f.request,chat.id)).turns[0];assert.equal(turn.status,'error');assert.equal(turn.input,'Synthetic public input');assert.equal(turn.errorCode,'required_context_unavailable');assert.equal(turn.contextIssues[0].reason,'missing');assert.equal(searches,0);assert.equal(models,0);assert.equal(contexts,0);
 blocked=false;assert.equal((await f.request(`/api/chats/${chat.id}/retry`,{id:turn.id,consent:true,engine:'codex'})).status,202);
 const retried=(await completed(f.request,chat.id)).turns[0];assert.equal(retried.status,'completed');assert.equal(retried.errorCode,undefined);assert.equal(retried.contextIssues,undefined);assert.equal(models,1);assert.equal(contexts,1);
});
frameworkTest("Rollback to older Core cannot downgrade versioned usage receipts into unversioned success",async t=>{
 for(const missing of ['memory-usage.mjs','search-output.mjs']){
  const f=fixture(true);t.after(()=>f.cleanup());fs.unlinkSync(join(f.root,'core-space/scripts/lib',missing));
  writeFileSync(join(f.root,'core-space/scripts/aipa-search.mjs'),'process.stdout.write("{}")');
  const adapter=await createAipaAdapter(f.root);
  await assert.rejects(()=>adapter.recordMemoryUse([{id:'synthetic-memory',body_hash:'a'.repeat(64)}],{receiptId:'synthetic-pending',at:'2026-10-25'}),/lacks body-version/i);
 }
});
frameworkTest("Legacy local-time events use the shared day boundary without filename or system-timezone guesses",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());const clock=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/day-clock.mjs')).href),events=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/event-store.mjs')).href);
 mkdirSync(join(f.root,'state/events'),{recursive:true});writeFileSync(join(f.root,'state/events/2026-10-24@synthetic.jsonl'),JSON.stringify({event_id:'synthetic-local-only',host:'synthetic',sid:'synthetic',type:'user_message',data:'Synthetic legacy work',ts_local:'2026-10-24 04:30:00'})+'\n');
 const reports=createMainReports({root:f.root,runtimeDir:join(f.base,'reports'),nodes:{list:()=>[],operations:()=>[]},clock:()=>clock.createBusinessClock(f.root),eventContract:()=>events});
 for(const hour of [4,6]){writeFileSync(join(f.root,'user-space/llm-provider.yaml'),`day_start_hour: ${hour}\ntime_zone: Asia/Shanghai\n`);assert.equal(reports.sources('2026-10-24').events.length,hour===4?1:0);assert.equal(reports.sources('2026-10-23').events.length,hour===6?1:0);assert.equal(clock.todayKey(f.root,{ts:events.readEvents(f.root)[0].ts_local}),hour===4?'2026-10-24':'2026-10-23');}
});
frameworkTest("Cross-date divergent events remain pending in Core and Hub even when one side is archived",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());
 const events=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/event-store.mjs')).href),archive=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/event-archive.mjs')).href),daily=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/daily-note.mjs')).href);
 const dir=join(f.root,'state/events');mkdirSync(dir,{recursive:true});
 const a={event_id:'synthetic-cross-day',host:'synthetic-review',sid:'synthetic',type:'user_message',data:'Synthetic A',ts:'2026-10-24T08:00:00Z',ts_local:'2026-10-24 16:00:00'},b={...a,data:'Synthetic B',ts:'2026-10-25T08:00:00Z',ts_local:'2026-10-25 16:00:00'};
 for(const row of [a,b])writeFileSync(join(dir,row.ts.slice(0,10)+'@synthetic-review.jsonl'),JSON.stringify(row)+'\n');
 const adapter=await createAipaAdapter(f.root),reports=createMainReports({root:f.root,runtimeDir:join(f.base,'reports'),nodes:{list:()=>[],operations:()=>[]},eventContract:()=>adapter.eventContract});
 for(const day of ['2026-10-24','2026-10-25'])assert.equal(reports.sources(day).events.length,0);
 mkdirSync(join(f.root,'user-space/logs/daily'),{recursive:true});writeFileSync(join(f.root,'user-space/logs/daily/DAILY-NOTE_2026-10-24.md'),'## \u65f6\u95f4\u7ebf\n'+daily.timelineLine(a)+'\n## \u603b\u7ed3\nSynthetic\n');
 assert.equal(archive.pruneEvents(f.root,{cutoff:'2026-10-25',apply:true}).pruned,1);assert.equal(events.readEvents(f.root).length,0);assert.equal(reports.sources('2026-10-25').events.length,0);
});
frameworkTest("Sensitive metadata is withheld and project history never crosses model scopes",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());
 const source=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/memory-source.mjs')).href),meta=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/memory-meta.mjs')).href);
 const file=join(f.root,'user-space/memory/preferences.md');writeFileSync(file,'## Private choice\nSYNTHETIC_METADATA_ONLY_PRIVATE_CHOICE\n');const entry=source.memoryRecords(source.readMemorySources(f.root))[0];
 writeFileSync(join(f.root,'user-space/memory/memory-meta.json'),JSON.stringify({version:1,entries:{[entry.id]:{file:entry.file,body_hash:meta.bodyHash(entry.body),sensitive:true}}}));
 const adapter=await createAipaAdapter(f.root),chat={project:'synthetic-a',turns:[{id:'old',status:'completed',project:'synthetic-a',input:'SYNTHETIC_OTHER_PROJECT_HISTORY',answer:'Other project answer'}]};
 const context=await adapter.context(chat,{id:'current',project:'synthetic-b',input:'Private choice'},[]);
 assert.ok(!context.prompt.includes(entry.body));assert.ok(!context.prompt.includes('SYNTHETIC_OTHER_PROJECT_HISTORY'));assert.ok(!context.memoryUse.includes(entry.id));
});
test("HTTP persists project bindings, checks retry projects, and recovers receipts after restart without model replay",async t=>{
 const f=fixture();let hub,models=0,receipts=0,fail=true,captured,blocked=false;const runtimeDir=join(f.base,'runtime');t.after(async()=>{await hub?.close();f.cleanup();});
 const adapter={...fakeAdapter(),projectScope:true,projects:()=>[{id:'synthetic-a'}],context:async(chat,turn)=>{captured={chat:chat.project,turn:turn.project};assert.equal(hub.store.readChat(chat.id).turns[0].status,'running');return {prompt:'Synthetic',sources:[],omitted:0,memoryUse:['synthetic-memory'],memoryReceipt:{project:turn.project,at:'2026-10-25',entries:[{id:'synthetic-memory',body_hash:'a'.repeat(64)}]}};},recordMemoryUse:async(entries,options)=>{receipts++;assert.equal(options.project,'synthetic-a');assert.equal(entries[0].body_hash,'a'.repeat(64));if(fail)throw Error('Synthetic transient failure');}};
 const make=async()=>{const value=await createHub({root:f.root,runtimeDir,port:0,adapter,runner:async()=>{models++;const turn=hub.store.listChats()[0].turns[0];assert.equal(turn.memoryReceipt.status,'awaiting-answer');return 'Synthetic answer';}});value.scheduler.start=()=>{};return value;};
 adapter.coreRuntimeStatus=()=>blocked?{status:'blocked',code:'core_restart_required',summary:'Synthetic blocked Core'}:{status:'ready'};
 hub=await make();let url=await hub.listen();let cookie;
 const login=async()=>{const response=await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'});cookie=response.headers.get('set-cookie').split(';')[0];};await login();
 const request=(path,body)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const chat=await(await request('/api/chats',{project:'synthetic-a'})).json();assert.equal(chat.project,'synthetic-a');
 assert.equal((await request('/api/chats',{project:'../escape'})).status,400);
 const input={id:randomUUID(),text:'Synthetic input',engine:'codex',consent:true};assert.equal((await request('/api/chats/'+chat.id+'/turns',input)).status,202);
 let turn=(await completed(request,chat.id)).turns[0];assert.equal(turn.status,'completed');assert.equal(turn.memoryReceipt.status,'pending');assert.ok(turn.warnings.includes("Answer generated; memory usage receipt registration incomplete"));assert.deepEqual(captured,{chat:'synthetic-a',turn:'synthetic-a'});
 assert.equal((await request('/api/chats/'+chat.id+'/turns',{...input,project:'synthetic-b'})).status,409);assert.equal(models,1);
 await hub.close();hub=null;blocked=true;hub=await make();url=await hub.listen();assert.equal((await fetch(url+'/readyz')).status,503);assert.equal(receipts,1);await hub.close();hub=null;
 blocked=false;fail=false;hub=await make();url=await hub.listen();await login();turn=(await(await request('/api/chats/'+chat.id)).json()).turns[0];assert.equal(turn.memoryReceipt.status,'delivered');assert.equal(turn.warnings.length,0);assert.equal(models,1);assert.equal(receipts,2);
});
frameworkTest("Event batch identity and digest calculations avoid file reads; Core changes reject new batches",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());const adapter=await createAipaAdapter(f.root),contract=adapter.eventContract;
 const row={host:'synthetic-host',sid:'synthetic-session',event_id:'synthetic-id',type:'user_message',data:'Synthetic event',ts:'2026-10-24T08:00:00Z'};
 const key=contract.eventIdentity(row),hash=contract.eventContentHash(row);
 const mocked=t.mock.method(fs,'readFileSync',()=>assert.fail('Pure event calculation must not read files'));
 syncBuiltinESMExports();
 try{for(let i=0;i<1000;i++){assert.equal(contract.eventIdentity(row),key);assert.equal(contract.eventContentHash(row),hash);}}
 finally{mocked.mock.restore();syncBuiltinESMExports();}
 const path=join(f.root,'core-space/scripts/lib/event-store.mjs');writeFileSync(path,readFileSync(path,'utf8')+'\n// synthetic upgrade\n');
 assert.throws(()=>adapter.eventContract,{code:'core_restart_required'});
});
frameworkTest("Core code changes block readiness and APIs before model calls; restoring the original version resumes", async t => {
 const f=fixture(true); let calls=0,hub; t.after(async()=>{await hub?.close();f.cleanup();});
 hub=await createHub({root:f.root,runtimeDir:join(f.base,'runtime'),port:0,runner:async()=>{calls++;return 'synthetic';},newsFetcher:async()=>assert.fail('Blocked Core must not fetch news')});
 hub.scheduler.start=()=>{};
 const url=await hub.listen();
 const login=await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'});
 const headers={Origin:url,'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]};
 assert.equal((await fetch(url+'/readyz')).status,200);
 const leaf=join(f.root,'core-space/scripts/lib/safe-path.mjs'),original=readFileSync(leaf);
 writeFileSync(leaf,original.toString()+'\n// synthetic upgraded dependency\n');
 const ready=await fetch(url+'/readyz'); assert.equal(ready.status,503); assert.equal((await ready.json()).core.code,'core_restart_required');
 const status=await(await fetch(url+'/api/status',{headers})).json(); assert.equal(status.core.status,'blocked');
 hub.scheduler.configure('daily-briefing',{enabled:true,dailyAt:'08:00',timeZone:'Asia/Shanghai'}); await hub.scheduler.runNow('daily-briefing');
 assert.equal(hub.scheduler.list().find(t=>t.id==='daily-briefing').result.code,'core_restart_required');
 const note=await fetch(url+'/api/notes',{method:'POST',headers,body:JSON.stringify({id:randomUUID(),text:'Synthetic preserved in client'})});
 assert.equal(note.status,503); assert.equal(calls,0); assert.equal(hub.store.listNotes().length,0);
 await assert.rejects(()=>createAipaAdapter(f.root),{code:'core_restart_required'});
 writeFileSync(leaf,original);
 assert.equal((await fetch(url+'/readyz')).status,200);
 const saved=await fetch(url+'/api/notes',{method:'POST',headers,body:JSON.stringify({id:randomUUID(),text:'Synthetic recovered'})});
 assert.equal(saved.status,200); assert.equal((await saved.json()).text,'Synthetic recovered'); assert.equal(calls,0);
 assert.equal(hub.store.listNotes().length,1);
});
frameworkTest("Native agenda provider preserves Core bytes and schema 2 reads after uninstall and rejects drift",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());mkdirSync(join(f.root,'.git'));
 const files=['agenda-records.mjs','reminders.mjs','reminder-plugin.mjs','agenda-provider.mjs','agenda-interface.json'];
 const before=files.map(name=>readFileSync(join(f.root,'core-space/scripts/lib',name),'utf8'));
 const configFile=join(f.base,'provider-config.json'),runtimeDir=join(f.base,'provider-runtime');writeFileSync(configFile,JSON.stringify({root:f.root,runtimeDir}));
 const installed=installAgendaIntegration({configFile});assert.equal(installed.native,true);assert.equal(installed.files,2);assert.equal(agendaCapability(f.root).ready,true);
 assert.deepEqual(files.map(name=>readFileSync(join(f.root,'core-space/scripts/lib',name),'utf8')),before);
 mkdirSync(join(f.root,'user-space/reminders'));writeFileSync(join(f.root,'user-space/reminders/synthetic-day.json'),JSON.stringify({schema:2,id:'synthetic-day',title:'Synthetic day',status:'open',all_day:true,start_date:'2026-10-24',time_zone:'Asia/Shanghai',remind_at:'2026-10-23T15:00:00Z'}));
 restoreAgendaIntegration({configFile,backup:installed.backup});assert.equal(agendaCapability(f.root).ready,true);
 const readers=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/reminders.mjs')).href);assert.equal(readers.listDueReminders(f.root,'2026-10-24T00:00:00Z').length,1);
 writeFileSync(join(f.root,'core-space/scripts/lib/reminders.mjs'),before[1]+'\n// synthetic drift\n');
 assert.equal(agendaCapability(f.root).ready,false);assert.throws(()=>installAgendaIntegration({configFile}),/changed/i);
});
frameworkTest("Context construction does not register use before final answer delivery", async () => {
  const f=fixture(true);
  try {
    const adapter=await createAipaAdapter(f.root),context=await adapter.context({turns:[]},{input:'\u56de\u7b54\u98ce\u683c'},[]);
    assert.ok(context.memoryUse.length>0);const decay=join(f.root,'state/memory-decay.json');
    assert.equal(existsSync(decay),false);await adapter.recordMemoryUse(context.memoryUse);assert.equal(existsSync(decay),true);
  } finally { f.cleanup(); }
});
frameworkTest("IDE and Hub share rule projection and idempotent final body-version usage receipts",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());
 const projector=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/context-projection.mjs')).href);
 writeFileSync(join(f.root,'user-space/memory/instructions.md'),'## Format\nSynthetic rule: use numbered conclusions.\n');
 const adapter=await createAipaAdapter(f.root),context=await adapter.context({turns:[]},{id:'synthetic-turn',input:'\u56de\u7b54\u98ce\u683c'},[]);
 const ide=projector.projectContext(f.root,{host:'ide'});
 assert.deepEqual(context.contextProjection.sections.map(s=>s.id).sort(),ide.sections.filter(s=>s.kind!=='host-protocol').map(s=>s.id).sort());
 assert.match(context.prompt,/use numbered conclusions/);assert.equal(context.contextProjection.capabilities.execution,'disabled');
 const receipt=context.memoryReceipt;assert.ok(receipt.entries.length>0);await adapter.recordMemoryUse(receipt.entries,{receiptId:'synthetic-hub-receipt',project:receipt.project,at:receipt.at});
 await adapter.recordMemoryUse(receipt.entries,{receiptId:'synthetic-hub-receipt',project:receipt.project,at:receipt.at});
 const growth=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/growth-feedback.mjs')).href);
 assert.equal(growth.growthSummary(f.root).counts.retrieved,receipt.entries.length);
 writeFileSync(join(f.root,'user-space/memory/instructions.md'),'## Format\nCorrected synthetic rule.\n');
 await assert.rejects(()=>adapter.recordMemoryUse(receipt.entries,{receiptId:'different-hub-receipt',project:receipt.project,at:receipt.at}));
});
frameworkTest("Reports share Core day boundaries and event conflict identities and revise history after boundary changes",async t=>{
 const f=fixture(true);t.after(()=>f.cleanup());
 const clock=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/day-clock.mjs')).href),events=await import(pathToFileURL(join(f.root,'core-space/scripts/lib/event-store.mjs')).href);
 for(const host of ['Synthetic-Host','invalid_host',''])for(const shard of [true,false]){
  const sample={host:'Synthetic-Own',sid:'synthetic-session',event_id:'synthetic-id',type:'user_message',data:{a:1,b:2},ts:'2026-10-24T08:00:00Z',ts_local:'2026-10-24 16:00:00'};
  assert.equal(eventMirror.eventIdentity(sample,host,{shard}),events.eventIdentity(sample,host,{shard}));assert.equal(eventMirror.eventContentHash(sample),events.eventContentHash(sample));
 }
 const sameId=[{host:'synthetic-one',sid:'one',event_id:'shared',data:'one'},{host:'synthetic-two',sid:'two',event_id:'shared',data:'two'}];
 assert.equal(quarantineEventRows(Buffer.from(JSON.stringify(sameId[0])+'\n'),Buffer.from(JSON.stringify(sameId[1])+'\n')).trim().split('\n').length,2);
 writeFileSync(join(f.root,'user-space/llm-provider.yaml'),'day_start_hour: 4\ntime_zone: Asia/Shanghai\n');
 const dir=join(f.root,'state/events');mkdirSync(dir,{recursive:true});
 const row={event_id:'synthetic-clock-event',host:'synthetic-clock',sid:'synthetic',type:'user_message',data:'Synthetic work',ts:'2026-10-23T20:30:00Z',ts_local:'2026-10-24 04:30:00'};
 writeFileSync(join(dir,'2026-10-24@synthetic-clock.jsonl'),JSON.stringify(row)+'\n');
 const reports=createMainReports({root:f.root,runtimeDir:join(f.base,'report-runtime'),nodes:{list:()=>[],operations:()=>[]},clock:()=>clock.createBusinessClock(f.root),eventContract:()=>events,now:()=>Date.parse('2026-10-25T10:00:00Z')});
 await reports.daily('2026-10-24');await reports.period('monthly','2026-10');assert.equal(reports.sources('2026-10-24').events.length,1);
 writeFileSync(join(f.root,'user-space/llm-provider.yaml'),'day_start_hour: 6\ntime_zone: Asia/Shanghai\n');
 assert.equal(reports.sources('2026-10-24').events.length,0);assert.equal(reports.sources('2026-10-23').events.length,1);
 await reports.tick();assert.ok(reports.read('daily','2026-10-24').metadata.revision>=2);
 const month=reports.read('monthly','2026-10').metadata;assert.equal(month.covered.find(d=>d.day==='2026-10-24').revision,reports.read('daily','2026-10-24').metadata.revision);
 writeFileSync(join(dir,'2026-10-23@synthetic-clock.jsonl'),JSON.stringify({...row,data:'Contradictory synthetic work'})+'\n');
 assert.equal(events.readEvents(f.root).length,0);assert.equal(reports.sources('2026-10-23').events.length,0);assert.ok(reports.sources('2026-10-23').malformed.length>0);
 mkdirSync(join(f.root,'.git'));writeFileSync(join(f.root,'user-space/llm-provider.yaml'),'day_start_hour: 6\ntime_zone: America/New_York\n');
 const zonedHub=await createHub({root:f.root,runtimeDir:join(f.base,'supported-clock'),main:{enabled:true},runner:async()=>assert.fail('No model in clock validation')});
 try{assert.equal(zonedHub.reports.clockSettings().timeZone,'America/New_York');assert.ok(zonedHub.scheduler.list().filter(task=>task.dailyAt).every(task=>task.timeZone==='America/New_York'));}finally{await zonedHub.close();}
});
const TMP = join(REPO, 'aipa-test-tmp');
mkdirSync(TMP, { recursive: true });
function fixture(realScripts = false) {
  const base = mkdtempSync(join(TMP, 'hub-'));
  const root = join(base, 'instance');
  mkdirSync(join(root, 'user-space', 'memory'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'AIPA-MANIFEST.yaml'), 'aipa:\n  owner: Example\n  version: 0.23.0\n');
  writeFileSync(join(root, 'state', 'host-id'), 'hub-test');
  writeFileSync(join(root, 'user-space', 'privacy.yaml'), 'upload_policy:\n  mode: ask\n  block_tags: [private, sensitive]\n');
  writeFileSync(join(root, 'user-space', 'profile.yaml'), 'owner: Example\nstyle: \u7ed3\u8bba\u5148\u884c\n');
  if (realScripts) {
    cpSync(FRAMEWORK, join(root, 'core-space', 'scripts'), { recursive: true });
    writeFileSync(join(root,'core-space/policy.md'),'Synthetic framework guard');
    writeFileSync(join(root,'core-space/host-protocol.md'),'Synthetic execution protocol');
    for(const project of ['synthetic-a','synthetic-b']){mkdirSync(join(root,'user-space/projects',project),{recursive:true});writeFileSync(join(root,'user-space/projects',project,'project.yaml'),'name: Synthetic project');}
    writeFileSync(join(root, 'user-space', 'memory', 'preferences.md'), '# \u504f\u597d\n\n## \u56de\u7b54\u98ce\u683c\n- \u559c\u6b22\u7ed3\u8bba\u5148\u884c，\u51cf\u5c11\u5ba2\u5957。\n');
  }
  return { root, base, cleanup() {
    const target = resolve(base);
    assert.ok(target.startsWith(resolve(TMP) + sep) && target !== resolve(TMP), "Recursive cleanup is limited to this test directory");
    rmSync(target, { recursive: true, force: true });
  } };
}
function fakeAdapter() {
  return { owner: 'Example', version: '0.23.0', requiresConsent: () => true, begin: async () => null,
    record: async () => null, search: async () => [],
    context: async (_chat, turn) => ({ prompt: turn.input, sources: [], omitted: 0 }),
  };
}
async function running(t, options = {}) {
  const f = fixture();
  const runner = async input => { await delay(20); return `\u5df2\u6536\u5230：${input}`; };
  const hub = await createHub({ root: f.root, runtimeDir: join(f.base, 'runtime'), adapter: fakeAdapter(), runner, port: 0, hostname: 'hub-test.example.ts.net', ...options });
  const url = await hub.listen();
  t.after(async () => { await hub.close(); f.cleanup(); });
  let cookie = '';
  const request = async (path, body, extra = {}, target = url) => {
    const response = await new Promise((resolveResponse, reject) => {
      const call = httpRequest(target + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: url }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      }, result => {
        const chunks = []; result.on('data', chunk => chunks.push(chunk));
        result.on('end', () => resolveResponse(new Response(Buffer.concat(chunks), { status: result.statusCode, headers: result.headers })));
      });
      call.on('error', reject); call.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const requestPublic = (path, body, extra = {}) => {
    const origin = new URL(options.publicOrigins[0]);
    return request(path, body, { Host: origin.host, Origin: origin.origin, ...extra }, `http://127.0.0.1:${hub.publicServer.address().port}`);
  };
  return { hub, url, f, request, requestPublic, login: () => request('/api/local-login', {}) };
}
async function completed(request, id) {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const chat = await (await request(`/api/chats/${id}`)).json();
    if (chat.turns.length && !['queued', 'running'].includes(chat.turns.at(-1).status)) return chat;
    await delay(50);
  }
  throw new Error('\u6d4b\u8bd5\u4efb\u52a1\u6ca1\u6709\u5b8c\u6210');
}

test("Empty receipt checks succeed on a five-minute schedule without inventing delivery times",async t=>{
 const f=await running(t);
 assert.equal((await f.request('/api/tasks/memory-receipts/run',{})).status,401);
 await f.login();
 assert.equal((await f.request('/api/tasks/memory-receipts/run',{}, {Origin:'https://untrusted.example'})).status,403);
 assert.equal((await f.request('/api/tasks/memory-receipts/run',{})).status,202);
 const result=await f.hub.scheduler.runNow('memory-receipts');
 assert.equal(result.status,'success');assert.equal(result.code,'no_pending_receipts');assert.equal(result.pending,0);assert.equal(result.delivered,0);assert.equal(result.silent,true);
 const task=f.hub.scheduler.list().find(task=>task.id==='memory-receipts');
 assert.ok(task.lastSuccessAt);assert.equal(task.lastDeliveredAt,undefined);
 assert.ok(Math.abs(Date.parse(task.nextRunAt)-Date.parse(task.lastFinishedAt)-300000)<100);
 assert.match(task.history.at(-1).summary,/no pending receipts/i);
});

test("Failed pending receipts survive and later recover only delivery with actual timestamps",async t=>{
 let failed=true,deliveries=0,models=0;
 const f=await running(t,{adapter:{...fakeAdapter(),recordMemoryUse:async()=>{deliveries++;if(failed)throw Error('synthetic failure');}},runner:async()=>{models++;return 'must not run';}});
 const chat=f.hub.store.createChat();
 chat.turns.push({id:'receipt-turn',status:'completed',input:'Synthetic',answer:'Preserved answer',memoryReceipt:{id:'synthetic-receipt',status:'pending',entries:[{id:'memory',body_hash:'b'.repeat(64)}]}});
 f.hub.store.saveChat(chat);
 assert.equal((await f.hub.scheduler.runNow('memory-receipts')).status,'partial');
 assert.equal(f.hub.store.readChat(chat.id).turns[0].memoryReceipt.status,'pending');
 failed=false;assert.equal((await f.hub.scheduler.runNow('memory-receipts')).code,'receipts_delivered');
 assert.ok(f.hub.scheduler.list().find(task=>task.id==='memory-receipts').lastDeliveredAt);
 await f.hub.scheduler.runNow('memory-receipts');assert.equal(deliveries,2);assert.equal(models,0);
 assert.equal(f.hub.store.readChat(chat.id).turns[0].answer,'Preserved answer');
});

test("Privacy-blocked questions never trigger search or model calls and input remains preserved", async t => {
  const actualFetch = globalThis.fetch; let searches = 0, modelCalls = 0, contexts = 0;
  globalThis.fetch = async (...args) => { searches++; return new Response('<html></html>'); };
  let f;
  try {
    const adapter = { ...fakeAdapter(), allowedContent: () => false, context: async () => { contexts++; throw new Error('\u9690\u79c1\u89c4\u5219\u963b\u6b62'); } };
    f = await running(t, { adapter, runner: async () => { modelCalls++; return 'must not run'; } });
  } finally { globalThis.fetch = actualFetch; }
  await f.login(); const chat = await (await f.request('/api/chats', {})).json();
  const input = 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_SEND';
  const profile = await (await f.request('/api/web-search/settings')).json();
  await f.request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: input, consent: true, engine: 'codex', allowWeb: true, searchQuery: 'public query', webProfileVersion: profile.settings.revision });
  const result = (await completed(f.request, chat.id)).turns[0];
  assert.equal(result.status, 'error'); assert.match(result.error, /privacy rules/i);
  assert.equal(result.input, input); assert.equal(searches, 0); assert.equal(modelCalls, 0); assert.equal(contexts, 0);
});

test("Web sends independent queries only; duplicate IDs cannot replace web choices and configuration changes require consent", async t => {
  const calls=[];
  const f=await running(t,{ webFetcher:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({results:[{title:'\u6765\u6e90',url:'https://example.org/news',snippet:'\u53d6\u5f97\u7684\u6458\u8981'}]}));} });
  await f.login();
  const settings=await (await f.request('/api/web-search/settings',{provider:'deepseek',apiKey:'synthetic-only'})).json();
  const chat=await (await f.request('/api/chats',{})).json();
  const body={id:randomUUID(),text:'\u8fd9\u662f\u53ea\u5141\u8bb8\u7ed9\u56de\u7b54\u6a21\u578b\u7684\u5b8c\u6574\u4e0a\u4e0b\u6587，\u4e0d\u5e94\u5f53\u53d1\u9001\u7ed9\u641c\u7d22\u670d\u52a1',engine:'codex',consent:true,allowWeb:true,searchQuery:'public topic',webProfileVersion:settings.settings.revision};
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,body)).status,202);
  const done=await completed(f.request,chat.id); assert.equal(done.turns[0].status,'completed');
  assert.deepEqual(calls[0].body,{query:'public topic',count:6,need_content:false});
  assert.equal(done.turns[0].searchQuery,'public topic');
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,body)).status,200);
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,{...body,searchQuery:'changed'})).status,409);
  await f.request('/api/web-search/settings',{provider:'bing'});
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,{...body,id:randomUUID()})).status,428);
  assert.equal(calls.length,1);
});

test("Web connection checks require sign-in, Origin, version, and explicit consent; model and image capabilities are verifiable",async t=>{
  let calls=0;const f=await running(t,{webFetcher:async()=>{calls++;return new Response(JSON.stringify({results:[]}));}});
  assert.equal((await f.request('/api/web-search/check',{live:true})).status,401);await f.login();
  const profile=await(await f.request('/api/web-search/settings',{provider:'deepseek',apiKey:'test'})).json();
  assert.equal((await f.request('/api/web-search/check',{})).status,200);assert.equal(calls,0);
  const check={live:true,consent:true,webProfileVersion:profile.settings.revision};
  assert.equal((await f.request('/api/web-search/check',check,{Origin:'https://wrong.example'})).status,403);
  assert.equal((await f.request('/api/web-search/check',{...check,consent:false})).status,428);
  assert.equal((await f.request('/api/web-search/check',check)).status,200);assert.equal(calls,1);
  const status=await(await f.request('/api/status')).json(),chat=await(await f.request('/api/chats',{})).json();
  const body={id:randomUUID(),text:'test',engine:'codex',consent:true,modelProfileVersion:'stale'};
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,body)).status,428);
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,{...body,modelProfileVersion:status.modelProfileVersion,attachmentIds:['image-001']})).status,400);
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,{...body,modelProfileVersion:status.modelProfileVersion})).status,202);
  const finished=await completed(f.request,chat.id);assert.equal(finished.turns[0].model.version,status.modelProfileVersion);
});

test("Search authentication failures return gateway errors without expiring Hub sessions or exposing upstream content",async t=>{
  const f=await running(t,{webFetcher:async()=>new Response('SECRET_UPSTREAM_BODY',{status:401})});
  await f.login();
  const profile=await(await f.request('/api/web-search/settings',{provider:'deepseek',apiKey:'synthetic-key'})).json();
  const response=await f.request('/api/web-search/check',{live:true,consent:true,webProfileVersion:profile.settings.revision});
  assert.equal(response.status,502);
  const body=await response.text();assert.match(body,/401/);assert.doesNotMatch(body,/SECRET_UPSTREAM_BODY|synthetic-key/);
  assert.equal((await f.request('/api/status')).status,200);
});

test("Single-entry questions generate displayed search terms idempotently; offline and manual modes skip planning",async t=>{
  const searches=[];let plans=0,answers=0;
  const f=await running(t,{runner:async prompt=>{if(prompt.startsWith('Generate one minimal public-topic search query')){plans++;return '{"query":"DeepSeek Search \u5b98\u65b9\u6587\u6863"}';}answers++;return 'answer';},webFetcher:async(_url,init)=>{searches.push(JSON.parse(init.body).query);return new Response(JSON.stringify({results:[]}));}});
  await f.login();const settings=await(await f.request('/api/web-search/settings',{provider:'deepseek',apiKey:'fixture'})).json();
  const chat=await(await f.request('/api/chats',{})).json(),body={id:randomUUID(),text:'\u8bf7\u5e2e\u6211\u4e86\u89e3DeepSeek\u7684\u8054\u7f51\u63a5\u53e3\u600e\u4e48\u4f7f\u7528',engine:'codex',consent:true,allowWeb:true,webProfileVersion:settings.settings.revision};
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,body)).status,202);
  const turn=(await completed(f.request,chat.id)).turns[0];assert.equal(turn.status,'completed');assert.equal(turn.searchQuery,'');assert.equal(turn.webQuery.query,'DeepSeek Search \u5b98\u65b9\u6587\u6863');assert.deepEqual(searches,['DeepSeek Search \u5b98\u65b9\u6587\u6863']);
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,body)).status,200);assert.equal(plans,1);
  assert.equal((await f.request(`/api/chats/${chat.id}/turns`,{...body,searchQuery:'changed'})).status,409);
  await f.request(`/api/chats/${chat.id}/turns`,{...body,id:randomUUID(),allowWeb:false});await completed(f.request,chat.id);assert.equal(plans,1);assert.equal(answers,2);
});

test("Failed or private automatic queries never send the original question as fallback and answers disclose degradation",async t=>{
  for(const planned of ['invalid','{"query":"13812345678"}']){
    let searches=0;const f=await running(t,{runner:async prompt=>prompt.startsWith('Generate one minimal public-topic search query')?planned:'local answer',webFetcher:async()=>{searches++;throw new Error('must not search');}});
    await f.login();const settings=await(await f.request('/api/web-search/settings')).json(),chat=await(await f.request('/api/chats',{})).json();
    await f.request(`/api/chats/${chat.id}/turns`,{id:randomUUID(),text:'public question',engine:'codex',consent:true,allowWeb:true,webProfileVersion:settings.settings.revision});
    const turn=(await completed(f.request,chat.id)).turns[0];assert.equal(turn.status,'completed');assert.equal(turn.webQuery.status,'failed');assert.ok(turn.warnings.some(w=>w.includes("Web search incomplete")));assert.equal(searches,0);
  }
});

test("Web settings reuse official DeepSeek credentials without repeated key entry and support automatic queries",async t=>{
  const names=['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN'];const previous=names.map(k=>process.env[k]);
  process.env.ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic';process.env.ANTHROPIC_AUTH_TOKEN='fixture-model-key';
  try{
    let calls=0;const f=await running(t,{engine:'claude',runner:async prompt=>prompt.startsWith('Generate one minimal public-topic search query')?'{"query":"DeepSeek \u5b98\u65b9\u6587\u6863"}':'answer',webFetcher:async(_url,init)=>{calls++;assert.equal(init.headers.Authorization,'Bearer fixture-model-key');return new Response(JSON.stringify({results:[]}));}});
    await f.login();const settings=await(await f.request('/api/web-search/settings',{provider:'deepseek'})).json();
    assert.equal(settings.settings.credentialSource,'model');assert.equal(settings.ready,true);assert.doesNotMatch(JSON.stringify(settings),/fixture-model-key/);
    const chat=await(await f.request('/api/chats',{})).json();await f.request(`/api/chats/${chat.id}/turns`,{id:randomUUID(),text:'DeepSeek\u63a5\u53e3\u662f\u4ec0\u4e48',engine:'claude',consent:true,allowWeb:true,webProfileVersion:settings.settings.revision});
    assert.equal((await completed(f.request,chat.id)).turns[0].status,'completed');assert.equal(calls,1);
  }finally{names.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
});

test("Scheduled task status requires pairing; manual execution checks Origin and rejects disabled tasks", async t => {
  const { request, login } = await running(t);
  assert.equal((await request('/api/tasks')).status, 401);
  assert.equal((await request('/api/tasks/repo-sync/run', {})).status, 401);
  await login();
  const task = (await (await request('/api/tasks')).json()).tasks[0];
  assert.equal(task.id, 'repo-sync'); assert.equal(task.intervalMinutes, 30); assert.equal(task.enabled, false);
  assert.equal((await request('/api/tasks/repo-sync/run', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/tasks/repo-sync/run', {})).status, 409);
  assert.equal((await request('/api/tasks/arbitrary-command/run', {})).status, 404);
});

test("Hiding and restoring chats change display markers only and preserve original conversation bytes and events", async t => {
  let records = 0; const adapter = fakeAdapter(); adapter.record = async () => { records++; return null; };
  const { request, login, hub, f } = await running(t, { adapter });
  assert.equal((await request('/api/chats/unknown-id/visibility', { hidden: true })).status, 401);
  await login(); const chat = await (await request('/api/chats', {})).json();
  await request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: '\u6d4b\u8bd5\u95ee\u7b54\u5fc5\u987b\u4fdd\u7559', consent: true, engine: 'codex' });
  await completed(request, chat.id); await delay(20);
  const path = join(f.root, 'user-space', 'logs', 'hub', 'conversations', `${chat.id}.json`), original = readFileSync(path), before = records;
  assert.equal((await request(`/api/chats/${chat.id}/visibility`, { hidden: true }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(`/api/chats/${chat.id}/visibility`, { hidden: 'true' })).status, 400);
  assert.equal((await request('/api/chats/unknown-id/visibility', { hidden: true })).status, 404);
  assert.equal((await request(`/api/chats/${chat.id}/visibility`, { hidden: true })).status, 200);
  assert.equal((await request(`/api/chats/${chat.id}/visibility`, { hidden: true })).status, 200);
  assert.equal((await (await request('/api/chats')).json()).chats.length, 0);
  assert.equal((await (await request('/api/chats?visibility=hidden')).json()).chats[0].id, chat.id);
  assert.equal((await request(`/api/chats/${chat.id}`)).status, 200, "Hiding a list entry is not deletion or a permission change");
  assert.deepEqual(readFileSync(path), original); assert.equal(records, before);
  assert.equal(createChatVisibility(hub.runtimeDir).hiddenIds().has(chat.id), true, "New service instances read the same durable visibility markers");
  assert.equal((await request(`/api/chats/${chat.id}/visibility`, { hidden: false })).status, 200);
  assert.equal((await (await request('/api/chats')).json()).chats[0].id, chat.id);
  assert.equal((await (await request('/api/chats?visibility=hidden')).json()).chats.length, 0);
  assert.deepEqual(readFileSync(path), original); assert.equal(records, before);
});

test("Bottom navigation allows zero pins, filters unknown or duplicate features, and recovers corrupt preferences", () => {
  assert.deepEqual(normalisePins([]), []);
  assert.deepEqual(normalisePins(['pushes', 'unknown', 'tasks', 'pushes']), ['pushes', 'tasks']);
  assert.deepEqual(normalisePins(null), [...DEFAULT_PINS]);
  assert.deepEqual(normalisePins({ command: 'arbitrary' }), [...DEFAULT_PINS]);
});

test("Notification APIs require pairing and registered sources; news persists in the instance and inbox read state", async t => {
  let calls = 0;
  const { request, login, hub } = await running(t, {
    briefing: { enabled: false, categories: ['economy'], sourceIds: ['cns-finance'], interests: "Economy" },
    newsFetcher: async () => new Response(`<rss><channel><item><title>\u7ecf\u6d4e\u65b0\u8fdb\u5c55</title><link>https://www.chinanews.com.cn/cj/example.shtml</link><description>\u516c\u5f00\u7684\u7ecf\u6d4e\u8d44\u8baf\u6458\u8981。</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`),
    runner: async () => { calls++; return JSON.stringify({ intro: '\u7ecf\u6d4e\u7b80\u62a5', items: [{ id: 'n1', summary: '\u516c\u5f00\u6765\u6e90\u62a5\u9053\u4e86\u65b0\u7684\u7ecf\u6d4e\u8fdb\u5c55。' }] }); },
  });
  assert.equal((await request('/api/pushes')).status, 401);
  assert.equal((await request('/api/pushes/daily-briefing/run', {})).status, 401);
  await login();
  const { settings } = await (await request('/api/briefing-settings')).json();
  assert.equal((await request('/api/briefing-settings', { ...settings, sourceIds: ['http://127.0.0.1'] })).status, 400);
  assert.equal((await request('/api/briefing-settings', { ...settings, enabled: true }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/briefing-settings', { ...settings, enabled: true })).status, 200);
  assert.equal((await request('/api/pushes/daily-briefing/run', {})).status, 202);
  let data;
  for (let i = 0; i < 100; i++) { data = await (await request('/api/pushes')).json(); if (data.pushes.length) break; await delay(10); }
  assert.equal(data.unread, 1); const item = data.pushes[0]; assert.equal(item.type, 'daily-briefing');
  const push = await (await request(`/api/pushes/${item.id}`)).json();
  const report = await (await request(`/api/briefings/${push.payload.day}`)).json();
  assert.match(report.sections[0].items[0].url, /^https:\/\/www.chinanews.com.cn/);
  assert.equal((await request(`/api/pushes/${item.id}/read`, {})).status, 200);
  assert.equal((await (await request('/api/pushes')).json()).unread, 0);
  await hub.scheduler.runNow('daily-briefing'); assert.equal(calls, 1); assert.equal(hub.store.listPushes().length, 1);
  assert.equal((await request('/api/pushes/arbitrary-command/run', {})).status, 404);
});

test("News and conversations share a serialized model runner and defer synchronization during generation", async t => {
  let entered, release, active = 0, maxActive = 0;
  const started = new Promise(r => entered = r), held = new Promise(r => release = r);
  const { request, login, hub } = await running(t, {
    briefing: { enabled: false, categories: ['economy'], sourceIds: ['cns-finance'], interests: '' },
    tasks: { 'repo-sync': { enabled: true } },
    newsFetcher: async () => new Response(`<rss><channel><item><title>\u7ecf\u6d4e\u8d44\u8baf</title><link>https://www.chinanews.com.cn/cj/example.shtml</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`),
    runner: async prompt => {
      active++; maxActive = Math.max(maxActive, active);
      try { if (prompt.includes('You edit a personal daily news briefing')) { entered(); await held; return JSON.stringify({ intro: '\u7b80\u62a5', items: [{ id: 'n1', summary: '\u6458\u8981。' }] }); } return '\u5bf9\u8bdd\u56de\u7b54'; }
      finally { active--; }
    },
  });
  await hub.scheduler.runNow('repo-sync');
  await login(); const { settings } = await (await request('/api/briefing-settings')).json();
  await request('/api/briefing-settings', { ...settings, enabled: true });
  const producing = hub.scheduler.runNow('daily-briefing'); await started;
  try {
    assert.equal((await hub.scheduler.runNow('repo-sync')).status, 'deferred');
    const chat = await (await request('/api/chats', {})).json();
    await request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: '\u4f60\u597d', consent: true, engine: 'codex' });
    await delay(10); assert.equal(active, 1); release(); await producing;
    assert.equal((await completed(request, chat.id)).turns[0].answer, '\u5bf9\u8bdd\u56de\u7b54'); assert.equal(maxActive, 1);
  } finally { release(); }
});

test("Model execution defers sync while polling and input records remain readable", async t => {
  let release, entered;
  const ready = new Promise(resolve => entered = resolve);
  const { request, login, hub } = await running(t, { tasks: { 'repo-sync': { enabled: true, intervalMinutes: 60 } }, runner: async () => { entered(); await new Promise(resolve => release = resolve); return 'done'; } });
  await hub.scheduler.runNow('repo-sync');
  await login(); const chat = await (await request('/api/chats', {})).json();
  await request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: '\u4fdd\u7559\u539f\u59cb\u8f93\u5165', consent: true, engine: 'codex' });
  await ready;
  try {
    const result = await hub.scheduler.runNow('repo-sync'); assert.equal(result.status, 'deferred');
    const current = await (await request(`/api/chats/${chat.id}`)).json(); assert.equal(current.turns[0].status, 'running'); assert.equal(current.turns[0].input, '\u4fdd\u7559\u539f\u59cb\u8f93\u5165');
    assert.equal((await (await request('/api/tasks')).json()).tasks[0].status, 'deferred');
  } finally { release(); }
  assert.equal((await completed(request, chat.id)).turns[0].status, 'completed');
});

test("Private APIs require sign-in and reject cross-site POST, unknown Host, and remote local-entry authentication", async t => {
  const { request, login } = await running(t);
  assert.equal((await request('/api/chats')).status, 401);
  for (const path of ['/markdown.js', '/vendor/marked.esm.js', '/vendor/purify.es.mjs']) {
    const asset = await request(path);
    assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  }
  assert.equal((await request('/api/local-login', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/healthz', undefined, { Host: 'untrusted.example' })).status, 403);
  assert.equal((await request('/api/local-login', {}, { Host: 'hub-test.example.ts.net', Origin: 'https://hub-test.example.ts.net' })).status, 403);
  assert.equal((await request('/api/local-login', {}, { 'X-Forwarded-For': '100.64.0.10' })).status, 403);
  assert.equal((await login()).status, 200);
  assert.equal((await request('/api/status')).status, 200);
  const privatePair = await request('/api/pairing', undefined, { Host: 'hub-test.example.ts.net' });
  assert.equal(privatePair.status, 403);
  assert.equal((await request('/api/pairing', undefined, { 'X-Forwarded-For': '100.64.0.10' })).status, 403);
});

test("Phone pairing, HttpOnly sessions, and logout work correctly", async t => {
  const { request, login } = await running(t);
  await login();
  const { code } = await (await request('/api/pairing')).json();
  await request('/api/logout', {});
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/login', { code: 'wrong-code' })).status, 401);
  const paired = await request('/api/login', { code }, { Host: 'hub-test.example.ts.net', Origin: 'https://hub-test.example.ts.net' });
  assert.equal(paired.status, 200);
  assert.match(paired.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(paired.headers.get('set-cookie'), /; Secure/);
  assert.equal((await request('/api/status')).status, 200);
});

test("Tunnel requests require remote pairing; forged localhost, proxy headers, and ports cannot acquire local privileges", async t => {
  const origin = 'https://hub.example.com:2443';
  const { request, requestPublic, login, hub } = await running(t, { publicOrigins: [origin, 'https://203.0.113.10:2443'], publicPort: 0 });
  assert.equal(hub.publicServer.address().address, '127.0.0.1');
  assert.equal((await requestPublic('/healthz')).status, 200);
  assert.equal((await requestPublic('/api/chats')).status, 401);
  assert.equal((await requestPublic('/api/local-login', {})).status, 403);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal((await requestPublic('/api/local-login', {}, { Host: host, Origin: `http://${host}` })).status, 403);
    assert.equal((await requestPublic('/healthz', undefined, { Host: host })).status, 403);
  }
  assert.equal((await requestPublic('/api/local-login', {}, { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Host': 'localhost', 'X-Forwarded-Proto': 'http' })).status, 403);
  assert.equal((await requestPublic('/healthz', undefined, { Host: 'hub.example.com:2444' })).status, 403);
  assert.equal((await requestPublic('/healthz', undefined, { Host: 'hub.example.com:2443/ignored' })).status, 403);
  assert.equal((await requestPublic('/healthz', undefined, { Host: '203.0.113.10:2443' })).status, 200);
  await login();
  const pairing = await (await request('/api/pairing')).json();
  assert.equal(pairing.remoteUrl, origin); assert.equal(pairing.connectionMode, 'public');
  assert.equal((await requestPublic('/api/pairing')).status, 403);
  await request('/api/logout', {});
  const paired = await requestPublic('/api/login', { code: pairing.code });
  assert.equal(paired.status, 200); assert.match(paired.headers.get('set-cookie'), /; Secure/);
  const status = await (await requestPublic('/api/status')).json();
  assert.equal(status.local, false); assert.equal(status.remoteUrl, origin); assert.equal(status.connectionMode, 'public');
  assert.equal((await requestPublic('/api/pairing')).status, 403);
  assert.equal((await requestPublic('/api/chats', {}, { Origin: 'https://hub.example.com:2444' })).status, 403);
  const chat = await (await requestPublic('/api/chats', {})).json();
  assert.ok(chat.id);
  const tailStatus = await (await request('/api/status', undefined, { Host: 'hub-test.example.ts.net' })).json();
  assert.equal(tailStatus.connectionMode, 'tailscale');
});

test("Public entry settings reject plaintext, wildcards, userinfo, paths, and incomplete ports", async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const base = { root: f.root, runtimeDir: join(f.base, 'runtime'), adapter: fakeAdapter(), runner: async () => 'unused', port: 0 };
  for (const origin of ['http://hub.example.com', 'https://*.example.com', 'https://user:pass@hub.example.com', 'https://hub.example.com/path', 'https://hub.example.com?x=1', 'https://hub.example.com#x', 'https://127.0.0.1:4319', 'https://localhost', 'https://hub.example.com\\@evil.example']) {
    await assert.rejects(createHub({ ...base, publicOrigins: [origin], publicPort: 0 }), /public entry|public access/i);
  }
  await assert.rejects(createHub({ ...base, publicOrigins: 'https://hub.example.com' }), /publicOrigins/);
  await assert.rejects(createHub({ ...base, publicOrigins: ['https://hub.example.com'] }), /both/i);
  await assert.rejects(createHub({ ...base, publicPort: 4319 }), /both/i);
  await assert.rejects(createHub({ ...base, publicOrigins: ['https://hub.example.com'], publicPort: -1 }), /valid port/i);
});

test("Input is saved before execution and deduplicated; refresh recovers the complete conversation", async t => {
  let release;
  const runner = input => new Promise(resolveRun => { release = () => resolveRun(`\u56de\u7b54：${input}`); });
  const { request, login, hub, f } = await running(t, { runner });
  await login();
  const chat = await (await request('/api/chats', {})).json();
  const body = { id: randomUUID(), text: '\u8bf7\u5e2e\u6211\u6574\u7406\u601d\u8def', consent: true, engine: 'codex' };
  assert.equal((await request(`/api/chats/${chat.id}/turns`, body)).status, 202);
  assert.equal(hub.store.readChat(chat.id).turns[0].input, body.text);
  const duplicate = await (await request(`/api/chats/${chat.id}/turns`, body)).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(hub.store.readChat(chat.id).turns.length, 1);
  await assert.rejects(createHub({ root: f.root, runtimeDir: hub.runtimeDir, adapter: fakeAdapter(), runner, port: 0 }), /Hub is already running/i);
  assert.ok(['queued', 'running'].includes(hub.store.readChat(chat.id).turns[0].status));
  await delay(10); release();
  const done = await completed(request, chat.id);
  assert.equal(done.turns[0].answer, `\u56de\u7b54：${body.text}`);
  assert.equal(done.turns[0].status, 'completed');
  assert.equal((await request(`/api/chats/${chat.id}/turns`, { ...body, text: '\u53e6\u4e00\u4e2a\u5185\u5bb9' })).status, 409);
});

test("Outbound consent is required; notes save independently without duplicate records", async t => {
  const { request, login, hub } = await running(t);
  await login(); const chat = await (await request('/api/chats', {})).json();
  assert.equal((await request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: '\u4f60\u597d', engine: 'codex' })).status, 428);
  assert.equal((await request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: '\u4f60\u597d', consent: true, engine: 'claude' })).status, 428);
  const body = { id: randomUUID(), text: '<script>alert(1)</script> \u5148\u4fdd\u5b58\u539f\u6587' };
  assert.equal((await request('/api/notes', body)).status, 200);
  assert.equal((await request('/api/notes', body)).status, 200);
  assert.equal(hub.store.listNotes().length, 1);
  assert.match(readFileSync(join(hub.store.base, 'notes', `${body.id}.md`), 'utf8'), /<script>/);
  assert.equal((await request('/api/notes', { id: '../../outside', text: 'bad' })).status, 400);
  assert.equal((await request('/api/notes', { ...body, text: '\u4e0d\u540c\u7684\u5185\u5bb9' })).status, 409);
});

test("Restart marks unfinished requests retryable without losing input or replaying models", t => {
  const f = fixture(); t.after(() => f.cleanup());
  const store = createStore(f.root), chat = store.createChat();
  chat.turns.push({ id: randomUUID(), input: '\u672a\u5b8c\u6210\u7684\u8bf7\u6c42', status: 'running' }); store.saveChat(chat);
  const path = join(store.base, 'conversations', `${chat.id}.json`);
  writeFileSync(path, '\uFEFF' + readFileSync(path, 'utf8'));
  const restored = createStore(f.root).readChat(chat.id);
  assert.equal(restored.turns[0].input, '\u672a\u5b8c\u6210\u7684\u8bf7\u6c42');
  assert.equal(restored.turns[0].status, 'interrupted');
});

frameworkTest("Real AIPA retrieval, privacy filtering, and raw event registration preserve framework files", async t => {
  const f = fixture(true); let hub;
  t.after(async () => { if (hub) await hub.close(); f.cleanup(); });
  const adapter = await createAipaAdapter(f.root);
  assert.ok(termsOf('\u6211\u5e0c\u671b\u56de\u7b54\u98ce\u683c\u66f4\u7b80\u77ed\u4e00\u4e9b').includes('\u56de\u7b54'));
  const hits = await adapter.search('\u56de\u7b54\u98ce\u683c');
  assert.ok(hits.some(h => h.body.includes('\u7ed3\u8bba\u5148\u884c')));
  const chat = { id: randomUUID(), turns: [] };
  const turn = { id: randomUUID(), input: '\u56de\u7b54\u98ce\u683c' };
  const context = await adapter.context(chat, turn, [{ id: 'private123', text: '\u56de\u7b54\u98ce\u683c sensitive: true', title: '\u9690\u85cf\u8d44\u6599', tags: ['private'] }]);
  assert.match(context.prompt, /\u7ed3\u8bba\u5148\u884c/);
  assert.doesNotMatch(context.prompt, /\u9690\u85cf\u8d44\u6599/);
  await assert.rejects(adapter.context(chat, { input: 'password=not-a-real-secret' }, []), /privacy rules/i);
  const noteText = 'AIPA Hub \u539f\u6587\u767b\u8bb0\u6d4b\u8bd5';
  assert.equal(await adapter.record('user_message', noteText, chat.id, 'hub-event-test'), null);
  const files = (await import(pathToFileURL(join(FRAMEWORK, 'lib', 'event-store.mjs')).href)).listEventFiles(f.root);
  assert.ok(files.some(file => readFileSync(file.path, 'utf8').includes(noteText)));
  hub = await createHub({ root: f.root, runtimeDir: join(f.base, 'runtime'), adapter, runner: async () => 'test', port: 0 });
  const url = await hub.listen();
  const login = await fetch(url + '/api/local-login', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const saved = await fetch(url + '/api/notes', { method: 'POST', headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), text: '\u968f\u624b\u8bb0\u5fc5\u987b\u7528\u5408\u6cd5\u7684 AIPA \u7528\u6237\u4e8b\u4ef6\u767b\u8bb0' }) });
  const savedNote = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedNote.warning, null);
});

test("Codex receives original stdin with intact Unicode chunks in read-only temporary sessions", async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const entry = join(f.base, 'fake-codex.js');
  writeFileSync(entry, `import fs from 'node:fs'; const input=fs.readFileSync(0,'utf8');\nif(!process.argv.includes('--ephemeral')||!process.argv.includes('read-only')||process.argv.includes(input))process.exit(3);\nconst data=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}})+'\\n');process.stdout.write(data.subarray(0,80));setTimeout(()=>process.stdout.write(data.subarray(80)),5);`);
  const runner = createCodexRunner({ entry, workDir: relative(process.cwd(), join(f.base, 'work')), timeoutMs: 3000 });
  const text = '\u5b8c\u6574\u4fdd\u7559\u4e2d\u6587，shell \u5b57\u7b26 ; $() & \u53ea\u662f\u6587\u672c';
  assert.equal(await runner(text), text);
});

test("Claude minimal mode disables tools and MCP and stores no sessions; original content travels only through stdin", async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const entry = join(f.base, 'fake-claude.js');
  writeFileSync(entry, `import fs from 'node:fs'; const input=fs.readFileSync(0,'utf8');const args=process.argv;\nif(!args.includes('--bare')||!args.includes('--strict-mcp-config')||!args.includes('--no-session-persistence')||args[args.indexOf('--tools')+1]!==''||args.includes(input))process.exit(3);\nprocess.stdout.write(JSON.stringify({is_error:false,result:input}));`);
  const runner = createClaudeRunner({ entry, workDir: join(f.base, 'work'), timeoutMs: 3000 });
  assert.equal(await runner('\u4fdd\u6301\u4e2d\u6587\u539f\u6587 ; $() &'), '\u4fdd\u6301\u4e2d\u6587\u539f\u6587 ; $() &');
});

test("Recall parses Monday-to-Sunday weeks, year boundaries, and explicit dates with visible range limits", () => {
  const last = resolveRecallRange('\u6211\u4e0a\u5468\u5b8c\u6210\u4e86\u54ea\u4e9b\u5de5\u4f5c？', '2026-10-15');
  assert.deepEqual(last.days, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.equal(resolveRecallRange('\u672c\u5468\u505a\u4e86\u4ec0\u4e48', '2026-10-15').from, '2026-10-12');
  assert.equal(resolveRecallRange('\u4e0a\u5468\u5de5\u4f5c', '2027-01-04').from, '2026-12-28');
  assert.equal(resolveRecallRange('\u4e0a\u5468\u5de5\u4f5c', '2027-01-04').to, '2027-01-03');
  assert.equal(resolveRecallRange('\u6700\u8fd17\u5929\u505a\u4e86\u4ec0\u4e48', '2026-10-15').from, '2026-10-09');
  assert.equal(resolveRecallRange('2026\u5e7410\u67088\u65e5\u505a\u4e86\u4ec0\u4e48', '2026-10-15').from, '2026-10-08');
  assert.equal(resolveRecallRange('\u56de\u7b54\u98ce\u683c', '2026-10-15'), null);
  assert.throws(() => resolveRecallRange('2026-02-30', '2026-10-15'), /valid date/i);
  const wide = resolveRecallRange('\u8fc7\u53bb100\u5929\u5de5\u4f5c', '2026-10-15');
  assert.equal(wide.days.length, 31); assert.equal(wide.limited, true);
  assert.equal(resolveRecallRange('\u4e0a\u6708\u5de5\u4f5c', '2026-10-15').report.value, '2026-09');
});

const fixedNow = () => new Date('2026-10-15T13:07:00Z');
function diary(root, day, summary, prefix = '') {
  const dir = join(root, 'user-space/logs/daily'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `DAILY-NOTE_${day}.md`), `${prefix}# DAILY-NOTE ${day}\n\n## \u65f6\u95f4\u7ebf（\u673a\u68b0\u751f\u6210）\n- [08:00] project · user_message: \u65e5\u62a5\u7684\u539f\u59cb\u65f6\u95f4\u7ebf\n\n## \u8981\u70b9\n\u9879\u76ee\u8fdb\u5c55\n\n## \u4eca\u65e5\u603b\u7ed3\n${summary}\n\n## \u76f8\u5173\u9879\u76ee\nproject\n`);
}

frameworkTest("Last-week recall reads all five daily reports without keyword dependence and HTTP persists coverage", async t => {
  const f = fixture(true); let hub;
  t.after(async () => { if (hub) await hub.close(); f.cleanup(); });
  for (const day of ['07', '08', '09', '10', '11']) diary(f.root, `2026-10-${day}`, `\u5b8c\u6210\u4e86\u9a8c\u6536\u9879 Z${day}。\u53e6\u4e00\u4e2a\u529f\u80fd\u4ecd\u5f85\u63d0\u4ea4。`);
  diary(f.root, '2026-10-12', '\u672c\u5468\u7684\u9a8c\u6536\u9879 W12，\u4e0d\u5c5e\u4e8e\u4e0a\u5468。');
  const adapter = await createAipaAdapter(f.root, { now: fixedNow });
  const context = await adapter.context({ turns: [] }, { input: '\u6211\u4e0a\u5468\u5b8c\u6210\u4e86\u54ea\u4e9b\u5de5\u4f5c？' }, []);
  assert.deepEqual(context.sources.filter(s => s.kind === 'daily').map(s => s.title), ['07', '08', '09', '10', '11'].map(day => `2026-10-${day} Daily summary`));
  assert.match(context.prompt, /Z07/); assert.match(context.prompt, /Z11/); assert.doesNotMatch(context.prompt, /W12/);
  assert.match(context.prompt, /Never infer an empty month from a few results/i);
  assert.equal(context.recall.days.filter(day => day.status === 'missing').length, 2);
  const search = await adapter.search('\u4e0a\u5468'); assert.equal(search.length, 5);
  let seenPrompt;
  hub = await createHub({ root: f.root, runtimeDir: join(f.base, 'runtime'), adapter, runner: async prompt => { seenPrompt = prompt; return '\u4f9d\u636e\u4e94\u4efd\u65e5\u62a5\u56de\u7b54'; }, port: 0 });
  const url = await hub.listen();
  const login = await fetch(url + '/api/local-login', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, body) => fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const chat = await (await request('/api/chats', {})).json();
  const response = await request(`/api/chats/${chat.id}/turns`, { id: randomUUID(), text: '\u6211\u4e0a\u5468\u5b8c\u6210\u4e86\u54ea\u4e9b\u5de5\u4f5c？', consent: true, engine: 'codex' });
  assert.equal(response.status, 202);
  const done = await completed(request, chat.id);
  assert.match(seenPrompt, /Z11/); assert.equal(done.turns[0].recall.from, '2026-10-05');
  assert.equal(done.turns[0].sources.filter(s => s.kind === 'daily').length, 5);
});

frameworkTest("Filtered auxiliary daily sections retain safe summaries without bypassing file or summary privacy markers", async t => {
  const f = fixture(true); t.after(() => f.cleanup());
  diary(f.root, '2026-10-14', '\u5b8c\u6210\u4e86\u8bbe\u5907\u8fc1\u79fb\u4e0e\u9a8c\u6536 S14，\u53e6\u6709\u4e00\u9879\u5c1a\u672a\u63d0\u4ea4。');
  const path = join(f.root, 'user-space/logs/daily/DAILY-NOTE_2026-10-14.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('\u9879\u76ee\u8fdb\u5c55', '\u666e\u901a\u8981\u70b9\n- token=synthetic-hidden-credential'));
  const adapter = await createAipaAdapter(f.root, { now: fixedNow });
  const context = await adapter.context({ turns: [] }, { input: '\u6628\u5929\u5e72\u4e86\u4ec0\u4e48，\u4ea7\u751f\u4e86\u4ec0\u4e48\u6210\u679c？' }, []);
  assert.match(context.prompt, /\u5b8c\u6210\u4e86\u8bbe\u5907\u8fc1\u79fb\u4e0e\u9a8c\u6536 S14/);
  assert.doesNotMatch(context.prompt, /synthetic-hidden-credential|\u666e\u901a\u8981\u70b9/);
  assert.equal(context.sources.filter(s => s.kind === 'daily').length, 1);
  const day = context.recall.days[0];
  assert.equal(day.status, 'summary'); assert.deepEqual(day.omittedSections, ["Highlights"]);
  assert.deepEqual(day.readSections, ["Daily summary", "Related projects"]); assert.equal(context.recall.omitted, 1);
  const hits = await adapter.search('\u6628\u5929'); assert.equal(hits.length, 1); assert.match(hits[0].body, /S14/);
  writeFileSync(path, 'sensitive: true\n' + readFileSync(path, 'utf8'));
  const privateFile = await adapter.context({ turns: [] }, { input: '\u6628\u5929\u5e72\u4e86\u4ec0\u4e48？' }, []);
  assert.equal(privateFile.recall.days[0].status, 'blocked'); assert.doesNotMatch(privateFile.prompt, /S14/);
  writeFileSync(path, readFileSync(path, 'utf8').replace('sensitive: true\n', '').replace('\u5b8c\u6210\u4e86\u8bbe\u5907\u8fc1\u79fb\u4e0e\u9a8c\u6536 S14，\u53e6\u6709\u4e00\u9879\u5c1a\u672a\u63d0\u4ea4。', 'password=synthetic-summary-secret'));
  const privateSummary = await adapter.context({ turns: [] }, { input: '\u6628\u5929\u5e72\u4e86\u4ec0\u4e48？' }, []);
  assert.equal(privateSummary.recall.days[0].status, 'blocked'); assert.doesNotMatch(privateSummary.prompt, /synthetic-summary-secret/);
});

frameworkTest("Missing daily reports use dual-source events, stable-ID deduplication, and privacy-safe excerpts under instance day boundaries", async t => {
  const f = fixture(true); t.after(() => f.cleanup());
  diary(f.root, '2026-10-12', '\u5b8c\u6210 A。password=synthetic-secret');
  diary(f.root, '2026-10-13', '\u8be5\u6587\u4ef6\u5df2\u6807\u654f\u611f。', 'tags: [private]\n');
  diary(f.root, '2026-10-14', '（\u5f85\u8865\u603b\u7ed3）');
  const oldDir = join(f.root, 'state/events'), newDir = join(f.root, 'state/hosts/device-a/events');
  mkdirSync(oldDir, { recursive: true }); mkdirSync(newDir, { recursive: true });
  const row = { host: 'device-a', sid: 'sid-a', event_id: 'stable-event', ts_local: '2026-10-15 10:00:00', type: 'assistant_message', data: '\u552f\u4e00\u7684\u9a8c\u6536\u6210\u679cE15', project: 'project-a' };
  writeFileSync(join(oldDir, '2026-10-15@device-a.jsonl'), JSON.stringify(row) + '\n');
  writeFileSync(join(newDir, '2026-10-15.jsonl'), [row,
    { ...row, event_id: 'night', ts_local: '2026-10-15 03:00:00', data: '\u51cc\u6668\u7684\u8bb0\u5f55\u5c5e\u4e8e\u5341\u56db\u65e5' },
    { ...row, event_id: 'private-event', data: 'token=synthetic-only' },
    { ...row, event_id: 'hub-event', tool: 'aipa-hub', data: '\u5148\u524d\u52a9\u624b\u5bf9\u6ca1\u6709\u8bb0\u5f55\u7684\u9519\u8bef\u65ad\u8a00' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const adapter = await createAipaAdapter(f.root, { now: fixedNow });
  const context = await adapter.context({ turns: [] }, { input: '\u672c\u5468\u5de5\u4f5c\u8fdb\u5c55' }, [{ id: 'private-note', created: fixedNow().toISOString(), text: '\u79c1\u6709\u7b14\u8bb0\u5185\u5bb9', tags: ['private'] }]);
  assert.match(context.prompt, /\u552f\u4e00\u7684\u9a8c\u6536\u6210\u679cE15/);
  assert.match(context.prompt, /\u51cc\u6668\u7684\u8bb0\u5f55\u5c5e\u4e8e\u5341\u56db\u65e5/);
  assert.equal(context.prompt.split('\u552f\u4e00\u7684\u9a8c\u6536\u6210\u679cE15').length - 1, 1);
  assert.doesNotMatch(context.prompt, /synthetic-secret|token=synthetic-only|\u8be5\u6587\u4ef6\u5df2\u6807\u654f\u611f|\u79c1\u6709\u7b14\u8bb0\u5185\u5bb9|\u5148\u524d\u52a9\u624b\u5bf9\u6ca1\u6709\u8bb0\u5f55\u7684\u9519\u8bef\u65ad\u8a00/);
  assert.equal(context.recall.days.find(day => day.date === '2026-10-12').status, 'blocked');
  assert.equal(context.recall.days.find(day => day.date === '2026-10-13').status, 'blocked');
  assert.equal(context.recall.days.find(day => day.date === '2026-10-14').status, 'events');
  assert.equal(context.recall.days.find(day => day.date === '2026-10-15').records, 1);
  assert.ok(context.recall.omitted >= 4);
});

frameworkTest("Relative dates use Asia/Shanghai and the instance 06:00 boundary; monthly reports take priority with explicit excerpt coverage", async t => {
  const f = fixture(true); t.after(() => f.cleanup());
  diary(f.root, '2026-10-14', '\u5341\u56db\u65e5\u8bb0\u5f55');
  const adapter = await createAipaAdapter(f.root, { now: () => new Date('2026-10-14T20:30:00Z') });
  const context = await adapter.context({ turns: [] }, { input: '\u4eca\u5929\u505a\u4e86\u4ec0\u4e48' }, []);
  assert.equal(context.recall.from, '2026-10-14');
  assert.match(context.prompt, /2026-10-15 04:30:00/);
  const monthly = join(f.root, 'user-space/logs/monthly'); mkdirSync(monthly, { recursive: true });
  writeFileSync(join(monthly, 'MONTHLY-REVIEW_2026-09.md'), '# \u4e5d\u6708\u6708\u62a5\n\u5b8c\u6210\u6708\u5ea6\u9a8c\u6536\n' + '\u6b63\u6587'.repeat(13000));
  const month = await adapter.context({ turns: [] }, { input: '\u4e0a\u6708\u5b8c\u6210\u4e86\u4ec0\u4e48' }, []);
  assert.equal(month.sources[0].kind, 'month');
  assert.equal(month.recall.from, '2026-09-01');
  assert.equal(month.recall.to, '2026-09-30');
  assert.equal(month.recall.truncated, true);
  assert.match(month.prompt, /\u5b8c\u6210\u6708\u5ea6\u9a8c\u6536/);
});
