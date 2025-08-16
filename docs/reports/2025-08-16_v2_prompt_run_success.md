# v2 Prompts Run Report (2025-08-16)

ユーザーが v2 テスト用プロンプト集に従い、音が出るまでの手順を含む全工程を完了。結果を要約。

## 要点
- デバイス: IAC Driver Bus 1（portName="IAC" の部分一致で選択）
- 再生: durationMs=800 で C4 を送出し、発音確認。
- 停止: stop_playback で停止成功。
- そのほか: store/get/list/export/find すべて期待通り。

## ログ抜粋
- FILE_ID_1: b296725b-280e-471f-8742-c72dfdbabba2
- PB_ID_1: 5f3ccb2d-03b0-4670-b33f-70011f309ec7
- exportPath: data/export/test_c4_note.mid

## 備考
- 最新の twinkle 検索で items[0] が既存IDを指すケースあり。find_midiは「最新が末尾」になるため、最新は配列末尾（または createdAt 最大）として選択すると安全。

Prepared by: AgileAgent (GitHub Copilot)
