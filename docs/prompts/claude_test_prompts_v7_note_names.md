# Claude テストプロンプト v7（音名指定での再生検証 / JSON→SMF→dryRun→実再生→逆変換）

このプロンプトは、ノートの音名指定（例: C4, F#3, Bb5）で作成したJSONをSMFへコンパイルし、dryRun→実再生→smf_to_jsonの往復で「音名が付与されていること」を検証します。

---

## 貼り付け用（そのまま使用）
以下をそのままClaudeに送信してください。

```
あなたはMCPクライアントです。以下の手順を順番に実行し、各ステップで「使用ツール / 引数サマリ / 主要戻り値 / 所見」を1-3行で要約してください。失敗時は原因・再現方法・リトライ案を示し、継続可能なところまで進めてください。

[準備]
- 利用可能なMCPツール一覧を表示（tools/list 等）。以下が存在するか確認:
  - json_to_smf, smf_to_json, play_smf, stop_playback, list_devices, get_playback_status

[パートA: 音名でJSON→SMF→dryRun→実再生→逆変換]
A-1) 音名指定のJSON楽曲を作成（Cメジャーの上昇→下降メロディー、各240tick）:
{
  "ppq": 480,
  "tracks": [
    { "events": [ { "type": "meta.tempo", "tick": 0, "usPerQuarter": 500000 }, { "type": "meta.trackName", "tick": 0, "text": "NoteNames" } ] },
    { "channel": 0, "events": [
      { "type": "program", "tick": 0, "program": 0 },
      { "type": "note", "tick": 0,    "note": "C4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 240,  "note": "D4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 480,  "note": "E4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 720,  "note": "F4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 960,  "note": "G4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 1200, "note": "F4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 1440, "note": "E4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 1680, "note": "D4", "velocity": 100, "duration": 240 },
      { "type": "note", "tick": 1920, "note": "C4", "velocity": 100, "duration": 240 }
    ] }
  ]
}

A-2) json_to_smf を呼び出し、name="note_names_smoke.mid", overwrite=true で保存。
  - 期待: fileId, bytes, trackCount, eventCount を取得。

A-3) play_smf を dryRun:true で実行。
  - 期待: scheduledEvents が複数件（ノート数に応じて増加）、totalDurationMs > 0。

A-4) list_devices を実行し、利用可能な出力ポート名を列挙。ポートが見つかった場合のみA-5へ。

A-5) play_smf（実再生）: portName にA-4のポート名を指定し、schedulerLookaheadMs=200, schedulerTickMs=20 を付与可。
  - 期待: playbackId を取得。get_playback_status で cursorMs/totalDurationMs/done を観測。
  - 2〜3秒で stop_playback を呼び停止。

A-6) smf_to_json を呼び出し、A-2の fileId を逆変換。
  - 期待: 返却JSONのnoteイベントに pitch と note の両方が併記されている（例: pitch:60, note:"C4"）。
  - 確認: 先頭/中間/末尾ノートの note が ["C4", "G4"（または近傍）, "C4"] のように音名として妥当。

[出力フォーマット]
- 各ステップ: "ステップ名 / ツール / 引数サマリ / 主要戻り値 / 所見" を簡潔に列挙。
- 最後に bytes/trackCount/eventCount/scheduledEvents/totalDurationMs と、確認した note 名（先頭/中間/末尾）を再掲し総括してください。
```

---

## ポイント
- 入力: note フィールド（音名）で指定可能。内部でMIDI番号へ解決してSMF生成。
- 出力: smf_to_json で pitch（番号）と note（音名）の双方を併記し、人間可読性を確保。
- 実再生はポートがある時のみ実施。まず dryRun で総尺・イベント件数を確認してから。
