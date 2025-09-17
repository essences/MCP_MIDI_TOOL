import pkg from '@tonejs/midi';
const { Midi } = pkg;
import fs from 'fs';
import path from 'path';

console.log('🔍 @tonejs/midi チャンネル動作検証テスト');

// チャンネル指定の動作確認
const midi = new Midi();
const track = midi.addTrack();

// CC64をチャンネル1で明示的に追加
console.log('Adding CC64 events with explicit channel 1...');
track.addCC({ 
  number: 64, 
  value: 127, 
  time: 0, 
  channel: 1 
});
track.addCC({ 
  number: 64, 
  value: 0, 
  time: 1.0, 
  channel: 1 
});

// 追加したCCイベントの確認
console.log('\n📋 Added CC events:');
if (track.controlChanges && track.controlChanges[64]) {
  track.controlChanges[64].forEach((cc, index) => {
    console.log(`  CC64[${index}]: time=${cc.time}s, value=${cc.value}, channel=${cc.channel}`);
  });
} else {
  console.log('  ❌ No CC64 events found in track.controlChanges[64]');
}

// 全CCイベントの確認
console.log('\n📋 All control changes:');
Object.keys(track.controlChanges || {}).forEach(ccNumber => {
  console.log(`  CC${ccNumber}: ${track.controlChanges[ccNumber].length} events`);
});

// ファイル保存
const outputPath = path.join('./data/export', 'tonejs_channel_debug.mid');
fs.writeFileSync(outputPath, Buffer.from(midi.toArray()));
console.log(`\n💾 Debug file saved: ${outputPath}`);

// バイナリ内容を即座に確認
console.log('\n🔍 Binary content check:');
const savedData = fs.readFileSync(outputPath);
const hexString = savedData.toString('hex');
console.log('File size:', savedData.length, 'bytes');
console.log('Hex (first 200 chars):', hexString.substring(0, 200));

// CC64パターンを検索
const cc64OnPattern = 'b14001';  // B1 40 7F (ch1, cc64, val127)
const cc64OffPattern = 'b14000'; // B1 40 00 (ch1, cc64, val0)
console.log(`\nSearching for CC64 patterns:`);
console.log(`  b1407f (ch1 cc64 val127): ${hexString.includes('b1407f') ? '✅ Found' : '❌ Not found'}`);
console.log(`  b14000 (ch1 cc64 val0):   ${hexString.includes('b14000') ? '✅ Found' : '❌ Not found'}`);
console.log(`  b0407f (ch0 cc64 val127): ${hexString.includes('b0407f') ? '✅ Found' : '❌ Not found'}`);
console.log(`  b04000 (ch0 cc64 val0):   ${hexString.includes('b04000') ? '✅ Found' : '❌ Not found'}`);

console.log('\n🎯 Conclusion: Check if @tonejs/midi respects channel parameter for CC events');