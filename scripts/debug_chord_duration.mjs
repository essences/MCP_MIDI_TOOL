#!/usr/bin/env node
// Score DSL の和音デュレーション問題をデバッグ
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() {
  const command = process.execPath; // node
  const args = ['./dist/index.js'];
  const child = spawn(command, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', (e) => console.error('[server:error]', e));
  child.stderr.on('data', (d) => process.stderr.write(String(d)));
  return child;
}

function sendLine(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function readLine(child) {
  const [buf] = await once(child.stdout, 'data');
  const line = String(buf).split(/\r?\n/).filter(Boolean)[0];
  return JSON.parse(line);
}

// 和音のテスト用Score DSL
function createChordTest() {
  return {
    ppq: 480,
    meta: {
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { root: "C", mode: "major" },
      tempo: { bpm: 120 }
    },
    tracks: [
      { 
        channel: 1,
        program: 0,
        events: [
          // C-E-Gの和音（全音符）
          { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1" }, velocity: 100 },
          { type: "note", note: "E4", start: { bar: 1, beat: 1 }, duration: { value: "1" }, velocity: 100 },
          { type: "note", note: "G4", start: { bar: 1, beat: 1 }, duration: { value: "1" }, velocity: 100 },
        ]
      }
    ]
  };
}

async function main() {
  const child = spawnServer();
  let id = 1;
  
  try {
    // initialize
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'initialize', 
      params: { 
        protocolVersion: '2025-06-18', 
        capabilities: {}, 
        clientInfo: { name: 'chord-debug', version: '1.0.0' } 
      } 
    });
    const initRes = await readLine(child);
    if (initRes.error) throw new Error('initialize failed');

    // Score DSL -> SMF変換
    const chordTest = createChordTest();
    console.log('🎼 入力Score DSL:');
    console.log(JSON.stringify(chordTest, null, 2));
    
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { 
        name: 'json_to_smf', 
        arguments: { 
          json: chordTest, 
          format: 'score_dsl_v1',
          name: 'chord-debug.mid'
        } 
      } 
    });
    const smfRes = await readLine(child);
    if (smfRes.error) throw new Error('json_to_smf failed: ' + JSON.stringify(smfRes.error));
    
    const smfBody = JSON.parse(smfRes.result.content[0].text);
    console.log('✅ SMF作成完了:', smfBody.fileId);

    // SMF -> JSON変換して内部構造を確認
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { 
        name: 'smf_to_json', 
        arguments: { 
          fileId: smfBody.fileId
        } 
      } 
    });
    const jsonRes = await readLine(child);
    if (jsonRes.error) throw new Error('smf_to_json failed');
    
    const jsonBody = JSON.parse(jsonRes.result.content[0].text);
    console.log('\n🔍 変換後のJSON MIDI構造:');
    console.log('PPQ:', jsonBody.json.ppq);
    console.log('Tracks:');
    
    jsonBody.json.tracks.forEach((track, i) => {
      console.log(`\nTrack ${i}:`);
      if (track.events) {
        track.events.forEach(event => {
          if (event.type === 'note') {
            console.log(`  Note ${event.note}: tick=${event.tick}, duration=${event.duration} (${event.duration / 480}拍)`);
          }
        });
      }
    });

    // 理論値の計算
    console.log('\n📐 理論値:');
    console.log('  BPM 120, 4/4拍子, PPQ 480');
    console.log('  全音符(1) = 4拍 = 1920 ticks');
    console.log('  4拍 = 2000ms (BPM120で1拍=500ms)');

    child.kill();
    
  } catch (e) {
    console.error('❌ エラー:', e?.message || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

main();