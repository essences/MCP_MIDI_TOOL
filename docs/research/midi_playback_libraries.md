# Node/TypeScript向け MIDI 再生ライブラリ調査（SMF再生/スケジューリング/デバイス出力）

更新日: 2025-08-16

## 目的
- SMF（Standard MIDI File）を正しいタイミングで再生し、CoreMIDI等の実デバイスへ出力できるライブラリ/構成を選定する。

## 候補と評価

### 1) node-midi（npm: `midi`）
- URL: https://www.npmjs.com/package/midi / https://github.com/justinlatimer/node-midi
- 概要: RtMidiラッパー。CoreMIDI/Windows/MME/ALSA対応。実機I/Oの事実上の標準。
- 長所: 実デバイス出力が安定。導入実績多数。
- 短所: SMFパース/再生ロジックは別途実装が必要。ネイティブビルド。
- 適合: ◎（本プロジェクトの list_devices/playback_midi の方針と一致）

### 2) easymidi（npm: `easymidi`）
- URL: https://github.com/dinchak/node-easymidi
- 概要: `midi` を包む薄いイベントAPI。
- 長所: APIが簡潔。
- 短所: メンテ頻度や型定義は要確認。結局SMF/スケジューラは別途。
- 適合: ○

### 3) coremidi（npm: `coremidi`）
- URL: https://www.npmjs.com/package/coremidi
- 概要: macOS専用CoreMIDIバインディング（ストリーム）。
- 長所: macOSに特化。
- 短所: クロスプラットフォーム性に欠ける。情報少なめ。
- 適合: △（mac専用で良ければ選択肢）

### 4) JZZ + jzz-midi-smf
- URL: https://github.com/jazz-soft/JZZ / https://www.npmjs.com/package/jzz-midi-smf
- 概要: Node/ブラウザ横断のMIDI基盤。`jzz-midi-smf` はSMFのread/write/playを提供。
- 長所: SMF再生を内包（プレイヤー実装のショートカット）。
- 短所: Nodeでのハードウェア出力は環境/プラグイン依存となる場合あり（要検証）。
- 適合: ○（早期にSMF再生を得たい場合の候補）

### 5) midi-player-js（npm: `midi-player-js`）
- URL: https://www.npmjs.com/package/midi-player-js
- 概要: ブラウザ/Node対応のMIDIパーサ&プレイヤー（コールバックでノートイベント）
- 長所: かんたんにイベント駆動で再生ロジックが得られる。
- 短所: 実デバイス出力へは `midi` 等と接続する実装が必要。メンテ頻度は低め。
- 適合: ○

### 6) @tonejs/midi（npm: `@tonejs/midi`）
- URL: https://www.npmjs.com/package/@tonejs/midi / https://github.com/Tonejs/Midi
- 概要: SMF→JSONパーサ。プレイヤー機能は持たない。
- 長所: TypeScriptで扱いやすい。構造が分かりやすい。
- 短所: スケジューラは自作が必要。
- 適合: ◎（TDDで自前スケジューラを作る方針と相性良）

### 7) midi-file（npm: `midi-file`）
- URL: https://www.npmjs.com/package/midi-file
- 概要: SMFの低レベルparse/write。
- 長所: 依存が軽い。自前実装に向く。
- 短所: 高レベルAPIはない。
- 適合: ○

### 8) MIDIVal
- URL: https://midival.github.io/
- 概要: TSの高レベルMIDI API。Web/Node/ReactNative横断をうたう。
- 長所: APIがモダン。
- 短所: Nodeでのハードウェア出力の安定性/要件適合は要検証。
- 適合: △

## 推奨スタック（2案）
- 案A（制御優先・堅実）: `midi` + `@tonejs/midi` + 自作ルックアヘッドスケジューラ
  - 既存コード（list_devices / playback_midi）の延長で自然に統合可能
  - TDDで時間変換/テンポ変化/停止処理を段階実装
- 案B（実装短縮）: `JZZ` + `jzz-midi-smf`
  - SMFのread/playを活用して早期に再生到達
  - NodeでのCoreMIDI出力が確実か要事前検証

## 次の一手
1) 案Aでユニットテスト雛形作成（固定テンポ1トラックのtick→ms変換と送出順序の検証）
2) `@tonejs/midi` を使い、fileId→SMF→イベント列→tMs付与の関数を実装
3) 既存の `playback_midi` を `play_smf`（仮）に拡張 or 新ツール追加
4) 途中でJZZ系の実機出力可否もPoC比較

## インストール例（案A）
```bash
npm i midi @tonejs/midi
```

