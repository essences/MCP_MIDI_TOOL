#!/usr/bin/env node
// 聴音トレーニングデモ: trigger_notes + single_capture_device を使用
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

// 問題パターン定義
const PROBLEMS = [
  { 
    name: "単音問題: C4", 
    notes: ["C4"], 
    type: "single_note" 
  },
  { 
    name: "単音問題: F#4", 
    notes: ["F#4"], 
    type: "single_note" 
  },
  { 
    name: "和音問題: C-E-G (Cメジャー)", 
    notes: ["C4", "E4", "G4"], 
    type: "chord" 
  },
  { 
    name: "和音問題: F-A-C (Fメジャー)", 
    notes: ["F4", "A4", "C5"], 
    type: "chord" 
  },
  { 
    name: "和音問題: D-F#-A (Dメジャー)", 
    notes: ["D4", "F#4", "A4"], 
    type: "chord" 
  }
];

// 音名をMIDI番号に変換
function noteToMidi(noteName) {
  const noteMap = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 
    'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11
  };
  
  const match = noteName.match(/^([A-G][#b]?)(\d+)$/);
  if (!match) return null;
  
  const [, note, octave] = match;
  const noteNum = noteMap[note];
  if (noteNum === undefined) return null;
  
  return noteNum + (parseInt(octave) + 1) * 12;
}

// MIDI番号を音名に変換
function midiToNote(midi) {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;
  return noteNames[noteIndex] + octave;
}

// 音符配列を正規化（ソート）
function normalizeNotes(notes) {
  return notes.slice().sort((a, b) => a - b);
}

async function main() {
  const child = spawnServer();
  let id = 1;
  
  try {
    console.log('🎵 聴音トレーニングデモ開始');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // initialize
    sendLine(child, { 
      jsonrpc: '2.0', 
      id: id++, 
      method: 'initialize', 
      params: { 
        protocolVersion: '2025-06-18', 
        capabilities: {}, 
        clientInfo: { name: 'ear-training', version: '1.0.0' } 
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

    const inputDevice = inputDevicesBody.devices.find(d => 
      d.name.includes('KeyLab') || d.name.includes('IAC') || d.name.includes('MIDI')
    ) || inputDevicesBody.devices[0];
    
    if (!inputDevice) {
      console.log('❌ MIDI入力デバイスが見つかりません');
      child.kill();
      return;
    }
    
    console.log(`🎹 入力デバイス: ${inputDevice.name}\n`);

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
    console.log(`🔊 出力デバイス: ${outputDevice?.name || 'なし'}\n`);

    // 問題を順番に出題
    let correctCount = 0;
    let totalCount = 0;

    for (let i = 0; i < PROBLEMS.length; i++) {
      const problem = PROBLEMS[i];
      totalCount++;
      
      console.log(`\n📝 問題 ${i + 1}/${PROBLEMS.length}: ${problem.name}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━');
      
      // 問題音をtrigger_notesで再生
      console.log('🎼 問題音を再生します...');
      sendLine(child, { 
        jsonrpc: '2.0', 
        id: id++, 
        method: 'tools/call', 
        params: { 
          name: 'trigger_notes', 
          arguments: { 
            notes: problem.notes,
            velocity: 100,
            durationMs: problem.type === 'chord' ? 2000 : 1000,
            channel: 1,
            portName: outputDevice?.name
          } 
        } 
      });
      await readLine(child);
      
      // 回答待ち
      console.log('⏰ 聞こえた音をMIDIキーボードで弾いてください（5秒以内）');
      
      // single capture開始
      sendLine(child, { 
        jsonrpc: '2.0', 
        id: id++, 
        method: 'tools/call', 
        params: { 
          name: 'start_device_single_capture', 
          arguments: { 
            portName: inputDevice.name,
            onsetWindowMs: 100, // 和音受付時間窓
            silenceMs: 200,     // 無音確定時間
            maxWaitMs: 5000     // 最大待機時間
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
      console.log(`🎤 キャプチャ開始: ${captureId}`);
      
      // ポーリングで結果待ち
      let captured = false;
      let attempts = 0;
      const maxAttempts = 25; // 5秒 / 200ms
      
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
            
            console.log(`📊 キャプチャ完了: ${statusBody.reason}`);
            
            if (statusBody.reason === 'completed' && statusBody.result) {
              const { notes: capturedNotes, isChord } = statusBody.result;
              const capturedNoteNames = capturedNotes.map(midiToNote);
              
              console.log(`🎹 あなたの回答: ${capturedNoteNames.join(', ')} ${isChord ? '(和音)' : '(単音)'}`);
              
              // 正答チェック
              const correctMidi = problem.notes.map(noteToMidi).filter(n => n !== null);
              const normalizedCorrect = normalizeNotes(correctMidi);
              const normalizedAnswer = normalizeNotes(capturedNotes);
              
              const isCorrect = normalizedCorrect.length === normalizedAnswer.length && 
                normalizedCorrect.every((note, idx) => note === normalizedAnswer[idx]);
              
              if (isCorrect) {
                console.log('✅ 正解！');
                correctCount++;
              } else {
                console.log('❌ 不正解');
                console.log(`💡 正解: ${problem.notes.join(', ')}`);
              }
            } else if (statusBody.reason === 'timeout') {
              console.log('⏰ タイムアウト - 回答なし');
              console.log(`💡 正解: ${problem.notes.join(', ')}`);
            }
            break;
          } else {
            process.stdout.write('.');
          }
        }
      }
      
      if (!captured) {
        console.log('\n⏰ 回答時間終了');
        console.log(`💡 正解: ${problem.notes.join(', ')}`);
      }
    }
    
    // 最終結果
    console.log('\n🏆 聴音トレーニング結果');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`正解数: ${correctCount} / ${totalCount}`);
    console.log(`正答率: ${Math.round((correctCount / totalCount) * 100)}%`);
    
    if (correctCount === totalCount) {
      console.log('🎉 パーフェクト！素晴らしい聴音能力です！');
    } else if (correctCount >= totalCount * 0.8) {
      console.log('👏 とても良い成績です！');
    } else if (correctCount >= totalCount * 0.6) {
      console.log('👍 まずまずの成績です。練習を続けましょう！');
    } else {
      console.log('💪 練習あるのみ！継続して聴音力を鍛えましょう！');
    }
    
    child.kill();
    console.log('\n🏁 聴音トレーニング終了');
    
  } catch (e) {
    console.error('❌ エラー:', e?.message || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

main();