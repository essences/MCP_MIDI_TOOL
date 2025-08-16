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

最小JSON例（概略）:
```json
{
   "ppq": 480,
   "tracks": [
      { "events": [ { "type": "meta.tempo", "bpm": 120, "tick": 0 } ] },
      { "channel": 0, "events": [
         { "type": "program", "program": 0, "tick": 0 },
         { "type": "note", "note": 60, "velocity": 100, "tick": 0, "durationTicks": 960 }
      ]}
   ]
}
```

### 対応イベント一覧（現状）
- ノート: note（ON/OFF、velocity、durationTicks）
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
- list_devices: MIDI出力デバイス列挙
- playback_midi: 単音PoC再生（durationMsで長さ指定）
- play_smf: SMFを解析して再生（dryRun解析、範囲再生、スケジューラ）
- stop_playback: 再生停止（全ノート消音、タイマ解除、ポートクローズ）
- find_midi: 名前の部分一致検索
- get_playback_status: 再生進捗の取得（cursor/lastSentAt/総尺など）

戻り値はClaude互換の`content: [{type:'text', text: ...}]`を含みます。

### ツール詳細（入出力の要点）
- json_to_smf
   - 入力: `{ song: <JSON MIDI>, name?: string, overwrite?: boolean }`
   - 出力: `{ fileId, bytes, trackCount, eventCount }`
- smf_to_json
   - 入力: `{ fileId }`
   - 出力: `{ json: <JSON MIDI>, bytes, trackCount, eventCount }`
- play_smf（dryRun推奨→実再生）
   - 入力: `{ fileId, dryRun?: true|false, portName?: string, startMs?: number, stopMs?: number, schedulerLookaheadMs?: number, schedulerTickMs?: number }`
   - 出力: `dryRun:true` の場合 `{ scheduledEvents, totalDurationMs }` を返却。実再生時は `playbackId` を発行。
- get_playback_status
   - 出力: `{ playbackId, done, cursorMs, lastSentAt, totalDurationMs }`

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
- 確認ポイント: トラック入力 / モニタリング / 音源割当 / MIDIチャンネル（通常ch1=0）

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
- 大容量SMFはdryRunで件数や総尺を把握し、範囲再生（startMs/stopMs）を推奨
- 早期停止が見える場合は`get_playback_status`で進捗を確認し、スケジューラの窓/tickを調整
- `stop_playback`は全ノート消音とポートクローズを行います（ハングノート対策）

## FAQ / トラブルシューティング
- node-midiのビルドに失敗します
   - Node.jsとOSの対応ビルドが必要です。Node 20+を推奨。再ビルド: `npm rebuild midi`。CI環境では`node-gyp`等のビルドツールが必要です。
- 出力ポートが見つかりません
   - `list_devices`でポート名を確認し、`portName`に部分一致/正確な名称を指定。macOSではIAC Driverを有効化してください。
- 再生しても音が出ません
   - 受信アプリ/音源のMIDIインプット接続、チャンネル（デフォルトch1=0）、音源割当、モニタリングを確認。まず`dryRun:true`でイベント検出を確認。
- 再生がカクつく/遅延します
   - `schedulerLookaheadMs`を広げ、`schedulerTickMs`をやや大きく。CPU負荷が高いとタイマ精度が落ちるため、他の重い処理を避けて検証。
- ハングノートが発生します
   - `stop_playback`で全ノートオフを送出。発生原因として範囲再生の途中停止や受信側の処理落ちが考えられます。

## ライセンス
- 本リポジトリ内のコード/ドキュメントのライセンスはリポジトリの LICENSE に従います（未定義の場合は別途合意）。
