import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() {
  const child = spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'] });
  return child;
}
function sendLine(child: any, obj: any) { child.stdin.write(JSON.stringify(obj)+'\n'); }
async function readLine(child: any) { const [buf] = await once(child.stdout,'data') as [Buffer]; return JSON.parse(buf.toString().split(/\r?\n/)[0]); }

// 画像から抽出された代表デバイス名（部分一致用キーワード）
const defaultExpectedKeywords = [
  'IAC', 'UM-550', 'DX-7', 'TD17', 'P80', 'MS2000', 'VK-8', 'Akai', 'Rubix24', 'KeyLab', 'Xkey Air', 'Prophecy', 'iPad'
];

describe('実機デバイス一覧が画像と整合するか (ヒューリスティック比較)', () => {
  it('list_devices の結果に代表名が含まれる (ネイティブロード成功時のみ評価)', async () => {
    if (process.platform !== 'darwin') {
      console.warn('[SKIP] 非macOS環境');
      return;
    }
    const child = spawnServer();
    try {
      sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'snapshot-test', version:'1.0.0'} } });
      await readLine(child);
      sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'list_devices', arguments:{} } });
      const resp = await readLine(child);
      expect(resp.error).toBeUndefined();
      const body = resp.result;
      const diagnostics = body.diagnostics || {};
      const names: string[] = (body.devices||[]).map((d:any)=> d.name);
      const nativeFailed = diagnostics.nativeLoadFailed;
      if (nativeFailed) {
        console.warn('[INFO] ネイティブロード失敗のため比較スキップ:', nativeFailed);
        // 現状 placeholder のみであることを最低限保証
        if (names.length === 1) expect(names[0]).toMatch(/placeholder/i);
        return; // スキップ扱い
      }
      // 環境変数で期待名を上書き可能 (カンマ区切り)
      const expectedKw = process.env.MCP_MIDI_EXPECT_DEVICES
        ? process.env.MCP_MIDI_EXPECT_DEVICES.split(',').map(s=>s.trim()).filter(Boolean)
        : defaultExpectedKeywords;
      const found: string[] = [];
      for (const kw of expectedKw) {
        if (names.some(n => n.includes(kw))) found.push(kw);
      }
      // 画像に多数あるので閾値: 期待候補のうち 3 以上ヒットで合格 (緩め)
      const threshold = Math.min(3, expectedKw.length);
      const ok = found.length >= threshold;
      if (!ok) {
        console.error('期待候補 <-> 実デバイス 照合失敗', { expectedKw, names, found });
      }
      expect(ok).toBe(true);
    } finally {
      // 終了
      // @ts-ignore
      child.kill();
    }
  });
});
