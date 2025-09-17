#!/bin/bash

echo "🔍 insert_sustain機能の直接テスト"

# ベーストラックの作成
cat > base_track.json << 'EOF'
{
  "format": 1,
  "ppq": 480,
  "tracks": [
    {
      "events": [
        { "type": "meta.tempo", "tick": 0, "usPerQuarter": 500000 }
      ]
    },
    {
      "channel": 1,
      "events": [
        { "type": "program", "tick": 0, "program": 0 },
        { "type": "note", "tick": 0, "pitch": 60, "velocity": 100, "duration": 480 },
        { "type": "note", "tick": 480, "pitch": 64, "velocity": 100, "duration": 480 }
      ]
    }
  ]
}
EOF

echo "📝 ベーストラック作成完了"

# MCPサーバーでの処理
echo "🚀 MCP サーバー経由でのinsert_sustain実行..."

# 1. JSONをSMFに変換
cat << 'EOF' | timeout 10s node dist/index.js > smf_response.json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "json_to_smf",
    "arguments": {
      "json": BASE_TRACK_CONTENT_PLACEHOLDER,
      "format": "json_midi_v1", 
      "name": "sustain_direct_test.mid",
      "overwrite": true
    }
  }
}
EOF

# base_track.json の内容を置換
sed "s/BASE_TRACK_CONTENT_PLACEHOLDER/$(cat base_track.json | jq -c .)/g" << 'EOF' | timeout 10s node dist/index.js > smf_response.json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "json_to_smf",
    "arguments": {
      "json": BASE_TRACK_CONTENT_PLACEHOLDER,
      "format": "json_midi_v1", 
      "name": "sustain_direct_test.mid",
      "overwrite": true
    }
  }
}
EOF

echo "📄 SMF変換レスポンス:"
cat smf_response.json | head -1 | jq .

# fileIdを抽出
FILE_ID=$(cat smf_response.json | head -1 | jq -r '.result.content[0].text' | jq -r '.fileId' 2>/dev/null)

if [ "$FILE_ID" = "null" ] || [ -z "$FILE_ID" ]; then
    echo "❌ fileId取得失敗"
    exit 1
fi

echo "✅ fileId: $FILE_ID"

# 2. insert_sustainを実行
cat << EOF | timeout 10s node dist/index.js > sustain_response.json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "insert_sustain",
    "arguments": {
      "fileId": "$FILE_ID",
      "ranges": [
        {
          "startTick": 0,
          "endTick": 960,
          "valueOn": 127,
          "valueOff": 0,
          "channel": 1
        }
      ]
    }
  }
}
EOF

echo "📄 insert_sustain レスポンス:"
cat sustain_response.json | head -1 | jq .

# 3. エクスポート
cat << EOF | timeout 10s node dist/index.js > export_response.json  
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "export_midi",
    "arguments": {
      "fileId": "$FILE_ID"
    }
  }
}
EOF

echo "📄 Export レスポンス:"
cat export_response.json | head -1 | jq .

# 4. 結果確認
EXPORTED_FILE="data/export/sustain_direct_test.mid"
if [ -f "$EXPORTED_FILE" ]; then
    echo "✅ ファイル作成成功: $EXPORTED_FILE"
    
    echo "🔍 バイナリ内容確認:"
    hexdump -C "$EXPORTED_FILE" | head -10
    
    echo "🔍 CC64イベント検索:"
    hexdump -C "$EXPORTED_FILE" | grep -E "b[0-9a-f] 40" || echo "CC64イベント見つからず"
    
else
    echo "❌ エクスポートファイル作成失敗"
fi

# クリーンアップ
rm -f base_track.json smf_response.json sustain_response.json export_response.json