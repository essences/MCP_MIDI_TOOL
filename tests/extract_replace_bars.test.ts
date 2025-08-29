import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

describe('Extract and Replace Bars', () => {
  let serverProcess: ChildProcess;
  let serverReady = false;
  
  beforeEach(async () => {
    serverProcess = spawn('node', [path.resolve('./dist/index.js')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      if (serverProcess.stdout) {
        serverProcess.stdout.on('data', () => {
          serverReady = true;
          clearTimeout(timeout);
          resolve(undefined);
        });
      } else {
        setTimeout(resolve, 2000);
      }
    });
    
    serverReady = true;
  });

  afterEach(async () => {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise(resolve => {
        serverProcess.on('exit', resolve);
        setTimeout(resolve, 1000);
      });
    }
  });

  const sendMCPRequest = async (method: string, params: any = {}): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (!serverProcess.stdin || !serverProcess.stdout) {
        reject(new Error('Server not ready'));
        return;
      }

      const requestId = Math.floor(Math.random() * 1000000);
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params
      }) + '\n';

      let responseData = '';
      const onData = (chunk: Buffer) => {
        responseData += chunk.toString();
        try {
          const lines = responseData.split('\n').filter(line => line.trim());
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              serverProcess.stdout?.off('data', onData);
              resolve(response);
              return;
            }
          }
        } catch {
          // JSON解析失敗は続行
        }
      };

      serverProcess.stdout.on('data', onData);
      serverProcess.stdin.write(request);

      setTimeout(() => {
        serverProcess.stdout?.off('data', onData);
        reject(new Error('Request timeout'));
      }, 10000);
    });
  };

  it('基本的な小節抽出: 2小節のメロディからの1小節抽出', async () => {
    if (!serverReady) return;

    // 2小節のメロディを作成
    const originalJson = {
      ppq: 480,
      tracks: [
        { events: [{ type: "meta.tempo", usPerQuarter: 500000, tick: 0 }] },
        {
          channel: 0,
          events: [
            { type: "program", program: 0, tick: 0 },
            // 1小節目: C4 全音符
            { type: "note", pitch: 60, velocity: 100, tick: 0, duration: 1920 },
            // 2小節目: D4 全音符  
            { type: "note", pitch: 62, velocity: 100, tick: 1920, duration: 1920 }
          ]
        }
      ]
    };

    // 元の曲をSMFとして保存
    const storeResponse = await sendMCPRequest('tools/call', {
      name: 'json_to_smf',
      arguments: {
        json: originalJson,
        format: 'json_midi_v1',
        name: 'test-2bars.mid'
      }
    });

    const storeResult = storeResponse.result.content?.[0]?.text 
      ? JSON.parse(storeResponse.result.content[0].text)
      : storeResponse.result;
    
    expect(storeResult.ok).toBe(true);
    const fileId = storeResult.fileId;

    // 1小節目を抽出
    const extractResponse = await sendMCPRequest('tools/call', {
      name: 'extract_bars',
      arguments: {
        fileId,
        startBar: 1,
        endBar: 1,
        format: 'json_midi_v1'
      }
    });

    const extractResult = extractResponse.result.content?.[0]?.text 
      ? JSON.parse(extractResponse.result.content[0].text)
      : extractResponse.result;
    
    expect(extractResult.ok).toBe(true);
    expect(extractResult.startBar).toBe(1);
    expect(extractResult.endBar).toBe(1);
    expect(extractResult.startTick).toBe(0);
    expect(extractResult.endTick).toBe(1920); // 1小節分のtick
    expect(extractResult.eventCount).toBe(3); // meta.tempo + program + note
    
    // 抽出されたJSONの確認
    const extractedJson = extractResult.json;
    expect(extractedJson.ppq).toBe(480);
    expect(extractedJson.tracks).toHaveLength(1); // SMFからJSONへの変換で統合されている
    
    // メロディトラックのイベント確認
    const melodyTrack = extractedJson.tracks[0];
    const noteEvent = melodyTrack.events.find((e: any) => e.type === 'note');
    expect(noteEvent.pitch).toBe(60); // C4
    expect(noteEvent.tick).toBe(0); // 相対tick（抽出範囲の開始から）
    expect(noteEvent.duration).toBe(1920);
  }, 10000);

  it('複数小節抽出: 4小節から2-3小節を抽出', async () => {
    if (!serverReady) return;

    // 4小節のメロディを作成
    const originalJson = {
      ppq: 480,
      tracks: [
        { events: [{ type: "meta.tempo", usPerQuarter: 500000, tick: 0 }] },
        {
          channel: 0, 
          events: [
            { type: "program", program: 0, tick: 0 },
            // 1小節目: C4
            { type: "note", pitch: 60, velocity: 100, tick: 0, duration: 1920 },
            // 2小節目: D4
            { type: "note", pitch: 62, velocity: 100, tick: 1920, duration: 1920 },
            // 3小節目: E4
            { type: "note", pitch: 64, velocity: 100, tick: 3840, duration: 1920 },
            // 4小節目: F4
            { type: "note", pitch: 65, velocity: 100, tick: 5760, duration: 1920 }
          ]
        }
      ]
    };

    const storeResponse = await sendMCPRequest('tools/call', {
      name: 'json_to_smf',
      arguments: {
        json: originalJson,
        format: 'json_midi_v1', 
        name: 'test-4bars.mid'
      }
    });

    const fileId = JSON.parse(storeResponse.result.content[0].text).fileId;

    // 2-3小節を抽出
    const extractResponse = await sendMCPRequest('tools/call', {
      name: 'extract_bars',
      arguments: {
        fileId,
        startBar: 2,
        endBar: 3
      }
    });

    const extractResult = JSON.parse(extractResponse.result.content[0].text);
    
    expect(extractResult.startBar).toBe(2);
    expect(extractResult.endBar).toBe(3);
    expect(extractResult.startTick).toBe(1920); // 2小節目開始
    expect(extractResult.endTick).toBe(5760); // 4小節目開始（3小節目終了）
    expect(extractResult.eventCount).toBe(2); // 2 notes (D4, E4) - programは範囲外

    // 抽出されたノートの確認
    const melodyTrack = extractResult.json.tracks[0];
    const noteEvents = melodyTrack.events.filter((e: any) => e.type === 'note');
    expect(noteEvents).toHaveLength(2);
    expect(noteEvents[0].pitch).toBe(62); // D4
    expect(noteEvents[0].tick).toBe(0); // 相対tick
    expect(noteEvents[1].pitch).toBe(64); // E4
    expect(noteEvents[1].tick).toBe(1920); // 相対tick
  }, 10000);

  it('小節置換: 1小節目を新しいメロディに置換', async () => {
    if (!serverReady) return;

    // 元の2小節曲を作成
    const originalJson = {
      ppq: 480,
      tracks: [
        { events: [{ type: "meta.tempo", usPerQuarter: 500000, tick: 0 }] },
        {
          channel: 0,
          events: [
            { type: "program", program: 0, tick: 0 },
            // 1小節目: C4
            { type: "note", pitch: 60, velocity: 100, tick: 0, duration: 1920 },
            // 2小節目: D4  
            { type: "note", pitch: 62, velocity: 100, tick: 1920, duration: 1920 }
          ]
        }
      ]
    };

    const storeResponse = await sendMCPRequest('tools/call', {
      name: 'json_to_smf',
      arguments: {
        json: originalJson,
        format: 'json_midi_v1',
        name: 'test-replace-source.mid'
      }
    });

    const fileId = JSON.parse(storeResponse.result.content[0].text).fileId;

    // 置換用データ（G4の全音符）
    const replacementJson = {
      ppq: 480,
      tracks: [
        { events: [] }, // メタトラック
        {
          channel: 0,
          events: [
            { type: "note", pitch: 67, velocity: 110, tick: 0, duration: 1920 } // G4
          ]
        }
      ]
    };

    // 1小節目を置換
    const replaceResponse = await sendMCPRequest('tools/call', {
      name: 'replace_bars',
      arguments: {
        fileId,
        startBar: 1,
        endBar: 1,
        json: replacementJson,
        format: 'json_midi_v1',
        outputName: 'test-replaced.mid'
      }
    });

    const replaceResult = JSON.parse(replaceResponse.result.content[0].text);
    
    expect(replaceResult.ok).toBe(true);
    expect(replaceResult.startBar).toBe(1);
    expect(replaceResult.endBar).toBe(1);
    expect(replaceResult.newFileId).toBeDefined();
    expect(replaceResult.name).toBe('test-replaced.mid');

    // 置換後のファイルをJSON化して確認
    const verifyResponse = await sendMCPRequest('tools/call', {
      name: 'smf_to_json',
      arguments: { fileId: replaceResult.newFileId }
    });

    const verifyResult = JSON.parse(verifyResponse.result.content[0].text);
    console.log('Verify result:', JSON.stringify(verifyResult.json, null, 2));
    
    const melodyTrack = verifyResult.json.tracks[0];
    const noteEvents = melodyTrack.events.filter((e: any) => e.type === 'note');
    
    expect(noteEvents).toHaveLength(2);
    expect(noteEvents[0].pitch).toBe(67); // G4（置換された）
    expect(noteEvents[0].tick).toBe(0);
    expect(noteEvents[1].pitch).toBe(62); // D4（元の2小節目）  
    expect(noteEvents[1].tick).toBe(1920);
  }, 12000);

  it('エラーハンドリング: 不正な小節範囲', async () => {
    if (!serverReady) return;

    const originalJson = {
      ppq: 480,
      tracks: [
        { events: [{ type: "meta.tempo", usPerQuarter: 500000, tick: 0 }] },
        { channel: 0, events: [{ type: "program", program: 0, tick: 0 }] }
      ]
    };

    const storeResponse = await sendMCPRequest('tools/call', {
      name: 'json_to_smf',
      arguments: { json: originalJson, format: 'json_midi_v1', name: 'test-error.mid' }
    });

    const fileId = JSON.parse(storeResponse.result.content[0].text).fileId;

    // 不正な範囲（startBar > endBar）
    const errorResponse = await sendMCPRequest('tools/call', {
      name: 'extract_bars',
      arguments: {
        fileId,
        startBar: 3,
        endBar: 1 // エラー
      }
    });

    expect(errorResponse.error || errorResponse.result?.ok === false).toBeTruthy();

    // 不正な小節番号（0以下）
    const errorResponse2 = await sendMCPRequest('tools/call', {
      name: 'extract_bars', 
      arguments: {
        fileId,
        startBar: 0, // エラー
        endBar: 1
      }
    });

    expect(errorResponse2.error || errorResponse2.result?.ok === false).toBeTruthy();
  }, 8000);
});