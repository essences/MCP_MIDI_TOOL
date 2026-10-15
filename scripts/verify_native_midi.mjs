#!/usr/bin/env node
// Opt-in CoreMIDI integration: only this process's uniquely named virtual ports.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
if (!process.argv.includes('--run')) {
  console.log('Build first, then opt in: node scripts/verify_native_midi.mjs --run');
  process.exit(0);
}
const require = createRequire(import.meta.url);
const midi = require('midi');
const { createMidiEngine } = await import('../dist/engine.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midi-native-qa-'));
const suffix = `${process.pid}-${Date.now()}`;
const sinkName = `MIDI-TOOL-QA-SINK-${suffix}`, sourceName = `MIDI-TOOL-QA-SOURCE-${suffix}`;
let sink, source, engine;
const received = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(operation, args = {}) {
  const result = await engine.call(operation, args);
  assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
  return result;
}
try {
  process.env.MIDI_TOOL_DATA_DIR = path.join(root, 'data');
  process.env.MCP_MIDI_MANIFEST = 'manifest.json';
  sink = new midi.Input(); sink.ignoreTypes(false, false, false);
  sink.on('message', (delta, bytes) => received.push({ delta, bytes: [...bytes], at: performance.now() }));
  sink.openVirtualPort(sinkName);
  source = new midi.Output(); source.openVirtualPort(sourceName);
  // Refuse to proceed unless both exact private port names are discoverable.
  const inputProbe = new midi.Input(), outputProbe = new midi.Output();
  try {
    assert(Array.from({ length: inputProbe.getPortCount() }, (_, n) => inputProbe.getPortName(n)).includes(sourceName));
    assert(Array.from({ length: outputProbe.getPortCount() }, (_, n) => outputProbe.getPortName(n)).includes(sinkName));
  } finally { inputProbe.closePort(); outputProbe.closePort(); }
  engine = createMidiEngine();
  const recording = await call('start_continuous_recording', { portName: sourceName, idleTimeoutMs: 10000, silenceTimeoutMs: 10000, maxDurationMs: 10000 });
  const composed = await call('json_to_smf', { format: 'json_midi_v1', name: 'private-play.mid', json: { format: 1, ppq: 480, tracks: [{ channel: 3, events: [
    { type: 'meta.tempo', tick: 0, usPerQuarter: 500000 },
    { type: 'program', tick: 0, program: 9 }, { type: 'cc', tick: 0, controller: 1, value: 70 },
    { type: 'pitchBend', tick: 0, value: 512 }, { type: 'note', tick: 0, pitch: 60, velocity: 90, duration: 480 },
  ] }] } });
  const playback = await call('play_smf', { fileId: composed.fileId, portName: sinkName });
  await delay(50);
  const simultaneous = engine.getActivity();
  assert.equal(simultaneous.playbacks, 1); assert.equal(simultaneous.recordings, 1);
  source.sendMessage([0xc3, 12]); source.sendMessage([0xb3, 1, 75]); source.sendMessage([0xe3, 0, 68]); source.sendMessage([0x93, 65, 96]);
  await delay(180); source.sendMessage([0x83, 65, 0]); source.sendMessage([0xb3, 64, 0]);
  const deadline = Date.now() + 5000;
  let playbackStatus;
  do { playbackStatus = await call('get_playback_status', { playbackId: playback.playbackId }); if (playbackStatus.done) break; await delay(20); } while (Date.now() < deadline);
  assert.equal(playbackStatus.done, true); assert.equal(playbackStatus.error, undefined);
  await delay(50);
  const expected = [[0xc3, 9], [0xb3, 1, 70], [0xe3, 0, 68], [0x93, 60, 90], [0x83, 60, 0], [0xb3, 64, 0], [0xb3, 123, 0]];
  for (const bytes of expected) assert(received.some(message => JSON.stringify(message.bytes) === JSON.stringify(bytes)), `Missing sink bytes ${bytes}`);
  const stopped = await call('stop_continuous_recording', { recordingId: recording.recordingId, name: 'private-record.mid' });
  const decoded = await call('smf_to_json', { fileId: stopped.fileId });
  const events = decoded.json.tracks.flatMap(track => track.events);
  const note = events.find(event => event.type === 'note' && event.pitch === 65 && event.channel === 3);
  assert(note, 'Recorded note and internal channel3 must survive saved SMF');
  const durationMs = note.duration / decoded.json.ppq * 500;
  assert(durationMs >= 100 && durationMs <= 400, `Recorded note duration ${durationMs}ms`);
  assert(events.some(event => event.type === 'cc' && event.controller === 1 && event.value === 75 && event.channel === 3));
  assert(events.some(event => event.type === 'pitchBend' && event.value === 512 && event.channel === 3));
  assert(events.some(event => event.type === 'program' && event.program === 12 && event.channel === 3));
  console.log(JSON.stringify({ ok: true, platform: process.platform, node: process.version, sinkName, sourceName, simultaneous, sinkMessages: received.map(message => message.bytes), recording: { durationMs, events: events.length, bytes: stopped.bytes }, usedExistingPorts: false }, null, 2));
} finally {
  await engine?.dispose().catch(error => console.error('Dispose:', error.message));
  try { sink?.closePort(); } catch {}
  try { source?.closePort(); } catch {}
  await fs.rm(root, { recursive: true, force: true });
}
