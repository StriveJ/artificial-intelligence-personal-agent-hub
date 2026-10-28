import {createHash} from 'node:crypto';
export const EVENT_IDENTITY_SCHEMA=1;
const normalize=value=>String(value??'').trim().toLowerCase();
const valid=value=>/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(value);
export function eventIdentity(row,fileHost='',{shard=false}={}){
 const file=normalize(fileHost),own=normalize(row?.host),host=shard&&valid(file)?file:valid(own)?own:valid(file)?file:'legacy';
 return row?.event_id?JSON.stringify([host,row.sid||'',row.event_id]):'';
}
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
export function eventContentHash(row){
 const instant=typeof row.ts==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.ts)&&Number.isFinite(Date.parse(row.ts));
 return createHash('sha256').update(JSON.stringify(stable([row.type||'',row.data??'',row.project||'',instant?new Date(row.ts).toISOString():'',instant?'':row.ts_local||'']))).digest('hex');
}
