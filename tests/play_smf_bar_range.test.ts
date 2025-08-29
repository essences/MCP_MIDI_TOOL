import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() { const command = process.execPath; const args = ['./dist/index.js']; return spawn(command, args, { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'] }); }
function sendLine(child:any, obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function readLine(child:any){ const [buf] = await once(child.stdout,'data') as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

// Score DSL v1 (シンプル): 2小節 / 4/4 / 120bpm / 各小節8分音符x8
const SCORE = "#title:BarRangeTest\n#tempo:120\n#time:4/4\npiano: C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 | C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8";

describe('play_smf bar range', () => {
  it('startBar/endBar 指定で 1小節目のみ抽出される (dryRun)', async () => {
    const child = spawnServer();
    sendLine(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest-client',version:'0.0.1'}}});
    await readLine(child);

    // Score DSL -> SMF
    sendLine(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: SCORE, format: 'score_dsl_v1', name: 'bar_range.mid', overwrite: true }}});
    const smfResp = await readLine(child); expect(smfResp.error).toBeUndefined(); const fileId = smfResp.result?.fileId; expect(typeof fileId).toBe('string');

    // 全体 dryRun
    sendLine(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true }}});
    const allResp = await readLine(child); expect(allResp.error).toBeUndefined(); expect(allResp.result?.ok).toBe(true);
    const allEvents = allResp.result?.scheduledEvents as number; expect(typeof allEvents).toBe('number');
    const allDuration = allResp.result?.totalDurationMs as number; expect(typeof allDuration).toBe('number');

    // 1小節目
    sendLine(child,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:1, endBar:1 }}});
    const barResp = await readLine(child); expect(barResp.error).toBeUndefined(); const barEvents = barResp.result?.scheduledEvents as number; const barDuration = barResp.result?.totalDurationMs as number;
    expect(barEvents).toBeLessThan(allEvents);
    expect(barDuration).toBeLessThan(allDuration);
    expect(barDuration).toBeGreaterThan(100);

    // 2小節目
    sendLine(child,{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:2, endBar:2 }}});
    const bar2Resp = await readLine(child); expect(bar2Resp.error).toBeUndefined(); const bar2Events = bar2Resp.result?.scheduledEvents as number;
    const mode1 = barResp.result?.extractionMode || 'simple';
    const mode2 = bar2Resp.result?.extractionMode || 'simple';
    // precise モードではメタシード/合成イベントでイベント数が膨らむ可能性があるため simple 同士のみ厳密比較
    if (mode1==='simple' && mode2==='simple') {
      expect(Math.abs(bar2Events - barEvents)).toBeLessThanOrEqual(4);
    } else {
      expect(bar2Events).toBeGreaterThan(0); // 精密モードなら最低限イベントが存在することのみ検証
    }

    child.kill();
  }, 20000);
});
