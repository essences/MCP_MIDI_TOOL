#!/usr/bin/env node
// 和音デュレーション問題の回避策テスト
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() {
  const command = process.execPath;
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

// 回避策: JSON MIDI直接形式でメロディを作成
function createMelodyDirectJson() {
  return {
    format: 1,
    ppq: 480,
    tracks: [
      // Track 0: テンポ情報
      { 
        events: [
          { type: 'meta.tempo', tick: 0, usPerQuarter: 500000 } // BPM 120
        ] 
      },
      // Track 1: メロディ (ch1 = 内部channel 0)
      { 
        channel: 0, // 内部表記（外部ch1）
        events: [
          { type: 'program', tick: 0, program: 0 }, // Piano
          
          // 1小節目: ド・レ・ミ・ファ (4分音符 = 480 ticks)
          { type: 'note', tick: 0, pitch: 60, note: 'C4', velocity: 100, duration: 480 },
          { type: 'note', tick: 480, pitch: 62, note: 'D4', velocity: 95, duration: 480 },
          { type: 'note', tick: 960, pitch: 64, note: 'E4', velocity: 90, duration: 480 },
          { type: 'note', tick: 1440, pitch: 65, note: 'F4', velocity: 95, duration: 480 },
          
          // 2小節目: ソ・ファ・ミ・レ  
          { type: 'note', tick: 1920, pitch: 67, note: 'G4', velocity: 100, duration: 480 },
          { type: 'note', tick: 2400, pitch: 65, note: 'F4', velocity: 95, duration: 480 },
          { type: 'note', tick: 2880, pitch: 64, note: 'E4', velocity: 90, duration: 480 },
          { type: 'note', tick: 3360, pitch: 62, note: 'D4', velocity: 95, duration: 480 },
          
          // 3小節目: C-E-Gの和音 (全音符 = 1920 ticks)
          { type: 'note', tick: 3840, pitch: 60, note: 'C4', velocity: 100, duration: 1920 },
          { type: 'note', tick: 3840, pitch: 64, note: 'E4', velocity: 100, duration: 1920 },
          { type: 'note', tick: 3840, pitch: 67, note: 'G4', velocity: 100, duration: 1920 },
          
          // 4小節目: ド (全音符)
          { type: 'note', tick: 5760, pitch: 60, note: 'C4', velocity: 110, duration: 1920 }
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
        clientInfo: { name: 'chord-workaround', version: '1.0.0' } 
      } 
    });
    const initRes = await readLine(child);
    if (initRes.error) throw new Error('initialize failed');

    console.log('🎼 回避策：JSON MIDI直接形式で作曲');

    // JSON MIDI直接形式でSMF作成
    const melody = createMelodyDirectJson();
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { 
        name: 'json_to_smf', 
        arguments: { 
          json: melody, 
          format: 'json_midi_v1',
          name: 'fixed-melody.mid', 
          overwrite: true 
        } 
      } 
    });
    const smfRes = await readLine(child);
    if (smfRes.error) throw new Error('json_to_smf failed: ' + JSON.stringify(smfRes.error));
    
    const smfBody = JSON.parse(smfRes.result.content[0].text);
    console.log(`✅ 修正版楽曲作成完了: ${smfBody.fileId}`);
    console.log(`   サイズ: ${smfBody.bytes} bytes, イベント数: ${smfBody.eventCount}`);

    // dryRun解析
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { 
        name: 'play_smf', 
        arguments: { 
          fileId: smfBody.fileId, 
          dryRun: true 
        } 
      } 
    });
    const dryRunRes = await readLine(child);
    if (dryRunRes.error) throw new Error('dryRun failed');
    
    console.log(`📊 解析結果: ${dryRunRes.result.scheduledEvents}イベント, ${dryRunRes.result.totalDurationMs}ms`);

    // IACで再生
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { 
        name: 'play_smf', 
        arguments: { 
          fileId: smfBody.fileId, 
          portName: 'IAC'
        } 
      } 
    });
    const playRes = await readLine(child);
    if (playRes.error) throw new Error('play failed');
    
    console.log(`🎵 修正版再生開始: ${playRes.result.playbackId}`);
    console.log('🎹 和音が正しく4拍分鳴るはずです！');

    // 10秒後に停止
    setTimeout(async () => {
      sendLine(child, { 
        jsonrpc: '2.0', 
        id: id++, 
        method: 'tools/call', 
        params: { 
          name: 'stop_playback', 
          arguments: { 
            playbackId: playRes.result.playbackId
          } 
        } 
      });
      try {
        await readLine(child);
        console.log('⏹️ 再生停止');
      } catch (e) {}
      child.kill();
      console.log('🏁 テスト完了');
    }, 10000);

  } catch (e) {
    console.error('❌ エラー:', e?.message || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

main();