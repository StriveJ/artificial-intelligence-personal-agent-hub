import {existsSync, readdirSync, readFileSync,realpathSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

function safeInstancePath(root,path){
  const base=realpathSync(root),full=resolve(path),rel=relative(base,full);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error("Agenda path escapes its root");
  let at=base;for(const part of rel.split(/[\\/]/)){at=join(at,part);try{if(lstatSync(at).isSymbolicLink())throw Error("Agenda paths cannot traverse links");}catch(e){if(e.code!=='ENOENT')throw e;}}
  return full;
}
function writeJson(path,value){mkdirSync(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n','utf8');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);}

export const agendaError = (message, status = 400) => Object.assign(new Error(message), {status});
const bad = message => { throw agendaError(message); };
export const agendaId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) ? id : bad("Invalid agenda ID");
export const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validDate(value) {
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const n=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0,10)===value;
}
export function validInstant(value) {
  const m=typeof value==='string' && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/);
  return Boolean(m && validDate(m[1]) && +m[2]<24 && +m[3]<60 && +(m[4]||0)<60 && +(m[6]||0)<=14 && +(m[7]||0)<60 && (+m[6]!==14 || +m[7]===0) && Number.isFinite(Date.parse(value)));
}
export function zone(value='Asia/Shanghai') {
  try { if(typeof value!=='string'||value.length>80)throw Error(); new Intl.DateTimeFormat('en',{timeZone:value}); return value; }
  catch { return bad("Invalid agenda time zone"); }
}
export function localDate(stamp, timeZone='Asia/Shanghai') {
  const p=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(stamp));
  const v=Object.fromEntries(p.map(x=>[x.type,x.value]));return `${v.year}-${v.month}-${v.day}`;
}
export const nextDate = day => new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function midnight(day, timeZone) {
  if(!validDate(day))return bad("Invalid agenda date");
  const target=Date.parse(day+'T00:00:00Z');let result=target;
  const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  for(let i=0;i<4;i++){
    const v=Object.fromEntries(fmt.formatToParts(new Date(result)).map(p=>[p.type,p.value]));
    const wall=Date.parse(`${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}Z`);
    const delta=target-wall;if(!delta)return result;result+=delta;
  }
  return bad("This date does not exist in the selected time zone; specify the time explicitly");
}
const FIELDS=new Set(['title','kind','priority','event_at','end_at','time_zone','all_day','start_date','end_date_exclusive','remind_at']);
export function fieldsFor(value, previous = null) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!FIELDS.has(k)))return bad("Invalid agenda fields");
  if(previous?.remind_at&&!Object.hasOwn(value,'remind_at')&&['event_at','end_at','all_day','start_date','end_date_exclusive','time_zone','kind'].some(k=>Object.hasOwn(value,k)&&value[k]!==previous[k]))return bad("When rescheduling, explicitly keep, reset or cancel the reminder time");
  const v={...(previous?Object.fromEntries([...FIELDS].filter(k=>previous[k]!==undefined).map(k=>[k,previous[k]])):{}),...value};
  if(typeof v.title!=='string'||!v.title.trim()||v.title.length>160||/[\u0000-\u001f]/.test(v.title))return bad("Provide a valid agenda title (at most 160 characters)");
  v.title=v.title.trim();v.kind||='event';v.priority||='normal';v.time_zone=zone(v.time_zone);v.all_day??=false;
  if(!['event','deadline'].includes(v.kind)||!['high','normal','low'].includes(v.priority)||typeof v.all_day!=='boolean')return bad("Invalid agenda type or importance");
  v.remind_at??=null;v.end_at??=null;
  if(v.all_day){
    if(!validDate(v.start_date)||!validDate(v.end_date_exclusive||nextDate(v.start_date)))return bad("All-day agenda requires a valid date");
    v.end_date_exclusive||=nextDate(v.start_date);
    if(v.end_date_exclusive<=v.start_date)return bad("End date must be later than start date");
    if(v.event_at||v.end_at)return bad("All-day agenda cannot also specify clock times");
    v.event_at=null;v.end_at=null;
  } else {
    if(!validInstant(v.event_at)||v.end_at!==null&&!validInstant(v.end_at))return bad("Agenda time must include a specific date and an explicit time-zone offset");
    if(v.end_at&&Date.parse(v.end_at)<=Date.parse(v.event_at))return bad("End time must be later than start time");
    if(v.start_date||v.end_date_exclusive)return bad("Timed agenda cannot also specify all-day dates");
    v.start_date=null;v.end_date_exclusive=null;
  }
  const eventTime=v.all_day?midnight(v.kind==='deadline'?v.end_date_exclusive:v.start_date,v.time_zone):Date.parse(v.event_at);
  if(v.remind_at!==null&&(!validInstant(v.remind_at)||Date.parse(v.remind_at)>eventTime))return bad("Reminder time is invalid or later than the item time");
  if(v.kind==='deadline'&&v.end_at)return bad("A deadline item requires only one deadline time");
  return v;
}
export function normalized(raw, fileId) {
  if(!raw || ![1,2,undefined].includes(raw.schema))return bad("Unsupported agenda format");
  const id=agendaId(raw.id);if(fileId!==undefined&&fileId!==id)return bad("Agenda ID does not match the filename");
  const status=raw.status||'open';if(!['open','completed','cancelled','conflicted'].includes(status))return bad("Invalid agenda status");
  const fields={};for(const k of FIELDS)if(raw[k]!==undefined)fields[k]=raw[k];
  return {...fieldsFor(fields),id,status,revision:revisionOf(raw),tags:Array.isArray(raw.tags)?raw.tags.filter(t=>typeof t==='string').slice(0,20):[],visibility:raw.visibility==='sensitive'?'sensitive':'normal',created_at:raw.created_at||raw.createdAt||null,updated_at:raw.updated_at||raw.updatedAt||null};
}
export function timing(item, now=Date.now()) {
  const start=item.all_day?midnight(item.start_date,item.time_zone):Date.parse(item.event_at);
  const end=item.all_day?midnight(item.end_date_exclusive,item.time_zone):item.end_at?Date.parse(item.end_at):start;
  const at=item.kind==='deadline'?end===start?start:end:start;
  const ongoing=item.kind==='event'&&start<=now&&now<end;
  const temporal=ongoing?'ongoing':at>=now?'upcoming':item.kind==='deadline'?'overdue':'elapsed';
  return {start,end,at,temporal,eligible:ongoing||at>=now};
}
export function createAgenda({root,now=Date.now}) {
  const dir=safeInstancePath(root,join(root,'user-space','reminders'));
  const path=id=>safeInstancePath(root,join(dir,agendaId(id)+'.json'));
  function raw(id){try{return JSON.parse(readFileSync(path(id),'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return null;throw agendaError("Cannot read agenda record; original file preserved",409);}}
  function read(id){const r=raw(id);if(!r)throw agendaError("Agenda item not found",404);return normalized(r,id);}
  function scan(){
    const items=[];let invalid=0;
    for(const name of existsSync(dir)?readdirSync(dir):[]){if(!name.endsWith('.json'))continue;try{const r=read(name.slice(0,-5));items.push({...r,...timing(r,now())});}catch{invalid++;}}
    return {items,invalid};
  }
  function candidates(text){
    const all=scan(),words=[...new Intl.Segmenter('zh',{granularity:'word'}).segment(text.toLowerCase())].filter(p=>p.isWordLike&&p.segment.length>=2).map(p=>p.segment);
    const score=item=>words.reduce((n,w)=>n+(item.title.toLowerCase().includes(w)?2:0)+(String(item.event_at||item.start_date).includes(w)?1:0),0);
    all.items.sort((a,b)=>score(b)-score(a)||(a.status==='open'?0:1)-(b.status==='open'?0:1)||Math.abs(a.at-now())-Math.abs(b.at-now())||a.id.localeCompare(b.id));
    return {...all,total:all.items.length,items:all.items.slice(0,30)};
  }
  function list({preview=false,offset=0,limit=50,status='',priority='',from='',to=''}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100) return bad("Invalid agenda pagination");
    if(status&&!['open','completed','cancelled','conflicted'].includes(status)||priority&&!['high','normal','low'].includes(priority)||from&&!validDate(from)||to&&!validDate(to)||from&&to&&from>to)return bad("Invalid agenda filter");
    let {items,invalid}=scan();
    const conflicts=items.filter(i=>i.status==='conflicted').length;
    if(preview)items=items.filter(i=>i.status==='open'&&i.eligible);
    else items=items.filter(i=>(!status||i.status===status)&&(!priority||i.priority===priority)&&(!from||localDate(i.at,i.time_zone)>=from)&&(!to||localDate(i.start,i.time_zone)<=to));
    items.sort((a,b)=>(preview?(a.temporal==='ongoing'?0:1)-(b.temporal==='ongoing'?0:1):0)||a.at-b.at||a.id.localeCompare(b.id));
    const total=items.length;
    const initialOffset=preview?0:offset;
    const selected=items.slice(initialOffset,initialOffset+(preview?3:limit));
    return {items:selected,total,offset:initialOffset,nextOffset:!preview&&initialOffset+selected.length<total?initialOffset+selected.length:null,invalid,conflicts,asOf:new Date(now()).toISOString(),timeZone:'Asia/Shanghai'};
  }
  function apply(plan,operationId) {
    if(!plan||!['create','update','cancel','complete','restore'].includes(plan.action))return bad("Invalid agenda operation");
    const id=agendaId(plan.targetId||randomUUID());
    const old=raw(id);
    if(old?.last_operation_id===operationId||plan.action==='create'&&old?.created_operation_id===operationId)return read(id);
    if(plan.action==='create'){
      if(old)throw agendaError("Agenda item already exists. Review it again.",409);
    } else {
      if(!old)throw agendaError("Agenda item not found",404);
      if(plan.expectedRevision!==revisionOf(old))throw agendaError("Agenda changed. Review it before applying the action.",409);
      if(plan.action==='update'&&old.status!=='open')throw agendaError("Restore this agenda item before editing",409);
    }
    const previous=old?normalized(old,id):null;
    if(previous&&(plan.action==='cancel'&&previous.status==='cancelled'||plan.action==='complete'&&previous.status==='completed'||plan.action==='restore'&&previous.status==='open'))return previous;
    const fields=plan.action==='create'?fieldsFor(plan.fields):plan.action==='update'?fieldsFor(plan.fields,previous):fieldsFor(Object.fromEntries([...FIELDS].map(k=>[k,previous[k]])));
    if(plan.action==='create'&&!timing(fields,now()).eligible)return bad("New agenda time has passed. Review it again.");
    const stamp=new Date(now()).toISOString();
    const next={...old,...fields,schema:2,id,status:plan.action==='cancel'?'cancelled':plan.action==='complete'?'completed':plan.action==='restore'?'open':old?.status||'open',created_at:old?.created_at||old?.createdAt||stamp,updated_at:stamp,last_operation_id:operationId,created_operation_id:old?.created_operation_id||(plan.action==='create'?operationId:null),source:old?.source||plan.source||null};
    writeJson(path(id),next);return read(id);
  }
  return {list,read,raw,apply,candidates};
}
