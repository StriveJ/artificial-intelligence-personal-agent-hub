import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMainDistillation } from '../lib/main-distillation.mjs';

const base=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(base,{recursive:true});
function fixture({events=[],web=[],memoryExcludedEventIds=[],days=['2026-10-26'],consent=true,allowed}={}){
 const work=mkdtempSync(join(base,'distillation-privacy-')),root=join(work,'instance'),runtimeDir=join(work,'runtime');
 mkdirSync(join(root,'user-space/logs/hub/reports/daily'),{recursive:true});
 for(const day of days)writeFileSync(join(root,'user-space/logs/hub/reports/daily',day+'.json'),JSON.stringify({fingerprint:'synthetic'}));
 const calls=[],reads=[];
 const reports={sources:()=>assert.fail('Use yielding source reader'),sourcesAsync:async day=>{reads.push(day);return {events,web,memoryExcludedEventIds};},status:()=>({days:Object.fromEntries(days.map(day=>[day,{closedAt:day+'T18:00:00Z'}]))})};
 const make=()=>createMainDistillation({root,runtimeDir,reports,consent,adapter:()=>({allowedContent:allowed|| (value=>!JSON.stringify(value).match(/SYNTHETIC_PRIVATE|token|sensitive.*true/i))}),runner:async prompt=>{calls.push(prompt);return '[]';}});
 return {make,calls,reads};
}

test("Restricted records are isolated individually; technical terms and sensitive values cannot bypass privacy policy",async()=>{
 const f=fixture({events:[{event_id:'safe',data:'Synthetic public method'},{event_id:'restricted',data:'token usage'},{event_id:'credential',data:{api_key:'SYNTHETIC_PRIVATE_VALUE'}},{event_id:'tagged',data:'ordinary',sensitive:true}],web:[{id:'safe-web',input:'Synthetic question',answer:'Synthetic answer'},{id:'private-web',input:'SYNTHETIC_PRIVATE_VALUE'}]});
 const d=f.make(),result=await d.run('2026-10-26');
 assert.equal(result.status,'success');assert.equal(result.code,'privacy_filtered');assert.deepEqual([result.privacy.total,result.privacy.accepted,result.privacy.blocked],[6,2,4]);
 assert.match(result.summary,/isolated 4 restricted records/i);assert.equal(f.calls.length,1);assert.match(f.calls[0],/Synthetic public method/);assert.match(f.calls[0],/Synthetic question/);assert.doesNotMatch(f.calls[0],/SYNTHETIC_PRIVATE|token usage|ordinary/);
 assert.doesNotMatch(JSON.stringify(d.status().lastRun),/SYNTHETIC_PRIVATE|token usage/);
 await f.make().run('2026-10-26');assert.equal(f.calls.length,1);
});

test("No model call occurs for fully restricted input, absent consent, or failed final-material privacy checks",async()=>{
 for(const options of [{events:[{data:'SYNTHETIC_PRIVATE'}]},{events:[{data:'Synthetic permitted'}],consent:false},{events:[{data:'Synthetic permitted'}],allowed:value=>typeof value!=='string'}]){
  const f=fixture(options),result=await f.make().run('2026-10-26');
  assert.equal(result.status,'blocked');assert.equal(f.calls.length,0);
 }
});

test("Web and mirrored events are isolated together so privacy labels survive copies and answers",async()=>{
 const f=fixture({events:[{event_id:'hub-user-linked',data:'PRIVATE_PAIR_SENTINEL',sensitive:true},{event_id:'hub-answer-linked',data:'PRIVATE_PAIR_SENTINEL'},{event_id:'safe',data:'Synthetic safe method'}],web:[{id:'linked',input:'PRIVATE_PAIR_SENTINEL',answer:'PRIVATE_PAIR_SENTINEL'}]});
 const result=await f.make().run('2026-10-26');
 assert.equal(result.privacy.accepted,1);assert.equal(result.privacy.blocked,3);
 assert.doesNotMatch(f.calls[0],/PRIVATE_PAIR_SENTINEL/);
});

test("Image records and cross-day image events stay out of long-term memory",async()=>{
 const f=fixture({events:[{event_id:'hub-user-image',data:'IMAGE_PRIVATE_SENTINEL'},{event_id:'hub-answer-image',data:'IMAGE_PRIVATE_SENTINEL'},{event_id:'cross-day-image',data:'IMAGE_PRIVATE_SENTINEL'},{event_id:'hub-imageweb-query',data:'IMAGE_PRIVATE_SENTINEL'},{event_id:'safe',data:'Synthetic ordinary method'}],web:[{id:'image',attachmentIds:['synthetic-image'],input:'IMAGE_PRIVATE_SENTINEL'}],memoryExcludedEventIds:['cross-day-image']});
 const result=await f.make().run('2026-10-26');assert.equal(result.privacy.total,1);assert.equal(f.calls.length,1);assert.doesNotMatch(f.calls[0],/IMAGE_PRIVATE_SENTINEL/);
});

test("Scheduled distillation uses the latest closed day; historical processing requires bounded explicit dates",async()=>{
 const f=fixture({events:[{data:'Synthetic method'}],days:['2026-10-24','2026-10-25','2026-10-26']});
 assert.deepEqual((await f.make().tick()).checkedDays,['2026-10-26']);assert.deepEqual(f.reads,['2026-10-26']);
 await f.make().tick({days:['2026-10-24']});assert.deepEqual(f.reads,['2026-10-26','2026-10-24']);
 await assert.rejects(()=>f.make().tick({days:['2026-10-20']}),/closed workdays/i);
 assert.equal(f.calls.length,2);
});
