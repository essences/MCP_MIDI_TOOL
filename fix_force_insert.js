import { spawn } from 'child_process';

const FILE_ID = '4c676d7f-5f92-43b2-a455-07eb399fc3a5';
const PORT_NAME_HINT = 'IACドライバ バス1';
const MANIFEST = 'manifest.json';

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
        }
      } catch {}
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

(async () => {
  console.log('🔧 強制サスティン挿入を開始: fileId=%s, manifest=%s', FILE_ID, MANIFEST);
  const cli = makeClient();
  await cli.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'force', version: '1.0' } });

  const r1 = await cli.send('tools/call', { name: 'smf_to_json', arguments: { fileId: FILE_ID } });
  let song;
  try {
    const txt = r1?.result?.content?.[0]?.text;
    if (txt) {
      const parsed = JSON.parse(txt);
      song = parsed.json || (parsed.result && parsed.result.json);
    }
    if (!song) song = r1?.result?.json;
  } catch {}
  if (!song) { console.error('❌ smf_to_json失敗'); process.exit(1); }

  let minTick = Number.MAX_SAFE_INTEGER, maxTick = 0;
  const noteChannelFreq = new Map();
  let trackIndexWithNotes = 0;
  song.tracks.forEach((tr, ti) => {
    const ch = Number.isFinite(Number(tr.channel)) ? (tr.channel|0) : undefined;
    for (const ev of tr.events || []) {
      if (ev.type === 'note') {
        if (ev.tick < minTick) { minTick = ev.tick; trackIndexWithNotes = ti; }
        if (ev.tick + ev.duration > maxTick) maxTick = ev.tick + ev.duration;
        if (ch !== undefined) noteChannelFreq.set(ch, (noteChannelFreq.get(ch)||0)+1);
      }
    }
  });
  if (minTick === Number.MAX_SAFE_INTEGER) { minTick = 0; maxTick = song.ppq * 4; }
  let mainNoteCh = 0; let best = -1;
  for (const [k,v] of noteChannelFreq.entries()) { if (v > best) { best = v; mainNoteCh = k; } }

  console.log('🛠️ removeExisting=true で入れ直し: range=[%d..%d], channel(ext)=%d, trackIndex=%d', minTick, maxTick, mainNoteCh+1, trackIndexWithNotes);
  const r2 = await cli.send('tools/call', { name: 'insert_sustain', arguments: { fileId: FILE_ID, ranges: [ { startTick: minTick, endTick: maxTick, channel: (mainNoteCh+1), trackIndex: trackIndexWithNotes, valueOn: 127, valueOff: 0, removeExisting: true } ] } });
  console.log('応答:', r2?.result?.content?.[0]?.text || r2?.content?.[0]?.text || JSON.stringify(r2));

  const r3 = await cli.send('tools/call', { name: 'export_midi', arguments: { fileId: FILE_ID } });
  console.log('📤 export:', r3?.result?.content?.[0]?.text || '');

  const dr = await cli.send('tools/call', { name: 'play_smf', arguments: { fileId: FILE_ID, portName: PORT_NAME_HINT, dryRun: true, startMs: 0, stopMs: 2000 } });
  console.log('👟 dryRun:', dr?.result?.content?.[0]?.text || '');

  const real = await cli.send('tools/call', { name: 'play_smf', arguments: { fileId: FILE_ID, portName: PORT_NAME_HINT, startMs: 0, stopMs: 2000 } });
  console.log('🎵 play:', real?.result?.content?.[0]?.text || '');
})();
