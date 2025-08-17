# Claude テストプロンプト v9（trigger_notes: 単発発音・和音対応・高速ワンショット）

このプロンプトは、耳トレ/聴音用途の単発発音ツール `trigger_notes` を検証します。音名/数値ノート、transpose、velocity、durationMs、program、portName、dryRun の動作を確認します。

---

## 貼り付け用
以下をそのままClaudeに送信してください。

```
あなたはMCPクライアントです。以下の手順を順に実行し、各ステップの「使用ツール/引数/主要戻り値/所見」を簡潔に1-3行で要約してください。

[準備（イニシャライズ）]
- ツール一覧を取得し、trigger_notes / list_devices / get_playback_status / stop_playback があるか確認。

[パートT: trigger_notes（ドライラン→実送出→異常系）]
T-1) 単音・ドライラン: { notes:["C4"], velocity:96, durationMs:150, dryRun:true }
  - 期待: ok, scheduledNotes=1, durationMs=150。

T-2) 和音・ドライラン（音名）: { notes:["C4","E4","G4"], durationMs:200, dryRun:true }
  - 期待: scheduledNotes=3。

T-3) 和音・ドライラン（数値+transpose）: { notes:[60,64,67], transpose:12, dryRun:true }
  - 期待: scheduledNotes=3（+12半音の指定が受理されること）。

T-4) 実送出（デバイスがある場合のみ）:
  1) list_devices で候補取得。IAC/Network/Virtual を優先、無ければ先頭を選択。
  2) trigger_notes を実行: { notes:["C4","E4","G4"], velocity:100, durationMs:250, channel:0, program:0, portName:"<選択名>" }
  3) 直後に get_playback_status（playbackId指定）→ 0.3秒待機 → stop_playback。
  - 期待: playbackId取得、get_playback_statusで進捗とdoneが確認できる。

T-5) 異常系（入力バリデーション）: { notes:["H4"], dryRun:true } など不正音名/型で実行。
  - 期待: エラー応答（invalid note name など）。

[出力フォーマット]
- ステップごとに箇条書きで「使用ツール/引数/主要戻り値(scheduledNotes, durationMs, playbackId等)/所見」を1-3行で。
- 総括として、成功件数/エラー件数、代表的な scheduledNotes/durationMs を数値で再掲。
```

---

## 注意
- 実送出はポートがある場合のみ。まずは dryRun で件数/所要ミリ秒を確認してから実送出してください。
- `notes` は音名（例: C4, F#3, Bb5）または数値（0..127）の配列で渡せます。`transpose` で半音単位の移調が可能です。
- program を指定すると、発音前に Program Change を1回送出します。

### Score DSL 連携時の注意（共通）
- Score DSLでは `start.beat` は整数です（小数は不可）。半拍や3連位置は `unit`/`offset` を用いて表現してください。
  - 例: 2.5拍 → `{"start": { "bar": 1, "beat": 2, "unit": 2, "offset": 1 }}`
- `articulation` に `diminuendo` は未対応です。段階的な `velocity` 変化、または `cc` イベントで代替してください。
