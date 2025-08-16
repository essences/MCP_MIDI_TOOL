# MCP MIDI TOOL

非AI・決定論的なMCPスタンドアロンサーバー。MIDIファイルの保存/取得/一覧/書き出しに加え、ノート送出とSMF(Standard MIDI File)の再生を提供します。Claude Desktop等のMCPクライアントからの操作を前提に、TDDで実装・検証しています。

- ランタイム: Node.js 20+ / TypeScript ESM
- I/O: [node-midi](https://www.npmjs.com/package/midi)（RtMidi）を動的に使用（利用不可環境ではサイレントフォールバック）
- SMF解析: [@tonejs/midi](https://www.npmjs.com/package/@tonejs/midi)

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

## Claudeでの検証手順（推奨）
- 単音スモーク＆基本操作: `docs/prompts/claude_test_prompts_v2.md`
- SMF再生（dryRun→実再生→停止）: `docs/prompts/claude_test_prompts_v3_play_smf.md`
- 8秒の継続音SMFでE2E検証: `docs/prompts/claude_test_prompts_v4_continuous_8s.md`
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

## 受信側（音が出ない時）
- macOSの例: `docs/setup/macos_coremidi_receiver.md`
- チェックリスト: `docs/checklists/receiver_setup_checklist.md`
- 確認ポイント: トラック入力 / モニタリング / 音源割当 / MIDIチャンネル（通常ch1=0）

## クロスプラットフォーム
- 目標: macOS(CoreMIDI) / Windows(MME) / Linux(ALSA)
- 依存: node-midi のネイティブビルドに依存（OS/Nodeバージョン注意）
- ADR: `docs/adr/ADR-0001-node-midi-adoption.md`

## 開発
- TDDで進行。Vitestなどでユニット/結合テスト（`npm test`）
- コード: `src/index.ts`, `src/storage.ts`
- 仕様/バックログ: `docs/specs/*`, `BACKLOG.md`

## 既知の制限/注意
- 大容量SMFはdryRunで件数や総尺を把握し、範囲再生（startMs/stopMs）を推奨
- 早期停止が見える場合は`get_playback_status`で進捗を確認し、スケジューラの窓/tickを調整
- `stop_playback`は全ノート消音とポートクローズを行います（ハングノート対策）

## ライセンス
- 本リポジトリ内のコード/ドキュメントのライセンスはリポジトリの LICENSE に従います（未定義の場合は別途合意）。
