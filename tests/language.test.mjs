import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeResponseLanguage, responseLanguageInstruction } from '../lib/language.mjs';
import { readResponseLanguage } from '../lib/language-preference.mjs';
import { briefingPrompt } from '../lib/briefings.mjs';
import { createDeepSeekVision } from '../lib/deepseek-vision.mjs';
import { resolveRecallRange } from '../lib/recall.mjs';
import { createAgendaActions, mayManageAgenda } from '../lib/agenda-actions.mjs';
import { createAipaAdapter } from '../lib/aipa.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'aipa-language-'));
  mkdirSync(join(root,'user-space'),{recursive:true});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
test('Shared language preference validates BCP 47, defaults to auto, and never rewrites user files',t=>{
  const root=fixture(t),path=join(root,'user-space/overrides.yaml');
  assert.equal(readResponseLanguage(root),'auto');
  const original='display:\n  language: "es-mx"\npersonal:\n  preserved: true\n';
  writeFileSync(path,original);assert.equal(readResponseLanguage(root),'es-MX');assert.equal(readFileSync(path,'utf8'),original);
  assert.equal(normalizeResponseLanguage('zh-cn'),'zh-CN');
  for(const invalid of [null,{},'',' en','en_US'])assert.throws(()=>normalizeResponseLanguage(invalid));
  for(const content of ['display:\n  language: en\n  language: es\n','display:\n    language: en\n','display: {language: en}\n']){writeFileSync(path,content);assert.throws(()=>readResponseLanguage(root));}
  assert.match(responseLanguageInstruction('auto'),/current user input/);assert.match(responseLanguageInstruction('es'),/configured language es/);assert.match(responseLanguageInstruction('es'),/Preserve original user input/);
});
test('Briefing prompts use shared response language without translating public source materials',()=>{
  const original='\u4eba\u5de5\u667a\u80fd\u65b0\u95fb';
  const prompt=briefingPrompt([{id:'n1',title:original,excerpt:original,category:'ai',sourceName:'Synthetic',publishedAt:'2026-10-27T00:00:00Z'}],{interests:original},'2026-10-27','es');
  assert.match(prompt,/configured language es/);assert.ok(prompt.includes(original));assert.match(prompt,/Return only JSON/);assert.doesNotMatch(prompt,/use Chinese|respond in Chinese/i);
});
test('Vision requests honor configured language and preserve original user text',async()=>{
  let sent;const vision=createDeepSeekVision({engine:'claude',responseLanguage:()=> 'fr',env:()=>({ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_AUTH_TOKEN:'synthetic-only'}),fetcher:async(_,options)=>{sent=JSON.parse(options.body);return Response.json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:'Synthetic answer'}}]});}});
  const original='\u753b\u50cf\u3092\u8aac\u660e\u3057\u3066';await vision.run({text:original,images:[Buffer.from('synthetic')],consent:true,expectedProfileVersion:vision.profile().version});assert.match(sent.messages[0].content,/configured language fr/);assert.equal(sent.messages[1].content[0].text,original);vision.close();
});
test('English and legacy multilingual recall resolve equivalent date windows',()=>{
  for(const [en,legacy] of [['last week','\u4e0a\u5468'],['yesterday','\u6628\u5929'],['this month','\u672c\u6708'],['last year','\u53bb\u5e74'],['past 7 days','\u8fc7\u53bb7\u5929']])assert.deepEqual(resolveRecallRange(en,'2026-10-27'),resolveRecallRange(legacy,'2026-10-27'));
  assert.equal(mayManageAgenda('Please reschedule the meeting tomorrow'),true);
});
test('Agenda interpretation uses the shared preference and keeps multilingual input intact',async t=>{
  const root=fixture(t);writeFileSync(join(root,'user-space/overrides.yaml'),'display:\n  language: ja\n');let prompt;
  const actions=createAgendaActions({root,runtimeDir:join(root,'runtime'),runner:async p=>{prompt=p;return JSON.stringify({action:'no_action',targetId:null,fields:{},message:'Synthetic clarification',needsConfirmation:false});}});
  const original='\u3053\u308c\u306f\u4e88\u5b9a\u3067\u306f\u3042\u308a\u307e\u305b\u3093';const result=await actions.propose({id:'synthetic-language-operation',text:original,consent:true,modelProfileVersion:'test'});assert.equal(result.status,'no_action');assert.match(prompt,/configured language ja/);assert.ok(prompt.includes(original));
});
const origin=process.env.AIPA_ORIGIN_ROOT,framework=origin&&join(origin,'product/core-space/scripts');
test('Core-backed Hub context reads language dynamically and preserves multilingual evidence',{skip:!framework||!existsSync(framework)},async t=>{
  const root=fixture(t);cpSync(framework,join(root,'core-space/scripts'),{recursive:true});writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n  owner: Synthetic\n  version: 1.0.0\n');writeFileSync(join(root,'core-space/policy.md'),'Synthetic required policy');writeFileSync(join(root,'core-space/host-protocol.md'),'Synthetic execution boundary');writeFileSync(join(root,'user-space/privacy.yaml'),'upload_policy:\n  mode: ask\n');writeFileSync(join(root,'user-space/overrides.yaml'),'display:\n  language: de\n');
  const adapter=await createAipaAdapter(root),original='\u8acb\u4fdd\u7559\u9019\u6bb5\u539f\u6587';let context=await adapter.context({turns:[]},{input:original},[]);assert.match(context.prompt,/configured language de/);assert.ok(context.prompt.includes(original));writeFileSync(join(root,'user-space/overrides.yaml'),'display:\n  language: auto\n');context=await adapter.context({turns:[]},{input:original},[]);assert.match(context.prompt,/language of that input/);assert.equal(adapter.responseLanguage(),'auto');
});

test('Core-backed model language reads fail closed on private metadata',{skip:!framework||!existsSync(framework)},async t=>{
  const root=fixture(t);cpSync(framework,join(root,'core-space/scripts'),{recursive:true});
  writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n  owner: Synthetic\n  version: 1.0.0\n');
  writeFileSync(join(root,'user-space/overrides.yaml'),'display:\n  language: pt-BR\n');
  writeFileSync(join(root,'user-space/privacy.yaml'),'upload_policy:\n  mode: ask\n  block_patterns: ["pt-BR"]\n');
  const adapter=await createAipaAdapter(root);
  assert.throws(()=>adapter.responseLanguage(),e=>e.code==='required_context_private'&&!e.message.includes('pt-BR'));
});
