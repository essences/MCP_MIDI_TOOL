import type { JsonMidiSong } from "./jsonSchema.js";

function writeUint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff; b[1] = (n >>> 16) & 0xff; b[2] = (n >>> 8) & 0xff; b[3] = n & 0xff;
  return b;
}

function writeVarLen(n: number): number[] {
  // MIDI variable length quantity
  let buffer = n & 0x7f;
  const bytes: number[] = [];
  while ((n >>= 7)) {
    buffer <<= 8;
    buffer |= ((n & 0x7f) | 0x80);
  }
  // unfold
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8; else break;
  }
  return bytes;
}

function textToBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

type EncEvent = { tick: number; bytes: number[]; ord: number };

function buildTrackBody(events: EncEvent[]): Uint8Array {
  events.sort((a, b) => a.tick - b.tick || a.ord - b.ord);
  let lastTick = 0;
  const out: number[] = [];
  for (const ev of events) {
    const dt = Math.max(0, ev.tick - lastTick);
    out.push(...writeVarLen(dt));
    out.push(...ev.bytes);
    lastTick = ev.tick;
  }
  // End of Track (delta 0)
  out.push(0x00, 0xff, 0x2f, 0x00);
  return new Uint8Array(out);
}

function buildTrackChunk(events: EncEvent[]): Uint8Array {
  const body = buildTrackBody(events);
  const len = body.length;
  const chunk = new Uint8Array(4 + 4 + len);
  chunk.set([0x4d, 0x54, 0x72, 0x6b], 0);
  chunk.set(writeUint32BE(len), 4);
  chunk.set(body, 8);
  return chunk;
}

export function encodeToSmfBinary(song: JsonMidiSong): Uint8Array {
  const ppq = song.ppq || 480;
  const format = (song.format === 0 ? 0 : 1) as 0 | 1;

  // 音名→MIDIノート番号（C4=60基準）
  const NOTE_BASE: Record<string, number> = { C:0, "C#":1, Db:1, D:2, "D#":3, Eb:3, E:4, F:5, "F#":6, Gb:6, G:7, "G#":8, Ab:8, A:9, "A#":10, Bb:10, B:11 };
  function nameToMidi(n?: string): number | undefined {
    if (!n) return undefined;
    const m = /^([A-Ga-g])([#b]?)-?(\d+)$/.exec(n.trim());
    if (!m) return undefined;
    let [_, L, acc, octStr] = m;
    const letter = L.toUpperCase();
    const key = (letter + (acc || "")) as keyof typeof NOTE_BASE;
    const base = NOTE_BASE[key];
    if (base === undefined) return undefined;
    const oct = Number(octStr);
    if (!Number.isFinite(oct)) return undefined;
    const midi = base + (oct + 1) * 12; // MIDI: C-1=0 → C4(=60)
    return (midi >= 0 && midi <= 127) ? midi : undefined;
  }

  // Prepare per-track EncEvent lists
  const makeEncEventsForTrack = (trackIndex: number) => {
    const tr = song.tracks[trackIndex]!;
    const chDefault = Number.isFinite(Number(tr.channel)) ? (tr.channel as number) : undefined;
    const enc: EncEvent[] = [];

    // track name meta at tick of the earliest event (default 0)
    if (tr.name) {
      const nameBytes = textToBytes(String(tr.name).slice(0, 128));
      enc.push({ tick: 0, ord: 0, bytes: [0xff, 0x03, ...writeVarLen(nameBytes.length), ...nameBytes] });
    }

    for (const e of tr.events) {
      if (e.type === "meta.tempo") {
        // collect later into track 0 (handled below)
        continue;
      }
      if (e.type === "program") {
        const ch = Number.isFinite(Number(e.channel)) ? (e.channel as number) : (chDefault ?? 0);
        const prog = Math.max(0, Math.min(127, e.program|0));
        enc.push({ tick: e.tick, ord: 10, bytes: [0xc0 | (ch & 0x0f), prog] });
        continue;
      }
      if (e.type === "cc") {
        const ch = Number.isFinite(Number(e.channel)) ? (e.channel as number) : (chDefault ?? 0);
        const ctrl = Math.max(0, Math.min(127, e.controller|0));
        const val = Math.max(0, Math.min(127, e.value|0));
        enc.push({ tick: e.tick, ord: 20, bytes: [0xb0 | (ch & 0x0f), ctrl, val] });
        continue;
      }
      if (e.type === "pitchBend") {
        const ch = Number.isFinite(Number(e.channel)) ? (e.channel as number) : (chDefault ?? 0);
        const v14 = Math.max(-8192, Math.min(8191, e.value|0)) + 8192; // 0..16383
        const lsb = v14 & 0x7f, msb = (v14 >> 7) & 0x7f;
        enc.push({ tick: e.tick, ord: 30, bytes: [0xe0 | (ch & 0x0f), lsb, msb] });
        continue;
      }
      if (e.type === "note") {
        const ch = Number.isFinite(Number(e.channel)) ? (e.channel as number) : (chDefault ?? 0);
        const nRaw = (e as any).pitch ?? nameToMidi((e as any).note);
        const n = Math.max(0, Math.min(127, Number(nRaw)|0));
        const v = Math.max(1, Math.min(127, e.velocity|0));
        const tOn = e.tick|0;
        const tOff = Math.max(tOn, tOn + (e.duration|0));
        // NoteOff before NoteOn at same tick → ord: off=90, on=100
        enc.push({ tick: tOn, ord: 100, bytes: [0x90 | (ch & 0x0f), n, v] });
        enc.push({ tick: tOff, ord: 90, bytes: [0x80 | (ch & 0x0f), n, 0] });
        continue;
      }
      if (e.type === "meta.trackName") {
        const nameBytes = textToBytes(String(e.text).slice(0, 128));
        enc.push({ tick: e.tick, ord: 0, bytes: [0xff, 0x03, ...writeVarLen(nameBytes.length), ...nameBytes] });
        continue;
      }
      if (e.type === "meta.marker") {
        const txt = textToBytes(String(e.text).slice(0, 128));
        enc.push({ tick: e.tick, ord: 5, bytes: [0xff, 0x06, ...writeVarLen(txt.length), ...txt] });
        continue;
      }
      if (e.type === "meta.timeSignature") {
        // handled later (first track)
        continue;
      }
      if (e.type === "meta.keySignature") {
        // handled later (first track)
        continue;
      }
      // unimplemented types are ignored for now (future work)
    }
    return enc;
  };

  // Gather global metas (tempo, timeSignature, keySignature) for track 0
  const tempoEnc: EncEvent[] = [];
  const tsEnc: EncEvent[] = [];
  const ksEnc: EncEvent[] = [];
  for (const tr of song.tracks) {
    for (const e of tr.events) {
      if (e.type === "meta.tempo") {
        const uspq = Math.max(1, e.usPerQuarter|0);
        const b2 = (uspq >>> 16) & 0xff, b1 = (uspq >>> 8) & 0xff, b0 = uspq & 0xff;
        tempoEnc.push({ tick: e.tick, ord: -10, bytes: [0xff, 0x51, 0x03, b2, b1, b0] });
      } else if (e.type === "meta.timeSignature") {
        const num = Math.max(1, e.numerator|0);
        const den = Math.max(1, e.denominator|0);
        // convert to power-of-two exponent
        const dd = Math.max(0, Math.round(Math.log2(den)));
        const cc = 24; // MIDI clocks per metronome click
        const bb = 8;  // 32nd notes per 24 MIDI clocks
        tsEnc.push({ tick: e.tick, ord: -9, bytes: [0xff, 0x58, 0x04, num & 0xff, dd & 0xff, cc, bb] });
      } else if (e.type === "meta.keySignature") {
        const sf = (e.sf|0) & 0xff; // signed stored in byte
        const mi = (e.mi|0) & 0xff;
        ksEnc.push({ tick: e.tick, ord: -8, bytes: [0xff, 0x59, 0x02, sf, mi] });
      }
    }
  }

  let trackChunks: Uint8Array[] = [];
  if (format === 0) {
    // merge all tracks into single track (include tempo)
    let merged: EncEvent[] = [];
    merged.push(...tempoEnc);
    for (let i = 0; i < song.tracks.length; i++) merged.push(...makeEncEventsForTrack(i));
    trackChunks.push(buildTrackChunk(merged));
  } else {
    // format 1: first track gets global metas + its own events
    for (let i = 0; i < song.tracks.length; i++) {
      const own = makeEncEventsForTrack(i);
      if (i === 0 && (tempoEnc.length > 0 || tsEnc.length > 0 || ksEnc.length > 0)) {
        trackChunks.push(buildTrackChunk([...tempoEnc, ...tsEnc, ...ksEnc, ...own]));
      } else {
        trackChunks.push(buildTrackChunk(own));
      }
    }
    if (song.tracks.length === 0) {
      // empty safeguard track
      trackChunks.push(buildTrackChunk([]));
    }
  }

  const ntrks = trackChunks.length;
  const header = new Uint8Array(14);
  header.set([0x4d,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, (format>>8)&0xff, format&0xff, (ntrks>>8)&0xff, ntrks&0xff, (ppq>>8)&0xff, ppq&0xff]);

  const totalLen = header.length + trackChunks.reduce((a,c)=>a+c.length,0);
  const out = new Uint8Array(totalLen);
  out.set(header, 0);
  let off = header.length;
  for (const trk of trackChunks) { out.set(trk, off); off += trk.length; }
  return out;
}
