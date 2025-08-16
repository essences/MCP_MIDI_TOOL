# レポート: 受信側セットアップ（2025-08-16）

## 目的
MCP MIDI TOOL の `playback_midi` の発音率を上げるため、受信側設定手順とチェックリストを整備。

## 追加ドキュメント
- docs/setup/macos_coremidi_receiver.md
- docs/checklists/receiver_setup_checklist.md

## メモ
- IACポート名は `IAC ドライバ バス 2` などDAW側表記に合わせると選択しやすい
- `durationMs` は 800ms 程度が聴感上わかりやすい
- `list_devices` で実デバイスが見えない場合は node-midi が未導入の可能性
