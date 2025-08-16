# macOS 受信側セットアップ（CoreMIDI / IAC / DAW）

このドキュメントは、MCP MIDI TOOL の `playback_midi` が送信するノートを確実に受け取って鳴らすための受信側（DAW/音源）の設定手順です。

対象: macOS, CoreMIDI, Logic Pro / Digital Performer / 任意のDAW, IACドライバ

---

## 0. 事前確認
- macOS: システム環境設定 > オーディオMIDI設定 を起動
- MIDIスタジオを開く（ウィンドウ > MIDIスタジオを表示）
- IACドライバが表示されていること

## 1. IACドライバを有効化
1) IACドライバをダブルクリック
2) 「装置はオンライン」にチェック
3) 必要ならポートを追加（例: `IAC ドライバ Logic->DP`, `IAC ドライバ パス 2`）
4) 適用

ヒント: スクリーンショットのように複数ポートが作成可能。DAW間のルーティング名を分かりやすく付ける。

## 2. DAW側でMIDI入力を有効化
- Logic Pro:
  - 設定 > MIDI > 入力デバイス で、使用したい IAC ポートにチェック
  - トラックの入力を「すべて」または該当ポートに設定
- Digital Performer（DP）:
  - スタジオ設定で IAC ポートが入力として見えることを確認
  - トラックの入力を対象ポートにアサイン
- そのほかのDAW/音源（MainStage, GarageBand, VSTホスト等）でも同様に IAC を入力として有効化

## 3. node-midi（送信側）確認
- 本ツールは `node-midi` が存在すれば実デバイスへ送信します。未インストール時は擬似デバイス名を返すだけで送信しません。
- 送信確認:
  1) `list_devices` を実行し、`IAC` や実機ポート名が列挙されるか確認
  2) `playback_midi` 実行時に `portName` を部分一致指定（例: `IAC ドライバ バス 2` → `"IAC バス 2"` など）
  3) `durationMs` を 600–1200ms 程度に設定（短すぎると聞こえづらい）

## 4. ルーティング例
- Logic Pro: ソフト音源トラックを作成 → 入力: IAC ドライバ バス 2 → レコード有効（R）/モニタ（I）ON → 再生
- DP: インストゥルメントトラック作成 → 入力: IAC ドライバ Logic->DP → モニタON

## 5. トラブルシューティング
- デバイスに出ない: `list_devices` が空 or 擬似デバイスのみ → node-midi をインストール or 別の送信手段を利用
- 鳴らない: DAWの入力ポート設定、トラックのモニタ/レコード有効、音源の割当を確認
- 音が短い: `durationMs` を増やす（800–1500ms）
- 間違いポート: `portName` をより正確に指定（完全一致不要、部分一致可）

## 6. 検証フロー（最小）
1) `list_devices`
2) `playback_midi` with `{ durationMs: 800, portName: "IAC" }`
3) DAW側メータが振れる/音が出ることを確認

---

参考: `docs/prompts/claude_test_prompts_v2.md` に、Claude Desktop からの一連手順が記載されています。
