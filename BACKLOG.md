# プロダクトバックログ - MCP MIDI TOOL

更新日: 2025-08-17（優先順位を再評価）

凡例: [ ] 未着手 / [~] 進行中 / [x] 完了 / [!] ブロック

## 最優先（Next Up / Top 10）
1. [ ] R7: JSONスキーマ起草（`docs/specs/json_midi_schema_v1.md`・Zod型・順序ルール）
2. [ ] R7: ツール `json_to_smf { json, name? }`（検証→コンパイル→保存）
3. [ ] R7: ツール `smf_to_json { fileId }`（解析→JSON化）
4. [~] R6: TDD強化（固定テンポ/テンポ変化/停止/順序・totalDurationMs検証）
5. [ ] R3: 観測性（構造化ログ/共通エラーモデル/操作IDトレース）
6. [ ] R2: メタ情報抽出の拡充（durationMs/ppq/トラック数/イベント数）
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
- [ ] 仕様: `docs/specs/json_midi_schema_v1.md`（Zod型・順序ルール）
- [ ] ツール: `json_to_smf { json, name? }`（検証→コンパイル→保存）
- [ ] ツール: `smf_to_json { fileId }`（解析→JSON化）
- [ ] プロンプト: JSON生成→保存→dryRun→再生の手順書
- [ ] テスト: ラウンドトリップ（JSON→SMF→JSON）と代表イベント

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
