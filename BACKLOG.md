# プロダクトバックログ - MCP MIDI TOOL

更新日: 2025-08-16

凡例: [ ] 未着手 / [~] 進行中 / [x] 完了 / [!] ブロック

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
- [ ] transform_midi: tempo変更/humanizeの追加
- [ ] エクスポート: 名前衝突回避と履歴
- [ ] メタ情報抽出の拡充（durationMs/ppq など）

## R3（運用）
- [ ] 観測性（構造化ログ、操作IDトレース、簡易メトリクス）
- [ ] 設定ファイル（config/）の導入

## R4（互換性）
- [ ] Windows/LinuxのMIDI出力対応

## リスク/ブロッカー
- CoreMIDI依存のためmacOS以外は未対応
- 大容量MIDIの処理時間

## 進捗メモ
- manifestを `manifest.<pid>.json` に分離し、`MCP_MIDI_MANIFEST` で上書き可能に。get_midiにインメモリフォールバックを追加し、並列テスト時の不整合を解消。
- playback_midi / stop_playback を最小スタブで実装し、TDD（RED→GREEN）で8/8テストGREEN。
- prompts/list / resources/list を実装し、Claude Desktop の tools/resources 探索と prompts 探索に応答。テストは9/9 GREEN。
- 次は CoreMIDI 連携の実装強化（実デバイス列挙）、エラーモデル共通化、SMF再生スケジューラのTDDへ進む。
 - v2プロンプトで実機検証: list_devices→playback_midi(durationMs=800, portName部分一致) で発音確認済み。音が出る手順（durationMs/デバイス選択）をドキュメント化。
 - 受信側セットアップ（IAC/DAW）の手順書とチェックリストを追加: `docs/setup/macos_coremidi_receiver.md`, `docs/checklists/receiver_setup_checklist.md`。検証レポートを `docs/reports/2025-08-16_receiver_setup.md` に記録。
