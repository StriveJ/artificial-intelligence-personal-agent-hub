import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createAipaAdapter} from '../lib/aipa.mjs';
import {agendaCapability} from '../lib/agenda-capability.mjs';
import {installAgendaIntegration,restoreAgendaIntegration} from '../lib/agenda-integration.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),origin=resolve(process.env.AIPA_ORIGIN_ROOT||join(repo,'..','artificial-intelligence-origin-agent'));
const available=existsSync(join(origin,'product/core-space/scripts/lib/update-engine.mjs'));
if(process.env.AIPA_ORIGIN_ROOT&&!available)throw Error('AIPA_ORIGIN_ROOT must point to public Origin source');
test("Isolated upgrade matrix covers current public artifacts and Hub providers",{skip:available?false:'Set AIPA_ORIGIN_ROOT to run combined upgrade acceptance'},async t=>{
 const {createSyntheticFixture,LAB_ROOT}=await import(pathToFileURL(join(origin,'lab/support/synthetic-fixture.mjs')).href),f=createSyntheticFixture({parent:LAB_ROOT,prefix:'joint-upgrade-'}),previousEnv=process.env;process.env=f.env();t.after(()=>{process.env=previousEnv;});
 const {planUpdate,applyUpdate,recoverUpdate}=await import(pathToFileURL(join(origin,'product/core-space/scripts/lib/update-engine.mjs')).href),{writeChecksums}=await import(pathToFileURL(join(origin,'product/core-space/scripts/lib/origin-checksums.mjs')).href);
 const base=f.path('base'),target=f.path('target'),next=f.path('next'),bad=f.path('unsupported');
 const run=(script,args)=>execFileSync(process.execPath,[script,...args],{encoding:'utf8',stdio:'pipe',env:f.env(),windowsHide:true});
 const git=(root,...args)=>execFileSync('git',['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','core.longpaths=true','-C',f.checked(root),...args],{encoding:'utf8',stdio:'pipe',env:f.env(),windowsHide:true}).trim();
 run(join(origin,'studio/scripts/aipa-assemble-origin.mjs'),['--src',origin,'--dest',base]);
 function version(path,value){writeFileSync(join(path,'ORIGIN-MANIFEST.yaml'),readFileSync(join(path,'ORIGIN-MANIFEST.yaml'),'utf8').replace(/^  version:.+$/m,'  version: '+value));writeFileSync(join(path,'VERSION'),value+'\n');writeChecksums(path);}
 version(base,'0.23.0-beta.4');for(const [path,value] of [[target,'0.23.0-beta.5'],[next,'0.23.0-beta.6'],[bad,'0.23.0-beta.3']]){cpSync(base,path,{recursive:true});version(path,value);}
 const contract=JSON.parse(readFileSync(join(bad,'update-contract.json')));contract.capabilities=contract.capabilities.filter(c=>!['context-completeness-v1','agenda-provider-v1'].includes(c));writeFileSync(join(bad,'update-contract.json'),JSON.stringify(contract));writeChecksums(bad);
 const reports=[];
 function instance(name){
  const root=f.path(name),runtimeDir=f.path(name+'-runtime'),configFile=f.put(name+'-config.json',JSON.stringify({root,runtimeDir,testMode:true}));
  run(join(base,'scripts/aipa-init.mjs'),['--root',root,'--owner','Synthetic','--channel','beta','--telemetry','on']);
  f.put(name+'/user-space/memory/preferences.md','## Synthetic preference\nUse numbered conclusions.\n');
  f.put(name+'/user-space/memory/memory-meta.json',JSON.stringify({version:1,entries:{}}));
  f.put(name+'/user-space/reminders/synthetic.json',JSON.stringify({schema:2,id:'synthetic',title:'Synthetic reminder',status:'open',all_day:true,start_date:'2026-10-25',time_zone:'Asia/Shanghai',remind_at:'2026-10-24T15:00:00Z'}));
  const files=['user-space/profile.yaml','user-space/memory/preferences.md','user-space/memory/memory-meta.json','user-space/reminders/synthetic.json'],before=files.map(p=>readFileSync(join(root,p)));
  return {root,configFile,unchanged(){files.forEach((path,i)=>assert.deepEqual(readFileSync(join(root,path)),before[i],path));}};
 }
 async function scenario(name,fn){await t.test(name,async()=>{await fn();reports.push({scenario:name,status:'passed'});});}
 await scenario("Fresh artifacts pass Core integrity and consume schema 2",async()=>{
  const f1=instance('fresh'),adapter=await createAipaAdapter(f1.root);assert.equal(adapter.assertContextReady().status,'ready');assert.equal(agendaCapability(f1.root).native,true);
  const reminders=await import(pathToFileURL(join(f1.root,'core-space/scripts/lib/reminders.mjs')).href);assert.equal(reminders.listDueReminders(f1.root,'2026-10-25T00:00:00Z').length,1);f1.unchanged();
 });
 await scenario("Upgrades preserve provider bindings and personal bytes; old processes block and new processes work",async()=>{
  const f1=instance('native'),installed=installAgendaIntegration({configFile:f1.configFile,programDir:repo}),binding=readFileSync(join(f1.root,'.git/aipa-hub-agenda.json')),skill=readFileSync(join(f1.root,'user-space/skills/work/aipa-remind/SKILL.md')),adapter=await createAipaAdapter(f1.root);
  assert.equal(applyUpdate(f1.root,planUpdate(f1.root,target,{frameworkOnly:true})).status,'installed');assert.throws(()=>adapter.assertContextReady(),e=>e.code==='core_restart_required');
  assert.deepEqual(readFileSync(join(f1.root,'.git/aipa-hub-agenda.json')),binding);assert.deepEqual(readFileSync(join(f1.root,'user-space/skills/work/aipa-remind/SKILL.md')),skill);assert.equal(agendaCapability(f1.root).ready,true);
  const worker=f.put('fresh-process.mjs',`import {createAipaAdapter} from ${JSON.stringify(pathToFileURL(join(repo,'lib/aipa.mjs')).href)};const a=await createAipaAdapter(process.argv[2]);console.log(JSON.stringify({version:a.version,status:a.assertContextReady().status}));`);
  assert.deepEqual(JSON.parse(run(worker,[f1.root])),{version:'0.23.0-beta.5',status:'ready'});
  restoreAgendaIntegration({configFile:f1.configFile,backup:installed.backup});assert.equal(agendaCapability(f1.root).ready,true);f1.unchanged();
 });
 await scenario("Supported upgrade and downgrade preserve providers and personal records",()=>{
  const f1=instance('rollback');installAgendaIntegration({configFile:f1.configFile,programDir:repo});
  applyUpdate(f1.root,planUpdate(f1.root,target,{frameworkOnly:true}));applyUpdate(f1.root,planUpdate(f1.root,next,{frameworkOnly:true}));assert.throws(()=>planUpdate(f1.root,target,{frameworkOnly:true}),/allow-downgrade/);
  applyUpdate(f1.root,planUpdate(f1.root,target,{frameworkOnly:true,allowDowngrade:true}));assert.match(readFileSync(join(f1.root,'AIPA-MANIFEST.yaml'),'utf8'),/0\.23\.0-beta\.5/);assert.equal(agendaCapability(f1.root).ready,true);f1.unchanged();
 });
 await scenario("Targets without integrity or agenda capabilities reject even with downgrade allowed",()=>{
  const f1=instance('incompatible');installAgendaIntegration({configFile:f1.configFile,programDir:repo});const manifest=readFileSync(join(f1.root,'AIPA-MANIFEST.yaml'));
  assert.throws(()=>planUpdate(f1.root,bad,{frameworkOnly:true,allowDowngrade:true}),/missing behavior|provider interface/i);assert.deepEqual(readFileSync(join(f1.root,'AIPA-MANIFEST.yaml')),manifest);f1.unchanged();
 });
 await scenario("Legacy overlays reject explicitly and cannot masquerade as upstream baselines",()=>{
  const f1=instance('overlay'),marker=join(f1.root,'core-space/scripts/lib/hub-agenda-capability.json');writeFileSync(marker,JSON.stringify({version:1,schema:2,overlay:{version:1,owner:'synthetic-overlay',files:[]}}));git(f1.root,'add','--','core-space/scripts/lib/hub-agenda-capability.json');git(f1.root,'commit','-qm','synthetic overlay');
  assert.throws(()=>planUpdate(f1.root,target,{frameworkOnly:true}),/overlay/);assert.equal(existsSync(marker),true);f1.unchanged();
 });
 await scenario("Interrupted provider upgrades restore original Core and preserve agenda and bindings",()=>{
  const f1=instance('interrupted');installAgendaIntegration({configFile:f1.configFile,programDir:repo});const binding=readFileSync(join(f1.root,'.git/aipa-hub-agenda.json')),manifest=readFileSync(join(f1.root,'AIPA-MANIFEST.yaml'));
  assert.throws(()=>applyUpdate(f1.root,planUpdate(f1.root,target,{frameworkOnly:true}),{fault:phase=>{if(phase==='write')throw Error('Synthetic joint interruption');}}),/Synthetic joint interruption/);
  assert.equal(recoverUpdate(f1.root).status,'rolled-back');assert.deepEqual(readFileSync(join(f1.root,'AIPA-MANIFEST.yaml')),manifest);assert.deepEqual(readFileSync(join(f1.root,'.git/aipa-hub-agenda.json')),binding);assert.equal(agendaCapability(f1.root).ready,true);f1.unchanged();
 });
 f.put('matrix-report.json',JSON.stringify({schema:1,status:reports.length===6?'passed':'failed',node:process.version,platform:process.platform,scenarios:reports,model:'none',personalInstanceAccess:false,limitations:['\u7248\u672c\u548c\u80fd\u529b\u58f0\u660e\u6765\u81ea\u5f53\u524d\u516c\u5f00\u6e90\u7801\u7684\u5408\u6210\u4ea7\u7269，\u4e0d\u5192\u5145\u5b9e\u9645\u5386\u53f2\u53d1\u884c\u5305','Core \u5b89\u88c5\u4e0d\u542f\u52a8\u771f\u5b9e Hub；\u91cd\u542f\u4ee5\u72ec\u7acb\u5408\u6210\u9002\u914d\u5668\u8fdb\u7a0b\u9a8c\u8bc1','\u7a0b\u5e8f\u66f4\u65b0\u5feb\u7167/\u542f\u52a8\u8bfb\u53d6\u8303\u56f4\u987b\u53e6\u9a8c，\u4e0d\u636e\u6b64\u5ba3\u79f0 Hub \u66f4\u65b0\u96f6\u4e2a\u4eba\u8d44\u6599\u8bfb\u53d6','\u672a\u8986\u76d6 Linux、\u771f\u5b9e\u4e3b\u4ece\u90e8\u7f72\u6216\u4e2a\u4eba\u5b9e\u4f8b\u5b89\u88c5']},null,2)+'\n');
});
