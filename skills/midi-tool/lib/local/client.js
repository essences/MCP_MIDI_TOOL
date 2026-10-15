import { persistedSessionResult } from '../sessionStore.js';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const VERSION = 1;
export const BUILD_VERSION = "0.1.0-cli-1";
export const MAX_MESSAGE = 16 * 1024 * 1024;
export function endpoint(dataDir) {
    const directory = path.join(os.tmpdir(), `midi-tool-${process.getuid?.() ?? 'user'}`);
    const key = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 24);
    return { directory, socket: path.join(directory, `${key}.sock`), lock: path.join(directory, `${key}.lock`) };
}
export function failure(code, message) { return { ok: false, error: { code, message } }; }
export async function request(dataDir, operation, args = {}, timeout = 15000) {
    const id = randomUUID();
    return new Promise(resolve => {
        const socket = net.createConnection(endpoint(dataDir).socket);
        let buffer = '';
        let settled = false;
        socket.setEncoding('utf8');
        const finish = (result) => { if (settled)
            return; settled = true; socket.destroy(); resolve(result); };
        socket.setTimeout(timeout, () => finish(failure('TIMEOUT', 'Runtime request timed out; outcome may be unknown')));
        socket.on('error', (error) => finish(failure(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'NOT_RUNNING' : 'CONNECTION_ERROR', error.message)));
        socket.on('connect', () => { const line = JSON.stringify({ version: VERSION, build: BUILD_VERSION, id, operation, args }) + '\n'; if (Buffer.byteLength(line) > MAX_MESSAGE)
            return finish(failure('LIMIT_EXCEEDED', 'Request too large')); socket.write(line); });
        socket.on('data', chunk => { buffer += chunk.toString(); if (Buffer.byteLength(buffer) > MAX_MESSAGE)
            return finish(failure('LIMIT_EXCEEDED', 'Response too large')); const end = buffer.indexOf('\n'); if (end < 0)
            return; try {
            const value = JSON.parse(buffer.slice(0, end));
            if (value.version !== VERSION || value.build !== BUILD_VERSION)
                return finish(failure('VERSION_MISMATCH', 'Runtime protocol version mismatch'));
            if (value.id !== id)
                return finish(failure('PROTOCOL_ERROR', 'Runtime response ID mismatch'));
            finish(value.result);
        }
        catch {
            finish(failure('PROTOCOL_ERROR', 'Invalid runtime response'));
        } });
        socket.on('end', () => finish(failure('CONNECTION_CLOSED', 'Runtime disconnected; outcome may be unknown')));
    });
}
export async function callRuntime(dataDir, operation, args = {}, autostart = false) {
    const status = await request(dataDir, 'runtime.status', {}, 1000);
    const historical = async (result) => {
        const eligible = ['NOT_RUNNING', 'NOT_FOUND'].includes(result.error?.code);
        if (eligible)
            return await persistedSessionResult(dataDir, operation, args) ?? result;
        if (operation === 'list_continuous_recordings' && result.ok) {
            const saved = await persistedSessionResult(dataDir, operation, args);
            const current = result.recordings ?? [];
            const merged = [...current, ...(saved?.recordings ?? []).filter((item) => !current.some((entry) => (entry.recordingId ?? entry.id) === (item.recordingId ?? item.id)))];
            merged.sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
            const activeCount = merged.filter((item) => ['waiting_for_input', 'recording'].includes(item.status)).length;
            const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
            return { ...result, recordings: merged.slice(0, limit), total: merged.length, activeCount, completedCount: merged.length - activeCount };
        }
        return result;
    };
    if (status.ok)
        return historical(await request(dataDir, operation, args));
    const statusOnly = ['get_playback_status', 'get_single_capture_status', 'get_continuous_recording_status', 'list_continuous_recordings'].includes(operation);
    if (!autostart || statusOnly || status.error?.code !== 'NOT_RUNNING')
        return historical(status);
    const location = endpoint(dataDir);
    await fs.mkdir(location.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(location.directory, 0o700);
    const deadline = Date.now() + 10000;
    let owner = false;
    const token = randomUUID();
    while (Date.now() < deadline) {
        try {
            await fs.mkdir(location.lock, { mode: 0o700 });
            await fs.writeFile(path.join(location.lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }));
            owner = true;
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const live = await request(dataDir, 'runtime.status', {}, 500);
            if (live.ok)
                return request(dataDir, operation, args);
            try {
                const previous = JSON.parse(await fs.readFile(path.join(location.lock, 'owner.json'), 'utf8'));
                let dead = false;
                try {
                    process.kill(previous.pid, 0);
                }
                catch (e) {
                    dead = e.code === 'ESRCH';
                }
                if (dead) {
                    const guard = location.lock + '.recovery';
                    let recovery = false;
                    try {
                        await fs.mkdir(guard, { mode: 0o700 });
                        recovery = true;
                        const before = await fs.stat(location.lock);
                        const current = JSON.parse(await fs.readFile(path.join(location.lock, 'owner.json'), 'utf8'));
                        if (current.token === previous.token && current.pid === previous.pid) {
                            const after = await fs.stat(location.lock);
                            if (after.ino === before.ino)
                                await fs.rm(location.lock, { recursive: true });
                        }
                    }
                    catch { }
                    finally {
                        if (recovery)
                            await fs.rmdir(guard).catch(() => { });
                    }
                }
            }
            catch { }
            await new Promise(r => setTimeout(r, 100));
        }
    }
    if (!owner)
        return failure('START_TIMEOUT', 'Runtime start lock timed out');
    try {
        const live = await request(dataDir, 'runtime.status', {}, 500);
        if (!live.ok) {
            if (live.error?.code !== 'NOT_RUNNING')
                return live;
            // Unlink only after a failed real connection, while holding this data directory startup lock.
            await fs.unlink(location.socket).catch((error) => { if (error.code !== 'ENOENT')
                throw error; });
            const entry = fileURLToPath(new URL('./runtime.js', import.meta.url));
            const source = entry.endsWith('/src/local/runtime.js');
            const log = await fs.open(path.join(location.directory, path.basename(location.socket) + '.log'), 'a', 0o600);
            const child = spawn(process.execPath, source ? ['--import', 'tsx', entry.replace(/\.js$/, '.ts'), dataDir] : [entry, dataDir], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, MIDI_TOOL_DATA_DIR: dataDir, MCP_MIDI_MANIFEST: 'manifest.json' } });
            child.unref();
            await log.close();
            let spawnError;
            child.once('error', e => { spawnError = e; });
            while (Date.now() < deadline) {
                if (spawnError)
                    return failure('START_FAILED', spawnError.message);
                const ready = await request(dataDir, 'runtime.status', {}, 500);
                if (ready.ok)
                    break;
                if (ready.error?.code !== 'NOT_RUNNING')
                    return ready;
                await new Promise(r => setTimeout(r, 75));
            }
        }
        return request(dataDir, operation, args);
    }
    finally {
        const current = await fs.readFile(path.join(location.lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (current?.token === token)
            await fs.rm(location.lock, { recursive: true, force: true });
    }
}
