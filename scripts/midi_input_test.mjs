#!/usr/bin/env node
// MIDI入力テスト: キャプチャした音をすぐに再生
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

// MIDI番号を音名に変換
function midiToNote(midi) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;
  return noteNames[noteIndex] + octave;
}

async function main() {
  const child = spawnServer();
  let id = 1;
  
  try {
    console.log('🎹 MIDI入力テスト開始');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // initialize
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'initialize', 
      params: { 
        protocolVersion: '2025-06-18', 
        capabilities: {}, 
        clientInfo: { name: 'midi-input-test', version: '1.0.0' } 
      } 
    });
    const initRes = await readLine(child);
    if (initRes.error) throw new Error('initialize failed');

    // MIDI入力デバイス一覧取得
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { name: 'list_input_devices', arguments: {} } 
    });
    const inputDevicesRes = await readLine(child);
    if (inputDevicesRes.error) throw new Error('list_input_devices failed');
    
    const inputDevicesBody = JSON.parse(inputDevicesRes.result.content[0].text);
    console.log('📱 利用可能なMIDI入力デバイス:');
    inputDevicesBody.devices.forEach((device, i) => {
      console.log(`  ${i}: ${device.name}`);
    });

    // KeyLabを優先的に選択
    const inputDevice = inputDevicesBody.devices.find(d => 
      d.name.includes('KeyLab')
    ) || inputDevicesBody.devices.find(d => 
      d.name.includes('MIDI') || d.name.includes('IAC')
    ) || inputDevicesBody.devices[0];
    
    if (!inputDevice) {
      console.log('❌ MIDI入力デバイスが見つかりません');
      child.kill();
      return;
    }
    
    console.log(`🎹 入力デバイス: ${inputDevice.name}`);

    // MIDI出力デバイス一覧取得  
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'tools/call', 
      params: { name: 'list_devices', arguments: {} } 
    });
    const outputDevicesRes = await readLine(child);
    const outputDevicesBody = JSON.parse(outputDevicesRes.result.content[0].text);
    
    const outputDevice = outputDevicesBody.devices.find(d => d.name.includes('IAC')) || outputDevicesBody.devices[0];
    console.log(`🔊 出力デバイス: ${outputDevice?.name || 'なし'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let testCount = 0;
    const maxTests = 10;

    console.log('🎵 MIDI入力→即座再生テスト');
    console.log(`MIDIキーボードで音を弾いてください（${maxTests}回まで、Ctrl+Cで終了）\n`);

    while (testCount < maxTests) {
      testCount++;
      console.log(`🎯 テスト ${testCount}/${maxTests}:`);
      console.log('⏳ MIDIキーボードで何か弾いてください...');
      
      // single capture開始
      sendLine(child, { 
        jsonrpc: '2.0', 
        id: id++, 
        method: 'tools/call', 
        params: { 
          name: 'start_device_single_capture', 
          arguments: { 
            portName: inputDevice.name,
            onsetWindowMs: 150,  // 和音受付時間を少し長く
            silenceMs: 300,      // 無音確定時間を少し長く
            maxWaitMs: 10000     // 10秒待機
          } 
        } 
      });
      const captureStartRes = await readLine(child);
      if (captureStartRes.error) {
        console.log('❌ キャプチャ開始エラー:', captureStartRes.error);
        continue;
      }
      
      const captureBody = JSON.parse(captureStartRes.result.content[0].text);
      const captureId = captureBody.captureId;
      
      // ポーリングで結果待ち
      let captured = false;
      let attempts = 0;
      const maxAttempts = 50; // 10秒 / 200ms
      
      while (!captured && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 200));
        attempts++;
        
        sendLine(child, { 
          jsonrpc: '2.0', 
          id: id++, 
          method: 'tools/call', 
          params: { 
            name: 'get_single_capture_status', 
            arguments: { captureId } 
          } 
        });
        
        const statusRes = await readLine(child);
        if (statusRes.result?.ok) {
          const statusBody = JSON.parse(statusRes.result.content[0].text);
          if (statusBody.done) {
            captured = true;
            
            if (statusBody.reason === 'completed' && statusBody.result) {
              const { notes: capturedNotes, velocities, durationMs, isChord } = statusBody.result;
              const capturedNoteNames = capturedNotes.map(midiToNote);
              
              console.log(`📝 キャプチャ結果: ${capturedNoteNames.join(', ')} ${isChord ? '(和音)' : '(単音)'}`);
              console.log(`   ベロシティ: ${velocities.join(', ')}, 持続: ${durationMs}ms`);
              
              // 即座に同じ音を再生
              console.log('🎼 キャプチャした音を再生します...');
              sendLine(child, { 
                jsonrpc: '2.0', 
                id: id++, 
                method: 'tools/call', 
                params: { 
                  name: 'trigger_notes', 
                  arguments: { 
                    notes: capturedNotes,  // MIDI番号そのまま使用
                    velocity: Math.max(...velocities),  // 最大ベロシティを使用
                    durationMs: Math.min(Math.max(durationMs, 500), 2000),  // 0.5-2秒に制限
                    channel: 1,
                    portName: outputDevice?.name
                  } 
                } 
              });
              
              const playRes = await readLine(child);
              if (playRes.result?.ok) {
                const playBody = JSON.parse(playRes.result.content[0].text);
                console.log(`✅ 再生完了: ${playBody.scheduledNotes}音符, ${playBody.durationMs}ms`);
              } else {
                console.log('❌ 再生エラー:', playRes.error || playRes.result);
              }
              
            } else if (statusBody.reason === 'timeout') {
              console.log('⏰ タイムアウト - 入力がありませんでした');
            } else {
              console.log(`⚠️ キャプチャ終了: ${statusBody.reason}`);
            }
            break;
          } else {
            // キャプチャ進行中
            if (attempts % 5 === 0) process.stdout.write('.');
          }
        }
      }
      
      if (!captured) {
        console.log('\n⏰ 最大待機時間終了');
      }
      
      console.log(''); // 改行
    }
    
    console.log('🏁 MIDI入力テスト終了');
    child.kill();
    
  } catch (e) {
    console.error('❌ エラー:', e?.message || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

// Ctrl+C graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 テストを終了します...');
  process.exit(0);
});

main();