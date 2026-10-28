import test from 'node:test';
import assert from 'node:assert/strict';
import {generateWebQuery,validateWebQuery} from '../lib/web-query.mjs';

test("Automatic search generates one public topic without raw-question fallback",async()=>{
  let calls=0;
  assert.equal(await generateWebQuery('Explain the DeepSeek search API',async prompt=>{calls++;assert.match(prompt,/Current question/i);return '```json\n{"query":"DeepSeek Search API official documentation"}\n```';}),"DeepSeek Search API official documentation");
  assert.equal(calls,1);
  for(const answer of ['not json','{"query":null}','{"query":""}',JSON.stringify({query:'a'.repeat(129)})])await assert.rejects(()=>generateWebQuery('\u539f\u95ee\u9898',async()=>answer),/incomplete|valid search query/i);
});

test("Automatic and manual queries reject contact details, credentials, and local paths and recheck instance privacy",async()=>{
  for(const query of ['alice@example.org','13812345678','D:\\private\\notes.txt','/home/example-user/private','token=secret-value','sk-abcdefghijklmnop'])assert.throws(()=>validateWebQuery(query),/personal information or credentials/i);
  await assert.rejects(()=>generateWebQuery('\u95ee\u9898',async()=>' {"query":"blocked topic"}',()=>false),/privacy rules/i);
});
