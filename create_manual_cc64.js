import { writeFileSync } from 'fs';

// テスト用シンプルなMIDIファイルを手動作成
// CC64 ON/OFFの明確なパターンを持つ最小構成

const midiData = new Uint8Array([
  // MIDI Header chunk
  0x4D, 0x54, 0x68, 0x64,  // "MThd"
  0x00, 0x00, 0x00, 0x06,  // Header length: 6
  0x00, 0x00,              // Format type: 0
  0x00, 0x01,              // Number of tracks: 1
  0x01, 0xE0,              // Division: 480 ticks per quarter note

  // Track chunk
  0x4D, 0x54, 0x72, 0x6B,  // "MTrk"
  0x00, 0x00, 0x00, 0x22,  // Track length: 34 bytes

  // Track events
  0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,  // Tempo: 120 BPM
  
  0x00, 0xB0, 0x40, 0x7F,  // Delta 0, CC64 ON (127) ch0
  0x81, 0xE0, 0xB0, 0x40, 0x00,  // Delta 480, CC64 OFF (0) ch0
  
  0x00, 0xB1, 0x40, 0x7F,  // Delta 0, CC64 ON (127) ch1
  0x81, 0xE0, 0xB1, 0x40, 0x00,  // Delta 480, CC64 OFF (0) ch1
  
  0x00, 0xFF, 0x2F, 0x00   // End of track
]);

writeFileSync('data/export/manual_cc64_test.mid', midiData);

console.log('✅ 手動MIDI作成完了: manual_cc64_test.mid');
console.log('📋 含まれているCC64イベント:');
console.log('  - チャンネル0: CC64 ON (127) → OFF (0)');
console.log('  - チャンネル1: CC64 ON (127) → OFF (0)');
console.log('');
console.log('🔍 16進確認:');

const hex = Array.from(midiData).map(b => b.toString(16).padStart(2, '0')).join('');
console.log(`b0407f: ${hex.includes('b0407f') ? '✅' : '❌'}`);
console.log(`b04000: ${hex.includes('b04000') ? '✅' : '❌'}`);
console.log(`b1407f: ${hex.includes('b1407f') ? '✅' : '❌'}`);
console.log(`b14000: ${hex.includes('b14000') ? '✅' : '❌'}`);