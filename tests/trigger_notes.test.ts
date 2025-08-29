import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() { const child = spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'] }); return child; }
function sendLine(child:any, obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function readLine(child:any){ const [buf] = await once(child.stdout,'data') as [Buffer]; const line = buf.toString('utf8').split(/\r?\n/)[0]; return JSON.parse(line); }

describe('trigger_notes tool', () => {
  it('dryRun returns scheduledNotes and durationMs', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'trigger_notes', arguments:{ notes:['C4','E4','G4'], velocity:96, durationMs:200, dryRun:true } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.scheduledNotes).toBe(3);
    expect(body.durationMs).toBe(200);
    child.kill();
  }, 10000);

  it('accepts numeric notes and transpose', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'trigger_notes', arguments:{ notes:[60,64,67], transpose:12, channel:5, dryRun:true } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.scheduledNotes).toBe(3);
    expect(body.channel).toBe(5); // 外部
    expect(body.internalChannel).toBe(4); // 内部
    child.kill();
  }, 10000);
});

describe('trigger_notes channel mapping', () => {
  it('maps external channel 10 -> internal 9', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'trigger_notes', arguments:{ notes:['C4'], channel:10, dryRun:true } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.channel).toBe(10);
    expect(body.internalChannel).toBe(9);
    child.kill();
  }, 10000);

  it('legacy internal 0 still works with warning and reports external 1', async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0' } } });
    await readLine(child);
    sendLine(child, { jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'trigger_notes', arguments:{ notes:['C4'], channel:0, dryRun:true } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.channel).toBe(1);
    expect(body.internalChannel).toBe(0);
    expect(Array.isArray(body.warnings) ? body.warnings.join('\n') : '').toMatch(/legacy internal/);
    child.kill();
  }, 10000);
});
