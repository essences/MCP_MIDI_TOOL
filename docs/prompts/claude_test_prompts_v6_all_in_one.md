# Claude テストプロンプト v6（All-in-One / JSON→SMF→再生→逆変換＋Web検索）

このプロンプトをClaudeに貼り付けて、MCP MIDI TOOLの基本機能とWeb検索ツール連携を一気に検証します。手順は安全のためdryRun→実再生の順。ツール名はお使いのClaude環境の表示に合わせて微調整してください。

---

## 貼り付け用（そのまま使用）
以下をそのまま送信してください。

```
あなたはMCPクライアントです。以下のチェックリストを厳密に順番通り実行し、各ステップごとに実行したMCPツール名・引数・戻り値（主要フィールド）・所見を箇条書きでレポートしてください。失敗時は原因・再現方法・リトライ案を提示して続行可能なところまで進めてください。

[準備]
- 利用可能なMCPツール一覧を表示（tools/list 等）。少なくとも次があるか確認:
  - json_to_smf, smf_to_json, play_smf, stop_playback, list_devices, get_playback_status
  - （任意）Web検索MCPツール（例: web.search / brave.search など）。あれば使用、無ければスキップ。

[パートA: JSON→SMF→dryRun→実再生→停止→逆変換]
A-1) JSON楽曲（最小構成）を生成:
{
  "ppq": 480,
  "tracks": [
    { "events": [ { "type": "meta.tempo", "tick": 0, "usPerQuarter": 500000 } ] },
    { "channel": 0, "events": [
      { "type": "program", "tick": 0, "program": 0 },
      { "type": "note", "tick": 0, "pitch": 60, "velocity": 100, "duration": 240 }
    ]}
  ]
}

A-2) json_to_smf を呼び出し、name="claude_smoke.mid", overwrite=true で保存。
  - 期待: fileId, bytes, trackCount, eventCount を取得。

A-3) play_smf を dryRun:true で実行。
  - 期待: scheduledEvents >= 1, totalDurationMs > 0。

A-4) list_devices を実行し、利用可能な出力ポート名を列挙。利用可能な場合のみ下記A-5へ。

A-5) play_smf を実再生で実行（portNameに上記のポート名を指定）。
  - オプション: schedulerLookaheadMs=200, schedulerTickMs=20。
  - 期待: playbackId を取得。get_playback_status で cursorMs/totalDurationMs/done を観測。
  - 2秒程度で stop_playback を実行して停止。

A-6) smf_to_json を呼び出し、A-2の fileId を逆変換。
  - 期待: json.ppq==480、先頭トラックに meta.tempo があること。

[パートB: （任意）Web検索→MIDI取得→保存→dryRun]
B-1) （Web検索MCPがある場合のみ）
  - クエリ例: "Bach Invention 1 MIDI"。
  - 小さめの .mid を1件選定し、HTTP経由で取得（クライアント側でダウンロード→base64化）。
  - store_midi に { base64, name:"invention_test.mid" } を渡して保存（fileId取得）。
  - play_smf { fileId, dryRun:true } を実行し、scheduledEvents/totalDurationMs を確認。

[成功条件]
- A-2, A-3, A-6 がすべて成功。A-5はポートがあれば成功（任意）。
- （任意）B-1が成功。

[出力フォーマット]
- 各ステップ: "ステップ名 / 使用ツール / 引数サマリ / 主要戻り値 / 所見" の順で1-3行に要約。
- 最後に、bytes/trackCount/eventCount/scheduledEvents/totalDurationMs/ppq を一覧で再掲し、総括してください。
```

---

## 目的とポイント
- JSONファーストでの往復（JSON→SMF→JSON）とメトリクス可視化を短時間で検証
- 実再生前に必ずdryRunで総尺・イベント件数を確認（安全運用）
- 受信側がある環境では短時間だけ実再生→stopでハングノート対策も含めて確認
- Web検索MCPがある場合、ネット上の小規模SMFも取り込みテスト

## 期待される主な戻り値（要素）
- json_to_smf: { fileId, bytes, trackCount, eventCount }
- play_smf(dryRun): { scheduledEvents, totalDurationMs }
- play_smf(実再生): { playbackId }
- get_playback_status: { playbackId, done, cursorMs, totalDurationMs }
- smf_to_json: { json: { ppq, tracks[...] }, bytes, trackCount, eventCount }

## トラブル時のヒント
- ポートが見つからない: macOSはIAC Driverを有効化、list_devices出力を確認
- 送出が不安定: schedulerLookaheadMs↑, schedulerTickMs↑で安定化
- 逆変換でtempoが見えない: tempoはトラック0集約。ヘッダの扱いに注意
- 大容量: まずdryRunで総尺・件数を確認、必要なら区間再生（startMs/stopMs）

## さらに進めるには
- 2トラック以上・CC/PitchBend・timeSignatureを含むJSONを用意し、往復挙動とメトリクスを比較
- Web検索で得たSMFを複数保存し、list_midi / find_midi / export_midi を併用
