import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){
  const command = process.execPath;
  const args = ['./dist/index.js'];
  return spawn(command, args, { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'] });
}
function send(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+"\n"); }
async function recv(child:any){ const [buf] = (await once(child.stdout,'data')) as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

describe('json_to_smf FORMAT_MISMATCH / AUTO_DETECT_FAILED', ()=>{
  it('FORMAT_MISMATCH: JSON MIDI を score_dsl_v1 として指定すると警告', async ()=>{
    const child = spawnServer();
    send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest',version:'0'}}});
    await recv(child);
    const jsonMidi = { format:1, ppq:480, tracks:[{ channel:0, events:[{ type:'note', tick:0, pitch:60, velocity:90, duration:240 }] }] };
    send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: jsonMidi, format:'score_dsl_v1' }}});
    const res = await recv(child);
    expect(res.result?.error?.message).toMatch(/FORMAT_MISMATCH/);
    child.kill();
  },15000);

  it('AUTO_DETECT_FAILED: どちらの形式でもないオブジェクト', async ()=>{
    const child = spawnServer();
    send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest',version:'0'}}});
    await recv(child);
    const bad = { foo: 123, tracks: [{}] }; // 不完全: format/ppq なし、DSL 的構造も不足
    send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: bad }}});
    const res = await recv(child);
    expect(res.result?.error?.message).toMatch(/AUTO_DETECT_FAILED/);
    child.kill();
  },15000);
});
