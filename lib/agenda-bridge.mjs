import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
try{
  const binding=JSON.parse(readFileSync(join(root,'.git','aipa-hub-agenda.json'),'utf8'));
  const child=spawn(process.execPath,[join(binding.programDir,'lib','agenda-cli.mjs'),'--config',binding.configFile,...process.argv.slice(2)],{stdio:'inherit',shell:false,windowsHide:true});
  child.on('error',()=>{console.error("Agenda Hub connection failed. Check the local binding.");process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
}catch{console.error("Local Hub agenda bridge is not installed. Run the integration installer first.");process.exitCode=1;}
