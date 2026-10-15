export function startPlayback(plan, output, options = {}) {
    const lookahead = options.lookaheadMs ?? 50, tick = options.tickMs ?? 10;
    if (!Number.isFinite(lookahead) || lookahead < 0 || !Number.isFinite(tick) || tick <= 0)
        throw new Error('Invalid playback scheduler timing');
    if (!Number.isFinite(plan.totalDurationMs) || plan.totalDurationMs < 0 || plan.events.some((event, index) => !Number.isFinite(event.tMs) || event.tMs < 0 || event.tMs > plan.totalDurationMs || (index > 0 && event.tMs < plan.events[index - 1].tMs)))
        throw new Error('Invalid playback plan');
    const started = performance.now();
    const channels = new Set(plan.events.map(event => event.ch));
    const state = { type: 'smf', done: false, cursor: 0, lastSentIndex: -1, lastSentAt: 0, scheduledEvents: plan.events.length, totalDurationMs: plan.totalDurationMs, active: new Set(), out: output, intervalId: undefined, timeouts: new Set(), portName: options.portName, portIndex: options.portIndex, stop: () => finish() };
    function recordError(error) { state.error ??= { code: 'MIDI_SEND_FAILED', message: error instanceof Error ? error.message : String(error) }; }
    function finish() {
        if (state.done)
            return;
        state.done = true;
        if (state.intervalId !== undefined)
            clearInterval(state.intervalId);
        state.intervalId = undefined;
        for (const timer of state.timeouts)
            clearTimeout(timer);
        state.timeouts.clear();
        const send = (bytes) => { try {
            output.sendMessage(bytes);
        }
        catch (error) {
            recordError(error);
        } };
        for (const key of state.active) {
            const [ch, note] = key.split(':').map(Number);
            send([0x80 | ch, note, 0]);
        }
        for (const ch of channels) {
            send([0xb0 | ch, 64, 0]);
            send([0xb0 | ch, 123, 0]);
        }
        state.active.clear();
        try {
            output.closePort?.();
        }
        catch (error) {
            recordError(error);
        }
    }
    function schedule(fn, delay) {
        const timer = setTimeout(() => { state.timeouts.delete(timer); if (!state.done)
            fn(); }, Math.max(0, delay));
        state.timeouts.add(timer);
    }
    function checkDone() {
        if (state.lastSentIndex === plan.events.length - 1 && performance.now() - started >= plan.totalDurationMs)
            finish();
    }
    function pump() {
        const elapsed = performance.now() - started;
        while (!state.done && state.cursor < plan.events.length && plan.events[state.cursor].tMs <= elapsed + lookahead) {
            const index = state.cursor++;
            const event = plan.events[index];
            schedule(() => {
                try {
                    output.sendMessage(event.bytes);
                    if (event.kind === 'on')
                        state.active.add(`${event.ch}:${event.n}`);
                    if (event.kind === 'off')
                        state.active.delete(`${event.ch}:${event.n}`);
                    state.lastSentIndex = index;
                    state.lastSentAt = performance.now() - started;
                    checkDone();
                }
                catch (error) {
                    recordError(error);
                    finish();
                }
            }, event.tMs - elapsed);
        }
        checkDone();
    }
    state.intervalId = setInterval(pump, tick);
    schedule(checkDone, plan.totalDurationMs);
    pump();
    return state;
}
