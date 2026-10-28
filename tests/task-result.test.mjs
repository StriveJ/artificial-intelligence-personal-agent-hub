import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createScheduler } from '../lib/scheduler.mjs';
import { TASK_STATUSES } from '../lib/task-result.mjs';
const base = resolve(process.env.AIPA_TEST_TMP || 'aipa-test-tmp');
mkdirSync(base, { recursive: true });
const timers = { setTimer: () => ({ unref() {} }), clearTimer() {} };
test("Failed, partial, and invalid task results never become false success and persisted history matches API results", async () => {
  for (const returned of [...TASK_STATUSES.map(status => ({ status, summary: 'synthetic' })), undefined, {}, { status: 'misspelled' }]) {
    const path = join(mkdtempSync(join(base, 'task-contract-')), 'tasks.json');
    const scheduler = createScheduler({ path, ...timers });
    scheduler.register({ id: 'synthetic-task', intervalMs: 1000, run: async () => returned });
    const result = await scheduler.runNow('synthetic-task');
    const expected = returned?.status && TASK_STATUSES.includes(returned.status) ? returned.status : 'error';
    const state = scheduler.list()[0], saved = JSON.parse(readFileSync(path)).tasks['synthetic-task'];
    assert.equal(result.status, expected); assert.equal(state.status, expected); assert.equal(saved.history.at(-1).status, expected);
    assert.equal(Boolean(state.lastSuccessAt), expected === 'success');
    await scheduler.stop();
  }
});
test("Unknown outcomes survive restart without automatic replay and require manual execution", async () => {
  const path = join(mkdtempSync(join(base, 'task-unknown-')), 'tasks.json'); let calls = 0, now = 1000;
  const make = () => { const s = createScheduler({ path, now: () => now, ...timers }); s.register({ id: 'synthetic-task', intervalMs: 1000, run: async () => { calls++; return { status: 'unknown' }; } }); return s; };
  let s = make(); await s.runNow('synthetic-task'); await s.stop(); now += 100_000;
  s = make(); await s.tick(); assert.equal(calls, 1); assert.equal(s.list()[0].nextRunAt, null);
  await s.runNow('synthetic-task'); assert.equal(calls, 2); await s.stop();
});
test("Interrupted and unknown tasks do not replay automatically after restart or schedule changes",async()=>{
  for(const status of ['running','interrupted','unknown']){
    const path=join(mkdtempSync(join(base,'task-restart-')),'tasks.json');let calls=0;
    writeFileSync(path,JSON.stringify({tasks:{'synthetic-task':{status,scheduleKey:'interval/1000',nextRunAt:'2026-10-24T00:00:00Z',history:[]}}}));
    const s=createScheduler({path,now:()=>Date.parse('2026-10-24T02:00:00Z'),...timers});
    s.register({id:'synthetic-task',dailyAt:'07:00',run:async()=>{calls++;return{status:'success'};}});
    await s.tick();assert.equal(calls,0);assert.equal(s.list()[0].status,'unknown');assert.equal(s.list()[0].nextRunAt,null);
    s.configure('synthetic-task',{enabled:true,dailyAt:'08:00'});await s.tick();assert.equal(calls,0);assert.equal(s.list()[0].nextRunAt,null);
    if(status!=='unknown')assert.equal(s.list()[0].history.at(-1).status,'unknown');
    await s.runNow('synthetic-task');assert.equal(calls,1);await s.stop();
  }
});
