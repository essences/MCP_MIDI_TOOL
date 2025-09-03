import { spawn, ChildProcess } from 'child_process';
import path from 'path';

export interface McpTestServer {
  process: ChildProcess;
  ready: boolean;
  send: (method: string, params?: any, timeoutMs?: number) => Promise<any>;
  shutdown: () => Promise<void>;
}

export async function spawnMcpServer(startTimeoutMs = 4000): Promise<McpTestServer> {
  const child = spawn('node', [path.resolve('./dist/index.js')], { stdio: ['pipe','pipe','pipe'] });
  let ready = false;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { resolve(); }, startTimeoutMs);
    let buffer = '';
    const onData = (chunk: Buffer) => {
      if (ready) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.ready) {
            ready = true; clearTimeout(timeout); child.stdout?.off('data', onData); resolve();
            return;
          }
        } catch { /* ignore non JSON lines */ }
      }
    };
    child.stdout?.on('data', onData);
  });
  child.stderr?.on('data', d => console.error('[server:stderr]', d.toString()));

  const send = (method: string, params: any = {}, timeoutMs = 10000): Promise<any> => {
    if (!child.stdin || !child.stdout) return Promise.reject(new Error('Server stdio not ready'));
    const requestId = Math.floor(Math.random() * 1_000_000);
    const request = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === requestId) {
              child.stdout?.off('data', onData);
              resolve(parsed);
              return;
            }
          } catch {/* ignore */}
        }
      };
      const to = setTimeout(() => { child.stdout?.off('data', onData); reject(new Error('Request timeout')); }, timeoutMs);
      child.stdout?.on('data', onData);
      child.stdin.write(request);
      child.on('exit', () => { clearTimeout(to); child.stdout?.off('data', onData); });
    });
  };

  const shutdown = async () => {
    if (child.exitCode == null) {
      child.kill();
      await new Promise(r => { child.on('exit', r); setTimeout(r, 1000); });
    }
  };

  return { process: child, ready, send, shutdown };
}
