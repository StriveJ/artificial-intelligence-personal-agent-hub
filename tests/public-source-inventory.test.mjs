import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {publicSourceFiles} from './helpers/public-source-files.mjs';

test('A staged public inventory cannot silently use its parent repository or omit public source',t=>{
 const base=mkdtempSync(join(tmpdir(),'aipa-public-inventory-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 execFileSync('git',['init','--quiet',base],{stdio:'pipe',windowsHide:true});writeFileSync(join(base,'.gitignore'),'staged/\n');const staged=join(base,'staged');mkdirSync(staged);
 for(const dir of ['lib','public','tests'])mkdirSync(join(staged,dir));
 for(const name of ['lib/aipa.mjs','public/index.html','tests/english-source.test.mjs','package.json','package-lock.json','LICENSE','README.md','README_EN.md'])writeFileSync(join(staged,name),'Synthetic public file\n');
 writeFileSync(join(staged,'lib/native-fixture.mjs'),'// '+String.fromCodePoint(0x4e2d)+'\n');
 let files=publicSourceFiles(staged);assert.ok(files.includes('lib/native-fixture.mjs'));assert.ok(files.length>=7);assert.ok(!files.includes('.gitignore'));
 const clean=join(base,'separate');cpSync(staged,clean,{recursive:true});files=publicSourceFiles(clean);assert.ok(files.includes('lib/native-fixture.mjs'));
 rmSync(join(staged,'LICENSE'));assert.throws(()=>publicSourceFiles(staged),/LICENSE/);
});
