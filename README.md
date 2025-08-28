# MCP MIDI TOOL

非AI・決定論的なMCPスタンドアロンサーバー。MIDIファイルの保存/取得/一覧/書き出しに加え、ノート送出とSMF(Standard MIDI File)の再生を提供します。Claude Desktop等のMCPクライアントからの操作を前提に、TDDで実装・検証しています。

- ランタイム: Node.js 20+ / TypeScript ESM
- I/O: [node-midi](https://www.npmjs.com/package/midi)（RtMidi）を動的に使用（利用不可環境ではサイレントフォールバック）
- SMF解析: [@tonejs/midi](https://www.npmjs.com/package/@tonejs/midi)

## JSONファースト（作曲/編集フロー）
AIとの連携では、長大なBase64よりも「構造化JSON→SMFコンパイル」の方が堅牢で反復編集に適します（ADR-0002）。本サーバはJSONファーストを正式サポートしています。
- json_to_smf: JSONを検証しSMFへコンパイル・保存（bytes/trackCount/eventCount を返却）
- smf_to_json: 既存SMFをJSONへデコンパイル（同メトリクス付き）

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
- play_smf（dryRun推奨→実再生）
   - 入力: `{ fileId, dryRun?: true|false, portName?: string, startMs?: number, stopMs?: number, schedulerLookaheadMs?: number, schedulerTickMs?: number }`
   - 出力: `dryRun:true` の場合 `{ scheduledEvents, totalDurationMs }` を返却。実再生時は `playbackId` を発行。
- get_playback_status
   - 出力: `{ playbackId, done, cursorMs, lastSentAt, totalDurationMs }`
- trigger_notes（単発発音・即時）
   - 入力: `{ notes: (string[]|number[]), velocity?: number(1-127)=100, durationMs?: number(20-10000)=500, channel?: number(1-16)=1, program?: number(0-127), portName?: string, transpose?: number, dryRun?: boolean }`（外部表記。内部では 0〜15 にマップ）
   - 出力: `{ playbackId, scheduledNotes, durationMs, portName? }`（dryRun時は即done相当）
   - 例: `{ tool:"trigger_notes", arguments:{ notes:["C4","E4","G4"], velocity:96, durationMs:200, portName:"IAC" } }`

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

### MCPクライアントからの呼び出し例（擬似）
以下はMCPクライアントが送るpayloadの概略です（実際はクライアント実装に依存）。

json_to_smf:
（内部 JSON MIDI の例。チャンネルは 0〜15（ch1=0）で表現されます。外部指定は 1〜16 を使用してください）
```jsonc
{
   "tool": "json_to_smf",
   "arguments": {
    "json": { "ppq":480, "tracks":[ {"events":[{"type":"meta.tempo","tick":0,"usPerQuarter":500000}]}, {"channel":0,"events":[{"type":"program","tick":0,"program":0},{"type":"note","tick":0,"pitch":60,"velocity":100,"duration":960}]} ] },
         "format": "json_midi_v1",
      "name": "example.json",
      "overwrite": true
   }
}
```

Score DSL を直接渡す例（オブジェクト or JSON文字列のどちらでも可）:
```jsonc
{
   "tool": "json_to_smf",
   "arguments": {
      "json": {
         "ppq": 480,
         "meta": { "timeSignature": { "numerator": 4, "denominator": 4 }, "tempo": { "bpm": 120 } },
         "tracks": [ { "channel": 1, "events": [ { "type": "note", "note": "C4", "start": { "bar": 1, "beat": 1 }, "duration": { "value": "1/4" } } ] } ]
      },
      "format": "score_dsl_v1",
      "name": "from-dsl.mid"
   }
}
```

append_to_smf（末尾へScore DSLを追記）:
```jsonc
{ 
   "tool": "append_to_smf",
   "arguments": {
      "fileId": "<existing-fileId>",
      "json": { "ppq": 480, "meta": { "timeSignature": { "numerator": 4, "denominator": 4 }, "tempo": { "bpm": 120 } }, "tracks": [ { "channel": 1, "events": [ { "type": "note", "note": "G4", "start": { "bar": 1, "beat": 1 }, "duration": { "value": "1/4" } } ] } ] },
      "format": "score_dsl_v1",
      "atEnd": true,
      "gapTicks": 240
   }
}
```

insert_sustain（CC64のON/OFFを挿入）:
```jsonc
{ 
   "tool": "insert_sustain",
   "arguments": {
      "fileId": "<existing-fileId>",
      "ranges": [
         { "startTick": 0, "endTick": 720 },
         { "startTick": 1920, "endTick": 2400, "channel": 0, "trackIndex": 1, "valueOn": 120, "valueOff": 0 }
      ]
   }
}
```

insert_cc（任意CCのON/OFF相当を挿入）:
```jsonc
{
   "tool": "insert_cc",
   "arguments": {
      "fileId": "<existing-fileId>",
      "controller": 11,
      "ranges": [
         { "startTick": 0, "endTick": 480, "valueOn": 90, "valueOff": 40 }
      ]
   }
}
```
備考:
- `controller` は 0〜127。`channel` は 1〜16（外部）もしくは 0〜15（内部）で指定可能。
- 仕様・挙動は概ね insert_sustain と同様（同tickでのON/OFF、値域、trackIndex継承/明示）。
 - 複数レンジや重なりレンジを与えた場合、イベントはそのまま挿入されます（レンジのマージは行いません）。ただし、完全重複の同一イベント（tick/値/チャンネル一致）は重複除去されます。
備考:
- 未指定時は、最初の音源トラックを自動選択し、そのトラックのチャンネル（内部0〜15）を継承します。見つからない場合は ch0 を使用。
- `channel` は外部表記 1〜16 も受け付けます（内部 0〜15 に自動マップ）。内部表記 0〜15 の指定も可。
- `trackIndex` を指定すると挿入先トラックを明示できます。
- `valueOn`/`valueOff` は 0〜127 を使用（既定 127/0）。
   - 同tickでのON/OFも可能（startTick===endTickのときは同tickに両方のイベントが入ります）。
   - ハーフペダル等の任意値も指定可能（例: valueOn:100, valueOff:20）。

play_smf（dryRun→実再生）:
```jsonc
{ "tool":"play_smf", "arguments": { "fileId":"<from-json_to_smf>", "dryRun": true } }
{ "tool":"play_smf", "arguments": { "fileId":"<from-json_to_smf>", "portName":"IAC", "schedulerLookaheadMs":200, "schedulerTickMs":20 } }
```

### エンドツーエンド例（Score DSL → SMF → 追記 → CC自動/手動 → 再生）
以下は小さなフレーズを Score DSL で作成し、SMF 化 → 末尾にフレーズ追記 → Expression カーブを自動付与（`crescendo_to_expression`）しつつ、更に任意CCで強調 → dryRun 解析 → 実再生 までの一連例です。

1. 初期スコア（crescendoプリセット付き）を `json_to_smf`:
```jsonc
{ "tool":"json_to_smf", "arguments": {
   "json": {
      "ppq":480,
      "meta": { "timeSignature": { "numerator":4,"denominator":4 }, "tempo": { "bpm":120 }, "autoCcPresets":[ { "id":"crescendo_to_expression" } ] },
      "tracks": [ { "channel":1, "program":0, "events":[
         { "type":"note","note":"C4","start":{"bar":1,"beat":1},"duration":{"value":"1/4"},"dynamic":"mp"},
         { "type":"note","note":"D4","start":{"bar":1,"beat":2},"duration":{"value":"1/4"},"dynamic":"mf"},
         { "type":"note","note":"E4","start":{"bar":1,"beat":3},"duration":{"value":"1/4"},"dynamic":"f"}
      ] } ]
   },
   "format":"score_dsl_v1",
   "name":"phrase1.mid"
} }
```
2. 別フレーズを Score DSL で末尾追記 (`append_to_smf` + `atEnd:true` + `gapTicks`):
```jsonc
{ "tool":"append_to_smf", "arguments": {
   "fileId":"<phrase1-fileId>",
   "json": { "ppq":480, "meta": { "timeSignature": { "numerator":4, "denominator":4 }, "tempo": { "bpm":120 } }, "tracks":[ { "channel":1, "program":0, "events":[ { "type":"note","note":"G4","start":{"bar":1,"beat":1},"duration":{"value":"1/2"}, "dynamic":"mf" } ] } ] },
   "format":"score_dsl_v1",
   "atEnd":true,
   "gapTicks":240
} }
```
3. 追加で任意CC（例: CC11で軽いブースト区間 2小節目開始～2小節目終わり）を `insert_cc`:
```jsonc
{ "tool":"insert_cc", "arguments": {
   "fileId":"<resulting-fileId>",
   "controller":11,
   "ranges":[ { "startTick": 480*4, "endTick": 480*8, "valueOn":100, "valueOff":70 } ]
} }
```
4. 安全確認 （dryRun解析）:
```jsonc
{ "tool":"play_smf", "arguments": { "fileId":"<file-after-cc>", "dryRun": true } }
```
    - `scheduledEvents` と `totalDurationMs` を確認し過剰イベントでないか判断。
5. 実再生:
```jsonc
{ "tool":"play_smf", "arguments": { "fileId":"<file-after-cc>", "portName":"IAC" } }
```
6. 進捗監視と停止:
```jsonc
{ "tool":"get_playback_status", "arguments": { "playbackId":"<id>" } }
{ "tool":"stop_playback", "arguments": { "playbackId":"<id>" } }
```
ポイント:
- 自動付与 (autoCcPresets) と手動挿入 (insert_cc) を組み合わせて段階＋滑らかな変化を作れる。
- 大編成/長尺ではこの手順を小刻みに繰り返し、常に `dryRun` でメトリクスを把握してから再生。


## ディレクトリ
- `src/` MCPサーバ本体（stdio）
- `dist/` ビルド出力
- `data/midi`, `data/export` ストレージ/エクスポート先
- `docs/` セットアップ、プロンプト、スニペット、ADR/仕様

## セットアップ
1) 依存インストール
   - `npm install`
2) ビルド
   - `npm run build`
3) 実行（MCPクライアントから）
   - Claude Desktop でこのサーバのエントリ（`node dist/index.js`）を登録してください。

補足:
- 環境変数`MCP_MIDI_MANIFEST`でマニフェストパスを上書き可能です（デフォルトはプロセスごとに`manifest.<pid>.json`）。

テスト:
- `npm test`（Vitest）でユニット/結合テスト一式が実行されます。

## Claudeでの検証手順（推奨）
- 単音スモーク＆基本操作: `docs/prompts/claude_test_prompts_v2.md`
- SMF再生（dryRun→実再生→停止）: `docs/prompts/claude_test_prompts_v3_play_smf.md`
- 8秒の継続音SMFでE2E検証: `docs/prompts/claude_test_prompts_v4_continuous_8s.md`
- ネットDL→Bach 3声インベンション実再生: `docs/prompts/claude_test_prompts_v5_bach_3voice_net.md`
- 8秒SMFの生成スニペット: `docs/snippets/continuous_chords_smf_8s.md`

最短確認（例）:
1) list_devices で出力ポート確認（IAC/Network/Virtual推奨）
2) store_midi でSMF保存→fileId取得
3) play_smf { fileId, dryRun:true } で scheduledEvents / totalDurationMs を確認
4) play_smf { fileId, portName:"IAC" } で実再生
5) get_playback_status で cursor/lastSentAt/done を観測 → stop_playback

## スケジューラの調整
- play_smf はルックアヘッド型で送出します。必要に応じて以下で調整可能:
  - `schedulerLookaheadMs`（既定50、10〜1000）
  - `schedulerTickMs`（既定10、5〜200）

例: `{ fileId, portName:"IAC", schedulerLookaheadMs:200, schedulerTickMs:20 }`

観測ポイント（dryRun/実再生）:
- totalDurationMs: SMF全体の総尺
- scheduledEvents: dryRunで解析されたイベント件数
- cursorMs/lastSentAt/done: 再生中の進捗確認用

## 受信側（音が出ない時）
- macOSの例: `docs/setup/macos_coremidi_receiver.md`
- チェックリスト: `docs/checklists/receiver_setup_checklist.md`
- 確認ポイント: トラック入力 / モニタリング / 音源割当 / MIDIチャンネル（通常は ch1。内部値では 0）

## クロスプラットフォーム
- 目標: macOS(CoreMIDI) / Windows(MME) / Linux(ALSA)
- 依存: node-midi のネイティブビルドに依存（OS/Nodeバージョン注意）
- ADR: `docs/adr/ADR-0001-node-midi-adoption.md`
   - 追加: `docs/adr/ADR-0002-json-first-composition.md`

## 開発
- TDDで進行。Vitestなどでユニット/結合テスト（`npm test`）
- コード: `src/index.ts`, `src/storage.ts`
- 仕様/バックログ: `docs/specs/*`, `BACKLOG.md`

### 変換メトリクス（観測可能性）
- json_to_smf / smf_to_json は以下を返します:
   - `bytes`: 入出力SMFのバイトサイズ
   - `trackCount`: トラック数
   - `eventCount`: イベント総数（解析/生成時点）
これらはクライアント側のログやガードレール（過大サイズ回避）に活用できます。

## 既知の制限/注意
### 構造化エラーコード（MCPレスポンス）
全ツールは失敗時に `ok:false` と以下のような構造化エラーを返します:
```json
{
   "ok": false,
   "error": {
      "tool": "json_to_smf",
      "code": "VALIDATION_ERROR",
      "message": "score_dsl_v1 compile/validation failed: ...",
      "hint": "入力JSON/Score DSL のスキーマを README と docs/specs を参照して修正してください (format指定推奨)",
      "issues": [ { "path": ["tracks",0,"events",1,"pitch"], "message": "Expected number" } ]
   }
}
```
コード一覧:
- MISSING_PARAMETER: 必須パラメータ欠如
- NOT_FOUND: fileId 等が存在しない
- VALIDATION_ERROR: スキーマ検証/コンパイル失敗（Zod issues 付随可）
- INPUT_FORMAT_ERROR: 音名/JSON構造等の軽度フォーマット不正
- LIMIT_EXCEEDED: サイズ上限超過等
- DEVICE_UNAVAILABLE: node-midi 等デバイス未利用可能
- INTERNAL_ERROR: 想定外例外（Stackはログにのみ出力推奨）
（single capture 補足: reason は 'completed' か 'timeout' の2値。timeout は maxWaitMs 超過発生）

クライアント実装指針:
1. ok===false → error.code で分岐
2. hint があればユーザ提示
3. issues があればパス単位で再生成プロンプトへ投入
4. VALIDATION_ERROR かつ format 未指定の場合は次回 format 明示

### Score DSL / JSON MIDI のエラーの読み方（format導入後）
- `format` を指定した場合:
   - `format: "json_midi_v1"` では `json_midi_v1 validation failed: ...` の形でZodの検証エラーが返ります。
   - `format: "score_dsl_v1"` では `score_dsl_v1 compile/validation failed: ...` の形でコンパイル/検証エラーが返ります。
- `format` 未指定の場合（後方互換）:
   - まず JSON MIDI v1 として検証し、失敗時は Score DSL v1 のコンパイルを試みます。
   - その場合のメッセージは `json validation failed (or score compile failed): ... | score-compile: ...` のように連結されます。
- Score DSLの値（特に NotationValue）は `"1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32"` を使用してください（`"1/1"`は無効）。
- 大容量SMFはdryRunで件数や総尺を把握し、範囲再生（startMs/stopMs）を推奨
- 早期停止が見える場合は`get_playback_status`で進捗を確認し、スケジューラの窓/tickを調整
- `stop_playback`は全ノート消音とポートクローズを行います（ハングノート対策）

## ラウンドトリップ保証範囲（JSON⇄SMF）
- ✅ 往復検証済み（テストGREEN）
   - note / cc / pitchBend / program
   - meta.tempo / meta.timeSignature / meta.marker / meta.trackName
- 🔄 片方向対応
   - meta.keySignature（エンコード可／デコードは今後対応予定）
- ⭐ 実装予定（スキーマ定義済み）
   - aftertouch.channel / aftertouch.poly

## メトリクスの読み方（実務ガイド）
- bytes
   - ファイルサイズの概観。大きいほど読み込み・送出コスト増。数MB級はdryRunで絞り込み（startMs/stopMs）を検討。
- trackCount
   - トラックが多いほど並行イベントが増えがち。不要トラックは削除、役割が同じなら統合を検討。
- eventCount
   - スケジューラ負荷の目安。多い場合は`schedulerLookaheadMs`拡大・`schedulerTickMs`調整で安定化。
- scheduledEvents（play_smf: dryRun）
   - 実送出前の見積り。想定より多い場合はクオンタイズ/ベロシティの簡略化やCC間引きを検討。
- totalDurationMs
   - 再生時間の総尺。長尺では区間再生と進捗監視（get_playback_status）を併用。

ヒント:
- 初回は `dryRun:true` で scheduledEvents/totalDurationMs を把握 → 実再生へ
- カクつき時は lookahead を広げ、tick をやや大きく（例: 200ms/20ms）
- 受信側の負荷や内部モニタリングの有無も体感に影響します（DAWのメータ/可視化を一時オフに）

## FAQ / トラブルシューティング
- node-midiのビルドに失敗します
   - Node.jsとOSの対応ビルドが必要です。Node 20+を推奨。再ビルド: `npm rebuild midi`。CI環境では`node-gyp`等のビルドツールが必要です。
- 出力ポートが見つかりません
   - `list_devices`でポート名を確認し、`portName`に部分一致/正確な名称を指定。macOSではIAC Driverを有効化してください。
- 再生しても音が出ません
   - 受信アプリ/音源のMIDIインプット接続、チャンネル（デフォルトは ch1。内部値では 0）、音源割当、モニタリングを確認。まず`dryRun:true`でイベント検出を確認。
- 再生がカクつく/遅延します
   - `schedulerLookaheadMs`を広げ、`schedulerTickMs`をやや大きく。CPU負荷が高いとタイマ精度が落ちるため、他の重い処理を避けて検証。
- ハングノートが発生します
   - `stop_playback`で全ノートオフを送出。発生原因として範囲再生の途中停止や受信側の処理落ちが考えられます。

## ライセンス
- 本プロジェクトは MIT License です。詳細はルートの `LICENSE` をご確認ください。
