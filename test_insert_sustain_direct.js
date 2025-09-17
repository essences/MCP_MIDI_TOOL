import { spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';

async function testInsertSustain() {
  console.log('🔍 insert_sustain 機能の直接テスト');
  
  const child = spawn(process.execPath, ['./dist/index.js'], { 
    stdio: ['pipe', 'pipe', 'pipe'] 
  });

  function send(obj) { 
    child.stdin.write(JSON.stringify(obj) + '\n'); 
  }
  
  async function read() {
    const [buf] = await once(child.stdout, 'data');
    return JSON.parse(buf.toString().split('\n')[0]);
  }

  try {
    // 1. Initialize
    console.log('📡 MCP初期化...');
    send({ 
      jsonrpc: '2.0', 
      id: 1, 
      method: 'initialize', 
      params: { 
        protocolVersion: '2025-06-18', 
        capabilities: {}, 
        clientInfo: { name: 'test', version: '1.0' } 
      } 
    });
    await read();

    // 2. Create base track
    console.log('📝 ベーストラック作成...');
    const baseTrack = {
      format: 1,
      ppq: 480,
      tracks: [
        {
          events: [
            { type: "meta.tempo", tick: 0, usPerQuarter: 500000 }
          ]
        },
        {
          channel: 1,
          events: [
            { type: "program", tick: 0, program: 0 },
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 480 },
            { type: "note", tick: 480, pitch: 64, velocity: 100, duration: 480 }
          ]
        }
      ]
    };

    send({ 
      jsonrpc: '2.0', 
      id: 2, 
      method: 'tools/call', 
      params: { 
        name: 'json_to_smf', 
        arguments: { 
          json: baseTrack, 
          format: 'json_midi_v1', 
          name: 'sustain_direct_test.mid', 
          overwrite: true 
        } 
      }
    });
    
    const smfResponse = await read();
    const fileId = JSON.parse(smfResponse.result.content[0].text).fileId;
    console.log(`✅ SMF作成成功: ${fileId}`);

    // 3. Insert sustain
    console.log('🎛️ CC64挿入...');
    send({ 
      jsonrpc: '2.0', 
      id: 3, 
      method: 'tools/call', 
      params: { 
        name: 'insert_sustain', 
        arguments: { 
          fileId: fileId,
          ranges: [{
            startTick: 0,
            endTick: 960,
            valueOn: 127,
            valueOff: 0,
            channel: 1
          }]
        } 
      }
    });
    
    const sustainResponse = await read();
    console.log(`✅ CC64挿入完了:`, JSON.parse(sustainResponse.result.content[0].text));

    // 4. Export
    console.log('📤 エクスポート...');
    send({ 
      jsonrpc: '2.0', 
      id: 4, 
      method: 'tools/call', 
      params: { 
        name: 'export_midi', 
        arguments: { fileId: fileId } 
      }
    });
    
    await read();
    
    // 5. Check result
    const exportedFile = 'data/export/sustain_direct_test.mid';
    if (fs.existsSync(exportedFile)) {
      console.log(`✅ ファイル作成成功: ${exportedFile}`);
      
      const data = fs.readFileSync(exportedFile);
      const hex = data.toString('hex');
      
      console.log('\n🔍 バイナリ内容確認:');
      console.log(`  ファイルサイズ: ${data.length} bytes`);
      console.log(`  Hex (先頭100文字): ${hex.substring(0, 100)}`);
      
      console.log('\n🎯 CC64パターン検索:');
      console.log(`  b1407f (ch1 cc64 val127): ${hex.includes('b1407f') ? '✅ Found' : '❌ Not found'}`);
      console.log(`  b14000 (ch1 cc64 val0):   ${hex.includes('b14000') ? '✅ Found' : '❌ Not found'}`);
      console.log(`  b0407f (ch0 cc64 val127): ${hex.includes('b0407f') ? '✅ Found' : '❌ Not found'}`);
      console.log(`  b04000 (ch0 cc64 val0):   ${hex.includes('b04000') ? '✅ Found' : '❌ Not found'}`);
      
      if (hex.includes('b04000') && !hex.includes('b0407f')) {
        console.log('\n🚨 問題発見: OFFイベント(00)のみでONイベント(7F)が見つからない！');
      }
      
    } else {
      console.log('❌ エクスポートファイル作成失敗');
    }
    
  } catch (err) {
    console.error('❌ エラー:', err);
  } finally {
    child.kill();
  }
}

testInsertSustain();