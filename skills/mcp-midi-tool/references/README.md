# Portable MCP MIDI TOOL Skill

このフォルダは、`MCP MIDI TOOL` の主要機能とフルツール面を、単体で持ち運べるようにまとめたポータブルスキルです。

外部のMCP設定は不要です。`skills/mcp-midi-tool/` をコピーし、このフォルダ内で依存関係を入れれば使えます。

## できること

- JSON MIDI v1 から SMF を生成
- Score DSL v1 から SMF を生成
- 既存 SMF を JSON へ変換
- CC64 や任意 CC の挿入
- 小節抽出、置換、追記
- SMF の dry-run 解析
- MIDI 出力ポートへの演奏
- デバイス列挙
- 元のMCPツール一式のローカル呼び出し

## フォルダ構成

- `SKILL.md`: Codex 用のスキル定義
- `package.json`: このスキル単体の依存関係
- `lib/`: 実行コード
- `scripts/`: そのまま使えるスクリプト
- `references/`: 仕様や補足ドキュメント
- `data/midi/`: 生成されたMIDI
- `data/export/`: 書き出し先
- `data/manifest.json`: 管理対象ファイル一覧

## 初回セットアップ

前提:

- Node.js 20 以上
- macOS で直接再生する場合は CoreMIDI が使えること
- MIDI を受けるアプリや IAC ドライバなど、出力先が存在すること

手順:

```bash
cd skills/mcp-midi-tool
npm install
```

初回確認:

```bash
node scripts/list_all_tools.mjs
```

これでツール一覧が出れば、ポータブルスキルとしての起動系は問題ありません。

## すぐ試す

### 1. 短い曲を作って dry-run 解析

```bash
node scripts/direct_compose_and_analyze.mjs
```

### 2. 短い曲を作って再生

```bash
PORT_NAME="IACドライバ バス1" node scripts/direct_compose_and_play.mjs
```

`PORT_NAME` を省略した場合はスクリプト内の既定値を使います。

### 3. 既存 fileId の内容を確認

```bash
FILE_ID="<file-id>" node scripts/direct_file_summary.mjs
```

### 4. サスティンを自動補正

```bash
FILE_ID="<file-id>" node scripts/direct_inspect_and_fix_sustain.mjs
```

## 2つの実行経路

このスキルには2系統あります。

### 軽量API

`lib/directApi.js` を直接使う経路です。軽い処理を簡単に呼ぶ用途です。

主な対象:

- `saveSongAsSmf`
- `loadSmfAsJson`
- `insertSustainRanges`
- `insertControllerRanges`
- `analyzeSmfDryRun`
- `exportMidiFile`

### フルツール面

`lib/index.js` を `lib/localToolClient.mjs` 経由で呼ぶ経路です。元のMCPツール面をローカルに閉じたまま使います。

主な対象:

- `append_to_smf`
- `extract_bars`
- `replace_bars`
- `play_smf`
- `trigger_notes`
- `list_devices`
- `start_continuous_recording`
- そのほか元の全ツール

## 汎用ツール呼び出し

任意の元ツールを呼ぶには `scripts/run_tool.mjs` を使います。

例: 一覧を見る

```bash
TOOL_NAME=list_midi \
TOOL_ARGS_JSON='{"limit":10,"offset":0}' \
node scripts/run_tool.mjs
```

例: dry-run 再生解析

```bash
TOOL_NAME=play_smf \
TOOL_ARGS_JSON='{"fileId":"<file-id>","dryRun":true}' \
node scripts/run_tool.mjs
```

例: デバイス列挙

```bash
TOOL_NAME=list_devices \
TOOL_ARGS_JSON='{}' \
node scripts/run_tool.mjs
```

## よく使うスクリプト

- `scripts/list_all_tools.mjs`
  - フルツール面の一覧を表示
- `scripts/run_tool.mjs`
  - 任意ツールを名前指定で実行
- `scripts/direct_compose_and_analyze.mjs`
  - 曲生成 + dry-run
- `scripts/direct_compose_and_play.mjs`
  - 曲生成 + 実再生
- `scripts/direct_file_summary.mjs`
  - fileId の概要確認
- `scripts/direct_inspect_and_fix_sustain.mjs`
  - サスティン補正
- `scripts/test_continuous_recording.mjs`
  - 単独の継続録音テスト
- `scripts/play_and_record_together.mjs`
  - 再生と録音を同時に走らせ、同期確認用の状態を出力

## 環境変数

- `MCP_MIDI_BASE_DIR`
  - データ保存先ルートを上書き
- `MCP_MIDI_MANIFEST`
  - manifest ファイル名を上書き
- `FILE_ID`
  - 対象MIDIファイルID
- `PORT_NAME`
  - 再生やノート出力のポート名ヒント
- `TOOL_NAME`
  - `run_tool.mjs` で呼ぶツール名
- `TOOL_ARGS_JSON`
  - `run_tool.mjs` に渡す JSON 文字列

既定ではこのスキルフォルダ自身をベースとして使います。

- `data/midi`
- `data/export`
- `data/manifest.json`

## 初めて使う人向けの流れ

1. `npm install`
2. `node scripts/list_all_tools.mjs`
3. `node scripts/direct_compose_and_analyze.mjs`
4. `TOOL_NAME=list_devices TOOL_ARGS_JSON='{}' node scripts/run_tool.mjs`
5. MIDI受け先を準備して `PORT_NAME=... node scripts/direct_compose_and_play.mjs`

この順でやれば、依存関係、ツール面、生成、デバイス、再生まで段階的に確認できます。

## 再生しながら録音

同一の bundled server プロセス内で `play_smf` と `start_continuous_recording` を動かす専用スクリプトがあります。

```bash
PLAY_FILE_ID="<play-file-id>" \
PLAY_PORT_NAME="IACドライバ バス1" \
RECORD_PORT_NAME="KeyLab 61 mk3 MIDI" \
node scripts/play_and_record_together.mjs
```

主な環境変数:

- `PLAY_FILE_ID`
- `PLAY_PORT_NAME`
- `RECORD_PORT_NAME`
- `OUTPUT_NAME`
- `PRE_ROLL_MS`
- `POST_ROLL_MS`

このスクリプトは「同一プロセス内での開始協調」は行いますが、DAWのようなサンプル精度同期を保証するものではありません。

## トラブルシュート

### `fileId not found`

- `data/manifest.json` に対象 `fileId` が入っているか確認してください。
- `MCP_MIDI_BASE_DIR` を変えている場合、見ている `data/` が別になっている可能性があります。

### 再生できない

- `list_devices` でポートが見えているか確認してください。
- `PORT_NAME` が実在ポート名に一致しているか確認してください。
- macOS では IAC ドライバや受け先アプリの起動が必要です。

### `npm install` 後も `midi` が使えない

- `node-midi` は環境依存です。CoreMIDI やネイティブ依存が壊れていると出力系だけ失敗することがあります。
- その場合でも JSON/SMF 変換系は多くが利用可能です。

### 古い `manifest.<pid>.json` が残っている

- これは旧テストの名残で、現在の既定運用は `manifest.json` です。
- 不安なら不要ファイルとして整理して構いません。

## 参考ドキュメント

- `references/composition_workflow.md`
- `references/score_dsl_v1.md`
- `references/json_midi_schema_v1.md`

## 備考

この README は、元リポジトリ全体の README ではなく、ポータブルスキル単体の利用説明です。
