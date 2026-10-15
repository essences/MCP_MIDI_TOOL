import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMidiEngine } from '../src/engine.js';
const note = (pitch: number, tick = 0, duration = 240) => ({ type: 'note', pitch, tick, duration, velocity: 90 });
const json = (events: any[], channel = 3) => ({ format: 1, ppq: 480, tracks: [{ channel, events }] });
describe.sequential('engine editing preservation and concurrency', () => {
  let root: string, engine: ReturnType<typeof createMidiEngine>;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'editing-')); vi.stubEnv('MIDI_TOOL_DATA_DIR', path.join(root, 'data')); vi.stubEnv('MCP_MIDI_MANIFEST', 'manifest.json'); engine = createMidiEngine({ midi: {} }); });
  afterEach(async () => { await engine.dispose(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  async function call(op: string, args: any) { const result = await engine.call(op, args); expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); return result; }
  async function save(song: any, name = 'source.mid') { return call('json_to_smf', { json: song, format: 'json_midi_v1', name }); }
  async function decode(fileId: string) { return (await call('smf_to_json', { fileId })).json; }
  const notes = (song: any) => song.tracks.flatMap((track: any) => track.events.filter((event: any) => event.type === 'note'));
  it('append preserves distinct tracks and channels', async () => {
    const saved = await save({ format: 1, ppq: 480, tracks: [{ name: 'lead', channel: 3, events: [note(60)] }, { name: 'bass', channel: 5, events: [note(48)] }] });
    await call('append_to_smf', { fileId: saved.fileId, json: json([note(62)]), format: 'json_midi_v1', atEnd: true });
    const decoded = await decode(saved.fileId);
    expect(notes(decoded)).toEqual(expect.arrayContaining([expect.objectContaining({ pitch: 60, channel: 3 }), expect.objectContaining({ pitch: 48, channel: 5 }), expect.objectContaining({ pitch: 62, channel: 3 })]));
    expect(decoded.tracks.filter((track: any) => track.events.some((event: any) => event.type === 'note')).length).toBeGreaterThanOrEqual(2);
  });
  it('extract and replace bars creates a separate result without changing source', async () => {
    const saved = await save(json([note(60, 0), note(62, 1920), note(64, 3840)]));
    const before = await fs.readFile(path.resolve(root, saved.path));
    const extracted = await call('extract_bars', { fileId: saved.fileId, startBar: 2, endBar: 2 });
    expect(notes(extracted.json).map((event: any) => [event.pitch, event.tick])).toEqual([[62, 0]]);
    const replaced = await call('replace_bars', { fileId: saved.fileId, startBar: 2, endBar: 2, json: json([note(67)]), outputName: 'replacement.mid' });
    expect(replaced.fileId).not.toBe(saved.fileId);
    expect(notes(await decode(replaced.fileId)).map((event: any) => event.pitch)).toEqual([60, 67, 64]);
    expect(await fs.readFile(path.resolve(root, saved.path))).toEqual(before);
  });
  it('CC external channel maps to internal channel and output copy preserves source', async () => {
    const saved = await save(json([note(60, 0, 960)])); const before = await fs.readFile(path.resolve(root, saved.path));
    const changed = await call('insert_cc', { fileId: saved.fileId, controller: 64, ranges: [{ startTick: 0, endTick: 480, channel: 4 }], outputName: 'pedal.mid' });
    expect(changed.fileId).not.toBe(saved.fileId);
    const controls = (await decode(changed.fileId)).tracks.flatMap((track: any) => track.events).filter((event: any) => event.type === 'cc');
    expect(controls).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 3, controller: 64, value: 127, tick: 0 }), expect.objectContaining({ channel: 3, controller: 64, value: 0, tick: 480 })]));
    expect(await fs.readFile(path.resolve(root, saved.path))).toEqual(before);
  });
  it('concurrent appends retain every update and cleaning makes a safe copy', async () => {
    const saved = await save(json([note(60)]));
    await Promise.all([61, 62, 63, 64].map(pitch => call('append_to_smf', { fileId: saved.fileId, json: json([note(pitch)]), format: 'json_midi_v1', atEnd: true })));
    expect(notes(await decode(saved.fileId)).map((event: any) => event.pitch).sort()).toEqual([60, 61, 62, 63, 64]);
    const before = await fs.readFile(path.resolve(root, saved.path)); const cleaned = await call('clean_midi', { fileId: saved.fileId });
    expect(cleaned.fileId).not.toBe(saved.fileId); expect(await fs.readFile(path.resolve(root, saved.path))).toEqual(before);
    expect(notes(await decode(cleaned.fileId))).toHaveLength(5);
  });
});
