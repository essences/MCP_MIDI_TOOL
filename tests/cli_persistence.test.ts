import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const cli = (data: string, ...args: string[]) => new Promise<any>((resolve, reject) => {
  execFile(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--data-dir', data, ...args], { timeout: 20000 }, (error, stdout, stderr) => { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${error} ${stdout} ${stderr}`)); } });
});
test('capture result survives stop and restart; SIGKILL active capture becomes interrupted without autostart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-persistence-')), data = path.join(root, 'data');
  try {
    const capture = await cli(data, 'capture', 'start', '--source', 'simulated', '--max-wait-ms', '60000', '--finalize-on-release'); expect(capture.ok).toBe(true);
    await cli(data, 'capture', 'feed', '--id', capture.captureId, '--events', JSON.stringify([{ kind: 'on', note: 60, velocity: 90, at: 0 }, { kind: 'off', note: 60, at: 100 }]));
    const before = await cli(data, 'capture', 'status', '--id', capture.captureId); expect(before.result.notes).toEqual([60]);
    await cli(data, 'runtime', 'stop'); await new Promise(resolve => setTimeout(resolve, 100));
    const saved = await cli(data, 'capture', 'status', '--id', capture.captureId); expect(saved.result).toEqual(before.result);
    expect((await cli(data, 'runtime', 'status')).error.code).toBe('NOT_RUNNING');
    const running = await cli(data, 'capture', 'start', '--source', 'simulated', '--max-wait-ms', '60000'); expect(running.ok).toBe(true);
    expect((await cli(data, 'capture', 'status', '--id', capture.captureId)).result).toEqual(before.result);
    const runtime = await cli(data, 'runtime', 'status'); process.kill(runtime.pid, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 100));
    const interrupted = await cli(data, 'capture', 'status', '--id', running.captureId);
    expect(interrupted).toMatchObject({ ok: true, done: true, interrupted: true, status: 'interrupted' });
    expect((await cli(data, 'runtime', 'status')).error.code).toBe('NOT_RUNNING');
  } finally { await cli(data, 'runtime', 'stop'); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
