import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {timeZone,localDay,dailyTime,dailyDue,wallParts} from '../lib/time-zone.mjs';
import {createScheduler} from '../lib/scheduler.mjs';
import {createStore} from '../lib/storage.mjs';
import {createBriefingService,briefingPrompt,validateBriefingSettings} from '../lib/briefings.mjs';
import {createDailyDigest} from '../lib/daily-digest.mjs';
import {createAgendaActions} from '../lib/agenda-actions.mjs';
import {createMainReports,logicalDay} from '../lib/main-reports.mjs';
import {createAipaAdapter} from '../lib/aipa.mjs';
import {createHub} from '../server.mjs';
import {createSubHub,subCommand} from '../sub-server.mjs';
import {createWebSearch} from '../lib/web-search.mjs';
import {formatStamp} from '../public/status.js';
const iso=stamp=>new Date(stamp).toISOString();
const timers={setTimer:()=>({unref(){}}),clearTimer(){}};
function fixture(t){const base=mkdtempSync(join(tmpdir(),'aipa-zone-')),root=join(base,'instance'),runtimeDir=join(base,'runtime');mkdirSync(join(root,'user-space'),{recursive:true});mkdirSync(runtimeDir);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n  owner: Synthetic\n  version: 1.0.0\n');t.after(()=>rmSync(base,{recursive:true,force:true}));return{base,root,runtimeDir};}
const options={enabled:true,dailyAt:'07:00',categories:['ai'],sourceIds:['openai'],interests:''};
test('IANA schedules cover UTC, non-hour offsets, DST gaps, overlaps, and a skipped civil date',()=>{
 assert.equal(timeZone(),'Asia/Shanghai');
 for(const value of ['Eastern Standard Time','+05:45','Bad/Zone',null,''])assert.throws(()=>timeZone(value),/IANA/);
 assert.equal(iso(dailyTime('2027-06-01','07:00','UTC')),'2027-06-01T07:00:00.000Z');
 assert.equal(iso(dailyTime('2027-06-01','07:00','Asia/Kathmandu')),'2027-06-01T01:15:00.000Z');
 assert.equal(iso(dailyTime('2027-03-14','02:30','America/New_York')),'2027-03-14T07:30:00.000Z');
 assert.equal(iso(dailyTime('2027-11-07','01:30','America/New_York')),'2027-11-07T05:30:00.000Z');
 assert.equal(iso(dailyTime('2027-10-03','02:15','Australia/Lord_Howe')),'2027-10-02T15:45:00.000Z');
 assert.equal(iso(dailyTime('2011-12-30','07:00','Pacific/Apia')),'2011-12-30T17:00:00.000Z');
 assert.equal(iso(dailyDue(Date.parse('2027-11-07T06:00:00Z'),'01:30',true,'America/New_York')),'2027-11-08T06:30:00.000Z');
 assert.equal(localDay(Date.parse('2027-06-01T00:30:00Z'),'America/New_York'),'2027-05-31');
 assert.equal(wallParts(Date.parse('2027-06-01T00:30:00Z'),'Asia/Kathmandu').minute,15);
});
test('Zoned schedule conversion ignores operating-system local time settings',()=>{
 const url=pathToFileURL(resolve('lib/time-zone.mjs')).href;
 const code='import {dailyTime} from '+JSON.stringify(url)+'; process.stdout.write(new Date(dailyTime("2027-11-07","01:30","America/New_York")).toISOString());';
 for(const zone of ['UTC','Pacific/Honolulu','Asia/Tokyo'])assert.equal(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:zone},encoding:'utf8',windowsHide:true}),'2027-11-07T05:30:00.000Z');
});
test('Scheduler executes a repeated DST wall time once and preserves that result on restart',async t=>{
 const f=fixture(t),path=join(f.runtimeDir,'tasks.json');let clock=Date.parse('2027-11-07T05:29:00Z'),calls=0;
 const register=s=>s.register({id:'daily-test',label:'Synthetic',dailyAt:'01:30',timeZone:'America/New_York',run:async({scheduledFor})=>{calls++;assert.equal(scheduledFor,'2027-11-07T05:30:00.000Z');return{status:'success'};}});
 let scheduler=createScheduler({path,now:()=>clock,...timers});register(scheduler);scheduler.start();await scheduler.tick();assert.equal(calls,0);
 clock=Date.parse('2027-11-07T05:30:00Z');await scheduler.tick();assert.equal(calls,1);assert.equal(scheduler.list()[0].nextRunAt,'2027-11-08T06:30:00.000Z');await scheduler.stop();
 clock=Date.parse('2027-11-07T06:30:00Z');scheduler=createScheduler({path,now:()=>clock,...timers});register(scheduler);scheduler.start();await scheduler.tick();assert.equal(calls,1);await scheduler.stop();
});
test('Scheduler shifts a missing DST time and recomputes after a shared zone change',async t=>{
 const f=fixture(t);let clock=Date.parse('2027-03-14T06:59:00Z'),zone='America/New_York',calls=0;
 const scheduler=createScheduler({path:join(f.runtimeDir,'tasks.json'),now:()=>clock,timeZone:()=>zone,...timers});
 scheduler.register({id:'daily-test',label:'Synthetic',dailyAt:'02:30',run:async({scheduledFor})=>{calls++;assert.equal(scheduledFor,'2027-03-14T07:30:00.000Z');return{status:'success'};}});
 scheduler.start();clock=Date.parse('2027-03-14T07:00:00Z');await scheduler.tick();assert.equal(calls,0);clock=Date.parse('2027-03-14T07:30:00Z');await scheduler.tick();assert.equal(calls,1);
 zone='Asia/Kathmandu';assert.equal(scheduler.list()[0].timeZone,zone);assert.equal(scheduler.list()[0].nextRunAt,'2027-03-14T20:45:00.000Z');
 assert.throws(()=>scheduler.configure('daily-test',{enabled:true,dailyAt:'02:30',timeZone:'UTC'}),/differs/);await scheduler.stop();
});
test('Briefing dates, source dates, digests, and report boundaries share the selected zone',async t=>{
 const f=fixture(t),store=createStore(f.root),now=()=>Date.parse('2027-06-01T00:30:00Z');let zone='America/New_York';
 const service=createBriefingService({...f,store,now,timeZone:()=>zone,defaults:options,runner:async()=>assert.fail('Empty source should not call a model'),fetcher:async()=>new Response('<feed/>')});
 await service.generate();assert.equal(store.readBriefing('2027-05-31').timeZone,zone);assert.equal(service.settings().timeZone,zone);
 assert.throws(()=>service.configure({...options,timeZone:'UTC'}),/Invalid notification/);
 assert.equal(validateBriefingSettings({...options,timeZone:'Asia/Kathmandu'}).timeZone,'Asia/Kathmandu');assert.throws(()=>validateBriefingSettings({...options,timeZone:'invalid'}));
 const prompt=briefingPrompt([{id:'n1',title:'Synthetic',publishedAt:'2027-06-01T00:30:00Z'}],{timeZone:zone,interests:''},'2027-05-31');assert.match(prompt,/"sourceDate":"2027-05-31"/);assert.doesNotMatch(prompt,/sourceDateBeijing/);
 const agenda={list:()=>({items:[],total:0,invalid:0,conflicts:0,timeZone:zone,asOf:new Date(now()).toISOString()})},pushes={publish(){}};
 const digest=createDailyDigest({...f,store,now,timeZone:()=>zone,agenda,pushes,defaults:{enabled:true}});assert.equal(digest.snapshot().day,'2027-05-31');assert.equal(digest.report('2027-05-31').timeZone,zone);
 assert.throws(()=>digest.configure({enabled:true,dailyAt:'07:00',timeZone:'UTC'}),/settings|time/i);
 assert.equal(logicalDay(Date.parse('2027-03-14T09:59:00Z'),6,zone),'2027-03-13');assert.equal(logicalDay(Date.parse('2027-03-14T10:00:00Z'),6,zone),'2027-03-14');
 assert.equal(formatStamp('2027-06-01T00:30:00Z',zone),'2027-05-31 20:30:00');
 const reports=createMainReports({...f,nodes:{list:()=>[],operations:()=>[]},timeZone:zone,now});assert.equal(reports.clockSettings().timeZone,zone);assert.equal(reports.localHour(now()),20);
 zone='Asia/Kathmandu';assert.equal(service.settings().timeZone,zone);assert.equal(digest.settings().timeZone,zone);
});
test('Agenda relative interpretation receives the shared zone, defaults new items to it, and invalidates stale proposals',async t=>{
 const f=fixture(t);let zone='America/New_York',prompt='';const at=Date.parse('2027-06-01T00:30:00Z');
 const actions=createAgendaActions({...f,now:()=>at,timeZone:()=>zone,runner:async value=>{prompt=value;return JSON.stringify({action:'create',fields:{title:'Synthetic meeting',all_day:true,start_date:'2027-06-01',end_date_exclusive:'2027-06-02'},needsConfirmation:true});}});
 const proposal=await actions.propose({id:'synthetic-zone-operation',text:'Schedule an all-day meeting tomorrow',consent:true,modelProfileVersion:'test'});assert.equal(proposal.plan.fields.time_zone,zone);assert.equal(actions.agenda.list().timeZone,zone);assert.match(prompt,/"timeZone":"America\/New_York"/);assert.match(prompt,/nonexistent or ambiguous daylight-saving/);
 zone='UTC';assert.throws(()=>actions.confirm({id:proposal.operationId,confirmed:true}),/Shared timezone changed/);
});
const origin=process.env.AIPA_ORIGIN_ROOT,framework=origin&&join(origin,'product/core-space');
test('A real Core-backed Hub applies a non-Shanghai zone to daily tasks, producers, and runtime diagnostics',{skip:!framework||!existsSync(framework)},async t=>{
 const f=fixture(t);cpSync(framework,join(f.root,'core-space'),{recursive:true});mkdirSync(join(f.root,'.git'));writeFileSync(join(f.root,'user-space/llm-provider.yaml'),'day_start_hour: 6\ntime_zone: America/New_York\n');writeFileSync(join(f.root,'user-space/privacy.yaml'),'upload_policy:\n  mode: ask\n');
 const original=readFileSync(join(f.root,'user-space/llm-provider.yaml'),'utf8');const adapter=await createAipaAdapter(f.root),hub=await createHub({...f,adapter,main:{enabled:true},runner:async()=>assert.fail('No model in timezone startup acceptance')});
 try{assert.ok(hub.scheduler.list().filter(task=>task.dailyAt).every(task=>task.timeZone==='America/New_York'));assert.equal(hub.briefings.settings().timeZone,'America/New_York');assert.equal(hub.dailyDigest.settings().timeZone,'America/New_York');assert.equal(hub.reports.clockSettings().timeZone,'America/New_York');assert.equal(hub.runtimeStatus.snapshot().timeZone,'America/New_York');assert.equal(readFileSync(join(f.root,'user-space/llm-provider.yaml'),'utf8'),original);}finally{await hub.close();}
});

test('Search quotas reset at the shared civil midnight rather than UTC or device midnight',async t=>{
 const f=fixture(t);let clock=Date.parse('2027-06-01T23:59:00Z');
 const search=createWebSearch({...f,now:()=>clock,timeZone:()=> 'America/New_York',fetcher:async()=>new Response('<li class="b_algo"><h2><a href="https://example.com/synthetic">Synthetic result</a></h2><p>Public synthetic excerpt</p></li>')});
 await search.run('Synthetic query');assert.equal(search.metadata().usedToday,1);assert.equal(search.metadata().timeZone,'America/New_York');
 clock=Date.parse('2027-06-02T00:01:00Z');assert.equal(search.metadata().usedToday,1);
 clock=Date.parse('2027-06-02T04:00:00Z');assert.equal(search.metadata().usedToday,0);
});
test('Sub Hub IPC agenda inherits the same Core zone without calling a model or contacting a remote service',{skip:!framework||!existsSync(framework)},async t=>{
 const f=fixture(t);cpSync(framework,join(f.root,'core-space'),{recursive:true});execFileSync('git',['init','--quiet',f.root],{windowsHide:true});writeFileSync(join(f.root,'user-space/llm-provider.yaml'),'time_zone: Asia/Kathmandu\n');writeFileSync(join(f.root,'user-space/privacy.yaml'),'upload_policy:\n  mode: ask\n');
 const sub=await createSubHub({...f,nodeId:'synthetic-zone-node',installationId:'synthetic-zone-installation',token:'synthetic-only',mainUrl:'http://127.0.0.1:9',testMode:true,runner:async()=>assert.fail('List must not call a model')});
 try{await sub.listen();await sub.cycle();await sub.sync.request();const result=await subCommand(f.runtimeDir,'agenda-list');assert.equal(result.timeZone,'Asia/Kathmandu');assert.equal(result.total,0);}finally{await sub.close();}
});
