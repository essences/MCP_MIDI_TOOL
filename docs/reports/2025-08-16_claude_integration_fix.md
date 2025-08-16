# Claude Desktop 連携修正レポート（prompts/list 対応）

日付: 2025-08-16
担当: AgileAgent

## 背景
Claude Desktop から `prompts/list` が呼ばれた際にサーバが応答を返さず、`ZodError: invalid_union` が発生。併せて `tools/list` / `resources/list` は成功、まれに `EPIPE` により接続が落ちる事象も発生。

## 変更内容
- `src/index.ts`
  - initialize の `capabilities` に `prompts` / `resources` を明示
  - `prompts/list` に空配列を返す実装を追加
  - 参考: `prompts/get` は未提供のためエラー応答
- テスト
  - `tests/prompts_list.test.ts` を追加し `prompts/list` の応答を検証
- ドキュメント
  - `BACKLOG.md` に対応完了を追記

## 検証
- `npm run build && npm test` にて 9/9 GREEN
- 既存ツール (`tools/list`, `resources/list`) の回帰なし

## 期待効果
- Claude 側の探索フロー（tools/resources/prompts）で ZodError が解消
- `EPIPE` はクライアント切断に起因していたため、応答未実装がなくなり再発確率が低下

## 次の一手
- `list_devices` を node-midi で実デバイス列挙へ
- SMF のタイミング再生スケジューラーを TDD で実装
- エラーモデル/ログの共通化
