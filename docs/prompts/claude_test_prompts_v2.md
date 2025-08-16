# Claude テスト用プロンプト集 v2（音が出るまでの手順を含む）

目的: Claude Desktop から mcp-midi-tool を段階的に検証し、確実に発音確認できるようにするためのコピペ用プロンプト。

注意:
- 各プロンプトは単体で実行できますが、fileId は保存のたびに変わります。指示に従って ID を“記憶”してください。
- portName は list_devices の name を部分一致で指定できます。未指定の場合は IAC/Network/Virtual を優先して自動選択します。
- durationMs を指定するとノート保持時間を延ばせます（既定 300ms、最大 2000ms）。

---

## 00. 準備チェック（探索）
- 「mcp-midi-tool の tools/list, resources/list, prompts/list を順に呼び出し、JSON をそのまま表示してください。」

## 01. 保存（store_midi）: C4単音
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)をそのまま表示。fileId を抽出して“FILE_ID_1”として記憶してください。
  base64=TVRoZAAAAAYAAAABAeBNVHJrAAAACwCQPEBggDxAAP8vAA==
  name=test_c4_note」

## 02. 検索（find_midi）: fileId再確認
- 「mcp-midi-tool の find_midi を query="test_c4_note" で呼び、JSONを表示。最後のヒット（最新）を選び、その id を“FILE_ID_1”として上書き記憶してください。」

## 03. 出力デバイス確認（list_devices）
- 「mcp-midi-tool の list_devices を呼び、JSON を表示。最も使いたい name を“DEV_NAME_1”として記憶してください（例: "IAC"）。見つからなければ空でもOKです。」

## 04. 再生（playback_midi）: 音を出す
- 「mcp-midi-tool の playback_midi を fileId=“FILE_ID_1”, portName=“DEV_NAME_1”, durationMs=800 で呼び、JSON を表示。戻りの playbackId を“PB_ID_1”として記憶してください。」

## 05. 停止（stop_playback）
- 「mcp-midi-tool の stop_playback を playbackId=“PB_ID_1” で呼び、JSON を表示してください。」

## 06. エクスポート（export_midi）
- 「mcp-midi-tool の export_midi を fileId=“FILE_ID_1” で呼び、JSON を表示。exportPath を明示してください。」

## 07. 取得（get_midi）: base64あり
- 「mcp-midi-tool の get_midi を fileId=“FILE_ID_1”, includeBase64=true で呼び、JSON を表示。base64 の長さと先頭50文字を併記してください。」

## 08. 追加保存（和音）
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)を表示。fileId を“FILE_ID_2”として記憶してください。
  base64=TVRoZAAAAAYAAAABAeBNVHJrAAAAGgCQPEAAkEBAAJBDQIFwgDxAAIBAQACAQ0AA/y8A
  name=test_c_major_chord」

## 09. 追加保存（スケール）
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)を表示。fileId を“FILE_ID_3”として記憶してください。
  base64=TVRoZAAAAAYAAAABAGBNVHJrAAAAFQCQPEAwgDxAAJA+QDCAPkAAkEBAMIBAQAD/LwA=
  name=do_re_mi_scale」

## 10. 一覧で複数確認（list_midi）
- 「mcp-midi-tool の list_midi を limit=10, offset=0 で呼び、JSON を表示。“FILE_ID_1, FILE_ID_2, FILE_ID_3”が含まれているか確認し、結果を要約してください。」

## 11. 異常系（get_midi）
- 「mcp-midi-tool の get_midi を fileId="1" と fileId="invalid" でそれぞれ呼び、エラーをそのまま表示してください。」

## 12. 追加保存（きらきら星）
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)を表示。fileId を“FILE_ID_TWINKLE”として記憶してください。
  base64=TVRoZAAAAAYAAAABAGBNVHJrAAAAIACQPEBggDxAAJA8QGCAPEAAkENAYIBDQACQQ0BggENAAP8vAA==
  name=twinkle_twinkle_melody」

## 13. find_midi→get/export ショートカット
- 「mcp-midi-tool の find_midi を query="twinkle" で呼び、最新の items[0].id を “FILE_ID_TWINKLE” と一致確認。続けて get_midi(fileId=“FILE_ID_TWINKLE”, includeBase64=false) と export_midi(fileId=“FILE_ID_TWINKLE”) を順に呼び、JSON を表示してください。」

## 14. クリーンな検証（名前未指定保存）
- 「mcp-midi-tool の store_midi を base64=TVRoZAAAAAYAAAABAGBNVHJrAAAABAD/LwA= のみで呼び、レスポンス(JSON)を表示。fileId を“FILE_ID_MIN”として記憶。その後 list_midi で最上位5件を表示し、“FILE_ID_MIN”のレコードを確認してください。」

---

## トラブルシューティング（音が出ない）
- IAC Driver を有効化: macOS の「Audio MIDI 設定」で IAC を有効化し、バスを1つ以上作成。
- 受信側の準備: DAWやMIDIモニターで IAC/選択ポートを入力に設定。受信チャンネルは ch1。
- ポート名の指定: list_devices の name に含まれる語を portName に渡す（例: "IAC"、"Network"、"Virtual"）。
- durationMs を増やす: 800〜1000ms に上げると聴き取りやすい。
- 未指定で試す: portName を省略すると IAC/Network/Virtual を優先選択します。

