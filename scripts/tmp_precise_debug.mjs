import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ return spawn(process.execPath,['./dist/index.js'],{cwd:process.cwd(),stdio:['pipe','pipe','inherit']}); }
function send(child,obj){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function recv(child){ const [buf]=await once(child.stdout,'data'); return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

const SCORE_OBJ = { ppq:480, meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'C',mode:'major'}, tempo:{ changes:[ { bar:1, beat:1, bpm:120 }, { bar:2, beat:1, bpm:240 } ] } }, tracks:[ { name:'piano', channel:0, program:0, events:[ { type:'note', start:{bar:1,beat:1}, duration:{ value:'1' }, pitch:60, velocity:90 }, { type:'note', start:{bar:2,beat:1}, duration:{ value:'1' }, pitch:62, velocity:90 } ] } ] };

(async()=>{
  const child=spawnServer();
  send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'dbg',version:'0.0.0'}}});
  await recv(child);
  send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json:SCORE_OBJ, format:'score_dsl_v1', name:'tempo_change.mid', overwrite:true }}});
  const smf=await recv(child); const fileId=smf.result.fileId; console.log('fileId',fileId);
  send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:2, endBar:2 }}});
  const resp=await recv(child); console.log(JSON.stringify(resp,null,2));
  child.kill();
})();
