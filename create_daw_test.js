import pkg from '@tonejs/midi';
const { Midi } = pkg;
import fs from 'fs';
import path from 'path';

// テスト用のMIDIファイルを作成
const midi = new Midi();

// トラックを追加
const track = midi.addTrack();

// 楽器音
track.addNote({
  midi: 60, // C4
  time: 0,
  duration: 0.5
});

track.addNote({
  midi: 64, // E4
  time: 0.5,
  duration: 0.5
});

track.addNote({
  midi: 67, // G4
  time: 1.0,
  duration: 0.5
});

track.addNote({
  midi: 72, // C5
  time: 1.5,
  duration: 0.5
});

// サスティンペダル（CC64）を手動で追加
// 開始時にON（value=127）
track.addCC({
  number: 64,
  value: 127,
  time: 0
});

// 終了時にOFF（value=0）
track.addCC({
  number: 64,
  value: 0,
  time: 2.0
});

// ファイルに保存
const outputDir = './data/export';
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, 'cc64_daw_test.mid');
fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));

console.log(`CC64 test file created: ${outputPath}`);
console.log('MIDI structure:');
console.log('- Notes: C4, E4, G4, C5 (quarter notes)');
console.log('- CC64 Sustain: ON at 0.0s, OFF at 2.0s');
console.log('- This file can be imported into your DAW for testing');

// より詳細な情報
console.log('\nCC64 events:');
track.controlChanges[64].forEach(cc => {
  console.log(`  - Time: ${cc.time}s, Value: ${cc.value}`);
});