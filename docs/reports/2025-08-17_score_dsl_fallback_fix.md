# Score DSL → json_to_smf フォールバック不具合 修正レポート (2025-08-17)

## 概要
- 現象: `json_to_smf` に Score DSL v1 を渡した際、`json validation failed (or score compile failed)` として JSON MIDI v1 の検証エラー（`tick: Required`, `duration: Expected number` 等）が返る。
- 影響: Claude用プロンプト v8 の手順 S-2 が失敗する場合がある。

## 原因
- 一部クライアントが `arguments.json` を「オブジェクト」ではなく「文字列(JSON文字列)」として送信するケースがあり、サーバー側で JSON MIDI v1 の zod 検証に直接かけて失敗し、Score DSL フォールバックまで到達しない可能性があった。
- また、エラーメッセージが JSON MIDI v1 側の検証エラーのみを集約しており、Score DSL コンパイル/再検証の失敗内容が見えづらかった。

## 対応
1) サーバーの `json_to_smf` にて、`arguments.json` が string の場合は `JSON.parse` を試行する前処理を追加。
2) Score DSL フォールバック経路のエラーハンドリングを強化し、
   - 元JSONの検証エラー
   - フォールバック後の JSON MIDI 再検証エラー
   を併記して詳細化。
3) 統合テストを追加: `tests/score_dsl_json_to_smf_integration.test.ts`
   - オブジェクト入力と文字列入力の双方で SMF 保存が成功することを確認。

## 変更ファイル
- src/index.ts
  - `json` が string の場合の自動 `JSON.parse`
  - フォールバック時の詳細なエラーメッセージ
- tests/score_dsl_json_to_smf_integration.test.ts（新規）

## 検証
- 単体/統合テスト:
  - Score DSL 統合テスト: 2件 PASS
  - 既存テスト: フルスイート PASS（環境出力の都合でログ一部抑制あり）
- E2E（手動）: Claude v8 プロンプト手順 S-2 再実行にて保存成功を確認（要クライアント側再試行）

## 実行手順（参考）
- テストのみ: `npx vitest run tests/score_dsl_json_to_smf_integration.test.ts`
- 全テスト: `npx vitest run`

## コミット
- fix(server): json_to_smf accepts Score DSL when json is string; improve error detail; add DSL integration tests

## 今後のフォロー
- v8 プロンプトに「`json` はオブジェクト/文字列どちらでも可」を注意書きで明記（必要なら追記）。
- 追加ケース（小節またぎ、テンポ/拍子/キー変化混在、連続スラー/タイ）の統合テスト拡充。
