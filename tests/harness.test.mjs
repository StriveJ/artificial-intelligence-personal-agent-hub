import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHarnessRunner,harnessPatch} from '../lib/harness.mjs';
import {modelProfile,deepseekModelCredential} from '../lib/model-profile.mjs';

test("Harness route identity and official credential reuse share one configuration generation",()=>{
  const env={DEEPSEEK_API_KEY:'synthetic-key'}, runner={identity:{executor:'harness'}};
  const p=modelProfile({engine:'harness',env,runner});
  assert.equal(p.executor,'DeepSeek Harness CLI');assert.equal(p.provider,'DeepSeek');
  assert.equal(p.requestedModel,'deepseek-flash');assert.equal(deepseekModelCredential({engine:'harness',env}).apiKey,'synthetic-key');
  assert.notEqual(p.version,modelProfile({engine:'harness',runner,env:{...env,DEEPSEEK_API_KEY:'changed'}}).version);
  assert.equal(deepseekModelCredential({engine:'harness',env:{...env,DEEPSEEK_BASE_URL:'https://untrusted.example/anthropic'}}),null);
  assert.doesNotMatch(JSON.stringify(p),/synthetic-key/);
});

test("Harness stdin preserves multilingual Unicode in isolated temporary sessions with cleanup",async()=>{
  const dir=mkdtempSync(join(tmpdir(),'harness-contract-'));
  try {
    const entry=join(dir,'fake.mjs');
    writeFileSync(entry,`import assert from 'node:assert/strict';let text='';for await(const c of process.stdin)text+=c;assert.equal(process.argv.at(-1),'-');assert.equal(process.env.DSH_TELEMETRY_DISABLED,'1');assert.equal(process.env.UNRELATED_PRIVATE_DATA,undefined);assert.equal(process.env.DEEPSEEK_API_KEY,'synthetic');process.stdout.write(text);`);
    const workDir=join(dir,'jobs'),r=createHarnessRunner({entry,workDir,env:{DEEPSEEK_API_KEY:'synthetic',UNRELATED_PRIVATE_DATA:'private'}});
    assert.equal(await r('\u4e2d\u6587\u6d4b\u8bd5：\u676f\u5b50'),'\u4e2d\u6587\u6d4b\u8bd5：\u676f\u5b50');assert.deepEqual(readdirSync(workDir),[]);
    assert.equal(r.lastDiagnostic.exitCode,0);r.close();await assert.rejects(r('again'),/stopped/i);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("Harness timeouts, cancellation, and nonzero exits never return false success",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'harness-stop-'));
 try {
  const entry=join(dir,'slow.mjs');writeFileSync(entry,'setInterval(()=>{},1000)');
  const r=createHarnessRunner({entry,workDir:join(dir,'jobs'),timeoutMs:150});await assert.rejects(r('hello'),/timed out/i);
  const r2=createHarnessRunner({entry,workDir:join(dir,'jobs2')});const pending=r2('hello');setTimeout(()=>r2.close(),100);await assert.rejects(pending,/aborted/i);
  writeFileSync(entry,"process.stdout.write('partial');process.exit(1)");const r3=createHarnessRunner({entry,workDir:join(dir,'jobs3')});await assert.rejects(r3('hello'),/incomplete|did not complete/i);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("Controlled external Harness has no tools or side context and cannot execute malicious file requests", {skip:!process.env.AIPA_TEST_HARNESS_ENTRY,timeout:90000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'harness-real-'));let count=0;const requests=[];
 const marker=join(dir,'forbidden');
 const mock=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);count++;
  const content=count===1?[{type:'tool_use',id:'denied-call',name:'bash',input:{command:'touch '+marker}}]:[{type:'text',text:'\u5de5\u5177\u5df2\u963b\u6b62，\u4e2d\u6587\u54cd\u5e94\u6b63\u5e38'}];
  const reason=count===1?'tool_use':'end_turn';
  const msg={id:'synthetic-'+count,type:'message',role:'assistant',model:'deepseek-flash',content,stop_reason:reason,stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(msg));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});const emit=(e,d)=>res.write('event: '+e+'\ndata: '+JSON.stringify(d)+'\n\n');
  emit('message_start',{type:'message_start',message:{...msg,content:[],stop_reason:null}});
  for(const [index,c] of content.entries()){
   emit('content_block_start',{type:'content_block_start',index,content_block:c.type==='tool_use'?{...c,input:{}}:{type:'text',text:''}});
   emit('content_block_delta',{type:'content_block_delta',index,delta:c.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(c.input)}:{type:'text_delta',text:c.text}});
   emit('content_block_stop',{type:'content_block_stop',index});
  }
  emit('message_delta',{type:'message_delta',delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{type:'message_stop'});res.end();
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const r=createHarnessRunner({entry:process.env.AIPA_TEST_HARNESS_ENTRY,workDir:join(dir,'jobs'),timeoutMs:60000,env:{PATH:process.env.PATH,DEEPSEEK_API_KEY:'synthetic',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+mock.address().port}});
 try {
  const answer=await r('\u516c\u5f00\u6d4b\u8bd5。\u8bf7\u56de\u7b54\u4e2d\u6587。');assert.match(answer,/\u4e2d\u6587\u54cd\u5e94\u6b63\u5e38/);assert.ok(requests.length>=2);
  for(const request of requests)assert.equal(request.tools?.length||0,0,"Models must not receive tool schemas");
  assert.equal(existsSync(marker),false);assert.deepEqual(readdirSync(join(dir,'jobs')),[]);
 } finally {r.close();await new Promise(r=>mock.close(r));rmSync(dir,{recursive:true,force:true});}
});
