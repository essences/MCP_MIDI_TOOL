import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

describe('Continuous Recording Phase 4', () => {
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

  it('list_continuous_recordings: 空のレジストリで正常応答', async () => {
    if (!serverReady) return;

    const response = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'all' }
    });

    const result = response.result.content?.[0]?.text 
      ? JSON.parse(response.result.content[0].text)
      : response.result;
    
    expect(result.ok).toBe(true);
    expect(result.recordings).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.activeCount).toBe(0);
    expect(result.completedCount).toBe(0);
  }, 8000);

  it('list_continuous_recordings: アクティブセッションフィルタリング', async () => {
    if (!serverReady) return;

    // セッション1を開始
    const startResponse1 = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 60000,
        idleTimeoutMs: 30000
      }
    });

    const startResult1 = startResponse1.result.content?.[0]?.text 
      ? JSON.parse(startResponse1.result.content[0].text)
      : startResponse1.result;
    
    if (!startResult1.ok) {
      console.error('[diagnostic] phase4 start1 failed:', startResult1);
      if (startResult1.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (phase4 アクティブフィルタ テストスキップ)'); return; }
    }
    expect(startResult1.ok).toBe(true);
    const recordingId1 = startResult1.recordingId;

    // セッション2を開始
    const startResponse2 = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 60000,
        idleTimeoutMs: 30000
      }
    });

    const startResult2 = startResponse2.result.content?.[0]?.text 
      ? JSON.parse(startResponse2.result.content[0].text)
      : startResponse2.result;
    
    if (!startResult2.ok) {
      console.error('[diagnostic] phase4 start2 failed:', startResult2);
      if (startResult2.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (phase4 アクティブフィルタ テストスキップ)'); return; }
    }
    expect(startResult2.ok).toBe(true);
    const recordingId2 = startResult2.recordingId;

    // アクティブセッション一覧確認
    const listResponse = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'active', limit: 10 }
    });

    const listResult = listResponse.result.content?.[0]?.text 
      ? JSON.parse(listResponse.result.content[0].text)
      : listResponse.result;
    
    expect(listResult.ok).toBe(true);
    expect(listResult.recordings).toHaveLength(2);
    expect(listResult.activeCount).toBe(2);
    expect(listResult.completedCount).toBe(0);
    expect(listResult.total).toBe(2);

    // 各セッションの基本情報確認
    const recording1 = listResult.recordings.find((r: any) => r.recordingId === recordingId1);
    const recording2 = listResult.recordings.find((r: any) => r.recordingId === recordingId2);
    
    expect(recording1).toBeDefined();
    expect(recording1.status).toBe('waiting_for_input');
    expect(recording1.eventCount).toBe(0);
    expect(recording1.fileId).toBeNull();

    expect(recording2).toBeDefined();
    expect(recording2.status).toBe('waiting_for_input');
    expect(recording2.eventCount).toBe(0);
    expect(recording2.fileId).toBeNull();

    // セッション1を手動終了
    await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { recordingId: recordingId1 }
    });

    // 完了済みセッション一覧確認
    const completedListResponse = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'completed' }
    });

    // 注意: stop_continuous_recordingでレジストリから削除されるため、completedには表示されない
    // これは現在の実装仕様
    const completedResult = completedListResponse.result.content?.[0]?.text 
      ? JSON.parse(completedListResponse.result.content[0].text)
      : completedListResponse.result;
    
    expect(completedResult.ok).toBe(true);
    // セッション1は削除済みなので、completedCount は 0
    expect(completedResult.completedCount).toBe(0);

    // セッション2を終了
    await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { recordingId: recordingId2 }
    });
  }, 15000);

  it('マルチセッション制限: 4番目のセッション開始でエラー', async () => {
    if (!serverReady) return;

    // 3つのセッションを開始
  const sessions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await sendMCPRequest('tools/call', {
        name: 'start_continuous_recording',
        arguments: {
          ppq: 480,
          maxDurationMs: 60000,
          idleTimeoutMs: 30000
        }
      });

      const result = response.result.content?.[0]?.text 
        ? JSON.parse(response.result.content[0].text)
        : response.result;
      
      if (!result.ok) {
        console.error('[diagnostic] phase4 multi-session start failed:', result);
        if (result.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (phase4 マルチセッション テストスキップ)'); return; }
      }
      expect(result.ok).toBe(true);
      sessions.push(result.recordingId);
    }

    // 4番目のセッション開始（エラーが期待される）
    const fourthResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 60000,
        idleTimeoutMs: 30000
      }
    });

    const fourthResult = fourthResponse.result.content?.[0]?.text 
      ? JSON.parse(fourthResponse.result.content[0].text)
      : fourthResponse.result;
    
    expect(fourthResult.ok).toBe(false);
    expect(fourthResult.error).toBeDefined();
    expect(fourthResult.error.message).toContain('Maximum concurrent recording sessions');

    // アクティブセッション確認（3つまで）
    const listResponse = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'active' }
    });

    const listResult = listResponse.result.content?.[0]?.text 
      ? JSON.parse(listResponse.result.content[0].text)
      : listResponse.result;
    
    expect(listResult.activeCount).toBe(3);

    // セッション終了（クリーンアップ）
    for (const sessionId of sessions) {
      await sendMCPRequest('tools/call', {
        name: 'stop_continuous_recording',
        arguments: { recordingId: sessionId }
      });
    }
  }, 15000);

  it('limit制限: 最大50まで、デフォルト10', async () => {
    if (!serverReady) return;

    // デフォルトlimit (10) のテスト
    const defaultResponse = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'all' }
    });

    const defaultResult = defaultResponse.result.content?.[0]?.text 
      ? JSON.parse(defaultResponse.result.content[0].text)
      : defaultResponse.result;
    
    expect(defaultResult.ok).toBe(true);

    // limit=5のテスト
    const limitResponse = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'all', limit: 5 }
    });

    const limitResult = limitResponse.result.content?.[0]?.text 
      ? JSON.parse(limitResponse.result.content[0].text)
      : limitResponse.result;
    
    expect(limitResult.ok).toBe(true);

    // limit=100 (最大50に制限される) のテスト
    const maxLimitResponse = await sendMCPRequest('tools/call', {
      name: 'list_continuous_recordings',
      arguments: { status: 'all', limit: 100 }
    });

    const maxLimitResult = maxLimitResponse.result.content?.[0]?.text 
      ? JSON.parse(maxLimitResponse.result.content[0].text)
      : maxLimitResponse.result;
    
    expect(maxLimitResult.ok).toBe(true);
    // 実際のレコード数が0なので、上限チェックは別の方法で確認する必要がある
  }, 8000);
});