# MCP MIDI TOOL

非AI・決定論的なMCPスタンドアロンサーバー。MIDIファイルの保存/取得/一覧/書き出しに加え、ノート送出とSMF(Standard MIDI File)の再生を提供します。Claude Desktop等のMCPクライアントからの操作を前提に、TDDで実装・検証しています。

- ランタイム: Node.js 20+ / TypeScript ESM
- I/O: [node-midi](https://www.npmjs.com/package/midi)（RtMidi）を動的に使用（利用不可環境ではサイレントフォールバック）
- SMF解析: [@tonejs/midi](https://www.npmjs.com/package/@tonejs/midi)

## JSONファースト（作曲/編集フロー）
AIとの連携では、長大なBase64よりも「構造化JSON→SMFコンパイル」の方が堅牢で反復編集に適します（ADR-0002）。本サーバはJSONファーストを正式サポートしています。
- json_to_smf: JSONを検証しSMFへコンパイル・保存（bytes/trackCount/eventCount を返却）
- smf_to_json: 既存SMFをJSONへデコンパイル（同メトリクス付き）

関連ガイド: `docs/guide/composition_workflow.md` に、Score DSL/JSON MIDI を用いた「作曲→編集→再生→書き出し」までの実践フローをまとめています。

クライアント接続（Codex CLI 等）
- Codex から本サーバーを MCP として登録する手順は `docs/setup/codex_mcp_client.md` を参照してください（mcpServers 設定例とスモークテスト付き）。

JSONスキーマ、正規化/順序ルールは `docs/adr/ADR-0002-json-first-composition.md` と `docs/specs/json_midi_schema_v1.md` を参照。既存のSMFワークフロー（store_midi→play_smf）もそのまま利用可能です。

### クイックフロー（JSON→SMF→再生）
1) smf_to_json（任意）: 参考用に既存SMFをJSON化
2) json_to_smf: JSONをSMFへコンパイルして保存（fileId取得）
3) play_smf: `dryRun:true`で解析（scheduledEvents/totalDurationMsを確認）→ 実再生

最小JSON例（概略・スキーマ準拠｜ピッチ番号 or 音名指定の両対応）:
```json
{
   "ppq": 480,
   "tracks": [
         { "events": [ { "type": "meta.tempo", "usPerQuarter": 500000, "tick": 0 } ] },
         { "channel": 0, "events": [
            { "type": "program", "program": 0, "tick": 0 },
            { "type": "note", "note": "C4", "velocity": 100, "tick": 0, "duration": 960 },
            { "type": "note", "pitch": 64,  "velocity": 100, "tick": 960, "duration": 240 }
         ] }
   ]
}
```
注: 上記は内部 JSON MIDI v1 の構造例です。実際に `json_to_smf` ツールへ渡す場合は `format: "json_midi_v1"` を指定してください（下のツール呼び出し例を参照）。

注意（チャンネル表記について）
- 上記は内部の JSON MIDI v1 例です。チャンネルは内部値 0〜15（ch1=0）で表されます。
- MCPツールの引数や Score DSL など、外部からチャンネルを指定する場合は 1〜16 で指定してください（本ドキュメントではこの外部表記を基本とします）。

## Score DSL v1（小節/拍/音価/アーティキュレーション）

人間に読み書きしやすい記法でJSONを組み立て、内部でJSON MIDI v1（tick/ppq）へコンパイルしてからSMFに変換します。

```json
{
   "ppq": 480,
   "meta": {
      "timeSignature": { "numerator": 4, "denominator": 4 },
      "keySignature": { "root": "C", "mode": "major" },
      "tempo": { "bpm": 120 }
   },
   "tracks": [
   { "channel": 1, "program": 0, "events": [
         { "type": "note", "note": "C4", "start": { "bar":1, "beat":1 }, "duration": { "value": "1/4" }, "articulation": "staccato" },
         { "type": "note", "note": "D4", "start": { "bar":1, "beat":2 }, "duration": { "value": "1/8", "dots": 1 }, "articulation": "accent" }
      ]}
   ]
}
```
注意点（よくある質問）
- `start.beat` は整数（小数不可）。半拍や3連位置は `unit`/`offset` で表現します。
- `articulation` の許容は `staccato|tenuto|legato|accent|marcato`。`diminuendo` は未対応（`velocity`/`cc`で代替）。

注: 上記は Score DSL v1 の構造例です。実際に `json_to_smf` ツールへ渡す場合は `format: "score_dsl_v1"` を指定してください（下のツール呼び出し例を参照）。
詳細は `docs/specs/score_dsl_v1.md` を参照。
#### 自動CC付与プリセット (meta.autoCcPresets)
Score DSL → JSON MIDI コンパイル時に、演奏表現を補助するCCイベントを自動生成できます（オプション）。

| プリセットID | 目的 | 生成CC | ロジック概要 |
|--------------|------|--------|--------------|
| `sustain_from_slur` | スラー/レガート区間のペダル保持 | CC64 127→0 | `slur:true` または `articulation:"legato"` が連続するノート群を一括区間化し開始/終了に ON/OFF |
| `crescendo_to_expression` | ダイナミクス段階変化の滑らかな音量フェード | CC11 ランプ | ノートの `dynamic` (pp,p,mp,mf,f,ff) の変化点を端点に線形補間。過剰イベント防止のため約 ppq/4 刻みサンプリング |

使用例:
```jsonc
{
   "ppq":480,
   "meta": {
      "timeSignature": { "numerator":4, "denominator":4 },
      "keySignature": { "root":"C", "mode":"major" },
      "tempo": { "bpm":120 },
      "autoCcPresets": [ { "id": "sustain_from_slur" }, { "id": "crescendo_to_expression" } ]
   },
   "tracks": [
      { "channel":1, "program":0, "events":[
         { "type":"note", "note":"C4", "start":{ "bar":1, "beat":1 }, "duration":{ "value":"1/4" }, "slur": true, "dynamic":"mp" },
         { "type":"note", "note":"D4", "start":{ "bar":1, "beat":2 }, "duration":{ "value":"1/4" }, "articulation":"legato", "dynamic":"mf" },
         { "type":"note", "note":"E4", "start":{ "bar":1, "beat":3 }, "duration":{ "value":"1/4" }, "dynamic":"f" }
      ] }
   ]
}
```
補足:
- プリセットは副作用的にCCイベントを挿入するのみで既存ノートを改変しません。
- 手動で `insert_cc` など後処理を行う場合は二重にならないよう CC 番号 (64/11) の重複を確認してください。
- 将来的に曲線種別（指数/S字）や粒度調整オプションを追加予定です。

### 対応イベント一覧（現状）
- ノート: note（ON/OFF、velocity、durationTicks）
   - ピッチ指定は2通り: `pitch`(0..127) または `note`(音名: C4, F#3, Bb5 等)。SMF→JSONでは両方が付与されます。
- コントロールチェンジ: cc（0–127）
- ピッチベンド: pitchBend（-8192〜+8191）
- プログラムチェンジ: program（0–127）
- メタイベント:
   - meta.tempo（usPerQuarter、トラック0へ集約）
   - meta.timeSignature（トラック0へ集約・roundtripテスト済）
   - meta.keySignature（エンコード対応／デコードは今後対応）
   - meta.marker（デコード/エンコード対応）
   - meta.trackName（デコード/エンコード対応）
- スキーマ定義済み・今後実装拡充: aftertouch.channel / aftertouch.poly（エンコード/デコードとも対応予定）

## 環境変数 (Environment Variables)

| 変数名 | 説明 | デフォルト |
|--------|------|------------|
| `MCP_MIDI_MANIFEST_THRESHOLD` | マニフェスト内アイテム数の閾値。超過すると `manifestItemsThresholdExceeded` が ready ペイロードで `true` になり、stderr に WARN を出力。 | `5000` |
| `MCP_MIDI_EMIT_READY` | `1` のときのみ起動時に ready ペイロード(JSON 1行)を stdout に出力。既存クライアントとの後方互換性維持のためデフォルト非出力。 | (未設定) |

## ready ペイロード構造 (オプトイン時 `MCP_MIDI_EMIT_READY=1`)
```json
{
  "ready": true,
  "coldStartMs": 123,
  "warmup": {
    "manifest": { "count": 1234, "ms": 45 },
    "schema": { "compiled": true, "ms": 12 },
    "midi": { "dynamicImport": true }
  },
  "manifestCache": { "path": "data/manifest.XXXXX.json", "exists": true },
  "manifestItemsThresholdExceeded": false,
  "manifestThreshold": 5000
}
```

### フィールド解説
- `manifestItemsThresholdExceeded`: マニフェスト件数 >= 閾値で true。
- `manifestThreshold`: 判定に利用した閾値値。
- `coldStartMs`: プロセス開始から ready 出力までのおおよその経過ミリ秒。
- `warmup.manifest.count`: 読み込んだアイテム数。
- `warmup.manifest.ms`: マニフェスト読込所要時間。
- `warmup.schema.ms`: スキーマ初期化所要時間。
- `manifestCache.path`: 利用されたマニフェストキャッシュファイルパス。

## WARN ログ
閾値を超えると stderr に以下形式の警告が出力されます:
```
[WARN] manifest item count high: <count> >= <threshold>
```

## テストにおける利用例
特定テストで ready ペイロードを検証する場合:
```
MCP_MIDI_EMIT_READY=1 MCP_MIDI_MANIFEST_THRESHOLD=50 vitest run tests/manifest_threshold_ready.test.ts
```

## 主な機能（MCP Tools）
- store_midi: base64のMIDIを保存し、fileIdを返す
- get_midi: メタ情報を返し、任意でbase64を同梱
- list_midi: 保存済みMIDI一覧（ページング）
- export_midi: data/exportへコピー
- append_to_smf: 既存SMFへJSON/Score DSLチャンクを追記（末尾/指定tick）
- insert_sustain: 既存SMFにサスティン（CC64）のON/OFFを指定tick範囲で挿入
- insert_cc: 既存SMFに任意のCC番号のON/OFF相当（2値）を指定tick範囲で挿入
- list_devices: MIDI出力デバイス列挙
- playback_midi: 単音PoC再生（durationMsで長さ指定）
- play_smf: SMFを解析して再生（dryRun解析、範囲再生、スケジューラ）
- stop_playback: 再生停止（全ノート消音、タイマ解除、ポートクローズ）
- find_midi: 名前の部分一致検索
- get_playback_status: 再生進捗の取得（cursor/lastSentAt/総尺など）
- trigger_notes: 単発でノート（単音/和音）を即送出（耳トレ/聴音ワンショット）
- start_single_capture: 単発(単音/和音)リアルタイムキャプチャ開始（onsetWindow内ノートを和音化）
- feed_single_capture: （テスト/擬似入力用）キャプチャ中セッションへノートON/OFFイベント投入
- get_single_capture_status: キャプチャ進捗/完了結果取得（reason, result を含む）
- start_continuous_recording: MIDI入力デバイスから継続的な演奏記録を開始（3種類タイムアウト・フィルタリング対応）
- get_continuous_recording_status: 記録セッションの現在状態・進捗・メトリクス取得（リアルタイム監視）
- stop_continuous_recording: 継続記録セッション手動終了・SMF生成保存・fileId発行
- list_continuous_recordings: 進行中・完了済み記録セッション一覧取得（デバッグ・監視用）
- extract_bars: SMFファイルの指定小節範囲をJSON MIDI形式で抽出（相対tick変換）
- replace_bars: SMFファイルの指定小節範囲をJSONデータで置換（部分編集）
- clean_midi: 既存SMF内の重複テンポ/拍子/調号メタやチャネル分割トラックを正規化し新規fileIdで保存（クリーン再構築）

### 精密小節範囲再生 (R11: extractionMode:"precise")
`play_smf` に `startBar` / `endBar` を与えると、R11 以降は単純 ms 範囲切出ではなく「抽出モード」が動作します。

基本動作（precise モード）:
1. 対象SMFを JSON MIDI に解析
2. 指定 bar 範囲のイベントを抽出（tick を 0 起点へ正規化しない: 内部では相対化→再エンコード）
3. 範囲開始前に有効だった状態系イベント（tempo / timeSignature / pitchBend / CC64 / 任意 CC controller 値）を 0tick にシード
4. 跨ぎノート: 範囲前で発音し範囲内で鳴り続けるノートは 0tick に合成 NoteOn（duration 端調整）を生成（未実装: TODO）
5. (予定) 範囲終端を越える保持ノートに NoteOff 合成（安全終了）

レスポンス拡張:
```jsonc
{
   "ok": true,
   "extractionMode": "precise", // 精密抽出成功時
   "scheduledEvents": 123,
   "debug": { "extracted": { /* 0tick シード含む内部JSON */ } }
}
```

フォールバック:
- 環境変数 `MCP_MIDI_PLAY_SMF_BAR_MODE=simple` を設定すると旧ロジック（簡易: tempo/拍子変化・CCシード無し）へ切替 (実装予定)。

現状の実装状況:
- pitchBend / CC64 / 任意 CC のシード済み (RED→GREEN テストで保証)
- 複数テンポ変化中の bar2 抽出, 拍子変更跨ぎ, sustain OFF 跨ぎ, 跨ぎノート合成は RED テスト追加予定

注意:
- Score DSL v1 は小節途中テンポ変更を未サポート。精密抽出の検証では JSON MIDI 直接投入でテンポ変化を構築。


戻り値はClaude互換の`content: [{type:'text', text: ...}]`を含みます。

### ツール詳細（入出力の要点）
- json_to_smf
   - 入力: `{ json: <JSON MIDI または Score DSL v1>, format?: "json_midi_v1"|"score_dsl_v1", name?: string, overwrite?: boolean }`
      - format を明示すると、その形式で厳密に処理します（推奨）。
      - 未指定の場合は後方互換として「JSON MIDI v1の検証→失敗ならScore DSL v1のコンパイル」へフォールバックします。
   - 出力: `{ fileId, bytes, trackCount, eventCount }`
- smf_to_json
- append_to_smf
   - 入力: `{ fileId: string, json: <JSON MIDI または Score DSL v1>, format?: "json_midi_v1"|"score_dsl_v1", atEnd?: boolean, atTick?: number, gapTicks?: number, trackIndex?: number, outputName?: string }`
      - `atEnd:true` で既存末尾へ追記。`atTick` 指定時はそのtickから相対配置。
      - `gapTicks` で追記前に隙間を空ける。`trackIndex` で追記先トラックを選択（未指定は最初の音源トラック）。
      - `outputName` を指定すると新規ファイルとして保存（未指定は同名上書き）。
   - 出力: `{ fileId, name, path, bytes, insertedAtTick }`
   - 入力: `{ fileId }`
   - 出力: `{ json: <JSON MIDI>, bytes, trackCount, eventCount }`
- clean_midi
   - 目的: 累積 append/replace で増殖した重複グローバルメタ(tempo/time/key)やチャネル毎に分断された多数トラックを整理。
   - 入力: `{ fileId: string }`
   - 出力: `{ fileId, path, bytes, original:{trackCount,eventCount}, cleaned:{trackCount,eventCount}, removedDuplicateMeta, mergedTracks }`
   - 処理: 最初に出現した tempo/time/key を採用し以降削除。channel番号でトラック統合（非チャネルイベントは track0へ）。tick順で再ソート。
   - 推奨タイミング: 1) 大量追記後の最適化 2) 予期せぬ trackCount 急増検知時。
- play_smf（dryRun推奨→実再生）
   - 入力: `{ fileId, dryRun?: true|false, portName?: string, startMs?: number, stopMs?: number, schedulerLookaheadMs?: number, schedulerTickMs?: number }`
   - 出力: `dryRun:true` の場合 `{ scheduledEvents, totalDurationMs }` を返却。実再生時は `playbackId` を発行。
- get_playback_status
   - 出力: `{ playbackId, done, cursorMs, lastSentAt, totalDurationMs }`
- trigger_notes（単発発音・即時）
   - 入力: `{ notes: (string[]|number[]), velocity?: number(1-127)=100, durationMs?: number(20-10000)=500, channel?: number(1-16)=1, program?: number(0-127), portName?: string, transpose?: number, dryRun?: boolean }`（外部表記。内部では 0〜15 にマップ）
   - 出力: `{ playbackId, scheduledNotes, durationMs, portName? }`（dryRun時は即done相当）
   - 例: `{ tool:"trigger_notes", arguments:{ notes:["C4","E4","G4"], velocity:96, durationMs:200, portName:"IAC" } }`
- extract_bars（小節範囲抽出）
   - 入力: `{ fileId: string, startBar: number(>=1), endBar: number(>=1), format?: "json_midi_v1" }`
   - 出力: `{ ok:true, startBar, endBar, startTick, endTick, eventCount, json, durationTicks }`
   - 例: `{ tool:"extract_bars", arguments:{ fileId:"abc123", startBar:2, endBar:3 } }`
- replace_bars（小節範囲置換）
   - 入力: `{ fileId: string, startBar: number(>=1), endBar: number(>=1), json: object, format?: "json_midi_v1", outputName?: string }`
   - 出力: `{ ok:true, newFileId, name, startBar, endBar, originalFileId }`
   - 例: `{ tool:"replace_bars", arguments:{ fileId:"abc123", startBar:1, endBar:1, json:{...}, outputName:"modified.mid" } }`

#### 単発リアルタイムキャプチャ (single capture)
和音あるいは単音を「最初のNoteOn発生から onsetWindowMs 以内」にまとめて 1 つの結果として返す軽量キャプチャ。全ノートOff後のサイレンス、または maxWaitMs 経過で確定。

2025-08 現在: 2系統の入力をサポート
- 擬似イベント: `feed_single_capture` （テスト/自動化用）
- 実デバイス: `start_device_single_capture` （`list_input_devices` でポート名を取得して指定）

コントラクト（成功時 / 擬似入力）:
```
start_single_capture -> { captureId, onsetWindowMs, silenceMs, maxWaitMs }
feed_single_capture(captureId, events[]) -> { ok:true, captureId, done:boolean }
get_single_capture_status(captureId) -> {
   ok:true,
   captureId,
   done:boolean,
   reason?: 'completed' | 'timeout',
   result?: { notes:number[], velocities:number[], durationMs:number, isChord:boolean }
}
```
デバイス版追加ツール:
```
list_input_devices -> { ok:true, devices:[ { index, name } ... ] }
start_device_single_capture { portName?, onsetWindowMs?, silenceMs?, maxWaitMs? } -> { captureId, portName, mode:'device', onsetWindowMs, silenceMs, maxWaitMs }
get_single_capture_status { captureId } -> （共通）
```

主要パラメータ（共通）:
- onsetWindowMs (10–500 推奨既定80): 最初のNoteOnから同一和音として受理する追加NoteOnの時間窓
- silenceMs (>=50): 全ノートOff後に確定する無音保持時間
- maxWaitMs (>=200): キャプチャ開始からの最大全体待ち時間（NoteOn未発生でも timeout）

feed_single_capture の events 形式:
```
{ kind:'on'|'off', note: <0-127>, velocity?:1-127, at: <capture開始基準ms> }
```
ルール:
- onsetWindow超過の追加NoteOnは無視
- 無効ノート/負値/範囲外はエラー
- 完了後の feed は ignored 扱い

使用例（和音キャプチャ → 結果取得：擬似イベント）:
```jsonc
// 1) start
{ "tool":"start_single_capture", "arguments": { "onsetWindowMs":80, "silenceMs":150, "maxWaitMs":3000 } }
// <- { captureId }

// 2) feed (C,E,G triad)
{ "tool":"feed_single_capture", "arguments": { "captureId":"<id>", "events":[
   {"kind":"on","note":60,"velocity":100,"at":10},
   {"kind":"on","note":64,"velocity":102,"at":30},
   {"kind":"on","note":67,"velocity":98,"at":55},
   {"kind":"off","note":60,"at":300},
   {"kind":"off","note":64,"at":305},
   {"kind":"off","note":67,"at":310}
] } }

// 3) 約500ms後 status
{ "tool":"get_single_capture_status", "arguments": { "captureId":"<id>" } }
// -> done:true, reason:'completed', result.notes:[60,64,67]
```

デバイス使用例（IACバスを自動選択または部分一致）:
```jsonc
// 1) 入力ポート列挙
{ "tool":"list_input_devices", "arguments":{} }
// <- { devices:[ {"index":0, "name":"IAC Driver Bus 1"}, ... ] }

// 2) キャプチャ開始（portName 省略で 0 番候補 / IAC / virtual / network 優先）
{ "tool":"start_device_single_capture", "arguments": { "portName":"IAC", "onsetWindowMs":90, "silenceMs":150, "maxWaitMs":4000 } }
// <- { captureId, portName:"IAC Driver Bus 1", mode:"device" }

// 3) MIDIキーボードで和音を弾く → 全ノート離して silence 経過
{ "tool":"get_single_capture_status", "arguments": { "captureId":"<id>" } }
// -> done:true, reason:'completed', result.notes:[60,64,67]
```

タイムアウト例（無入力 / 擬似 or デバイス）:
```jsonc
{ "tool":"start_single_capture", "arguments": { "maxWaitMs":400 } }
// 500ms後 status
{ "tool":"get_single_capture_status", "arguments": { "captureId":"<id>" } }
// -> reason:'timeout', result.notes:[]
```
```jsonc
{ "tool":"start_single_capture", "arguments": { "maxWaitMs":400 } }
// 500ms後 status
{ "tool":"get_single_capture_status", "arguments": { "captureId":"<id>" } }
// -> reason:'timeout', result.notes:[]
```
エッジ/確認ポイント:
- done:false の間は reason 未設定
- result は完了後イミュータブル
- durationMs は和音最初のNoteOnから最終Off相対

#### 継続MIDI記録 (continuous recording)
MIDI入力デバイスから演奏全体を継続的に記録し、自動または手動でSMFファイルとして保存する機能。長時間演奏、複数楽器パート、レッスン記録などに対応。

**主要機能**:
- **3種類の自動終了**: idle timeout（初回入力待ち）、silence timeout（演奏終了検出）、max duration（最大記録時間）
- **マルチセッション**: 最大3セッション同時記録対応（セッション間分離）
- **フィルタリング**: チャンネル（1-16）・イベントタイプ（note/cc/pitchBend/program）による記録対象絞り込み
- **メモリ管理**: イベント数100K上限、セッション10MB制限、24時間自動削除
- **自動SMF保存**: タイムアウト時の自動ファイル生成・重複回避命名・manifest更新

**基本フロー例**:
```jsonc
// 1) 記録開始
{ "tool":"start_continuous_recording", "arguments": {
   "ppq": 480,
   "maxDurationMs": 300000,     // 5分で自動終了
   "idleTimeoutMs": 30000,      // 初回入力30秒待ち
   "silenceTimeoutMs": 10000,   // 最終入力から10秒無音で終了
   "channelFilter": [1, 2, 10], // ch1,2,10のみ記録
   "eventTypeFilter": ["note", "cc"]
}}
// -> { recordingId, portName, ppq, status:"waiting_for_input", startedAt, ... }

// 2) 状態監視（ポーリング推奨）
{ "tool":"get_continuous_recording_status", "arguments": { "recordingId":"<id>" }}
// -> { status:"recording", eventCount:245, durationMs:82000, eventBreakdown:{note:180,cc:65}, channelActivity:{1:120,2:85,10:40}, timeUntilTimeout:218000, ... }

// 3a) 手動終了・SMF保存
{ "tool":"stop_continuous_recording", "arguments": { "recordingId":"<id>", "name":"my-session.mid" }}
// -> { fileId, name, path, bytes, durationMs, eventCount, reason:"manual_stop", recordingStartedAt, savedAt, ... }

// 3b) または自動終了（タイムアウト検出）
{ "tool":"get_continuous_recording_status", "arguments": { "recordingId":"<id>" }}
// -> { status:"timeout_silence", reason:"silence_timeout", ... } (SMFは非同期で自動保存済み)
```

**セッション一覧・デバッグ用**:
```jsonc
// アクティブなセッション確認
{ "tool":"list_continuous_recordings", "arguments": { "status":"active", "limit":10 }}
// -> { recordings:[{recordingId,status,startedAt,durationMs,eventCount,portName},...], total:2, activeCount:2, completedCount:0 }

// 完了済み含む全セッション
{ "tool":"list_continuous_recordings", "arguments": { "status":"all" }}
```

**状態遷移**: `waiting_for_input` → `recording` → `completed`/`timeout_idle`/`timeout_silence`/`timeout_max_duration`/`stopped_manually`

**制約・リソース管理**:
- 同時記録セッション: 最大3セッション
- イベント数上限: セッションあたり100,000イベント
- メモリ上限: セッションあたり10MB推定
- 自動削除: 完了から24時間後に未保存セッション削除
- ファイル命名: デフォルト `recording-YYYY-MM-DD-HHmmss.mid`、重複時は番号suffix付与

#### 小節範囲編集 (bar-based editing)
既存SMFファイルの指定小節範囲を抽出・置換する部分編集機能。MCPクライアントから曲を修正しながら作曲できます。

**主要機能**:
- **小節抽出**: 指定小節範囲をJSON MIDI形式で抽出（相対tick変換）
- **小節置換**: 指定小節範囲をJSONデータで置換（既存ファイルの一部書き換え）
- **タイムシグネチャ対応**: 4/4以外の拍子記号を考慮した小節計算
- **SMF互換**: 元ファイルのPPQ・メタ情報を維持

**基本的な使用例**:
```jsonc
// 1. 2小節のメロディから1小節目を抽出
{ "tool":"extract_bars", "arguments": {
   "fileId": "abc123", "startBar": 1, "endBar": 1, "format": "json_midi_v1" 
}}
// -> { ok:true, startBar:1, endBar:1, startTick:0, endTick:1920, eventCount:3, json:{...} }

// 2. 抽出したJSONを修正してから置換
{ "tool":"replace_bars", "arguments": {
   "fileId": "abc123", "startBar": 1, "endBar": 1,
   "json": { "ppq":480, "tracks":[...] }, "format": "json_midi_v1",
   "outputName": "modified-melody.mid"
}}
// -> { ok:true, newFileId:"def456", name:"modified-melody.mid", startBar:1, endBar:1 }
```

**注意事項**:
- 小節番号は1から開始（1-indexed）
- 抽出されたJSONのtickは相対値（抽出範囲の開始を0とする）
- 置換時は元のSMF構造に合わせてイベントが統合される
- 複数トラックのSMFでも、JSON変換時に統合された構造で処理される


### JSONイベント仕様（抜粋）
- note: `{ type:"note", tick, pitch(0-127), velocity(1-127), duration>=1, channel? }`
- cc: `{ type:"cc", tick, controller(0-127), value(0-127), channel? }`
- program: `{ type:"program", tick, program(0-127), channel? }`
- pitchBend: `{ type:"pitchBend", tick, value(-8192..8191), channel? }`
- meta.tempo: `{ type:"meta.tempo", tick, usPerQuarter>=1 }`（BPM=60,000,000/usPerQuarter）
- meta.timeSignature: `{ type:"meta.timeSignature", tick, numerator>=1, denominator∈{1,2,4,8,16,32} }`
- meta.keySignature: `{ type:"meta.keySignature", tick, sf(-7..7), mi∈{0,1} }`
- meta.marker: `{ type:"meta.marker", tick, text<=128 }`
- meta.trackName: `{ type:"meta.trackName", tick, text<=128 }`

## 環境変数 (Environment Variables)

| 変数名 | 説明 | デフォルト |
|--------|------|------------|
| `MCP_MIDI_MANIFEST_THRESHOLD` | マニフェスト内アイテム数の閾値。超過すると `manifestItemsThresholdExceeded` が ready ペイロードで `true` になり、stderr に WARN を出力。 | `5000` |
| `MCP_MIDI_EMIT_READY` | `1` のときのみ起動時に ready ペイロード(JSON 1行)を stdout に出力。既存クライアントとの後方互換性維持のためデフォルト非出力。 | (未設定) |

## ready ペイロード構造 (オプトイン時 `MCP_MIDI_EMIT_READY=1`)
```json
{
  "ready": true,
  "coldStartMs": 123,
  "warmup": {
    "manifest": { "count": 1234, "ms": 45 },
    "schema": { "compiled": true, "ms": 12 },
    "midi": { "dynamicImport": true }
  },
  "manifestCache": { "path": "data/manifest.XXXXX.json", "exists": true },
  "manifestItemsThresholdExceeded": false,
  "manifestThreshold": 5000
}
```

### フィールド解説
- `manifestItemsThresholdExceeded`: マニフェスト件数 >= 閾値で true。
- `manifestThreshold`: 判定に利用した閾値値。
- `coldStartMs`: プロセス開始から ready 出力までのおおよその経過ミリ秒。
- `warmup.manifest.count`: 読み込んだアイテム数。
- `warmup.manifest.ms`: マニフェスト読込所要時間。
- `warmup.schema.ms`: スキーマ初期化所要時間。
- `manifestCache.path`: 利用されたマニフェストキャッシュファイルパス。

## WARN ログ
閾値を超えると stderr に以下形式の警告が出力されます:
```
[WARN] manifest item count high: <count> >= <threshold>
```

## テストにおける利用例
特定テストで ready ペイロードを検証する場合:
```
MCP_MIDI_EMIT_READY=1 MCP_MIDI_MANIFEST_THRESHOLD=50 vitest run tests/manifest_threshold_ready.test.ts
```
