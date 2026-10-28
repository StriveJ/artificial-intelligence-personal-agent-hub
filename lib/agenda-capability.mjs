import {readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readJson,safeInstancePath} from './storage.mjs';
import {agendaError} from './agenda.mjs';

export const AGENDA_CAPABILITY_PATH='core-space/scripts/lib/hub-agenda-capability.json';
export const AGENDA_NATIVE_PATH='core-space/scripts/lib/agenda-interface.json';
export const AGENDA_CONSUMERS=['core-space/scripts/lib/hub-agenda-records.mjs','core-space/scripts/lib/reminders.mjs','core-space/scripts/lib/reminder-plugin.mjs'];
export const agendaHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const expectedRecords=agendaHash(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'agenda.mjs')));
// Verified historical format identity remains readable; new writes use the current contract.
const legacyNativeRecordsHash='bbe78db625e9373fbed9692becdad62169e6fec1a5e533c0749a82ffaa169b08';
const legacyConsumerRecordsHash='30aa3e6bb15f3641e13137eeb3ffa4d3ff485db54aabd9b01ce78b4ec047a88d';
const canonicalHash=text=>agendaHash(String(text).replace(/\r\n/g,'\n'));
const hubRecords=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'agenda.mjs'),'utf8').replace(/\r\n/g,'\n');
const nativeRecords="// Core agenda format source; the Hub mirror is verified by synthetic contract tests.\nimport {createHash} from 'node:crypto';\n"+hubRecords.slice(hubRecords.indexOf('export const agendaError'),hubRecords.indexOf('export function createAgenda'));
export function agendaCapability(root){
  try{
    const nativePath=safeInstancePath(root,join(root,AGENDA_NATIVE_PATH));
    if(existsSync(nativePath)){
      const manifest=readJson(nativePath,null),readers=['agenda-records.mjs','reminders.mjs','reminder-plugin.mjs','agenda-provider.mjs'];
      if(manifest?.version!==1||manifest.provider!=='aipa-signal agenda'||manifest.writer_schema!==2||!manifest.schemas?.includes(2)||Object.keys(manifest.files||{}).length!==readers.length)return {ready:false,reason:"Unsupported Core native agenda interface version"};
      if(![canonicalHash(nativeRecords),legacyNativeRecordsHash].includes(manifest.files['agenda-records.mjs']))return {ready:false,reason:"Core and Hub agenda format contracts differ"};
      for(const name of readers){const path=safeInstancePath(root,join(root,'core-space/scripts/lib',name));if(!existsSync(path)||canonicalHash(readFileSync(path,'utf8'))!==manifest.files[name])return {ready:false,reason:"Core native agenda interface files changed. Verify framework installation."};}
      return {ready:true,version:1,schema:2,native:true,provider:manifest.provider};
    }
    const path=safeInstancePath(root,join(root,AGENDA_CAPABILITY_PATH)),proof=readJson(path,null);
    if(proof?.version!==1||proof.schema!==2||!proof.files||Object.keys(proof.files).length!==AGENDA_CONSUMERS.length)return {ready:false,reason:"Agenda read-compatibility layer is not installed"};
    if(![expectedRecords,legacyConsumerRecordsHash].includes(proof.files[AGENDA_CONSUMERS[0]]))return {ready:false,reason:"Agenda read-compatibility layer needs an update"};
    for(const relative of AGENDA_CONSUMERS){const target=safeInstancePath(root,join(root,relative));if(!existsSync(target)||agendaHash(readFileSync(target))!==proof.files[relative])return {ready:false,reason:"Agenda read-compatibility layer changed. Verify installation again."};}
    return {ready:true,version:1,schema:2};
  }catch{return {ready:false,reason:"Cannot verify agenda read-compatibility layer"};}
}
export function agendaWriteState({root,runtimeDir,enabled=true}){
  const capability=agendaCapability(root);
  let control;try{control=readJson(join(runtimeDir,'agenda-write-control.json'),{enabled:true});}catch{return {...capability,writable:false,reason:"Cannot read agenda write control"};}
  if(enabled!==true||control?.enabled!==true)return {...capability,writable:false,reason:"Agenda writes are paused; existing agenda items remain readable"};
  return {...capability,writable:capability.ready};
}
export function assertAgendaWritable(options){const state=agendaWriteState(options);if(!state.writable)throw Object.assign(agendaError(state.reason+"; proposal and original input preserved; agenda not saved",428),{code:'agenda_write_unavailable'});}
