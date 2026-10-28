import test from 'node:test';
import assert from 'node:assert/strict';
import { quarantineMemoryText, quarantineEventRows, mergeMemoryMetadata } from '../lib/conflict-resolution.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRepoSync } from '../lib/repo-sync.mjs';
test("Disputed rules are not selected by default; undisputed text survives and unknown blocks are isolated", () => {
  const text = '## agreed\nShared fact\n<<<<<<< HEAD\nDeployment requires approval\n=======\nDeployment needs no approval\n>>>>>>> synthetic-remote\n## other\nUnrelated fact\n';
  const result = quarantineMemoryText(text, 'synthetic-audit');
  assert.doesNotMatch(result, /requires approval|needs no approval|<<<<<<<|>>>>>>>/); assert.match(result, /Shared fact/); assert.match(result, /Unrelated fact/);
  assert.doesNotMatch(quarantineMemoryText('Unmarked conflicting candidate', 'synthetic'), /Unmarked conflicting candidate/);
});
test("All same-ID divergent events remain pending while unrelated events can merge", () => {
  const local = Buffer.from('{"id":"same","data":"local"}\n{"id":"unique","data":"agreed"}\n');
  const remote = Buffer.from('{"id":"same","data":"remote"}\n');
  const result = quarantineEventRows(local, remote); assert.doesNotMatch(result, /"same"/); assert.match(result, /"unique"/);
});
test("Withdrawal takes priority independent of body changes and other metadata ambiguities become conflicted", () => {
  const bytes = status => Buffer.from(JSON.stringify({ version: 1, entries: { 'mem-synthetic': { file: 'user-space/memory/preferences.md', body_hash: 'synthetic', confirmation: { status } } } }));
  let result = mergeMemoryMetadata(bytes('observed'), bytes('revoked'), bytes('user_confirmed'), 'audit');
  assert.equal(result.value.entries['mem-synthetic'].confirmation.status, 'revoked');
  result = mergeMemoryMetadata(bytes('observed'), bytes('user_confirmed'), bytes('model_confirmed'), 'audit');
  assert.equal(result.value.entries['mem-synthetic'].confirmation.status, 'conflicted'); assert.equal(result.pending, true);
});
test("Synthetic Git merge isolates disputed memories while preserving both originals and usable unrelated content", async () => {
  const base=resolve(process.env.AIPA_TEST_TMP||'aipa-test-tmp');mkdirSync(base,{recursive:true});
  const work=mkdtempSync(join(base,'memory-merge-')),origin=join(work,'origin.git'),writer=join(work,'writer'),root=join(work,'instance');
  const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath='+join(work,'empty-hooks'),'-C',cwd,...args],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();
  git(work,'init','--bare','--initial-branch=master',origin);git(work,'clone',origin,writer);
  const put=(cwd,file,text)=>{mkdirSync(dirname(join(cwd,file)),{recursive:true});writeFileSync(join(cwd,file),text);};
  const file='user-space/memory/preferences.md';
  for(const cwd of [writer]){git(cwd,'config','user.name','Synthetic');git(cwd,'config','user.email','synthetic@example.invalid');git(cwd,'config','core.autocrlf','false');}
  put(writer,'AIPA-MANIFEST.yaml','aipa:\n  version: synthetic\n');put(writer,file,'## Shared\nKeep agreed context\n\n## Deployment\nOriginal rule\n');
  git(writer,'add','.');git(writer,'commit','-qm','synthetic baseline');git(writer,'push','-u','origin','master');git(work,'clone',origin,root);
  put(root,file,'## Shared\nKeep agreed context\n\n## Deployment\nDeployment requires approval\n');
  put(writer,file,'## Shared\nKeep agreed context\n\n## Deployment\nDeployment needs no approval\n');git(writer,'add','.');git(writer,'commit','-qm','synthetic remote rule');git(writer,'push');
  const sync=createRepoSync({root,runtimeDir:join(work,'runtime'),testMode:true,push:true,autoResolve:true,capturePaths:['user-space']});
  const result=await sync();assert.equal(result.status,'success');assert.equal(result.pushSuppressed,true);
  const current=readFileSync(join(root,file),'utf8');assert.match(current,/Keep agreed context/);assert.doesNotMatch(current,/requires approval|needs no approval|<<<<<<<|>>>>>>>/);
  const dir=join(root,'user-space/logs/hub/conflicts'),audit=JSON.parse(readFileSync(join(dir,readdirSync(dir)[0],'audit.json')));
  assert.equal(audit.status,'pending-review');assert.equal(audit.entries[0].strategy,'memory-conflict-quarantined');assert.equal(audit.entries[0].evidence.length,3);
  assert.equal((await sync()).status,'success');assert.equal(readFileSync(join(root,file),'utf8'),current);
  assert.equal(readdirSync(dir).length,1,"Repeated sync must neither duplicate nor reactivate a dispute");
});
