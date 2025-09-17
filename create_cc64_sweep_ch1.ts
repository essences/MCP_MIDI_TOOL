import { writeFileSync } from 'fs';

// CC64スイープ: Ch1で 0→127→0 と昇降する連続イベント
const events: number[] = [];

// Delta 0: Tempo 120bpm
events.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);

// Helper: write variable length delta-time for 30 ticks (短い間隔)
function dt30() { return [0x1e]; }

// 上昇 0→127
for (let v = 0; v <= 127; v++) {
  // delta 30 ticks
  events.push(...dt30(), 0xB1, 0x40, v);
}
// 降下 127→0
for (let v = 127; v >= 0; v--) {
  events.push(...dt30(), 0xB1, 0x40, v);
}

// EOT
events.push(0x00, 0xFF, 0x2F, 0x00);

// Track length
const trackLen = events.length;
const lenBytes = [ (trackLen>>>24)&0xFF, (trackLen>>>16)&0xFF, (trackLen>>>8)&0xFF, trackLen&0xFF ];

const header = [
  0x4D,0x54,0x68,0x64,  // MThd
  0x00,0x00,0x00,0x06,  // header length
  0x00,0x00,            // format 0
  0x00,0x01,            // one track
  0x01,0xE0             // ppq=480
];

const trackHeader = [
  0x4D,0x54,0x72,0x6B,  // MTrk
  ...lenBytes
];

const data = new Uint8Array([...header, ...trackHeader, ...events]);
writeFileSync('data/export/cc64_sweep_ch1.mid', data);

console.log('✅ 生成: data/export/cc64_sweep_ch1.mid');
console.log(`イベント数: 上昇128 + 下降128 + テンポ + EOT = ${128+128+2}`);
