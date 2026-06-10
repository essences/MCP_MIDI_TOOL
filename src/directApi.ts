import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { zSong } from "./jsonSchema.js";
import { encodeToSmfBinary } from "./jsonToSmf.js";
import { compileScoreToJsonMidi } from "./scoreToJsonMidi.js";
import { decodeSmfToJson } from "./smfToJson.js";
import {
  appendItem,
  getItemById,
  readManifest,
  resolveBaseDir,
  resolveExportDir,
  resolveMidiDir,
  writeManifest,
  type MidiItem,
} from "./storage.js";

export type SupportedFormat = "json_midi_v1" | "score_dsl_v1";

export type ControllerRangeInput = {
  startTick: number;
  endTick: number;
  channel?: number;
  trackIndex?: number;
  valueOn?: number;
  valueOff?: number;
  removeExisting?: boolean;
};

type JsonSong = Awaited<ReturnType<typeof decodeSmfToJson>>;

function eventCount(song: JsonSong | any): number {
  return Array.isArray(song?.tracks)
    ? song.tracks.reduce((sum: number, track: any) => sum + (Array.isArray(track?.events) ? track.events.length : 0), 0)
    : 0;
}

function ensureMidExtension(name: string) {
  return name.toLowerCase().endsWith(".mid") ? name : `${name}.mid`;
}

function normalizeSongInput(input: unknown, format?: SupportedFormat) {
  if (format === "json_midi_v1") return zSong.parse(input);
  if (format === "score_dsl_v1") return zSong.parse(compileScoreToJsonMidi(input));

  const parsed = zSong.safeParse(input);
  if (parsed.success) return parsed.data;
  return zSong.parse(compileScoreToJsonMidi(input));
}

async function resolveItem(fileId: string) {
  const item = await getItemById(fileId);
  if (!item) throw new Error(`fileId not found: ${fileId}`);
  return item;
}

async function writeMidiRecord(data: Buffer, name: string, fileId?: string) {
  const midiDir = resolveMidiDir();
  await fs.mkdir(midiDir, { recursive: true });
  const nameWithExt = ensureMidExtension(name);
  const absPath = path.join(midiDir, nameWithExt);
  await fs.writeFile(absPath, data);

  const base = resolveBaseDir();
  const relPath = path.relative(base, absPath);
  const bytes = data.byteLength;

  if (fileId) {
    const manifest = await readManifest();
    const existing = manifest.items.find((item) => item.id === fileId);
    if (!existing) throw new Error(`fileId not found in manifest: ${fileId}`);
    existing.name = nameWithExt;
    existing.path = relPath;
    existing.bytes = bytes;
    await writeManifest(manifest);
    return { fileId, name: nameWithExt, path: relPath, bytes, createdAt: existing.createdAt };
  }

  const createdAt = new Date().toISOString();
  const newId = randomUUID();
  const record: MidiItem = { id: newId, name: nameWithExt, path: relPath, bytes, createdAt };
  await appendItem(record);
  return { fileId: newId, name: nameWithExt, path: relPath, bytes, createdAt };
}

export async function saveSongAsSmf(params: {
  json: unknown;
  format?: SupportedFormat;
  name?: string;
  overwrite?: boolean;
}) {
  const song = normalizeSongInput(params.json, params.format);
  const binary = encodeToSmfBinary(song);
  const data = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const name = ensureMidExtension(params.name?.trim() || `json-${Date.now()}.mid`);
  const saved = await writeMidiRecord(data, name);
  return {
    ok: true,
    ...saved,
    trackCount: Array.isArray(song.tracks) ? song.tracks.length : 0,
    eventCount: eventCount(song),
  };
}

export async function loadSmfAsJson(fileId: string) {
  const item = await resolveItem(fileId);
  const absPath = path.resolve(resolveBaseDir(), item.path);
  const buf = await fs.readFile(absPath);
  const json = await decodeSmfToJson(buf);
  return {
    ok: true,
    fileId,
    json,
    bytes: buf.byteLength,
    trackCount: Array.isArray(json.tracks) ? json.tracks.length : 0,
    eventCount: eventCount(json),
  };
}

function normalizeControllerValue(value: number | undefined, fallback: number) {
  return Math.max(0, Math.min(127, Number.isFinite(Number(value)) ? Number(value) | 0 : fallback));
}

function normalizeTrackIndex(song: JsonSong, preferred?: number) {
  if (Number.isFinite(Number(preferred)) && song.tracks[preferred as number]) return preferred as number;
  const firstMusicalTrack = song.tracks.findIndex((track: any) =>
    (track.events || []).some((event: any) =>
      !["meta.tempo", "meta.timeSignature", "meta.keySignature", "meta.trackName", "meta.marker"].includes(event.type)
    )
  );
  return firstMusicalTrack >= 0 ? firstMusicalTrack : 0;
}

export async function insertControllerRanges(params: {
  fileId: string;
  controller: number;
  ranges: ControllerRangeInput[];
  outputName?: string;
}) {
  if (!Array.isArray(params.ranges) || params.ranges.length === 0) {
    throw new Error("ranges must be a non-empty array");
  }

  const item = await resolveItem(params.fileId);
  const loaded = await loadSmfAsJson(params.fileId);
  const song = loaded.json;
  const controller = Math.max(0, Math.min(127, params.controller | 0));

  for (const range of params.ranges) {
    const trackIndex = normalizeTrackIndex(song, range.trackIndex);
    if (!song.tracks[trackIndex]) song.tracks[trackIndex] = { events: [] } as any;
    const track = song.tracks[trackIndex] as any;
    const channel = Number.isFinite(Number(range.channel))
      ? Math.max(0, Math.min(15, (Number(range.channel) | 0) - 1))
      : (Number.isFinite(Number(track.channel)) ? Number(track.channel) | 0 : 0);
    const startTick = Math.max(0, Number(range.startTick) | 0);
    const endTick = Math.max(startTick, Number(range.endTick) | 0);
    const valueOn = normalizeControllerValue(range.valueOn, 127);
    const valueOff = normalizeControllerValue(range.valueOff, 0);
    const removeExisting = range.removeExisting !== false;

    if (removeExisting) {
      track.events = (track.events || []).filter((event: any) => {
        if (event.type !== "cc" || event.controller !== controller) return true;
        const eventChannel = Number.isFinite(Number(event.channel))
          ? Number(event.channel) | 0
          : (Number.isFinite(Number(track.channel)) ? Number(track.channel) | 0 : 0);
        return !(event.tick >= startTick && event.tick <= endTick && eventChannel === channel);
      });
    }

    track.events.push(
      { type: "cc", tick: startTick, controller, value: valueOn, channel },
      { type: "cc", tick: endTick, controller, value: valueOff, channel }
    );
    track.events.sort((a: any, b: any) => (a.tick | 0) - (b.tick | 0) || String(a.type).localeCompare(String(b.type)));
  }

  const binary = encodeToSmfBinary(song);
  const data = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const saved = await writeMidiRecord(data, params.outputName?.trim() || item.name, params.outputName ? undefined : item.id);
  return {
    ok: true,
    ...saved,
    controller,
    rangeCount: params.ranges.length,
  };
}

export async function insertSustainRanges(params: {
  fileId: string;
  ranges: ControllerRangeInput[];
  outputName?: string;
}) {
  return insertControllerRanges({ ...params, controller: 64 });
}

export async function exportMidiFile(fileId: string, outputName?: string) {
  const item = await resolveItem(fileId);
  const base = resolveBaseDir();
  const src = path.resolve(base, item.path);
  const exportDir = resolveExportDir();
  await fs.mkdir(exportDir, { recursive: true });
  const destName = ensureMidExtension(outputName?.trim() || item.name);
  const dest = path.join(exportDir, destName);
  await fs.copyFile(src, dest);
  const stat = await fs.stat(dest);
  return {
    ok: true,
    fileId,
    exportedPath: path.relative(base, dest),
    bytes: stat.size,
  };
}

export async function analyzeSmfDryRun(fileId: string) {
  const loaded = await loadSmfAsJson(fileId);
  const song = loaded.json;
  let maxTick = 0;
  let scheduledEvents = 0;
  const tempoAtZero = song.tracks
    .flatMap((track: any) => track.events || [])
    .find((event: any) => event.type === "meta.tempo" && (event.tick | 0) === 0);
  const usPerQuarter = tempoAtZero?.usPerQuarter || 500000;

  for (const track of song.tracks || []) {
    for (const event of track.events || []) {
      if (event.type === "note") {
        scheduledEvents += 2;
        maxTick = Math.max(maxTick, (event.tick | 0) + (event.duration | 0));
      } else if (event.type !== "meta.trackName" && event.type !== "meta.marker") {
        scheduledEvents += 1;
        maxTick = Math.max(maxTick, event.tick | 0);
      }
    }
  }

  const totalDurationMs = Math.round((maxTick / (song.ppq || 480)) * (usPerQuarter / 1000));
  return {
    ok: true,
    fileId,
    scheduledEvents,
    totalDurationMs,
    ppq: song.ppq,
    trackCount: loaded.trackCount,
  };
}
