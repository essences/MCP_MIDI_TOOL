import net from 'node:net';
import { promises as fs } from 'node:fs';
import { createMidiEngine } from '../engine.js';
import { SessionStore } from '../sessionStore.js';
import { endpoint, VERSION, BUILD_VERSION, MAX_MESSAGE, failure } from './client.js';
export async function serve(dataDir: string) {
  process.env.MIDI_TOOL_DATA_DIR = dataDir; process.env.MCP_MIDI_MANIFEST = 'manifest.json';
  const engine = createMidiEngine(), store = new SessionStore(dataDir), location = endpoint(dataDir);
  let queue = Promise.resolve(), stopping = false, idleSince = Date.now(), pending = 0;
  let closing: Promise<void> | undefined;
  const sockets = new Set<net.Socket>();
  try { await store.initialize(); await store.save(engine.snapshot()); }
  catch (error) { await engine.dispose().catch(() => {}); throw error; }
  const persist = () => store.save(engine.snapshot());
  const server = net.createServer(socket => {
    socket.setEncoding('utf8'); sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(20000, () => socket.destroy());
    let buffer = '', received = false;
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_MESSAGE) { received = true; socket.end(JSON.stringify({ version: VERSION, build: BUILD_VERSION, result: failure('LIMIT_EXCEEDED', 'Request too large') }) + '\n'); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      received = true; let req: any;
      try { req = JSON.parse(buffer.slice(0, end)); }
      catch { socket.end(JSON.stringify({ version: VERSION, build: BUILD_VERSION, result: failure('INPUT_ERROR', 'Invalid JSON') }) + '\n'); return; }
      pending++;
      queue = queue.then(async () => {
        let result: any, shutdown = false;
        try {
          if (req.version !== VERSION || req.build !== BUILD_VERSION) result = failure('VERSION_MISMATCH', 'Runtime protocol version mismatch');
          else if (stopping) result = failure('NOT_RUNNING', 'Runtime stopping');
          else if (req.operation === 'runtime.status') result = { ok: true, build: BUILD_VERSION, pid: process.pid, activity: engine.getActivity() };
          else if (req.operation === 'runtime.stop') {
            stopping = true; shutdown = true;
            await engine.dispose(); result = { ok: true, stopped: true };
          } else if (typeof req.operation !== 'string' || !req.args || typeof req.args !== 'object' || Array.isArray(req.args)) result = failure('INPUT_ERROR', 'Operation and object args required');
          else { idleSince = Date.now(); result = await engine.call(req.operation, req.args); }
        } catch (error: any) { result = failure('INTERNAL_ERROR', error.message); }
        try { await persist(); } catch (error: any) { result = failure('PERSISTENCE_ERROR', error.message); }
        socket.end(JSON.stringify({ version: VERSION, build: BUILD_VERSION, id: req.id, result }) + '\n');
        if (shutdown) setTimeout(() => void close().catch(report), 50);
      }).catch(report).finally(() => { pending--; });
    });
  });
  const report = (error: unknown) => console.error(error instanceof Error ? error.message : String(error));
  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      clearInterval(idle); clearInterval(snapshotTimer);
      try { await engine.dispose(); } catch (error) { report(error); }
      try { await persist(); } catch (error) { report(error); }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.unlink(location.socket).catch(() => {});
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
      process.removeListener('uncaughtException', onException); process.removeListener('unhandledRejection', onException);
    })();
    return closing;
  }
  const snapshotTimer = setInterval(() => { if (!stopping) void persist().catch(report); }, 250); snapshotTimer.unref();
  const idle = setInterval(() => {
    const activity = engine.getActivity();
    if (pending || Object.values(activity).some(value => value > 0)) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince > Number(process.env.MIDI_TOOL_IDLE_MS || 60000) && !stopping) { stopping = true; queue = queue.then(close).catch(report); }
  }, 1000); idle.unref();
  function onSignal() { if (!stopping) { stopping = true; queue = queue.then(close).catch(report); } }
  function onException(error: unknown) { report(error); process.exitCode = 1; void close().catch(report); }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); process.once('uncaughtException', onException); process.once('unhandledRejection', onException);
  try {
    await fs.mkdir(location.directory, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(location.socket, () => resolve()); });
    await fs.chmod(location.socket, 0o600);
  } catch (error) { await close(); throw error; }
}
if (process.argv[1]?.match(/runtime\.(js|ts)$/)) serve(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
