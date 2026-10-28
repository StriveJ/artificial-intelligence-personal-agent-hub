import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export function localSocket(runtimeDir,kind,{platform=process.platform,uid=process.getuid?.()??0}={}){
  if(!['hub','updater'].includes(kind))throw Error('Unknown local socket kind');
  const digest=createHash('sha256').update(resolve(runtimeDir)).digest('hex').slice(0,24);
  if(platform==='win32')return `\\\\.\\pipe\\aipa-${kind}-${digest}`;
  const path=join(runtimeDir,kind==='hub'?'sub.sock':'updater.sock');
  return platform==='linux'&&Buffer.byteLength(path)>=100?`\0aipa-${kind}-${uid}-${digest}`:path;
}
export const filesystemSocket=path=>process.platform!=='win32'&&!path.startsWith('\0');
