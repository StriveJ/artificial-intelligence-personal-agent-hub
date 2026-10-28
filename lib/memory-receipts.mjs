export const RECEIPT_WARNING="Answer generated; memory usage receipt registration incomplete";
export function receiptIntent(chatId,turnId,context){
 const entries=context.memoryReceipt?.entries;
 if(!entries?.length)return null;
 if(!Array.isArray(entries)||entries.some(e=>typeof e?.id!=='string'||!/^[a-f0-9]{64}$/.test(e.body_hash||'')))throw Error("Memory usage receipt lacks a body version");
 return {schema:1,id:`hub-${chatId}-${turnId}`,entries,project:context.memoryReceipt?.project||'',at:context.memoryReceipt?.at,status:'awaiting-answer',attempts:0};
}
export function createMemoryReceipts({store,deliver}){
 let running;
 async function flush(){
  if(running)return running;
  running=(async()=>{
   let delivered=0,pending=0;
   for(const snapshot of store.listChats())for(const snapshotTurn of snapshot.turns){
    if(snapshotTurn.status!=='completed'||!snapshotTurn.answer||snapshotTurn.memoryReceipt?.status!=='pending')continue;
    const intent=snapshotTurn.memoryReceipt;let success=false;
    try{if(!deliver)throw Error('Receipt capability unavailable');await deliver(intent.entries,{receiptId:intent.id,project:intent.project,at:intent.at});success=true;}catch{}
    const chat=store.readChat(snapshot.id),turn=chat?.turns.find(t=>t.id===snapshotTurn.id);
    if(!turn||turn.memoryReceipt?.id!==intent.id)continue;
    turn.memoryReceipt={...intent,status:success?'delivered':'pending',attempts:(intent.attempts||0)+1};
    turn.warnings=(turn.warnings||[]).filter(w=>w!==RECEIPT_WARNING);
    if(success)delivered++;else{pending++;turn.warnings.push(RECEIPT_WARNING);}
    store.saveChat(chat);
   }
   return {delivered,pending};
  })().finally(()=>{running=null;});return running;
 }
 return {flush,pending:()=>store.listChats().reduce((count,chat)=>count+chat.turns.filter(t=>t.status==='completed'&&t.memoryReceipt?.status==='pending').length,0)};
}
