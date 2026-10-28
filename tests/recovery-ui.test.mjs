import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryPanel,recoveryItems} from '../public/status.js';
const main={capabilities:{reportRetry:true},reports:{maintenanceFailures:{'daily/2026-10-24':{summary:'Synthetic failed date'}}},distillation:{jobs:{synthetic:{status:'model-unknown',candidates:null}}}};
class Element{
 constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.textContent='';}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
}
test("Older services and pages avoid unsupported retry endpoints and initialize safely",()=>{
 const legacy={...main,capabilities:undefined};assert.equal(recoveryItems(legacy)[0].retry,false);
 const doc={createElement:tag=>new Element(tag,doc)},container=new Element('div',doc);
 const render=createRecoveryPanel({container,request:()=>assert.fail('No legacy endpoint'),refresh:()=>{},notify:()=>{}});render(legacy);
 assert.equal(container.children[0].children.some(n=>n.tag==='button'),false);
 assert.doesNotThrow(()=>createRecoveryPanel({container:null})(legacy));
});
test("Recovery UI shows phases without unknown-model replay and sends one report retry despite repeated clicks",async()=>{
 const doc={createElement:tag=>new Element(tag,doc)},container=new Element('div',doc),messages=[];let calls=0,release;
 const render=createRecoveryPanel({container,request:async key=>{assert.equal(key,'daily/2026-10-24');calls++;await new Promise(r=>release=r);return {status:'success',summary:'Recovered'};},refresh:async()=>{},notify:text=>messages.push(text)});
 render(main);assert.equal(container.children.length,2);
 assert.equal(container.children[1].children.some(n=>n.tag==='button'),false);assert.match(container.children[1].children[1].textContent,/will not.*automatically|no automatic/i);
 const button=container.children[0].children.find(n=>n.tag==='button'),first=button.onclick();await button.onclick();assert.equal(calls,1);assert.equal(button.disabled,true);release();await first;assert.deepEqual(messages,['Recovered']);
 assert.equal(recoveryItems(main)[1].retry,false);
});
test("Refresh during requests cannot reenter; buttons recover after failed requests and rerendering",async()=>{
 const doc={createElement:tag=>new Element(tag,doc)},container=new Element('div',doc);let release;
 const render=createRecoveryPanel({container,request:async()=>{await new Promise(r=>release=r);throw Error('Synthetic retry failed');},refresh:async()=>render(main),notify:()=>{}});
 render(main);const button=container.children[0].children.find(n=>n.tag==='button'),action=button.onclick();
 render(main);assert.equal(container.children[0].children.find(n=>n.tag==='button').disabled,true);
 release();await action;assert.equal(container.children[0].children.find(n=>n.tag==='button').disabled,false);
});
