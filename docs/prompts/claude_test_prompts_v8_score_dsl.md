# Claude テストプロンプト v8（Score DSL v1: 小節/拍/音価/アーティキュレーション→SMF→dryRun→再生→逆変換）

このプロンプトは、Score DSL（小節/拍/音価/拍子・キー/テンポ/アーティキュレーション）で記述したJSONをSMFに変換し、dryRun/実再生/逆変換で正しく機能することを検証します。`json_to_smf` は JSON MIDI v1 と Score DSL v1 の両方を受け付けます（Score DSLは内部でコンパイル）。

---

## 貼り付け用
以下をそのままClaudeに送信してください。

```
あなたはMCPクライアントです。以下の手順を順に実行し、各ステップの「使用ツール/引数/主要戻り値/所見」を簡潔に1-3行で要約してください。

[準備]
- ツール一覧を取得し、json_to_smf / smf_to_json / play_smf / stop_playback / list_devices / get_playback_status があるか確認。

[パートS: Score DSL → SMF → dryRun → 実再生 → 逆変換]
S-1) Score DSL v1 の入力JSON（4/4, C major, 120bpm, 音価とアーティキュレーションを含む）を用意:
{
  "ppq": 480,
  "meta": {
    "timeSignature": { "numerator": 4, "denominator": 4 },
    "keySignature": { "root": "C", "mode": "major" },
    "tempo": { "bpm": 120 },
    "title": "Score DSL Demo"
  },
  "tracks": [
    {
      "name": "Lead",
      "channel": 0,
      "program": 0,
      "events": [
        { "type": "note", "note": "C4", "start": { "bar": 1, "beat": 1 }, "duration": { "value": "1/4" }, "articulation": "staccato", "velocity": 96 },
        { "type": "note", "note": "D4", "start": { "bar": 1, "beat": 2 }, "duration": { "value": "1/8", "dots": 1 }, "articulation": "accent", "velocity": 90 },
        { "type": "note", "note": "E4", "start": { "bar": 1, "beat": 3 }, "duration": { "value": "1/8", "tuplet": { "inSpaceOf": 2, "play": 3 } }, "slur": true, "velocity": 84 },
        { "type": "note", "note": "F4", "start": { "bar": 1, "beat": 4 }, "duration": { "value": "1/4" }, "articulation": "tenuto", "velocity": 80 }
      ]
    }
  ]
}

S-2) json_to_smf を呼び出し、name="score_dsl_demo.mid", overwrite=true で保存。
  - 期待: fileId, bytes, trackCount>=2（meta+lead）, eventCount>0。

S-3) play_smf を dryRun:true で実行。
  - 期待: scheduledEvents>0, totalDurationMs>0。

S-4) list_devices を実行し、出力ポートがある場合のみS-5を実施。

S-5) play_smf（実再生）: portName をS-4の候補から指定。2〜3秒で stop_playback。
  - 期待: playbackId取得、get_playback_statusでdoneまで遷移。

S-6) smf_to_json で S-2 の fileId を逆変換。
  - 期待: meta.timeSignature/keySignature/tempo がtrack0に存在。ノートは pitch と duration/tick が現実的。

[出力フォーマット]
- 各ステップを箇条書きし、主要戻り値を数値で再掲。
- 総括として、ppq/bytes/trackCount/eventCount/scheduledEvents/totalDurationMsをまとめる。
```

---

## 注意
- Score DSL入力は `json_to_smf` にそのまま渡せます（内部でJSON MIDI v1へコンパイル）。
- 実再生はポートがある時のみ。まず dryRun で所要時間とイベント件数を確認。
