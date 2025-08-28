import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

describe('Continuous Recording Timeout', () => {
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
      }, 15000); // タイムアウトテスト用に延長
    });
  };

  it('idleタイムアウト: 最初の入力がない場合', async () => {
    if (!serverReady) return;

    // 短いidleTimeoutで記録開始
    const startResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 30000,
        idleTimeoutMs: 3000, // 3秒でidleタイムアウト
        silenceTimeoutMs: 5000
      }
    });

    const startResult = startResponse.result.content?.[0]?.text 
      ? JSON.parse(startResponse.result.content[0].text)
      : startResponse.result;
    
    expect(startResult.ok).toBe(true);
    const recordingId = startResult.recordingId;

    // 1秒待機（まだidleタイムアウト前）
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const status1 = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status',
      arguments: { recordingId }
    });

    const statusResult1 = status1.result.content?.[0]?.text 
      ? JSON.parse(status1.result.content[0].text)
      : status1.result;

    expect(statusResult1.status).toBe('waiting_for_input');
    expect(statusResult1.timeUntilTimeout).toBeGreaterThan(1500); // より余裕を持った範囲
    expect(statusResult1.timeUntilTimeout).toBeLessThan(2200);

    // 4秒待機（idleタイムアウト発生）
    await new Promise(resolve => setTimeout(resolve, 3500)); // 少し短縮

    const status2 = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status', 
      arguments: { recordingId }
    });

    const statusResult2 = status2.result.content?.[0]?.text 
      ? JSON.parse(status2.result.content[0].text)
      : status2.result;

    expect(statusResult2.status).toBe('timeout_idle');
    expect(statusResult2.reason).toBe('idle_timeout');
    expect(statusResult2.eventCount).toBe(0);
  }, 10000); // 10秒タイムアウト

  it('maxDurationタイムアウト: 記録全体の最大時間超過', async () => {
    if (!serverReady) return;

    // 短いmaxDurationで記録開始
    const startResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 4000, // 4秒で全体タイムアウト
        idleTimeoutMs: 10000,
        silenceTimeoutMs: 10000
      }
    });

    const startResult = startResponse.result.content?.[0]?.text 
      ? JSON.parse(startResponse.result.content[0].text)
      : startResponse.result;
    
    expect(startResult.ok).toBe(true);
    const recordingId = startResult.recordingId;

    // 2秒待機（まだmaxDurationタイムアウト前）
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const status1 = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status',
      arguments: { recordingId }
    });

    const statusResult1 = status1.result.content?.[0]?.text 
      ? JSON.parse(status1.result.content[0].text)
      : status1.result;

    expect(statusResult1.status).toBe('waiting_for_input');
    expect(statusResult1.currentDurationMs).toBeGreaterThan(1500);

    // 5秒待機（maxDurationタイムアウト発生）
    await new Promise(resolve => setTimeout(resolve, 3500)); // 少し短縮

    const status2 = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status',
      arguments: { recordingId }
    });

    const statusResult2 = status2.result.content?.[0]?.text 
      ? JSON.parse(status2.result.content[0].text)
      : status2.result;

    expect(statusResult2.status).toBe('timeout_max_duration');
    expect(statusResult2.reason).toBe('max_duration');
    expect(statusResult2.currentDurationMs).toBeGreaterThan(4000);
  }, 10000);

  it('タイマークリーンアップ確認: タイムアウト後に状態が安定', async () => {
    if (!serverReady) return;

    // 非常に短いidleTimeoutで記録開始
    const startResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 30000,
        idleTimeoutMs: 2000, // 2秒
        silenceTimeoutMs: 5000
      }
    });

    const startResult = startResponse.result.content?.[0]?.text 
      ? JSON.parse(startResponse.result.content[0].text)
      : startResponse.result;
    
    const recordingId = startResult.recordingId;

    // idleタイムアウト発生まで待機
    await new Promise(resolve => setTimeout(resolve, 2500));

    // 複数回状態確認（状態が安定していることを確認）
    for (let i = 0; i < 3; i++) {
      const status = await sendMCPRequest('tools/call', {
        name: 'get_continuous_recording_status',
        arguments: { recordingId }
      });

      const statusResult = status.result.content?.[0]?.text 
        ? JSON.parse(status.result.content[0].text)
        : status.result;

      expect(statusResult.status).toBe('timeout_idle');
      expect(statusResult.reason).toBe('idle_timeout');
      
      // 短時間待機
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }, 8000);

  it('timeUntilTimeout計算精度確認', async () => {
    if (!serverReady) return;

    const startResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 30000,
        idleTimeoutMs: 8000,
        silenceTimeoutMs: 3000
      }
    });

    const startResult = startResponse.result.content?.[0]?.text 
      ? JSON.parse(startResponse.result.content[0].text)
      : startResponse.result;
    
    const recordingId = startResult.recordingId;

    // 1秒間隔で3回測定し、timeUntilTimeoutが適切に減少することを確認
    const measurements = [];
    for (let i = 0; i < 3; i++) {
      const status = await sendMCPRequest('tools/call', {
        name: 'get_continuous_recording_status',
        arguments: { recordingId }
      });

      const statusResult = status.result.content?.[0]?.text 
        ? JSON.parse(status.result.content[0].text)
        : status.result;

      measurements.push({
        timeUntilTimeout: statusResult.timeUntilTimeout,
        currentDurationMs: statusResult.currentDurationMs
      });

      if (i < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // timeUntilTimeoutが単調減少していることを確認
    expect(measurements[1].timeUntilTimeout).toBeLessThan(measurements[0].timeUntilTimeout);
    expect(measurements[2].timeUntilTimeout).toBeLessThan(measurements[1].timeUntilTimeout);
    
    // currentDurationMsが単調増加していることを確認
    expect(measurements[1].currentDurationMs).toBeGreaterThan(measurements[0].currentDurationMs);
    expect(measurements[2].currentDurationMs).toBeGreaterThan(measurements[1].currentDurationMs);
  }, 8000);
});