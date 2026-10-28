import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptIntent,createMemoryReceipts,RECEIPT_WARNING} from '../lib/memory-receipts.mjs';
test("Receipts bind chats and turns; legacy interfaces without body versions cannot enter automatic recovery",()=>{
 const context={memoryReceipt:{project:'synthetic',at:'2026-10-25',entries:[{id:'memory',body_hash:'a'.repeat(64)}]}};
 assert.notEqual(receiptIntent('synthetic-a','same-turn',context).id,receiptIntent('synthetic-b','same-turn',context).id);
 assert.equal(receiptIntent('synthetic-a','same-turn',{memoryUse:['memory']}),null);
 assert.throws(()=>receiptIntent('synthetic-a','same-turn',{memoryReceipt:{entries:[{id:'memory'}]}}),/body.version/i);
});
test("Unanswered intents do not register use; recovery updates only completed-answer receipts and warnings",async()=>{
 const intent=receiptIntent('synthetic-chat','synthetic-turn',{memoryReceipt:{entries:[{id:'memory',body_hash:'b'.repeat(64)}],project:'synthetic',at:'2026-10-25'}});
 let chat={id:'synthetic-chat',turns:[{id:'synthetic-turn',status:'interrupted',memoryReceipt:intent}]},calls=0,fail=true;
 const store={listChats:()=>[structuredClone(chat)],readChat:()=>structuredClone(chat),saveChat:value=>chat=structuredClone(value)};
 const deliver=async(entries,options)=>{calls++;assert.equal(entries[0].body_hash,'b'.repeat(64));assert.equal(options.receiptId,intent.id);if(fail)throw Error('Synthetic failure');};
 let queue=createMemoryReceipts({store,deliver});await queue.flush();assert.equal(calls,0);
 Object.assign(chat.turns[0],{status:'completed',answer:'Synthetic preserved answer',warnings:['Synthetic other warning'],memoryReceipt:{...intent,status:'pending'}});
 await queue.flush();assert.equal(queue.pending(),1);assert.ok(chat.turns[0].warnings.includes(RECEIPT_WARNING));
 fail=false;queue=createMemoryReceipts({store,deliver});await queue.flush();assert.equal(queue.pending(),0);assert.equal(calls,2);assert.equal(chat.turns[0].answer,'Synthetic preserved answer');assert.deepEqual(chat.turns[0].warnings,['Synthetic other warning']);await queue.flush();assert.equal(calls,2);
});
