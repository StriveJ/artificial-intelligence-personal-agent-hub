import test from 'node:test';
import assert from 'node:assert/strict';
import {modelProfile,deepseekModelCredential} from '../lib/model-profile.mjs';
import {turnOptions,sameTurnRequest} from '../lib/turn-request.mjs';

test("Model identity binds route, model, and credentials without exposing private paths, keys, or guessed actual models",()=>{
  const env={ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_MODEL:'example-model',ANTHROPIC_AUTH_TOKEN:'synthetic-secret'};
  const a=modelProfile({engine:'claude',runner:{identity:{entry:'D:/private/cli.exe'}},env});
  assert.equal(a.provider,'DeepSeek');assert.equal(a.requestedModel,'example-model');assert.equal(a.resolvedModel,null);
  assert.doesNotMatch(JSON.stringify(a),/synthetic-secret|private|api\.deepseek/);
  assert.equal(modelProfile({engine:'claude',runner:{identity:{entry:'D:/private/cli.exe'}},env}).version,a.version);
  assert.notEqual(modelProfile({engine:'claude',runner:{},env:{...env,ANTHROPIC_AUTH_TOKEN:'changed'}}).version,a.version);
  const unknown=modelProfile({engine:'codex',runner:{},env:{}});assert.equal(unknown.requestedModel,null);assert.match(unknown.provider,/unverified/i);
});

test("Turn protocol preserves model generation and image references and rejects invalid image IDs",()=>{
  const options=turnOptions({engine:'codex',consent:true,modelProfileVersion:'profile'});
  assert.equal(options.requestVersion,1);assert.deepEqual(options.attachmentIds,[]);
  assert.equal(sameTurnRequest({input:'text',...options},'text',options),true);
  assert.equal(sameTurnRequest({input:'text',...options},'text',{...options,modelProfileVersion:'different'}),false);
  assert.equal(sameTurnRequest({input:'text',engine:'codex',consent:true},'text',options),true,"Legacy records without model generations recognize harmless duplicate submissions");
  assert.throws(()=>turnOptions({attachmentIds:['image-001']}),/invalid image references/i);
  assert.throws(()=>turnOptions({requestVersion:2}),/protocol/i);
});

test("Only confirmed official DeepSeek routes are reused; proxies, spoofed hosts, and URL credentials are rejected",()=>{
  const env={ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_AUTH_TOKEN:'fixture-key'};
  assert.equal(deepseekModelCredential({engine:'claude',env}).apiKey,'fixture-key');
  for(const base of ['https://api.deepseek.com.evil.example','http://api.deepseek.com','https://user:password@api.deepseek.com','https://api.deepseek.com/other','https://proxy.example/anthropic','https://api.deepseek.com?key=x',''])assert.equal(deepseekModelCredential({engine:'claude',env:{...env,ANTHROPIC_BASE_URL:base}}),null);
  assert.equal(deepseekModelCredential({engine:'codex',env:{OPENAI_BASE_URL:'https://api.deepseek.com/v1',OPENAI_API_KEY:'fixture'}}).apiKey,'fixture');
});
