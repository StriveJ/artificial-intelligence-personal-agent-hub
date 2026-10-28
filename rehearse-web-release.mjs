import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildRelease,verifyRelease,sha256} from './lib/release-package.mjs';
import {createTaskGate} from './lib/task-gate.mjs';
import {createRequire} from 'node:module';

const option=(k,f)=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:f;
const repo=realpathSync(resolve('.')),work=resolve(option('--work','.aipa-hub/web-release-rehearsal'));
const rel=relative(repo,work);
if(!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(work))throw new Error("Rehearsal directory must be a fresh standalone directory within the source tree");
const baselineFile=resolve(option('--baseline')),candidateFile=resolve(option('--candidate')),trustFile=resolve(option('--trust')),framework=resolve(option('--framework'));
const installer=resolve(option('--installer','install-managed.mjs')),evidence=resolve(option('--evidence','.aipa-hub/web-release-rehearsal-result.json'));
const imageWeb=process.argv.includes('--image-web'),images=imageWeb||process.argv.includes('--images'),dependencies=images?realpathSync(resolve(option('--dependencies','node_modules'))):null;
if(!existsSync(join(framework,'lib/privacy-policy.mjs')))throw new Error("Generic framework scripts are required; personal instances are not accepted as fixtures");
const trust=JSON.parse(readFileSync(trustFile)),baseline=verifyRelease(baselineFile,trust,{role:'main'}),candidate=verifyRelease(candidateFile,trust,{role:'main'});
if(candidate.manifest.sequence<=baseline.manifest.sequence)throw new Error("Candidate sequence must be greater than baseline");
mkdirSync(work,{recursive:true,mode:0o700});
const run=(file,args=[])=>execFileSync(process.execPath,[file,...args],{encoding:'utf8',stdio:'pipe',windowsHide:true,cwd:repo,timeout:120000}).trim();
const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath='+join(work,'empty-hooks'),'-c','commit.gpgsign=false','-C',cwd,...args],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
const root=join(work,'instance'),runtimeDir=join(work,'runtime'),base=join(work,'program'),catalog=join(work,'catalog');
for(const path of [root,runtimeDir,base,catalog,join(work,'empty-hooks')])mkdirSync(path,{recursive:true});
const installationId=randomUUID(),configFile=join(work,'config.json'),installationFile=join(work,'installation.json'),localTrust=join(work,'trust.json');
const {privateKey,publicKey}=generateKeyPairSync('ed25519');trust.keys['rehearsal-only']=publicKey.export({type:'spki',format:'pem'});
writeFileSync(localTrust,JSON.stringify(trust));
for(const file of [baselineFile,candidateFile])cpSync(file,join(catalog,JSON.parse(readFileSync(file)).payload.manifest.releaseId+'.hubpkg.json'));
const brokenSource=join(work,'broken-source');mkdirSync(brokenSource);
for(const [name,content]of Object.entries(candidate.contents)){const target=join(brokenSource,name);mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,Buffer.from(content,'base64'));}
const managed=join(brokenSource,'lib/managed-runtime.mjs'),original=readFileSync(managed,'utf8'),patched=original.replace('releaseId: process.env.AIPA_HUB_RELEASE_ID',"releaseId: 'rehearsal-wrong-release'");assert.notEqual(patched,original);writeFileSync(managed,patched);
git(brokenSource,'init');git(brokenSource,'add','-A');git(brokenSource,'-c','user.name=release-test','-c','user.email=test@localhost','commit','-m','Synthetic bad candidate');
const badId=candidate.manifest.releaseId+'-bad';
const bad=buildRelease({source:brokenSource,manifest:{...candidate.manifest,releaseId:badId,sequence:candidate.manifest.sequence+1,sourceCommit:git(brokenSource,'rev-parse','HEAD')},privateKey,keyId:'rehearsal-only'});
writeFileSync(join(catalog,badId+'.hubpkg.json'),JSON.stringify(bad));
git(root,'init');writeFileSync(join(root,'.git/aipa-hub-no-push.json'),'{"reason":"isolated-release-rehearsal"}\n');
writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'owner: release-fixture\nversion: 1\n');
cpSync(framework,join(root,'core-space/scripts'),{recursive:true});mkdirSync(join(root,'user-space/memory'),{recursive:true});
writeFileSync(join(root,'core-space/policy.md'),'Synthetic mandatory policy: use only the isolated test instance.\n');
writeFileSync(join(root,'user-space/privacy.yaml'),'upload_policy:\n  mode: ask\n');
writeFileSync(join(root,'user-space/profile.yaml'),'name: release-fixture\n');
const cli=join(work,'fake-model.cjs');writeFileSync(cli,"process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'synthetic model answer'}})));\n");
const cliJs=join(work,'fake-model.js');cpSync(cli,cliJs);
writeFileSync(configFile,JSON.stringify({root,runtimeDir,engine:'codex',port:0,testMode:true,tasks:{'repo-sync':{enabled:false}},briefing:{enabled:false},main:{modelConsent:false}}));
writeFileSync(installationFile,JSON.stringify({base,configFile,role:'main',installationId,catalogDir:catalog,probationMs:1200}));
const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
writeFileSync(join(runtimeDir,'web-search.json'),JSON.stringify({provider:'bocha',apiKey:'fixture-legacy-key',dailyCap:80,usage:{day,count:2}}));
run(installer,['--installation',installationFile,'--package',baselineFile,'--trust',localTrust]);
if(images)cpSync(dependencies,join(base,'releases',baseline.manifest.releaseId,'node_modules'),{recursive:true});
if(option('--bootstrap')){const previous=realpathSync(resolve(option('--bootstrap'))),proof=JSON.parse(readFileSync(join(previous,'bootstrap.json')));for(const[name,hash]of Object.entries(proof.files))assert.equal(sha256(readFileSync(join(previous,name))),hash);cpSync(previous,join(base,'bootstrap'),{recursive:true});}
let launcher,exited=false;let result;
const log=[];
function ctl(command,body){const args=['update',command,'--config',configFile];if(body){const file=join(work,'body-'+randomUUID()+'.json');writeFileSync(file,JSON.stringify(body));args.push('--body',file);}return JSON.parse(run('hubctl.mjs',args));}
async function until(label,fn){const deadline=Date.now()+90000;while(Date.now()<deadline){if(exited)throw new Error('launcher unexpectedly exited');try{const v=await fn();if(v)return v;}catch(error){if(Date.now()+1000>=deadline)throw error;}await delay(200);}throw new Error('Timed out: '+label);}
const status=()=>ctl('status');
async function switchTo(id,action='upgrade',beforeApply){const s=status(),plan=ctl('plan',{target:{kind:'main',installationId},action,releaseId:id,expectedCurrentReleaseId:s.current.releaseId,expectedDeploymentGeneration:s.current.deploymentGeneration,when:'idle',waitTimeoutSeconds:30});ctl('prepare',{id:plan.id});
  if(images&&id!==baseline.manifest.releaseId){const target=join(base,'releases',id),modules=join(target,'node_modules');if(!existsSync(modules))cpSync(dependencies,modules,{recursive:true});const require=createRequire(join(target,'server.mjs'));assert.ok(realpathSync(require.resolve('sharp')).startsWith(realpathSync(modules)));const version=execFileSync(process.execPath,['-e',"console.log(require('node:module').createRequire(process.argv[1])('sharp').versions.sharp)",join(target,'server.mjs')],{encoding:'utf8',windowsHide:true}).trim();assert.equal(version,'0.35.5');}
  const ready=ctl('get-plan',{id:plan.id}),release=beforeApply?await beforeApply():null;let op;
  try{op=ctl('apply',{id:plan.id,expectedPlanRevision:ready.revision});if(release)await until('maintenance',()=>createTaskGate(root).maintenance()?.reason==='update');}finally{release?.();}
  await until('switch',()=>status().active===null);return ctl('operation',{id:op.id});}
function origin(){const lines=readFileSync(join(runtimeDir,'managed-hub.log'),'utf8').split('\n').reverse();for(const line of lines){try{const data=JSON.parse(line);if(data.status==='ready'&&data.url)return data.url;}catch{}}throw new Error('No main URL');}
async function client(){const url=origin(),login=await fetch(url+'/api/local-login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:'{}'});assert.equal(login.status,200);const Cookie=login.headers.get('set-cookie').split(';')[0];const request=async(path,body)=>{const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,Cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.ok(response.ok,`${path}: ${response.status}`);return data;};request.upload=async(id,bytes)=>{const res=await fetch(url+'/api/attachments',{method:'POST',headers:{Origin:url,Cookie,'Content-Type':'image/png','X-Aipa-Draft':id,'Idempotency-Key':randomUUID()},body:bytes});assert.equal(res.status,201);return res.json();};return request;}
let image,photo,photoChat,pendingChat,cachedFile,cachedDigest;
function checkImages(){const metadata=JSON.parse(readFileSync(join(root,'user-space/logs/hub/attachments',photo.id,'metadata.json')));assert.equal(sha256(readFileSync(join(root,'user-space/logs/hub/attachments',photo.id,'image.webp'))),metadata.sha256);const notes=JSON.parse(readFileSync(join(root,'user-space/logs/hub/notes/image-note-record.json')));assert.deepEqual(notes.attachmentIds,[photo.id]);const view=JSON.parse(readFileSync(join(root,'user-space/logs/hub/conversations',photoChat.id+'.json')));assert.deepEqual(view.turns[0].attachmentIds,[photo.id]);}
try{
  launcher=spawn(process.execPath,[join(base,'bootstrap/hub-launcher.mjs'),'--installation',installationFile],{cwd:repo,env:{...process.env,AIPA_CODEX_ENTRY:cliJs,...(images?{OPENAI_BASE_URL:'https://api.deepseek.com/v1',OPENAI_API_KEY:'synthetic-rehearsal-key'}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});launcher.on('exit',()=>{exited=true;});launcher.stdout.on('data',d=>log.push(String(d)));launcher.stderr.on('data',d=>log.push(String(d)));
  await until('baseline',()=>status().knownGood.includes(baseline.manifest.releaseId));
  let api=await client();assert.equal((await api('/api/web-search/settings')).settings.apiKeySet,true);
  await api('/api/notes',{id:'before-upgrade-note',text:'synthetic baseline note'});
  const up=await switchTo(candidate.manifest.releaseId);assert.equal(up.status,'succeeded');
  api=await client();const settings=await api('/api/web-search/settings');assert.equal(settings.settings.apiKeySet,true);assert.equal(settings.usedToday,2);
  await api('/api/notes',{id:'after-upgrade-note',text:'synthetic new record kept after rollback'});
  if(images){const sharp=(await import('sharp')).default;image=await sharp({create:{width:80,height:40,channels:3,background:'#167457'}}).png().toBuffer();photo=await api.upload('image-note-record',image);await api('/api/notes',{id:'image-note-record',text:'synthetic photo',attachmentIds:[photo.id]});photoChat=await api('/api/chats',{});const upload=await api.upload('image-chat-record',image);await api(`/api/chats/${photoChat.id}/turns`,{id:'image-chat-record',text:'',attachmentIds:[upload.id]});pendingChat=await api('/api/chats',{});checkImages();}
  if(imageWeb){const cached=await api('/api/chats',{});cachedFile=join(root,'user-space/logs/hub/conversations',cached.id+'.json');cached.turns=[{id:'cached-image-web',input:'synthetic public topic',attachmentIds:[photo.id],analyzeImages:true,allowWeb:true,imageWebConsent:true,visionConsent:true,status:'error',attempts:1,created:new Date().toISOString(),processing:'vision-web',imageWeb:{version:1,identity:'synthetic',stage:'search',recognition:{status:'completed',value:{answer:'synthetic public object',model:{resolvedModel:'deepseek-flash'}}},query:{status:'completed',value:{query:'public official docs'}},search:{status:'failed',error:'synthetic outage'}}}];writeFileSync(cachedFile,JSON.stringify(cached,null,2)+'\n');cachedDigest=sha256(readFileSync(cachedFile));}
  const chat=await api('/api/chats',{}),profile=await api('/api/status');
  await api(`/api/chats/${chat.id}/turns`,{id:'model-check-turn',text:'synthetic question',engine:'codex',consent:true,modelProfileVersion:profile.modelProfileVersion});
  await until('model answer',async()=>{const view=await api(`/api/chats/${chat.id}`);return view.turns[0]?.status==='completed';});
  const failed=await switchTo(badId);assert.equal(failed.status,'failed');assert.equal(failed.recovered,true);assert.equal(status().current.releaseId,candidate.manifest.releaseId);
  const down=await switchTo(baseline.manifest.releaseId,'rollback',images?async()=>{
    api=await client();const webBeforeGate=await api('/api/web-search/settings');const gate=createTaskGate(root),lease=gate.acquire('sync');assert.ok(lease);
    try{const note=await api.upload('pending-photo-note',image);await api('/api/notes',{id:'pending-photo-note',text:'pending picture preserved during rollback',attachmentIds:[note.id]});const turn=await api.upload('pending-photo-turn',image);await api(`/api/chats/${pendingChat.id}/turns`,{id:'pending-photo-turn',text:'pending vision must not send',attachmentIds:[turn.id],analyzeImages:true,visionConsent:true,visionProfileVersion:profile.attachments.visionProfile.version,...(imageWeb?{allowWeb:true,imageWebConsent:true,webProfileVersion:webBeforeGate.settings.revision}:{})});}catch(e){gate.release(lease.token);throw e;}
    return()=>gate.release(lease.token);
  }:undefined);assert.equal(down.status,'succeeded');
  api=await client();const legacy=await api('/api/web-search/settings');assert.equal(legacy.settings.apiKeySet,true);assert.equal(legacy.usedToday,2);
  if(imageWeb)assert.equal(sha256(readFileSync(cachedFile)),cachedDigest);
  assert.equal((await api('/api/notes')).notes.some(n=>n.id==='after-upgrade-note'),true);
  if(images){checkImages();const pending=JSON.parse(readFileSync(join(root,'user-space/logs/hub/notes/pending-photo-note.json')));assert.deepEqual(pending.attachmentIds,[photo.id]);const view=await api(`/api/chats/${pendingChat.id}`);assert.equal(view.turns[0].status,'interrupted');assert.equal(view.turns[0].analyzeImages,true);assert.deepEqual(view.turns[0].attachmentIds,[photo.id]);assert.equal(JSON.parse(readFileSync(join(runtimeDir,'capture-inbox/turn-pending-photo-turn.json'))).status,'delivered');}
  await api('/api/web-search/settings',{provider:'bocha',apiKey:'fixture-key-after-rollback'});
  const state=JSON.parse(readFileSync(join(runtimeDir,'web-search.json')));state.usage={day,count:3};writeFileSync(join(runtimeDir,'web-search.json'),JSON.stringify(state));
  assert.equal((await switchTo(candidate.manifest.releaseId)).status,'succeeded');api=await client();
  assert.equal((await api('/api/web-search/settings')).usedToday,3);
  assert.equal(JSON.parse(readFileSync(join(runtimeDir,'web-search-credentials.json'))).keys.bocha,'fixture-key-after-rollback');
  assert.equal((await api('/api/notes')).notes.length>=2,true);assert.equal(existsSync(join(root,'.git/aipa-hub-no-push.json')),true);assert.equal(status().maintenance,null);
  if(images){checkImages();assert.equal((await api('/api/attachments/'+photo.id)).status,'archived');const view=await api(`/api/chats/${pendingChat.id}`);assert.equal(view.turns[0].status,'interrupted');assert.equal(view.turns[0].attempts,1);}
  if(imageWeb){assert.equal(sha256(readFileSync(cachedFile)),cachedDigest);const view=await api(`/api/chats/${pendingChat.id}`);assert.equal(view.turns[0].imageWebConsent,true);assert.equal(view.turns[0].allowWeb,true);}
  result={platform:process.platform,node:process.version,baseline:baseline.manifest.releaseId,candidate:candidate.manifest.releaseId,upgrade:true,failedCandidateRecovered:true,explicitRollback:true,reupgrade:true,newRecordsKept:true,legacyCredentialsKept:true,quotaNotDecreased:true,noPushMarkerKept:true,syntheticModelAnswered:true,...(images?{attachmentsKept:true,pendingAttachmentsArchived:true,visionNotReplayed:true,nativeDependencyVerified:true}:{}),productionDeployment:false};
  if(imageWeb)Object.assign(result,{imageWebStagesKept:true,imageWebNotReplayed:true});
  mkdirSync(resolve(evidence,'..'),{recursive:true});writeFileSync(evidence,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{
  if(launcher&&!exited){launcher.kill();for(let i=0;i<150&&!exited;i++)await delay(200);if(!exited)throw new Error("Isolated launcher did not exit; directory preserved for review");}
  if(result){const checked=realpathSync(work);if(checked!==work||!checked.startsWith(repo+ (process.platform==='win32'?'\\':'/')))throw new Error("Invalid cleanup scope");rmSync(checked,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  else if(log.length)console.error('REHEARSAL_FAILED '+log.join('').slice(-3000));
}
