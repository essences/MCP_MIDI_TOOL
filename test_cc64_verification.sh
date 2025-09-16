#!/bin/bash

# CC64検証のための insert_sustain テストスクリプト
echo "🧪 CC64 insert_sustain 検証テスト開始..."

# ビルド確認
npm run build --silent

# ベースJSONファイル作成
cat > cc64_base.json << 'EOF'
{
  "format": 1,
  "ppq": 480,
  "tracks": [
    {
      "events": [
        { "type": "meta.tempo", "tick": 0, "usPerQuarter": 500000 },
        { "type": "meta.timeSignature", "tick": 0, "numerator": 4, "denominator": 4 }
      ]
    },
    {
      "channel": 0,
      "events": [
        { "type": "program", "tick": 0, "program": 0 },
        { "type": "note", "tick": 0, "pitch": 60, "velocity": 100, "duration": 240 },
        { "type": "note", "tick": 480, "pitch": 64, "velocity": 100, "duration": 240 },
        { "type": "note", "tick": 960, "pitch": 67, "velocity": 100, "duration": 240 }
      ]
    }
  ]
}
EOF

# テスト関数
test_insert_sustain() {
    local test_name="$1"
    local range_config="$2"
    local description="$3"
    
    echo "📝 Test: $test_name - $description"
    
    # MCP サーバーへのリクエスト構築
    cat > mcp_request.json << EOF
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
        "name": "json_to_smf", 
        "arguments": {
            "json": $(cat cc64_base.json),
            "format": "json_midi_v1",
            "name": "${test_name}_base.mid",
            "overwrite": true
        }
    }
}
EOF

    # SMF作成
    local response=$(timeout 10s node dist/index.js < mcp_request.json 2>/dev/null | head -1)
    if [ $? -ne 0 ]; then
        echo "❌ SMF作成タイムアウト"
        return 1
    fi
    
    local file_id=$(echo "$response" | jq -r '.result.content[0].text' | jq -r '.fileId')
    if [ "$file_id" = "null" ]; then
        echo "❌ fileId取得失敗"
        return 1
    fi
    
    # insert_sustain実行
    cat > sustain_request.json << EOF
{
    "jsonrpc": "2.0", 
    "id": 2,
    "method": "tools/call",
    "params": {
        "name": "insert_sustain",
        "arguments": {
            "fileId": "$file_id",
            "ranges": [$range_config]
        }
    }
}
EOF

    local sustain_response=$(timeout 10s node dist/index.js < sustain_request.json 2>/dev/null | head -1)
    if [ $? -ne 0 ]; then
        echo "❌ insert_sustain タイムアウト"
        return 1
    fi
    
    # export実行
    cat > export_request.json << EOF
{
    "jsonrpc": "2.0",
    "id": 3, 
    "method": "tools/call",
    "params": {
        "name": "export_midi",
        "arguments": {"fileId": "$file_id"}
    }
}
EOF

    local export_response=$(timeout 10s node dist/index.js < export_request.json 2>/dev/null | head -1)
    if [ $? -ne 0 ]; then
        echo "❌ export失敗"
        return 1
    fi
    
    # 結果確認
    local exported_path="data/export/${test_name}_base.mid"
    if [ -f "$exported_path" ]; then
        echo "✅ 作成成功: $exported_path"
        hexdump -C "$exported_path" | grep "b0 40" | head -2
        return 0
    else
        echo "❌ ファイル作成失敗"
        return 1
    fi
}

# テスト1: 閾値64でのON
test_insert_sustain "cc64_threshold64" \
    '{"startTick": 0, "endTick": 1440, "valueOn": 64, "valueOff": 0}' \
    "CC64値64（閾値ギリギリ）でON"

# テスト2: チャンネル1指定
test_insert_sustain "cc64_channel1" \
    '{"startTick": 0, "endTick": 1440, "valueOn": 127, "valueOff": 0, "channel": 1}' \
    "チャンネル1（外部表記）指定"

# テスト3: 部分的なON/OFF
test_insert_sustain "cc64_partial" \
    '{"startTick": 240, "endTick": 720, "valueOn": 127, "valueOff": 0}' \
    "部分的な範囲でのCC64"

# テスト4: ハーフペダル値
test_insert_sustain "cc64_half_pedal" \
    '{"startTick": 0, "endTick": 1440, "valueOn": 80, "valueOff": 40}' \
    "ハーフペダル値（80→40）"

# クリーンアップ
rm -f cc64_base.json mcp_request.json sustain_request.json export_request.json

echo ""
echo "🎯 検証完了！以下のファイルをDAWでテストしてください："
echo "   - cc64_threshold64_base.mid (値64でON)"  
echo "   - cc64_channel1_base.mid (チャンネル1)"
echo "   - cc64_partial_base.mid (部分的範囲)"
echo "   - cc64_half_pedal_base.mid (ハーフペダル)"
echo ""
echo "💡 いずれかのファイルでサスティンが効けば、問題の原因が特定できます！"