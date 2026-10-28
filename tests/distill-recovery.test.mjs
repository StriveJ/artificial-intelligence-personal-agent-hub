import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMainDistillation } from '../lib/main-distillation.mjs';
const base=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(base,{recursive:true});
test("Lost candidate or confirmation receipts query actual identity without repeating model calls",async()=>{
  for(const lose of ['add','confirm']){
    const work=mkdtempSync(join(base,'distill-recovery-')),root=join(work,'instance'),runtimeDir=join(work,'runtime'),day='2026-10-20';
    mkdirSync(join(root,'user-space/logs/hub/reports/daily'),{recursive:true});writeFileSync(join(root,'user-space/logs/hub/reports/daily',day+'.json'),JSON.stringify({fingerprint:'synthetic'}));
    let receipt=null,lost=false,models=0,confirms=0;
    const adapter={allowedContent:()=>true,distillAdd:async()=>{receipt||={id:'distill-synthetic-0001',status:'queued'};if(lose==='add'&&!lost){lost=true;throw Error('synthetic lost add reply');}return receipt;},distillStatus:async()=>receipt,distillApplied:()=>false,distillConfirm:async id=>{assert.equal(id,receipt.id);confirms++;receipt={...receipt,status:'landed'};if(lose==='confirm'&&!lost){lost=true;throw Error('synthetic lost confirm reply');}}};
    const make=()=>createMainDistillation({root,runtimeDir,runner:async()=>{models++;return JSON.stringify([{type:'method',text:'Synthetic method'}]);},adapter:()=>adapter,reports:{sources:()=>({events:[{id:'synthetic'}],web:[]})},consent:true});
    await assert.rejects(()=>make().run(day),/lost/);const result=await make().run(day);
    assert.equal(result.candidates[0].phase,'complete');assert.equal(result.candidates[0].queueId,'distill-synthetic-0001');assert.equal(models,1);assert.equal(confirms,1);
  }
});
