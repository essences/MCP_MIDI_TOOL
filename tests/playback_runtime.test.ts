import { afterEach, expect, test, vi } from 'vitest';
import { buildPlaybackPlan } from '../src/playbackPlan.js';
import { startPlayback } from '../src/playbackRuntime.js';
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const sent: number[][] = []; const closePort = vi.fn();
  const output = { sendMessage: (bytes: number[]) => { sent.push(bytes); }, closePort };
  const plan = buildPlaybackPlan({ format: 1, ppq: 480, tracks: [{ channel: 5, events: [
    { type: 'program', tick: 0, program: 4 }, { type: 'cc', tick: 0, controller: 64, value: 127 }, { type: 'pitchBend', tick: 0, value: 0 },
    { type: 'note', tick: 0, pitch: 60, velocity: 90, duration: 480 },
  ] }] });
  return { sent, closePort, output, plan };
}
test('lookahead never finishes before queued events actually deliver', () => {
  const { sent, closePort, output, plan } = setup();
  const state = startPlayback(plan, output, { lookaheadMs: 1000 });
  expect(state.cursor).toBe(plan.events.length); expect(state.done).toBe(false);
  vi.advanceTimersByTime(1);
  expect(sent.slice(0, 3)).toEqual([[0xc5, 4], [0xb5, 64, 127], [0xe5, 0, 64]]);
  expect(state.active.has('5:60')).toBe(true);
  vi.advanceTimersByTime(498); expect(state.done).toBe(false); expect(closePort).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(state.done).toBe(true); expect(state.lastSentIndex).toBe(plan.events.length - 1);
  expect(sent.slice(-3)).toEqual([[0x85, 60, 0], [0xb5, 64, 0], [0xb5, 123, 0]]);
  expect(closePort).toHaveBeenCalledOnce(); expect(state.timeouts.size).toBe(0);
});
test('stop releases held notes and sustain once and cancels pending events', () => {
  const { sent, closePort, output, plan } = setup(); const state = startPlayback(plan, output);
  vi.advanceTimersByTime(5); state.stop(); const count = sent.length;
  expect(sent.slice(-3)).toEqual([[0x85, 60, 0], [0xb5, 64, 0], [0xb5, 123, 0]]);
  state.stop(); vi.advanceTimersByTime(1000); expect(sent).toHaveLength(count); expect(closePort).toHaveBeenCalledOnce();
});
test('send failure records structured error and closes output', () => {
  const { closePort, plan } = setup();
  const state = startPlayback(plan, { sendMessage() { throw new Error('device lost'); }, closePort });
  vi.advanceTimersByTime(1);
  expect(state.done).toBe(true); expect(state.error).toEqual({ code: 'MIDI_SEND_FAILED', message: 'device lost' }); expect(closePort).toHaveBeenCalledOnce();
});
