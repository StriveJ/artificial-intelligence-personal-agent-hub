import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,rmSync,cpSync,writeFileSync} from 'node:fs';
import {join,resolve,sep,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {hubSupport,hubSupportMarkdown,supportDiagnostics,contextDiagnostic,HUB_PROTOCOL} from '../lib/support-contract.mjs';
import {supportSummary} from '../public/status.js';
import {createAipaAdapter} from '../lib/aipa.mjs';
import {createHub} from '../server.mjs';
const HERE=resolve(dirname(fileURLToPath(import.meta.url)),'..'),ORIGIN=resolve(process.env.AIPA_ORIGIN_ROOT||join(HERE,'..','artificial-intelligence-origin-agent'));
const {coreSupport}=await import(pathToFileURL(join(ORIGIN,'product/core-space/scripts/lib/support-contract.mjs')).href);
const TMP=resolve('aipa-test-tmp');mkdirSync(TMP,{recursive:true});
function fixture(t){const base=mkdtempSync(join(TMP,'support-')),root=join(base,'instance'),f={base,root};mkdirSync(join(root,'user-space'),{recursive:true});writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n  version: 0.23.0\n  owner: Synthetic\n');writeFileSync(join(root,'user-space/privacy.yaml'),'upload_policy:\n  mode: ask\n');t.after(async()=>{await f.close?.();assert.ok(base.startsWith(TMP+sep));rmSync(base,{recursive:true,force:true});});return f;}

test("Hub support derives from package and protocol; missing declarations, capabilities, and restart states are distinct",()=>{
 const pkg=JSON.parse(readFileSync(join(HERE,'package.json'))),hub=hubSupport();assert.equal(hub.node,pkg.engines.node);assert.deepEqual(hub.dependencies,pkg.dependencies);assert.deepEqual(hub.protocol,HUB_PROTOCOL);
 const doc=readFileSync(join(HERE,'README.md'),'utf8'),generated=doc.split('<!-- aipa-support:hub:begin -->')[1].split('<!-- aipa-support:hub:end -->')[0].trim().replace(/\r\n/g,'\n');assert.equal(generated,hubSupportMarkdown());
 const options={role:'main',core:{status:'ready',code:'current',sourceSha256:'a'.repeat(64)},coreSupport:coreSupport(),coreVersion:'0.23.0',context:null,engine:'claude',engineAvailable:true};
 let report=supportDiagnostics(options);assert.equal(report.combination.status,'declared');assert.equal(report.context.status,'not-checked');assert.equal(report.personalDataInspected,false);assert.equal(report.releaseAcceptance,'not-checked');
 assert.equal(supportDiagnostics({...options,coreSupport:null}).combination.status,'unverified');
 assert.equal(supportDiagnostics({...options,coreSupport:{...coreSupport(),context:{...coreSupport().context,completeness:2}}}).combination.status,'unverified');
 report=supportDiagnostics({...options,coreSupport:{...coreSupport(),capabilities:coreSupport().capabilities.filter(c=>c!=='context-completeness-v1')}});assert.equal(report.combination.status,'unsupported');assert.deepEqual(report.combination.missing,['context-completeness-v1']);
 const failure={code:'required_context_private',message:'SYNTHETIC_PRIVATE_BODY',contextIssues:[{body:'SYNTHETIC_PRIVATE_BODY'}]};report=supportDiagnostics({...options,context:failure});assert.equal(report.context.status,'blocked');assert.doesNotMatch(JSON.stringify(report),/SYNTHETIC_PRIVATE_BODY/);assert.match(supportSummary(report),/Privacy settings block required rules/);
 report=supportDiagnostics({...options,core:{status:'blocked',code:'core_restart_required'}});assert.match(supportSummary(report),/restart/i);assert.equal(contextDiagnostic({code:'SYNTHETIC_PRIVATE_BODY'}).status,'not-checked');
});

test("Core adapter exposes loaded-generation declarations and retains them after code changes without claiming reload",async t=>{
 const {root}=fixture(t);cpSync(join(ORIGIN,'product/core-space'),join(root,'core-space'),{recursive:true});const adapter=await createAipaAdapter(root);assert.deepEqual(adapter.coreSupport,coreSupport());assert.equal(adapter.coreRuntimeStatus().status,'ready');
 writeFileSync(join(root,'core-space/scripts/lib/support-contract.mjs'),'// Synthetic changed code');assert.equal(adapter.coreRuntimeStatus().code,'core_restart_required');const report=supportDiagnostics({core:adapter.coreRuntimeStatus(),coreSupport:adapter.coreSupport,coreVersion:adapter.version});assert.equal(report.core.program.status,'restart-required');assert.equal(report.core.baselineDrift,'not-checked');
});

test("Paired status diagnoses blocked Core; context failures and retries clear accurately without diagnostic model calls",async t=>{
 const f=fixture(t),{base,root}=f;writeFileSync(join(root,'user-space/profile.yaml'),'SYNTHETIC_PRIVATE_BODY');let blocked=true,calls=0,current={status:'ready',code:'current',sourceSha256:'b'.repeat(64)};
 execFileSync('git',['-c','core.hooksPath=/dev/null','init','--quiet',root],{stdio:'pipe',windowsHide:true});
 const adapter={owner:'Synthetic',version:'0.23.0',coreSupport:coreSupport(),coreRuntimeStatus:()=>current,requiresConsent:()=>true,begin:async()=>null,record:async()=>null,assertContextReady:()=>{if(blocked)throw Object.assign(Error('SYNTHETIC_PRIVATE_BODY'),{code:'required_context_unavailable'});},context:async()=>({prompt:'Synthetic prompt',sources:[],omitted:0})};
 const hub=await createHub({root,runtimeDir:join(base,'runtime'),adapter,runner:async()=>{calls++;return 'Synthetic answer';},engine:'claude',port:0,testMode:true});f.close=()=>hub.close();const origin=await hub.listen();let cookie='';
 const request=(path,body)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/api/status')).status,401);const login=await request('/api/local-login',{});cookie=login.headers.get('set-cookie').split(';')[0];
 let report=(await (await request('/api/status')).json()).diagnostics;assert.equal(report.context.status,'not-checked');assert.equal(calls,0);
 const chat=await (await request('/api/chats',{})).json();
 const complete=async()=>{for(let deadline=Date.now()+10000;Date.now()<deadline;){const value=await (await request('/api/chats/'+chat.id)).json();if(value.turns.length&&!['queued','running'].includes(value.turns.at(-1).status))return value.turns.at(-1);await delay(20);}throw Error('Synthetic request timed out');};
 assert.equal((await request('/api/chats/'+chat.id+'/turns',{id:'synthetic-turn',text:'Synthetic request',consent:true,engine:'claude'})).status,202);assert.equal((await complete()).status,'error');assert.equal(calls,0);
 report=(await (await request('/api/status')).json()).diagnostics;assert.equal(report.context.code,'required_context_unavailable');assert.doesNotMatch(JSON.stringify(report),/SYNTHETIC_PRIVATE_BODY/);
 blocked=false;assert.equal((await request('/api/chats/'+chat.id+'/retry',{id:'synthetic-turn',consent:true,engine:'claude'})).status,202);assert.equal((await complete()).status,'completed');assert.equal(calls,1);report=(await (await request('/api/status')).json()).diagnostics;assert.equal(report.context.status,'checked');
 current={status:'blocked',code:'core_restart_required'};const response=await request('/api/status');assert.equal(response.status,200);report=(await response.json()).diagnostics;assert.equal(report.core.program.status,'restart-required');assert.equal((await request('/readyz')).status,503);const runtime=await (await request('/api/runtime/status')).json();assert.equal(runtime.main.diagnostics.core.program.status,'restart-required');assert.equal(calls,1);
});

test('Invalid response-language configuration is a blocked context diagnostic without private metadata',()=>{
  assert.deepEqual(contextDiagnostic({code:'response_language_unavailable',message:'SYNTHETIC_PRIVATE_TAG'}),{status:'blocked',stage:'context',code:'response_language_unavailable'});
});
