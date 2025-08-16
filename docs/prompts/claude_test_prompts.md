# Claude テスト用プロンプト集（mcp-midi-tool）

目的: Claude Desktop から mcp-midi-tool を段階的に検証するためのコピペ用プロンプト。

注意:
- それぞれのプロンプトは単体で貼り付けても動きますが、fileId は保存のたびに変わるため、手順どおりの順番で実行してください。
- プロンプト中の指示に「レスポンスから fileId を抽出して記憶」と明記しています。Claudeに変数として保持させるための指示です。

---

## 00. 準備チェック（探索）
- 「mcp-midi-tool の tools/list, resources/list, prompts/list を順に呼び出し、JSON そのまま表示してください。」

## 01. 保存（store_midi）: C4単音
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)をそのまま表示。さらに fileId を抽出して“FILE_ID_1”という名前で記憶してください。
  base64=TVRoZAAAAAYAAAABAeBNVHJrAAAACwCQPEBggDxAAP8vAA==
  name=test_c4_note」

## 02. 一覧（list_midi）
- 「mcp-midi-tool の list_midi を limit=10, offset=0 で呼んで、JSON をそのまま表示。“FILE_ID_1”に一致するレコードを探して、その1件だけ抜き出して再掲してください。」

## 03. 検索（find_midi）
- 「mcp-midi-tool の find_midi を query="test_c4_note" で呼び、JSONをそのまま表示。最初のヒットの id を“FILE_ID_1”と一致確認し、合っていれば OK と表示してください。」

## 04. 取得（get_midi）: base64なし
- 「mcp-midi-tool の get_midi を fileId=“FILE_ID_1”, includeBase64=false で呼び、JSON をそのまま表示。name と bytes を人間が読みやすい形でも併記してください。」

## 05. 取得（get_midi）: base64あり
- 「mcp-midi-tool の get_midi を fileId=“FILE_ID_1”, includeBase64=true で呼び、JSON をそのまま表示。base64 の長さだけ別途表示してください（先頭50文字も抜粋表示）。」

## 06. エクスポート（export_midi）
- 「mcp-midi-tool の export_midi を fileId=“FILE_ID_1” で呼び、JSON をそのまま表示。exportPath を明示してください。」

## 07. 再生（playback_midi → stop）
- 「mcp-midi-tool の list_devices を呼び、JSON をそのまま表示。macOS でポート名が分かる場合は portName に部分一致で指定し、分からなければ portName は省略して、playback_midi を fileId=“FILE_ID_1” で呼んでください。戻りの playbackId を“PLAYBACK_ID_1”として記憶し、その後 stop_playback playbackId=“PLAYBACK_ID_1” を呼んで JSON をそのまま表示してください。」

## 08. 追加保存（和音）
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)を表示。fileId を“FILE_ID_2”として記憶してください。
  base64=TVRoZAAAAAYAAAABAeBNVHJrAAAAGgCQPEAAkEBAAJBDQIFwgDxAAIBAQACAQ0AA/y8A
  name=test_c_major_chord」

## 09. 追加保存（スケール）
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)を表示。fileId を“FILE_ID_3”として記憶してください。
  base64=TVRoZAAAAAYAAAABAGBNVHJrAAAAFQCQPEAwgDxAAJA+QDCAPkAAkEBAMIBAQAD/LwA=
  name=do_re_mi_scale」

## 10. 一覧で複数確認
- 「mcp-midi-tool の list_midi を limit=10, offset=0 で呼び、JSONをそのまま表示。id の一覧を抽出し、“FILE_ID_1, FILE_ID_2, FILE_ID_3”が含まれていることを確認して結果を要約してください。」

## 11. 異常系（存在しない fileId）
- 「mcp-midi-tool の get_midi を fileId="1" で呼び、エラーをそのまま表示してください。次に fileId="invalid" で呼んで同様に表示してください。」

## 12. 追加保存（きらきら星）
- 「mcp-midi-tool の store_midi を呼び、次の引数で実行し、レスポンス(JSON)を表示。fileId を“FILE_ID_TWINKLE”として記憶してください。
  base64=TVRoZAAAAAYAAAABAGBNVHJrAAAAIACQPEBggDxAAJA8QGCAPEAAkENAYIBDQACQQ0BggENAAP8vAA==
  name=twinkle_twinkle_melody」

## 13. find_midi→get/export ショートカット
- 「mcp-midi-tool の find_midi を query="twinkle" で呼び、最初の items[0].id を “FILE_ID_TWINKLE” と一致確認。続けて get_midi(fileId=“FILE_ID_TWINKLE”, includeBase64=false) と export_midi(fileId=“FILE_ID_TWINKLE”) を順に呼び、それぞれの JSON をそのまま表示してください。」

## 14. クリーンな検証（名前未指定保存）
- 「mcp-midi-tool の store_midi を base64=TVRoZAAAAAYAAAABAGBNVHJrAAAABAD/LwA= のみで呼び、レスポンス(JSON)を表示。fileId を“FILE_ID_MIN”として記憶。その後 list_midi で最上位5件を表示し、“FILE_ID_MIN”に対応するレコードを確認してください。」

---

## トラブルシューティング
- list_midi に保存した直後のIDが出ない:
  - もう一度 list_midi を呼んでください（manifest 反映タイミング）。
- get_midi で "fileId not found":
  - UUID（storeの戻り値や find_midi の items[].id）を使ってください。名前や数字ではヒットしません。
- 再生で効果が分かりにくい:
  - PoC実装のため瞬時に Note On/Off を送出します。IAC Driver を有効化するとMIDIモニターで確認できます。
