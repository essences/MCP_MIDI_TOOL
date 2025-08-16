# Claude デスクトップ用 テストプロンプト集 v3（play_smf: dryRun→実再生→停止）

目的: Claude Desktop から本MCPサーバーの SMF 再生機能を段階的に検証します。まず dryRun でイベント解釈を確認し、次に実際に音を出し、最後に安全に停止します。

前提:
- 受信側（IAC/Network/仮想MIDI/DAW）のルーティングが完了していること。macOS例は `docs/setup/macos_coremidi_receiver.md` を参照。
- 既に Claude Desktop から本サーバーに接続済みで、tools/resources/prompts の探索エラーがないこと。

---

## 0) 探索の健全性チェック（任意）
```
このMCPサーバーに対し、以下を順に実行し結果をそのまま表示してください。
1) tools/list
2) resources/list
3) prompts/list
エラーやZodErrorがあれば指摘してください。
```

---

## 1) 出力デバイスの列挙と選定
```
list_devices を呼び、得られたJSONを表示してください。IAC/Network/Virtual/Loopback を含む name を優先して1つ選び、その文字列を “DEV_NAME” として記憶してください（部分一致でOK）。
```
メモ例: DEV_NAME = "IAC"

---

## 2) SMFの用意（保存 or 既存を検索）
新規に保存する場合:
```
store_midi を呼び、以下の引数で実行し、レスポンス(JSON)を表示してください。返ってきた id を “FILE_ID” として記憶してください。
- name: twinkle_twinkle_melody
- base64: TVRoZAAAAAYAAAABAGBNVHJrAAAAIACQPEBggDxAAJA8QGCAPEAAkENAYIBDQACQQ0BggENAAP8vAA==
```
既存から見つける場合:
```
find_midi を query="twinkle" で呼び、最新の items[0].id を “FILE_ID” として記憶してください。
```

---

## 3) dryRun でイベント確認（音は出さない）
```
play_smf を dryRun で実行し、イベント件数とタイム順を確認してください。
- 入力: { fileId: "FILE_ID", dryRun: true }
- 出力: scheduledEvents と totalDurationMs を表示し、先頭3件と末尾3件の tMs/type/ch/num/vel などを抜粋して表示してください。
- 参考: 8秒継続SMFの生成スニペットは docs/snippets/continuous_chords_smf_8s.md を参照
```
想定結果のポイント:
- scheduledEvents が 2件以上（NoteOn/NoteOff）あること。
- tMs は昇順に並んでいること。

---

## 4) 実再生（数秒だけ）
```
play_smf を実再生で呼びます。5〜10秒後に停止するので、返却の playbackId を “PB_ID” として記憶してください。
- 入力例: { fileId: "FILE_ID", portName: "DEV_NAME" }
- 出力: { ok: true, playbackId: "..." }
```
補足:
- portName は部分一致で選択されます。未指定時は IAC/Network/Virtual を優先して自動選択します。
- 再生はルックアヘッド型スケジューラで送出されます。
 - 進捗の観測には get_playback_status { playbackId: "PB_ID" } を利用できます（cursor/lastSentAt/totalDurationMsなど）。

---

## 5) 停止（全ノート消音/タイマ解除/ポートクローズ）
```
stop_playback を PB_ID で呼び、JSON を表示してください。
- 入力: { playbackId: "PB_ID" }
- 期待: ok: true かつ アクティブノートの消音が完了
```

---

## 6) 追加確認（任意）
- 再生範囲の指定: startMs / stopMs を与えて一部分のみ再生
```
play_smf を { fileId: "FILE_ID", portName: "DEV_NAME", startMs: 0, stopMs: 5000 } で呼び、部分再生できることを確認してください。
```
- 単音スモーク: 音が出ない環境での切り分けに playback_midi(durationMs=800) も有効

---

## トラブルシューティング
- デバイスが見つからない: 仮想デバイス(IAC等)の有効化、node-midi のネイティブビルド、権限を確認。
- 音が出ない: 受信トラックのインプット/モニタ/レコードアーム、音源プラグイン、MIDIチャンネル(通常ch1=0) を確認。
- ノートが鳴り止まない: stop_playback を必ず呼ぶ。改善しない場合はバグ報告として playbackId と直前の scheduledEvents を添付。
- 大容量で重い: まず dryRun で件数を確認し、startMs/stopMs で短く検証。

---

以上。
