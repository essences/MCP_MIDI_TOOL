import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ return spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio:['pipe','pipe','pipe'] }); }
function sendLine(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function readLine(child:any){ const [buf] = await once(child.stdout,'data') as [Buffer]; const line = buf.toString('utf8').split(/\r?\n/)[0]; return JSON.parse(line); }

// 単発キャプチャTDD: フロー
// 1) start_single_capture -> captureId
// 2) feed_single_capture で onsetWindow 内で複数NoteOn, 少し後に NoteOff 群
// 3) get_single_capture_status で done/result を検証
// Note: 実際のリアルデバイス入力は未実装。テストは feed_* 疑似イベントで駆動。

describe('single chord capture (TDD)', () => {
  it('captures simple triad within onset window and finalizes after silence', async () => {
    const child = spawnServer();
    // init
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    // start capture (tight window & silence)
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'start_single_capture', arguments:{ onsetWindowMs:90, silenceMs:120, maxWaitMs:3000 } } });
    const resStart = await readLine(child);
    expect(resStart.error).toBeUndefined();
    const bodyStart = JSON.parse(resStart.result.content[0].text);
    expect(bodyStart.ok).toBe(true);
    const captureId = bodyStart.captureId;
    expect(typeof captureId).toBe('string');

    // feed events: C4(60), E4(64), G4(67) on within 50ms, then offs at 400ms region
    sendLine(child, { jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'feed_single_capture', arguments:{ captureId, events:[
      { kind:'on', note:60, velocity:100, at:10 },
      { kind:'on', note:64, velocity:102, at:30 },
      { kind:'on', note:67, velocity:98, at:55 },
      { kind:'off', note:60, at:300 },
      { kind:'off', note:64, at:305 },
      { kind:'off', note:67, at:310 }
    ] } } });
    const resFeed = await readLine(child);
    expect(resFeed.error).toBeUndefined();

  // 最終NoteOff(≈310ms) + silenceMs(120ms) まで待機 (>=430ms) 余裕を持って500ms待つ
  await new Promise(r=> setTimeout(r, 500));
    sendLine(child, { jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'get_single_capture_status', arguments:{ captureId } } });
    const resStatus = await readLine(child);
    expect(resStatus.error).toBeUndefined();
    const bodyStatus = JSON.parse(resStatus.result.content[0].text);
    expect(bodyStatus.ok).toBe(true);
    expect(bodyStatus.captureId).toBe(captureId);
    expect(bodyStatus.done).toBe(true);
    expect(bodyStatus.result).toBeDefined();
    expect(bodyStatus.result.notes).toEqual([60,64,67]);
    expect(bodyStatus.result.velocities.length).toBe(3);
    expect(bodyStatus.result.durationMs).toBeGreaterThanOrEqual(250); // ~300ms 持続
    expect(bodyStatus.result.isChord).toBe(true);

    child.kill();
  }, 10000);

  it('ignores late note outside onsetWindow', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'start_single_capture', arguments:{ onsetWindowMs:60, silenceMs:100, maxWaitMs:3000 } } });
    const start = await readLine(child);
    const captureId = JSON.parse(start.result.content[0].text).captureId;
    // feed: first note at 0ms, second at 200ms (should be ignored)
    sendLine(child, { jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'feed_single_capture', arguments:{ captureId, events:[
      { kind:'on', note:60, velocity:90, at:5 },
      { kind:'off', note:60, at:150 },
      { kind:'on', note:64, velocity:90, at:200 },
      { kind:'off', note:64, at:260 }
    ] } } });
    await readLine(child);
  // 最終NoteOff 150ms + silence 100ms => 250ms 以上。余裕を持って300ms待つ
  await new Promise(r=> setTimeout(r, 300));
    sendLine(child, { jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'get_single_capture_status', arguments:{ captureId } } });
    const st = await readLine(child);
    const body = JSON.parse(st.result.content[0].text);
    expect(body.done).toBe(true);
    expect(body.result.notes).toEqual([60]);
    expect(body.result.isChord).toBe(false);
    child.kill();
  }, 10000);

  it('returns timeout reason when no note arrives within maxWaitMs', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    // onsetWindow irrelevant; set short maxWaitMs
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'start_single_capture', arguments:{ onsetWindowMs:80, silenceMs:120, maxWaitMs:400 } } });
    const start = await readLine(child);
    const captureId = JSON.parse(start.result.content[0].text).captureId;
    // 500ms待って timeout
    await new Promise(r=> setTimeout(r, 500));
    sendLine(child, { jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'get_single_capture_status', arguments:{ captureId } } });
    const st = await readLine(child);
    const body = JSON.parse(st.result.content[0].text);
    expect(body.done).toBe(true);
    expect(body.reason).toBe('timeout');
    expect(body.result.notes.length).toBe(0); // ノート無し
    child.kill();
  }, 10000);

  it('maxWaitMs到達時 全ノート終了済みなら completed 扱い', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    // maxWaitMs より前に短い和音を閉じる
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'start_single_capture', arguments:{ onsetWindowMs:60, silenceMs:100, maxWaitMs:500 } } });
    const start = await readLine(child);
    const captureId = JSON.parse(start.result.content[0].text).captureId;
    sendLine(child, { jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'feed_single_capture', arguments:{ captureId, events:[
      { kind:'on', note:60, velocity:90, at:10 },
      { kind:'off', note:60, at:50 }
    ] } } });
    await readLine(child);
    // lastOff=50ms + silence100 => 150ms で completed になる見込みだが maxWaitMs(500) までには確実に完了
    await new Promise(r=> setTimeout(r, 520));
    sendLine(child, { jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'get_single_capture_status', arguments:{ captureId } } });
    const st = await readLine(child);
    const body = JSON.parse(st.result.content[0].text);
    expect(body.done).toBe(true);
    expect(body.reason).toBe('completed');
    child.kill();
  }, 10000);
});
