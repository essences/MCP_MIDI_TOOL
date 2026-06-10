import { spawn } from 'child_process';
import { once } from 'events';

const FILE_ID = process.env.FILE_ID || '4c676d7f-5f92-43b2-a455-07eb399fc3a5';
const PORT_NAME_HINT = process.env.PORT_NAME || 'IACドライバ バス1';
const MANIFEST = process.env.MANIFEST || 'manifest.json';

function makeClient(env = {}) {
  const child = spawn(process.execPath, ['./dist/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_MIDI_MANIFEST: MANIFEST, ...env }
  });
  let buf = '';
  const resolvers = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && resolvers.has(msg.id)) {
          const fn = resolvers.get(msg.id);
          if (fn) fn(msg);
          resolvers.delete(msg.id);
        } else {
          // console.log('OTHER', msg);
        }
      } catch (e) {
        console.error('JSON parse error:', e, 'line:', line);
      }
    }
  });
  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    const req = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(JSON.stringify(req) + '\n');
    return new Promise((resolve) => resolvers.set(id, resolve));
  }
  function close() { try { child.kill(); } catch {} }
  return { send, close };
}

async function main() {
  console.log('🔧 sustain診断を開始: fileId=%s, manifest=%s', FILE_ID, MANIFEST);
  const cli = makeClient();
  try {
    await cli.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'diag', version: '1.0' } });

    // 1) 解析
    const r1 = await cli.send('tools/call', { name: 'smf_to_json', arguments: { fileId: FILE_ID } });
    // server は wrap({ ok:true, json, ... }) を result に格納し、同時に result.content[0].text に JSON文字列も載せる
    let song;
    try {
      const txt = r1?.result?.content?.[0]?.text;
      if (txt) {
        const parsed = JSON.parse(txt);
        song = parsed.json || (parsed.result && parsed.result.json);
      }
      if (!song) song = r1?.result?.json;
    } catch {}
    if (!song || !song.tracks) {
      console.error('❌ 解析失敗: song構造が取得できません');
      return;
    }
    console.log('✅ 解析成功: ppq=%s tracks=%s', song.ppq, song.tracks.length);

    // ノート範囲と既存CC64の統計
    let minTick = Number.MAX_SAFE_INTEGER, maxTick = 0;
    let trackIndexWithNotes = 0;
    let channelGuess = 0;
    let cc64Count = 0, cc64OnCount = 0, cc64OffCount = 0, cc64NonBinary = 0;
    const noteChannelFreq = new Map();
    const cc64ChannelFreq = new Map();
    song.tracks.forEach((tr, ti) => {
      const ch = Number.isFinite(Number(tr.channel)) ? (tr.channel|0) : undefined;
      for (const ev of tr.events || []) {
        if (ev.type === 'note') {
          if (ev.tick < minTick) { minTick = ev.tick; trackIndexWithNotes = ti; }
          if (ev.tick + ev.duration > maxTick) maxTick = ev.tick + ev.duration;
          if (ch !== undefined) {
            channelGuess = ch;
            noteChannelFreq.set(ch, (noteChannelFreq.get(ch)||0)+1);
          }
        }
      }
    });
    if (minTick === Number.MAX_SAFE_INTEGER) { minTick = 0; maxTick = song.ppq * 4; }

    for (const tr of song.tracks) {
      for (const ev of tr.events || []) {
        if (ev.type === 'cc' && ev.controller === 64) {
          cc64Count++;
          if (ev.value >= 64) cc64OnCount++; else if (ev.value === 0) cc64OffCount++; else cc64NonBinary++;
          const evCh = Number.isFinite(Number(ev.channel)) ? (ev.channel|0) : (Number.isFinite(Number(tr.channel)) ? (tr.channel|0) : 0);
          cc64ChannelFreq.set(evCh, (cc64ChannelFreq.get(evCh)||0)+1);
        }
      }
    }
    // 主ノートチャンネルを決定
    let mainNoteCh = channelGuess;
    for (const [k,v] of noteChannelFreq.entries()) { if ((noteChannelFreq.get(mainNoteCh)||0) < v) mainNoteCh = k; }
    console.log('ℹ️ ノート主チャンネル: ch=%d (外部表記:%d)', mainNoteCh, mainNoteCh+1);
    console.log('ℹ️ 既存CC64: total=%d, ON(>=64)=%d, OFF(0)=%d, その他=%d, 分布=%s', cc64Count, cc64OnCount, cc64OffCount, cc64NonBinary, JSON.stringify(Object.fromEntries(cc64ChannelFreq)));

    // 2) 必要ならサスティンを入れ直す
    const ccOnOnMainCh = cc64ChannelFreq.get(mainNoteCh)|0;
    if (cc64OnCount === 0 || ccOnOnMainCh === 0) {
      console.log('🛠️ CC64(127/0)を挿入: range=[%d..%d], channel=%d, trackIndex=%d', minTick, maxTick, (mainNoteCh+1), trackIndexWithNotes);
      const r2 = await cli.send('tools/call', { name: 'insert_sustain', arguments: { fileId: FILE_ID, ranges: [ { startTick: minTick, endTick: maxTick, channel: (mainNoteCh+1), trackIndex: trackIndexWithNotes, valueOn: 127, valueOff: 0, removeExisting: true } ] } });
      const ok = JSON.parse(r2.content?.[0]?.text || '{}').ok ?? JSON.parse(r2.result?.content?.[0]?.text || '{}').ok ?? r2.ok;
      console.log(ok ? '✅ 挿入完了' : '⚠️ 挿入結果が不明');
    } else {
      console.log('↩️ 既存CC64が見つかったため、挿入はスキップ (必要なら removeExisting:true で再実施可能)');
    }

    // 3) エクスポート
    const r3 = await cli.send('tools/call', { name: 'export_midi', arguments: { fileId: FILE_ID } });
    console.log('📤 エクスポート応答:', r3.result?.content?.[0]?.text || r3.content?.[0]?.text || JSON.stringify(r3));

    // 4) ドライラン→実送出（2秒）
    const dr = await cli.send('tools/call', { name: 'play_smf', arguments: { fileId: FILE_ID, portName: PORT_NAME_HINT, dryRun: true, startMs: 0, stopMs: 2000 } });
    console.log('👟 ドライラン:', dr.result?.content?.[0]?.text || dr.content?.[0]?.text || JSON.stringify(dr));

    const real = await cli.send('tools/call', { name: 'play_smf', arguments: { fileId: FILE_ID, portName: PORT_NAME_HINT, startMs: 0, stopMs: 2000 } });
    console.log('🎵 実送出開始:', real.result?.content?.[0]?.text || real.content?.[0]?.text || JSON.stringify(real));
  } catch (e) {
    console.error('❌ エラー:', e);
  }
}

main().then(()=>process.exit(0));
