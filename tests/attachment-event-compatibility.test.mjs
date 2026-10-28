import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {attachmentEventText,attachmentEventTextV1,createAttachments} from '../lib/attachments.mjs';
import {createEventOutbox} from '../lib/event-outbox.mjs';
import {createStore} from '../lib/storage.mjs';
import {createHub} from '../server.mjs';

test('Fixed v1 attachment event projections retain legacy bytes while default descriptions remain English',()=>{
 const ids=['a'.repeat(64),'b'.repeat(64)];
 assert.equal(attachmentEventTextV1('',ids),'\u56fe\u7247\u8bb0\u5f55\n\u56fe\u7247\u4ec5\u4fdd\u5b58\u3001\u672a\u8bc6\u56fe\uff1b\u5f15\u7528\uff1a'+ids.join('\u3001'));
 assert.equal(attachmentEventTextV1('Synthetic',ids,true),'Synthetic\n\u56fe\u7247\u8bc6\u56fe\u8bf7\u6c42\uff08\u6267\u884c\u7ed3\u679c\u89c1\u8be5\u8f6e\u72b6\u6001\uff09\uff1b\u5f15\u7528\uff1a'+ids.join('\u3001'));
 assert.equal(attachmentEventTextV1('Original input',[]),'Original input');assert.match(attachmentEventText('',ids),/^Image note\nImages saved only/);
});

test('A Hub restart preserves delivered v1 image events and still rejects real changes under a reused event ID',async t=>{
 const base=mkdtempSync(join(tmpdir(),'aipa-attachment-wire-')),root=join(base,'instance'),runtimeDir=join(base,'runtime');mkdirSync(root);mkdirSync(runtimeDir);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa: {}');
 t.after(()=>rmSync(base,{recursive:true,force:true}));const store=createStore(root),attachments=createAttachments({root,runtimeDir,store});
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).png().toBuffer(),scope=randomUUID(),req=Object.assign(Readable.from([bytes]),{headers:{'content-type':'image/png','content-length':bytes.length}});
 const image=await attachments.upload(req,{scope,owner:'synthetic',key:randomUUID()});attachments.prepare([image.id],'synthetic',scope);attachments.archive([image.id]);
 const at='2026-10-28T08:00:00Z',id='legacy-image-note';store.saveNote(id,'Original synthetic note',at,[image.id]);
 const eventId='hub-note-attachments-'+id,outbox=createEventOutbox(runtimeDir,async()=>null);await outbox.record('tool_result',attachmentEventTextV1('',[image.id]),'notes',eventId,at);
 const before=JSON.parse(readFileSync(join(runtimeDir,'event-outbox.json'))).records[eventId];let modelCalls=0;
 const adapter={owner:'Synthetic',version:'test',requiresConsent:()=>true,begin:async()=>null,record:async()=>null,search:async()=>[],context:async()=>assert.fail('No model context during image recovery')};
 const hub=await createHub({root,runtimeDir,adapter,runner:async()=>{modelCalls++;throw Error('Unexpected model call');}});try{assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir,'event-outbox.json'))).records[eventId],before);assert.equal(store.listNotes().filter(row=>row.id===id).length,1);assert.equal(modelCalls,0);}finally{await hub.close();}
 const restored=createEventOutbox(runtimeDir,async()=>null);assert.throws(()=>restored.enqueue('tool_result','Changed attachment content','notes',eventId,at),/different content/);assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir,'event-outbox.json'))).records[eventId],before);
});
