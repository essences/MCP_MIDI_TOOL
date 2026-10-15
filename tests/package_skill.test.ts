import {describe,it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const repository=process.cwd();
function run(file:string,args:string[],cwd:string){return new Promise<{stdout:string;stderr:string}>((resolve,reject)=>execFile(file,args,{cwd,timeout:60000},(error,stdout,stderr)=>error?reject(new Error(`${error.message}\n${stdout}\n${stderr}`)):resolve({stdout,stderr})));}
describe('standalone skill distribution',()=>{
 it('packages only reachable modules and operates outside the repository',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'midi-package-'));const output=path.join(root,'portable');const elsewhere=path.join(root,'elsewhere');await fs.mkdir(elsewhere);let cli='';
  try{
   const result=JSON.parse((await run(process.execPath,[path.join(repository,'scripts/package_skill.mjs'),'--output',output],elsewhere)).stdout);expect(result.ok).toBe(true);expect(result.modules).toContain('engine.js');expect(result.modules.some((name:string)=>/index|directApi|mcp\//.test(name))).toBe(false);
   const pkg=JSON.parse(await fs.readFile(path.join(output,'package.json'),'utf8'));expect(Object.keys(pkg.dependencies).sort()).toEqual(['midi','midi-file','zod']);expect(await fs.readdir(output)).not.toContain('data');
   for(const name of result.modules){const source=await fs.readFile(path.join(output,'lib',name),'utf8');expect(source).not.toContain('@modelcontextprotocol');expect(source).not.toContain(repository);}
   // Smoke-only symlink provides already installed dependencies; distribution never includes node_modules.
   await fs.symlink(path.join(repository,'node_modules'),path.join(output,'node_modules'),'dir');
   cli=path.join(output,'scripts/midi.mjs');const data=path.join(root,'state');const song=path.join(root,'song.json');await fs.writeFile(song,JSON.stringify({ppq:480,tracks:[{channel:0,events:[{type:'note',tick:0,duration:240,pitch:60,velocity:90}]}]}));
   const invoke=async(...args:string[])=>JSON.parse((await run(process.execPath,[cli,'--data-dir',data,...args],elsewhere)).stdout);
   const composed=await invoke('compose','--input',song,'--format','json_midi_v1','--name','portable.mid');expect(composed.ok).toBe(true);expect((await invoke('decode','--file-id',composed.fileId)).ok).toBe(true);expect((await invoke('play','--file-id',composed.fileId,'--dry-run')).ok).toBe(true);
   const capture=await invoke('capture','start','--source','simulated','--finalize-on-release');expect(capture.ok).toBe(true);expect((await invoke('capture','feed','--id',capture.captureId,'--events','[{"kind":"on","note":60,"at":0},{"kind":"off","note":60,"at":100}]')).ok).toBe(true);expect((await invoke('capture','status','--id',capture.captureId)).done).toBe(true);expect((await invoke('runtime','stop')).ok).toBe(true);
   const preserve=path.join(output,'data','keep.mid');await fs.mkdir(path.dirname(preserve));await fs.writeFile(preserve,'keep');await run(process.execPath,[path.join(repository,'scripts/package_skill.mjs'),'--output',output],elsewhere);expect(await fs.readFile(preserve,'utf8')).toBe('keep');
  }finally{if(cli)await run(process.execPath,[cli,'--data-dir',path.join(root,'state'),'runtime','stop'],elsewhere).catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
 },30000);
});
