import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {createMainReports} from '../lib/main-reports.mjs';
test("Batched sources match synchronous results while yielding the event loop",async()=>{
 const parent=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(parent,{recursive:true});const base=mkdtempSync(join(parent,'report-batch-')),root=join(base,'instance'),runtimeDir=join(base,'runtime'),day='2026-10-24';
 mkdirSync(join(root,'state/events'),{recursive:true});mkdirSync(join(root,'user-space/logs/hub/conversations'),{recursive:true});mkdirSync(runtimeDir);
 const events=Array.from({length:2000},(_,i)=>({event_id:'synthetic-'+i,type:'user_message',data:'Synthetic event '+i,ts:day+'T08:00:00Z'}));writeFileSync(join(root,'state/events',day+'@synthetic.jsonl'),events.map(row=>JSON.stringify(row)).join('\n')+'\n');
 writeFileSync(join(root,'user-space/logs/hub/conversations/synthetic.json'),JSON.stringify({turns:Array.from({length:500},(_,i)=>({id:'synthetic-turn-'+i,created:day+'T08:00:00Z',input:'Synthetic question',answer:'Synthetic answer',status:'completed'}))}));
 const reports=createMainReports({root,runtimeDir,nodes:{list:()=>[],operations:()=>[]},modelConsent:false});let turns=0;const ticker=setInterval(()=>turns++,0);
 try{assert.deepEqual(await reports.sourcesAsync(day),reports.sources(day));assert.ok(turns>0,"Scanning must yield the event loop for other requests");turns=0;const record=await reports.daily(day);assert.ok(turns>0,"Real daily report generation must use batched sources");assert.equal(record.sourceCounts.events,2000);assert.equal(record.sourceCounts.web,500);assert.equal((await reports.daily(day)).revision,record.revision);}finally{clearInterval(ticker);}
});

const origin=resolve(process.env.AIPA_ORIGIN_ROOT||join(dirname(fileURLToPath(import.meta.url)),'../../artificial-intelligence-origin-agent'));
const core=await import(pathToFileURL(join(origin,'product/core-space/scripts/lib/event-store.mjs')).href);
const {pruneEvents}=await import(pathToFileURL(join(origin,'product/core-space/scripts/lib/event-archive.mjs')).href);
function fixture(t){const parent=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(parent,{recursive:true});const base=mkdtempSync(join(parent,'report-global-')),root=join(base,'instance'),runtimeDir=join(base,'runtime'),day='2026-10-24';mkdirSync(join(root,'state/events'),{recursive:true});mkdirSync(runtimeDir);t.after(()=>{assert.ok(resolve(base).startsWith(parent+sep));rmSync(base,{recursive:true,force:true});});const file=join(root,'state/events',day+'@synthetic.jsonl'),rows=Array.from({length:2048},(_,i)=>({event_id:'synthetic-'+i,host:'synthetic',sid:'synthetic-session',type:'user_message',data:'Synthetic event '+i,ts:day+'T08:00:00Z',ts_local:day+' 16:00:00'}));writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');return {root,runtimeDir,day,file,rows};}

test("Daily reports use Core batched global conflict verification with archived late variants matching synchronous results",async t=>{
 const f=fixture(t),old={...f.rows[0],event_id:'archived',ts:'2026-10-22T08:00:00Z',ts_local:'2026-10-22 16:00:00'};writeFileSync(join(f.root,'state/events/2026-10-22@synthetic.jsonl'),JSON.stringify(old)+'\n');assert.equal(pruneEvents(f.root,{cutoff:'2026-10-23',apply:true,force:true}).pruned,1);writeFileSync(f.file,[...f.rows,{...old,data:'Synthetic disputed copy'}].map(row=>JSON.stringify(row)).join('\n')+'\n');
 let syncCalls=0,asyncCalls=0,models=0;const contract={...core,readEventSet:(...args)=>{syncCalls++;return core.readEventSet(...args);},readEventSetAsync:(...args)=>{asyncCalls++;return core.readEventSetAsync(...args);}};
 const reports=createMainReports({...f,nodes:{list:()=>[],operations:()=>[]},eventContract:()=>contract,modelConsent:false,runner:async()=>{models++;throw Error('\u4e0d\u5f97\u8c03\u7528\u6a21\u578b');}});
 const actual=await reports.sourcesAsync(f.day);assert.equal(asyncCalls,1);assert.equal(syncCalls,0);assert.equal(actual.events.length,2048);assert.equal(actual.malformed.length,1);assert.deepEqual(actual,reports.sources(f.day));
 const daily=await reports.daily(f.day);assert.equal(asyncCalls,2);assert.equal(daily.sourceCounts.events,2048);assert.equal(models,0);
 const legacy=createMainReports({...f,runtimeDir:join(f.runtimeDir,'legacy'),nodes:{list:()=>[],operations:()=>[]},eventContract:()=>({...core,readEventSetAsync:undefined})});assert.deepEqual(await legacy.sourcesAsync(f.day),legacy.sources(f.day));
});

test("Source changes during global scanning reject partial reports without model calls or report writes",async t=>{
 const f=fixture(t);let models=0;const reports=createMainReports({...f,nodes:{list:()=>[],operations:()=>[]},eventContract:()=>core,modelConsent:true,allowed:()=>true,runner:async()=>{models++;return 'must-not-run';}}),pending=reports.daily(f.day);
 await yieldTurn();writeFileSync(f.file,f.rows.slice(0,1024).map(row=>JSON.stringify(row)).join('\n')+'\n');await assert.rejects(pending,{code:'event_source_changed'});assert.equal(models,0);assert.equal(existsSync(join(f.root,'user-space/logs/daily','DAILY-NOTE_'+f.day+'.md')),false);
});

test("Unknown global verification results block report generation instead of assuming no conflicts",async t=>{
 const f=fixture(t);for(const value of [null,{}, {conflicts:'unknown'},{conflicts:[{}]}]){const reports=createMainReports({...f,nodes:{list:()=>[],operations:()=>[]},eventContract:()=>({...core,readEventSetAsync:async()=>value})});await assert.rejects(reports.daily(f.day),/Cannot verify Core event validation results/i);}assert.equal(existsSync(join(f.root,'user-space/logs/daily','DAILY-NOTE_'+f.day+'.md')),false);
});
