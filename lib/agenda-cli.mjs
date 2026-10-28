import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {subCommand} from './sub-ipc.mjs';

export async function runAgendaCommand({config,command='list',text='',id,confirmed=false,consent=false,hostProposal,hostModel,sessionId,preview=false,offset=0,targetId,agendaAction}={}){
  if(!config?.root||!config.runtimeDir)throw Error("A valid Hub configuration is required");
  if(!['list','propose','confirm'].includes(command))throw Error("Only list/propose/confirm are supported");
  if(config.nodeId){
    const status=await subCommand(config.runtimeDir,'status');if(!status.agenda)throw Error("This sub Hub has no agenda interface. Update Hub first.");
    const args={id:command==='propose'?id||randomUUID():id,text,confirmed,consent,modelProfileVersion:status.model.version,hostProposal,hostModel,sessionId,preview,offset,targetId,agendaAction,leaseToken:process.env.AIPA_HUB_TASK_TOKEN};
    return subCommand(config.runtimeDir,`agenda-${command}`,args);
  }
  const origin=`http://127.0.0.1:${config.port||4317}`;
  const taskHeaders={...(process.env.AIPA_HUB_TASK_TOKEN?{'X-Aipa-Task-Lease':process.env.AIPA_HUB_TASK_TOKEN}:{}),...(sessionId?{'X-Aipa-Task-Session':sessionId}:{})};
  const login=await fetch(origin+'/api/local-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
  if(!login.ok)throw Error("Cannot connect to the local main Hub");const cookie=login.headers.get('set-cookie')?.split(';')[0];
  async function api(path,body){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...taskHeaders},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});const value=await r.json();if(!r.ok)throw Error(value.error||"Agenda operation did not complete");return value;}
  if(command==='list')return api(`/api/agenda?offset=${offset}${preview?'&mode=preview':''}`);
  if(command==='confirm')return api('/api/agenda/confirm',{id,confirmed});
  const profile=await api('/api/agenda-settings');
  return api('/api/agenda/actions',{id:id||randomUUID(),text,consent,modelProfileVersion:profile.model.version,targetId,action:agendaAction,hostProposal,hostModel});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),arg=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
    const config=JSON.parse(readFileSync(resolve(arg('config')),'utf8'));
    const result=await runAgendaCommand({config,command:arg('command')||'list',text:arg('text')||'',id:arg('id'),confirmed:args.includes('--confirmed'),consent:args.includes('--consent'),preview:args.includes('--preview'),offset:Number(arg('offset')||0),hostProposal:arg('host-plan')?JSON.parse(readFileSync(resolve(arg('host-plan')),'utf8')):undefined,hostModel:arg('host-model'),sessionId:arg('task-session'),targetId:arg('target-id'),agendaAction:arg('action')});
    console.log(JSON.stringify(result,null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
