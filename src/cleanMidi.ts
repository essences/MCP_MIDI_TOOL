import { encodeToSmfBinary } from "./jsonToSmf.js";
import { decodeSmfToJson } from "./smfToJson.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendItem, resolveBaseDir, resolveMidiDir } from "./storage.js";

/**
 * Very small subset of JsonMidiSong shape we rely on (kept loose to avoid import cycles).
 */
type AnySong = {
  ppq?: number;
  tracks: { name?: string; channel?: number; events: any[] }[];
};

export interface CleanResult {
  fileId: string;
  path: string;
  bytes: number;
  original: { trackCount: number; eventCount: number };
  cleaned: { trackCount: number; eventCount: number };
  removedDuplicateMeta: number;
  mergedTracks: number;
}

/**
 * Normalize a decoded SMF JSON (tempo/time/key meta duplication & per-channel track merging).
 * Strategy:
 *  - Collect first encountered tempo/timeSignature/keySignature (tick order) as canonical.
 *  - Remove further duplicates for those meta types.
 *  - Merge tracks sharing the same channel number (excluding channel undefined) preserving order.
 *  - Keep non-channel (meta-only) tracks by folding their events into track0.
 */
export function cleanJsonMidiSong(song: AnySong): { cleaned: AnySong; removedMeta: number; mergedTracks: number } {
  const canonicalTempo: any[] = [];
  const canonicalTS: any[] = [];
  const canonicalKS: any[] = [];
  let removedMeta = 0;
  // Gather & dedupe metas (retain earliest tick occurrence of each type)
  for (const tr of song.tracks) {
    tr.events = tr.events.filter(ev => {
      if (!ev || typeof ev.type !== 'string') return true;
      if (ev.type === 'meta.tempo') {
        if (canonicalTempo.length === 0) { canonicalTempo.push(ev); return false; } // pull out into canonical set
        removedMeta++; return false;
      }
      if (ev.type === 'meta.timeSignature') {
        if (canonicalTS.length === 0) { canonicalTS.push(ev); return false; }
        removedMeta++; return false;
      }
      if (ev.type === 'meta.keySignature') {
        if (canonicalKS.length === 0) { canonicalKS.push(ev); return false; }
        removedMeta++; return false;
      }
      return true;
    });
  }

  // Merge by channel
  const byChannel = new Map<number, { name?: string; channel: number; events: any[] }>();
  const orphanEvents: any[] = [];
  for (const tr of song.tracks) {
    const ch = typeof tr.channel === 'number' ? tr.channel : undefined;
    if (ch == null) {
      orphanEvents.push(...tr.events);
      continue;
    }
    const slot = byChannel.get(ch) || { channel: ch, events: [], name: tr.name };
    slot.events.push(...tr.events);
    // Preserve earliest name
    if (!slot.name && tr.name) slot.name = tr.name;
    byChannel.set(ch, slot);
  }
  const mergedTracks = byChannel.size;
  // Sort events in each merged track by tick
  for (const t of byChannel.values()) {
    t.events.sort((a,b)=> (a.tick||0)-(b.tick||0));
  }

  // Rebuild track list: one meta track (track0) containing canonical metas + orphan events, then channel tracks
  // Canonical metas forced to tick 0 (if they had tick>0) and unique per type
  for (const ev of [...canonicalTempo, ...canonicalTS, ...canonicalKS]) { ev.tick = 0; }
  const track0 = { events: [...canonicalTempo, ...canonicalTS, ...canonicalKS, ...orphanEvents] } as any;
  // Remove any accidental duplicate meta of same type at same tick that slipped in via orphanEvents
  const seenMetaTypes = new Set<string>();
  track0.events = track0.events.filter((ev: any) => {
    if (ev?.type?.startsWith('meta.')) {
      if (['meta.tempo','meta.timeSignature','meta.keySignature'].includes(ev.type)) {
        if (seenMetaTypes.has(ev.type)) { removedMeta++; return false; }
        seenMetaTypes.add(ev.type);
      }
    }
    return true;
  });
  track0.events.sort((a: any, b: any)=> (a.tick||0)-(b.tick||0));
  const newTracks = [track0, ...Array.from(byChannel.values())];
  const cleaned: AnySong = { ppq: song.ppq, tracks: newTracks };
  return { cleaned, removedMeta, mergedTracks: song.tracks.length - mergedTracks };
}

export async function cleanMidiFile(absPath: string): Promise<CleanResult> {
  const data = await fs.readFile(absPath);
  const decoded = await decodeSmfToJson(data) as unknown as AnySong; // relaxed assertion for cleaning scope
  const originalEvents = decoded.tracks.reduce((a,t)=> a + t.events.length, 0);
  const { cleaned, removedMeta, mergedTracks } = cleanJsonMidiSong(decoded);
  // Encode
  const smf = encodeToSmfBinary({ ppq: cleaned.ppq || 480, format: 1, tracks: cleaned.tracks } as any);
  const baseDir = resolveBaseDir();
  const midiDir = resolveMidiDir(baseDir);
  await fs.mkdir(midiDir, { recursive: true });
  const fileId = randomUUID();
  const outName = `cleaned_${fileId}.mid`;
  const outPath = path.join(midiDir, outName);
  await fs.writeFile(outPath, smf);
  await appendItem({ id: fileId, name: outName, path: path.relative(baseDir, outPath), bytes: smf.byteLength, createdAt: new Date().toISOString() });
  return {
    fileId,
    path: path.relative(baseDir, outPath),
    bytes: smf.byteLength,
    original: { trackCount: decoded.tracks.length, eventCount: originalEvents },
    cleaned: { trackCount: cleaned.tracks.length, eventCount: cleaned.tracks.reduce((a,t)=>a+t.events.length,0) },
    removedDuplicateMeta: removedMeta,
    mergedTracks
  };
}
