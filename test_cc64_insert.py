import subprocess
import json
import sys

def run_mcp_command(method, params):
    """MCPサーバーにコマンドを送信"""
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params
    }
    
    proc = subprocess.run(
        [sys.executable, "dist/index.js"],
        input=json.dumps(request) + '\n',
        text=True,
        capture_output=True
    )
    
    if proc.returncode != 0:
        print(f"Error: {proc.stderr}")
        return None
    
    # 最初の有効なJSONレスポンスを取得
    for line in proc.stdout.split('\n'):
        if line.strip():
            try:
                return json.loads(line)
            except:
                continue
    return None

# 初期化
init_resp = run_mcp_command("initialize", {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "test", "version": "1.0"}
})

if not init_resp:
    print("Failed to initialize")
    sys.exit(1)

# JSONをSMFに変換
with open('cc64_test.json', 'r') as f:
    test_json = json.load(f)

smf_resp = run_mcp_command("tools/call", {
    "name": "json_to_smf",
    "arguments": {
        "json": test_json,
        "format": "json_midi_v1",
        "name": "cc64_test_original.mid",
        "overwrite": True
    }
})

if not smf_resp:
    print("Failed to create SMF")
    sys.exit(1)

file_id = json.loads(smf_resp['result']['content'][0]['text'])['fileId']
print(f"Created SMF: {file_id}")

# CC64を挿入
cc64_resp = run_mcp_command("tools/call", {
    "name": "insert_sustain",
    "arguments": {
        "fileId": file_id,
        "ranges": [{"startTick": 0, "endTick": 1920, "valueOn": 127, "valueOff": 0}]
    }
})

if cc64_resp:
    result = json.loads(cc64_resp['result']['content'][0]['text'])
    print(f"Inserted CC64: {result}")

# エクスポート
export_resp = run_mcp_command("tools/call", {
    "name": "export_midi",
    "arguments": {"fileId": file_id}
})

if export_resp:
    result = json.loads(export_resp['result']['content'][0]['text'])
    print(f"Exported: {result}")

print("DAW test file created. Check data/export/ directory.")
