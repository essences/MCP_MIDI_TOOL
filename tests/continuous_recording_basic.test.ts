import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// NOTE: フレーク対策: 他ファイルと並列実行時に setTimeout ベース計測が遅延し test timeout を超過する問題があったため
// describe.sequential を使用して当該グループ内テストを逐次実行し、安定性を向上させる。
describe.sequential('Continuous Recording Basic', () => {
  let serverProcess: ChildProcess;
  let serverReady = false;
  
  beforeEach(async () => {
    // MCPサーバ起動
    serverProcess = spawn('node', [path.resolve('./dist/index.js')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // stderr収集（デバッグ）
    if (serverProcess.stderr) {
      serverProcess.stderr.on('data', d => {
        console.error('[server:stderr]', d.toString());
      });
    }
    
    // サーバー起動待機
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
          // JSON解析に失敗した場合は続行
        }
      };

      serverProcess.stdout.on('data', onData);
      serverProcess.stdin.write(request);

      // 10秒でタイムアウト
      setTimeout(() => {
        serverProcess.stdout?.off('data', onData);
        reject(new Error('Request timeout'));
      }, 10000);
    });
  };

  it('継続記録セッション開始・状態取得の基本フロー', async () => {
    if (!serverReady) {
      console.log('Server not ready, skipping test');
      return;
    }

    // 1. tools/listで継続記録ツールが利用可能か確認
    const toolsResponse = await sendMCPRequest('tools/list');
    expect(toolsResponse.result?.tools).toBeDefined();
    
    const tools = toolsResponse.result.tools;
    const startRecordingTool = tools.find((t: any) => t.name === 'start_continuous_recording');
    const getStatusTool = tools.find((t: any) => t.name === 'get_continuous_recording_status');
    
    expect(startRecordingTool).toBeDefined();
    expect(getStatusTool).toBeDefined();

    // 2. start_continuous_recording実行（デフォルト設定）
    const startResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 60000, // 1分
        idleTimeoutMs: 10000, // 10秒
        silenceTimeoutMs: 5000 // 5秒
      }
    });

  console.log('Start recording response (raw):', JSON.stringify(startResponse, null, 2));
    
    // レスポンス検証
    expect(startResponse.result).toBeDefined();
    const result = startResponse.result.content?.[0]?.text 
      ? JSON.parse(startResponse.result.content[0].text)
      : startResponse.result;
    
    if (!result.ok) {
      console.error('[diagnostic] start_continuous_recording failed raw result:', result);
      if (result.error?.code === 'DEVICE_UNAVAILABLE') {
        console.log('DEVICE_UNAVAILABLE 環境のためテストスキップ');
        return; // 環境依存: スキップ
      }
    }
    expect(result.ok).toBe(true);
    expect(result.recordingId).toBeDefined();
    expect(result.ppq).toBe(480);
    expect(result.maxDurationMs).toBe(60000);
    expect(result.idleTimeoutMs).toBe(10000);
    expect(result.silenceTimeoutMs).toBe(5000);
    expect(result.status).toBe('waiting_for_input');
    expect(result.startedAt).toBeDefined();

    const recordingId = result.recordingId;

    // 3. get_continuous_recording_status実行
    const statusResponse = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status',
      arguments: {
        recordingId
      }
    });

  console.log('Status response (raw):', JSON.stringify(statusResponse, null, 2));

    const statusResult = statusResponse.result.content?.[0]?.text 
      ? JSON.parse(statusResponse.result.content[0].text)
      : statusResponse.result;

    expect(statusResult.ok).toBe(true);
    expect(statusResult.recordingId).toBe(recordingId);
    expect(statusResult.status).toBe('waiting_for_input');
    expect(statusResult.eventCount).toBe(0);
    expect(statusResult.currentDurationMs).toBeGreaterThan(0);
    expect(statusResult.timeUntilTimeout).toBeGreaterThan(0);
    expect(statusResult.eventBreakdown).toBeDefined();
    expect(statusResult.channelActivity).toBeDefined();

    // 4. 少し待ってから再度状態確認（タイムアウト進行確認）
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const statusResponse2 = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status', 
      arguments: { recordingId }
    });

    const statusResult2 = statusResponse2.result.content?.[0]?.text 
      ? JSON.parse(statusResponse2.result.content[0].text)
      : statusResponse2.result;

    expect(statusResult2.currentDurationMs).toBeGreaterThan(statusResult.currentDurationMs);
    expect(statusResult2.timeUntilTimeout).toBeLessThan(statusResult.timeUntilTimeout);
  });

  it('無効なrecordingIdでエラーレスポンス', async () => {
    if (!serverReady) return;

    const statusResponse = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status',
      arguments: {
        recordingId: 'invalid-recording-id'
      }
    });

    // エラー条件確認
    expect(statusResponse.error || statusResponse.result?.ok === false).toBeTruthy();
  });

  it('パラメータ検証テスト', async () => {
    if (!serverReady) return;

    // PPQ範囲外テスト
    const startResponse1 = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 50, // 最小値96未満
        maxDurationMs: 60000
      }
    });

    const result1 = startResponse1.result.content?.[0]?.text 
      ? JSON.parse(startResponse1.result.content[0].text)
      : startResponse1.result;
    
    if (!result1.ok && result1.error?.code === 'DEVICE_UNAVAILABLE') {
      console.log('DEVICE_UNAVAILABLE 環境 (ppq検証スキップ)');
      return; // 以降のパラメータ検証は入力デバイス前提なのでスキップ
    }
    // ppq は自動的に96に調整される
    if (result1.ppq !== 96) {
      console.error('[diagnostic] ppq auto-adjust failed. raw:', result1);
    }
    expect(result1.ppq).toBe(96);

    // maxDurationMs範囲外テスト 
    const startResponse2 = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 500 // 最小値1000未満
      }
    });

    const result2 = startResponse2.result.content?.[0]?.text 
      ? JSON.parse(startResponse2.result.content[0].text)
      : startResponse2.result;
    
    if (!result2.ok && result2.error?.code === 'DEVICE_UNAVAILABLE') {
      console.log('DEVICE_UNAVAILABLE 環境 (maxDuration検証スキップ)');
      return; // スキップ
    }
    // maxDurationMs は自動的に1000に調整される
    if (result2.maxDurationMs !== 1000) {
      console.error('[diagnostic] maxDurationMs auto-adjust failed. raw:', result2);
    }
    expect(result2.maxDurationMs).toBe(1000);
  });
});