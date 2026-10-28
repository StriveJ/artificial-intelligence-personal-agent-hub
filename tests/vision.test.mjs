import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {createDeepSeekVision} from '../lib/deepseek-vision.mjs';
import {createHub} from '../server.mjs';
import {createStore,writeJson} from '../lib/storage.mjs';
import {createAttachments} from '../lib/attachments.mjs';
import {createCaptureInbox} from '../lib/capture-inbox.mjs';
import {createMainReports,logicalDay} from '../lib/main-reports.mjs';
import {createMainDistillation} from '../lib/main-distillation.mjs';
const envFixture={ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_AUTH_TOKEN:'synthetic-vision-key'};
const response=(content='\u7eff\u8272\u77e9\u5f62',extra={})=>Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content}}],...extra});
const input=profile=>({text:'\u63cf\u8ff0\u56fe\u7247',images:[Buffer.from('synthetic')],consent:true,expectedProfileVersion:profile.version});
const TMP=resolve('aipa-test-tmp');mkdirSync(TMP,{recursive:true});
function fixture(t){const base=mkdtempSync(join(TMP,'vision-')),root=join(base,'instance'),runtimeDir=join(base,'runtime');mkdirSync(root);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'owner: synthetic\n');t.after(()=>rmSync(base,{force:true,recursive:true}));return{base,root,runtimeDir};}
function configure(t){const previous={...process.env};Object.assign(process.env,envFixture);t.after(()=>{for(const key of Object.keys(envFixture))if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];});}
const png=()=>sharp({create:{width:96,height:48,channels:3,background:'#16a34a'}}).png().toBuffer();
const adapter={owner:'synthetic',version:'1',requiresConsent:()=>true,allowedContent:text=>!text.includes('private'),begin:async()=>null,record:async()=>null,context:async()=>{throw Error('Vision must never load private context');},search:async()=>[]};
async function client(hub){const url=await hub.listen(),login=await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const call=async(path,body)=>{const res=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:res.status,data:await res.json()};};
  const upload=async id=>{const res=await fetch(url+'/api/attachments',{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'image/png','X-Aipa-Draft':id,'Idempotency-Key':randomUUID()},body:await png()});assert.equal(res.status,201);return res.json();};
  return{call,upload};
}
async function settled(call,chatId){for(let i=0;i<150;i++){const {data}=await call(`/api/chats/${chatId}`);if(data.turns.length&&!data.turns.some(t=>['running','queued'].includes(t.status)))return data.turns.at(-1);await new Promise(r=>setTimeout(r,20));}throw Error('turn did not settle');}

test("Official vision credentials, explicit consent, configuration changes, and structured image requests are enforced",async()=>{
  let env={...envFixture},calls=0;
  const vision=createDeepSeekVision({engine:'claude',env:()=>env,fetcher:async(url,opts)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,`Bearer ${env.ANTHROPIC_AUTH_TOKEN}`);const body=JSON.parse(opts.body);assert.equal(body.model,'deepseek-flash');assert.equal(body.messages.length,2);assert.equal(body.messages[1].content[1].image_url.url,'data:image/webp;base64,c3ludGhldGlj');return response();}});
  const profile=vision.profile();assert.equal(profile.available,true);assert.doesNotMatch(JSON.stringify(profile),/synthetic-vision-key/);
  await assert.rejects(()=>vision.run({...input(profile),consent:false}),e=>e.status===428);
  env.ANTHROPIC_AUTH_TOKEN='rotated';await assert.rejects(()=>vision.run(input(profile)),e=>e.status===428);assert.equal(calls,0);
  const result=await vision.run(input(vision.profile()));assert.equal(result.model.resolvedModel,'deepseek-flash');assert.equal(calls,1);
  env.ANTHROPIC_BASE_URL='https://proxy.example/anthropic';assert.equal(vision.profile().available,false);await assert.rejects(()=>vision.run(input(vision.profile())),e=>e.status===503);
});

test("Vision responses are bounded, hide upstream bodies, and never retry automatically or switch models",async()=>{
  for(const fetcher of [async()=>new Response('synthetic-vision-key PRIVATE_IMAGE',{status:401}),async()=>{throw Error('synthetic-vision-key PRIVATE_IMAGE');},async()=>response('wrong',{model:'deepseek-v4-pro'}),async()=>new Response('x'.repeat(256*1024+1)),async()=>new Response('{bad json}')]){
    let calls=0;const vision=createDeepSeekVision({engine:'claude',env:()=>envFixture,fetcher:async(...a)=>{calls++;return fetcher(...a);}});
    await assert.rejects(()=>vision.run(input(vision.profile())),e=>{assert.doesNotMatch(e.message,/synthetic-vision-key|PRIVATE_IMAGE/);return true;});assert.equal(calls,1);
  }
  const vision=createDeepSeekVision({engine:'claude',env:()=>envFixture,fetcher:async()=>response('partial',{choices:[{finish_reason:'length',message:{content:'partial'}}]})});assert.equal((await vision.run(input(vision.profile()))).warnings.length,1);
});

test("Timeout and shutdown cancel vision without replaying unknown outcomes",async()=>{
  let calls=0;const fetcher=async(_,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('redacted')), {once:true}));};
  const a=createDeepSeekVision({engine:'claude',env:()=>envFixture,fetcher,timeoutMs:15});await assert.rejects(()=>a.run(input(a.profile())),/timed out/i);
  const b=createDeepSeekVision({engine:'claude',env:()=>envFixture,fetcher});const pending=b.run(input(b.profile()));b.close();await assert.rejects(()=>pending,/interrupted/i);assert.equal(calls,2);assert.equal(b.profile().available,false);
});

test("Image HTTP supports storage, outbound consent, privacy denial, error preservation, and original-image retry",async t=>{
  configure(t);const f=fixture(t);let visionCalls=0,textCalls=0,contextCalls=0,fail=true;
  const hub=await createHub({...f,port:0,engine:'claude',adapter:{...adapter,context:async()=>{contextCalls++;return{prompt:'synthetic text follow-up',sources:[]};}},runner:async prompt=>{textCalls++;assert.match(prompt,/No image pixels are provided in this turn/i);assert.doesNotMatch(prompt,/not analyzed/i);return '\u6587\u672c\u8ddf\u8fdb';},visionFetcher:async(_,opts)=>{visionCalls++;const body=JSON.parse(opts.body);assert.equal(body.messages[1].content.length,2);assert.doesNotMatch(opts.body,/profile.yaml|PRIVATE_CONTEXT/);return fail?new Response('redacted error',{status:503}):response();}});t.after(()=>hub.close());
  const{call,upload}=await client(hub),profile=(await call('/api/status')).data.attachments.visionProfile;
  const chat=(await call('/api/chats',{})).data,id=randomUUID(),image=await upload(id);
  const body={id,text:'\u63cf\u8ff0\u5f62\u72b6\u989c\u8272',attachmentIds:[image.id],analyzeImages:true,visionConsent:true,visionProfileVersion:profile.version};
  assert.equal((await call(`/api/chats/${chat.id}/turns`,{...body,visionConsent:false})).status,428);
  assert.equal((await call(`/api/chats/${chat.id}/turns`,{...body,visionProfileVersion:'old'})).status,428);assert.equal(visionCalls,0);
  assert.equal((await call(`/api/chats/${chat.id}/turns`,body)).status,202);let turn=await settled(call,chat.id);assert.equal(turn.status,'error');assert.equal(visionCalls,1);
  assert.equal((await call(`/api/attachments/${image.id}`)).status,200);
  assert.equal((await call(`/api/chats/${chat.id}/retry`,{...body,attachmentIds:['f'.repeat(64)]})).status,409);
  assert.equal((await call(`/api/chats/${chat.id}/retry`,{...body,visionConsent:false})).status,428);fail=false;
  assert.equal((await call(`/api/chats/${chat.id}/retry`,body)).status,202);turn=await settled(call,chat.id);assert.equal(turn.status,'completed');assert.equal(turn.answer,'\u7eff\u8272\u77e9\u5f62');assert.equal(turn.attempts,2);assert.equal(turn.model.resolvedModel,'deepseek-flash');assert.equal(textCalls,0);
  assert.equal((await call(`/api/chats/${chat.id}/turns`,body)).data.duplicate,true);assert.equal(visionCalls,2);
  const privateId=randomUUID();await upload(privateId);assert.equal((await call(`/api/chats/${chat.id}/turns`,{...body,id:privateId,text:'private detail'})).status,202);assert.equal((await settled(call,chat.id)).status,'error');assert.equal(visionCalls,2);
  const stored=randomUUID();await upload(stored);assert.equal((await call(`/api/chats/${chat.id}/turns`,{id:stored,text:'',attachmentIds:[image.id]})).status,201);assert.equal(visionCalls,2);
  assert.equal(contextCalls,0,"Image analysis must not read private context");assert.equal((await call(`/api/chats/${chat.id}/turns`,{id:randomUUID(),text:'\u7ee7\u7eed\u89e3\u91ca\u521a\u624d\u7684\u56de\u7b54',engine:'claude',consent:true})).status,202);assert.equal((await settled(call,chat.id)).answer,'\u6587\u672c\u8ddf\u8fdb');assert.equal(textCalls,1);assert.equal(contextCalls,1);assert.equal(visionCalls,2);
});

test("Queued configuration changes prevent outbound requests and vision works without text CLI availability",async t=>{
  configure(t);const f=fixture(t);let releaseBegin,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>releaseBegin=r);let calls=0;
  const runner=Object.assign(async()=>{throw Error('Unavailable');},{available:false});
  const hub=await createHub({...f,engine:'claude',port:0,runner,adapter:{...adapter,begin:async()=>{entered();await wait;return null;}},visionFetcher:async()=>{calls++;return response();}});t.after(()=>hub.close());
  const{call,upload}=await client(hub),profile=(await call('/api/status')).data.attachments.visionProfile,chat=(await call('/api/chats',{})).data,id=randomUUID(),image=await upload(id);
  const body={id,text:'\u989c\u8272',attachmentIds:[image.id],analyzeImages:true,visionConsent:true,visionProfileVersion:profile.version};
  assert.equal((await call(`/api/chats/${chat.id}/turns`,body)).status,202);await started;process.env.ANTHROPIC_AUTH_TOKEN='changed';releaseBegin();assert.equal((await settled(call,chat.id)).status,'error');assert.equal(calls,0);
  const nextProfile=(await call('/api/status')).data.attachments.visionProfile;
  assert.equal((await call(`/api/chats/${chat.id}/retry`,{...body,visionProfileVersion:nextProfile.version})).status,202);assert.equal((await settled(call,chat.id)).status,'completed');assert.equal(calls,1);
});

test("Queued vision survives restart as archival only; normal queue release can schedule authorized work",async t=>{
  const f=fixture(t),store=createStore(f.root),attachments=createAttachments({...f,store});let schedules=0;const record=async()=>null;
  const chat={id:randomUUID(),title:'test',created:new Date().toISOString(),updated:new Date().toISOString(),turns:[]};store.saveChat(chat);
  const id=randomUUID(),bytes=await png(),req=Object.assign(Readable.from([bytes]),{headers:{'content-type':'image/png'}}),image=await attachments.upload(req,{owner:'test',scope:id,key:randomUUID()});
  const opts={chatId:chat.id,text:'synthetic',attachmentIds:[image.id],analyzeImages:true,visionConsent:true,visionProfileVersion:'old'};
  let box=createCaptureInbox({...f,store,attachments,record,schedule:()=>schedules++});box.enqueue('turn',id,opts);
  box=createCaptureInbox({...f,store,attachments,record,schedule:()=>schedules++});await box.flush();assert.equal(schedules,0);assert.equal(store.readChat(chat.id).turns[0].status,'interrupted');assert.equal(attachments.get(image.id,'').status,'archived');
  const next=randomUUID();box.enqueue('turn',next,{...opts});await box.flush();assert.equal(schedules,1);assert.equal(store.readChat(chat.id).turns[1].status,'queued');
  const stopped=randomUUID();box.enqueue('turn',stopped,{...opts});await box.flush({interruptModels:true});assert.equal(schedules,1);assert.equal(store.readChat(chat.id).turns[2].status,'interrupted');assert.equal(box.pending(),false);
});

test("Vision reports record actual models, status, and references; cross-day image events stay out of automatic distillation",async t=>{
  const f=fixture(t),store=createStore(f.root),now=Date.parse('2026-10-20T12:00:00Z'),day=logicalDay(now),id=randomUUID(),created='2026-10-19T12:00:00Z';
  store.saveChat({id:randomUUID(),title:'test',created,updated:created,turns:[{id,input:'picture',attachmentIds:['a'.repeat(64)],analyzeImages:true,processing:'vision',status:'completed',answer:'UNCONFIRMED_PICTURE_RESULT',model:{provider:'DeepSeek',resolvedModel:'deepseek-flash'},created}]});
  const dir=join(f.root,'state/events');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,day+'.jsonl'),JSON.stringify({event_id:'hub-answer-'+id,ts:new Date(now).toISOString(),data:'UNCONFIRMED_PICTURE_RESULT'})+'\n');
  const reports=createMainReports({...f,nodes:{list:()=>[]},runner:async()=>{throw Error();},now:()=>now});assert.equal(reports.sources(day).memoryExcludedEventIds,undefined,"Images added on other dates must not change this report fingerprint");await reports.daily(day);let calls=0;
  const distill=createMainDistillation({...f,reports,consent:true,adapter:()=>({allowedContent:()=>true}),runner:async()=>{calls++;throw Error('must not distill');}});assert.equal((await distill.run(day)).code,'empty');assert.equal(calls,0);
  const yesterday=logicalDay(Date.parse(created));await reports.daily(yesterday);const content=readFileSync(join(f.root,'user-space/logs/daily',`DAILY-NOTE_${yesterday}.md`),'utf8');assert.match(content,/analyzed.*DeepSeek.*deepseek-flash/);assert.match(content,/result unconfirmed/i);assert.doesNotMatch(content,/base64/);
});
