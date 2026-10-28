import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createAgenda,validInstant,midnight,localDate} from '../lib/agenda.mjs';
import {createAgendaActions} from '../lib/agenda-actions.mjs';
import {createDailyDigest} from '../lib/daily-digest.mjs';
import {createPushService} from '../lib/pushes.mjs';
import {createStore,writeJson} from '../lib/storage.mjs';
import {createHub} from '../server.mjs';
import {createSubHub,subCommand} from '../sub-server.mjs';
import {runAgendaCommand} from '../lib/agenda-cli.mjs';
import {installAgendaIntegration,restoreAgendaIntegration} from '../lib/agenda-integration.mjs';
import {agendaWhen} from '../public/agenda.js';
import {agendaCapability,agendaWriteState} from '../lib/agenda-capability.mjs';
import {createTaskGate} from '../lib/task-gate.mjs';

const TMP=resolve('aipa-test-tmp');mkdirSync(TMP,{recursive:true});
const NOW=Date.parse('2030-10-23T07:00:00+08:00');
const fields=(day='2030-10-24',extra={})=>({title:'\u5408\u6210\u65e5\u7a0b',event_at:day+'T14:00:00+08:00',...extra});
function fixture(t){
  const base=mkdtempSync(join(TMP,'agenda-')),root=join(base,'instance'),runtimeDir=join(base,'runtime');mkdirSync(root);mkdirSync(runtimeDir);
  writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n  owner: Test\n');
  t.after(()=>{assert.ok(resolve(base).startsWith(TMP+sep));rmSync(base,{recursive:true,force:true});});
  return {root,runtimeDir,now:()=>NOW};
}
function add(agenda,f=fields()){return agenda.apply({action:'create',targetId:randomUUID(),fields:f},randomUUID());}
function prepareIntegration(f){
  if(!existsSync(join(f.root,'.git')))execFileSync('git',['init','--quiet',f.root]);
  const lib=join(f.root,'core-space/scripts/lib');mkdirSync(lib,{recursive:true});
  if(!existsSync(join(lib,'reminders.mjs')))writeFileSync(join(lib,'reminders.mjs'),"export function isExpired(reminder, nowMs) { return nowMs >= Date.parse(reminder.event_at)+86400000; }\n");
  if(!existsSync(join(lib,'reminder-plugin.mjs')))writeFileSync(join(lib,'reminder-plugin.mjs'),"export const sample = r => displayAt(r.event_at);\n");
  const configFile=join(f.runtimeDir,'agenda-integration-config.json');writeJson(configFile,{root:f.root,runtimeDir:f.runtimeDir});
  return {configFile,...installAgendaIntegration({configFile})};
}
const version={version:'agenda-model-v1'};
const request=(extra={})=>({id:randomUUID(),text:'\u8bf7\u8bb0\u5f55\u660e\u5929\u7684\u6d4b\u8bd5\u65e5\u7a0b',owner:'web',consent:true,modelProfileVersion:version.version,...extra});

test("Agenda selects the next three across months and paginates complete history including cancelled and completed items",t=>{
  const f=fixture(t),a=createAgenda(f);
  const rows=['2030-10-24','2030-10-25','2030-12-01','2031-02-01'].map((d,i)=>add(a,fields(d,{title:"Agenda"+i,priority:i===3?'high':'normal'})));
  assert.deepEqual(a.list({preview:true}).items.map(x=>x.id),rows.slice(0,3).map(x=>x.id));
  a.apply({action:'cancel',targetId:rows[0].id,expectedRevision:rows[0].revision},randomUUID());
  a.apply({action:'complete',targetId:rows[1].id,expectedRevision:rows[1].revision},randomUUID());
  assert.equal(a.list({preview:true}).items.length,2);
  const first=a.list({limit:2}),second=a.list({limit:2,offset:first.nextOffset});
  assert.equal(first.total,4);assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,4);
  assert.equal(a.list({status:'cancelled'}).total,1);
});
test("Legacy reminders remain readable; damaged records are visible and invalid paths, dates, and timezones are rejected",t=>{
  const f=fixture(t),a=createAgenda(f),dir=join(f.root,'user-space','reminders');mkdirSync(dir,{recursive:true});
  writeJson(join(dir,'legacy-one.json'),{schema:1,id:'legacy-one',title:'\u65e7\u63d0\u9192',event_at:'2030-10-25T10:00:00+08:00',remind_at:'2030-10-24T09:00:00+08:00',status:'open'});
  writeFileSync(join(dir,'broken.json'),'{');
  assert.equal(a.list({preview:true}).items[0].priority,'normal');assert.equal(a.list().invalid,1);
  assert.throws(()=>a.read('../../x'));assert.equal(validInstant('2030-02-30T12:00:00+08:00'),false);
  assert.equal(validInstant('2030-10-23 12:00'),false);
  assert.throws(()=>add(a,fields('2030-10-24',{time_zone:'bad/zone'})));
});
test("All-day, multiday, deadline, and active items sort using calendar dates rather than report business days",t=>{
  const f=fixture(t),a=createAgenda(f);
  const all=add(a,{title:'\u5168\u5929\u4e8b\u9879',all_day:true,start_date:'2030-10-23',end_date_exclusive:'2030-10-24'});
  add(a,fields('2030-10-23',{title:"In progress",event_at:'2030-10-23T06:00:00+08:00',end_at:'2030-10-23T09:00:00+08:00'}));
  const deadline=add(a,{title:'\u4eca\u65e5\u622a\u6b62',kind:'deadline',all_day:true,start_date:'2030-10-23'});
  assert.equal(a.list({preview:true}).items[0].id,all.id);
  assert.equal(a.list().items.find(x=>x.id===deadline.id).temporal,'upcoming');
  assert.equal(midnight('2030-10-23','Asia/Shanghai'),Date.parse('2030-10-23T00:00:00+08:00'));
  assert.equal(localDate(Date.parse('2030-10-22T17:00:00Z')),'2030-10-23');
  assert.equal(agendaWhen({all_day:true,kind:'deadline',start_date:'2030-10-23',end_date_exclusive:'2030-10-25'}),"2030-10-24 Due that day");
});
test("Revision conflicts and idempotent receipts prevent duplicate creation and stale confirmation deletion",t=>{
  const f=fixture(t),a=createAgenda(f),op=randomUUID(),plan={action:'create',targetId:randomUUID(),fields:fields()};
  const original=a.apply(plan,op);a.apply(plan,op);assert.equal(a.list().total,1);
  const changed=a.apply({action:'update',targetId:original.id,expectedRevision:original.revision,fields:{priority:'high'}},randomUUID());
  assert.throws(()=>a.apply({action:'cancel',targetId:original.id,expectedRevision:original.revision},randomUUID()),/changed/i);
  assert.equal(a.read(changed.id).status,'open');
});
test("LLM creation requires a proposal and confirmation; retries do not repeat model calls and cancellation preserves records",async t=>{
  const f=fixture(t);let calls=0,answer={action:'create',fields:fields(),needsConfirmation:true};
  const service=createAgendaActions({...f,profile:()=>version,runner:async()=>{calls++;return JSON.stringify(answer);}});
  const input=request(),op=await service.propose(input);assert.equal(op.status,'pending');assert.equal(service.agenda.list().total,0);
  assert.equal((await service.propose({...input,source:{at:'2030-10-24T00:00:00Z'}})).operationId,op.operationId);assert.equal(calls,1);
  const done=service.confirm({id:op.operationId,owner:'web',confirmed:true});assert.equal(done.status,'applied');
  service.confirm({id:op.operationId,owner:'web',confirmed:true});assert.equal(service.agenda.list().total,1);
  answer={action:'cancel',targetId:done.result.id,needsConfirmation:false};
  const cancelled=await service.propose(request({text:'\u53d6\u6d88\u8fd9\u4e2a\u660e\u786e\u7684\u65e5\u7a0b',targetId:done.result.id,action:'cancel'}));
  assert.equal(cancelled.result.status,'cancelled');assert.equal(service.agenda.list().total,1);assert.equal(service.agenda.list({preview:true}).total,0);
});
test("Ambiguous plans, invalid IDs, extra fields, model failures, and privacy blocks never write agenda records",async t=>{
  const f=fixture(t);let answer={action:'clarify',message:'\u8bf7\u95ee\u662f\u54ea\u4e00\u573a\u4f1a\u8bae？'};
  const service=createAgendaActions({...f,profile:()=>version,runner:async()=>JSON.stringify(answer)});
  assert.equal((await service.propose(request())).status,'clarify');
  answer={action:'cancel',targetId:'missing-id',needsConfirmation:false};await assert.rejects(service.propose(request()),/did not identify/i);
  answer={action:'create',fields:{...fields(),command:'danger'}};await assert.rejects(service.propose(request()),/field/i);
  const failed=createAgendaActions({...f,profile:()=>version,runner:async()=>{throw Error('private upstream details');}});
  await assert.rejects(failed.propose(request()),e=>!e.message.includes('private upstream'));
  const blocked=createAgendaActions({...f,profile:()=>version,allowed:()=>false,runner:async()=>assert.fail('No egress')});
  await assert.rejects(blocked.propose(request()),/privacy/i);assert.equal(service.agenda.list().total,0);
});
test("Model or record changes before confirmation reject stale operations",async t=>{
  const f=fixture(t),a=createAgenda(f),item=add(a);let current=version;
  const service=createAgendaActions({...f,profile:()=>current,runner:async()=>JSON.stringify({action:'cancel',targetId:item.id,needsConfirmation:true})});
  const op=await service.propose(request({text:'\u53d6\u6d88\u5408\u6210\u65e5\u7a0b'}));
  a.apply({action:'update',targetId:item.id,expectedRevision:item.revision,fields:{priority:'high'}},randomUUID());
  assert.throws(()=>service.confirm({id:op.operationId,owner:'web',confirmed:true}),/changed/i);
  current={version:'changed'};assert.throws(()=>service.confirm({id:op.operationId,owner:'web',confirmed:true}),/model configuration/i);
});
test("Agenda delivery is independent of news failures; silent updates preserve read state and historical snapshots",t=>{
  const f=fixture(t),agenda=createAgenda(f),store=createStore(f.root),pushes=createPushService({...f,store});
  pushes.register({id:'daily-briefing',label:'test',run:async()=>({})});
  const digest=createDailyDigest({...f,agenda,store,pushes,defaults:{enabled:true,dailyAt:'07:00'}});
  add(agenda);digest.snapshot('2030-10-23',{newsStatus:'failed',newsError:'\u516c\u5f00\u8d44\u8baf\u4e0d\u53ef\u7528'});
  const id='daily-briefing-2030-10-23';assert.equal(pushes.list().length,1);pushes.markRead(id);
  add(agenda,fields('2030-11-25'));digest.snapshot('2030-10-23',{newsStatus:'failed'});
  assert.equal(pushes.list()[0].unread,false);assert.equal(digest.report('2030-10-23').agenda.total,2);
  assert.equal(digest.report('2030-10-23').news,null);
  assert.ok(existsSync(join(f.root,'user-space','logs','hub','digests','2030-10-23.json')));
});
test("Real HTTP covers authentication, model consent, proposal confirmation, and complete agenda listing",{timeout:20000},async t=>{
  const f=fixture(t),adapter={owner:'Test',version:'0.23',requiresConsent:()=>true,allowedContent:()=>true,begin:async()=>null,record:async()=>null,context:async()=>({prompt:'normal',sources:[]})};
  execFileSync('git',['init','--quiet',f.root]);
  prepareIntegration(f);
  const hub=await createHub({...f,port:0,testMode:true,adapter,runner:async()=>JSON.stringify({action:'create',fields:fields('2035-10-25'),needsConfirmation:true})});
  await hub.listen();t.after(()=>{hub.server.closeAllConnections();return hub.close();});const origin=`http://127.0.0.1:${hub.server.address().port}`;
  const login=await fetch(origin+'/api/local-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const get=p=>fetch(origin+p,{headers:{Cookie:cookie}});
  const post=(p,v)=>fetch(origin+p,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(v)});
  assert.equal((await fetch(origin+'/api/agenda')).status,401);
  const status=await (await get('/api/status')).json();
  assert.equal((await post('/api/agenda/actions',{text:'\u8bb0\u5f55\u65e5\u7a0b'})).status,428);
  const proposed=await post('/api/agenda/actions',{id:randomUUID(),text:'\u8bb0\u5f552035\u5e7410\u670825\u65e5\u6d4b\u8bd5',consent:true,modelProfileVersion:status.modelProfileVersion});assert.equal(proposed.status,202);
  const op=await proposed.json();assert.equal((await (await get('/api/agenda')).json()).total,0);
  assert.equal((await post('/api/agenda/confirm',{id:op.operationId,confirmed:true})).status,200);
  assert.equal((await (await get('/api/agenda?mode=preview')).json()).items.length,1);
  assert.equal((await (await get('/api/agenda')).json()).total,1);
});

test("Sub Hub IPC reuses host model plans and task ownership through the CLI without exposing HTTP",async t=>{
  const f=fixture(t);execFileSync('git',['init','--quiet',f.root]);
  const lib=join(f.root,'core-space','scripts','lib');mkdirSync(lib,{recursive:true});
  writeFileSync(join(lib,'privacy-policy.mjs'),"export const loadPrivacyPolicy=()=>({}); export const privacyDecision=()=> 'allow';");
  prepareIntegration(f);
  let calls=0;const config={...f,nodeId:'agenda-test-node',installationId:randomUUID(),token:'synthetic-device-credential',mainUrl:'http://127.0.0.1:9',testMode:true,runner:async()=>{calls++;throw Error('Host judgement should be reused');}};
  const sub=await createSubHub(config);await sub.listen();t.after(()=>sub.close());await sub.cycle();await sub.sync.request();
  const lease=await subCommand(f.runtimeDir,'task-start',{pid:process.pid});assert.ok(lease);
  const blocked=await runAgendaCommand({config,command:'propose',text:'\u65b0\u589e\u6d4b\u8bd5\u65e5\u7a0b',consent:true,hostModel:'codex',hostProposal:{action:'create',fields:fields('2035-11-01')}});
  assert.equal(blocked.status,'deferred');
  const status=await subCommand(f.runtimeDir,'status');
  const op=await subCommand(f.runtimeDir,'agenda-propose',{id:randomUUID(),text:'\u65b0\u589e\u6d4b\u8bd5\u65e5\u7a0b',consent:true,modelProfileVersion:status.model.version,hostModel:'codex',hostProposal:{action:'create',fields:fields('2035-11-01')},leaseToken:lease.token});
  assert.equal(op.status,'pending');
  const done=await subCommand(f.runtimeDir,'agenda-confirm',{id:op.operationId,confirmed:true,leaseToken:lease.token});assert.equal(done.status,'applied');
  const listed=await subCommand(f.runtimeDir,'agenda-list',{leaseToken:lease.token});assert.equal(listed.total,1);assert.equal(calls,0);
  writeJson(join(f.runtimeDir,'agenda-write-control.json'),{enabled:false});
  const pendingCancel=await subCommand(f.runtimeDir,'agenda-propose',{id:randomUUID(),text:'\u53d6\u6d88\u8fd9\u9879\u5408\u6210\u65e5\u7a0b',targetId:done.result.id,agendaAction:'cancel',consent:true,modelProfileVersion:status.model.version,hostModel:'codex',hostProposal:{action:'cancel',targetId:done.result.id,needsConfirmation:false},leaseToken:lease.token});
  assert.equal(pendingCancel.status,'pending');assert.match(pendingCancel.warning,/paused/i);
  writeJson(join(f.runtimeDir,'agenda-write-control.json'),{enabled:true});
  const resumed=await subCommand(f.runtimeDir,'agenda-confirm',{id:pendingCancel.operationId,confirmed:true,leaseToken:lease.token});assert.equal(resumed.status,'applied');assert.equal(resumed.warning,null);assert.equal(resumed.result.status,'cancelled');
  assert.equal(sub.status().task.token,lease.token,"Must not release the outer task lease");await subCommand(f.runtimeDir,'task-end',{lockToken:lease.token});
});

test("Instance bridge installation backs up files and checks framework compatibility and duplicate installation",t=>{
  const f=fixture(t);execFileSync('git',['init','--quiet',f.root]);
  const lib=join(f.root,'core-space','scripts','lib');mkdirSync(lib,{recursive:true});
  writeFileSync(join(lib,'reminders.mjs'),"export function isExpired(reminder, nowMs) {\n return nowMs >= Date.parse(reminder.event_at)+86400000;\n}\n");
  writeFileSync(join(lib,'reminder-plugin.mjs'),"export const sample = r => displayAt(r.event_at);\n");
  const configFile=join(f.runtimeDir,'config.json');writeJson(configFile,{root:f.root,runtimeDir:f.runtimeDir,nodeId:'test-node'});
  const first=installAgendaIntegration({configFile});assert.equal(first.installed,true);assert.ok(existsSync(join(first.backup,'restore.json')));
  const installed=readFileSync(join(lib,'reminders.mjs'),'utf8');assert.match(installed,/normalizeHubAgenda/);
  installAgendaIntegration({configFile});assert.equal(readFileSync(join(lib,'reminders.mjs'),'utf8'),installed);
  assert.ok(existsSync(join(f.root,'core-space','scripts','aipa-agenda.mjs')));
  assert.match(readFileSync(join(f.root,'user-space','skills','work','aipa-remind','SKILL.md'),'utf8'),/host model|host judgment/i);
  const third=installAgendaIntegration({configFile});restoreAgendaIntegration({configFile,backup:third.backup});
  restoreAgendaIntegration({configFile,backup:first.backup});
  assert.equal(existsSync(join(f.root,'core-space','scripts','aipa-agenda.mjs')),false);
  assert.doesNotMatch(readFileSync(join(lib,'reminders.mjs'),'utf8'),/normalizeHubAgenda/);
});

test("Private tags and sensitive markers stay out of model candidates; provider errors remain private",async t=>{
  const f=fixture(t),a=createAgenda(f),r=add(a,fields('2030-10-25',{title:'\u5408\u6210\u79c1\u5bc6\u5185\u5bb9'}));
  const path=join(f.root,'user-space','reminders',r.id+'.json');writeJson(path,{...a.raw(r.id),tags:['private']});
  const service=createAgendaActions({...f,profile:()=>version,allowed:(_text,tags=[])=>!tags.includes('private'),runner:async prompt=>{assert.doesNotMatch(prompt,/\u5408\u6210\u79c1\u5bc6\u5185\u5bb9/);return '{"action":"no_action"}';}});
  assert.equal((await service.propose(request())).status,'no_action');
  const failed=createAgendaActions({...f,profile:()=>version,runner:async()=>{throw Object.assign(Error('private credential detail'),{status:401});}});
  await assert.rejects(failed.propose(request()),e=>e.status===502&&!e.message.includes('credential'));
});
test("Audit directory failures cannot misreport a saved agenda action as failed",async t=>{
  const f=fixture(t),service=createAgendaActions({...f,profile:()=>version,runner:async()=>JSON.stringify({action:'create',fields:fields()})});
  const op=await service.propose(request());const dir=join(f.root,'user-space','logs','hub');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'agenda'),'synthetic obstruction');
  const done=service.confirm({id:op.operationId,owner:'web',confirmed:true});assert.equal(done.status,'applied');assert.match(done.warning,/audit/i);assert.equal(service.agenda.list().total,1);
  assert.equal(service.confirm({id:op.operationId,owner:'web',confirmed:true}).status,'applied');
});

test("Rescheduling explicitly resolves reminders before field merging for timed, all-day, deadline, and idempotent actions",async t=>{
  const f=fixture(t),a=createAgenda(f);
  const item=add(a,fields('2030-10-24',{remind_at:'2030-10-24T13:50:00+08:00'}));
  let patch={event_at:'2030-10-25T14:00:00+08:00'};
  const service=createAgendaActions({...f,profile:()=>version,runner:async()=>JSON.stringify({action:'update',targetId:item.id,fields:patch,needsConfirmation:true})});
  await assert.rejects(service.propose(request({targetId:item.id})),/explicitly.*reminder/i);
  assert.equal(a.read(item.id).event_at,item.event_at);
  assert.throws(()=>a.apply({action:'update',targetId:item.id,expectedRevision:item.revision,fields:patch},randomUUID()),/explicitly.*reminder/i);
  patch={...patch,remind_at:'2030-10-25T13:50:00+08:00'};
  const op=await service.propose(request({targetId:item.id})),done=service.confirm({id:op.operationId,owner:'web',confirmed:true});
  assert.equal(done.result.remind_at,patch.remind_at);assert.equal(service.confirm({id:op.operationId,owner:'web',confirmed:true}).result.revision,done.result.revision);
  const kept=a.apply({action:'update',targetId:item.id,expectedRevision:done.result.revision,fields:{event_at:'2030-10-26T14:00:00+08:00',remind_at:patch.remind_at}},randomUUID());assert.equal(kept.remind_at,patch.remind_at);
  const cleared=a.apply({action:'update',targetId:item.id,expectedRevision:kept.revision,fields:{event_at:'2030-10-27T14:00:00+08:00',remind_at:null}},randomUUID());assert.equal(cleared.remind_at,null);
  for(const kind of ['event','deadline']){
    const day=add(a,{title:'\u5408\u6210\u5168\u5929',kind,all_day:true,start_date:'2030-10-24',remind_at:'2030-10-23T20:00:00+08:00'});
    assert.throws(()=>a.apply({action:'update',targetId:day.id,expectedRevision:day.revision,fields:{start_date:'2030-10-25',end_date_exclusive:'2030-10-26'}},randomUUID()),/explicitly.*reminder/i);
    assert.throws(()=>a.apply({action:'update',targetId:day.id,expectedRevision:day.revision,fields:{time_zone:'Asia/Tokyo'}},randomUUID()),/explicitly.*reminder/i);
  }
});

test("Web confirmation rejects missing, changed, or paused consumers; original proposals continue after installation",async t=>{
  const f=fixture(t);execFileSync('git',['init','--quiet',f.root]);
  const adapter={owner:'Test',version:'0.23',requiresConsent:()=>true,allowedContent:()=>true,record:async()=>null};
  const hub=await createHub({...f,port:0,testMode:true,adapter,agenda:{enabled:false},runner:async()=>JSON.stringify({action:'create',fields:fields('2035-10-25'),needsConfirmation:true})});
  await new Promise(r=>hub.server.listen(0,'127.0.0.1',r));t.after(()=>{hub.server.closeAllConnections();return hub.close();});
  const origin=`http://127.0.0.1:${hub.server.address().port}`,login=await fetch(origin+'/api/local-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const api=(p,b)=>fetch(origin+p,{method:b?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
  const profile=await (await api('/api/status')).json();
  const proposed=await (await api('/api/agenda/actions',{id:randomUUID(),text:'\u65b0\u589e\u5408\u6210\u65e5\u7a0b',consent:true,modelProfileVersion:profile.modelProfileVersion})).json();
  const confirm=()=>api('/api/agenda/confirm',{id:proposed.operationId,confirmed:true});
  assert.equal((await confirm()).status,428);assert.equal(hub.agendaActions.agenda.list().total,0);assert.equal(hub.agendaActions.get(proposed.operationId,'web').status,'pending');
  const lib=join(f.root,'core-space/scripts/lib');mkdirSync(lib,{recursive:true});writeFileSync(join(lib,'reminders.mjs'),"export function isExpired(reminder, nowMs) { return nowMs>=Date.parse(reminder.event_at)+86400000; }\n");
  assert.equal((await confirm()).status,428,"Legacy consumers do not establish compatibility");
  prepareIntegration(f);assert.equal(agendaCapability(f.root).ready,true);
  assert.equal(agendaWriteState({...f,enabled:false}).writable,false,"Configuration can independently disable writes");
  const consumer=join(lib,'reminders.mjs'),bytes=readFileSync(consumer);writeFileSync(consumer,Buffer.concat([bytes,Buffer.from('// changed\n')]));
  assert.equal((await confirm()).status,428,"Consumer digest changes must reject");writeFileSync(consumer,bytes);
  writeJson(join(f.runtimeDir,'agenda-write-control.json'),{enabled:false});assert.equal((await confirm()).status,428);
  writeJson(join(f.runtimeDir,'agenda-write-control.json'),{enabled:true});assert.equal((await confirm()).status,200);
  assert.equal(hub.agendaActions.agenda.list().total,1);assert.equal((await confirm()).status,200,"Applied receipts are idempotent");
});

test("New agenda formats prevent consumer removal; safe restore keeps reads and blocks writes until reinstall",async t=>{
  const f=fixture(t),installed=prepareIntegration(f),a=createAgenda(f);
  const item=add(a,{title:'\u5408\u6210\u5168\u5929',all_day:true,start_date:'2030-10-24'}),record=JSON.stringify(a.raw(item.id)),consumer=join(f.root,'core-space/scripts/lib/reminders.mjs'),before=readFileSync(consumer,'utf8');
  assert.throws(()=>restoreAgendaIntegration({configFile:installed.configFile,backup:installed.backup}),/newer.*agenda/i);
  assert.equal(agendaCapability(f.root).ready,true);assert.equal(readFileSync(consumer,'utf8'),before);
  const result=restoreAgendaIntegration({configFile:installed.configFile,backup:installed.backup,keepCompatible:true});
  assert.equal(result.compatibilityKept,true);assert.equal(result.writingEnabled,false);assert.equal(agendaCapability(f.root).ready,true);assert.equal(agendaWriteState(f).writable,false);assert.equal(JSON.stringify(a.raw(item.id)),record);
  assert.equal(readFileSync(consumer,'utf8'),before);
  const module=await import('node:url');const reader=await import(module.pathToFileURL(consumer).href);assert.equal(reader.isExpired(a.raw(item.id),NOW),false);
  installAgendaIntegration({configFile:installed.configFile});assert.equal(agendaWriteState(f).writable,true);
  const changed=a.apply({action:'update',targetId:item.id,expectedRevision:item.revision,fields:{priority:'high'}},randomUUID());assert.equal(changed.priority,'high');
  const gate=createTaskGate(f.root),lock=gate.acquire('task');assert.ok(lock);assert.throws(()=>installAgendaIntegration({configFile:installed.configFile}),/task/i);assert.equal(gate.state().token,lock.token);gate.release(lock.token);
  gate.pause('synthetic-maintenance');assert.throws(()=>restoreAgendaIntegration({configFile:installed.configFile,backup:installed.backup,keepCompatible:true}),/maintenance/i);gate.resume('synthetic-maintenance');
});

test("Main CLI reuses its own native task lease and rejects other owners or maintenance without releasing the outer task",async t=>{
  const f=fixture(t);prepareIntegration(f);
  const adapter={owner:'Test',version:'0.23',requiresConsent:()=>true,allowedContent:()=>true,record:async()=>null};
  const hub=await createHub({...f,port:0,main:{enabled:true},agenda:{enabled:false},testMode:true,adapter,runner:async()=>{throw Error('No nested model');}});
  await new Promise(r=>hub.server.listen(0,'127.0.0.1',r));t.after(()=>{hub.server.closeAllConnections();return hub.close();});
  const config={...f,port:hub.server.address().port},gate=createTaskGate(f.root),lease=gate.acquire('task');assert.ok(lease);
  const old=process.env.AIPA_HUB_TASK_TOKEN;process.env.AIPA_HUB_TASK_TOKEN=lease.token;
  try{
    assert.equal((await runAgendaCommand({config})).total,0);
    const op=await runAgendaCommand({config,command:'propose',text:'\u65b0\u589e\u5408\u6210\u65e5\u7a0b',consent:true,hostModel:'codex',hostProposal:{action:'create',fields:fields('2035-10-25')}});
    assert.equal(op.status,'pending');assert.equal((await runAgendaCommand({config,command:'confirm',id:op.operationId,confirmed:true})).status,'applied');assert.equal(gate.state().token,lease.token);
    process.env.AIPA_HUB_TASK_TOKEN='incorrect-owner';await assert.rejects(runAgendaCommand({config}),/ownership/i);
    process.env.AIPA_HUB_TASK_TOKEN=lease.token;gate.pause('test-maintenance');await assert.rejects(runAgendaCommand({config}),/maintenance/i);gate.resume('test-maintenance');
  }finally{if(old===undefined)delete process.env.AIPA_HUB_TASK_TOKEN;else process.env.AIPA_HUB_TASK_TOKEN=old;gate.release(lease.token);}
  const session=gate.startSession('codex:native-test');assert.ok(session);
  try{assert.equal((await runAgendaCommand({config,sessionId:'codex:native-test'})).total,1);assert.equal(gate.state().token,session.token);await assert.rejects(runAgendaCommand({config,sessionId:'codex:other'}),/ownership/i);}finally{gate.endSession('codex:native-test');}
});
