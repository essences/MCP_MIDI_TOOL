class WorkflowError extends Error {
    result;
    constructor(result) {
        super(result.error?.message || 'Workflow failed');
        this.result = result;
    }
}
const fail = (code, message) => ({ ok: false, error: { code, message } });
const checked = (result) => { if (!result?.ok)
    throw new WorkflowError(result || fail('INTERNAL_ERROR', 'Empty runtime result')); return result; };
const terminal = (status) => !['waiting_for_input', 'recording'].includes(status.status);
function defaultDelay(ms, signal) { return new Promise((resolve, reject) => { if (signal?.aborted)
    return reject(new WorkflowError(fail('CANCELLED', 'Workflow cancelled'))); const abort = () => { clearTimeout(timer); reject(new WorkflowError(fail('CANCELLED', 'Workflow cancelled'))); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms); signal?.addEventListener('abort', abort, { once: true }); }); }
function context(deps) { return { now: deps.now || Date.now, delay: deps.delay || defaultDelay, poll: deps.pollMs ?? 50, check() { if (deps.signal?.aborted)
        throw new WorkflowError(fail('CANCELLED', 'Workflow cancelled')); } }; }
function startArgs(options) { const { durationMs, ...args } = options; return { ...args, maxDurationMs: options.maxDurationMs ?? durationMs ?? 30000 }; }
async function cleanup(deps, operation, args) { let timer; try {
    return await Promise.race([deps.client(operation, args), new Promise(resolve => { timer = setTimeout(() => resolve(fail('CLEANUP_TIMEOUT', `Cleanup ${operation} timed out`)), deps.cleanupTimeoutMs ?? 5000); })]);
}
catch (error) {
    return fail('CLEANUP_FAILED', error.message);
}
finally {
    if (timer)
        clearTimeout(timer);
} }
function unknownOutcome(result) { return ['TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ERROR'].includes(result.error?.code); }
function errorResult(error) { return error instanceof WorkflowError ? error.result : fail('WORKFLOW_FAILED', error?.message || String(error)); }
function saved(status) { if (status.saveError || status.result?.ok === false)
    throw new WorkflowError({ ok: false, error: status.saveError || status.result.error }); return status.result?.ok && status.result.fileId ? status.result : undefined; }
/** Foreground recording owns only the session started by this call. */
export async function recordForeground(options, deps) {
    const ctx = context(deps);
    let recordingId;
    let settled = false;
    let completed = false;
    let stopRequested = false;
    try {
        ctx.check();
        const start = checked(await deps.client('start_continuous_recording', startArgs(options), true));
        recordingId = start.recordingId;
        const deadline = ctx.now() + (options.durationMs ?? options.maxDurationMs ?? 30000);
        const saveDeadline = deadline + 15000;
        while (ctx.now() < saveDeadline) {
            ctx.check();
            const status = checked(await deps.client('get_continuous_recording_status', { recordingId }));
            if (terminal(status)) {
                completed = true;
                const result = saved(status);
                if (result) {
                    settled = true;
                    return { ...result, recordingId };
                }
                if (status.status === 'error')
                    throw new WorkflowError(fail('RECORDING_FAILED', 'Recording entered error state'));
            }
            else if (ctx.now() >= deadline) {
                stopRequested = true;
                const result = checked(await deps.client('stop_continuous_recording', { recordingId, name: options.name, overwrite: options.overwrite }));
                completed = true;
                settled = true;
                return result;
            }
            await ctx.delay(ctx.poll, deps.signal);
        }
        throw new WorkflowError(fail('TIMEOUT', 'Recording result was not saved before the deadline'));
    }
    catch (error) {
        const result = errorResult(error);
        if (recordingId && !settled && !completed && (!stopRequested || !unknownOutcome(result))) {
            const stopped = await cleanup(deps, 'stop_continuous_recording', { recordingId, name: options.name, overwrite: options.overwrite });
            return { ...result, recordingId, recording: stopped };
        }
        return { ...result, ...(recordingId ? { recordingId } : {}) };
    }
}
/** Start input before playback, then save after playback/post-roll or early input timeout. */
export async function playAndRecord(options, deps) {
    const ctx = context(deps);
    let recordingId;
    let playbackId;
    let recordingComplete = false;
    let recordingSaved;
    let playbackComplete = false;
    let stopRequested = false;
    try {
        ctx.check();
        const { fileId, playPort, recordPort, preRollMs, postRollMs, ...recordOptions } = options;
        const started = checked(await deps.client('start_continuous_recording', startArgs({ ...recordOptions, portName: recordPort }), true));
        recordingId = started.recordingId;
        const deadline = ctx.now() + (options.maxDurationMs ?? 30000) + 15000;
        async function recordingStatus() { const status = checked(await deps.client('get_continuous_recording_status', { recordingId })); if (terminal(status)) {
            recordingComplete = true;
            recordingSaved = saved(status);
            if (status.status === 'error')
                throw new WorkflowError(fail('RECORDING_FAILED', 'Recording entered error state'));
        } return status; }
        if ((preRollMs ?? 0) > 0)
            await ctx.delay(preRollMs, deps.signal);
        ctx.check();
        await recordingStatus();
        if (recordingComplete)
            throw new WorkflowError(fail('RECORDING_ENDED_EARLY', 'Recording ended before playback started'));
        const playback = checked(await deps.client('play_smf', { fileId, portName: playPort }, true));
        playbackId = playback.playbackId;
        let postDeadline;
        while (ctx.now() < deadline) {
            ctx.check();
            await recordingStatus();
            if (!playbackComplete) {
                const status = checked(await deps.client('get_playback_status', { playbackId }));
                if (status.error)
                    throw new WorkflowError({ ok: false, error: status.error });
                if (status.done) {
                    playbackComplete = true;
                    postDeadline = ctx.now() + (postRollMs ?? 0);
                }
            }
            if (recordingComplete && !playbackComplete)
                throw new WorkflowError(fail('RECORDING_ENDED_EARLY', 'Recording ended before playback completed'));
            if (playbackComplete && (recordingComplete || ctx.now() >= postDeadline)) {
                if (!recordingComplete) {
                    stopRequested = true;
                    recordingSaved = checked(await deps.client('stop_continuous_recording', { recordingId, name: options.name, overwrite: options.overwrite }));
                    recordingComplete = true;
                }
                if (recordingSaved)
                    return { ok: true, recording: recordingSaved, playback: { ...playback, done: true }, fileId: recordingSaved.fileId, recordingId, playbackId };
            }
            await ctx.delay(ctx.poll, deps.signal);
        }
        throw new WorkflowError(fail('TIMEOUT', 'Play/record workflow exceeded its deadline'));
    }
    catch (error) {
        const result = errorResult(error);
        const cleanups = {};
        if (playbackId && !playbackComplete)
            cleanups.playback = await cleanup(deps, 'stop_playback', { playbackId });
        if (recordingId && !recordingComplete && (!stopRequested || !unknownOutcome(result)))
            cleanups.recording = await cleanup(deps, 'stop_continuous_recording', { recordingId, name: options.name, overwrite: options.overwrite });
        else if (recordingComplete) {
            const saveDeadline = ctx.now() + (deps.cleanupTimeoutMs ?? 5000);
            while (!recordingSaved && ctx.now() < saveDeadline) {
                const status = await cleanup(deps, 'get_continuous_recording_status', { recordingId });
                if (!status?.ok || status.saveError || status.result?.ok === false)
                    break;
                recordingSaved = status.result?.ok && status.result.fileId ? status.result : undefined;
                if (!recordingSaved)
                    await ctx.delay(ctx.poll);
            }
            if (recordingSaved)
                cleanups.recording = recordingSaved;
        }
        return { ...result, recordingId, playbackId, ...cleanups };
    }
}
