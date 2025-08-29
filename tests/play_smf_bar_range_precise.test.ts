import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ return spawn(process.execPath,['./dist/index.js'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']}); }
function send(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function recv(child:any){ const [buf]=await once(child.stdout,'data') as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

// JSON Score (score_dsl_v1 equivalent object) 2 bars whole notes, tempo change at bar2.
const SCORE_OBJ = { ppq:480, meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'C',mode:'major'}, tempo:{ changes:[ { bar:1, beat:1, bpm:120 }, { bar:2, beat:1, bpm:240 } ] } }, tracks:[ { name:'piano', channel:0, program:0, events:[ { type:'note', start:{bar:1,beat:1}, duration:{ value:'1' }, pitch:60, velocity:90 }, { type:'note', start:{bar:2,beat:1}, duration:{ value:'1' }, pitch:62, velocity:90 } ] } ] };

/* RED TEST: いまは簡易ms換算で warnings に "bar-range applied" が含まれる想定。 精密化後は除去され extractionMode:"precise" が追加される。 */
describe('play_smf precise bar extraction (RED)', () => {
  it('startBar/endBar=2..2 で simplified 警告が無く precision モードになる（現状は失敗する）', async () => {
    const child = spawnServer();
    send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest-client',version:'0.0.1'}}});
    await recv(child);
    // to SMF
    send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: SCORE_OBJ, format:'score_dsl_v1', name:'tempo_change.mid', overwrite:true }}});
    const smf = await recv(child); expect(smf.error).toBeUndefined(); const fileId = smf.result.fileId; expect(typeof fileId).toBe('string');
    // bar2 only
    send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:2, endBar:2 }}});
    const resp = await recv(child); expect(resp.error).toBeUndefined(); expect(resp.result.ok).toBe(true);
    // RED: まだ simplified warning があるため次の期待は FAIL するはず
    const warnings: string[] = resp.result.warnings || [];
    expect(warnings.some(w=>/bar-range applied/.test(w))).toBe(false); // precision化後にGREEN
    expect(resp.result.extractionMode).toBe('precise');
    child.kill();
  }, 15000);
});
