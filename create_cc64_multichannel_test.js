import pkg from '@tonejs/midi';
const { Midi } = pkg;
import fs from 'fs';
import path from 'path';

console.log('Creating multi-channel CC64 test file...');

// テスト用のMIDIファイルを作成
const midi = new Midi();

// トラックを追加
const track = midi.addTrack();

// 楽器音（複数チャンネル）
const notes = [
  { midi: 60, time: 0, duration: 0.5, channel: 0 },
  { midi: 64, time: 0.5, duration: 0.5, channel: 0 },
  { midi: 67, time: 1.0, duration: 0.5, channel: 0 },
  { midi: 72, time: 1.5, duration: 0.5, channel: 0 }
];

notes.forEach(note => {
  track.addNote(note);
});

// 複数チャンネルにCC64を送信（0-15チャンネル）
for (let ch = 0; ch < 16; ch++) {
  // 開始時にON（value=127）
  track.addCC({
    number: 64,
    value: 127,
    time: 0,
    channel: ch
  });

  // 終了時にOFF（value=0）
  track.addCC({
    number: 64,
    value: 0,
    time: 2.0,
    channel: ch
  });
}

// ファイルに保存
const outputDir = './data/export';
const outputPath = path.join(outputDir, 'cc64_multichannel_test.mid');
fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));

console.log(`Multi-channel CC64 test file created: ${outputPath}`);
console.log('- Notes on channel 0');
console.log('- CC64 Sustain events on ALL channels (0-15)');
console.log('- This ensures DAW will receive CC64 regardless of channel routing');