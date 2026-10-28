import {existsSync,readFileSync,readdirSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {safeInstancePath,writeJson,readJson,atomicWrite} from './storage.mjs';
import {createTaskGate} from './task-gate.mjs';
import {isPrivate} from './runtime-policy.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const failure=(message,status=409)=>Object.assign(new Error(message),{status});
const idOK=id=>typeof id==='string'&&/^[a-f0-9]{24}$/.test(id);
const opOK=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(id);
const maxBytes=512*1024;
const hashOK=value=>value===null||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function validateReceipt(receipt){
 if(receipt?.schema!==1||receipt.status!=='applied'||!opOK(receipt.id)||!idOK(receipt.auditId)||!hashOK(receipt.beforeHash)||!hashOK(receipt.resultHash)||!hashOK(receipt.auditHash)||receipt.auditHash===null||!Array.isArray(receipt.supersedes)||receipt.supersedes.some(id=>!opOK(id))||typeof receipt.payloadHash!=='string')throw failure("Unknown decision receipt format");
 return receipt;
}
function text(bytes){if(bytes===null)return null;if(bytes.length>maxBytes)return null;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}}
export function createConflictReview({root,runtimeDir,gate=createTaskGate(root),fault=()=>{}}){
 const base=()=>safeInstancePath(root,join(root,'user-space/logs/hub/conflicts'));
 const auditDir=id=>{if(!idOK(id))throw failure("Invalid conflict ID",400);return safeInstancePath(root,join(base(),id));};
 const target=path=>{
  if(typeof path!=='string'||!path||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||isPrivate(path)||! /^(?:user-space\/|state\/(?:events|hosts)\/)/.test(path)||path.startsWith('user-space/logs/hub/conflicts/'))throw failure("Decision writes are not allowed for this conflict path",400);
  return safeInstancePath(root,join(root,path));
 };
 const bytesAt=path=>{if(!existsSync(path))return null;const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw failure("File too large or not a regular file; state preserved");return readFileSync(path);};
 const hashAt=path=>{const bytes=bytesAt(path);return bytes===null?null:sha(bytes);};
 function load(id){
  const dir=auditDir(id),file=safeInstancePath(root,join(dir,'audit.json')),bytes=bytesAt(file);
  if(!bytes)throw failure("Conflict audit not found",404);
  let audit;try{audit=JSON.parse(bytes);}catch{throw failure("Conflict audit damaged; original content preserved");}
  if(audit.id!==id||!Array.isArray(audit.entries))throw failure("Unknown conflict audit format");
  return {dir,audit,auditHash:sha(bytes)};
 }
 function receipts(dir){
  const folder=safeInstancePath(root,join(dir,'decisions'));if(!existsSync(folder))return [];
  return readdirSync(folder).filter(n=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(n)).sort().map(n=>{
   const receipt=readJson(safeInstancePath(root,join(folder,n)),null);
   validateReceipt(receipt);if(receipt.id+'.json'!==n)throw failure("Decision receipt ID mismatch");return receipt;
  });
 }
 function detail(id){
  const {dir,audit,auditHash}=load(id),decisions=receipts(dir),local=safeInstancePath(runtimeDir,join(runtimeDir,'conflict-review',id));
  const pendingOperations=existsSync(local)?readdirSync(local).filter(n=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(n)).sort().map(n=>readJson(safeInstancePath(runtimeDir,join(local,n)),null)).filter(j=>j?.status==='prepared').map(j=>validateReceipt(j.receipt)).filter(op=>!decisions.some(d=>d.supersedes.includes(op.id))):[];
  const entries=audit.entries.map(entry=>{
   const file=target(entry.path),current=bytesAt(file),currentHash=current===null?null:sha(current),history=decisions.filter(d=>d.path===entry.path&&d.auditHash===auditHash);
   const superseded=new Set(history.flatMap(d=>d.supersedes)),leaves=history.filter(d=>!superseded.has(d.id));
   const hashes=[...new Set(entry.heads||[])],variants=hashes.map(hash=>{
    if(hash===null)return {hash:null,label:"Delete",text:null,selectable:true};
    if(!/^[a-f0-9]{64}$/.test(hash)||!entry.evidence?.includes(hash+'.bin'))throw failure("Conflict version has no evidence");
    const bytes=bytesAt(safeInstancePath(root,join(dir,hash+'.bin')));if(bytes===null||sha(bytes)!==hash)throw failure("Conflict evidence digest mismatch");
    const value=text(bytes);return {hash,label:"Version "+hash.slice(0,12),text:value,selectable:value!==null&&!entry.path.startsWith('user-space/logs/hub/attachments/')};
   });
   const resolved=leaves.length===1&&leaves[0].resultHash===currentHash;
   return {path:entry.path,strategy:entry.strategy,status:pendingOperations.some(op=>op.path===entry.path)?'recovery-required':resolved?'resolved':leaves.length?'decision-needs-review':entry.review==='pending'?'pending':'mechanically-resolved',revision:digest({auditHash,path:entry.path,currentHash,receipts:history}),currentHash,current:text(current),variants,decisions:history,leaves:leaves.map(r=>r.id),canChooseCurrent:current===null||text(current)!==null};
  });
  return {id,createdAt:audit.createdAt,auditHash,status:entries.some(e=>['pending','decision-needs-review','recovery-required'].includes(e.status))?'pending-review':'resolved',entries,pendingOperations};
 }
 const journalPath=(id,op)=>safeInstancePath(runtimeDir,join(runtimeDir,'conflict-review',id,op+'.json'));
 function resume(journal){
  if(journal?.schema!==1||!idOK(journal.auditId)||!['prepared','applied'].includes(journal.status))throw failure("Unknown decision recovery journal format");validateReceipt(journal.receipt);
  if(journal.receipt.auditId!==journal.auditId)throw failure("Decision recovery identity mismatch");
  const {dir,auditHash}=load(journal.auditId);if(auditHash!==journal.receipt.auditHash)throw failure("Audit changed; pending operation preserved for review");
  const path=target(journal.receipt.path),current=hashAt(path),expected=journal.receipt.beforeHash,result=journal.receipt.resultHash;
  if(current!==expected&&current!==result)throw failure("File changed after an unfinished decision. Overwrite refused; preserve state for review.");
  if(current!==result){
   if(result===null){if(existsSync(path))unlinkSync(path);}
   else{const bytes=bytesAt(safeInstancePath(root,join(dir,result+'.bin')));if(bytes===null||sha(bytes)!==result)throw failure("Incomplete evidence for the decision target");atomicWrite(path,bytes);}
  }
  fault('after-write');
  if(hashAt(path)!==result)throw failure("Digest mismatch after decision write");
  const destination=safeInstancePath(root,join(dir,'decisions',journal.receipt.id+'.json')),existing=readJson(destination,null);
  if(existing&&digest(existing)!==digest(journal.receipt))throw failure("Ambiguous decision receipts share an ID");
  if(!existing)writeJson(destination,journal.receipt);
  fault('after-receipt');
  journal.status='applied';writeJson(journalPath(journal.auditId,journal.receipt.id),journal);
  return {...journal.receipt,currentMatches:hashAt(path)===result};
 }
 async function decide(id,body){
  if(!idOK(id)||!opOK(body?.id)||body.confirmed!==true||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>2000||typeof body.revision!=='string')throw failure("Decision requires an operation ID, observed revision, owner confirmation, and reason",400);
  const input={path:body.path,choice:body.choice,revision:body.revision,reason:body.reason.trim()},payloadHash=digest(input);
  return gate.run('main',()=>{
   const {dir}=load(id),prior=readJson(journalPath(id,body.id),null),shared=readJson(safeInstancePath(root,join(dir,'decisions',body.id+'.json')),null);
   if(prior||shared){
    const receipt=validateReceipt(prior?.receipt||shared);if(receipt.id!==body.id||receipt.auditId!==id||receipt.payloadHash!==payloadHash)throw failure("An operation ID cannot be reused for another decision");
    if(prior?.status==='prepared'&&receipts(dir).some(d=>d.supersedes.includes(body.id)))throw failure("A newer decision supersedes this operation. History preserved; old file not restored.");
    return prior?.status!=='applied'&&prior?resume(prior):{...receipt,currentMatches:hashAt(target(receipt.path))===receipt.resultHash};
   }
   const view=detail(id),entry=view.entries.find(e=>e.path===body.path);if(!entry)throw failure("Conflict entry not found",404);
   if(entry.revision!==body.revision)throw failure("File or decision changed. Refresh and review again.");
   const choice=body.choice==='current'?{hash:entry.currentHash,selectable:entry.canChooseCurrent}:entry.variants.find(v=>(v.hash===null?'delete':v.hash)===body.choice);
   if(!choice?.selectable)throw failure("Selection is not an available text version; preserve state",400);
   const path=target(entry.path),current=bytesAt(path);
   if(current!==null)atomicWrite(safeInstancePath(root,join(dir,sha(current)+'.bin')),current);
   const receipt={schema:1,id:body.id,auditId:id,path:entry.path,auditHash:view.auditHash,status:'applied',actor:'user',source:'paired-web',reason:input.reason,choice:body.choice,beforeHash:entry.currentHash,resultHash:choice.hash,supersedes:[...new Set([...entry.leaves,...view.pendingOperations.filter(op=>op.path===entry.path).map(op=>op.id)])],revision:entry.revision,payloadHash,at:new Date().toISOString()};
   const journal={schema:1,auditId:id,status:'prepared',receipt};writeJson(journalPath(id,body.id),journal);fault('prepared');return resume(journal);
  });
 }
 return {detail,decide,list:()=>{
  const folder=base();if(!existsSync(folder))return [];
  return readdirSync(folder).filter(idOK).sort().reverse().map(id=>{try{const view=detail(id);return{id,status:view.status,createdAt:view.createdAt,entries:view.entries.length};}catch{return{id,status:'unreadable',summary:"Cannot safely read audit or evidence; original preserved"};}});
 }};
}
