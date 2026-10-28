import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer,connect} from 'node:net';
import {localSocket,filesystemSocket} from '../lib/local-socket.mjs';

test("IPC paths remain compatible on Windows and use distinct short addresses for deep multibyte Linux paths",async()=>{
 const short=process.platform==='win32'?'C:\\aipa-short':'/tmp/aipa-short',deep=resolve('\u5408\u6210'.repeat(100)),digest=createHash('sha256').update(deep).digest('hex').slice(0,24);
 assert.equal(localSocket(short,'hub',{platform:'linux'}),join(short,'sub.sock'));
 assert.equal(localSocket(deep,'hub',{platform:'win32'}),`\\\\.\\pipe\\aipa-hub-${digest}`);
 const path=localSocket(deep,'hub',{platform:'linux',uid:123});assert.ok(path.startsWith('\0'));assert.ok(Buffer.byteLength(path)<100);
 assert.notEqual(path,localSocket(deep,'updater',{platform:'linux',uid:123}));assert.notEqual(path,localSocket(deep,'hub',{platform:'linux',uid:124}));
 if(process.platform!=='linux')return;
 assert.equal(filesystemSocket(path),false);
 const server=createServer(socket=>socket.end('synthetic'));
 await new Promise((yes,no)=>{server.once('error',no);server.listen(path,yes);});
 try{assert.equal(await new Promise((yes,no)=>{const socket=connect(path);let value='';socket.on('data',v=>value+=v);socket.on('error',no);socket.on('end',()=>yes(value));}),'synthetic');}finally{await new Promise(r=>server.close(r));}
});
