const transportError=(body,message)=>Object.assign(new Error(body===undefined?message:'Connection interrupted; operation outcome is unknown. Refresh to check its status first.'),{network:true,outcomeUnknown:body!==undefined});
export function xhrRequest(path,body,{createXHR=()=>new XMLHttpRequest(),timeoutMs=30000,onUnauthorized=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  const request=createXHR();request.open(body===undefined?'GET':'POST',path,true);request.withCredentials=true;request.timeout=timeoutMs;
  request.setRequestHeader('Accept','application/json');if(body!==undefined)request.setRequestHeader('Content-Type','application/json');
  request.onload=()=>{let data;try{data=JSON.parse(request.responseText);}catch{reject(transportError(body,"Invalid response"));return;}
   if(request.status>=200&&request.status<300)resolve(data);
   else{if(request.status===401&&!path.endsWith('/login'))onUnauthorized();reject(Object.assign(new Error(data?.error||"Request incomplete"),{status:request.status}));}
  };
  request.onerror=()=>reject(transportError(body,"Connection interrupted"));request.ontimeout=()=>reject(transportError(body,"Connection timed out"));request.onabort=()=>reject(transportError(body,"Connection aborted"));
  request.send(body===undefined?undefined:JSON.stringify(body));
 });
}
export async function jsonRequest(path,body,{fetchImpl=globalThis.fetch,xhr=(path,body)=>xhrRequest(path,body),timeoutMs=30000,onUnauthorized=()=>{}}={}){
 if(body!==undefined)return xhr(path,body);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let response,data;
 try{response=await fetchImpl(path,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});data=await response.json();}
 catch{return xhr(path);}
 finally{clearTimeout(timer);}
 if(!response.ok){if(response.status===401&&!path.endsWith('/login'))onUnauthorized();throw Object.assign(new Error(data?.error||"Request incomplete"),{status:response.status});}
 return data;
}
