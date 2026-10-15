import { expect, test } from 'vitest';
import { buildPlaybackPlan } from '../src/playbackPlan.js';
import type { JsonMidiSong } from '../src/jsonSchema.js';
const song = (events: any[], channel = 3): JsonMidiSong => ({ format: 1, ppq: 480, tracks: [{ channel, events }] });
test('integrates changing tempos and emits nonzero-channel state bytes', () => {
  const plan = buildPlaybackPlan(song([
    { type: 'meta.tempo', tick: 0, usPerQuarter: 500000 }, { type: 'meta.tempo', tick: 480, usPerQuarter: 1000000 },
    { type: 'program', tick: 0, program: 9 }, { type: 'cc', tick: 0, controller: 64, value: 127 }, { type: 'pitchBend', tick: 0, value: 8191 },
    { type: 'note', tick: 0, pitch: 60, velocity: 100, duration: 960 },
  ]));
  expect(plan.totalDurationMs).toBe(1500);
  expect(plan.events.slice(0, 3).map(event => event.bytes)).toEqual([[0xc3, 9], [0xb3, 64, 127], [0xe3, 127, 127]]);
  expect(plan.events.at(-1)).toMatchObject({ tMs: 1500, bytes: [0x83, 60, 0] });
});
test('clips both note boundaries and restores latest state per controller/channel', () => {
  const plan = buildPlaybackPlan(song([
    { type: 'cc', tick: 0, controller: 7, value: 80 }, { type: 'cc', tick: 200, controller: 7, value: 90 },
    { type: 'cc', tick: 0, controller: 7, value: 70, channel: 2 }, { type: 'program', tick: 0, program: 2 }, { type: 'pitchBend', tick: 100, value: -8192 },
    { type: 'note', tick: 0, pitch: 60, velocity: 90, duration: 1920 },
  ]), { startMs: 500, stopMs: 1000 });
  expect(plan.totalDurationMs).toBe(500);
  expect(plan.events.filter(event => event.kind === 'on')).toEqual([{ tMs: 0, bytes: [0x93, 60, 90], kind: 'on', ch: 3, n: 60, v: 90 }]);
  expect(plan.events.at(-1)?.tMs).toBe(500);
  expect(plan.events.map(event => event.bytes)).toContainEqual([0xb3, 7, 90]);
  expect(plan.events.map(event => event.bytes)).toContainEqual([0xb2, 7, 70]);
  expect(plan.events.map(event => event.bytes)).toContainEqual([0xe3, 0, 0]);
  expect(plan.events.filter(event => event.bytes[0] === 0xb3)).toHaveLength(1);
});
test('bar boundaries reflect meter changes and include metadata', () => {
  const plan = buildPlaybackPlan(song([
    { type: 'meta.timeSignature', tick: 0, numerator: 4, denominator: 4 },
    { type: 'meta.timeSignature', tick: 1920, numerator: 3, denominator: 4 },
    { type: 'meta.marker', tick: 2000, text: 'selected' },
    { type: 'note', tick: 1800, pitch: 60, velocity: 90, duration: 2000 },
  ]), { startBar: 2, endBar: 2 });
  expect(plan.totalDurationMs).toBe(1500);
  expect(plan.extractionMode).toBe('precise');
  expect(plan.debug?.extracted.tracks[0].events).toContainEqual({ type: 'meta.marker', tick: 80, text: 'selected' });
  expect(plan.events[0].tMs).toBe(0); expect(plan.events.at(-1)?.tMs).toBe(1500);
});
test('note offs precede state and ons; invalid range and malformed notes fail', () => {
  const input = song([{ type: 'note', tick: 0, pitch: 60, velocity: 90, duration: 480 }, { type: 'cc', tick: 480, controller: 64, value: 0 }, { type: 'note', tick: 480, pitch: 61, velocity: 90, duration: 480 }]);
  expect(buildPlaybackPlan(input).events.filter(event => event.tMs === 500).map(event => event.kind)).toEqual(['off', 'state', 'on']);
  expect(() => buildPlaybackPlan(input, { startMs: 700, stopMs: 100 })).toThrow();
  expect(() => buildPlaybackPlan(input, { startBar: 1, startMs: 0 })).toThrow();
  expect(() => buildPlaybackPlan(song([{ type: 'note', tick: 0, duration: 1, velocity: 90 }]))).toThrow();
});
test('unbounded plans retain final state events including tick-zero-only songs', () => {
  expect(buildPlaybackPlan(song([{ type: 'cc', tick: 0, controller: 64, value: 0 }])).events.map(event => event.bytes)).toEqual([[0xb3, 64, 0]]);
  const input = song([{ type: 'note', tick: 0, pitch: 60, velocity: 80, duration: 480 }, { type: 'cc', tick: 480, controller: 64, value: 0 }]);
  expect(buildPlaybackPlan(input).events.at(-1)?.bytes).toEqual([0xb3, 64, 0]);
  expect(buildPlaybackPlan(input, { stopMs: 500 }).events.some(event => event.kind === 'state')).toBe(false);
});
test('off-boundary meter metadata is accepted without a bar selection', () => {
  const input = song([{ type: 'meta.timeSignature', tick: 120, numerator: 3, denominator: 4 }, { type: 'cc', tick: 480, controller: 64, value: 0 }]);
  expect(() => buildPlaybackPlan(input)).not.toThrow(); expect(() => buildPlaybackPlan(input, { stopMs: 500 })).not.toThrow();
  expect(() => buildPlaybackPlan(input, { startBar: 1 })).toThrow('bar boundary');
});
