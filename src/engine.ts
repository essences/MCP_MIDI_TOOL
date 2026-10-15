import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getItemById, readManifest, resolveExportDir, resolveBaseDir, withDataWriteLock } from "./storage.js";
import { saveMidiRecord, saveMidiRecordUnlocked, safeMidiName } from "./fileStore.js";
import { buildPlaybackPlan } from "./playbackPlan.js";
import { startPlayback } from "./playbackRuntime.js";
import { zSong } from "./jsonSchema.js";
import { encodeToSmfBinary } from "./jsonToSmf.js";
import { decodeSmfToJson } from "./smfToJson.js";
import { compileScoreToJsonMidi } from "./scoreToJsonMidi.js";
export type MidiEngineOptions = {
    midi?: {
        Input?: any;
        Output?: any;
    };
};
/** MCP-free business operations; further service splitting can preserve this API. */
export function createMidiEngine(options: MidiEngineOptions = {}) {
    let MidiOutput: any = options.midi?.Output ?? null;
    let MidiInput: any = options.midi?.Input ?? null;
    let lastMidiLoadError: any = null; // ネイティブ import 失敗内容を保持（後段 diagnostics で可視化）
    async function loadMidi() {
        if (options.midi || MidiOutput || MidiInput)
            return { MidiOutput, MidiInput, error: lastMidiLoadError };
        try {
            const mod: any = await import('midi');
            const Out = mod?.Output || mod?.default?.Output;
            const In = mod?.Input || mod?.default?.Input;
            MidiOutput = typeof Out === 'function' ? Out : null;
            MidiInput = typeof In === 'function' ? In : null;
            lastMidiLoadError = null;
        }
        catch (e: any) {
            MidiOutput = null;
            MidiInput = null;
            lastMidiLoadError = e;
        }
        return { MidiOutput, MidiInput, error: lastMidiLoadError };
    }
    type ItemRec = {
        id: string;
        name: string;
        path: string;
        bytes: number;
        createdAt: string;
    };
    const playbacks = new Map<string, any>();
    let disposed = false;
    const ports = new Set<any>();
    function trackPort(port: any) {
        ports.add(port);
        const close = port.closePort?.bind(port);
        port.closePort = () => { try { return close?.(); } finally { ports.delete(port); } };
        return port;
    }
    const recordingSaves = new Map<string, Promise<any>>();
    const recordingResults = new Map<string, any>();
    const pendingSaves = new Set<string>();
    function saveContinuousRecordingAsSmf(session: ContinuousRecordingSession, name?: string, overwrite?: boolean): Promise<any> {
        name ??= session.outputName;
        overwrite ??= session.overwrite;
        let pending = recordingSaves.get(session.id);
        if (!pending) {
            pendingSaves.add(session.id);
            pending = persistContinuousRecording(session, name, overwrite).then(result => {
                const saved = {ok:true,...result,recordingId:session.id,reason:session.reason,recordingStartedAt:new Date(session.startedAt).toISOString(),recordingEndedAt:new Date(session.endedAt!).toISOString(),savedAt:new Date().toISOString()};
                recordingResults.set(session.id, saved);
                return saved;
            }, error => {
                recordingResults.set(session.id, {ok:false,error:{code:'SAVE_FAILED',message:String(error?.message||error)}});
                throw error;
            }).finally(() => pendingSaves.delete(session.id));
            recordingSaves.set(session.id, pending);
        }
        return pending;
    }
    const classifyError = (tool: string, err: any): {
        code: string;
        message: string;
        hint?: string;
        issues?: any[];
    } => {
        const rawMsg = (err?.message || String(err) || "").trim();
        const lower = rawMsg.toLowerCase();
        let code = typeof err?.code === "string" ? err.code : "INTERNAL_ERROR";
        let hint: string | undefined;
        // 既に json_to_smf で加工された issues (path/message/code/expected/received) を尊重
        const rawIssues: any[] | undefined = Array.isArray(err?.issues) ? err.issues : undefined;
        const issues = rawIssues?.map(i => ({
            path: i.path,
            message: i.message,
            code: i.code,
            expected: i.expected,
            received: i.received
        }));
        if (/already exists/.test(lower)) {
            code = 'ALREADY_EXISTS';
        } else if (/invalid midi name/.test(lower)) {
            code = 'INPUT_FORMAT_ERROR';
        } else if (/validation failed|compile failed|json validation failed/.test(lower)) {
            code = "VALIDATION_ERROR";
            hint = "入力JSON/Score DSL のスキーマを README と docs/specs を参照して修正してください (format指定推奨)";
        }
        else if (/not found/i.test(rawMsg)) {
            code = "NOT_FOUND";
            if (lower.includes("fileid"))
                hint = "有効な fileId を list_midi や json_to_smf の結果から指定してください";
        }
        else if (/required/.test(lower)) {
            code = "MISSING_PARAMETER";
            const m = rawMsg.match(/'(\w+)' is required/i);
            if (m)
                hint = `パラメータ ${m[1]} を arguments に追加してください`;
        }
        else if (/invalid note name|unsupported note item|invalid json|invalid smf/i.test(lower)) {
            code = "INPUT_FORMAT_ERROR";
            hint = "音名表記やJSON構造を再確認してください (例: C4, F#3, Bb5)";
        }
        else if (/size exceeds|too large|exceeds/i.test(lower)) {
            code = "LIMIT_EXCEEDED";
            hint = "データサイズを削減するか分割して append_to_smf を利用してください";
        }
        else if (/node-midi not available|failed to open.*port/i.test(lower)) {
            code = "DEVICE_UNAVAILABLE";
            hint = "出力デバイス利用不可。macOS/IAC かサポート環境で再試行、または dryRun を使用";
        }
        return { code, message: rawMsg, hint, ...(issues ? { issues } : {}) };
    };
    function nameToMidiLocal(s: string): number | undefined {
        const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(s).trim());
        if (!m)
            return undefined;
        const letter = m[1].toUpperCase();
        const acc = m[2];
        const oct = parseInt(m[3], 10);
        const baseMap: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        let sem = baseMap[letter];
        if (sem === undefined)
            return undefined;
        if (acc === '#')
            sem += 1;
        else if (acc === 'b')
            sem -= 1;
        const midi = 12 * (oct + 1) + sem;
        if (midi < 0 || midi > 127)
            return undefined;
        return midi;
    }
    type CaptureState = {
        id: string;
        startedAt: number; // epoch ms
        onsetWindowMs: number;
        silenceMs: number;
        maxWaitMs: number;
        originMs?: number; // 最初のNoteOn(=和音起点)
        lastEventAt?: number; // 相対ms (origin基準ではなく capture開始基準)
        notes: Map<number, {
            onAt: number;
            offAt?: number;
            velocity: number;
        }>;
        done: boolean;
        reason?: 'completed' | 'timeout';
        result?: any;
        // デバイスキャプチャ用
        inputInstance?: any; // node-midi Input
        inputPortName?: string;
        finalizeOnRelease?: boolean; // 全ノートOff時に即確定（silenceMs待機をスキップ）
    };
    const captureRegistry: Map<string, CaptureState> = new Map();
    type ContinuousRecordingSession = {
        id: string;
        startedAt: number; // epoch ms
        endedAt?: number; // Frozen completion time, including the release of held notes.
        pendingNotes: Map<string, any[]>; // FIFO queues keyed by internal channel:pitch.
        firstInputAt?: number; // epoch ms
        lastInputAt?: number; // epoch ms
        status: 'waiting_for_input' | 'recording' | 'completed' | 'timeout_idle' | 'timeout_silence' | 'timeout_max_duration' | 'stopped_manually' | 'error';
        reason?: string;
        // 設定値
        ppq: number;
        outputName?: string;
        overwrite?: boolean;
        maxDurationMs: number;
        idleTimeoutMs: number;
        silenceTimeoutMs: number;
        channelFilter?: number[]; // 1-16 external representation
        eventTypeFilter: string[]; // 'note', 'cc', 'pitchBend', 'program'
        // MIDI入力管理
        inputInstance?: any; // node-midi Input
        inputPortName?: string;
        // イベントバッファ
        events: Array<{
            tick: number;
            type: string;
            channel?: number; // 内部0-15
            [key: string]: any;
        }>;
        // タイマー管理
        idleTimer?: NodeJS.Timeout;
        silenceTimer?: NodeJS.Timeout;
        maxDurationTimer?: NodeJS.Timeout;
        // メトリクス
        eventCount: number;
        eventBreakdown: Record<string, number>;
        channelActivity: Record<string, number>;
    };
    const continuousRecordingRegistry: Map<string, ContinuousRecordingSession> = new Map();
    function cleanupOldSessions() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24時間
        for (const [sessionId, session] of continuousRecordingRegistry.entries()) {
            // 完了から24時間経過したセッションを削除
            if (session.status === 'completed' ||
                session.status.startsWith('timeout_') ||
                session.status === 'stopped_manually' ||
                session.status === 'error') {
                const endTime = session.lastInputAt || session.startedAt;
                if (now - endTime > maxAge) {
                    // MIDI入力ポートがまだ開いていれば閉じる
                    if (session.inputInstance) {
                        try {
                            if (typeof session.inputInstance.closePort === 'function') {
                                session.inputInstance.closePort();
                            }
                        }
                        catch {
                            // クローズエラーは無視
                        }
                    }
                    continuousRecordingRegistry.delete(sessionId);
                }
            }
        }
    }
    const cleanupInterval = setInterval(cleanupOldSessions, 5 * 60 * 1000);
    function finalizeCapture(st: CaptureState, reason: 'completed' | 'timeout' = 'completed') {
        if (st.done)
            return;
        st.done = true;
        try { st.inputInstance?.closePort(); } catch {}
        st.reason = reason;
        // まだオフになっていないノートは lastEventAt か maxWaitMs 終了時点でオフ扱い
        const endRel = (() => {
            let latest = 0;
            for (const v of st.notes.values()) {
                const off = (v.offAt !== undefined ? v.offAt : (st.lastEventAt ?? 0));
                if (off > latest)
                    latest = off;
            }
            return latest;
        })();
        // 結果整形
        const entries = Array.from(st.notes.entries()).map(([n, v]) => ({ note: n, onAt: v.onAt, offAt: v.offAt ?? endRel, velocity: v.velocity }));
        entries.sort((a, b) => a.note - b.note);
        const notes = entries.map(e => e.note);
        const velocities = entries.map(e => e.velocity);
        const startRel = st.originMs !== undefined ? (st.originMs - st.startedAt) : 0;
        const durationMs = endRel - (st.originMs !== undefined ? (st.originMs - st.startedAt) : 0);
        st.result = { notes, velocities, durationMs: Math.max(0, durationMs), isChord: notes.length > 1 };
    }
    function maybeAutoFinalize(st: CaptureState) {
        if (st.done)
            return;
        const nowMs = Date.now();
        const elapsedSinceStart = nowMs - st.startedAt;
        if (elapsedSinceStart >= st.maxWaitMs) {
            // 期待仕様: 既にノートが発生し全ノートOff状態なら 'completed' 扱い。未入力または入力途中なら 'timeout'
            if (st.originMs) {
                const anyActiveLate = Array.from(st.notes.values()).some(v => v.offAt === undefined);
                if (!anyActiveLate) {
                    finalizeCapture(st, 'completed');
                    return;
                }
            }
            finalizeCapture(st, 'timeout');
            return;
        }
        if (!st.originMs)
            return; // まだ最初のon無しだが maxWaitMs は既に上で判定済
        // 全ノートoff & サイレンス経過
        const anyActive = Array.from(st.notes.values()).some(v => v.offAt === undefined);
        if (!anyActive) {
            if (st.finalizeOnRelease) {
                finalizeCapture(st, 'completed');
            }
            else {
                const lastOff = Math.max(...Array.from(st.notes.values()).map(v => v.offAt ?? 0), 0);
                if ((elapsedSinceStart - lastOff) >= st.silenceMs)
                    finalizeCapture(st, 'completed');
            }
        }
    }
    function createContinuousSession(portName: string, ppq: number, maxDurationMs: number, idleTimeoutMs: number, silenceTimeoutMs: number, channelFilter?: number[], eventTypeFilter?: string[]): ContinuousRecordingSession {
        const id = randomUUID();
        const session: ContinuousRecordingSession = {
            id,
            startedAt: Date.now(),
            status: 'waiting_for_input',
            pendingNotes: new Map(),
            ppq,
            maxDurationMs,
            idleTimeoutMs,
            silenceTimeoutMs,
            channelFilter,
            eventTypeFilter: eventTypeFilter || ['note', 'cc', 'pitchBend', 'program'],
            inputPortName: portName,
            events: [],
            eventCount: 0,
            eventBreakdown: {},
            channelActivity: {}
        };
        return session;
    }
    function finalizeSession(session: ContinuousRecordingSession, reason: string) {
        if (session.endedAt !== undefined) return;
        session.endedAt = Date.now();
        session.reason = reason;
        const endTick = msToTick(session.endedAt - session.startedAt, session.ppq);
        for (const queue of session.pendingNotes.values()) {
            for (const note of queue) note.duration = Math.max(1, endTick - note.tick);
        }
        session.pendingNotes.clear();
        // タイマークリア
        if (session.idleTimer) {
            clearTimeout(session.idleTimer);
            session.idleTimer = undefined;
        }
        if (session.silenceTimer) {
            clearTimeout(session.silenceTimer);
            session.silenceTimer = undefined;
        }
        if (session.maxDurationTimer) {
            clearTimeout(session.maxDurationTimer);
            session.maxDurationTimer = undefined;
        }
        // MIDI入力クローズ
        if (session.inputInstance) {
            try {
                session.inputInstance.closePort();
            }
            catch { }
            session.inputInstance = undefined;
        }
    }
    function startSilenceTimer(session: ContinuousRecordingSession) {
        // 既存のサイレンスタイマーをクリア
        if (session.silenceTimer) {
            clearTimeout(session.silenceTimer);
        }
        session.silenceTimer = undefined;
        if (session.pendingNotes.size || session.endedAt !== undefined) return;
        session.silenceTimer = setTimeout(async () => {
            const currentSession = continuousRecordingRegistry.get(session.id);
            if (currentSession && currentSession.status === 'recording' && !currentSession.pendingNotes.size) {
                currentSession.status = 'timeout_silence';
                finalizeSession(currentSession, 'silence_timeout');
                // 自動SMF保存
                try {
                    await saveContinuousRecordingAsSmf(currentSession);
                }
                catch (error) {
                    console.error('Failed to auto-save recording on silence timeout:', error);
                }
                continuousRecordingRegistry.set(currentSession.id, currentSession);
            }
        }, session.silenceTimeoutMs);
    }
    async function persistContinuousRecording(session: ContinuousRecordingSession, name?: string, overwrite?: boolean): Promise<{
        fileId: string;
        name: string;
        path: string;
        bytes: number;
        durationMs: number;
        eventCount: number;
        ppq: number;
        trackCount: number;
    }> {
        // ファイル名生成・重複回避
        const timestamp = new Date(session.startedAt);
        const defaultName = `recording-${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')}-${String(timestamp.getHours()).padStart(2, '0')}${String(timestamp.getMinutes()).padStart(2, '0')}${String(timestamp.getSeconds()).padStart(2, '0')}.mid`;
        const originalName = safeMidiName(name || defaultName);
        const data = encodeToSmfBinary({format:0,ppq:session.ppq,tracks:[{events:[{type:'meta.tempo',tick:0,usPerQuarter:500000},...session.events] as any}]});
        let filename = originalName;
        let suffix = 1;
        while (true) {
            try {
                const record = await saveMidiRecord(data,{name:filename,overwrite});
                return {fileId:record.fileId,name:record.name,path:record.path,bytes:record.bytes,durationMs:(session.endedAt??Date.now())-session.startedAt,eventCount:session.eventCount,ppq:session.ppq,trackCount:1};
            } catch (error:any) {
                if (overwrite || !/MIDI file already exists:/.test(error?.message||'')) throw error;
                filename = `${originalName.replace(/\.midi?$/i,'')}_${suffix++}.mid`;
            }
        }
    }

    function msToTick(relativeMs: number, ppq: number): number {
        // 仮の固定テンポ120BPM (500000 us/quarter)
        const usPerQuarter = 500000;
        const ticksPerMs = (ppq * 1000) / usPerQuarter;
        return Math.round(relativeMs * ticksPerMs);
    }
    function barToTick(bar: number, ppq: number, timeSignature: {
        numerator: number;
        denominator: number;
    } = { numerator: 4, denominator: 4 }): number {
        // 小節1から開始（bar=1は tick=0）
        const barIndex = bar - 1;
        const ticksPerBeat = ppq * (4 / timeSignature.denominator); // 4分音符基準
        const ticksPerBar = ticksPerBeat * timeSignature.numerator;
        return Math.round(barIndex * ticksPerBar);
    }
    function tickToBar(tick: number, ppq: number, timeSignature: {
        numerator: number;
        denominator: number;
    } = { numerator: 4, denominator: 4 }): number {
        const ticksPerBeat = ppq * (4 / timeSignature.denominator);
        const ticksPerBar = ticksPerBeat * timeSignature.numerator;
        const barIndex = Math.floor(tick / ticksPerBar);
        return barIndex + 1; // 小節1から開始
    }
    function extractTimeSignatureFromJson(jsonMidi: any): {
        numerator: number;
        denominator: number;
    } {
        // JSON MIDIからタイムシグネチャを抽出
        if (jsonMidi?.tracks) {
            for (const track of jsonMidi.tracks) {
                if (track?.events) {
                    for (const event of track.events) {
                        if (event?.type === 'meta.timeSignature' && event.numerator && event.denominator) {
                            return { numerator: event.numerator, denominator: event.denominator };
                        }
                    }
                }
            }
        }
        return { numerator: 4, denominator: 4 }; // デフォルト4/4拍子
    }
    function touchRecordingInput(session: ContinuousRecordingSession) {
        session.lastInputAt = Date.now();
        if (session.status === 'waiting_for_input') {
            session.status = 'recording';
            session.firstInputAt = session.lastInputAt;
            if (session.idleTimer) clearTimeout(session.idleTimer);
            session.idleTimer = undefined;
        }
        startSilenceTimer(session);
    }
    function addEventToSession(session: ContinuousRecordingSession, bytes: number[], relativeMs: number) {
        if (session.endedAt !== undefined || bytes.length < 2) return;
        const status = bytes[0] | 0;
        const type = status & 0xf0;
        const channel = status & 0x0f;
        const externalChannel = channel + 1;
        if (session.channelFilter && !session.channelFilter.includes(externalChannel)) return;
        const tick = msToTick(Math.max(0, relativeMs), session.ppq); // Explicit fixed 120 BPM.
        const isNote = (type === 0x90 || type === 0x80) && bytes.length >= 3;
        const eventType = isNote ? 'note' : type === 0xb0 && bytes.length >= 3 ? 'cc' : type === 0xe0 && bytes.length >= 3 ? 'pitchBend' : type === 0xc0 ? 'program' : '';
        if (!session.eventTypeFilter.includes(eventType)) return;
        const key = `${channel}:${bytes[1] & 0x7f}`;
        if (isNote && (type === 0x80 || bytes[2] === 0)) {
            const queue = session.pendingNotes.get(key);
            const note = queue?.shift();
            if (note) {
                note.duration = Math.max(1, tick - note.tick);
                if (!queue!.length) session.pendingNotes.delete(key);
                touchRecordingInput(session);
            }
            return;
        }
        if (session.events.length >= 100000 || session.events.length * 50 >= 10 * 1024 * 1024) {
            session.status = 'error';
            finalizeSession(session, 'event_limit_exceeded');
            void saveContinuousRecordingAsSmf(session).catch(() => {});
            return;
        }
        let event: any = {tick, channel, type:eventType};
        if (isNote) {
            event = {...event,pitch:bytes[1] & 0x7f,velocity:bytes[2] & 0x7f,duration:1};
            const queue = session.pendingNotes.get(key) || [];
            queue.push(event);
            session.pendingNotes.set(key,queue);
        } else if (eventType === 'cc') event = {...event,controller:bytes[1] & 0x7f,value:bytes[2] & 0x7f};
        else if (eventType === 'pitchBend') event = {...event,value:((bytes[2] & 0x7f) << 7 | (bytes[1] & 0x7f))-8192};
        else if (eventType === 'program') event = {...event,program:bytes[1] & 0x7f};
        else return;
        session.events.push(event);
        session.eventCount++;
        session.eventBreakdown[eventType] = (session.eventBreakdown[eventType] || 0) + 1;
        session.channelActivity[String(externalChannel)] = (session.channelActivity[String(externalChannel)] || 0) + 1;
        touchRecordingInput(session);
    }
    function ensureInputAvailable(portName: string, temporaryPort: any) {
        for (const st of captureRegistry.values()) maybeAutoFinalize(st);
        const busy = [...continuousRecordingRegistry.values()].some(st => st.inputPortName === portName && st.inputInstance)
            || [...captureRegistry.values()].some(st => st.inputPortName === portName && !st.done && st.inputInstance);
        if (busy) {
            temporaryPort.closePort();
            throw Object.assign(new Error(`Input port is already in use: ${portName}`), {code:'DEVICE_BUSY'});
        }
    }
    cleanupInterval.unref();
    async function dispatch(name: string, args: Record<string, any> = {}): Promise<any> {
        try {
            if (name === "trigger_notes") {
                const rawNotes = args?.notes;
                if (!Array.isArray(rawNotes) || rawNotes.length === 0)
                    throw new Error("'notes' must be a non-empty array");
                const rawChannelInput = args?.channel;
                let channel: number; // 内部0-15
                let resolvedChannelExternal: number; // 外部1-16
                const warnings: string[] = [];
                if (rawChannelInput === undefined) {
                    channel = 0;
                    resolvedChannelExternal = 1;
                }
                else {
                    const num = Number(rawChannelInput);
                    if (!Number.isFinite(num))
                        throw new Error("channel must be a number (1-16)");
                    if (num >= 1 && num <= 16) {
                        // 正常な外部表記
                        resolvedChannelExternal = num | 0;
                        channel = (num - 1) | 0;
                    }
                    else if (num >= 0 && num <= 15) {
                        // 旧実装互換: 内部値が直接渡されたケース
                        channel = num | 0;
                        resolvedChannelExternal = (num + 1) | 0;
                        warnings.push(`channel value ${num} interpreted as legacy internal (0-15). Use 1-16 external next time -> external ${resolvedChannelExternal}.`);
                    }
                    else {
                        throw new Error("channel out of range (expected 1-16)");
                    }
                }
                const velocity = Math.max(1, Math.min(127, Number(args?.velocity ?? 100) | 0));
                const durationMs = Math.max(20, Math.min(10000, Number(args?.durationMs ?? 500) | 0));
                const transpose = Number.isFinite(Number(args?.transpose)) ? (Number(args?.transpose) | 0) : 0;
                const program = Number.isFinite(Number(args?.program)) ? (Number(args?.program) | 0) : undefined;
                const dryRun = !!args?.dryRun;
                // normalize notes to midi numbers
                const notes: number[] = [];
                for (const n of rawNotes) {
                    if (typeof n === 'number' && Number.isFinite(n))
                        notes.push(Math.max(0, Math.min(127, (n | 0) + transpose)));
                    else if (typeof n === 'string') {
                        const m = nameToMidiLocal(n);
                        if (m === undefined)
                            throw new Error(`invalid note name: ${n}`);
                        notes.push(Math.max(0, Math.min(127, m + transpose)));
                    }
                    else {
                        throw new Error(`unsupported note item: ${String(n)}`);
                    }
                }
                // warnings は上部で定義・利用
                const playbackId = randomUUID();
                const registry: Map<string, any> = playbacks;
                if (dryRun) {
                    registry.set(playbackId, { type: 'oneshot', startedAt: Date.now(), scheduledEvents: notes.length * 2, totalDurationMs: durationMs, cursor: notes.length * 2, lastSentIndex: notes.length * 2 - 1, lookahead: 0, tickInterval: 0, portName: undefined, done: true });
                    return { ok: true, playbackId, scheduledNotes: notes.length, durationMs, channel: resolvedChannelExternal, internalChannel: channel, warnings: warnings.length ? warnings : undefined };
                }
                // 実送出
                let portNameResolved: string | undefined;
                // extractionMode を外側スコープで保持（dryRun 応答にも含める）
                let extractionMode: 'simple' | 'precise' = 'simple';
                try {
                    const { MidiOutput: OutCls } = await loadMidi();
                    if (!OutCls) {
                        throw new Error('node-midi not available for output');
                    }
                    else {
                        const out = trackPort(new OutCls());
                        const ports = out.getPortCount?.() ?? 0;
                        if (!ports) throw new Error('node-midi not available: no output devices');
                        let target = 0;
                        const pickByHint = (o: any, hint: string) => {
                            for (let i = 0; i < ports; i++) {
                                try {
                                    const nm = o.getPortName(i);
                                    if (String(nm).toLowerCase().includes(hint))
                                        return i;
                                }
                                catch { }
                            }
                            return -1;
                        };
                        if (typeof args?.portName === 'string' && args.portName.length > 0) {
                            const wanted = pickByHint(out, String(args.portName).toLowerCase());
                            if (wanted >= 0) target = wanted;
                            else throw new Error('output port not found: ' + args?.portName);
                        }
                        else {
                            const pref = pickByHint(out, 'iac');
                            const net = pref < 0 ? pickByHint(out, 'network') : pref;
                            const vir = net < 0 ? pickByHint(out, 'virtual') : net;
                            if (vir >= 0)
                                target = vir;
                        }
                        out.openPort(target);
                        try {
                            portNameResolved = String(out.getPortName?.(target));
                        }
                        catch { }
                        // optional program change
                        if (Number.isFinite(program as number)) {
                            out.sendMessage([0xC0 | (channel & 0x0f), (program as number) & 0x7f]);
                        }
                        // note on for each note
                        for (const n of notes) {
                            out.sendMessage([0x90 | (channel & 0x0f), n & 0x7f, velocity & 0x7f]);
                        }
                        // schedule note off after duration
                        const timeouts: any[] = [];
                        const to = setTimeout(() => {
                            try {
                                // 互換性重視: Note Off(0x80)ではなく Note On(0x90) velocity 0 を優先送出
                                for (const n of notes) {
                                    out.sendMessage([0x90 | (channel & 0x0f), n & 0x7f, 0]);
                                }
                                // 状態更新（activeをクリアしdone=true）
                                try {
                                    const reg: Map<string, any> | undefined = playbacks;
                                    const st = reg?.get(playbackId);
                                    if (st) {
                                        if (st.active && typeof st.active.clear === 'function')
                                            st.active.clear();
                                        st.done = true;
                                    }
                                }
                                catch { }
                            }
                            finally {
                                try {
                                    out.closePort();
                                }
                                catch { }
                            }
                        }, durationMs);
                        timeouts.push(to);
                        // registry for optional stop_playback
                        registry.set(playbackId, { type: 'oneshot', startedAt: Date.now(), scheduledEvents: notes.length * 2, totalDurationMs: durationMs, intervalId: null, timeouts, active: new Set(notes.map(n => `${channel}:${n}`)), out, cursor: notes.length * 2, lastSentIndex: notes.length * 2 - 1, lastSentAt: durationMs, lookahead: 0, tickInterval: 0, portName: portNameResolved, done: false });
                    }
                }
                catch (e: any) {
                    throw e;
                }
                return { ok: true, playbackId, scheduledNotes: notes.length, durationMs, portName: portNameResolved, channel: resolvedChannelExternal, internalChannel: channel, warnings: warnings.length ? warnings : undefined } as any;
            }
            if (name === "store_midi") {
                const base64: string | undefined = args?.base64;
                const fileNameInput: string | undefined = args?.name;
                const MAX_BYTES = 10 * 1024 * 1024; // 10MB
                if (!base64)
                    throw new Error("'base64' is required for store_midi");
                const data = Buffer.from(base64, "base64");
                if (!Number.isFinite(data.byteLength) || data.byteLength <= 0) {
                    throw new Error("Decoded data is empty or invalid");
                }
                if (data.byteLength > MAX_BYTES) {
                    throw new Error(`MIDI size exceeds 10MB limit: ${data.byteLength}`);
                }
                if (data.subarray(0,4).toString() !== 'MThd') throw new Error('Invalid SMF header');
                await decodeSmfToJson(data);
                const record = await saveMidiRecord(data,{name:fileNameInput?.trim() || `untitled-${randomUUID()}.mid`,overwrite:args?.overwrite === true});
                return {ok:true,...record};
            }
            if (name === "json_to_smf") {
                let json = args?.json;
                const format: string | undefined = typeof args?.format === 'string' ? String(args.format) : undefined;
                const originalInputIsString = typeof json === 'string';
                if (originalInputIsString) {
                    // まずJSON.parseを試みる（失敗したら DSL 文字列の可能性）
                    try {
                        json = JSON.parse(json as string);
                    }
                    catch { /* 後段で DSL パスへ */ }
                }
                const fileNameInput: string | undefined = args?.name;
                if (!json)
                    throw new Error("'json' is required for json_to_smf");
                // 形式ヒューリスティック検出: 期待と異なる場合は早期に FORMAT_MISMATCH を返し、ユーザーが正しい format 指定やデータ修正をしやすくする
                const detectFormat = (obj: any): 'json_midi_v1' | 'score_dsl_v1' | 'unknown' => {
                    try {
                        if (obj && typeof obj === 'object') {
                            if (obj.format === 1 && typeof obj.ppq === 'number' && Array.isArray(obj.tracks)) {
                                // tick ベースイベントがあれば JSON MIDI とみなす
                                for (const t of obj.tracks) {
                                    if (t && Array.isArray(t.events)) {
                                        if (t.events.some((ev: any) => typeof ev?.tick === 'number'))
                                            return 'json_midi_v1';
                                    }
                                }
                            }
                            // start / duration を含む DSL イベントパターン
                            if (typeof obj.ppq === 'number' && Array.isArray(obj.tracks)) {
                                for (const t of obj.tracks) {
                                    if (t && Array.isArray(t.events)) {
                                        if (t.events.some((ev: any) => ev && ev.start && (ev.start.bar || ev.start.beat) && ev.duration))
                                            return 'score_dsl_v1';
                                    }
                                }
                            }
                        }
                    }
                    catch { /* ignore */ }
                    return 'unknown';
                };
                const detected = detectFormat(json);
                if (format && detected !== 'unknown' && format !== detected) {
                    // 指定フォーマットと内容の推定が食い違う場合
                    throw new Error(`FORMAT_MISMATCH: expected=${format} detected=${detected} | 提供されたデータは ${detected} 形式らしく見えます。"format" を ${detected} に変更するかデータ構造を ${format} の仕様に合わせてください。`);
                }
                let song: any;
                if (format === 'json_midi_v1') {
                    // 明示: JSON MIDI v1 として検証
                    try {
                        song = zSong.parse(json);
                    }
                    catch (e: any) {
                        const zIssues: any[] = Array.isArray(e?.issues) ? e.issues : [];
                        const summary = zIssues.slice(0, 5).map((i: any, idx: number) => `${idx}(${i.path?.join?.('.') || '(root)'}:${i.message})`).join(' | ');
                        const detailLines = zIssues.map((i: any, idx: number) => {
                            const pathStr = i.path?.join?.('.') || '(root)';
                            const code = i.code || 'ZOD_ERROR';
                            const exp = (i as any).expected !== undefined ? ` expected=${JSON.stringify((i as any).expected)}` : '';
                            const rec = (i as any).received !== undefined ? ` received=${JSON.stringify((i as any).received)}` : '';
                            return `#${idx} path=${pathStr} code=${code} msg=${i.message}${exp}${rec}`;
                        }).join('\n');
                        const more = zIssues.length > 5 ? ` ...(and ${zIssues.length - 5} more)` : '';
                        const errMsg = `json_midi_v1 validation failed: ${summary || (e?.message || String(e))}${more}\n--- details ---\n${detailLines}`;
                        const err2: any = new Error(errMsg);
                        if (zIssues.length) {
                            err2.issues = zIssues.map((i: any) => ({ path: i.path, message: i.message, code: i.code, expected: (i as any).expected, received: (i as any).received }));
                        }
                        throw err2;
                    }
                }
                else if (format === 'score_dsl_v1') {
                    // 明示: Score DSL v1 をコンパイル→検証
                    try {
                        let inputForCompile = json;
                        let directJsonMidi: any | undefined;
                        // 簡易 DSL 文字列 (旧テスト互換) をオブジェクト形式へ変換
                        if (originalInputIsString && typeof json === 'string') {
                            try {
                                const lines = (json as string).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                                let title: string | undefined;
                                let tempo: number | undefined;
                                let timeSig: {
                                    numerator: number;
                                    denominator: number;
                                } | undefined;
                                const trackSpecs: {
                                    name: string;
                                    tokens: string[];
                                }[] = [];
                                for (const ln of lines) {
                                    if (ln.startsWith('#title:'))
                                        title = ln.slice(7).trim();
                                    else if (ln.startsWith('#tempo:'))
                                        tempo = Number(ln.slice(7).trim());
                                    else if (ln.startsWith('#time:')) {
                                        const m = ln.slice(6).trim().match(/(\d+)\/(\d+)/);
                                        if (m)
                                            timeSig = { numerator: Number(m[1]), denominator: Number(m[2]) };
                                    }
                                    else {
                                        const m = ln.match(/^(\w+):\s*(.+)$/);
                                        if (m) {
                                            trackSpecs.push({ name: m[1], tokens: m[2].split(/\s+/) });
                                        }
                                    }
                                }
                                const ppq = 480;
                                const numerator = timeSig?.numerator ?? 4;
                                const denominator = (timeSig?.denominator ?? 4) as 1 | 2 | 4 | 8 | 16;
                                const tracks: any[] = [];
                                const barTicks = ppq * numerator; // 4/4 固定で denominator=4 前提
                                for (const ts of trackSpecs) {
                                    const events: any[] = [];
                                    let curBar = 1;
                                    let curTickInBar = 0;
                                    let i = 0;
                                    while (i < ts.tokens.length) {
                                        const token = ts.tokens[i];
                                        if (token === '|') {
                                            curBar++;
                                            curTickInBar = 0;
                                            i++;
                                            continue;
                                        }
                                        const lenToken = ts.tokens[i + 1];
                                        if (!lenToken)
                                            break;
                                        const lenMap: Record<string, number> = { '8': Math.round(ppq / 2), '4': ppq, '2': ppq * 2, '1': ppq * 4 };
                                        const durTicks = lenMap[lenToken] ?? Math.round(ppq / 2);
                                        const globalTick = (curBar - 1) * barTicks + curTickInBar;
                                        // note name to midi (simple)
                                        const m = /^([A-Ga-g])(#|b)?(\d)$/.exec(token.trim());
                                        let pitch: number | undefined;
                                        if (m) {
                                            const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
                                            let base = names.indexOf((m[1].toUpperCase()) + (m[2] || ''));
                                            if (base === -1) {
                                                const enh: any = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
                                                const k = (m[1].toUpperCase()) + (m[2] || '');
                                                if (enh[k])
                                                    base = names.indexOf(enh[k]);
                                            }
                                            const oct = Number(m[3]);
                                            if (base >= 0 && Number.isFinite(oct))
                                                pitch = base + (oct + 1) * 12;
                                        }
                                        if (pitch !== undefined) {
                                            events.push({ type: 'note', tick: globalTick, pitch, velocity: 80, duration: durTicks });
                                        }
                                        curTickInBar += durTicks;
                                        i += 2;
                                    }
                                    tracks.push({ name: ts.name, channel: 0, program: 0, events });
                                }
                                directJsonMidi = { format: 1, ppq, tracks };
                            }
                            catch { /* fallback: そのまま compile */ }
                        }
                        if (directJsonMidi) {
                            song = zSong.parse(directJsonMidi);
                        }
                        else {
                            const compiled = compileScoreToJsonMidi(inputForCompile);
                            song = zSong.parse(compiled);
                        }
                    }
                    catch (e: any) {
                        // Zod 由来の issues を構造化し、全件を詳細ラインで表示
                        const issuesArr: any[] = Array.isArray(e?.issues) ? e.issues : [];
                        const summary = issuesArr.slice(0, 5).map((i: any, idx: number) => `${idx}(${i.path?.join?.('.') || '(root)'}:${i.message})`).join(' | ');
                        const detailLines = issuesArr.map((i: any, idx: number) => {
                            const pathStr = i.path?.join?.('.') || '(root)';
                            const code = i.code || 'ZOD_ERROR';
                            const exp = (i as any).expected !== undefined ? ` expected=${JSON.stringify((i as any).expected)}` : '';
                            const rec = (i as any).received !== undefined ? ` received=${JSON.stringify((i as any).received)}` : '';
                            return `#${idx} path=${pathStr} code=${code} msg=${i.message}${exp}${rec}`;
                        }).join('\n');
                        const more = issuesArr.length > 5 ? ` ...(and ${issuesArr.length - 5} more)` : '';
                        const msg = `score_dsl_v1 compile/validation failed: ${summary || (e?.message || String(e))}${more}\n--- details ---\n${detailLines}`;
                        const err2: any = new Error(msg);
                        if (issuesArr.length)
                            err2.issues = issuesArr.map(i => ({ path: i.path, message: i.message, code: i.code, expected: (i as any).expected, received: (i as any).received }));
                        throw err2;
                    }
                }
                else {
                    // 後方互換: まずJSON MIDI v1として検証→失敗ならScore DSL v1としてコンパイルを試行
                    const parsed = zSong.safeParse(json);
                    if (parsed.success) {
                        song = parsed.data;
                    }
                    else {
                        // 2段階エラー収集 (JSON MIDI→Score DSL) を詳細化
                        const jsonIssues = parsed.error.issues?.map(i => ({ path: i.path.join('.'), message: i.message }));
                        let dslCompileError: any = null;
                        try {
                            const compiled = compileScoreToJsonMidi(json);
                            try {
                                song = zSong.parse(compiled);
                            }
                            catch (e2: any) {
                                const z2 = e2?.issues?.map?.((i: any) => `${i.path?.join?.('.')}: ${i.message}`).join('; ');
                                dslCompileError = { stage: 'compiled-json-invalid', detail: z2 || e2?.message || String(e2) };
                                throw e2;
                            }
                        }
                        catch (e: any) {
                            if (!dslCompileError) {
                                const extra = e?.issues?.map?.((i: any) => `${i.path?.join?.('.')}: ${i.message}`).join('; ') || e?.message || String(e);
                                dslCompileError = { stage: 'compile', detail: extra };
                            }
                            const aggregate = {
                                ok: false,
                                error: {
                                    kind: 'auto_detect_failed',
                                    message: 'Neither JSON MIDI v1 nor Score DSL v1 could be validated/compiled',
                                    tried: {
                                        json_midi_v1: jsonIssues,
                                        score_dsl_v1: dslCompileError,
                                    }
                                }
                            };
                            throw new Error("AUTO_DETECT_FAILED: " + JSON.stringify(aggregate.error));
                        }
                    }
                }
                const bin = encodeToSmfBinary(song);
                const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
                const record = await saveMidiRecord(data,{name:fileNameInput?.trim() || `json-${randomUUID()}.mid`,overwrite:args?.overwrite === true});
                const trackCount = song.tracks.length;
                const eventCount = song.tracks.reduce((count:number,track:any)=>count+track.events.length,0);
                return {ok:true,...record,trackCount,eventCount};
            }
            if (name === "smf_to_json") {
                const fileId: string | undefined = args?.fileId;
                if (!fileId)
                    throw new Error("'fileId' is required for smf_to_json");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const buf = await fs.readFile(absPath);
                const json = await decodeSmfToJson(buf);
                const bytes = buf.byteLength;
                const trackCount = Array.isArray(json.tracks) ? json.tracks.length : 0;
                const eventCount = Array.isArray(json.tracks) ? json.tracks.reduce((a: number, t: any) => a + (Array.isArray(t.events) ? t.events.length : 0), 0) : 0;
                return { ok: true, json, bytes, trackCount, eventCount } as any;
            }
            if (name === "clean_midi") {
                const fileId: string | undefined = args?.fileId;
                if (!fileId)
                    throw new Error("'fileId' is required for clean_midi");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const {cleanJsonMidiSong} = await import('./cleanMidi.js');
                const original = await decodeSmfToJson(await fs.readFile(absPath));
                const originalCounts = {trackCount:original.tracks.length,eventCount:original.tracks.reduce((count,track)=>count+track.events.length,0)};
                const {cleaned,removedMeta,mergedTracks} = cleanJsonMidiSong(original as any);
                const record = await saveMidiRecordUnlocked(encodeToSmfBinary({format:1,ppq:cleaned.ppq,tracks:cleaned.tracks} as any),{name:`cleaned_${randomUUID()}.mid`});
                return {ok:true,...record,original:originalCounts,cleaned:{trackCount:cleaned.tracks.length,eventCount:cleaned.tracks.reduce((count:number,track:any)=>count+track.events.length,0)},removedDuplicateMeta:removedMeta,mergedTracks};
            }
            if (name === "append_to_smf") {
                const fileId: string | undefined = args?.fileId;
                if (!fileId)
                    throw new Error("'fileId' is required for append_to_smf");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const format: string | undefined = typeof args?.format === 'string' ? String(args.format) : undefined;
                let chunk = args?.json;
                if (typeof chunk === 'string') {
                    try {
                        chunk = JSON.parse(chunk);
                    }
                    catch { }
                }
                if (!chunk)
                    throw new Error("'json' is required for append_to_smf");
                // 簡易形式サポート: { events:[...] } だけを渡された場合は単一トラックJSON MIDIにラップ
                if (chunk && !chunk.tracks && Array.isArray(chunk.events)) {
                    const evs = chunk.events;
                    // baseJson まだ未読なので ppq は既定 480 にフォールバック
                    chunk = { ppq: 480, tracks: [{ channel: Number.isFinite(Number(chunk.channel)) ? chunk.channel : undefined, events: evs }] };
                }
                // 1) 既存SMFをJSONへ
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const buf = await fs.readFile(absPath);
                const baseJson = await decodeSmfToJson(buf);
                // 2) 追記するチャンクをJSON MIDI v1 へ
                let addSong: any;
                if (format === 'json_midi_v1') {
                    addSong = zSong.parse(chunk);
                }
                else if (format === 'score_dsl_v1') {
                    const compiled = compileScoreToJsonMidi(chunk);
                    addSong = zSong.parse(compiled);
                }
                else {
                    // 後方互換（未指定）: まずJSON MIDI、失敗でDSL
                    const parsed = zSong.safeParse(chunk);
                    if (parsed.success)
                        addSong = parsed.data;
                    else
                        addSong = zSong.parse(compileScoreToJsonMidi(chunk));
                }
                // 2.5) グローバルメタ制御: keepGlobalMeta / allowKeyChange フラグ処理
                const keepGlobalMeta = !!args?.keepGlobalMeta;
                const allowKeyChange = !!args?.allowKeyChange;
                // 既存の最初の keySignature / timeSignature / tempo を取得
                const existingMeta = { key: undefined as any, time: undefined as any, tempo: undefined as any };
                for (const ev of (baseJson.tracks[0]?.events || [])) {
                    if (!existingMeta.key && ev.type === 'meta.keySignature')
                        existingMeta.key = { sf: ev.sf, mi: ev.mi };
                    if (!existingMeta.time && ev.type === 'meta.timeSignature')
                        existingMeta.time = { numerator: ev.numerator, denominator: ev.denominator };
                    if (!existingMeta.tempo && ev.type === 'meta.tempo')
                        existingMeta.tempo = { usPerQuarter: ev.usPerQuarter };
                    if (existingMeta.key && existingMeta.time && existingMeta.tempo)
                        break;
                }
                // 追記チャンク内のグローバルメタを検査
                if (!keepGlobalMeta) {
                    for (const tr of addSong.tracks) {
                        tr.events = tr.events.filter((ev: any) => {
                            if (ev.type === 'meta.keySignature') {
                                if (existingMeta.key) {
                                    // 既存キーと異なり allowKeyChange でない → 無視
                                    if (!allowKeyChange && (existingMeta.key.sf !== ev.sf || existingMeta.key.mi !== ev.mi)) {
                                        return false;
                                    }
                                    // 同一キーは重複除去
                                    if (existingMeta.key.sf === ev.sf && existingMeta.key.mi === ev.mi)
                                        return false;
                                }
                            }
                            if (ev.type === 'meta.timeSignature') {
                                if (existingMeta.time) {
                                    if (existingMeta.time.numerator === ev.numerator && existingMeta.time.denominator === ev.denominator)
                                        return false; // 重複除去
                                }
                            }
                            if (ev.type === 'meta.tempo') {
                                if (existingMeta.tempo) {
                                    if (existingMeta.tempo.usPerQuarter === ev.usPerQuarter)
                                        return false;
                                }
                            }
                            return true;
                        });
                    }
                }
                // 3) 追記位置の決定（atEnd優先→atTick→既定末尾）。gapTicksで隙間を空ける
                const atEnd: boolean = !!args?.atEnd;
                const atTickArg = Number.isFinite(Number(args?.atTick)) ? (args.atTick | 0) : undefined;
                const gapTicks = Number.isFinite(Number(args?.gapTicks)) ? Math.max(0, args.gapTicks | 0) : 0;
                const trackIndex = Number.isFinite(Number(args?.trackIndex)) ? Math.max(0, args.trackIndex | 0) : undefined;
                const preserveTrackStructure = !!args?.preserveTrackStructure;
                const trackMapping = Array.isArray(args?.trackMapping) ? args.trackMapping.map((n: any) => Math.max(0, Number(n) || 0)) : undefined;
                // 既存末尾tickを計測
                const trackEndTicks: number[] = baseJson.tracks.map((tr: any) => {
                    let last = 0;
                    for (const ev of (tr.events || [])) {
                        if (typeof ev.tick === 'number') {
                            if (ev.type === 'note')
                                last = Math.max(last, ev.tick + (ev.duration || 0));
                            else
                                last = Math.max(last, ev.tick);
                        }
                    }
                    return last;
                });
                const globalEnd = trackEndTicks.length ? Math.max(...trackEndTicks) : 0;
                // 4) 挿入オフセットの算出（グローバルまたは指定トラックの末尾）
                let insertTick: number;
                if (preserveTrackStructure) {
                    // トラック構造保持モード：グローバル末尾基準
                    insertTick = atEnd ? globalEnd + gapTicks : (atTickArg ?? (globalEnd + gapTicks));
                }
                else {
                    // 従来モード：単一トラック指定
                    let tgt = trackIndex;
                    if (!Number.isFinite(tgt as number)) {
                        const cand = baseJson.tracks.findIndex((tr: any) => (tr.events || []).some((e: any) => e.type !== "meta.tempo" && e.type !== "meta.timeSignature" && e.type !== "meta.keySignature"));
                        tgt = (cand >= 0 ? cand : 0);
                    }
                    if (!baseJson.tracks[tgt!])
                        baseJson.tracks[tgt!] = { events: [] };
                    insertTick = atEnd ? (trackEndTicks[tgt!] ?? globalEnd) + gapTicks : (atTickArg ?? (globalEnd + gapTicks));
                }
                // 5) 追加曲の各イベントを insertTick へ相対シフトして追記
                if (preserveTrackStructure) {
                    // トラック構造保持モード：各トラックを個別に追記
                    for (let srcTrackIdx = 0; srcTrackIdx < addSong.tracks.length; srcTrackIdx++) {
                        const srcTrack = addSong.tracks[srcTrackIdx];
                        let dstTrackIdx: number;
                        if (trackMapping && trackMapping[srcTrackIdx] !== undefined) {
                            // 明示的マッピング指定
                            dstTrackIdx = trackMapping[srcTrackIdx];
                        }
                        else {
                            // 自動配置：既存トラック数から追記
                            dstTrackIdx = baseJson.tracks.length + srcTrackIdx;
                        }
                        // 対象トラックを確保（配列の長さを動的に拡張）
                        while (baseJson.tracks.length <= dstTrackIdx) {
                            baseJson.tracks.push({ events: [] });
                        }
                        if (!baseJson.tracks[dstTrackIdx]) {
                            baseJson.tracks[dstTrackIdx] = { events: [] };
                        }
                        for (const ev of srcTrack.events) {
                            if (ev.type === 'meta.tempo' || ev.type === 'meta.timeSignature' || ev.type === 'meta.keySignature') {
                                // グローバルメタは track0 に入れる
                                const tick = insertTick + (ev.tick | 0);
                                if (!baseJson.tracks[0])
                                    baseJson.tracks[0] = { events: [] };
                                baseJson.tracks[0].events.push({ ...ev, tick });
                            }
                            else {
                                const tick = insertTick + (ev.tick | 0);
                                baseJson.tracks[dstTrackIdx].events.push({ ...ev, tick });
                            }
                        }
                    }
                }
                else {
                    // 従来モード：全トラックを1つに統合
                    let tgt = trackIndex;
                    if (!Number.isFinite(tgt as number)) {
                        const cand = baseJson.tracks.findIndex((tr: any) => (tr.events || []).some((e: any) => e.type !== "meta.tempo" && e.type !== "meta.timeSignature" && e.type !== "meta.keySignature"));
                        tgt = (cand >= 0 ? cand : 0);
                    }
                    if (!baseJson.tracks[tgt!])
                        baseJson.tracks[tgt!] = { events: [] };
                    const dst = baseJson.tracks[tgt!];
                    for (const tr of addSong.tracks) {
                        for (const ev of tr.events) {
                            if (ev.type === 'meta.tempo' || ev.type === 'meta.timeSignature' || ev.type === 'meta.keySignature') {
                                // グローバルメタは track0 に入れる
                                const tick = insertTick + (ev.tick | 0);
                                if (!baseJson.tracks[0])
                                    baseJson.tracks[0] = { events: [] };
                                baseJson.tracks[0].events.push({ ...ev, tick });
                            }
                            else {
                                const tick = insertTick + (ev.tick | 0);
                                dst.events.push({ ...ev, tick });
                            }
                        }
                    }
                }
                // 6) 正規化（簡易: tickでソート、NoteOff順はエンコーダ側のordで制御）
                for (const tr of baseJson.tracks) {
                    tr.events.sort((a: any, b: any) => {
                        const ta = a.tick | 0, tb = b.tick | 0;
                        if (ta !== tb)
                            return ta - tb;
                        return String(a.type).localeCompare(String(b.type));
                    });
                }
                // 6.5) keySignature 差異検出警告 (allowKeyChange=false で保持された場合は既にフィルタ済み)
                let warnings: string[] | undefined;
                // 重複メタ (tick0 同種) をここでも最終チェックして prune
                const t0 = baseJson.tracks[0];
                if (t0) {
                    const seen = new Set<string>();
                    t0.events = t0.events.filter((ev: any) => {
                        if (ev?.type && ['meta.tempo', 'meta.timeSignature', 'meta.keySignature'].includes(ev.type) && (ev.tick || 0) === 0) {
                            if (seen.has(ev.type)) {
                                (warnings ||= []).push(`duplicate_meta_pruned:${ev.type}`);
                                return false;
                            }
                            seen.add(ev.type);
                        }
                        return true;
                    });
                }
                // 大きなギャップ検知: insertTick が既存末尾より >1小節相当 (ppq*4) の場合
                const ppqForGap = baseJson.ppq || 480;
                const barTicks = ppqForGap * 4; // 4/4前提 (timeSig 変化未サポート部位)
                const maxPrevTick = Math.max(0, ...baseJson.tracks.flatMap((t: any) => t.events.map((e: any) => e.tick || 0)));
                if (insertTick - maxPrevTick > barTicks) {
                    (warnings ||= []).push(`large_gap_detected:${insertTick - maxPrevTick}`);
                }
                if (allowKeyChange && !keepGlobalMeta) {
                    // フィルタ除去された可能性を示す通知（差異があったことを明示できれば理想だが元イベントは捨てている）
                    // 実装簡易化のためスキップ; 将来: 差異検出時にフラグ設定
                }
                // 7) SMFへ再エンコード→保存（新規名指定があれば複製）
                const bin = encodeToSmfBinary(baseJson);
                const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
                const outName = safeMidiName(args?.outputName?.trim() || item.name);
                const sameFile = outName === item.name;
                const record = await saveMidiRecordUnlocked(data,{name:outName,overwrite:sameFile || args?.overwrite === true,fileId:sameFile?item.id:undefined});
                return {ok:true,...record,insertedAtTick:insertTick,warnings};
            }
            if (name === 'start_single_capture') {
                const onsetWindowMs = Number.isFinite(Number(args?.onsetWindowMs)) ? Math.max(10, Math.min(500, Number(args.onsetWindowMs))) : 80;
                const silenceMs = Number.isFinite(Number(args?.silenceMs)) ? Math.max(50, Math.min(2000, Number(args.silenceMs))) : 150;
                const maxWaitMs = Number.isFinite(Number(args?.maxWaitMs)) ? Math.max(200, Math.min(10000, Number(args.maxWaitMs))) : 3000;
                const finalizeOnRelease = !!args?.finalizeOnRelease;
                const id = randomUUID();
                const st: CaptureState = { id, startedAt: Date.now(), onsetWindowMs, silenceMs, maxWaitMs, notes: new Map(), done: false, finalizeOnRelease };
                captureRegistry.set(id, st);
                return { ok: true, captureId: id, onsetWindowMs, silenceMs, maxWaitMs, finalizeOnRelease } as any;
            }
            if (name === 'list_input_devices') {
                const diagnostics: any = { platform: process.platform };
                try {
                    const r = await loadMidi();
                    if (!MidiInput) {
                        diagnostics.nativeLoadFailed = r.error ? (r.error.code || r.error.message || 'unknown') : 'MidiInputClassUnavailable';
                        return { ok: true, devices: [], diagnostics } as any;
                    }
                    const inp = trackPort(new MidiInput());
                    const count = typeof inp.getPortCount === 'function' ? inp.getPortCount() : 0;
                    diagnostics.nativePortCount = count;
                    const devices: Array<{
                        index: number;
                        name: string;
                    }> = [];
                    for (let i = 0; i < count; i++) {
                        let nm = '';
                        try {
                            nm = inp.getPortName(i) || `input:${i}`;
                        }
                        catch (e: any) {
                            nm = `input:${i}`;
                            diagnostics.lastEnumerateError = String(e?.message || e);
                        }
                        devices.push({ index: i, name: nm });
                    }
                    diagnostics.realCount = devices.length;
                    try {
                        if (typeof inp.closePort === 'function')
                            inp.closePort();
                    }
                    catch { }
                    return { ok: true, devices, diagnostics } as any;
                }
                catch (e: any) {
                    diagnostics.unhandledError = String(e?.message || e);
                    return { ok: false, error: { tool: 'list_input_devices', message: diagnostics.unhandledError }, diagnostics } as any;
                }
            }
            if (name === 'start_device_single_capture') {
                await loadMidi();
                if (!MidiInput)
                    throw new Error('node-midi not available for input');
                const onsetWindowMs = Number.isFinite(Number(args?.onsetWindowMs)) ? Math.max(10, Math.min(500, Number(args.onsetWindowMs))) : 80;
                const silenceMs = Number.isFinite(Number(args?.silenceMs)) ? Math.max(50, Math.min(2000, Number(args.silenceMs))) : 150;
                const maxWaitMs = Number.isFinite(Number(args?.maxWaitMs)) ? Math.max(200, Math.min(10000, Number(args.maxWaitMs))) : 3000;
                const finalizeOnRelease = !!args?.finalizeOnRelease;
                const reqPortName: string | undefined = args?.portName;
                // 列挙しターゲットポートを決定
                const temp = trackPort(new MidiInput());
                const count = typeof temp.getPortCount === 'function' ? temp.getPortCount() : 0;
                if (!count) { temp.closePort(); throw new Error('node-midi not available: no input devices'); }
                const ports: string[] = [];
                for (let i = 0; i < count; i++) {
                    try {
                        ports.push(temp.getPortName(i) || `input:${i}`);
                    }
                    catch {
                        ports.push(`input:${i}`);
                    }
                }
                let index = 0;
                if (reqPortName) {
                    const found = ports.findIndex(p => p === reqPortName || p.includes(reqPortName));
                    if (found >= 0)
                        index = found;
                    else
                        throw new Error(`input port not found: ${reqPortName}`);
                }
                // 実インスタンスを利用 (temp をそのまま使うと closePort タイミングが煩雑なので再利用)
                ensureInputAvailable(ports[index], temp);
                const inp = temp; // reuse
                try {
                    inp.openPort(index);
                }
                catch {
                    try {
                        inp.closePort();
                    }
                    catch { }
                    ;
                    throw new Error(`failed to open input port index=${index}`);
                }
                // システムリアルタイム/アクティブセンシング無視 (APIによっては ignoreTypes が存在)
                try {
                    if (typeof inp.ignoreTypes === 'function')
                        inp.ignoreTypes(false, false, false);
                }
                catch { }
                const id = randomUUID();
                const st: CaptureState = { id, startedAt: Date.now(), onsetWindowMs, silenceMs, maxWaitMs, notes: new Map(), done: false, inputInstance: inp, inputPortName: ports[index], finalizeOnRelease };
                captureRegistry.set(id, st);
                // メッセージハンドラ
                const handler = (delta: number, message: number[]) => {
                    try {
                        const status = message[0] | 0;
                        const type = status & 0xF0;
                        const note = message[1] | 0;
                        const velocity = message[2] | 0;
                        const at = Date.now() - st.startedAt; // relative ms
                        if (type === 0x90 && velocity > 0) {
                            if (!st.originMs)
                                st.originMs = st.startedAt + at;
                            const within = (st.startedAt + at - (st.originMs)) <= st.onsetWindowMs;
                            if (within) {
                                if (!st.notes.has(note))
                                    st.notes.set(note, { onAt: at, velocity: Math.max(1, Math.min(127, velocity)) });
                            }
                            else {
                                // onsetWindow外は無視（単発設計）
                            }
                            st.lastEventAt = at;
                        }
                        else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
                            const entry = st.notes.get(note);
                            if (entry && entry.offAt === undefined)
                                entry.offAt = at;
                            st.lastEventAt = at;
                        }
                        maybeAutoFinalize(st);
                        if (st.done) {
                            // 完了したらポートを閉じイベントを解除
                            try {
                                if (typeof inp.closePort === 'function')
                                    inp.closePort();
                            }
                            catch { }
                        }
                    }
                    catch {
                        // 例外は握りつぶし（キャプチャ継続）。致命的状況ではクライアントポーリングで timeout/結果取得可能。
                    }
                };
                try {
                    inp.on('message', handler);
                }
                catch { /* 一部実装差異 */ }
                return { ok: true, captureId: id, portName: ports[index], onsetWindowMs, silenceMs, maxWaitMs, finalizeOnRelease, mode: 'device' } as any;
            }
            if (name === 'feed_single_capture') {
                const captureId: string | undefined = args?.captureId;
                const events: any[] | undefined = args?.events;
                if (!captureId)
                    throw new Error("'captureId' is required for feed_single_capture");
                if (!Array.isArray(events) || events.length === 0)
                    throw new Error("'events' must be non-empty array");
                const st = captureRegistry.get(captureId);
                if (!st)
                    throw new Error(`captureId not found: ${captureId}`);
                if (st.done)
                    return { ok: true, captureId, done: true, ignored: true } as any;
                const base = st.startedAt;
                for (const ev of events) {
                    const kind = ev?.kind;
                    const note = Number(ev?.note);
                    const velRaw = Number(ev?.velocity);
                    const at = Number(ev?.at);
                    if (!Number.isFinite(note) || note < 0 || note > 127)
                        throw new Error(`invalid note: ${ev?.note}`);
                    if (!Number.isFinite(at) || at < 0)
                        throw new Error(`invalid at ms: ${ev?.at}`);
                    const atAbs = base + at; // absolute ms
                    if (kind === 'on') {
                        if (!st.originMs)
                            st.originMs = atAbs;
                        // onsetWindow内→和音メンバ
                        const within = (atAbs - st.originMs) <= st.onsetWindowMs;
                        if (within) {
                            if (!st.notes.has(note))
                                st.notes.set(note, { onAt: at, velocity: Number.isFinite(velRaw) ? Math.max(1, Math.min(127, velRaw)) : 100 });
                        }
                        else {
                            // onsetWindow超過の新しいNoteOnは無視（単発キャプチャ設計）
                        }
                        st.lastEventAt = at;
                    }
                    else if (kind === 'off') {
                        const entry = st.notes.get(note);
                        if (entry && entry.offAt === undefined) {
                            entry.offAt = at;
                        }
                        st.lastEventAt = at;
                    }
                    else {
                        throw new Error(`event.kind must be 'on'|'off'`);
                    }
                }
                // 自動完了判定
                maybeAutoFinalize(st);
                return { ok: true, captureId, done: st.done } as any;
            }
            if (name === 'get_single_capture_status') {
                const captureId: string | undefined = args?.captureId;
                if (!captureId)
                    throw new Error("'captureId' is required for get_single_capture_status");
                const st = captureRegistry.get(captureId);
                if (!st)
                    throw new Error(`captureId not found: ${captureId}`);
                maybeAutoFinalize(st);
                if (st.done && !st.result)
                    finalizeCapture(st, st.reason || 'completed');
                return { ok: true, captureId, done: st.done, reason: st.reason, result: st.result } as any;
            }
            if (name === 'start_continuous_recording') {
                const requestedOutputName = args?.name === undefined ? undefined : safeMidiName(args.name);
                await loadMidi();
                if (!MidiInput)
                    throw new Error('node-midi not available for input');
                // マルチセッション制限チェック（最大3セッション同時）
                const activeSessions = Array.from(continuousRecordingRegistry.values()).filter(s => s.status === 'waiting_for_input' || s.status === 'recording');
                if (activeSessions.length >= 3) {
                    const error = classifyError('start_continuous_recording', new Error("Maximum concurrent recording sessions (3) exceeded"));
                    return { ok: false, error } as any;
                }
                // パラメータ解析
                const ppq = Number.isFinite(Number(args?.ppq)) ? Math.max(96, Math.min(1920, Number(args.ppq))) : 480;
                const maxDurationMs = Number.isFinite(Number(args?.maxDurationMs)) ? Math.max(1000, Math.min(3600000, Number(args.maxDurationMs))) : 300000;
                const idleTimeoutMs = Number.isFinite(Number(args?.idleTimeoutMs)) ? Math.max(1000, Math.min(120000, Number(args.idleTimeoutMs))) : 30000;
                const silenceTimeoutMs = Number.isFinite(Number(args?.silenceTimeoutMs)) ? Math.max(1000, Math.min(60000, Number(args.silenceTimeoutMs))) : 10000;
                const reqPortName: string | undefined = args?.portName;
                const channelFilter: number[] | undefined = Array.isArray(args?.channelFilter) ? args.channelFilter.filter((n: any) => Number.isInteger(n) && n >= 1 && n <= 16) : undefined;
                const eventTypeFilter: string[] | undefined = Array.isArray(args?.eventTypeFilter) ? args.eventTypeFilter.filter((s: any) => typeof s === 'string' && ['note', 'cc', 'pitchBend', 'program'].includes(s)) : undefined;
                // 入力ポート決定
                const temp = trackPort(new MidiInput());
                const count = typeof temp.getPortCount === 'function' ? temp.getPortCount() : 0;
                if (!count) { temp.closePort(); throw new Error('node-midi not available: no input devices'); }
                const ports: string[] = [];
                for (let i = 0; i < count; i++) {
                    try {
                        ports.push(temp.getPortName(i) || `input:${i}`);
                    }
                    catch {
                        ports.push(`input:${i}`);
                    }
                }
                let index = 0;
                if (reqPortName) {
                    const found = ports.findIndex(p => p === reqPortName || p.includes(reqPortName));
                    if (found >= 0)
                        index = found;
                    else
                        throw new Error(`input port not found: ${reqPortName}`);
                }
                const actualPortName = ports[index] || 'unknown';
                ensureInputAvailable(actualPortName, temp);
                // セッション作成
                const session = createContinuousSession(actualPortName, ppq, maxDurationMs, idleTimeoutMs, silenceTimeoutMs, channelFilter, eventTypeFilter);
                session.outputName = requestedOutputName;
                session.overwrite = args?.overwrite === true;
                // MIDI入力設定
                const inp = temp; // reuse temp instance
                try {
                    inp.openPort(index);
                }
                catch {
                    try {
                        inp.closePort();
                    }
                    catch { }
                    throw new Error(`failed to open input port index=${index}`);
                }
                try {
                    if (typeof inp.ignoreTypes === 'function')
                        inp.ignoreTypes(false, false, false);
                }
                catch { }
                session.inputInstance = inp;
                // メッセージハンドラ設定
                const handler = (delta: number, message: number[]) => {
                    try {
                        const now = Date.now();
                        const relativeMs = now - session.startedAt;
                        if (session.status === 'waiting_for_input' || session.status === 'recording') {
                            addEventToSession(session, message, relativeMs);
                        }
                    }
                    catch {
                        // エラーは握りつぶし
                    }
                };
                inp.on('message', handler);
                // タイマー設定
                session.idleTimer = setTimeout(async () => {
                    const currentSession = continuousRecordingRegistry.get(session.id);
                    if (currentSession && currentSession.status === 'waiting_for_input') {
                        currentSession.status = 'timeout_idle';
                        finalizeSession(currentSession, 'idle_timeout');
                        // 自動SMF保存
                        try {
                            await saveContinuousRecordingAsSmf(currentSession);
                        }
                        catch (error) {
                            console.error('Failed to auto-save recording on idle timeout:', error);
                        }
                        continuousRecordingRegistry.set(currentSession.id, currentSession);
                    }
                }, idleTimeoutMs);
                session.maxDurationTimer = setTimeout(async () => {
                    const currentSession = continuousRecordingRegistry.get(session.id);
                    if (currentSession && (currentSession.status === 'waiting_for_input' || currentSession.status === 'recording')) {
                        currentSession.status = 'timeout_max_duration';
                        finalizeSession(currentSession, 'max_duration');
                        // 自動SMF保存
                        try {
                            await saveContinuousRecordingAsSmf(currentSession);
                        }
                        catch (error) {
                            console.error('Failed to auto-save recording on max duration timeout:', error);
                        }
                        continuousRecordingRegistry.set(currentSession.id, currentSession);
                    }
                }, maxDurationMs);
                // レジストリ登録
                continuousRecordingRegistry.set(session.id, session);
                return {
                    ok: true,
                    recordingId: session.id,
                    portName: actualPortName,
                    ppq,
                    maxDurationMs,
                    idleTimeoutMs,
                    silenceTimeoutMs,
                    channelFilter,
                    eventTypeFilter: session.eventTypeFilter,
                    startedAt: new Date(session.startedAt).toISOString(),
                    status: session.status
                } as any;
            }
            if (name === 'get_continuous_recording_status') {
                const recordingId: string | undefined = args?.recordingId;
                if (!recordingId)
                    throw new Error("'recordingId' is required for get_continuous_recording_status");
                const session = continuousRecordingRegistry.get(recordingId);
                if (!session)
                    throw new Error(`recording session not found: ${recordingId}`);
                const now = Date.now();
                const currentDurationMs = (session.endedAt ?? now) - session.startedAt;
                // タイムアウトの自動チェック（状態遷移は各タイマーが担当）
                let timeUntilTimeout = 0;
                if (session.status === 'waiting_for_input') {
                    const idleRemaining = Math.max(0, session.idleTimeoutMs - currentDurationMs);
                    const maxDurationRemaining = Math.max(0, session.maxDurationMs - currentDurationMs);
                    timeUntilTimeout = Math.min(idleRemaining, maxDurationRemaining);
                }
                else if (session.status === 'recording' && session.lastInputAt) {
                    const silenceElapsed = now - session.lastInputAt;
                    const silenceRemaining = session.pendingNotes.size ? Infinity : Math.max(0, session.silenceTimeoutMs - silenceElapsed);
                    const maxDurationRemaining = Math.max(0, session.maxDurationMs - currentDurationMs);
                    timeUntilTimeout = Math.min(silenceRemaining, maxDurationRemaining);
                }
                else if (session.status === 'recording') {
                    // recording状態だがlastInputAtがない場合（通常起こらないが安全のため）
                    timeUntilTimeout = Math.max(0, session.maxDurationMs - currentDurationMs);
                }
                return {
                    ok: true,
                    recordingId: session.id,
                    status: session.status,
                    startedAt: new Date(session.startedAt).toISOString(),
                    firstInputAt: session.firstInputAt ? new Date(session.firstInputAt).toISOString() : undefined,
                    lastInputAt: session.lastInputAt ? new Date(session.lastInputAt).toISOString() : undefined,
                    currentDurationMs,
                    eventCount: session.eventCount,
                    eventBreakdown: session.eventBreakdown,
                    channelActivity: session.channelActivity,
                    timeUntilTimeout,
                    reason: session.reason,
                    result: recordingResults.get(session.id),
                    fileId: recordingResults.get(session.id)?.fileId,
                    saveError: recordingResults.get(session.id)?.error,
                    saveStatus: recordingResults.has(session.id) ? (recordingResults.get(session.id).ok ? 'saved' : 'failed') : recordingSaves.has(session.id) ? 'saving' : 'pending',
                    endedAt: session.endedAt !== undefined ? new Date(session.endedAt).toISOString() : undefined,
                    tempoBpm: 120,
                    estimatedFileSizeBytes: session.eventCount * 8 + 1024, // 概算
                    portName: session.inputPortName
                } as any;
            }
            if (name === 'stop_continuous_recording') {
                const recordingId: string | undefined = args?.recordingId;
                const requestedName: string | undefined = args?.name;
                const overwrite: boolean | undefined = args?.overwrite;
                if (!recordingId)
                    throw new Error("'recordingId' is required for stop_continuous_recording");
                const session = continuousRecordingRegistry.get(recordingId);
                if (!session)
                    throw new Error(`recording session not found: ${recordingId}`);
                // 手動終了の場合、セッション状態を更新
                if (session.endedAt === undefined) {
                    session.status = 'stopped_manually';
                    finalizeSession(session, 'manual_stop');
                }
                // SMF生成・保存
                const savedFile = await saveContinuousRecordingAsSmf(session, requestedName, overwrite);
                // レジストリから削除（クリーンアップ）
                // Keep the finalized result available to status and repeated stop calls.
                return {
                    ok: true,
                    recordingId,
                    fileId: savedFile.fileId,
                    name: savedFile.name,
                    path: savedFile.path,
                    bytes: savedFile.bytes,
                    durationMs: savedFile.durationMs,
                    eventCount: savedFile.eventCount,
                    ppq: savedFile.ppq,
                    trackCount: savedFile.trackCount,
                    reason: session.reason || 'manual_stop',
                    recordingStartedAt: new Date(session.startedAt).toISOString(),
                    recordingEndedAt: new Date(session.endedAt!).toISOString(),
                    savedAt: recordingResults.get(session.id)?.savedAt
                } as any;
            }
            if (name === 'list_continuous_recordings') {
                const statusFilter: string = args?.status || 'active';
                const limit: number = Math.max(1, Math.min(50, args?.limit || 10));
                const allSessions = Array.from(continuousRecordingRegistry.values());
                // フィルター適用
                let filteredSessions = allSessions;
                if (statusFilter === 'active') {
                    filteredSessions = allSessions.filter(s => s.status === 'waiting_for_input' || s.status === 'recording');
                }
                else if (statusFilter === 'completed') {
                    filteredSessions = allSessions.filter(s => s.status === 'completed' ||
                        s.status === 'timeout_idle' ||
                        s.status === 'timeout_silence' ||
                        s.status === 'timeout_max_duration' ||
                        s.status === 'stopped_manually');
                }
                // statusFilter === 'all' の場合はフィルターなし
                // 制限適用（新しいものから順）
                const sortedSessions = filteredSessions
                    .sort((a, b) => b.startedAt - a.startedAt)
                    .slice(0, limit);
                // レスポンス形式に変換
                const recordings = sortedSessions.map(session => {
                    const now = Date.now();
                    const durationMs = session.lastInputAt
                        ? session.lastInputAt - session.startedAt
                        : now - session.startedAt;
                    const recording: any = {
                        recordingId: session.id,
                        status: session.status,
                        startedAt: new Date(session.startedAt).toISOString(),
                        durationMs: Math.max(0, durationMs),
                        eventCount: session.events.length,
                        portName: session.inputPortName || 'unknown'
                    };
                    // 完了セッションの場合は追加情報
                    if (session.status === 'completed' ||
                        session.status.startsWith('timeout_') ||
                        session.status === 'stopped_manually') {
                        if (session.lastInputAt) {
                            recording.endedAt = new Date(session.lastInputAt).toISOString();
                        }
                        if (session.reason) {
                            recording.reason = session.reason;
                        }
                        // fileIdは保存後に設定されるが、現在の実装ではセッション終了と同時にレジストリから削除される
                        // 将来的な拡張では保存されたfileId情報を含める可能性がある
                        recording.fileId = null;
                        recording.name = null;
                    }
                    else {
                        recording.fileId = null;
                    }
                    return recording;
                });
                // 統計情報
                const activeCount = allSessions.filter(s => s.status === 'waiting_for_input' || s.status === 'recording').length;
                const completedCount = allSessions.filter(s => s.status === 'completed' ||
                    s.status === 'timeout_idle' ||
                    s.status === 'timeout_silence' ||
                    s.status === 'timeout_max_duration' ||
                    s.status === 'stopped_manually').length;
                return {
                    ok: true,
                    recordings,
                    total: allSessions.length,
                    activeCount,
                    completedCount
                } as any;
            }
            if (name === "insert_sustain") {
                const fileId: string | undefined = args?.fileId;
                const ranges: Array<{
                    startTick: number;
                    endTick: number;
                    channel?: number;
                    trackIndex?: number;
                    valueOn?: number;
                    valueOff?: number;
                }> | undefined = args?.ranges;
                if (!fileId)
                    throw new Error("'fileId' is required for insert_sustain");
                if (!Array.isArray(ranges) || ranges.length === 0)
                    throw new Error("'ranges' must be a non-empty array");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const buf = await fs.readFile(absPath);
                const json = await decodeSmfToJson(buf);
                // デフォルトの挿入先トラック/チャンネルを推定
                const pickTrackIndex = (): number => {
                    // 音源イベントのある最初のトラック
                    const cand = json.tracks.findIndex((tr: any) => (tr.events || []).some((e: any) => e.type !== 'meta.tempo' && e.type !== 'meta.timeSignature' && e.type !== 'meta.keySignature'));
                    return cand >= 0 ? cand : 0;
                };
                const ensureTrack = (idx: number) => { if (!json.tracks[idx])
                    json.tracks[idx] = { events: [] }; };
                const guessChannelFromTrack = (tr: any): number | undefined => {
                    if (Number.isFinite(Number(tr?.channel)))
                        return (tr.channel | 0);
                    const ev = (tr?.events || []).find((e: any) => (e.channel !== undefined));
                    if (ev && Number.isFinite(Number(ev.channel)))
                        return (ev.channel | 0);
                    return undefined;
                };
                for (const r of ranges) {
                    const start = Math.max(0, Number((r as any).startTick | 0));
                    const end = Math.max(start, Number((r as any).endTick | 0));
                    const rr: any = r as any;
                    const onRaw = rr.valueOn;
                    const offRaw = rr.valueOff;
                    const valueOn = Number.isFinite(Number(onRaw)) ? Math.max(0, Math.min(127, Number(onRaw))) : 127;
                    const valueOff = Number.isFinite(Number(offRaw)) ? Math.max(0, Math.min(127, Number(offRaw))) : 0;
                    const removeExisting: boolean = rr.removeExisting !== false; // 既定 true
                    // 挿入先
                    const tIdx = Number.isFinite(Number(rr.trackIndex)) ? Math.max(0, Number(rr.trackIndex)) : pickTrackIndex();
                    ensureTrack(tIdx);
                    // channel受理: 1-16（外部表記）→内部0-15 / 0-15（内部表記）も許容
                    let chVal: number | undefined = Number.isFinite(Number(rr.channel)) ? Number(rr.channel) : guessChannelFromTrack(json.tracks[tIdx]);
                    let ch: number;
                    if (Number.isFinite(Number(chVal))) {
                        const c = Number(chVal);
                        if (c >= 1 && c <= 16)
                            ch = c - 1;
                        else
                            ch = c; // 外部表記なら-1
                    }
                    else {
                        ch = 0;
                    }
                    if (!Number.isFinite(ch as number))
                        ch = 0;
                    ch = Math.max(0, Math.min(15, ch as number));
                    // 範囲内の既存CC64を（同一チャンネルのみ）除去
                    if (removeExisting) {
                        json.tracks[tIdx].events = (json.tracks[tIdx].events || []).filter((ev: any) => {
                            if (ev?.type !== 'cc')
                                return true;
                            if ((ev.controller | 0) !== 64)
                                return true;
                            const trackChannel = json.tracks[tIdx]?.channel;
                            const normalizedTrackChannel = typeof trackChannel === 'number' ? (trackChannel | 0) : 0;
                            const evCh = Number.isFinite(Number(ev.channel)) ? (ev.channel | 0) : normalizedTrackChannel;
                            if ((evCh | 0) !== (ch | 0))
                                return true;
                            const tk = ev.tick | 0;
                            return !(tk >= start && tk <= end);
                        });
                    }
                    json.tracks[tIdx].events.push({ type: 'cc', tick: start, controller: 64, value: valueOn, channel: ch });
                    json.tracks[tIdx].events.push({ type: 'cc', tick: end, controller: 64, value: valueOff, channel: ch });
                    // 近傍の重複を軽減（同tickに複数が重ならないよう簡易除去）
                    json.tracks[tIdx].events = json.tracks[tIdx].events.filter((ev: any, i: number, arr: any[]) => {
                        if (ev.type !== 'cc' || ev.controller !== 64)
                            return true;
                        const key = `${ev.tick}:${ev.value}:${ev.channel ?? 'x'}`;
                        const first = arr.findIndex((e: any) => e.type === 'cc' && e.controller === 64 && (e.tick | 0) === (ev.tick | 0) && (e.value | 0) === (ev.value | 0) && ((e.channel ?? 'x') === (ev.channel ?? 'x')));
                        return first === i;
                    }).sort((a: any, b: any) => (a.tick | 0) - (b.tick | 0));
                }
                // 再エンコードして保存（上書き）
                const bin = encodeToSmfBinary(json);
                const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
                const outName = safeMidiName(args?.outputName?.trim() || item.name);
                const sameFile = outName === item.name;
                const record = await saveMidiRecordUnlocked(data,{name:outName,overwrite:sameFile || args?.overwrite === true,fileId:sameFile?item.id:undefined});
                return {ok:true,...record};
            }
            if (name === "insert_cc") {
                const fileId: string | undefined = args?.fileId;
                const controller: number | undefined = args?.controller;
                const ranges: Array<{
                    startTick: number;
                    endTick: number;
                    channel?: number;
                    trackIndex?: number;
                    valueOn?: number;
                    valueOff?: number;
                }> | undefined = args?.ranges;
                if (!fileId)
                    throw new Error("'fileId' is required for insert_cc");
                if (!Number.isFinite(Number(controller)))
                    throw new Error("'controller' is required (0-127)");
                const ctrl = Math.max(0, Math.min(127, Number(controller)));
                if (!Array.isArray(ranges) || ranges.length === 0)
                    throw new Error("'ranges' must be a non-empty array");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const buf = await fs.readFile(absPath);
                const json = await decodeSmfToJson(buf);
                const pickTrackIndex = (): number => {
                    const cand = json.tracks.findIndex((tr: any) => (tr.events || []).some((e: any) => e.type !== 'meta.tempo' && e.type !== 'meta.timeSignature' && e.type !== 'meta.keySignature'));
                    return cand >= 0 ? cand : 0;
                };
                const ensureTrack = (idx: number) => { if (!json.tracks[idx])
                    json.tracks[idx] = { events: [] }; };
                const guessChannelFromTrack = (tr: any): number | undefined => {
                    if (Number.isFinite(Number(tr?.channel)))
                        return (tr.channel | 0);
                    const ev = (tr?.events || []).find((e: any) => (e.channel !== undefined));
                    if (ev && Number.isFinite(Number(ev.channel)))
                        return (ev.channel | 0);
                    return undefined;
                };
                for (const r of ranges) {
                    const start = Math.max(0, Number((r as any).startTick | 0));
                    const end = Math.max(start, Number((r as any).endTick | 0));
                    const rr: any = r as any;
                    const onRaw = rr.valueOn;
                    const offRaw = rr.valueOff;
                    const valueOn = Number.isFinite(Number(onRaw)) ? Math.max(0, Math.min(127, Number(onRaw))) : 127;
                    const valueOff = Number.isFinite(Number(offRaw)) ? Math.max(0, Math.min(127, Number(offRaw))) : 0;
                    const tIdx = Number.isFinite(Number(rr.trackIndex)) ? Math.max(0, Number(rr.trackIndex)) : pickTrackIndex();
                    ensureTrack(tIdx);
                    // channel 1-16外部表記→内部0-15
                    let chVal: number | undefined = Number.isFinite(Number(rr.channel)) ? Number(rr.channel) : guessChannelFromTrack(json.tracks[tIdx]);
                    let ch: number;
                    if (Number.isFinite(Number(chVal))) {
                        const c = Number(chVal);
                        if (c >= 1 && c <= 16)
                            ch = c - 1;
                        else
                            ch = c;
                    }
                    else {
                        ch = 0;
                    }
                    json.tracks[tIdx].events.push({ type: 'cc', tick: start, controller: ctrl, value: valueOn, channel: ch });
                    json.tracks[tIdx].events.push({ type: 'cc', tick: end, controller: ctrl, value: valueOff, channel: ch });
                    json.tracks[tIdx].events = json.tracks[tIdx].events.filter((ev: any, i: number, arr: any[]) => {
                        if (ev.type !== 'cc' || ev.controller !== ctrl)
                            return true;
                        const key = `${ev.tick}:${ev.value}:${ev.channel ?? 'x'}`;
                        const first = arr.findIndex((e: any) => e.type === 'cc' && e.controller === ctrl && (e.tick | 0) === (ev.tick | 0) && (e.value | 0) === (ev.value | 0) && ((e.channel ?? 'x') === (ev.channel ?? 'x')));
                        return first === i;
                    }).sort((a: any, b: any) => (a.tick | 0) - (b.tick | 0));
                }
                // 再エンコードして保存（上書き）
                const bin = encodeToSmfBinary(json);
                const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
                const outName = safeMidiName(args?.outputName?.trim() || item.name);
                const sameFile = outName === item.name;
                const record = await saveMidiRecordUnlocked(data,{name:outName,overwrite:sameFile || args?.overwrite === true,fileId:sameFile?item.id:undefined});
                return {ok:true,...record};
            }
            if (name === "extract_bars") {
                const fileId: string | undefined = args?.fileId;
                const startBar: number | undefined = args?.startBar;
                const endBar: number | undefined = args?.endBar;
                const format: string = args?.format || "json_midi_v1";
                if (!fileId)
                    throw new Error("'fileId' is required for extract_bars");
                if (!Number.isFinite(Number(startBar)) || Number(startBar) < 1)
                    throw new Error("'startBar' must be >= 1");
                if (!Number.isFinite(Number(endBar)) || Number(endBar) < 1)
                    throw new Error("'endBar' must be >= 1");
                if (Number(startBar) > Number(endBar))
                    throw new Error("'startBar' must be <= 'endBar'");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const buf = await fs.readFile(absPath);
                const json = await decodeSmfToJson(buf);
                // タイムシグネチャを抽出
                const timeSignature = extractTimeSignatureFromJson(json);
                const ppq = json.ppq || 480;
                // 小節範囲をtickに変換
                const startTick = barToTick(Number(startBar), ppq, timeSignature);
                const endTick = barToTick(Number(endBar) + 1, ppq, timeSignature); // 終了小節の次の小節の開始tick
                // 指定範囲のイベントを抽出
                const extractedJson = {
                    ppq,
                    tracks: json.tracks.map((track: any) => {
                        const filteredEvents = (track.events || [])
                            .filter((event: any) => {
                            const eventTick = event.tick || 0;
                            return eventTick >= startTick && eventTick < endTick;
                        })
                            .map((event: any) => ({
                            ...event,
                            tick: event.tick - startTick // 相対tickに変換
                        }));
                        return {
                            ...track,
                            events: filteredEvents
                        };
                    })
                };
                // Score DSL形式が要求された場合は変換（将来拡張）
                if (format === "score_dsl_v1") {
                    // 現在は未実装、JSON MIDI形式で返却
                    console.warn("Score DSL v1 export is not yet implemented, returning JSON MIDI v1");
                }
                return {
                    ok: true,
                    fileId,
                    startBar: Number(startBar),
                    endBar: Number(endBar),
                    startTick,
                    endTick,
                    json: extractedJson,
                    ppq,
                    timeSignature,
                    eventCount: extractedJson.tracks.reduce((sum: number, track: any) => sum + (track.events?.length || 0), 0),
                    durationTicks: endTick - startTick
                } as any;
            }
            if (name === "replace_bars") {
                const fileId: string | undefined = args?.fileId;
                const startBar: number | undefined = args?.startBar;
                const endBar: number | undefined = args?.endBar;
                const jsonData: any = args?.json;
                const format: string = args?.format || "json_midi_v1";
                const outputName: string | undefined = args?.outputName;
                if (!fileId)
                    throw new Error("'fileId' is required for replace_bars");
                if (!Number.isFinite(Number(startBar)) || Number(startBar) < 1)
                    throw new Error("'startBar' must be >= 1");
                if (!Number.isFinite(Number(endBar)) || Number(endBar) < 1)
                    throw new Error("'endBar' must be >= 1");
                if (Number(startBar) > Number(endBar))
                    throw new Error("'startBar' must be <= 'endBar'");
                if (!jsonData)
                    throw new Error("'json' is required for replace_bars");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item.path);
                const buf = await fs.readFile(absPath);
                const originalJson = await decodeSmfToJson(buf);
                // タイムシグネチャを抽出
                const timeSignature = extractTimeSignatureFromJson(originalJson);
                const ppq = originalJson.ppq || 480;
                // 小節範囲をtickに変換
                const startTick = barToTick(Number(startBar), ppq, timeSignature);
                const endTick = barToTick(Number(endBar) + 1, ppq, timeSignature);
                // 置換用JSONデータの処理
                let replacementJson: any;
                if (typeof jsonData === 'string') {
                    try {
                        replacementJson = JSON.parse(jsonData);
                    }
                    catch {
                        throw new Error("Invalid JSON string in 'json' parameter");
                    }
                }
                else {
                    replacementJson = jsonData;
                }
                // Score DSL形式の場合はコンパイル
                if (format === "score_dsl_v1") {
                    try {
                        replacementJson = compileScoreToJsonMidi(replacementJson);
                    }
                    catch (err: any) {
                        throw new Error(`Score DSL compilation failed: ${err.message}`);
                    }
                }
                // 置換処理：指定範囲のイベントを削除し、新しいイベントを追加
                const modifiedJson = {
                    ...originalJson,
                    tracks: originalJson.tracks.map((track: any, trackIndex: number) => {
                        // 指定範囲外のイベントを保持
                        const eventsOutsideRange = (track.events || [])
                            .filter((event: any) => {
                            const eventTick = event.tick || 0;
                            return eventTick < startTick || eventTick >= endTick;
                        });
                        // 置換用データから全トラックのイベントを取得（SMF→JSONで統合されている可能性があるため）
                        let replacementEvents: any[] = [];
                        if (trackIndex === 0) {
                            // 統合されたトラックの場合、置換データの全非メタイベントを統合
                            for (const replacementTrack of (replacementJson.tracks || [])) {
                                const trackEvents = (replacementTrack.events || [])
                                    .filter((event: any) => !event.type?.startsWith('meta.')) // メタイベント除外
                                    .map((event: any) => ({
                                    ...event,
                                    tick: (event.tick || 0) + startTick, // 絶対tickに変換
                                    channel: event.channel !== undefined ? event.channel : replacementTrack.channel // トラックのチャンネルを継承
                                }));
                                replacementEvents.push(...trackEvents);
                            }
                        }
                        else if (replacementJson.tracks?.[trackIndex]) {
                            // 対応するトラックがある場合はそのイベントを使用
                            replacementEvents = (replacementJson.tracks[trackIndex].events || [])
                                .map((event: any) => ({
                                ...event,
                                tick: (event.tick || 0) + startTick // 絶対tickに変換
                            }));
                        }
                        return {
                            ...track,
                            events: [...eventsOutsideRange, ...replacementEvents].sort((a: any, b: any) => (a.tick || 0) - (b.tick || 0))
                        };
                    })
                };
                // SMFファイルとして保存
                const bin = encodeToSmfBinary(modifiedJson);
                const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
                const finalName = safeMidiName(outputName || `${item.name.replace(/\.midi?$/i,'')}_bars${startBar}-${endBar}.mid`);
                const record = await saveMidiRecordUnlocked(data,{name:finalName,overwrite:args?.overwrite === true});
                const newFileId = record.fileId;
                const relPath = record.path;
                const bytes = record.bytes;
                return {
                    ok: true,
                    originalFileId: fileId,
                    newFileId,
                    fileId:newFileId,
                    name: finalName,
                    path: relPath,
                    bytes,
                    startBar: Number(startBar),
                    endBar: Number(endBar),
                    startTick,
                    endTick,
                    replacedEventCount: replacementJson.tracks?.reduce((sum: number, track: any) => sum + (track.events?.length || 0), 0) || 0,
                    totalEventCount: modifiedJson.tracks.reduce((sum: number, track: any) => sum + (track.events?.length || 0), 0)
                } as any;
            }
            if (name === "play_smf") {
                if (!args?.fileId) throw new Error("'fileId' is required for play_smf");
                const item = await getItemById(args.fileId);
                if (!item) throw new Error(`fileId not found: ${args.fileId}`);
                const json = await decodeSmfToJson(await fs.readFile(path.resolve(resolveBaseDir(),item.path)));
                const plan = buildPlaybackPlan(json,{startMs:args.startMs,stopMs:args.stopMs,startBar:args.startBar,endBar:args.endBar});
                const playbackId = randomUUID();
                if (args.dryRun) {
                    playbacks.set(playbackId,{type:'smf',fileId:item.id,done:true,dryRun:true,scheduledEvents:plan.scheduledEvents,totalDurationMs:plan.totalDurationMs});
                } else {
                    const {MidiOutput: Output} = await loadMidi();
                    if (!Output) throw new Error('node-midi not available for output');
                    const out = trackPort(new Output());
                    try {
                        const count = out.getPortCount();
                        if (!count) throw new Error('node-midi not available: no output devices');
                        const names = Array.from({length:count},(_,i)=>String(out.getPortName(i)));
                        let index = 0;
                        if (typeof args.portName === 'string' && args.portName) {
                            index = names.findIndex(name=>name.toLowerCase().includes(args.portName.toLowerCase()));
                            if (index < 0) throw new Error(`output port not found: ${args.portName}`);
                        } else {
                            const preferred = names.findIndex(name=>/iac|network|virtual/i.test(name));
                            if (preferred >= 0) index = preferred;
                        }
                        out.openPort(index);
                        const state = startPlayback(plan,out,{lookaheadMs:args.schedulerLookaheadMs,tickMs:args.schedulerTickMs,portName:names[index],portIndex:index});
                        playbacks.set(playbackId,Object.assign(state,{fileId:item.id}));
                    } catch (error) { try {out.closePort();}catch{} throw error; }
                }
                return {ok:true,playbackId,scheduledEvents:plan.scheduledEvents,totalDurationMs:plan.totalDurationMs,extractionMode:plan.extractionMode,warnings:plan.warnings.length?plan.warnings:undefined,...(process.env.MCP_MIDI_PLAY_SMF_DEBUG_JSON?{debug:plan.debug}:{})};
            }
            if (name === "get_midi") {
                const fileId: string | undefined = args?.fileId;
                const includeBase64: boolean = !!args?.includeBase64;
                if (!fileId)
                    throw new Error("'fileId' is required for get_midi");
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const absPath = path.resolve(resolveBaseDir(), item!.path);
                const buf = includeBase64 ? await fs.readFile(absPath) : undefined;
                const base64 = includeBase64 && buf ? buf.toString("base64") : undefined;
                return {
                    ok: true,
                    fileId: item.id,
                    name: item.name,
                    path: item.path,
                    bytes: item.bytes,
                    createdAt: item.createdAt,
                    ...(includeBase64 && base64 ? { base64 } : {}),
                } as any;
            }
            if (name === "list_midi") {
                const limitRaw = args?.limit;
                const offsetRaw = args?.offset;
                const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
                    ? Math.min(Number(limitRaw), 100)
                    : 20;
                const offset = Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) >= 0
                    ? Number(offsetRaw)
                    : 0;
                let items: Array<{
                    id: string;
                    name: string;
                    path: string;
                    bytes: number;
                    createdAt: string;
                }> = [];
                items = (await readManifest()).items;
                const total = items.length;
                const slice = items.slice(offset, offset + limit);
                return { ok: true, total, items: slice } as any;
            }
            if (name === "export_midi") {
                const fileId: string | undefined = args?.fileId;
                if (!fileId)
                    throw new Error("'fileId' is required for export_midi");
                const item = await getItemById(fileId);
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                const srcAbs = path.resolve(resolveBaseDir(), item.path);
                const exportDir = resolveExportDir();
                await fs.mkdir(exportDir, { recursive: true });
                if ((await fs.lstat(exportDir)).isSymbolicLink()) throw new Error('Export directory must not be a symlink');
                const destAbs = path.join(exportDir,safeMidiName(args?.outputName || item.name));
                const bytes = await fs.readFile(srcAbs);
                if (args?.overwrite) {
                    const temp = `${destAbs}.${randomUUID()}.tmp`;
                    try {await fs.writeFile(temp,bytes,{flag:'wx'});await fs.rename(temp,destAbs);} finally {await fs.unlink(temp).catch(()=>{});}
                } else await fs.writeFile(destAbs,bytes,{flag:'wx'});
                const exportPath = path.relative(resolveBaseDir(),destAbs);
                return {ok:true,fileId,exportPath,exportedPath:exportPath,bytes:bytes.length};
            }
            if (name === "list_devices") {
                const devices: Array<{
                    id: string;
                    name: string;
                    placeholder?: boolean;
                }> = [];
                const diagnostics: any = { platform: process.platform };
                {
                    let realCount = 0;
                    let nativeLoadFailed: string | undefined;
                    try {
                        const { MidiOutput: OutCls } = await loadMidi();
                        if (OutCls) {
                            const out = trackPort(new OutCls());
                            const count = typeof out.getPortCount === "function" ? out.getPortCount() : 0;
                            diagnostics.nativePortCount = count;
                            for (let i = 0; i < count; i++) {
                                try {
                                    const n = out.getPortName(i);
                                    devices.push({ id: String(i), name: String(n) });
                                    realCount++;
                                }
                                catch (e: any) {
                                    diagnostics.lastEnumerateError = String(e?.message || e);
                                }
                            }
                            out.closePort();
                        }
                        else {
                            nativeLoadFailed = 'MidiOutputClassUnavailable';
                        }
                    }
                    catch (e: any) {
                        nativeLoadFailed = String(e?.code || e?.message || 'unknown');
                    }
                    if (nativeLoadFailed) {
                        diagnostics.nativeLoadFailed = nativeLoadFailed;
                        if (lastMidiLoadError) {
                            const msg = String(lastMidiLoadError?.message || lastMidiLoadError);
                            if (msg && !diagnostics.nativeLoadErrorMessage)
                                diagnostics.nativeLoadErrorMessage = msg.slice(0, 400);
                        }
                    }
                    diagnostics.realCount = realCount;

                }
                return { ok: true, devices, diagnostics } as any;
            }
            if (name === "playback_midi") {
                const fileId: string | undefined = args?.fileId;
                const portName: string | undefined = args?.portName;
                const durationMsRaw = args?.durationMs;
                const durationMs = Number.isFinite(Number(durationMsRaw)) && Number(durationMsRaw) > 0 ? Math.min(Number(durationMsRaw), 2000) : 300;
                if (!fileId)
                    throw new Error("'fileId' is required for playback_midi");
                // ファイル存在チェック（インメモリ→ストレージ）
                let item: ItemRec | undefined;
                if (!item)
                    item = (await getItemById(fileId)) as ItemRec | undefined;
                if (!item)
                    throw new Error(`fileId not found: ${fileId}`);
                // macOSで node-midi が利用可能な場合のみ、即時に開閉する簡易送出でPoC
                let playbackId = randomUUID();
                {
                    const { MidiOutput: OutCls } = await loadMidi();
                    if (OutCls) {
                        const out = trackPort(new OutCls());
                        const ports = out.getPortCount();
                        if (!ports) throw new Error('node-midi not available: no output devices');
                        // ポート選択: 指定があれば部分一致（大文字小文字無視）、無ければIAC/Network/Virtual優先、無ければ0
                        let target = 0;
                        const pickByHint = (hint: string) => {
                            for (let i = 0; i < ports; i++) {
                                try {
                                    const name = out.getPortName(i);
                                    if (String(name).toLowerCase().includes(hint))
                                        return i;
                                }
                                catch { }
                            }
                            return -1;
                        };
                        if (typeof portName === 'string' && portName.length > 0) {
                            const wanted = pickByHint(String(portName).toLowerCase());
                            if (wanted >= 0) target = wanted;
                            else throw new Error('output port not found: ' + args?.portName);
                        }
                        else {
                            const pref = pickByHint('iac');
                            const net = pref < 0 ? pickByHint('network') : pref;
                            const vir = net < 0 ? pickByHint('virtual') : net;
                            if (vir >= 0)
                                target = vir;
                        }
                        try {
                            out.openPort(target);
                            // 簡易確認: Middle C を短く鳴らす（Note On/Off）
                            out.sendMessage([0x90, 60, 100]);
                            // 指定時間だけ維持
                            await new Promise(res => setTimeout(res, durationMs));
                            out.sendMessage([0x80, 60, 0]);
                        }
                        finally {
                            try {
                                out.closePort();
                            }
                            catch { }
                        }
                    } else { throw new Error('node-midi not available for output'); }
                }
                // メモリ状態に記録
                playbacks.set(playbackId, { fileId, portName: portName || null, startedAt: Date.now(), done:true });
                return { ok: true, playbackId } as any;
            }
            if (name === "stop_playback") {
                const playbackId: string | undefined = args?.playbackId;
                if (!playbackId)
                    throw new Error("'playbackId' is required for stop_playback");
                const map: Map<string, any> | undefined = playbacks;
                const st = map?.get(playbackId);
                if (st?.stop) {st.stop();return {ok:true};}
                if (st) {
                    // スケジューラ停止
                    if (st.intervalId) {
                        try {
                            clearInterval(st.intervalId);
                        }
                        catch { }
                    }
                    for (const to of st.timeouts || []) {
                        try {
                            clearTimeout(to);
                        }
                        catch { }
                    }
                    // 未消音ノートを消音
                    if (st.out && st.active && st.active.size) {
                        try {
                            // まず CC123 All Notes Off をアクティブなチャンネルに送出（安全網）
                            const chSet = new Set<number>();
                            for (const key of Array.from(st.active)) {
                                const [chStr] = String(key).split(":");
                                chSet.add((Number(chStr) | 0) & 0x0f);
                            }
                            for (const ch of chSet) {
                                st.out.sendMessage([0xB0 | ch, 123, 0]);
                            }
                            // 念のため個別ノートにも Note On(vel0) を送る
                            for (const key of Array.from(st.active)) {
                                const [chStr, nStr] = String(key).split(":");
                                const ch = Number(chStr) | 0;
                                const n = Number(nStr) | 0;
                                st.out.sendMessage([0x90 | (ch & 0x0f), n & 0x7f, 0]);
                            }
                        }
                        catch { }
                    }
                    // 出力を閉じる
                    if (st.out) {
                        try {
                            st.out.closePort();
                        }
                        catch { }
                    }
                    st.done = true;
                }
                return { ok: true } as any;
            }
            if (name === "get_playback_status") {
                const playbackId: string | undefined = args?.playbackId;
                if (!playbackId)
                    throw new Error("'playbackId' is required for get_playback_status");
                const map: Map<string, any> | undefined = playbacks;
                const st = map?.get(playbackId);
                if (!st)
                    return { ok: false, error: 'not_found' } as any;
                const now = performance.now();
                const elapsedMs = now - (st.__t0 || now); // __t0 未保持でも0扱い
                const resp = {
                    ok: true,
                    type: st.type,
                    fileId: st.fileId,
                    scheduledEvents: st.scheduledEvents,
                    totalDurationMs: st.totalDurationMs ?? undefined,
                    cursor: st.cursor ?? undefined,
                    lastSentIndex: st.lastSentIndex ?? undefined,
                    lastSentAt: st.lastSentAt ?? undefined,
                    lookahead: st.lookahead ?? undefined,
                    tickInterval: st.tickInterval ?? undefined,
                    portIndex: st.portIndex ?? undefined,
                    portName: st.portName ?? undefined,
                    activeNotes: st.active ? Array.from(st.active) : [],
                    done: !!st.done,
                    error: st.error,
                };
                return resp as any;
            }
            if (name === "find_midi") {
                const q: string = String(args?.query || "").trim();
                if (!q)
                    return { ok: true, items: [] } as any;
                const manifest = await readManifest();
                const qLower = q.toLowerCase();
                const items = manifest.items.filter(i => i.name.toLowerCase().includes(qLower));
                return { ok: true, items } as any;
            }
            throw new Error(`Tool ${name} not found`);
        }
        catch (err: any) {
            // 例外をクライアントに伝達可能な構造化エラーへ変換
            const classified = classifyError(name, err);
            return { ok: false, error: { tool: name, ...classified } };
        }
    }
    async function runCall(name: string, args?: Record<string, any>): Promise<any> {
        if (disposed)
            return { ok: false, error: { code: 'ENGINE_DISPOSED', message: 'MIDI engine has been disposed' } };
        let result:any;
        try { result = await (['append_to_smf','insert_cc','insert_sustain','replace_bars','clean_midi'].includes(name) ? withDataWriteLock(()=>dispatch(name,args)) : dispatch(name,args)); } catch(error) {return {ok:false,error:classifyError(name,error)};}
        if (result?.ok === false && result.error && typeof result.error === 'object' && !result.error.code) result.error = {...result.error,...classifyError(name,new Error(result.error.message || 'Operation failed'))};
        if (result?.ok === false && typeof result.error === 'string')
            result.error = { code: result.error === 'not_found' ? 'NOT_FOUND' : 'INTERNAL_ERROR', message: result.error };
        return result;
    }
    const activeCalls = new Set<Promise<any>>();
    function call(name:string,args?:Record<string,any>):Promise<any> {
        const pending = runCall(name,args);
        activeCalls.add(pending);
        void pending.finally(()=>activeCalls.delete(pending)).catch(()=>{});
        return pending;
    }
    let disposing: Promise<void> | undefined;
    function dispose(): Promise<void> {
        if (disposing) return disposing;
        disposed = true;
        disposing = (async () => {
            clearInterval(cleanupInterval);
            await Promise.allSettled(activeCalls);
            for (const playbackId of playbacks.keys()) await dispatch('stop_playback', {playbackId});
            for (const st of captureRegistry.values()) { st.done=true; }
            for (const session of continuousRecordingRegistry.values()) {
                finalizeSession(session, 'engine_disposed');
                if (session.status === 'recording' || session.status === 'waiting_for_input') session.status = 'stopped_manually';
                void saveContinuousRecordingAsSmf(session).catch(() => {});
            }
            for (const port of [...ports]) { try {port.closePort();} catch {} }
            const settled = await Promise.allSettled(recordingSaves.values());
            const failed = settled.find(result => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        })();
        return disposing;
    }
    function getActivity() { for (const st of captureRegistry.values()) maybeAutoFinalize(st); return { playbacks: [...playbacks.values()].filter(s => !s.done && !s.dryRun).length, recordings: [...continuousRecordingRegistry.values()].filter(s => s.status === 'recording' || s.status === 'waiting_for_input' || pendingSaves.has(s.id)).length, captures: [...captureRegistry.values()].filter(s => !s.done).length }; }
    function snapshot() {
        return structuredClone({
            playbacks:[...playbacks].map(([id,s])=>({ok:true,id,playbackId:id,type:s.type,fileId:s.fileId,done:!!s.done,error:s.error,scheduledEvents:s.scheduledEvents,totalDurationMs:s.totalDurationMs,cursor:s.cursor,lastSentIndex:s.lastSentIndex,portName:s.portName,activeNotes:s.active?[...s.active]:[]})),
            captures:[...captureRegistry].map(([id,s])=>({ok:true,id,captureId:id,done:s.done,reason:s.reason,result:s.result})),
            recordings:[...continuousRecordingRegistry].map(([id,s])=>({ok:true,id,recordingId:id,status:s.status,reason:s.reason,startedAt:new Date(s.startedAt).toISOString(),endedAt:s.endedAt!==undefined?new Date(s.endedAt).toISOString():undefined,currentDurationMs:(s.endedAt??Date.now())-s.startedAt,eventCount:s.eventCount,eventBreakdown:{...s.eventBreakdown},channelActivity:{...s.channelActivity},result:recordingResults.get(id),fileId:recordingResults.get(id)?.fileId,error:recordingResults.get(id)?.error,saveError:recordingResults.get(id)?.error,saveStatus:recordingResults.has(id)?(recordingResults.get(id).ok?'saved':'failed'):pendingSaves.has(id)?'saving':'pending',tempoBpm:120}))
        });
    }
    return { call, dispose, getActivity, snapshot };
}
