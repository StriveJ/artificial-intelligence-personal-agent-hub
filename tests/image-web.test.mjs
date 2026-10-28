import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {runImageWeb} from '../lib/image-web.mjs';
import {createDeepSeekVision} from '../lib/deepseek-vision.mjs';
import {createHub} from '../server.mjs';
import {createStore} from '../lib/storage.mjs';
import {createMainReports,logicalDay} from '../lib/main-reports.mjs';
import {createMainDistillation} from '../lib/main-distillation.mjs';

const model={provider:'DeepSeek',resolvedModel:'deepseek-flash'};
const recognition={answer:'\u56fe\u7247\u4e0a\u5199\u7740 DeepSeek。',model,warnings:[]};
const source={id:'web-test',title:'DeepSeek \u6587\u6863',url:'https://api-docs.deepseek.com/',domain:'api-docs.deepseek.com',snippet:'\u5b98\u65b9 API \u4f7f\u7528\u8bf4\u660e。'};
function pipeline(){
  const turn={input:'\u8fd9\u662f\u4ec0\u4e48？\u627e\u5230\u5b83\u7684\u5b98\u65b9\u6587\u6863。',attachmentIds:['a'.repeat(64)],analyzeImages:true,allowWeb:true,visionConsent:true,imageWebConsent:true,visionProfileVersion:'vision1',webProfileVersion:'web1'};
  const counts={vision:0,query:0,search:0,answer:0},patches=[];
  const deps={turn,webRevision:()=>turn.webProfileVersion,allowed:()=>true,save:patch=>{patches.push(structuredClone(patch));Object.assign(turn,patch);},
    identify:async()=>{counts.vision++;return recognition;},
    runText:async prompt=>{if(prompt.includes("Return only JSON")){counts.query++;return {answer:JSON.stringify({query:'DeepSeek \u5b98\u65b9 API \u6587\u6863',safe:true}),model};}counts.answer++;return {answer:'\u56fe\u7247\u53ef\u89c1 DeepSeek；[\u5b98\u65b9\u6587\u6863](source:web-test)。',model};},
    search:async(query,opts)=>{counts.search++;assert.equal(query,'DeepSeek \u5b98\u65b9 API \u6587\u6863');assert.equal(opts.expectedRevision,turn.webProfileVersion);return {revision:turn.webProfileVersion,provider:'bing',results:[source]};}};
  return {turn,counts,patches,deps};
}

test("Image analysis, public query generation, search, and sourced answers persist each phase before advancing",async()=>{
  const f=pipeline(),events=[];f.deps.audit=async(...args)=>events.push(args);
  const answer=await runImageWeb(f.deps);
  assert.deepEqual(f.counts,{vision:1,query:1,search:1,answer:1});assert.match(answer.answer,/https:\/\/api-docs.deepseek.com/);assert.equal(answer.sources.length,1);assert.equal(answer.webQuery.mode,'image');
  assert.deepEqual(events.map(e=>e[0]),['recognition','query','search','answer']);
  for(const name of events.map(e=>e[0]))assert.ok(f.patches.some(p=>p.imageWeb?.[name]?.status==='running'));
  assert.equal(f.turn.imageWeb.stage,'completed');
});

test("Explicit retry after search failure reuses analysis and query; answer failure repeats only synthesis",async()=>{
  const f=pipeline(),search=f.deps.search,text=f.deps.runText;
  f.deps.search=async()=>{f.counts.search++;throw Error('\u641c\u7d22\u6682\u4e0d\u53ef\u7528');};
  await assert.rejects(runImageWeb(f.deps),/\u641c\u7d22\u6682\u4e0d\u53ef\u7528/);assert.equal(f.turn.imageWeb.recognition.status,'completed');assert.equal(f.turn.imageWeb.search.status,'failed');
  f.deps.search=search;f.deps.runText=async prompt=>{if(!prompt.includes("Return only JSON")){f.counts.answer++;throw Error('\u7efc\u5408\u6682\u4e0d\u53ef\u7528');}return text(prompt);};
  await assert.rejects(runImageWeb(f.deps),/\u7efc\u5408\u6682\u4e0d\u53ef\u7528/);assert.deepEqual(f.counts,{vision:1,query:1,search:2,answer:1});
  f.deps.runText=text;await runImageWeb(f.deps);assert.deepEqual(f.counts,{vision:1,query:1,search:2,answer:2});
});

test("Search setting changes preserve analysis and query; renewed consent refreshes search and answer, including expired results",async()=>{
  const f=pipeline();await runImageWeb(f.deps);f.deps.webRevision=()=> 'web2';
  await assert.rejects(runImageWeb(f.deps),e=>e.status===428);assert.equal(f.counts.search,1);
  f.turn.webProfileVersion='web2';await runImageWeb(f.deps);assert.deepEqual(f.counts,{vision:1,query:1,search:2,answer:2});
  f.turn.imageWeb.search.completedAt=new Date(Date.now()-16*60_000).toISOString();await runImageWeb(f.deps);assert.equal(f.counts.search,3);assert.equal(f.counts.vision,1);
  f.turn.visionProfileVersion='vision2';await runImageWeb(f.deps);assert.equal(f.counts.vision,2);
});

test("Uncertain objects trigger clarification; empty search preserves image analysis without invented web conclusions",async()=>{
  const f=pipeline();f.deps.runText=async()=>({answer:JSON.stringify({query:null,clarification:'\u8bf7\u8865\u62cd\u6e05\u6670\u7684\u578b\u53f7\u6807\u7b7e。',safe:true}),model});
  const answer=await runImageWeb(f.deps);assert.equal(f.counts.search,0);assert.match(answer.answer,/\u8bf7\u8865\u62cd/);assert.equal(answer.webQuery.status,'needs-clarification');
  const empty=pipeline();empty.deps.search=async()=>({revision:'web1',results:[]});const result=await runImageWeb(empty.deps);assert.equal(empty.counts.answer,0);assert.equal(result.webQuery.status,'empty');assert.match(result.answer,/based only on image analysis/i);
});

test("Sensitive, malformed, and internal-address queries are rejected without raw-question or analysis fallback",async()=>{
  for(const query of ['user@example.com','192.168.56.10 \u767b\u5f55','10.0.0.1','DESKTOP.local','D:\\code\\private','13800138000','password=hello','x'.repeat(129)]){
    const f=pipeline();f.deps.runText=async()=>({answer:JSON.stringify({query,safe:true}),model});await assert.rejects(runImageWeb(f.deps));assert.equal(f.counts.search,0);assert.equal(f.turn.imageWeb.recognition.status,'completed');
  }
  const f=pipeline();f.deps.runText=async()=>({answer:'\u4e0d\u662fJSON',model});await assert.rejects(runImageWeb(f.deps),/query generation/i);assert.equal(f.counts.search,0);
  const blocked=pipeline();blocked.deps.allowed=()=>false;await assert.rejects(runImageWeb(blocked.deps),e=>e.status===428);assert.equal(blocked.counts.query,0);
});

test("Configuration changes preserve completed image analysis and interruptions stop later external phases",async()=>{
  const f=pipeline();let revision='web1';f.deps.webRevision=()=>revision;f.deps.identify=async()=>{f.counts.vision++;revision='web2';return recognition;};
  await assert.rejects(runImageWeb(f.deps),e=>e.status===428);assert.equal(f.turn.imageWeb.recognition.status,'completed');assert.equal(f.counts.query,0);
  let stopped=false;f.turn.webProfileVersion='web2';f.deps.guard=()=>{if(stopped)throw Error("Interrupted");};f.deps.runText=async()=>{stopped=true;return{answer:'{"query":"DeepSeek","safe":true}',model};};
  await assert.rejects(runImageWeb(f.deps),/interrupted/i);assert.equal(f.counts.search,0);
});

const envFixture={ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_AUTH_TOKEN:'synthetic-image-web-key'};
const response=answer=>Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:answer}}]});
test("Official vision credentials process derived text without images or private context while enforcing consent and revision checks",async()=>{
  let calls=0;const service=createDeepSeekVision({engine:'claude',env:()=>envFixture,fetcher:async(_,opts)=>{calls++;const body=JSON.parse(opts.body);assert.equal(body.messages[1].content.length,1);assert.equal(body.model,'deepseek-flash');assert.doesNotMatch(opts.body,/image_url|profile.yaml/);return response('\u516c\u5f00\u4e3b\u9898');}});
  const options={text:'\u6388\u6743\u7684\u672c\u8f6e\u8bc6\u56fe\u7ed3\u679c',consent:true,expectedProfileVersion:service.profile().version};
  await assert.rejects(service.runText({...options,consent:false}),e=>e.status===428);assert.equal((await service.runText(options)).answer,'\u516c\u5f00\u4e3b\u9898');assert.equal(calls,1);service.close();
});

const TMP=resolve('aipa-test-tmp');mkdirSync(TMP,{recursive:true});
function fixture(t){const base=mkdtempSync(join(TMP,'image-web-')),root=join(base,'instance'),runtimeDir=join(base,'runtime');mkdirSync(root);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'owner: synthetic\n');t.after(()=>rmSync(base,{recursive:true,force:true}));return{root,runtimeDir};}
function configure(t){const prior={...process.env};Object.assign(process.env,envFixture);t.after(()=>{for(const key of Object.keys(envFixture))if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];});}
const adapter={owner:'synthetic',version:'1',requiresConsent:()=>true,allowedContent:text=>!text.includes('PRIVATE_CONTEXT'),begin:async()=>null,record:async()=>null,context:async()=>{throw Error('\u4e0d\u5141\u8bb8\u52a0\u8f7d\u4e2a\u4eba\u4e0a\u4e0b\u6587');},search:async()=>{throw Error('\u4e0d\u5141\u8bb8\u68c0\u7d22\u4e2a\u4eba\u8bb0\u5fc6');}};
async function client(hub){
  const url=await hub.listen(),login=await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const call=async(path,body)=>{const res=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:res.status,data:await res.json()};};
  const upload=async id=>{const bytes=await sharp({create:{width:64,height:64,channels:3,background:'#16a34a'}}).png().toBuffer(),res=await fetch(url+'/api/attachments',{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'image/png','X-Aipa-Draft':id,'Idempotency-Key':randomUUID()},body:bytes});assert.equal(res.status,201);return res.json();};return{call,upload};
}
async function settled(call,id){for(let i=0;i<200;i++){const {data}=await call('/api/chats/'+id);if(data.turns.length&&!data.turns.some(t=>['running','queued'].includes(t.status)))return data.turns.at(-1);await new Promise(r=>setTimeout(r,15));}throw Error("Incomplete");}
const BING='<ol id="b_results"><li class="b_algo"><h2><a href="https://api-docs.deepseek.com/">DeepSeek \u6587\u6863</a></h2><p>\u5b98\u65b9 API \u6587\u6863。</p></li></ol>';

test("HTTP binds combined consent and mode, deduplicates submissions, and resumes search failures explicitly without personal context",async t=>{
  configure(t);const f=fixture(t);let fail=true,vision=0,query=0,answer=0,search=0;
  const options={...f,engine:'claude',port:0,adapter,runner:async()=>{throw Error('\u4e0d\u5141\u8bb8\u8c03\u7528\u6587\u672cCLI');},webFetcher:async(url)=>{search++;assert.match(new URL(url).searchParams.get('q'),/DeepSeek \u5b98\u65b9\u6587\u6863/);assert.doesNotMatch(new URL(url).searchParams.get('q'),/PRIVATE_CONTEXT|\u8fd9\u662f\u4ec0\u4e48/);if(fail)throw Error('network fixture');return new Response(BING);}};
  options.visionFetcher=async(_,opts)=>{const content=JSON.parse(opts.body).messages[1].content;assert.doesNotMatch(opts.body,/PRIVATE_CONTEXT/);if(content.length>1){vision++;return response(recognition.answer);}if(content[0].text.includes("Return only JSON")){query++;return response('{"query":"DeepSeek \u5b98\u65b9\u6587\u6863","safe":true}');}answer++;const id=content[0].text.match(/web-[a-f0-9]{24}/)?.[0];assert.ok(id);return response(`\u8bc6\u56fe\u53ef\u89c1 DeepSeek，\u53c2\u8003[\u5b98\u65b9](source:${id}).`);};
  let hub=await createHub(options);t.after(()=>hub.close());let {call,upload}=await client(hub);
  const status=(await call('/api/status')).data,web=(await call('/api/web-search/settings')).data,chat=(await call('/api/chats',{})).data,id=randomUUID(),image=await upload(id);
  const body={id,text:'\u8fd9\u662f\u4ec0\u4e48？\u627e\u5b98\u65b9\u6587\u6863。',attachmentIds:[image.id],analyzeImages:true,visionConsent:true,imageWebConsent:true,allowWeb:true,visionProfileVersion:status.attachments.visionProfile.version,webProfileVersion:web.settings.revision};
  for(const [patch,code] of [[{imageWebConsent:false},428],[{visionConsent:false},428],[{webProfileVersion:'stale'},428],[{searchQuery:'manual'},400],[{searchQuery:5},400],[{analyzeImages:false},428]])assert.equal((await call(`/api/chats/${chat.id}/turns`,{...body,...patch})).status,code);
  assert.equal(vision,0);assert.equal((await call(`/api/chats/${chat.id}/turns`,body)).status,202);let turn=await settled(call,chat.id);assert.equal(turn.status,'error');assert.equal(turn.imageWeb.recognition.status,'completed');assert.equal(vision,1);assert.equal(query,1);assert.equal(search,1);
  assert.equal((await call(`/api/chats/${chat.id}/turns`,body)).data.duplicate,true);assert.equal((await call(`/api/chats/${chat.id}/retry`,{...body,allowWeb:false})).status,409);
  await hub.close();hub=await createHub(options);({call}=await client(hub));await new Promise(r=>setTimeout(r,3100));assert.equal(search,1,"Restart must not replay models automatically");
  fail=false;assert.equal((await call(`/api/chats/${chat.id}/retry`,body)).status,202);turn=await settled(call,chat.id);assert.equal(turn.status,'completed',turn.error);assert.equal(turn.processing,'vision-web');assert.match(turn.answer,/https:\/\/api-docs.deepseek.com/);assert.equal(turn.webSources.length,1);assert.equal(vision,1);assert.equal(query,1);assert.equal(search,2);assert.equal(answer,1);
});

test("Combined-mode reports record phases, queries, and source counts; derived image events stay out of automatic memories",async t=>{
  const f=fixture(t),store=createStore(f.root),now=Date.parse('2026-10-20T12:00:00Z'),created=new Date(now).toISOString(),day=logicalDay(now);
  store.saveChat({id:randomUUID(),created,updated:created,turns:[{id:'combo',input:'synthetic',created,status:'error',attachmentIds:['a'.repeat(64)],analyzeImages:true,allowWeb:true,imageWeb:{stage:'search',recognition:{status:'completed'},query:{status:'completed'},search:{status:'failed'}},webQuery:{query:'DeepSeek \u5b98\u65b9\u6587\u6863'},error:'synthetic search failure'}]});
  const dir=join(f.root,'state/events');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,day+'.jsonl'),JSON.stringify({event_id:'hub-imageweb-combo-1-query-completed',ts:created,type:'tool_result',data:'unconfirmed derived image material'})+'\n');
  const reports=createMainReports({...f,nodes:{list:()=>[]},now:()=>now});await reports.daily(day);
  const text=readFileSync(join(f.root,'user-space/logs/daily',`DAILY-NOTE_${day}.md`),'utf8');assert.match(text,/Image and web processing/i);assert.match(text,/DeepSeek \u5b98\u65b9\u6587\u6863/);assert.match(text,/"search":"failed"/);
  let calls=0;const distill=createMainDistillation({...f,reports,consent:true,adapter:()=>({allowedContent:()=>true}),runner:async()=>{calls++;throw Error('must not distill');}});
  assert.equal((await distill.run(day)).code,'empty');assert.equal(calls,0);
});
