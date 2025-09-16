import pkg from '@tonejs/midi';
const { Midi } = pkg;
import fs from 'fs';
import path from 'path';

console.log('Creating CC64 specification verification test files...');

// テスト1: 異なるCC64値でのテスト（閾値64を使用）
function createThresholdTest() {
  const midi = new Midi();
  const track = midi.addTrack();
  
  // ノート
  track.addNote({ midi: 60, time: 0, duration: 0.5, channel: 0 });
  track.addNote({ midi: 64, time: 0.5, duration: 0.5, channel: 0 });
  track.addNote({ midi: 67, time: 1.0, duration: 0.5, channel: 0 });
  
  // CC64: 閾値64を使用（MIDI仕様では64以上がON）
  track.addCC({ number: 64, value: 64, time: 0, channel: 0 });  // 閾値ギリギリでON
  track.addCC({ number: 64, value: 0, time: 2.0, channel: 0 }); // OFF
  
  const outputPath = path.join('./data/export', 'cc64_threshold_test.mid');
  fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));
  console.log(`- Threshold test: ${outputPath} (CC64 value=64 for ON)`);
}

// テスト2: チャンネル1（内部値1）でのテスト
function createChannelTest() {
  const midi = new Midi();
  const track = midi.addTrack();
  
  // ノート（チャンネル1）
  track.addNote({ midi: 60, time: 0, duration: 0.5, channel: 1 });
  track.addNote({ midi: 64, time: 0.5, duration: 0.5, channel: 1 });
  track.addNote({ midi: 67, time: 1.0, duration: 0.5, channel: 1 });
  
  // CC64（チャンネル1）
  track.addCC({ number: 64, value: 127, time: 0, channel: 1 });
  track.addCC({ number: 64, value: 0, time: 2.0, channel: 1 });
  
  const outputPath = path.join('./data/export', 'cc64_channel1_test.mid');
  fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));
  console.log(`- Channel 1 test: ${outputPath} (Using MIDI channel 1 instead of 0)`);
}

// テスト3: 複数のCC64値パターン
function createValuePatternTest() {
  const midi = new Midi();
  const track = midi.addTrack();
  
  // 長いノート
  track.addNote({ midi: 60, time: 0, duration: 3.0, channel: 0 });
  
  // CC64値のパターンテスト
  track.addCC({ number: 64, value: 127, time: 0, channel: 0 });   // 最大値でON
  track.addCC({ number: 64, value: 100, time: 0.5, channel: 0 }); // 高値でON継続
  track.addCC({ number: 64, value: 64, time: 1.0, channel: 0 });  // 閾値でON
  track.addCC({ number: 64, value: 63, time: 1.5, channel: 0 });  // 閾値未満でOFF
  track.addCC({ number: 64, value: 0, time: 2.0, channel: 0 });   // 完全にOFF
  
  const outputPath = path.join('./data/export', 'cc64_value_pattern_test.mid');
  fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));
  console.log(`- Value pattern test: ${outputPath} (127→100→64→63→0)`);
}

// テスト4: 同一トラック内での順序テスト
function createOrderingTest() {
  const midi = new Midi();
  const track = midi.addTrack();
  
  // CC64を先に送信してから音符
  track.addCC({ number: 64, value: 127, time: 0, channel: 0 });
  track.addNote({ midi: 60, time: 0.001, duration: 0.5, channel: 0 });
  track.addNote({ midi: 64, time: 0.5, duration: 0.5, channel: 0 });
  track.addNote({ midi: 67, time: 1.0, duration: 0.5, channel: 0 });
  track.addCC({ number: 64, value: 0, time: 1.999, channel: 0 }); // ノート終了直前
  
  const outputPath = path.join('./data/export', 'cc64_ordering_test.mid');
  fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));
  console.log(`- Ordering test: ${outputPath} (CC64 before/after notes)`);
}

// 全テスト実行
createThresholdTest();
createChannelTest();
createValuePatternTest();
createOrderingTest();

console.log('\n✅ CC64 specification verification test files created');
console.log('📋 Test these files in your DAW:');
console.log('   1. cc64_threshold_test.mid   - Tests CC64 value=64 (threshold)');
console.log('   2. cc64_channel1_test.mid    - Tests MIDI channel 1 instead of 0');  
console.log('   3. cc64_value_pattern_test.mid - Tests various CC64 values');
console.log('   4. cc64_ordering_test.mid    - Tests CC64 timing vs notes');
console.log('\n🎯 If any of these work, we can identify the specific issue!');