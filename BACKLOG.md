# プロダクトバックログ - MCP MIDI TOOL

更新日: 2025-08-17（優先順位を再評価｜README拡充・メトリクス反映済み）

凡例: [ ] 未着手 / [~] 進行中 / [x] 完了 / [!] ブロック

## 最優先（Next Up / Top 10）
1. [x] R7: JSONスキーマ起草（`docs/specs/json_midi_schema_v1.md`・Zod型・順序ルール（初版））
2. [x] R7: ツール `json_to_smf { json, name? }`（検証→コンパイル→保存｜最小エンコーダ＋メトリクス）
3. [x] R7: ツール `smf_to_json { fileId }`（解析→JSON化｜最小機能＋メトリクス｜tempo/timeSig/keySig/marker/trackName/cc/pb/program/notes）
4. [~] R6: TDD強化（固定テンポ/テンポ変化/停止/順序・totalDurationMs検証｜継続）
5. [ ] R3: 観測性（構造化ログ/共通エラーモデル/操作IDトレース）※変換メトリクスは実装済み
6. [~] R2: メタ情報抽出の拡充（ppq/トラック数/イベント数/bytesは実装済み、totalDurationMsはplay_smf(dryRun)で返却）
7. [ ] R2: エクスポートの名前衝突回避と履歴（連番/ハッシュ）
8. [ ] R4: CIで各OSのビルドとdryRunスモーク（macOS/Windows/Linux）
9. [ ] R4: Windows/Linux のデバイス列挙・出力の実機検証
10. [ ] R2: transform_midi（最小: transpose → 次: quantize/tempo/humanize）

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

## R7（JSONファースト: 作曲/編集）
- [x] ADR: JSONファースト採用（`docs/adr/ADR-0002-json-first-composition.md`）
- [x] 仕様: `docs/specs/json_midi_schema_v1.md`（Zod型・順序ルール・初版）
- [x] ツール: `json_to_smf { json, name? }`（検証→コンパイル→保存｜最小エンコーダ）
- [x] ツール: `smf_to_json { fileId }`（解析→JSON化｜最小機能）
- [ ] プロンプト: JSON生成→保存→dryRun→再生の手順書
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
- [x] ドキュメント: README 追記と `docs/prompts/claude_test_prompts_v8_score_dsl.md` 追加

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
