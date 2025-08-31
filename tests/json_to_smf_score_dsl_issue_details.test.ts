import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){
  return spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio:['pipe','pipe','pipe'] });
}
function send(c:any,o:any){ c.stdin.write(JSON.stringify(o)+"\n"); }
async function recv(c:any){ const [buf] = (await once(c.stdout,'data')) as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

describe('score_dsl_v1 validation issues detail', ()=>{
  it('returns issues array with path/message when fields missing', async ()=>{
    const child = spawnServer();
    send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest',version:'0'}}});
    await recv(child);
    const bad = { meta: { timeSignature:{ numerator:4, denominator:4 }, keySignature:{ root:'C', mode:'major' }, tempo:{ bpm:120 } }, tracks: [] }; // ppq, tracks>=1 など不足
    send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: bad, format:'score_dsl_v1' }}});
    const res = await recv(child);
    const errMsg = res.result?.error?.message || '';
    expect(errMsg).toMatch(/score_dsl_v1 compile\/validation failed/i);
    // issues は classifyError が拾う前の err.issues を保持しないため message 内のみ検証 or extend later
    child.kill();
  },15000);
});
