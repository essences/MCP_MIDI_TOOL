# 8秒継続コード進行SMF（正しいVLQとトラック長）

目的: 120 BPM / PPQ=480 で各コード2秒（= 1920 tick）×4コード = 8秒のType-0 SMFを生成します。
- 2秒の計算: 1四分音符=0.5秒（120BPM）。PPQ=480 → 1秒=960tick。2秒=1920tick。
- VLQ(可変長数量)の例: 1920dec → 0x0780 → VLQ [0x8F, 0x00]
- MTrk長は4バイトBEで正しく書き込みます。

以下を Claude の code-interpreter に貼り付けて実行し、出力の base64 を mcp-midi-tool の store_midi に渡してください。

```js
// 正しいVLQとMTrk長で 8秒（C-F-G-C）を作る
function vlq(n){
  // 可変長数量（SMF仕様）
  const stack = [];
  do { stack.push(n & 0x7f); n >>= 7; } while (n > 0);
  const out = new Uint8Array(stack.length);
  for (let i = 0; i < stack.length; i++) {
    out[i] = stack[stack.length - 1 - i] | (i < stack.length - 1 ? 0x80 : 0);
  }
  return out;
}

function be32(n){ return new Uint8Array([ (n>>>24)&0xFF, (n>>>16)&0xFF, (n>>>8)&0xFF, n&0xFF ]); }

function concat(arrs){
  const len = arrs.reduce((s,a)=>s+a.length,0);
  const r = new Uint8Array(len);
  let o=0; for (const a of arrs){ r.set(a,o); o+=a.length; }
  return r;
}

function make8sChords() {
  const header = new Uint8Array([
    0x4D,0x54,0x68,0x64,  // MThd
    0x00,0x00,0x00,0x06,  // header length
    0x00,0x00,            // type 0
    0x00,0x01,            // tracks=1
    0x01,0xE0             // division=480
  ]);

  const ev = [];
  // tempo 120 BPM (500000 usec/quarter)
  ev.push(new Uint8Array([0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]));

  const CH = 0x00; // ch1
  const on  = (dt, note, vel=0x64) => concat([vlq(dt), new Uint8Array([0x90|CH, note, vel])]);
  const off = (dt, note)           => concat([vlq(dt), new Uint8Array([0x80|CH, note, 0x00])]);

  const TWO_SEC = 1920; // ticks at 120BPM, PPQ=480

  // C major (C4,E4,G4)
  ev.push(on(0, 0x3C)); ev.push(on(0, 0x40)); ev.push(on(0, 0x43));
  ev.push(off(TWO_SEC, 0x3C)); ev.push(off(0, 0x40)); ev.push(off(0, 0x43));

  // F major (F4,A4,C4)
  ev.push(on(0, 0x3D)); ev.push(on(0, 0x41)); ev.push(on(0, 0x3C));
  ev.push(off(TWO_SEC, 0x3D)); ev.push(off(0, 0x41)); ev.push(off(0, 0x3C));

  // G major (G4,B4,D4)
  ev.push(on(0, 0x43)); ev.push(on(0, 0x47)); ev.push(on(0, 0x3E));
  ev.push(off(TWO_SEC, 0x43)); ev.push(off(0, 0x47)); ev.push(off(0, 0x3E));

  // C major (C4,E4,G4)
  ev.push(on(0, 0x3C)); ev.push(on(0, 0x40)); ev.push(on(0, 0x43));
  ev.push(off(TWO_SEC, 0x3C)); ev.push(off(0, 0x40)); ev.push(off(0, 0x43));

  // EOT
  ev.push(new Uint8Array([0x00, 0xFF, 0x2F, 0x00]));

  const trackData = concat(ev);
  const trackHeader = concat([
    new Uint8Array([0x4D,0x54,0x72,0x6B]),
    be32(trackData.length)
  ]);

  const midi = concat([header, trackHeader, trackData]);
  const b64 = Buffer.from(midi).toString('base64');
  return { bytes: midi.length, trackLen: trackData.length, base64: b64 };
}

const r = make8sChords();
console.log('bytes=', r.bytes, 'trackLen=', r.trackLen);
console.log('\n=== TEST MIDI BASE64 ===\n' + r.base64 + '\n=== END ===');
```

使い方（Claude経由の最短手順）:
1) code-interpreter で上記を実行 → base64 を取得
2) mcp-midi-tool: `store_midi { name: "continuous_8s.mid", base64 }`
3) `play_smf { fileId, dryRun:true }` → `totalDurationMs ≈ 8000` を確認
4) `play_smf { fileId, portName:"IAC" }` → 実再生
5) 必要に応じて `get_playback_status { playbackId }` → 進捗確認
6) `stop_playback { playbackId }` で停止
