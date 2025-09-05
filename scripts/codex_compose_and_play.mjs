#!/usr/bin/env node
// Compose a short piece (Score DSL JSON), save as SMF, dryRun analyze, then real playback if a device is available.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() {
  const child = spawn(process.execPath, ['./dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[srv:stderr] ' + String(d)));
  return child;
}

function send(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function read(child) {
  const [buf] = await once(child.stdout, 'data');
  const line = String(buf).split(/\r?\n/).filter(Boolean)[0];
  return JSON.parse(line);
}

function scoreDsl() {
  // 4 bars, 4/4, simple melody + bass
  return {
    ppq: 480,
    meta: {
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { root: 'C', mode: 'major' },
      tempo: { bpm: 110 },
      title: 'Codex Demo Melody'
    },
    tracks: [
      { channel: 1, program: 0, events: [
        { type:'note', note:'C4', start:{bar:1,beat:1}, duration:{ value:'1/4' } },
        { type:'note', note:'E4', start:{bar:1,beat:2}, duration:{ value:'1/4' } },
        { type:'note', note:'G4', start:{bar:1,beat:3}, duration:{ value:'1/4' } },
        { type:'note', note:'C5', start:{bar:1,beat:4}, duration:{ value:'1/4' } },

        { type:'note', note:'D4', start:{bar:2,beat:1}, duration:{ value:'1/4' } },
        { type:'note', note:'F4', start:{bar:2,beat:2}, duration:{ value:'1/4' } },
        { type:'note', note:'A4', start:{bar:2,beat:3}, duration:{ value:'1/4' } },
        { type:'note', note:'D5', start:{bar:2,beat:4}, duration:{ value:'1/4' } },

        { type:'note', note:'E4', start:{bar:3,beat:1}, duration:{ value:'1/4' } },
        { type:'note', note:'G4', start:{bar:3,beat:2}, duration:{ value:'1/4' } },
        { type:'note', note:'B4', start:{bar:3,beat:3}, duration:{ value:'1/4' } },
        { type:'note', note:'E5', start:{bar:3,beat:4}, duration:{ value:'1/4' } },

        { type:'note', note:'G4', start:{bar:4,beat:1}, duration:{ value:'1/4' } },
        { type:'note', note:'F4', start:{bar:4,beat:2}, duration:{ value:'1/4' } },
        { type:'note', note:'E4', start:{bar:4,beat:3}, duration:{ value:'1/4' } },
        { type:'note', note:'D4', start:{bar:4,beat:4}, duration:{ value:'1/4' } }
      ]},
      { channel: 2, program: 32, events: [
        { type:'note', note:'C3', start:{bar:1,beat:1}, duration:{ value:'1' } },
        { type:'note', note:'D3', start:{bar:2,beat:1}, duration:{ value:'1' } },
        { type:'note', note:'E3', start:{bar:3,beat:1}, duration:{ value:'1' } },
        { type:'note', note:'G2', start:{bar:4,beat:1}, duration:{ value:'1' } }
      ]}
    ]
  };
}

async function main() {
  const child = spawnServer();
  try {
    // initialize
    send(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'codex-compose', version:'0.0.1' } } });
    await read(child);

    // json_to_smf
    const score = scoreDsl();
    send(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'json_to_smf', arguments:{ json: score, format:'score_dsl_v1', name:'codex_compose.mid', overwrite:true } } });
    const res1 = await read(child);
    const r1 = res1.result?.content ? JSON.parse(res1.result.content[0].text) : res1.result;
    if (!r1?.ok) throw new Error('json_to_smf failed: '+JSON.stringify(res1));
    const fileId = r1.fileId;
    console.log('[compose] fileId', fileId, 'bytes', r1.bytes, 'events', r1.eventCount);

    // analyze (dryRun)
    send(child, { jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'play_smf', arguments:{ fileId, dryRun:true } } });
    const res2 = await read(child);
    if (!res2.result?.ok) throw new Error('dryRun failed: '+JSON.stringify(res2));
    const { scheduledEvents, totalDurationMs } = res2.result;
    console.log('[dryRun] events', scheduledEvents, 'totalMs', totalDurationMs);

    // list devices
    send(child, { jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'list_devices', arguments:{} } });
    const res3 = await read(child);
    const devices = res3.result?.devices || [];
    console.log('[devices]', devices.map(d=>d.name));

    // try real playback if any device is present
    if (devices.length > 0) {
      const prefer = devices.find(d => /IAC|Network|Virtual|Bus/i.test(d.name)) || devices[0];
      const portName = prefer.name;
      console.log('[play] using portName =', portName);
      send(child, { jsonrpc:'2.0', id:5, method:'tools/call', params:{ name:'play_smf', arguments:{ fileId, portName } } });
      const res4 = await read(child);
      if (res4.result?.ok && res4.result?.playbackId) {
        const pb = res4.result;
        console.log('[play] scheduled', pb.scheduledEvents, 'ms', pb.totalDurationMs, 'playbackId', pb.playbackId);
        // Optional: poll a few times
        const endAt = Date.now() + Math.min(4000, (pb.totalDurationMs || 0) + 1000);
        while (Date.now() < endAt) {
          await new Promise(r => setTimeout(r, 400));
          send(child, { jsonrpc:'2.0', id:6, method:'tools/call', params:{ name:'get_playback_status', arguments:{ playbackId: pb.playbackId } } });
          const st = await read(child);
          if (st.result?.done) { console.log('[status] done'); break; }
        }
      } else {
        console.log('[play] fallback: no playback started (ok?)', JSON.stringify(res4));
      }
    } else {
      console.log('[play] no MIDI output devices; skipped real playback');
    }
  } catch (e) {
    console.error('[compose_and_play:error]', e?.stack || String(e));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
  }
}

main();

