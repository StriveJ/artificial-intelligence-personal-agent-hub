import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';

export function publicSourceFiles(directory){
 const root=realpathSync(directory),same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 let top;try{top=execFileSync('git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:'pipe',windowsHide:true}).trim();}catch{}
 let files=[];
 if(top&&same(realpathSync(top),root))files=execFileSync('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',stdio:'pipe',windowsHide:true}).split('\0').filter(Boolean);
 else{
  const names=['lib','public','tests','README.md','README_EN.md','LICENSE','package.json','package-lock.json',...['scripts','.gitattributes','.gitignore','AGENTS.md','README_CN.md','CHANGELOG.md','docs/release-process.md','docs/pushes.md','docs/localization.md','config.example.json','config.main.example.json','config.sub.example.json'].filter(name=>existsSync(join(root,name))),...readdirSync(root).filter(name=>/\.(?:mjs|ps1|sh)$/.test(name))];
  const visit=path=>{const stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('Unexpected public source link');if(stat.isDirectory())for(const name of readdirSync(path).sort())visit(join(path,name));else if(stat.isFile())files.push(relative(root,path).replaceAll('\\','/'));else throw Error('Unexpected public source type');};
  for(const name of names)visit(join(root,name));
 }
 files=[...new Set(files)].sort();
 for(const file of files){const rel=relative(root,resolve(root,file));if(isAbsolute(file)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw Error('Public source escaped its root');if(existsSync(join(root,file))&&lstatSync(join(root,file)).isSymbolicLink())throw Error('Unexpected public source link');}
 for(const name of ['lib/aipa.mjs','public/index.html','tests/english-source.test.mjs','package.json','package-lock.json','LICENSE'])if(!files.includes(name))throw Error('Public source inventory is incomplete: '+name);
 return files;
}
