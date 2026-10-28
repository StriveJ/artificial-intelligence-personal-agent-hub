import {readFileSync,existsSync,mkdirSync,unlinkSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {readJson,atomicWrite,safeInstancePath,writeJson} from './storage.mjs';
import {createTaskGate,ownsTaskLease} from './task-gate.mjs';
import {AGENDA_CAPABILITY_PATH,AGENDA_NATIVE_PATH,AGENDA_CONSUMERS,agendaCapability} from './agenda-capability.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const hash=text=>createHash('sha256').update(text).digest('hex');
const TARGETS=['core-space/scripts/aipa-agenda.mjs',...AGENDA_CONSUMERS,'user-space/skills/work/aipa-remind/SKILL.md','.git/aipa-hub-agenda.json',AGENDA_CAPABILITY_PATH];
const NATIVE_TARGETS=['user-space/skills/work/aipa-remind/SKILL.md','.git/aipa-hub-agenda.json'];
function installNative({root,config,configFile,programDir}){
  const capability=agendaCapability(root);if(!capability.ready||!capability.native)throw Error(capability.reason||"Core native agenda interface unavailable");
  const skill=safeInstancePath(root,join(root,NATIVE_TARGETS[0])),binding=safeInstancePath(root,join(root,NATIVE_TARGETS[1]));
  if(existsSync(skill)&&!/^name: aipa-remind\s*$/m.test(readFileSync(skill,'utf8')))throw Error("Existing reminder skill identity differs; not overwritten");
  const text=readFileSync(join(HERE,'agenda-skill.md'),'utf8').replaceAll('core-space/scripts/aipa-agenda.mjs',"core-space/scripts/aipa-signal.mjs agenda --root <absolute-instance-path>");
  const files=new Map([[skill,text],[binding,JSON.stringify({version:1,configFile:resolve(configFile),programDir:resolve(programDir)},null,2)+'\n']]);
  const before=[...files.keys()].map(path=>({path,text:existsSync(path)?readFileSync(path,'utf8'):null,installed:hash(files.get(path))}));
  const control=join(config.runtimeDir,'agenda-write-control.json'),oldControl=existsSync(control)?readFileSync(control,'utf8'):null;
  const backup=join(config.runtimeDir,'agenda-integration-backups',randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});writeJson(join(backup,'restore.json'),{version:3,provider:'aipa-signal agenda',files:before});
  try{for(const [path,value] of files)atomicWrite(path,value);writeJson(control,{enabled:true});}
  catch(error){for(const entry of before){if(entry.text===null){if(existsSync(entry.path))unlinkSync(entry.path);}else atomicWrite(entry.path,entry.text);}if(oldControl===null){if(existsSync(control))unlinkSync(control);}else atomicWrite(control,oldControl);throw error;}
  return {installed:true,native:true,provider:capability.provider,files:files.size,backup};
}
function guarded(root,operation,{sessionId,leaseToken=process.env.AIPA_HUB_TASK_TOKEN}={}){
  const gate=createTaskGate(root);
  if(gate.maintenance())throw Error("Instance is under maintenance. Install or restore agenda integration after maintenance.");
  const held=gate.state(),owned=ownsTaskLease(held,{sessionId,leaseToken}),lease=owned?null:gate.acquire('task');
  if(!owned&&!lease)throw Error("Instance task or synchronization is active; agenda integration unchanged");
  try{return operation();}finally{if(lease)gate.release(lease.token);}
}
function hasModernAgenda(root){
  const dir=safeInstancePath(root,join(root,'user-space/reminders'));
  for(const name of existsSync(dir)?readdirSync(dir):[]){
    if(!name.endsWith('.json'))continue;
    try{const record=JSON.parse(readFileSync(safeInstancePath(root,join(dir,name)),'utf8').replace(/^\uFEFF/,''));if(!record||![1,undefined].includes(record.schema))return true;}catch{return true;}
  }
  return false;
}
export function installAgendaIntegration({configFile,programDir=resolve(HERE,'..'),sessionId}={}){
  const config=readJson(resolve(configFile),null),root=config?.root;
  if(!root||!config.runtimeDir||!existsSync(join(root,'.git'))||!existsSync(join(programDir,'lib','agenda-cli.mjs')))throw Error("Instance and agenda program are not ready");
  if(!lstatSync(join(root,'.git')).isDirectory()||lstatSync(join(root,'.git')).isSymbolicLink())throw Error("Integration supports standalone instance repositories only");
  return guarded(root,()=>{
  if(existsSync(safeInstancePath(root,join(root,AGENDA_NATIVE_PATH))))return installNative({root,config,configFile,programDir});
  const files=new Map(),script=rel=>safeInstancePath(root,join(root,rel));
  files.set(script('core-space/scripts/aipa-agenda.mjs'),readFileSync(join(HERE,'agenda-bridge.mjs'),'utf8'));
  files.set(script('core-space/scripts/lib/hub-agenda-records.mjs'),readFileSync(join(HERE,'agenda.mjs'),'utf8'));
  const oldRemindersPath=script('core-space/scripts/lib/reminders.mjs'),oldPluginPath=script('core-space/scripts/lib/reminder-plugin.mjs');
  let reminders=readFileSync(oldRemindersPath,'utf8').replace(/\r\n/g,'\n'),plugin=readFileSync(oldPluginPath,'utf8').replace(/\r\n/g,'\n');
  if(!reminders.includes('hub-agenda-records.mjs')){
    if(!reminders.includes('export function isExpired(reminder, nowMs) {'))throw Error("Reminder framework version incompatible; not installed");
    reminders="import {normalized as normalizeHubAgenda,timing as hubAgendaTiming} from './hub-agenda-records.mjs';\n"+reminders.replace('export function isExpired(reminder, nowMs) {',"export function isExpired(reminder, nowMs) {\n  if(reminder.schema===2){try{return nowMs>=hubAgendaTiming(normalizeHubAgenda(reminder),nowMs).end+24*60*60*1000;}catch{return true;}}\n");
  }
  if(!plugin.includes('hub-agenda:all-day')){
    if(!plugin.includes('displayAt(r.event_at)'))throw Error("Reminder renderer version incompatible; not installed");
    plugin='// hub-agenda:all-day\n'+plugin.replaceAll('displayAt(r.event_at)',"(r.all_day ? r.start_date+' all day' : displayAt(r.event_at))");
  }
  files.set(oldRemindersPath,reminders);files.set(oldPluginPath,plugin);
  const skillPath=script('user-space/skills/work/aipa-remind/SKILL.md');
  if(existsSync(skillPath)&&!/^name: aipa-remind\s*$/m.test(readFileSync(skillPath,'utf8')))throw Error("Existing reminder skill identity differs; not overwritten");
  files.set(skillPath,readFileSync(join(HERE,'agenda-skill.md'),'utf8'));
  const binding=script('.git/aipa-hub-agenda.json');files.set(binding,JSON.stringify({version:1,configFile:resolve(configFile),programDir:resolve(programDir)},null,2)+'\n');
  const previousOverlay=readJson(script(AGENDA_CAPABILITY_PATH),null)?.overlay?.files||[];
  const overlayFiles=[...files].filter(([p])=>p.includes('core-space')).map(([path,text])=>{
    const relative=path.slice(root.length+1).replace(/\\/g,'/'),current=existsSync(path)?hash(readFileSync(path,'utf8')):null,installed=hash(text),prior=previousOverlay.find(row=>row.path===relative);
    return {path:relative,base_sha256:prior&&prior.installed_sha256===current&&current===installed?prior.base_sha256:current,installed_sha256:installed};
  });
  files.set(script(AGENDA_CAPABILITY_PATH),JSON.stringify({version:1,schema:2,overlay:{version:1,owner:'aipa-hub-agenda',files:overlayFiles},files:Object.fromEntries(AGENDA_CONSUMERS.map(p=>[p,hash(files.get(script(p)))]))},null,2)+'\n');
  const before=[...files.keys()].map(path=>({path,text:existsSync(path)?readFileSync(path,'utf8'):null,installed:hash(files.get(path))}));
  const control=join(config.runtimeDir,'agenda-write-control.json'),oldControl=existsSync(control)?readFileSync(control,'utf8'):null;
  const backup=join(config.runtimeDir,'agenda-integration-backups',randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});writeJson(join(backup,'restore.json'),{version:2,files:before});
  try{for(const [path,text] of files)atomicWrite(path,text);writeJson(control,{enabled:true});}catch(e){for(const old of before){if(old.text===null){try{unlinkSync(old.path);}catch{}}else atomicWrite(old.path,old.text);}if(oldControl===null){if(existsSync(control))unlinkSync(control);}else atomicWrite(control,oldControl);throw e;}
  return {installed:true,files:files.size,backup};
  },{sessionId});
}
export function restoreAgendaIntegration({configFile,backup,keepCompatible=false,sessionId}={}){
  const config=readJson(resolve(configFile),null),root=config?.root;
  if(!root||!config.runtimeDir)throw Error("Invalid instance configuration");
  return guarded(root,()=>{
  const base=resolve(config.runtimeDir,'agenda-integration-backups');
  const backupPath=safeInstancePath(base,resolve(backup,'restore.json'));
  const data=readJson(backupPath,null),native=data?.version===3,allowed=new Set((native?NATIVE_TARGETS:TARGETS).map(p=>safeInstancePath(root,join(root,p))));
  const count=native?NATIVE_TARGETS.length:data?.version===1?TARGETS.length-1:TARGETS.length;
  if(![1,2,3].includes(data?.version)||!Array.isArray(data.files)||data.files.length!==count||new Set(data.files.map(x=>x.path)).size!==count||data.version===1&&data.files.some(x=>x.path===join(root,AGENDA_CAPABILITY_PATH)))throw Error("Invalid integration backup");
  for(const entry of data.files){
    if(!allowed.has(entry.path)||entry.text!==null&&typeof entry.text!=='string'||!existsSync(entry.path)||hash(readFileSync(safeInstancePath(root,entry.path),'utf8'))!==entry.installed)throw Error("Installed files changed or backup is invalid; overwrite stopped");
  }
  if(!native&&!keepCompatible&&hasModernAgenda(root))throw Error("Instance has newer or unverifiable agenda data. Read compatibility cannot be removed; use --keep-compatible to pause writes and preserve reads.");
  if(keepCompatible&&!agendaCapability(root).ready)throw Error("Existing read-compatibility layer cannot be verified; restoration not performed");
  const preserved=new Set([...AGENDA_CONSUMERS,AGENDA_CAPABILITY_PATH].map(p=>join(root,p))),selected=data.files.filter(entry=>!keepCompatible||!preserved.has(entry.path));
  const control=join(config.runtimeDir,'agenda-write-control.json'),oldControl=existsSync(control)?readFileSync(control,'utf8'):null;
  const current=selected.map(entry=>({path:entry.path,text:readFileSync(entry.path,'utf8')}));
  try{writeJson(control,{enabled:false});for(const entry of selected){if(entry.text===null)unlinkSync(entry.path);else atomicWrite(entry.path,entry.text);}}
  catch(error){for(const entry of current)atomicWrite(entry.path,entry.text);if(oldControl===null){if(existsSync(control))unlinkSync(control);}else atomicWrite(control,oldControl);throw error;}
  return {restored:true,files:selected.length,compatibilityKept:keepCompatible,writingEnabled:false};
  },{sessionId});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const at=process.argv.indexOf('--config');if(at<0)throw Error("--config <hub-config> is required");const rollback=process.argv.indexOf('--restore'),session=process.argv.indexOf('--task-session'),options={configFile:process.argv[at+1],sessionId:session<0?undefined:process.argv[session+1]};console.log(JSON.stringify(rollback<0?installAgendaIntegration(options):restoreAgendaIntegration({...options,backup:process.argv[rollback+1],keepCompatible:process.argv.includes('--keep-compatible')})));}catch(e){console.error(e.message);process.exitCode=1;}
}
