import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdirSync,readdirSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {readJson,writeJson,atomicWrite,safeInstancePath,assertId} from './storage.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=(text,status=400)=>{throw Object.assign(new Error(text),{status});};
export const attachmentIds=value=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>3||value.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||new Set(value).size!==value.length)fail("Invalid image references; up to 3 images per record");
  return value;
};
export const attachmentEventText=(text,ids=[],analyze=false)=>ids.length?`${text || "Image note"}\n${analyze?"Image analysis request (see this turn for execution status)":"Images saved only; not analyzed"}; references: ${ids.join(', ')}`:text;
// Fixed v1 audit event IDs require the original serialized values across upgrades
// and rollback. This legacy wire encoding is never the default UI description.
export const attachmentEventTextV1=(text,ids=[],analyze=false)=>ids.length?`${text || '\u56fe\u7247\u8bb0\u5f55'}\n${analyze?'\u56fe\u7247\u8bc6\u56fe\u8bf7\u6c42\uff08\u6267\u884c\u7ed3\u679c\u89c1\u8be5\u8f6e\u72b6\u6001\uff09':'\u56fe\u7247\u4ec5\u4fdd\u5b58\u3001\u672a\u8bc6\u56fe'}\uff1b\u5f15\u7528\uff1a${ids.join('\u3001')}`:text;
const types={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
export function createAttachments({root,runtimeDir,store,clock=Date.now}) {
  const staging=join(runtimeDir,'attachments-staging');mkdirSync(staging,{recursive:true});
  const repo=p=>safeInstancePath(root,join(store.base,p));
  const ticketPath=id=>join(staging,`${assertId(id)}.json`);
  const asset=id=>repo(`attachments/${attachmentIds([id])[0]}`);
  const deleted=id=>repo(`attachment-deletions/${attachmentIds([id])[0]}.json`);
  const tickets=()=>readdirSync(staging).filter(n=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(n)).map(n=>readJson(join(staging,n)));
  let processing=false;
  let available=false;try{const require=createRequire(import.meta.url);available=require('sharp').versions.sharp==='0.35.5';}catch{}
  const limits={maxImages:3,maxInputBytes:10*1024*1024,maxTotalInputBytes:20*1024*1024,maxPixels:20_000_000,maxOutputBytes:5*1024*1024};
  function decode(bytes) {
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('./image-worker.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_OPTIONS'].includes(k)))});
      const out=[];let n=0;const timer=setTimeout(()=>child.kill(),15_000);child.stderr.resume();child.stdin.on('error',()=>{});
      child.stdout.on('data',b=>{n+=b.length;if(n>8*1024*1024)child.kill();else out.push(b);});
      child.on('error',()=>{clearTimeout(timer);reject(Object.assign(Error("Image processor unavailable"),{status:503}));});
      child.on('close',code=>{clearTimeout(timer);try{if(code!==0||n>8*1024*1024)throw Error();resolve(JSON.parse(Buffer.concat(out)));}catch{reject(Object.assign(Error("Cannot process image: static JPEG, PNG, or WebP only, up to 20 million pixels"),{status:415}));}});
      child.stdin.end(bytes);
    });
  }
  function read(id) {
    if(existsSync(deleted(id)))fail("Image deleted",404);
    const dir=asset(id),meta=readJson(join(dir,'metadata.json'),null);
    if(!meta)return null;
    const bytes=readFileSync(repo(`attachments/${id}/image.webp`));
    if(hash(bytes)!==id||meta.sha256!==id||meta.id!==id||meta.mime!=='image/webp')fail("Image integrity check failed. Review synchronization conflicts.",409);
    return {meta,bytes};
  }
  function pendingIds() {
    const dir=join(runtimeDir,'capture-inbox');if(!existsSync(dir))return new Set();
    return new Set(readdirSync(dir).filter(f=>/^(note|turn)-[a-zA-Z0-9_-]{8,80}\.json$/.test(f)).flatMap(f=>{const r=readJson(join(dir,f));return r.status==='pending'||r.status==='needs-review'?r.data.attachmentIds||[]:[];}));
  }
  function gc() {
    const pending=pendingIds();
    for(const t of tickets()) if(clock()-t.createdAt>86400_000&&!pending.has(t.assetId)) {
      unlinkSync(ticketPath(t.uploadId)); const file=join(staging,`${t.uploadId}.webp`);if(existsSync(file))unlinkSync(file);
    }
  }
  async function upload(req,{owner,scope,key}) {
    assertId(scope);assertId(key);if(!available)fail("Image dependencies are not ready. Complete installation checks on this main Hub first.",503);
    if(processing)fail("Another image is being processed. Retry shortly.",429);
    const mime=String(req.headers['content-type']||'').split(';')[0];if(!Object.values(types).includes(mime))fail("JPEG, PNG, and WebP only; convert HEIC, GIF, or SVG first",415);
    if(Number(req.headers['content-length'])>limits.maxInputBytes)fail("Each image must not exceed 10 MiB",413);
    processing=true;
    try {
      gc();const all=tickets().filter(t=>!existsSync(join(asset(t.assetId),'metadata.json')));if(all.length>=200||all.reduce((n,t)=>n+t.outputBytes,0)>200*1024*1024)fail("Image staging is full. Save or remove drafts first.",503);
      const chunks=[];let n=0;
      for await(const chunk of req){n+=chunk.length;if(n>limits.maxInputBytes)fail("Each image must not exceed 10 MiB",413);chunks.push(chunk);}
      if(!n)fail("Image is empty");const bytes=Buffer.concat(chunks),inputHash=hash(bytes),previous=readJson(ticketPath(key),null);
      if(previous){if(previous.owner!==owner||previous.scope!==scope||previous.inputHash!==inputHash)fail("Repeated upload ID has different content or ownership",409);return view(previous);}
      const result=await decode(bytes);if(types[result.format]!==mime)fail("Actual image format differs from the declared format",415);
      const normalized=Buffer.from(result.data,'base64'),id=hash(normalized);
      if(existsSync(deleted(id)))fail("This image has a deletion marker and cannot be rebound",409);
      const t={uploadId:key,assetId:id,owner,scope,inputHash,inputBytes:n,outputBytes:normalized.length,width:result.width,height:result.height,createdAt:clock()};
      atomicWrite(join(staging,`${key}.webp`),normalized);writeJson(ticketPath(key),t);return view(t);
    } finally {processing=false;}
  }
  function view(t){return {id:t.assetId,width:t.width,height:t.height,bytes:t.outputBytes,status:existsSync(join(asset(t.assetId),'metadata.json'))?'archived':'received',url:`/api/attachments/${t.assetId}/content`};}
  function prepare(ids,owner,scope) {
    attachmentIds(ids);const all=tickets();const selected=ids.map(id=>all.find(t=>t.assetId===id&&t.owner===owner&&t.scope===scope));
    if(selected.some(t=>!t)||ids.some(id=>existsSync(deleted(id))))fail("Image missing or does not belong to this draft",404);
    if(selected.reduce((n,t)=>n+t.inputBytes,0)>limits.maxTotalInputBytes)fail("Images per record must not exceed 20 MiB in total",413);
    return selected;
  }
  function archive(ids) {
    for(const id of attachmentIds(ids)){
      if(read(id))continue;const t=tickets().find(t=>t.assetId===id);if(!t)fail("Image awaiting archival is missing",409);
      const bytes=readFileSync(join(staging,`${t.uploadId}.webp`));if(hash(bytes)!==id)fail("Staged image integrity check failed",409);
      const dir=asset(id);mkdirSync(dir,{recursive:true});atomicWrite(repo(`attachments/${id}/image.webp`),bytes);
      writeJson(repo(`attachments/${id}/metadata.json`),{version:1,id,sha256:id,mime:'image/webp',width:t.width,height:t.height,bytes:bytes.length});
    }
  }
  function get(id,owner) {
    const archived=read(id);if(archived)return {...archived,status:'archived'};
    const t=tickets().find(t=>t.assetId===id&&t.owner===owner);if(!t)fail("Image missing or inaccessible",404);
    const bytes=readFileSync(join(staging,`${t.uploadId}.webp`));if(hash(bytes)!==id)fail("Staged image integrity mismatch",409);
    return {meta:view(t),bytes,status:'received'};
  }
  function remove(id,owner,scope,{confirmArchived=false}={}) {
    attachmentIds([id]);const pending=pendingIds();if(pending.has(id))fail("Image awaits archival and cannot be removed",409);
    const references=[...store.listNotes(),...store.listChats().flatMap(c=>c.turns)].filter(r=>r.attachmentIds?.includes(id));
    if(references.length)fail("Existing records reference this image. Preserve the original records.",409);
    if(read(id)){if(!confirmArchived)fail("Deleting archived images requires explicit confirmation; Git history may still retain content",428);writeJson(deleted(id),{id,deleted:true});return;}
    const selected=tickets().filter(t=>t.assetId===id&&t.owner===owner&&t.scope===scope);if(!selected.length)fail("Image missing or inaccessible",404);
    for(const t of selected){unlinkSync(ticketPath(t.uploadId));const p=join(staging,`${t.uploadId}.webp`);if(existsSync(p))unlinkSync(p);}
  }
  return {upload,prepare,archive,get,remove,gc,limits,available,isBusy:()=>processing};
}
