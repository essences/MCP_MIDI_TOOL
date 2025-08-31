import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(env: Record<string,string> = {}) {
  return spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'], env: { ...process.env, ...env } });
}
function send(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function recv(child:any){ const [buf]=await once(child.stdout,'data') as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

/*
  REDテスト: 精密抽出 bar2..2 で 範囲前 (bar1) に存在した pitchBend(value=2048) が 0tick に再シードされること。
  現状は pitchBend シード未実装のため extracted.track0.events に出現せず FAIL を期待。
  条件: tempo 変化を bar2 頭に置き precise gating を有効化。
*/

const JSON_MIDI = {
  format: 1,
  ppq: 480,
  tracks: [
    { events: [
      { type: 'meta.timeSignature', tick: 0, numerator:4, denominator:4 },
      { type: 'meta.tempo', tick: 0, usPerQuarter: 500000 },
      { type: 'meta.tempo', tick: 1920, usPerQuarter: 400000 }, // tempo change at bar2 for precise mode gating
    ]},
  { channel:1, program:0, events: [
      { type: 'pitchBend', tick: 0, value: 2048 },
      { type: 'note', tick: 0, duration: 1920, pitch: 60, velocity: 100 },
      { type: 'note', tick: 1920, duration: 480, pitch: 64, velocity: 100 },
    ]}
  ]
};

describe('play_smf precise bar extraction pitchBend state seeding (RED)', () => {
  it('bar2 抽出で pitchBend(value=2048) が 0tick に再シードされる (現状FAIL想定)', async () => {
    const child = spawnServer({ MCP_MIDI_PLAY_SMF_DEBUG_JSON: '1' });
    send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest-client',version:'0.0.1'}}});
    await recv(child);
    send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: JSON_MIDI, format:'json_midi_v1', name:'pitchbend_seed.mid', overwrite:true }}});
    const smf = await recv(child); expect(smf.error).toBeUndefined(); const fileId = smf.result.fileId; expect(typeof fileId).toBe('string');
    send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:2, endBar:2 }}});
    const resp = await recv(child); expect(resp.error).toBeUndefined(); expect(resp.result.ok).toBe(true); expect(resp.result.extractionMode).toBe('precise');
    const extracted = resp.result?.debug?.extracted; expect(extracted).toBeDefined();
    const track0Evts = Array.isArray(extracted?.tracks?.[0]?.events) ? extracted.tracks[0].events : [];
    const hasSeed = track0Evts.some((e:any)=> e.type==='pitchBend' && e.value===2048 && e.tick===0);
    if (!hasSeed) {
      // 観察ログ: 現在の track0 events を出力
      // eslint-disable-next-line no-console
      console.error('DEBUG track0 events:', JSON.stringify(track0Evts));
    }
    expect(hasSeed).toBe(true); // RED: 失敗時にログで内容確認
    child.kill();
  }, 20000);
});
