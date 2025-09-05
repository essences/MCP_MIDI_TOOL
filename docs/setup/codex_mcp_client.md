# Codex CLI から MCP MIDI TOOL へ接続する

Codex（CLI）を MCP クライアントとして本サーバーに接続するための手順です。Codex 側の「MCPサーバー定義」に本プロセス（`node dist/index.js` もしくは `npm run dev`）を登録します。

前提
- Node.js 20+ がインストール済み
- このリポジトリをローカルに clone 済み

1) 依存関係のインストールとビルド
```
cd <このリポジトリ>
npm ci
npm run build   # dist/index.js を生成
```

2) MCP サーバー定義（Codex 設定への追加）
多くの MCP クライアントは下記のような「mcpServers」マップを受け付けます。Codex が参照する MCP 設定ファイル（例: グローバル設定やワークスペース設定）に以下を追加してください。設定ファイルの場所は Codex のドキュメントに従ってください。

```jsonc
{
  "mcpServers": {
    "mcp-midi-tool": {
      "command": "/usr/local/bin/node",      // もしくは "node"（PATHにある場合）
      "args": ["/absolute/path/to/repo/dist/index.js"],
      "env": {
        // 任意: 起動時 ready ペイロードを1行出力（デバッグ/テスト用）
        "MCP_MIDI_EMIT_READY": "1"
      }
    }
  }
}
```

備考
- 開発中に TypeScript のまま動かす場合は、以下のように `tsx` を使います。
```json
{
  "mcpServers": {
    "mcp-midi-tool-dev": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/repo/node_modules/tsx/dist/cli.mjs", "src/index.ts"],
      "env": { "MCP_MIDI_EMIT_READY": "1" }
    }
  }
}
```

3) 接続確認（Codex 側）
- Codex から当該 MCP サーバーを有効化した上で、次の順でチェックします。
  - tools 一覧が取得できる（`tools/list`）
  - prompts/resources 一覧も取得できる
  - `json_to_smf` → `play_smf(dryRun)` → `smf_to_json` が呼べる

4) ローカルでの疎通スモーク
Codex 側の UI からの動作に並行して、同梱のスモークスクリプトでも疎通確認できます。
```
npm run build && node scripts/mcp_smoke_e2e.mjs
```

5) 代表的なツール呼び出し（Codex から）
- `json_to_smf { json, format, name, overwrite? }`
- `play_smf { fileId, dryRun?, startBar?, endBar?, portName? }`
- `append_to_smf { fileId, json, format, atEnd?, atTick?, ... }`
- `extract_bars / replace_bars`
- `insert_sustain / insert_cc`
- `export_midi`

6) トラブルシュート
- Node のパス指定が必要な場合は `which node` で絶対パスを確認して設定してください。
- 権限やカレントディレクトリに依存する場合は `args` に絶対パスを指定してください。
- 再生で音が出ない場合: 出力デバイスが未接続でもエラーにはなりません。`list_devices` を確認し、`play_smf { portName }` で接続先を明示してください。macOS での受信側セットアップは `docs/setup/macos_coremidi_receiver.md` を参照。

補足
- Codex における MCP 設定ファイルの正確な配置/名称は Codex のバージョン・導入方法によって異なります。本書の JSON スキーマ（`mcpServers`）は Claude Desktop など一般的な MCP クライアントで広く用いられている形式です。Codex 側の設定仕様に合わせて調整してください。

