import pkg from '@tonejs/midi';
const { Midi } = pkg;
import fs from 'fs';
import path from 'path';

console.log('Creating CC64 timing test file...');

// テスト用のMIDIファイルを作成
const midi = new Midi();

// トラックを追加
const track = midi.addTrack();

// 楽器音
track.addNote({
  midi: 60, // C4
  time: 0.1, // 少し遅らせて開始
  duration: 1.8 // 長めに
});

track.addNote({
  midi: 64, // E4
  time: 0.6,
  duration: 1.3
});

track.addNote({
  midi: 67, // G4
  time: 1.1,
  duration: 0.8
});

// サスティンペダル（CC64）を音符の前後に配置
// パターン1: 音符開始前にON
track.addCC({
  number: 64,
  value: 127,
  time: 0.05 // 最初の音符の50ms前
});

// パターン2: 音符終了後にOFF
track.addCC({
  number: 64,
  value: 0,
  time: 2.05 // 最後の音符終了後
});

// 追加テスト: ハーフペダル値
track.addCC({
  number: 64,
  value: 64, // ハーフペダル
  time: 2.1
});

track.addCC({
  number: 64,
  value: 0, // 完全にOFF
  time: 2.2
});

// ファイルに保存
const outputDir = './data/export';
const outputPath = path.join(outputDir, 'cc64_timing_test.mid');
fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));

console.log(`CC64 timing test file created: ${outputPath}`);
console.log('- CC64 ON before first note (0.05s)');
console.log('- CC64 OFF after last note (2.05s)');
console.log('- Additional half-pedal test at 2.1s (value=64)');
console.log('- Final OFF at 2.2s');