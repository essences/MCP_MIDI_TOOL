import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(env: Record<string,string> = {}) {
  const command = process.execPath;
  const args = ['./dist/index.js'];
  return spawn(command, args, { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'], env: { ...process.env, ...env } });
}
function send(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function recv(child:any){ const [buf]=await once(child.stdout,'data') as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

/*
  REDテスト: 精密小節抽出 (bar2..2) 時に 範囲前 (bar1) に存在した CC64=127 (サスティンON) が 0tick に再シードされることを期待。
  現状実装は tempo/timeSig/keySig のみ再シードで CC 系は未対応のため FAIL する。
  手順:
   1) JSON MIDI を直接投入: ppq=480, track1 に CC64(127) @ tick0 と 4/4 120bpm の whole note 2小節 (ノートは bar2 のみ確認用でも良いが bar跨ぎノートによる影響を避けシンプル化)。
   2) 環境変数 MCP_MIDI_PLAY_SMF_DEBUG_JSON=1 を付与し play_smf(dryRun,startBar=2,endBar=2) を呼ぶ。
   3) response.result.extractionMode==='precise' を確認。
   4) response.result.debug.extracted.tracks[0].events に type==='cc' controller=64 value=127 tick=0 が含まれることを期待 (RED)。
*/

const JSON_MIDI = {
  format: 1,
  ppq: 480,
  tracks: [
    { events: [
      { type: 'meta.timeSignature', tick: 0, numerator:4, denominator:4 },
  { type: 'meta.tempo', tick: 0, usPerQuarter: 500000 }, // 120 bpm bar1
  { type: 'meta.tempo', tick: 1920, usPerQuarter: 400000 }, // 150 bpm bar2 (tempo change to enable precise mode gating)
    ]},
    { channel:0, program:0, events: [
      { type: 'cc', tick: 0, controller: 64, value: 127 }, // sustain ON before extracted bar
      // bar1: whole note (ignored in extraction range) 0..1920 ticks
      { type: 'note', tick: 0, duration: 1920, pitch: 60, velocity: 100 },
      // bar2: a note we will actually play (1920..3840)
      { type: 'note', tick: 1920, duration: 480, pitch: 64, velocity: 100 },
    ]}
  ]
};

describe('play_smf precise bar extraction CC64 state seeding (RED)', () => {
  it('bar2 抽出で CC64=127 が 0tick に再シードされ debug.extracted に現れる (現状FAIL想定)', async () => {
    const child = spawnServer({ MCP_MIDI_PLAY_SMF_DEBUG_JSON: '1' });
    send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest-client',version:'0.0.1'}}});
    await recv(child);
    // json_to_smf
    send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: JSON_MIDI, format:'json_midi_v1', name:'cc64_seed.mid', overwrite:true }}});
    const smf = await recv(child); expect(smf.error).toBeUndefined(); const fileId = smf.result.fileId; expect(typeof fileId).toBe('string');
    // precise extraction bar2
    send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:2, endBar:2 }}});
    const resp = await recv(child); expect(resp.error).toBeUndefined(); expect(resp.result.ok).toBe(true);
    expect(resp.result.extractionMode).toBe('precise');
    const extracted = resp.result?.debug?.extracted;
    expect(extracted).toBeDefined();
    const track0Evts = Array.isArray(extracted?.tracks?.[0]?.events) ? extracted.tracks[0].events : [];
    const hasSeed = track0Evts.some((e:any)=> e.type==='cc' && e.controller===64 && e.value===127 && e.tick===0);
    expect(hasSeed).toBe(true); // RED: まだ false のはず
    child.kill();
  }, 20000);
});
