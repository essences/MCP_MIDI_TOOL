# MCPツール実行レポート (2025-08-17)

## INIT / 環境情報
- Node: v23.5.0
- NPM: 10.9.2
- PWD: /Users/hayashieiichi/MCP_MIDI_TOOL
- Git status (直前):
  - modified: package.json
  - untracked: scripts/mcp_smoke_e2e.mjs

## Web検索 MCP ツール 検証
- クエリ: "Bach 3-voice inventions MIDI download"
- 上位結果（抜粋）:
  - Toccata and Fugue in D minor - A Johann Sebastian Bach Midi Page → Well Tempered Clavier, Inventions/Sinfonias ほか多数のMIDI直リンクあり
    - https://www.bachcentral.com/midiindexcomplete.html
  - MIDI Files - Inventions and Sinfonias - Dave's J.S. Bach Page
    - http://www.jsbach.net/midi/midi_invsin.html

結論: Web検索 MCP ツール呼び出し成功（結果取得OK）。

## MIDI MCP（ローカル・stdio）E2E スモーク
フロー: initialize → json_to_smf → play_smf(dryRun) → smf_to_json

実行サマリ:

```json
{
  "ok": true,
  "fileId": "70921115-aaec-4e16-9e32-c94a151d1ec6",
  "bytes": 57,
  "trackCount": 2,
  "eventCount": 3,
  "scheduledEvents": 2,
  "totalDurationMs": 250,
  "roundtripPpq": 480
}
```

結論: MIDI MCP ツール呼び出し成功。JSON→SMF生成とdryRunスケジューリング、SMF→JSONデコードまでE2E確認済み。

## 総合結論
- Web検索 MCP ツール: OK
- MIDI MCP ツール: OK（E2EスモークもOK）

このレポートは自動生成され、リポジトリに保存されています。
