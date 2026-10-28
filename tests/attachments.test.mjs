import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRepoSync} from '../lib/repo-sync.mjs';
import {createTaskGate} from '../lib/task-gate.mjs';
import {snapshotInstallation} from '../lib/update-snapshot.mjs';
import {createMainHub} from '../main-server.mjs';
import {createMainReports} from '../lib/main-reports.mjs';
import sharp from 'sharp';
import {createAttachments} from '../lib/attachments.mjs';
import {createStore} from '../lib/storage.mjs';
import {createCaptureInbox} from '../lib/capture-inbox.mjs';
import {createHub} from '../server.mjs';
const TMP=resolve('aipa-test-tmp');mkdirSync(TMP,{recursive:true});
function fixture(t){const base=mkdtempSync(join(TMP,'images-')),root=join(base,'instance'),runtimeDir=join(base,'runtime');mkdirSync(root);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa: {}');t.after(()=>{assert.ok(base.startsWith(TMP));rmSync(base,{recursive:true,force:true});});const store=createStore(root);return {base,root,runtimeDir,store};}
const png=()=>sharp({create:{width:64,height:32,channels:3,background:'#238b58'}}).png().toBuffer();
const request=(bytes,mime='image/png')=>Object.assign(Readable.from([bytes]),{headers:{'content-type':mime,'content-length':bytes.length}});
const options=(scope=randomUUID(),owner='owner')=>({scope,owner,key:randomUUID()});
test("Image decoding handles orientation, metadata removal, content addressing, idempotency, and draft ownership",async t=>{
  const f=fixture(t),a=createAttachments(f),o=options(),bytes=await sharp(await png()).withExif({IFD0:{Artist:'private artist'}}).toBuffer();
  const image=await a.upload(request(bytes),o);assert.match(image.id,/^[a-f0-9]{64}$/);assert.equal(image.status,'received');
  const staged=a.get(image.id,o.owner);const meta=await sharp(staged.bytes).metadata();assert.equal(meta.format,'webp');assert.equal(meta.exif,undefined);
  assert.deepEqual(await a.upload(request(bytes),o),image);
  await assert.rejects(()=>a.upload(request(awaitPng),o));
  assert.throws(()=>a.prepare([image.id],'other',o.scope),/does not belong/i);assert.throws(()=>a.prepare([image.id],o.owner,randomUUID()),/does not belong/i);
  a.prepare([image.id],o.owner,o.scope);a.archive([image.id]);assert.equal(a.get(image.id,'another paired device').status,'archived');
  assert.equal(createHash('sha256').update(a.get(image.id,'').bytes).digest('hex'),image.id);
});
const awaitPng=Buffer.from('different invalid input');
test("Reject disguised, animated, wrong-MIME, damaged, oversized, or excessive-pixel images and changed duplicate keys",async t=>{
  const a=createAttachments(fixture(t));
  await assert.rejects(()=>a.upload(request(Buffer.from('<svg/>'),'image/png'),options()),e=>e.status===415);
  await assert.rejects(()=>a.upload(request(Buffer.from('x'),'image/svg+xml'),options()),e=>e.status===415);
  await assert.rejects(()=>a.upload(request(awaitPng,'image/webp'),options()),e=>e.status===415);
  await assert.rejects(async()=>a.upload(request(await png(),'image/jpeg'),options()),e=>e.status===415);
  await assert.rejects(()=>a.upload(request(Buffer.alloc(10*1024*1024+1)),options()),e=>e.status===413);
  const big=await sharp({create:{width:5000,height:5000,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(()=>a.upload(request(big),options()),e=>e.status===415);
  const o=options();await a.upload(request(await png()),o);await assert.rejects(()=>a.upload(request(Buffer.from('replacement')),o),e=>e.status===409);
  const broken=Readable.from((async function*(){yield Buffer.from('short');throw Error('broken connection');})());broken.headers={'content-type':'image/png'};
  await assert.rejects(()=>a.upload(broken,options()));assert.ok((await a.upload(request(await png()),options())).id);
});
test("Pending images survive restart; expired drafts are collected without model calls and referenced images cannot be deleted",async t=>{
  const f=fixture(t);let now=Date.now(),a=createAttachments({...f,clock:()=>now}),o=options();const pic=await a.upload(request(await png()),o);
  let calls=0;let inbox=createCaptureInbox({...f,attachments:a,schedule:()=>calls++,record:async()=>null});
  inbox.enqueue('note',o.scope,{text:'',attachmentIds:[pic.id]});now+=2*86400_000;a.gc();assert.ok(a.get(pic.id,o.owner));
  a=createAttachments({...f,clock:()=>now});inbox=createCaptureInbox({...f,attachments:a,schedule:()=>calls++,record:async()=>null});await inbox.flush();
  assert.equal(f.store.listNotes()[0].attachmentIds[0],pic.id);assert.equal(calls,0);assert.equal(a.get(pic.id,'').status,'archived');
  assert.throws(()=>a.remove(pic.id,o.owner,o.scope,{confirmArchived:true}),e=>e.status===409);
  const draft=await a.upload(request(await sharp(await png()).negate().png().toBuffer()),options());now+=2*86400_000;a.gc();assert.throws(()=>a.get(draft.id,'owner'),e=>e.status===404);
});
test("Image HTTP checks authentication, Origin, and draft ownership; save-only chat never calls a model",async t=>{
  const f=fixture(t);let modelCalls=0;
  const hub=await createHub({...f,port:0,runner:async()=>{modelCalls++;return 'not expected';},adapter:{owner:'Example',version:'test',requiresConsent:()=>true,begin:async()=>null,record:async()=>null,search:async()=>[],context:async()=>{throw Error('No model');}}});
  const url=await hub.listen();t.after(()=>hub.close());
  const login=await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(path,body)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:url,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const bytes=await png(),scope=randomUUID();
  const upload=(headers={})=>fetch(url+'/api/attachments',{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'image/png','X-Aipa-Draft':scope,'Idempotency-Key':randomUUID(),...headers},body:bytes});
  assert.equal((await upload({Cookie:''})).status,401);assert.equal((await upload({Origin:'https://other.example'})).status,403);
  const res=await upload();assert.equal(res.status,201);const image=await res.json();
  assert.equal((await call('/api/notes',{id:randomUUID(),text:'bad ownership',attachmentIds:[image.id]})).status,404);
  const saved=await call('/api/notes',{id:scope,text:'',attachmentIds:[image.id]});assert.equal(saved.status,200);assert.equal((await saved.json()).attachmentIds[0],image.id);
  assert.equal((await call('/api/notes',{id:scope,text:'',attachmentIds:[image.id]})).status,200);
  const content=await call(`/api/attachments/${image.id}/content`);assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'image/webp');assert.match(content.headers.get('cache-control'),/private/);
  assert.equal((await fetch(url+`/api/attachments/${image.id}/content`)).status,401);
  const chat=await (await call('/api/chats',{})).json();
  const turn=await call(`/api/chats/${chat.id}/turns`,{id:scope,text:'',attachmentIds:[image.id]});assert.equal(turn.status,201);
  const view=await (await call(`/api/chats/${chat.id}`)).json();assert.equal(view.turns[0].status,'completed');assert.match(view.turns[0].answer,/without analysis or sending to a model/i);assert.equal(modelCalls,0);assert.equal(view.title,"Image note");
  assert.equal((await (await call('/api/chats')).json()).chats.find(c=>c.id===chat.id).title,"Image note");
  f.store.saveChat({...view,title:' '});const legacyPath=join(f.root,'user-space/logs/hub/conversations',chat.id+'.json'),legacyBytes=readFileSync(legacyPath);
  assert.equal((await (await call('/api/chats')).json()).chats.find(c=>c.id===chat.id).title,"Image note");assert.deepEqual(readFileSync(legacyPath),legacyBytes);
  assert.equal((await call(`/api/chats/${chat.id}/turns`,{id:scope,text:'changed',attachmentIds:[image.id]})).status,409);
  const other=(await (await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'})).headers.get('set-cookie')).split(';')[0];
  const draft=await upload();assert.equal(draft.status,201);
  assert.equal((await call('/api/notes',{id:scope,text:'wrong second session',attachmentIds:[image.id]})).status,409);
  assert.notEqual(other,cookie);
});

test("Queued image-only notes and analysis turns get nonempty titles; restart archival never invokes a model",async t=>{
  const f=fixture(t);let calls=0;
  for(const [analyzeImages,allowWeb,count] of [[false,false,1],[true,false,1],[true,true,2]]){
    const chat=f.store.createChat(),id=randomUUID(),ids=['a'.repeat(64),'b'.repeat(64)].slice(0,count),args={...f,schedule:()=>calls++,record:async()=>null};
    let inbox=createCaptureInbox(args);inbox.enqueue('turn',id,{chatId:chat.id,text:'',attachmentIds:ids,analyzeImages,allowWeb,visionConsent:analyzeImages,imageWebConsent:allowWeb});
    inbox=createCaptureInbox(args);await inbox.flush();const view=f.store.readChat(chat.id);
    assert.equal(view.title,analyzeImages?`Image conversation${count>1?' (2 images)':''}`:"Image note");assert.deepEqual(view.turns[0].attachmentIds,ids);assert.equal(view.turns[0].status,analyzeImages?'interrupted':'completed');
  }
  assert.equal(calls,0);
});

test("Image orientation is corrected and processing concurrency is bounded",async t=>{
  const a=createAttachments(fixture(t)),bytes=await sharp(await png()).jpeg().withMetadata({orientation:6}).toBuffer();
  const task=a.upload(request(bytes,'image/jpeg'),options());
  await assert.rejects(()=>a.upload(request(bytes,'image/jpeg'),options()),e=>e.status===429);
  const image=await task;assert.equal(image.width,32);assert.equal(image.height,64);
});

test("Synthetic two-device image sync preserves bytes, references, and snapshots without test-mode pushes",async t=>{
  const f=fixture(t),git=(cwd,...args)=>execFileSync('git',['-c','core.longpaths=true','-c','core.autocrlf=false','-c','user.name=Image Test','-c','user.email=image@example.invalid','-C',cwd,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git(f.root,'init','--initial-branch=master');git(f.root,'add','.');git(f.root,'commit','-m','synthetic baseline');
  const origin=join(f.base,'origin.git'),other=join(f.base,'other');git(f.base,'clone','--bare',f.root,origin);git(f.base,'clone',origin,other);git(f.root,'remote','add','origin',origin);git(f.root,'fetch','origin');git(f.root,'branch','--set-upstream-to=origin/master');
  const a=createAttachments(f),o=options(),first=await a.upload(request(await png()),o);a.archive([first.id]);f.store.saveNote(o.scope,'local',undefined,[first.id]);
  const b=createAttachments({root:other,runtimeDir:join(f.base,'other-runtime'),store:createStore(other)}),p=options();
  const second=await b.upload(request(await sharp(await png()).negate().png().toBuffer()),p);b.archive([second.id]);createStore(other).saveNote(p.scope,'remote',undefined,[second.id]);
  git(other,'add','.');git(other,'commit','-m','other device image');git(other,'push');const remoteBefore=git(origin,'rev-parse','HEAD');
  const sync=createRepoSync({...f,testMode:true,push:true,autoResolve:true,capturePaths:['user-space']});await sync();
  assert.equal(git(origin,'rev-parse','HEAD'),remoteBefore,'no remote push');assert.equal(f.store.listNotes().length,2);
  assert.equal(a.get(first.id,'').meta.id,first.id);assert.equal(a.get(second.id,'').meta.id,second.id);
  createTaskGate(f.root).state();const configFile=join(f.base,'config.json');writeFileSync(configFile,JSON.stringify({root:f.root,runtimeDir:f.runtimeDir}));
  const destination=join(f.base,'snapshot');await snapshotInstallation({...f,configFile,destination});
  assert.deepEqual(readFileSync(join(destination,'instance/user-space/logs/hub/attachments',first.id,'image.webp')),a.get(first.id,'').bytes);
});

test("Same-ID image conflicts derive separate content addresses and repair references while preserving review evidence",async t=>{
  const f=fixture(t),git=(cwd,...args)=>execFileSync('git',['-c','core.longpaths=true','-c','core.autocrlf=false','-c','user.name=Image Test','-c','user.email=image@example.invalid','-C',cwd,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  const old='f'.repeat(64),asset=join(f.root,'user-space/logs/hub/attachments',old);mkdirSync(asset,{recursive:true});
  const base=await sharp(await png()).webp().toBuffer();writeFileSync(join(asset,'image.webp'),base);writeFileSync(join(asset,'metadata.json'),JSON.stringify({version:1,id:old,sha256:old,mime:'image/webp',width:64,height:32,bytes:base.length}));
  f.store.saveNote('collision-note','same shared record',undefined,[old]);
  git(f.root,'init','--initial-branch=master');git(f.root,'add','.');git(f.root,'commit','-m','synthetic legacy image');
  const origin=join(f.base,'origin.git'),other=join(f.base,'other');git(f.base,'clone','--bare',f.root,origin);git(f.base,'clone',origin,other);git(f.root,'remote','add','origin',origin);git(f.root,'fetch','origin');git(f.root,'branch','--set-upstream-to=origin/master');
  const left=await sharp(await png()).negate().webp().toBuffer(),right=await sharp(await png()).grayscale().webp().toBuffer();
  writeFileSync(join(asset,'image.webp'),left);writeFileSync(join(other,'user-space/logs/hub/attachments',old,'image.webp'),right);git(other,'add','.');git(other,'commit','-m','other image version');git(other,'push');
  const remoteBefore=git(origin,'rev-parse','HEAD');const sync=createRepoSync({...f,testMode:true,push:true,autoResolve:true,capturePaths:['user-space']});const result=await sync();assert.equal(result.status,'success',JSON.stringify(result));
  const ids=[left,right].map(b=>createHash('sha256').update(b).digest('hex')).sort();assert.deepEqual(f.store.listNotes()[0].attachmentIds,ids);
  const a=createAttachments(f);for(const id of ids)assert.equal(a.get(id,'').meta.sha256,id);
  assert.equal(git(origin,'rev-parse','HEAD'),remoteBefore);assert.match(git(f.root,'show','HEAD:user-space/logs/hub/notes/collision-note.json'),new RegExp(ids[0]));
  assert.ok(result.conflicts || result.auditId || readFileSync(join(f.root,'user-space/logs/hub/notes/collision-note.md'),'utf8').includes(ids[0]));
});

test("Main sync gate queues text and images durably; restart archival avoids model replay and reports contain references only",async t=>{
  const f=fixture(t);execFileSync('git',['init',f.root],{stdio:'pipe'});let calls=0;
  const adapter={owner:'test',version:'1',requiresConsent:()=>true,begin:async()=>null,record:async()=>null,allowedContent:()=>false,search:async()=>[],context:async()=>{throw Error();}};
  let hub=await createMainHub({...f,adapter,runner:async()=>{calls++;return '';},port:0,tasks:{'repo-sync':{enabled:false}}});
  const origin=await hub.listen();const login=await fetch(origin+'/api/local-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});const cookie=login.headers.get('set-cookie').split(';')[0];
  const gate=createTaskGate(f.root),lease=gate.acquire('sync');assert.ok(lease);const id=randomUUID();
  try {
    const upload=await fetch(origin+'/api/attachments',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'image/png','X-Aipa-Draft':id,'Idempotency-Key':randomUUID()},body:await png()});assert.equal(upload.status,201);const pic=await upload.json();
    const save=await fetch(origin+'/api/notes',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({id,text:'isolated pending image',attachmentIds:[pic.id]})});assert.equal(save.status,202);assert.equal(f.store.listNotes().length,0);
    await hub.close();hub=null;gate.release(lease.token);
    const images=createAttachments(f),box=createCaptureInbox({...f,attachments:images,schedule:()=>calls++,record:async()=>null});await box.flush();
    assert.equal(calls,0);assert.equal(f.store.listNotes()[0].attachmentIds[0],pic.id);assert.equal(images.get(pic.id,'').status,'archived');
    const reports=createMainReports({...f,nodes:{list:()=>[]},runner:async()=>{throw Error('no model');},now:Date.now});
    const day=new Date(Date.now()+2*3600000).toISOString().slice(0,10),sources=reports.sources(day);assert.equal(sources.web[0].imageProcessing,'stored-only');assert.deepEqual(sources.web[0].attachmentIds,[pic.id]);assert.doesNotMatch(JSON.stringify(sources),/base64/);
  }finally{await hub?.close();if(gate.state()?.token===lease.token)gate.release(lease.token);}
});
