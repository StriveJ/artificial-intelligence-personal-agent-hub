import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createConflictReview} from '../lib/conflict-review.mjs';
import {createTaskGate} from '../lib/task-gate.mjs';
import {createConflictReviewPanel} from '../public/conflict-review.js';
import {createHub} from '../server.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const parent=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(parent,{recursive:true});const base=mkdtempSync(join(parent,'review-')),root=join(base,'instance'),runtimeDir=join(base,'runtime'),id='a'.repeat(24),path='user-space/memory/preferences.md',dir=join(root,'user-space/logs/hub/conflicts',id);
 for(const rel of ['.git','user-space/memory'])mkdirSync(join(root,rel),{recursive:true});mkdirSync(dir,{recursive:true});mkdirSync(runtimeDir);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n  version: synthetic\n');
 const a='## Synthetic choice\nRequire review\n',b='## Synthetic choice\nAllow without review\n',current='## Agreed\nKeep agreed text\n';
 for(const value of [a,b])writeFileSync(join(dir,hash(value)+'.bin'),value);
 const audit={id,createdAt:'2026-10-25T00:00:00Z',status:'pending-review',entries:[{path,strategy:'memory-conflict-quarantined',review:'pending',base:null,heads:[hash(a),hash(b)].sort(),evidence:[hash(a)+'.bin',hash(b)+'.bin']}]};
 writeFileSync(join(dir,'audit.json'),JSON.stringify(audit));writeFileSync(join(root,path),current);
 const service=options=>createConflictReview({root,runtimeDir,...options});
 const body=()=>({id:randomUUID(),path,revision:service().detail(id).entries[0].revision,choice:hash(a),confirmed:true,reason:'Synthetic human decision'});
 return {root,runtimeDir,id,path,dir,a,b,current,service,body};
}
test("Owner decisions verify observed revisions and preserve originals and idempotent receipts across refresh and rebuild",async()=>{
 const f=fixture(),review=f.service(),original=readFileSync(join(f.dir,'audit.json')),body=f.body();
 assert.equal(review.detail(f.id).entries[0].variants.length,2);
 await assert.rejects(()=>review.decide(f.id,{...body,confirmed:false}),/owner confirmation/i);
 await assert.rejects(()=>review.decide(f.id,{...body,reason:''}),/reason/i);
 await assert.rejects(()=>review.decide(f.id,{...body,revision:'stale'}),/changed/i);
 const result=await review.decide(f.id,body);assert.equal(result.actor,'user');assert.equal(result.currentMatches,true);assert.equal(readFileSync(join(f.root,f.path),'utf8'),f.a);
 assert.deepEqual(await f.service().decide(f.id,body),result);assert.deepEqual(readFileSync(join(f.dir,'audit.json')),original);assert.equal(readFileSync(join(f.dir,hash(f.current)+'.bin'),'utf8'),f.current);
 assert.equal(readdirSync(join(f.dir,'decisions')).length,1);assert.equal(f.service().detail(f.id).status,'resolved');
 await assert.rejects(()=>review.decide(f.id,{...body,choice:hash(f.b)}),/operation ID/i);
 writeFileSync(join(f.root,f.path),'Synthetic later edit');assert.equal((await review.decide(f.id,body)).currentMatches,false);assert.equal(review.detail(f.id).entries[0].status,'decision-needs-review');
});
test("Interrupted writes can be verified from the page without overwriting later changes",async()=>{
 for(const phase of ['prepared','after-write','after-receipt']){
  const f=fixture(),body=f.body(),review=f.service({fault:step=>{if(step===phase)throw Error('Synthetic interruption');}});
  await assert.rejects(()=>review.decide(f.id,body),/interruption/);
  const restarted=f.service(),pending=restarted.detail(f.id).pendingOperations;assert.equal(pending.length,1);assert.equal(pending[0].id,body.id);
  const result=await restarted.decide(f.id,body);assert.equal(result.status,'applied');assert.equal(restarted.detail(f.id).pendingOperations.length,0);assert.equal(readdirSync(join(f.dir,'decisions')).length,1);
 }
 const f=fixture(),body=f.body();await assert.rejects(()=>f.service({fault:s=>{if(s==='after-write')throw Error('Synthetic interruption');}}).decide(f.id,body));
 writeFileSync(join(f.root,f.path),'Synthetic concurrent edit');await assert.rejects(()=>f.service().decide(f.id,body),/overwrite refused/i);assert.equal(readFileSync(join(f.root,f.path),'utf8'),'Synthetic concurrent edit');
 const view=f.service().detail(f.id),entry=view.entries[0];const reconciled=await f.service().decide(f.id,{id:randomUUID(),path:f.path,revision:entry.revision,choice:'current',reason:'Synthetic explicit reconciliation',confirmed:true});assert.ok(reconciled.supersedes.includes(body.id));assert.equal(f.service().detail(f.id).pendingOperations.length,0);await assert.rejects(()=>f.service().decide(f.id,body),/newer decision/i);assert.equal(readFileSync(join(f.root,f.path),'utf8'),'Synthetic concurrent edit');
});
test("Maintenance or native task ownership defers decisions; path escapes and damaged evidence preserve originals",async()=>{
 const f=fixture(),review=f.service(),body=f.body(),gate=createTaskGate(f.root);gate.startSession('synthetic-task');assert.equal((await review.decide(f.id,body)).status,'deferred');assert.equal(existsSync(join(f.dir,'decisions')),false);gate.endSession('synthetic-task');
 gate.pause('synthetic-update');assert.equal((await review.decide(f.id,body)).status,'deferred');gate.resume('synthetic-update');
 writeFileSync(join(f.dir,hash(f.a)+'.bin'),'tampered');assert.throws(()=>review.detail(f.id),/digest mismatch/i);assert.equal(readFileSync(join(f.root,f.path),'utf8'),f.current);
 const audit=JSON.parse(readFileSync(join(f.dir,'audit.json')));audit.entries[0].path='../outside';writeFileSync(join(f.dir,'audit.json'),JSON.stringify(audit));assert.throws(()=>review.detail(f.id),/not allowed/i);
});
test("Concurrent cross-device decisions remain pending; keeping the current version resolves without erasing old receipts",async()=>{
 const f=fixture(),review=f.service(),first=await review.decide(f.id,f.body()),other={...first,id:randomUUID(),resultHash:hash(f.b),reason:'Synthetic other-device decision'};writeFileSync(join(f.dir,'decisions',other.id+'.json'),JSON.stringify(other));
 const entry=review.detail(f.id).entries[0];assert.equal(entry.status,'decision-needs-review');assert.equal(entry.leaves.length,2);
 const decision=await review.decide(f.id,{id:randomUUID(),path:f.path,revision:entry.revision,choice:'current',reason:'Synthetic reconciliation',confirmed:true});assert.equal(decision.supersedes.length,2);assert.equal(review.detail(f.id).status,'resolved');assert.equal(readdirSync(join(f.dir,'decisions')).length,3);
});
class Element{
 constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.textContent='';this.value='';}
 append(...items){this.children.push(...items);}prepend(...items){this.children.unshift(...items);}replaceChildren(...items){this.children=items;}
}
test("Decision UI shows both versions and reuses an operation ID for confirmation, recovery, and repeated clicks",async()=>{
 const doc={createElement:tag=>new Element(tag,doc)},container=new Element('div',doc),f=fixture(),messages=[];let calls=0,release,fail=true;
 const panel=createConflictReviewPanel({container,notify:message=>messages.push(message),newId:()=> 'synthetic-operation',request:async(path,body)=>{
  if(!body)return path.endsWith(f.id)?f.service().detail(f.id):{conflicts:f.service().list()};
  calls++;await new Promise(r=>release=r);if(fail){fail=false;throw Error('Synthetic transport failure');}return f.service().decide(f.id,body);
 }});
 await panel.load();await panel.show(f.id);const card=container.children.find(n=>n.className==='note-card'),select=card.children.find(n=>n.tag==='select'),reason=card.children.find(n=>n.tag==='textarea'),label=card.children.find(n=>n.tag==='label'),button=card.children.find(n=>n.tag==='button');
 assert.ok(card.children.some(n=>n.tag==='pre'&&n.textContent===f.a));select.value=hash(f.a);reason.value='Synthetic explicit choice';label.children[0].checked=true;
 await panel.load();assert.ok(container.children.includes(card),"Periodic refresh must preserve viewed versions and unsaved reasons");assert.equal(reason.value,'Synthetic explicit choice');
 const first=button.onclick();await button.onclick();await panel.load();assert.equal(calls,1);release();await first;assert.match(button.textContent,/retry/i);
 const retry=button.onclick();release();await retry;assert.equal(calls,2);assert.equal(readdirSync(join(f.dir,'decisions')).length,1);assert.equal(f.service().detail(f.id).status,'resolved');assert.ok(messages.includes("Decision saved; receipt available"));
});
test("Real main Hub HTTP covers authentication, Origin, task exclusion, static assets, and decision lookup",async t=>{
 const f=fixture(),adapter={owner:'Synthetic',version:'synthetic',requiresConsent:()=>false,begin:async()=>null,record:async()=>null,context:async()=>({prompt:'Synthetic',sources:[],omitted:0}),search:async()=>[],allowedContent:()=>true};
 const hub=await createHub({root:f.root,runtimeDir:f.runtimeDir,port:0,main:{enabled:true},adapter,runner:async()=>assert.fail('Conflict review must not call a model')});hub.scheduler.start=()=>{};t.after(()=>hub.close());const url=await hub.listen();let cookie;
 const request=(path,body,origin=url)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/conflict-review.js')).status,200);assert.equal((await request('/api/main/conflict-reviews')).status,401);
 const login=await request('/api/local-login',{});cookie=login.headers.get('set-cookie').split(';')[0];const endpoint='/api/main/conflict-reviews/'+f.id;
 const view=await(await request(endpoint)).json();assert.equal(view.entries[0].current,f.current);
 const body=f.body();assert.equal((await request(endpoint+'/decisions',body,'https://untrusted.example.invalid')).status,403);
 const gate=createTaskGate(f.root);gate.startSession('synthetic-native-session');assert.equal((await request(endpoint+'/decisions',body)).status,409);gate.endSession('synthetic-native-session');
 const response=await request(endpoint+'/decisions',body);assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.status,'applied');assert.deepEqual(await(await request(endpoint+'/decisions',body)).json(),receipt);
 assert.equal((await(await request(endpoint)).json()).status,'resolved');assert.equal(readdirSync(join(f.dir,'decisions')).length,1);
});
