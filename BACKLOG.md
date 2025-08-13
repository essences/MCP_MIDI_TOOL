# プロダクトバックログ - MCP MIDI TOOL

更新日: 2025-08-14

凡例: [ ] 未着手 / [~] 進行中 / [x] 完了 / [!] ブロック

## R1（MVP）
- [x] MCPツール仕様を確定しドキュメント化（docs/specs/R1_requirements.md）
- [x] ディレクトリ作成（docs/specs, data/{midi,export}, src/）
- [x] 開発方針（TDD徹底）: 仕様→失敗するテスト→最小実装→リファクタ→コミットのサイクルを徹底し、必ずテストが緑になってから次へ進む
- [x] 接続スケルトン（機能なし）: MCPサーバーがクライアントから接続可能であることをテスト（tests/connection.test.ts）で保証
- [ ] ストレージ層: data/ と manifest 管理実装
- [ ] ツール: store_midi（保存とfileId発行）
- [ ] ツール: get_midi（取得、base64同梱オプション）
- [ ] ツール: list_midi（ページング）
- [ ] ツール: export_midi（data/exportへの出力）
- [ ] ツール: list_devices（CoreMIDI列挙）
- [ ] ツール: playback_midi（再生、portName任意）
- [ ] ツール: stop_playback（停止）
- [ ] ツール: transform_midi（transpose/quantize）
- [ ] ログ/エラーモデルの共通化
- [ ] 最小テスト（ユニット/結合）

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
- 接続スケルトンまで完了（テスト緑）。次は store_midi をTDDで実装開始：
	1) 失敗するテスト（tools/call: store_midi → 未実装エラー）
	2) 最小実装（Base64保存・fileId発行・manifest更新）
	3) リファクタ＆境界テスト（10MB制限、拡張子、name省略時の命名）
