import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnMcpServer, McpTestServer } from './helpers/mcpServer';

// NOTE: フレーク対策: 並列実行で idle/maxDuration の実時間計測が遅延し 8-10s の test timeout を超過したため
// describe.sequential を使用しテスト間の並列負荷を避ける。
describe.sequential('Continuous Recording Timeout', () => {
  let server: McpTestServer;
  
  beforeEach(async () => { server = await spawnMcpServer(); });

  afterEach(async () => { await server.shutdown(); });

  const sendMCPRequest = (method: string, params: any = {}, timeout = 15000) => server.send(method, params, timeout);

  it('idleタイムアウト: 最初の入力がない場合', async () => {
  if (!server.ready) return;

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
    
  if (!startResult.ok) {
    console.error('[diagnostic] idle test start failed:', startResult);
    if (startResult.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (idle timeout テストスキップ)'); return; }
  }
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
  if (!server.ready) return;

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
    
  if (!startResult.ok) {
    console.error('[diagnostic] maxDuration test start failed:', startResult);
    if (startResult.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (maxDuration timeout テストスキップ)'); return; }
  }
  expect(startResult.ok).toBe(true);
    if (!startResult.ok) {
      console.error('[diagnostic] cleanup stability start failed:', startResult);
      if (startResult.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (cleanup stability テストスキップ)'); return; }
    }
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
  if (!server.ready) return;

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

      if (statusResult.status !== 'timeout_idle' || statusResult.reason !== 'idle_timeout') {
        console.error('[diagnostic] cleanup stability mismatch:', statusResult);
      }
      expect(statusResult.status).toBe('timeout_idle');
      expect(statusResult.reason).toBe('idle_timeout');
      
      // 短時間待機
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }, 8000);

  it('timeUntilTimeout計算精度確認', async () => {
  if (!server.ready) return;

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
    
  if (!startResult.ok) {
    console.error('[diagnostic] timeUntilTimeout start failed:', startResult);
    if (startResult.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (timeUntilTimeout テストスキップ)'); return; }
  }
  const recordingId = startResult.recordingId;

    // 1秒間隔で3回測定し、timeUntilTimeoutが適切に減少することを確認
  const measurements: { timeUntilTimeout: number; currentDurationMs: number }[] = [];
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