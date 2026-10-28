import {readFileSync} from 'node:fs';

const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
export const HUB_PROTOCOL=Object.freeze({min:1,max:1});
export const HUB_RUNTIME_SCHEMA=1;
export const REQUIRED_CORE_CAPABILITIES=['context-projection-v1','context-completeness-v1','memory-lifecycle-v1','business-clock-v1','memory-usage-receipts-v1'];
export function hubSupport(){return {schema:1,version:manifest.version,node:manifest.engines.node,dependencies:{...manifest.dependencies},protocol:{...HUB_PROTOCOL},runtimeSchema:HUB_RUNTIME_SCHEMA,requiredCoreCapabilities:[...REQUIRED_CORE_CAPABILITIES]};}
export function hubSupportMarkdown(){const value=hubSupport();return ["| Hub contract | Source declaration |",'|---|---|',`| Program version / Node requirement | ${value.version} / ${value.node} |`,`| Package dependencies | ${Object.entries(value.dependencies).map(([name,version])=>name+' '+version).join(', ')} |`,`| Main/sub protocol range / Runtime format | ${value.protocol.min}–${value.protocol.max} / schema ${value.runtimeSchema} |`,`| Core capabilities required for shared context | ${value.requiredCoreCapabilities.join(', ')} |`].join('\n');}

const contextCodes=new Set(['required_context_unavailable','required_context_private','required_context_exceeds_budget','context_privacy_unavailable','context_contract_unsupported','response_language_unavailable']);
export function contextDiagnostic(value){
 if(value?.status==='ready')return {status:'checked',stage:'context',code:'ready'};
 if(contextCodes.has(value?.code))return {status:'blocked',stage:'context',code:value.code};
 return {status:'not-checked',stage:'context',code:'not_checked'};
}
const version=value=>typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value)?value:null;
export function supportDiagnostics({role,core,coreSupport,coreVersion,context,engine,engineAvailable}={}){
 const capabilities=Array.isArray(coreSupport?.capabilities)?[...new Set(coreSupport.capabilities.filter(value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,95}-v[1-9][0-9]*$/.test(value)))].sort():[];
 const declared=coreSupport?.schema===1&&coreSupport?.updateSchema===1&&coreSupport?.context?.completeness===1&&coreSupport?.context?.projection===1&&Array.isArray(coreSupport?.capabilities);
 const missing=declared?REQUIRED_CORE_CAPABILITIES.filter(value=>!capabilities.includes(value)):[];
 return {schema:1,role:['main','legacy','sub'].includes(role)?role:'unknown',hub:hubSupport(),environment:{node:process.version,platform:process.platform,arch:process.arch},core:{version:version(coreVersion),declaration:declared?'present':'unavailable',capabilities,contextCompleteness:declared?coreSupport.context.completeness:null,program:{status:core?.code==='current'&&core.status==='ready'?'matching':core?.code==='core_restart_required'?'restart-required':'unverified',sourceSha256:/^[a-f0-9]{64}$/.test(core?.sourceSha256||'')?core.sourceSha256:null},baselineDrift:'not-checked'},combination:{status:!declared?'unverified':missing.length?'unsupported':'declared',missing},context:contextDiagnostic(context),executor:{engine:['claude','codex','harness'].includes(engine)?engine:'unknown',available:engineAvailable===true},personalDataInspected:false,dataCompatibility:'not-checked',releaseAcceptance:'not-checked'};
}
