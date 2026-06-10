# 作曲ワークフロー設計（MCP MIDI TOOL）

本ガイドは、MCP MIDI TOOL を用いた「JSONファースト」かつ反復可能な作曲/編集プロセスを示します。Claude Desktop 等の MCP クライアントからの操作を前提に、Score DSL v1 と JSON MIDI v1 を組み合わせて、検証→編集→再生→書き出しまでを一貫させます。

## 1. 前提とセットアップ

- ランタイム: Node.js 20+
- インストール: `npm ci`
- 実行（開発）: `npm run dev`（`tsx src/index.ts`）
- 実行（ビルド後）: `npm run build && npm start`
- データディレクトリ: `data/midi`（保存先）, `data/export`（書き出し先）
- 主要ENV:
  - `MCP_MIDI_BASE_DIR`: ベースディレクトリを上書き
  - `MCP_MIDI_MANIFEST` / `MCP_MIDI_MANIFEST_NOCACHE`: マニフェスト制御
  - `MCP_MIDI_EMIT_READY=1`: 起動時 ready ペイロード出力
  - `MCP_MIDI_PLAY_SMF_BAR_MODE=simple|precise`（将来）: 小節範囲再生の挙動切替

注: node-midi は動的読み込みです。未対応環境でもサーバは動作し、再生系はサイレントフォールバックします。

## 2. 基本コンセプト（JSONファースト）

- Score DSL v1（人間可読）→ JSON MIDI v1（tick/ppq, 検証可能）→ SMF へ変換し保存。
- 編集は基本 JSON（抽出/置換/追記/正規化）で行い、必要に応じて DSL を再コンパイルして反映。
- 再生は dryRun で解析とメトリクス確認→必要に応じて実再生（デバイス選択）。

用語と表記
- 「外部チャンネル」= 1〜16（Score DSL・ツール引数）／「内部チャンネル」= 0〜15（JSON MIDI）
- `format` 明示を推奨（`json_midi_v1` | `score_dsl_v1`）。不一致時は `FORMAT_MISMATCH` を返し早期発見。

## 3. 作曲フロー（ゼロから）

1) 素材の入力（Score DSL v1）
- まず DSL でラフに構成（小節/拍/音価/アーティキュレーション）。
- MCP: `json_to_smf { json, format:"score_dsl_v1", name, overwrite? }`

例（DSL文字列 → SMF保存）:
```json
{
  "name": "base.mid",
  "format": "score_dsl_v1",
  "json": "#title:Idea\n#tempo:120\n#time:4/4\nlead: C4 8 D4 8 E4 8 F4 8 | G4 4 R 4\n"
}
```
レスポンス: `{ ok, fileId, bytes, trackCount, eventCount }`

2) 解析と見積り（dryRun）
- MCP: `play_smf { fileId, dryRun:true }` → `{ scheduledEvents, totalDurationMs }`
- 小節範囲の確認には `startBar/endBar` 指定が可能。内部で「精密抽出」モード（tempo/拍子/CC/ピッチベンドの状態シード）を試みます。

3) 実再生（必要に応じて）
- MCP: `list_devices` で出力先を確認 → `play_smf { fileId, portName:"IAC" }`
- 進捗監視: `get_playback_status { playbackId }`／停止: `stop_playback { playbackId }`

4) 小節単位の編集（抽出→置換）
- 抽出: `extract_bars { fileId, startBar, endBar }`（JSON MIDIを返す）
- 置換: `replace_bars { fileId, startBar, endBar, json, format, outputName? }`
- 使い方: 抽出結果を編集（音高/velocity/CC等）して指定範囲に反映。`outputName` 指定で元を保ったまま別ファイルに書き出せます。

例（bar2 を2音に差し替え）:
```json
{
  "fileId": "<id>",
  "startBar": 2,
  "endBar": 2,
  "json": {
    "ppq": 480,
    "tracks": [ { "events": [
      { "type":"note", "tick":0,   "pitch":60, "velocity":100, "duration":480 },
      { "type":"note", "tick":480, "pitch":64, "velocity":100, "duration":480 }
    ] } ]
  },
  "format": "json_midi_v1",
  "outputName": "replaced_bar2.mid"
}
```

5) セクションの追加（追記）
- MCP: `append_to_smf { fileId, json, format, atEnd?, atTick?, gapTicks?, trackIndex?, preserveTrackStructure?, trackMapping?, keepGlobalMeta?, allowKeyChange?, outputName? }`
- DSLでもJSONでも可。`preserveTrackStructure:true` で元のトラック構造を維持して追記可能。

6) 表現付与（自動/手動）
- 自動CC: Score DSL の `meta.autoCcPresets`（`sustain_from_slur`, `crescendo_to_expression`）
- 手動挿入: `insert_sustain { fileId, ranges:[{startTick,endTick,channel?,trackIndex?,valueOn?,valueOff?}] }`
- 任意CC: `insert_cc { fileId, controller, ranges:[...] }`

7) 正規化/整備
- MCP: `clean_midi { fileId }` → 重複メタやトラック統合の整理、新規ファイルを発行

8) 出力
- MCP: `export_midi { fileId, name? }` → `data/export` へコピー

## 4. 録音ドリブンの作曲（素材→編集）

1) 記録開始: `start_continuous_recording { portName?, ppq?, maxDurationMs?, idleTimeoutMs?, silenceTimeoutMs?, channelFilter?, eventTypeFilter? }`
2) 進捗監視: `get_continuous_recording_status { recordingId }`
3) 終了保存: `stop_continuous_recording { recordingId, name?, overwrite? }` → SMF発行
4) 素材化: `smf_to_json { fileId }` で JSON 抽出
5) 編曲: 上記 4) 置換・5) 追記・6) 表現付与へ接続

単発キャプチャ（和音のワンショット）も利用可:
- `start_single_capture` → `get_single_capture_status`／テスト用に `feed_single_capture`

## 5. 実運用 Tips / エラー対処

- フォーマット明示: `json_to_smf`/`append_to_smf`/`replace_bars` は `format` 指定を推奨。誤判定時は `FORMAT_MISMATCH`。
- チャンネル表記: ツールの `channel` 引数は 1〜16（内部では 0〜15 に変換）。JSON MIDIは 0〜15。
- 小節範囲再生: `play_smf` の `startBar/endBar` は「精密抽出」を試行し、tempo/拍子/CC/ピッチベンドの直前値を 0tick にシード。跨ぎノートの合成は一部未実装（バックログ参照）。
- マニフェスト: 大量ファイル時は `MCP_MIDI_MANIFEST_THRESHOLD` を参照。キャッシュは `MCP_MIDI_MANIFEST_NOCACHE=1` で無効化可能。
- デバッグ: `MCP_MIDI_PLAY_SMF_DEBUG_JSON` で `play_smf` 応答に抽出JSON（`debug.extracted`）を含める。

## 6. MCP ツール呼び出し例（payload 抜粋）

- `json_to_smf`（JSON）
```json
{ "name":"json.mid", "format":"json_midi_v1", "json": { "format":1, "ppq":480, "tracks":[{ "events":[ {"type":"meta.tempo","tick":0,"usPerQuarter":500000}, {"type":"note","tick":0,"pitch":60,"velocity":100,"duration":480} ] }] } }
```

- `append_to_smf`（DSL）
```json
{ "fileId":"<id>", "format":"score_dsl_v1", "json": { "ppq":480, "meta":{ "timeSignature":{ "numerator":4, "denominator":4 }, "keySignature":{ "root":"C","mode":"major" }, "tempo":{ "bpm":120 } }, "tracks":[ { "channel":1, "events":[ {"type":"note","note":"C5","start":{"bar":1,"beat":1},"duration":{"value":"1/4"}} ] } ] }, "atEnd":true }
```

- `play_smf`（精密小節範囲 dryRun）
```json
{ "fileId":"<id>", "dryRun":true, "startBar":2, "endBar":3 }
```

- `insert_cc`（CC11をbar2相当tick範囲へ）
```json
{ "fileId":"<id>", "controller":11, "ranges":[ {"startTick":480*4, "endTick":480*8, "channel":1} ] }
```

- `export_midi`
```json
{ "fileId":"<id>", "name":"final_take.mid" }
```

## 7. 参考: E2E スクリプト

- `scripts/mcp_composition_workflow.mjs` は、DSL→SMF→bar抽出→置換→追記→精密bar再生（dryRun）までの一連を自動化しています。
- 実行例: `npm run build && node scripts/mcp_composition_workflow.mjs`

---
補足仕様は `README.md` と `docs/specs/*.md`（特に `score_dsl_v1.md`, `json_midi_schema_v1.md`）を参照してください。

