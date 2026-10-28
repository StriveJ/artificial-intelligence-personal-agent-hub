import test from 'node:test';
import assert from 'node:assert/strict';
import { contextBudgetBytes, DEFAULT_HUB_CONTEXT_BUDGET } from '../lib/context-budget.mjs';

test("Hub projection budget defaults to 1 MiB and accepts only bounded integer bytes",()=>{
  assert.equal(DEFAULT_HUB_CONTEXT_BUDGET,1048576);
  assert.equal(contextBudgetBytes(),1048576);
  assert.equal(contextBudgetBytes(16000),16000);
  for(const invalid of [null,0,-1,1023,1.5,'1048576',NaN,Infinity,16777217])assert.throws(()=>contextBudgetBytes(invalid),/contextBudgetBytes/);
});
