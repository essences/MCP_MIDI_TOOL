import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnMcpServer, McpTestServer } from './helpers/mcpServer';

describe.sequential('Continuous Recording Manual Stop', () => {
  let server: McpTestServer;
  
  beforeEach(async () => { server = await spawnMcpServer(); });

  afterEach(async () => { await server.shutdown(); });

  const sendMCPRequest = (method: string, params: any = {}, timeout = 10000) => server.send(method, params, timeout);

  it('手動終了: stop_continuous_recordingでSMF生成・保存', async () => {
  if (!server.ready) return;

    // 記録開始
    const startResponse = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: {
        ppq: 480,
        maxDurationMs: 60000,
        idleTimeoutMs: 30000,
        silenceTimeoutMs: 10000
      }
    });

    const startResult = startResponse.result.content?.[0]?.text 
      ? JSON.parse(startResponse.result.content[0].text)
      : startResponse.result;
    
  if (!startResult.ok) {
    console.error('[diagnostic] manual stop start failed:', startResult);
    if (startResult.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (manual stop テストスキップ)'); return; }
  }
  expect(startResult.ok).toBe(true);
    const recordingId = startResult.recordingId;

    // 少し待機（記録中状態にする必要はないが、テストの確実性のため）
    await new Promise(resolve => setTimeout(resolve, 500));

    // 手動終了・SMF保存
    const stopResponse = await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { 
        recordingId,
        name: 'test-manual-stop.mid'
      }
    });

    const stopResult = stopResponse.result.content?.[0]?.text 
      ? JSON.parse(stopResponse.result.content[0].text)
      : stopResponse.result;

    expect(stopResult.ok).toBe(true);
    expect(stopResult.recordingId).toBe(recordingId);
    expect(stopResult.fileId).toBeDefined();
    // ファイル名はtest-manual-stop.midまたは重複回避のため番号付き
    expect(stopResult.name).toMatch(/^test-manual-stop(_\d+)?\.mid$/);
    expect(stopResult.path).toBeDefined();
    expect(stopResult.bytes).toBeGreaterThan(0);
    expect(stopResult.ppq).toBe(480);
    expect(stopResult.trackCount).toBe(1);
    expect(stopResult.reason).toBe('manual_stop');
    expect(stopResult.recordingStartedAt).toBeDefined();
    expect(stopResult.savedAt).toBeDefined();

    // セッションが削除されていることを確認
    const statusResponse = await sendMCPRequest('tools/call', {
      name: 'get_continuous_recording_status',
      arguments: { recordingId }
    });

    expect(statusResponse.error || statusResponse.result?.ok === false).toBeTruthy();
  }, 12000);

  it('ファイル名重複回避: 同名ファイルがある場合に番号付きファイル名生成', async () => {
  if (!server.ready) return;

    // 最初の記録・保存
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
      console.error('[diagnostic] duplicate filename start1 failed:', startResult1);
      if (startResult1.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (duplicate filename テストスキップ)'); return; }
    }
    const recordingId1 = startResult1.recordingId;

    const stopResponse1 = await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { 
        recordingId: recordingId1,
        name: 'duplicate-test.mid'
      }
    });

    const stopResult1 = stopResponse1.result.content?.[0]?.text 
      ? JSON.parse(stopResponse1.result.content[0].text)
      : stopResponse1.result;

    // ファイル名はduplicate-test.midまたは重複回避のため番号付き  
    expect(stopResult1.name).toMatch(/^duplicate-test(_\d+)?\.mid$/);

    // 二番目の記録・保存（同名ファイル）
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
      console.error('[diagnostic] duplicate filename start2 failed:', startResult2);
      if (startResult2.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (duplicate filename 2 テストスキップ)'); return; }
    }
    const recordingId2 = startResult2.recordingId;

    const stopResponse2 = await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { 
        recordingId: recordingId2,
        name: 'duplicate-test.mid',
        overwrite: false  // 重複回避有効
      }
    });

    const stopResult2 = stopResponse2.result.content?.[0]?.text 
      ? JSON.parse(stopResponse2.result.content[0].text)
      : stopResponse2.result;

    // 2番目のファイルは確実に番号付きになる
    expect(stopResult2.name).toMatch(/^duplicate-test_\d+\.mid$/); // 番号付きファイル名
    expect(stopResult2.fileId).not.toBe(stopResult1.fileId); // 別ファイル
  }, 15000);

  it('overwrite=true: 既存ファイル上書き', async () => {
  if (!server.ready) return;

    // 最初の記録・保存
    const startResponse1 = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: { ppq: 480, maxDurationMs: 60000 }
    });

    const startResult1 = startResponse1.result.content?.[0]?.text 
      ? JSON.parse(startResponse1.result.content[0].text)
      : startResponse1.result;
    
    if (!startResult1.ok) {
      console.error('[diagnostic] overwrite start1 failed:', startResult1);
      if (startResult1.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (overwrite テストスキップ)'); return; }
    }
    const recordingId1 = startResult1.recordingId;

    await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { 
        recordingId: recordingId1,
        name: 'overwrite-test.mid'
      }
    });

    // 二番目の記録・保存（上書き）
    const startResponse2 = await sendMCPRequest('tools/call', {
      name: 'start_continuous_recording',
      arguments: { ppq: 480, maxDurationMs: 60000 }
    });

    const startResult2 = startResponse2.result.content?.[0]?.text 
      ? JSON.parse(startResponse2.result.content[0].text)
      : startResponse2.result;
    
    if (!startResult2.ok) {
      console.error('[diagnostic] overwrite start2 failed:', startResult2);
      if (startResult2.error?.code === 'DEVICE_UNAVAILABLE') { console.log('DEVICE_UNAVAILABLE 環境 (overwrite 2 テストスキップ)'); return; }
    }
    const recordingId2 = startResult2.recordingId;

    const stopResponse2 = await sendMCPRequest('tools/call', {
      name: 'stop_continuous_recording',
      arguments: { 
        recordingId: recordingId2,
        name: 'overwrite-test.mid',
        overwrite: true  // 上書き有効
      }
    });

    const stopResult2 = stopResponse2.result.content?.[0]?.text 
      ? JSON.parse(stopResponse2.result.content[0].text)
      : stopResponse2.result;

    if (stopResult2.name !== 'overwrite-test.mid') {
      console.error('[diagnostic] overwrite file name mismatch:', stopResult2);
    }
    expect(stopResult2.name).toBe('overwrite-test.mid'); // 同じファイル名
  }, 12000);
});