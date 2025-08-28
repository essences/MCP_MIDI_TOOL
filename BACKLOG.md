# プロダクトバックログ - MCP MIDI TOOL

更新日: 2025-08-27（構造化エラー・autoCcPresets・デバイス入力キャプチャ・継続MIDI記録機能追加）

凡例: [ ] 未着手 / [~] 進行中 / [x] 完了 / [!] ブロック

## 最優先（Next Up / Top 10）
1. [x] R7: JSONスキーマ起草（`docs/specs/json_midi_schema_v1.md`・Zod型・順序ルール（初版））
2. [x] R7: ツール `json_to_smf { json, name? }`（検証→コンパイル→保存｜最小エンコーダ＋メトリクス）
3. [x] R7: ツール `smf_to_json { fileId }`（解析→JSON化｜最小機能＋メトリクス｜tempo/timeSig/keySig/marker/trackName/cc/pb/program/notes）
4. [~] R6: TDD強化（固定テンポ/テンポ変化/停止/順序・totalDurationMs検証｜継続）
5. [x] R7: ツール `append_to_smf`（追記合成: atEnd/atTick/gapTicks/trackIndex｜README＋E2Eテスト）
6. [x] R7: `json_to_smf` に format 明示パラメータを導入（`json_midi_v1`/`score_dsl_v1`）＋README更新＋テスト
7. [x] R7: ツール `insert_sustain`（CC64のON/OFFを範囲挿入｜チャンネル/トラック継承・明示指定両対応｜README＋E2E）
8. [x] R7: ツール `insert_cc`（任意CCの2値レンジ挿入｜README＋E2E）
9. [~] **R9: 継続MIDI記録機能**（Phase1-3完了・Phase4進行中: 高度機能・観測性）
10. [x] R3: 構造化エラー分類・レスポンス統一（VALIDATION_ERROR/NOT_FOUND等）
11. [ ] R4: CIで各OSのビルドとdryRunスモーク（macOS/Windows/Linux）
12. [ ] R4: Windows/Linux のデバイス列挙・出力の実機検証
13. [ ] R2: transform_midi（最小: transpose → 次: quantize/tempo/humanize）

## R1（MVP）
- [x] MCPツール仕様を確定しドキュメント化（docs/specs/R1_requirements.md）
- [x] ディレクトリ作成（docs/specs, data/{midi,export}, src/）
- [x] 開発方針（TDD徹底）: 仕様→失敗するテスト→最小実装→リファクタ→コミットのサイクルを徹底し、必ずテストが緑になってから次へ進む
- [x] 接続スケルトン（機能なし）: MCPサーバーがクライアントから接続可能であることをテスト（tests/connection.test.ts）で保証
 - [x] ストレージ層: data/ と manifest 管理実装（manifestのプロセス分離・ENV上書き対応、storage.ts集約も完了）
- [x] ツール: store_midi（保存とfileId発行）
 - [x] ツール: get_midi（取得、base64同梱オプション）
- [x] ツール: list_midi（ページング）
- [x] ツール: export_midi（data/exportへの出力）
- [x] ツール: list_devices（CoreMIDI列挙）
- [x] ツール: playback_midi（再生、portName任意｜最小スタブ）
- [x] ツール: stop_playback（停止｜最小スタブ）
- [x] クライアント互換: tools/list / resources/list / prompts/list 応答を実装し、Claude Desktop の探索フェーズでの ZodError を解消
- [ ] ツール: transform_midi（transpose/quantize）
- [ ] ログ/エラーモデルの共通化
- [x] 最小テスト（ユニット/結合）
 - [x] README拡充（JSONファースト、ツールI/O、クイックフロー、イベント一覧、FAQ、MCP呼び出し例、メトリクス解説）

## R2（拡張）
- [ ] メタ情報抽出の拡充（durationMs/ppq/トラック数/イベント数）
- [ ] エクスポート: 名前衝突回避と履歴
- [ ] transform_midi: transpose → quantize → tempo変更/humanize の順で段階実装

## R3（運用）
- [ ] 観測性（構造化ログ、操作IDトレース、簡易メトリクス）
- [ ] 設定ファイル（config/）の導入

## R4（互換性 / クロスプラットフォーム化）
- [~] node-midi 採用で CoreMIDI/MME/ALSA を共通抽象化
- [ ] CIで各OSビルド・最小再生スモークを追加
- [ ] Windows/Linux のデバイス列挙と出力を実機で検証

## R6（実装: SMFプレイバック）
- [x] 依存導入: `midi`, `@tonejs/midi`
- [x] ツール追加: `play_smf { fileId, portName?, startMs?, stopMs?, dryRun?, schedulerLookaheadMs?, schedulerTickMs? }`
- [x] 変換: SMF→イベント列（tMs付与・テンポ変化対応）
- [x] 送出: ルックアヘッド型スケジューラ（未消音ノート管理）
- [x] 停止: `stop_playback` で全ノート消音/タイマ解除
- [~] TDD: 固定テンポ/テンポ変化/停止/順序のテスト（継続強化）
- [x] スモーク: きらきら星/8秒継続SMFで store_midi→play_smf を再生
- [x] プロンプト: v5（ネットDL→Bach 3声インベンション→dryRun→再生→停止）
 - [x] 追記: `append_to_smf` 実装・E2Eで atEnd/atTick/gapTicks を検証（追記後のイベント位置と総尺を検査）

## R7（JSONファースト: 作曲/編集）
- [x] ADR: JSONファースト採用（`docs/adr/ADR-0002-json-first-composition.md`）
- [x] 仕様: `docs/specs/json_midi_schema_v1.md`（Zod型・順序ルール・初版）
- [x] ツール: `json_to_smf { json, name? }`（検証→コンパイル→保存｜最小エンコーダ）
- [x] ツール: `smf_to_json { fileId }`（解析→JSON化｜最小機能）
- [x] ツール: `append_to_smf`（既存SMFへJSON/Score DSLチャンクを追記）
- [x] 明示指定: `format: "json_midi_v1"|"score_dsl_v1"` の厳密分岐を導入し、READMEのサンプルも更新
- [x] ツール: `insert_sustain`（CC64 ON/OFF の範囲挿入）。READMEに使用例と注意を追記
- [ ] プロンプト: JSON生成→保存→dryRun→再生の手順書（insert_sustain/append_to_smfを含む応用編）
- [~] テスト: ラウンドトリップ（JSON→SMF→JSON）と代表イベント（note/cc/pitchBend/program/timeSigは済、keySig/aftertouchは未）
- [x] デコード拡充: keySignature（meta.keySignature）
 - [x] JSON入力: ノート音名 `note: "C4"` 等の受け付け（エンコード時にMIDI番号へ変換、デコード時は `pitch` と `note` を併記）
- [ ] イベント拡充: aftertouch.channel / aftertouch.poly（エンコード/デコード）

## R8（音楽記法レイヤー: Score DSL v1）
- [x] 仕様: `docs/specs/score_dsl_v1.md`（小節/拍/音価/アーティキュレーション/拍子・キー/テンポ）
- [x] スキーマ: `src/scoreSchema.ts`（Zod: Position/DurationSpec/Articulation 等）
- [x] 変換: `src/scoreToJsonMidi.ts`（Position/Duration→tick, articulation/dynamic/tie/slur マッピング）
- [x] ツール: `json_to_smf` の受理拡張（Score DSL v1をフォールバックでコンパイル）
- [~] テスト: 音価（付点/連符）・アーティキュレーション・tie/slur・メタ（timeSig/keySig/tempo）
	- [x] 統合: `json_to_smf` が Score DSL を受理（オブジェクト/JSON文字列の両方）する統合テストを追加
	- [~] 追加ケース: 小節またぎ/メタ変化混在/丸め累積±1tick/複合アーティキュレーション
- [x] ドキュメント: README 追記と `docs/prompts/claude_test_prompts_v8_score_dsl.md` 追加
	- [x] レポート: `docs/reports/2025-08-17_score_dsl_fallback_fix.md`（DSLフォールバック不具合の原因/対処/検証）
 - [x] 注意書き: 全音符は "1"（"1/1"は無効）を明記
 - [x] autoCcPresets実装: `sustain_from_slur`（slur/legato→CC64自動付与）、`crescendo_to_expression`（dynamic変化→CC11ランプ）

### 補助
- [x] スモーク: `scripts/mcp_smoke_e2e_score_dsl.mjs`（Score DSL→json_to_smf→play_smf(dryRun)→smf_to_json）

## R9（継続MIDI記録機能）

### Phase 1: 基本記録セッション管理 ✅ **完了**
- [x] **セッション基盤**: 記録セッション管理クラス・レジストリ設計（ContinuousRecordingSession）
  - recordingId生成（UUID v4）・状態管理（waiting_for_input/recording/completed等7状態）
  - メモリ内イベントバッファ・tick基準時間変換ロジック・セッションレジストリ実装
- [x] **ツール**: `start_continuous_recording`（継続演奏キャプチャ開始）
  - 入力スキーマ: portName?, ppq?, maxDurationMs?, idleTimeoutMs?, silenceTimeoutMs?, channelFilter?, eventTypeFilter?
  - 出力: recordingId, portName, ppq, タイムアウト設定値, startedAt, status
  - MIDI入力ポート開放・node-midiコールバック設定・パラメータ検証実装
- [x] **ツール**: `get_continuous_recording_status`（記録状況監視）
  - 入力: recordingId（必須）
  - 出力: status, durationMs, eventCount, eventBreakdown, channelActivity, timeUntilTimeout, estimatedFileSizeBytes
  - リアルタイム進捗メトリクス計算・状態遷移チェック・timeUntilTimeout計算実装

### Phase 2: タイムアウト制御・自動終了 ✅ **完了**
- [x] **タイマー管理**: 3種類のタイムアウト実装
  - idleTimeoutMs: 記録開始→初回入力待機（デフォルト30秒、テスト用に最小1秒に調整）
  - silenceTimeoutMs: 最終入力→無音継続自動終了（デフォルト10秒、テスト用に最小1秒に調整）
  - maxDurationMs: 記録全体最大時間（デフォルト5分、テスト用に最小1秒に調整）
- [x] **状態遷移**: 自動終了ロジック・reason設定（idle_timeout/silence_timeout/max_duration）
  - setTimeout コールバック実装・セッションレジストリ同期・reason フィールド設定修正
- [x] **テスト完了**: タイムアウトテスト4件全合格（idle/maxDuration/cleanup/calculation精度）
  - 状態遷移確認・reason値検証・タイマークリーンアップ・timeUntilTimeout計算精度確認

### Phase 3: 手動終了・ファイル保存 ✅ **完了**
- [x] **ツール**: `stop_continuous_recording`（手動終了・SMF生成保存）
  - 入力: recordingId（必須）, name?, overwrite?
  - 出力: fileId, name, path, bytes, durationMs, eventCount, ppq, trackCount, reason, タイムスタンプ各種
  - 既存のjson_to_smfパイプライン活用（tick基準JSON MIDI → SMF）・レジストリクリーンアップ実装
- [x] **自動保存**: タイムアウト発生時の自動SMF生成・fileId発行・manifest更新
  - 3種類タイムアウト（idle/silence/maxDuration）すべてで自動SMF保存実装・非同期エラーハンドリング付き
- [x] **ファイル命名**: `recording-YYYY-MM-DD-HHmmss.mid` 既定・name指定対応・重複回避
  - タイムスタンプベース命名・重複検出・番号付きファイル名生成・overwrite対応実装

### Phase 4: 高度機能・観測性
- [ ] **ツール**: `list_continuous_recordings`（セッション一覧・デバッグ用）
  - 入力: status? (active/completed/all), limit?
  - 出力: recordings配列, total, activeCount, completedCount
- [ ] **フィルタリング**: channelFilter（1-16配列）, eventTypeFilter（note/cc/pitchBend/program配列）
- [ ] **マルチセッション**: 最大3セッション同時記録・セッション間分離・リソース管理
- [ ] **メモリ管理**: イベント数上限（100K）・セッションあたりメモリ制限（10MB）・24時間自動削除

### 技術統合・活用既存資産 ✅ **完了（Phase1-3）**
- [x] **node-midi統合**: 既存のloadMidi()・MidiInput活用・single_captureのデバイス処理参考
- [x] **タイミング**: single_captureの時間計算ロジック拡張（Date.now()基準→tick変換）
- [x] **JSON→SMF変換**: 既存のjson_to_smf・encodeToSmfBinary活用
- [x] **構造化エラー**: 既存のclassifyError・エラーコード体系（DEVICE_UNAVAILABLE/NOT_FOUND等）活用
- [x] **ストレージ**: 既存のappendItem・storage.ts・manifest管理活用

### テスト・品質保証
- [x] **基本機能**: 短時間記録（10秒）・各種タイムアウト・手動終了・ファイル生成確認
  - Phase1-3テスト完了: 基本3件・タイムアウト4件・手動終了3件・自動保存3件・全68テスト合格（2025-08-28）
  - 手動終了SMF生成・重複回避・overwrite・デフォルトファイル名生成・自動保存動作確認済み
- [ ] **エラー処理**: 無効recordingId・デバイス未接続・パラメータ検証・同時セッション上限
- [ ] **パフォーマンス**: 長時間記録（5分）・高頻度イベント・メモリリーク防止・CPU負荷測定
- [ ] **統合**: 既存ツールとの連携（保存後にplay_smf実行・smf_to_jsonラウンドトリップ確認）

### ドキュメント・ユーザビリティ
- [ ] **README更新**: 継続記録セクション追加・使用例・パラメータ詳細・エラー対処法
- [ ] **プロンプト**: claude_test_prompts_continuous_recording.md（記録開始→監視→終了→再生フロー）
- [ ] **仕様参照**: 実装時に docs/specs/continuous_midi_recording_interface_spec.md 準拠確認

### リスク・制約事項
- **同時セッション制限**: 3セッション・デバイス競合回避
- **メモリ使用量**: セッション10MB・イベント100K上限・段階的制限実装
- **タイミング精度**: JavaScriptタイマー精度限界・node-midiコールバック遅延考慮
- **プラットフォーム**: Windows/Linux実機検証は後続（macOS CoreMIDI優先）

## リスク/ブロッカー
- node-midi のネイティブビルドがOS/Nodeバージョンに依存
- 大容量MIDIの処理時間

## 進捗メモ
- manifestを `manifest.<pid>.json` に分離し、`MCP_MIDI_MANIFEST` で上書き可能に。get_midiにインメモリフォールバックを追加し、並列テスト時の不整合を解消。
- playback_midi / stop_playback を最小スタブで実装し、TDD（RED→GREEN）で8/8テストGREEN。
- prompts/list / resources/list を実装し、Claude Desktop の tools/resources 探索と prompts 探索に応答。テストは9/9 GREEN。
- 次は CoreMIDI 連携の実装強化（実デバイス列挙）、エラーモデル共通化、SMF再生スケジューラのTDDへ進む。
 - v2プロンプトで実機検証: list_devices→playback_midi(durationMs=800, portName部分一致) で発音確認済み。音が出る手順（durationMs/デバイス選択）をドキュメント化。
 - 受信側セットアップ（IAC/DAW）の手順書とチェックリストを追加: `docs/setup/macos_coremidi_receiver.md`, `docs/checklists/receiver_setup_checklist.md`。検証レポートを `docs/reports/2025-08-16_receiver_setup.md` に記録。
 - 再生ライブラリ調査を追加: `docs/research/midi_playback_libraries.md`（案A: midi+@tonejs/midi+自作スケジューラ / 案B: JZZ+jzz-midi-smf）。
 - 方針決定: `node-midi` を採用し、@tonejs/midi と自作スケジューラでSMF再生を実装。クロスプラットフォーム（macOS/CoreMIDI, Windows/MME, Linux/ALSA）を目標。
 - R6着手: `play_smf` ツールを追加（@tonejs/midiでSMF解析→イベント生成）。dryRun対応、実再生はルックアヘッド型スケジューラ（未消音ノート管理）。`stop_playback` を強化（タイマ解除・全ノート消音・ポートクローズ）。
 - JSONファースト採用（ADR-0002）。JSON→SMF/SMF→JSON の双方向ツールをR7で実装予定。
 - 変換メトリクス（bytes/trackCount/eventCount）を json_to_smf / smf_to_json の応答に追加しテストGREEN。READMEに観測ポイント/メトリクス解説とイベント対応一覧、MCP呼び出し例、ラウンドトリップ保証範囲を追記。
 - `append_to_smf` を実装し、E2Eで atEnd/gapTicks と atTick の双方をGREENに。Score DSL と JSON MIDI v1 の混在追記もドキュメント化。
 - `json_to_smf` に format 明示を入れ、誤検出を防止。READMEのサンプルもformatを明記。
 - `insert_sustain` を実装。最初の音源トラック/チャンネルの継承を既定とし、レンジごとに CC64(127/0) を挿入。E2Eで0..720tickのON/OFFを確認しGREEN。
 - `insert_sustain` のE2Eを拡充（複数レンジ/重なり/外部ch(1-16)マッピング/同tick境界/任意値）。READMEに同tick/半踏みの注意を追記。
 - `insert_cc` を実装し、Expression(CC11)の範囲挿入テストを追加。READMEに使用例と注意を追記。
 - **R9 継続MIDI記録 Phase1-3完了**: 基本→タイムアウト→手動終了・SMF保存の完全実装（2025-08-28）
   - Phase1: start_continuous_recording・get_continuous_recording_status・基本セッション管理
   - Phase2: 3種類タイムアウト（idle/silence/maxDuration）・状態遷移・reason設定・setTimeout callbacks修正
   - Phase3: stop_continuous_recording・自動SMF保存・ファイル命名・重複回避・overwrite対応
   - テスト完了: 基本3件・タイムアウト4件・手動終了3件・自動保存3件・全68テスト合格

### 次の改善（テスト駆動）
- **R9 Phase4**: list_continuous_recordings ツール・マルチセッション・メモリ管理・観測性機能実装
- **R4**: CIで各OSビルド・Windows/Linux実機検証・クロスプラットフォーム対応強化
- **R2**: transform_midi（transpose→quantize→tempo変更→humanize）の段階実装
- insert_sustain: 複数レンジ・重なりレンジ・境界tick（0/終端/同tickON/OFF）・明示channel/trackIndexの各ケースを追加テスト
- insert_sustain: 外部チャンネル表記(1-16)パラメータ受理の検討（内部0-15へ変換）と互換ガイド
- CCユーティリティ化: 任意のCC番号/値ペアをレンジ/リストで挿入する汎用ツール（`insert_cc`）の設計
- Score DSL: slur/legato→CC64補助の自動化（オプションスイッチ）、および衝突時の優先規則の定義
