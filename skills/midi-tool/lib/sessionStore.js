import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const retentionMs = 24 * 60 * 60 * 1000;
function id(value) { return value.playbackId ?? value.captureId ?? value.recordingId ?? value.id; }
function active(value) { return value.done === false || value.recording === true || ['pending', 'saving'].includes(value.saveStatus) || ['active', 'running', 'recording', 'capturing', 'pending', 'saving', 'listening', 'waiting_for_input'].includes(value.status) || ['active', 'running', 'recording', 'capturing', 'pending', 'saving', 'listening', 'waiting_for_input'].includes(value.state); }
function interrupted(value) { return { ...value, done: true, recording: false, saveStatus: value.saveStatus ? 'failed' : undefined, status: 'interrupted', state: 'interrupted', interrupted: true, error: { code: 'INTERRUPTED', message: 'Runtime ended before this session completed' } }; }
async function readDocument(dataDir) {
    try {
        const value = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions/status.json'), 'utf8'));
        if (value.version !== 1 || !Array.isArray(value.sessions))
            throw new Error('Unsupported session snapshot');
        return value;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
}
export class SessionStore {
    dataDir;
    instanceId = randomUUID();
    records = new Map();
    queue = Promise.resolve();
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async initialize() {
        const document = await readDocument(this.dataDir);
        for (const record of document?.sessions ?? []) {
            if (Date.now() - record.updatedAt > retentionMs && !active(record.value))
                continue;
            if (active(record.value)) {
                record.value = interrupted(record.value);
                record.updatedAt = Date.now();
            }
            this.records.set(`${record.kind}:${id(record.value)}`, record);
        }
    }
    save(snapshot) {
        // Clone immediately: engine registries may change while a previous disk write completes.
        const frozen = JSON.parse(JSON.stringify(snapshot));
        const run = this.queue.then(async () => {
            const now = Date.now();
            for (const kind of ['playbacks', 'captures', 'recordings'])
                for (const value of frozen[kind]) {
                    const sessionId = id(value);
                    if (!sessionId)
                        continue;
                    const key = `${kind}:${sessionId}`;
                    const previous = this.records.get(key);
                    const unchanged = previous && JSON.stringify(previous.value) === JSON.stringify(value);
                    this.records.set(key, { kind, value, updatedAt: unchanged ? previous.updatedAt : now, instanceId: this.instanceId, pid: process.pid });
                }
            for (const [key, record] of this.records)
                if (!active(record.value) && now - record.updatedAt > retentionMs)
                    this.records.delete(key);
            const directory = path.join(this.dataDir, 'sessions');
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const target = path.join(directory, 'status.json'), temp = `${target}.${this.instanceId}.tmp`;
            try {
                await fs.writeFile(temp, JSON.stringify({ version: 1, instanceId: this.instanceId, pid: process.pid, sessions: [...this.records.values()] }), { mode: 0o600 });
                await fs.rename(temp, target);
            }
            finally {
                await fs.unlink(temp).catch(() => { });
            }
        });
        this.queue = run.catch(() => { });
        return run;
    }
}
export async function persistedSessionResult(dataDir, operation, args = {}) {
    const kind = operation === 'get_playback_status' ? 'playbacks' : operation === 'get_single_capture_status' ? 'captures' : ['get_continuous_recording_status', 'list_continuous_recordings'].includes(operation) ? 'recordings' : undefined;
    if (!kind)
        return;
    const document = await readDocument(dataDir);
    if (!document)
        return;
    const values = document.sessions.filter(record => record.kind === kind && (active(record.value) || Date.now() - record.updatedAt <= retentionMs)).map(record => {
        // Fallback is historical: never claim persisted active sessions are live.
        return active(record.value) ? interrupted(record.value) : record.value;
    });
    if (operation === 'list_continuous_recordings') {
        const filter = args.status ?? 'active';
        const filtered = filter === 'active' ? [] : values;
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
        return { ok: true, recordings: filtered.sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '')).slice(0, limit), total: values.length, activeCount: 0, completedCount: values.length };
    }
    const sessionId = args.playbackId ?? args.captureId ?? args.recordingId ?? args.id;
    const value = values.find(value => id(value) === sessionId);
    return value ? { ok: true, ...value } : undefined;
}
