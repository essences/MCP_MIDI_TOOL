import {describe,it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cli=(data:string,...args:string[])=>new Promise<any>((resolve,reject)=>{execFile(process.execPath,['--import','tsx','src/cli/main.ts','--data-dir',data,...args],{timeout:20000},(error,stdout,stderr)=>{try{resolve({code:error?(error as any).code:0,value:JSON.parse(stdout),stderr});}catch{reject(new Error(`${error} ${stdout} ${stderr}`));}});});
describe('CLI independent process lifecycle',()=>{
 it('composes, resolves IDs, dry-runs, shares simulated capture, stops and restarts',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'midi-cli-'));const data=path.join(root,'data');
  try{
   expect((await cli(data,'runtime','status')).value.error.code).toBe('NOT_RUNNING');
   const score=path.join(root,'song.json');await fs.writeFile(score,JSON.stringify({ppq:480,tracks:[{channel:0,events:[{type:'note',tick:0,duration:240,pitch:60,velocity:100}]}]}));
   const composed=await cli(data,'compose','--input',score,'--format','json_midi_v1','--name','sample.mid');expect(composed.value.ok).toBe(true);
   const id=composed.value.fileId;expect((await cli(data,'inspect','--file-id',id)).value.fileId).toBe(id);expect((await cli(data,'decode','--file-id',id)).value.ok).toBe(true);
   expect((await cli(data,'play','--file-id',id,'--dry-run')).value.ok).toBe(true);expect((await cli(data,'runtime','status')).value.error.code).toBe('NOT_RUNNING');
   const capture=(await cli(data,'capture','start','--source','simulated','--max-wait-ms','10000','--finalize-on-release')).value;expect(capture.ok).toBe(true);
   const events=JSON.stringify([{kind:'on',note:60,velocity:90,at:0},{kind:'off',note:60,at:100}]);expect((await cli(data,'capture','feed','--id',capture.captureId,'--events',events)).value.ok).toBe(true);
   const status=(await cli(data,'capture','status','--id',capture.captureId)).value;expect(status.done).toBe(true);expect(status.result.notes).toEqual([60]);
   expect((await cli(data,'runtime','stop')).value.stopped).toBe(true);
   await new Promise(r=>setTimeout(r,150));expect((await cli(data,'runtime','status')).value.error.code).toBe('NOT_RUNNING');
   expect((await cli(data,'capture','start','--source','simulated')).value.ok).toBe(true);
   expect((await cli(data,'bogus')).code).toBe(2);expect((await cli(data,'list','--limit','oops')).code).toBe(2);
   const invalid=path.join(root,'bad.json');await fs.writeFile(invalid,'{');expect((await cli(data,'compose','--input',invalid)).code).toBe(2);
  }finally{await cli(data,'runtime','stop');await fs.rm(root,{recursive:true,force:true});}
 },30000);
});
