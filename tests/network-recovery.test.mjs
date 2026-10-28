import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {jsonRequest,xhrRequest} from '../public/json-api.js';
import {readFileSync} from 'node:fs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,posix} from 'node:path';
import {createHub} from '../server.mjs';
import {execFileSync} from 'node:child_process';

test("Reads fall back only on transport failures, never HTTP rejections, and terminate after timeouts",async()=>{
 let fallback=0,unauthorized=0;const xhr=async()=>{fallback++;return {synthetic:true};};
 assert.deepEqual(await jsonRequest('/read',undefined,{fetchImpl:async()=>{throw Error('network');},xhr}),{synthetic:true});assert.equal(fallback,1);
 await assert.rejects(()=>jsonRequest('/read',undefined,{fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:'denied'})}),xhr,onUnauthorized:()=>unauthorized++}),{status:401});assert.equal(fallback,1);assert.equal(unauthorized,1);
 const fetchImpl=(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
 assert.deepEqual(await jsonRequest('/read',undefined,{fetchImpl,xhr,timeoutMs:10}),{synthetic:true});assert.equal(fallback,2);
});
class FakeXHR{open(method,path){this.method=method;this.path=path;}setRequestHeader(){}send(body){this.body=body;queueMicrotask(()=>this.act(this));}}
test("Mutations send one XHR; timeouts and invalid responses preserve unknown outcomes without automatic replay",async()=>{
 for(const kind of ['error','timeout','invalid']){let sends=0;const createXHR=()=>{const request=new FakeXHR();request.act=x=>{sends++;assert.equal(x.method,'POST');assert.equal(x.withCredentials,true);assert.equal(x.timeout,30);assert.deepEqual(JSON.parse(x.body),{id:'synthetic-operation'});if(kind==='invalid'){x.status=200;x.responseText='broken';x.onload();}else x[kind==='error'?'onerror':'ontimeout']();};return request;};
  await assert.rejects(()=>jsonRequest('/change',{id:'synthetic-operation'},{fetchImpl:()=>assert.fail('POST \u4e0d\u5f97\u5148\u53d1 fetch'),xhr:(path,body)=>xhrRequest(path,body,{createXHR,timeoutMs:30})}),error=>error.outcomeUnknown===true&&/review|check|verify/i.test(error.message));assert.equal(sends,1);
 }
});
test("XHR authentication failures retain HTTP status without resending or repeated login-page resets",async()=>{
 let resets=0;const createXHR=()=>{const request=new FakeXHR();request.act=x=>{x.status=401;x.responseText=JSON.stringify({error:'denied'});x.onload();};return request;};
 await assert.rejects(()=>xhrRequest('/change',{}, {createXHR,onUnauthorized:()=>resets++}),{status:401});assert.equal(resets,1);
 await assert.rejects(()=>xhrRequest('/api/login',{}, {createXHR,onUnauthorized:()=>resets++}),{status:401});assert.equal(resets,1);
});
test("Real HTTP response loss never replays POST automatically; explicit same-ID retry preserves one record",async t=>{
 const entries=new Map();let requests=0,drop=true;
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;requests++;const body=JSON.parse(text);entries.set(body.id,body.text);if(drop){drop=false;req.socket.destroy();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({saved:entries.size}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url='http://127.0.0.1:'+server.address().port;
 const createXHR=()=>{const request=new FakeXHR();request.send=body=>{const req=httpRequest(url+request.path,{method:request.method,headers:{'Content-Type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{request.status=res.statusCode;request.responseText=text;request.onload();});});req.on('error',()=>request.onerror());req.end(body);};return request;};
 const body={id:'synthetic-same-id',text:'Synthetic preserved draft'},options={fetchImpl:()=>assert.fail('\u4e0d\u5e94\u8c03\u7528 fetch'),xhr:(path,body)=>xhrRequest(path,body,{createXHR})};
 await assert.rejects(()=>jsonRequest('/change',body,options),{outcomeUnknown:true});assert.equal(requests,1);assert.equal(entries.size,1);
 assert.deepEqual(await jsonRequest('/change',body,options),{saved:1});assert.equal(requests,2);assert.equal(entries.size,1);
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert.match(app,/jsonRequest\(path,body/);assert.match(app,/sessionStorage\.setItem\('aipa-pending'/);
});

test("All relative browser modules are served by Hub to prevent missing-module blank pages on weak networks",async t=>{
 const parent=resolve(tmpdir()),base=mkdtempSync(join(parent,'network-assets-')),root=join(base,'instance');mkdirSync(root);writeFileSync(join(root,'AIPA-MANIFEST.yaml'),'aipa:\n owner: Synthetic\n version: 0.23.0\n');
 execFileSync('git',['init','--initial-branch=test',root],{stdio:'pipe',windowsHide:true});
 let hub;t.after(async()=>{if(hub)await hub.close();assert.ok(resolve(base).startsWith(parent+sep));rmSync(base,{recursive:true,force:true});});
 hub=await createHub({root,runtimeDir:join(base,'runtime'),port:0,testMode:true,runner:async()=>assert.fail('\u9759\u6001\u9875\u9762\u4e0d\u80fd\u8c03\u7528\u6a21\u578b'),adapter:{owner:'Synthetic',version:'synthetic',requiresConsent:()=>true,begin:async()=>null,record:async()=>null,search:async()=>[],context:async()=>assert.fail('\u9759\u6001\u9875\u9762\u4e0d\u80fd\u8bfb\u4e0a\u4e0b\u6587')}});
 const url=await hub.listen(),seen=new Set(),pending=['/app.js'];
 while(pending.length){const path=pending.shift();if(seen.has(path))continue;seen.add(path);const response=await fetch(url+path);assert.equal(response.status,200,path);assert.match(response.headers.get('content-type'),/javascript/);const code=await response.text();for(const match of code.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){if(match[1].startsWith('.'))pending.push(posix.resolve(posix.dirname(path),match[1]));}}
 assert.ok(seen.has('/json-api.js'));assert.ok(seen.has('/vendor/marked.esm.js'));
});
