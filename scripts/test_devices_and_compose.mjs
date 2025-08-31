#!/usr/bin/env node
// MCP MIDI Tool で楽曲作曲・再生テスト
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

// Score DSLで簡単な4小節のメロディーを作成
function createSimpleMelody() {
  return {
    ppq: 480,
    meta: {
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { root: "C", mode: "major" },
      tempo: { bpm: 120 }
    },
    tracks: [
      { 
        channel: 1, // ch1 (ピアノ)
        program: 0, // acoustic piano
        events: [
          // 1小節目: ド・レ・ミ・ファ
          { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" }, velocity: 100 },
          { type: "note", note: "D4", start: { bar: 1, beat: 2 }, duration: { value: "1/4" }, velocity: 95 },
          { type: "note", note: "E4", start: { bar: 1, beat: 3 }, duration: { value: "1/4" }, velocity: 90 },
          { type: "note", note: "F4", start: { bar: 1, beat: 4 }, duration: { value: "1/4" }, velocity: 95 },
          
          // 2小節目: ソ・ファ・ミ・レ
          { type: "note", note: "G4", start: { bar: 2, beat: 1 }, duration: { value: "1/4" }, velocity: 100 },
          { type: "note", note: "F4", start: { bar: 2, beat: 2 }, duration: { value: "1/4" }, velocity: 95 },
          { type: "note", note: "E4", start: { bar: 2, beat: 3 }, duration: { value: "1/4" }, velocity: 90 },
          { type: "note", note: "D4", start: { bar: 2, beat: 4 }, duration: { value: "1/4" }, velocity: 95 },
          
          // 3小節目: ド・ミ・ソの和音（全音符）
          { type: "note", note: "C4", start: { bar: 3, beat: 1 }, duration: { value: "1" }, velocity: 100 },
          { type: "note", note: "E4", start: { bar: 3, beat: 1 }, duration: { value: "1" }, velocity: 100 },
          { type: "note", note: "G4", start: { bar: 3, beat: 1 }, duration: { value: "1" }, velocity: 100 },
          
          // 4小節目: ド（全音符）
          { type: "note", note: "C4", start: { bar: 4, beat: 1 }, duration: { value: "1" }, velocity: 110 }
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
        clientInfo: { name: 'composer-test', version: '1.0.0' } 
      } 
    });
    const initRes = await readLine(child);
    if (initRes.error) throw new Error('initialize failed: ' + JSON.stringify(initRes.error));
    console.log('✅ MCP MIDI Tool に接続しました');

    // list_devices - MIDI出力デバイス一覧を取得
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { name: 'list_devices', arguments: {} } 
    });
    const devicesRes = await readLine(child);
    if (devicesRes.error) throw new Error('list_devices failed: ' + JSON.stringify(devicesRes.error));
    
    const devicesBody = JSON.parse(devicesRes.result.content[0].text);
    console.log('📱 利用可能なMIDI出力デバイス:');
    devicesBody.devices.forEach((device, i) => {
      console.log(`  ${i}: ${device.name}`);
    });
    
    // IACデバイスを探す
    const iacDevice = devicesBody.devices.find(d => d.name.includes('IAC'));
    const targetDevice = iacDevice ? iacDevice.name : devicesBody.devices[0]?.name;
    console.log(`🎹 使用デバイス: ${targetDevice || 'なし'}`);

    // Score DSLで楽曲を作成してSMFに変換
    const melody = createSimpleMelody();
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { 
        name: 'json_to_smf', 
        arguments: { 
          json: melody, 
          format: 'score_dsl_v1',
          name: 'simple-melody.mid', 
          overwrite: true 
        } 
      } 
    });
    const smfRes = await readLine(child);
    if (smfRes.error) throw new Error('json_to_smf failed: ' + JSON.stringify(smfRes.error));
    
    const smfBody = JSON.parse(smfRes.result.content[0].text);
    console.log(`🎵 楽曲作成完了: ${smfBody.fileId}`);
    console.log(`   - サイズ: ${smfBody.bytes} bytes`);
    console.log(`   - トラック数: ${smfBody.trackCount}`);
    console.log(`   - イベント数: ${smfBody.eventCount}`);

    // dryRun で楽曲解析
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
    if (dryRunRes.error || !dryRunRes.result?.ok) {
      throw new Error('play_smf dryRun failed: ' + JSON.stringify(dryRunRes.error || dryRunRes.result));
    }
    
    console.log(`🔍 楽曲解析結果:`);
    console.log(`   - スケジュールイベント: ${dryRunRes.result.scheduledEvents}`);
    console.log(`   - 総演奏時間: ${dryRunRes.result.totalDurationMs}ms`);

    // 実際に再生（IAC経由）
    if (targetDevice) {
      sendLine(child, { 
        jsonrpc: '2.0', 
        id: id++, 
        method: 'tools/call', 
        params: { 
          name: 'play_smf', 
          arguments: { 
            fileId: smfBody.fileId, 
            portName: targetDevice,
            schedulerLookaheadMs: 100,
            schedulerTickMs: 10
          } 
        } 
      });
      const playRes = await readLine(child);
      if (playRes.error || !playRes.result?.ok) {
        throw new Error('play_smf failed: ' + JSON.stringify(playRes.error || playRes.result));
      }
      
      console.log(`🎼 再生開始: playbackId = ${playRes.result.playbackId}`);
      console.log(`   デバイス: ${targetDevice}`);
      console.log(`   チャンネル: 1 (ピアノ)`);
      
      // 2秒待って進捗確認
      setTimeout(async () => {
        sendLine(child, { 
          jsonrpc: '2.0', 
          id: id++, 
          method: 'tools/call', 
          params: { 
            name: 'get_playback_status', 
            arguments: { 
              playbackId: playRes.result.playbackId
            } 
          } 
        });
        try {
          const statusRes = await readLine(child);
          if (!statusRes.error && statusRes.result?.ok) {
            console.log(`📊 再生進捗:`, statusRes.result);
          }
        } catch (e) {
          console.log('進捗確認エラー:', e.message);
        }
      }, 2000);
      
      // 8秒後に停止
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
          const stopRes = await readLine(child);
          console.log(`⏹️ 再生停止:`, stopRes.result?.ok ? '成功' : '失敗');
        } catch (e) {
          console.log('停止エラー:', e.message);
        }
        
        child.kill();
        console.log('🏁 テスト完了');
      }, 8000);
      
    } else {
      console.log('❌ MIDI出力デバイスが見つかりませんでした');
      child.kill();
    }

  } catch (e) {
    console.error('❌ エラー:', e?.message || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

main();