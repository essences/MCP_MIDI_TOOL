import { z } from "zod";
import { zScore, Score, DurationSpec, Position } from "./scoreSchema.js";

// Minimal Json MIDI v1 types (align with existing schema expectations)
export type JsonMidiEvent =
  | { type: "note"; tick: number; pitch: number; velocity: number; duration: number; channel?: number }
  | { type: "program"; tick: number; program: number; channel?: number }
  | { type: "cc"; tick: number; controller: number; value: number; channel?: number }
  | { type: "pitchBend"; tick: number; value: number; channel?: number }
  | { type: "meta.tempo"; tick: number; usPerQuarter: number }
  | { type: "meta.timeSignature"; tick: number; numerator: number; denominator: 1|2|4|8|16|32 }
  | { type: "meta.keySignature"; tick: number; sf: number; mi: 0|1 }
  | { type: "meta.marker"; tick: number; text: string }
  | { type: "meta.trackName"; tick: number; text: string };

export type JsonMidiTrack = { name?: string; channel?: number; events: JsonMidiEvent[] };
export type JsonMidiSong = { format: 1; ppq: number; tracks: JsonMidiTrack[] };

// --- helpers ---
const dynToVel: Record<string, number> = { pp: 32, p: 48, mp: 64, mf: 80, f: 96, ff: 112 };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const NOTE_MAP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  for (let midi=0; midi<=127; midi++) {
    const octave = Math.floor(midi/12)-1;
    const name = names[midi%12] + String(octave);
    map[name] = midi;
  }
  // add flats
  const enh: Record<string,string> = {"C#":"Db","D#":"Eb","F#":"Gb","G#":"Ab","A#":"Bb"};
  for (const [sharp, flat] of Object.entries(enh)) {
    for (let o=-1; o<=9; o++) {
      const m = map[sharp+o];
      if (m!==undefined) map[flat+o] = m;
    }
  }
  return map;
})();

function nameToMidi(note?: string): number | undefined {
  if (!note) return undefined;
  const key = note.toUpperCase().replace("B#","C").replace("E#","F");
  return NOTE_MAP[key] ?? NOTE_MAP[note];
}

function bpmToUsPerQuarter(bpm: number) { return Math.round(1_000_000 * 60 / bpm); }

function noteTicksFromNotation(ppq: number, value: string): number {
  switch (value) {
    case "1": return ppq*4;
    case "1/2": return ppq*2;
    case "1/4": return ppq;
    case "1/8": return Math.round(ppq/2);
    case "1/16": return Math.round(ppq/4);
    case "1/32": return Math.round(ppq/8);
    default: throw new Error("Unsupported notation value: "+value);
  }
}

function durationSpecToTicks(ppq: number, spec: DurationSpec): number {
  const dots = spec.dots ?? 0;
  let base = 0;
  if (typeof spec.value === "string") base = noteTicksFromNotation(ppq, spec.value);
  else {
    base = Math.round((ppq*4) * (spec.value.numerator / spec.value.denominator));
  }
  let factor = 1;
  if (dots===1) factor = 1.5; else if (dots===2) factor = 1.75;
  let ticks = Math.round(base * factor);
  if (spec.tuplet) ticks = Math.round(ticks * (spec.tuplet.inSpaceOf / spec.tuplet.play));
  return Math.max(1, ticks);
}

function positionToTick(ppq: number, pos: Position, numerator: number, denominator: 1|2|4|8|16): number {
  const beatTicks = Math.round(ppq * (4/denominator));
  const barTicks = beatTicks * numerator;
  const offset = pos.unit && pos.offset ? Math.round((beatTicks / pos.unit) * pos.offset) : 0;
  const barIndex = Math.max(0, pos.bar-1);
  const beatIndex = Math.max(0, pos.beat-1);
  return barIndex*barTicks + beatIndex*beatTicks + offset;
}

function ksToSfMi(root: string, mode: "major"|"minor"): { sf: number, mi: 0|1 } {
  const order = ["Cb","Gb","Db","Ab","Eb","Bb","F","C","G","D","A","E","B","F#","C#"];
  const sfMap: Record<string, number> = { Cb:-7,Gb:-6,Db:-5,Ab:-4,Eb:-3,Bb:-2,F:-1,C:0,G:1,D:2,A:3,E:4,B:5, "F#":6, "C#":7 };
  let sf = sfMap[root] ?? 0;
  if (mode === "minor") {
    // relative minor is -3 steps in circle; approximate using major table minus 3 accidentals
    // More precise mapping can be added later
    sf = clamp(sf - 3, -7, 7);
  }
  return { sf, mi: mode === "minor" ? 1 : 0 } as const;
}

export function compileScoreToJsonMidi(input: unknown): JsonMidiSong {
  const parsed = zScore.parse(input) as Score;
  const { ppq, meta } = parsed;
  const num = meta.timeSignature.numerator;
  const den = meta.timeSignature.denominator as 1|2|4|8|16;

  const track0: JsonMidiTrack = { events: [] };
  track0.events.push({ type: "meta.timeSignature", tick: 0, numerator: num, denominator: den });
  const ks = ksToSfMi(meta.keySignature.root, meta.keySignature.mode);
  track0.events.push({ type: "meta.keySignature", tick: 0, sf: ks.sf, mi: ks.mi });
  if ("bpm" in meta.tempo) {
    track0.events.push({ type: "meta.tempo", tick: 0, usPerQuarter: bpmToUsPerQuarter(meta.tempo.bpm) });
  } else {
    for (const ch of meta.tempo.changes) {
      const t = positionToTick(ppq, { bar: ch.bar, beat: ch.beat }, num, den);
      track0.events.push({ type: "meta.tempo", tick: t, usPerQuarter: bpmToUsPerQuarter(ch.bpm) });
    }
  }
  if (meta.title) track0.events.push({ type: "meta.trackName", tick: 0, text: meta.title });

  const tracks: JsonMidiTrack[] = [track0];

  for (const st of parsed.tracks) {
    const t: JsonMidiTrack = { name: st.name, events: [] };
    if (st.name) t.events.push({ type: "meta.trackName", tick: 0, text: st.name });
    t.events.push({ type: "program", tick: 0, program: st.program, channel: st.channel });

    // materialize notes
    type TmpNote = { pitch: number; startTick: number; durTicks: number; velocity: number; articulation?: string; dynamic?: string; tie?: boolean; slur?: boolean };
    const tmp: TmpNote[] = [];

    for (const ev of st.events) {
      if (ev.type === "note") {
        const pitch = typeof ev.pitch === "number" ? ev.pitch : nameToMidi(ev.note);
        if (pitch === undefined) throw new Error("Note pitch unresolved");
        const startTick = positionToTick(ppq, ev.start, num, den);
        const dur = durationSpecToTicks(ppq, ev.duration);
        let velocity = ev.velocity ?? (ev.dynamic ? dynToVel[ev.dynamic] ?? 80 : 80);
        if (ev.articulation === "accent") velocity = clamp(velocity + 15, 1, 127);
        if (ev.articulation === "marcato") velocity = clamp(velocity + 25, 1, 127);
        tmp.push({ pitch, startTick, durTicks: dur, velocity, articulation: ev.articulation, dynamic: ev.dynamic, tie: ev.tie, slur: ev.slur });
      } else if (ev.type === "marker" || ev.type === "trackName") {
        const tick = positionToTick(ppq, ev.at, num, den);
        t.events.push({ type: ev.type === "marker" ? "meta.marker" : "meta.trackName", tick, text: ev.text } as any);
      } else if (ev.type === "cc") {
        const tick = positionToTick(ppq, ev.at, num, den);
        if (typeof ev.cc !== "number" || typeof ev.value !== "number") continue;
        t.events.push({ type: "cc", tick, controller: ev.cc, value: ev.value, channel: st.channel });
      } else if (ev.type === "pitchBend") {
        const tick = positionToTick(ppq, ev.at, num, den);
        if (typeof ev.bend !== "number") continue;
        t.events.push({ type: "pitchBend", tick, value: ev.bend, channel: st.channel });
      }
    }

    // sort by startTick, then pitch
    tmp.sort((a,b)=> a.startTick - b.startTick || a.pitch - b.pitch);

    // tie merge: extend previous if same pitch and contiguous/overlapping
    const merged: TmpNote[] = [];
    for (const n of tmp) {
      const last = merged[merged.length-1];
      if (last && n.tie && last.pitch === n.pitch && n.startTick <= (last.startTick + last.durTicks + 1)) {
        last.durTicks = Math.max(last.durTicks, (n.startTick + n.durTicks) - last.startTick);
      } else {
        merged.push({...n});
      }
    }

    // apply articulations affecting duration and legato overlap
    for (let i=0; i<merged.length; i++) {
      const n = merged[i];
      const next = merged[i+1];
      if (n.articulation === "staccato") n.durTicks = Math.max(1, Math.round(n.durTicks * 0.5));
      if (n.articulation === "tenuto") n.durTicks = Math.max(1, Math.round(n.durTicks * 1.05));
      if (n.articulation === "legato" || n.slur) {
        const overlap = Math.max(5, Math.round(n.durTicks * 0.1));
        n.durTicks += overlap;
      }
      if (next) {
        const maxEnd = next.startTick - 1;
        const end = n.startTick + n.durTicks;
        if (end > maxEnd) n.durTicks = Math.max(1, maxEnd - n.startTick);
      }
    }

    for (const n of merged) {
      t.events.push({ type: "note", tick: n.startTick, pitch: n.pitch, velocity: n.velocity, duration: n.durTicks, channel: st.channel });
    }

    // autoCcPresets: sustain_from_slur（slur/legatoの持続区間にCC64 on/off）
    if (meta.autoCcPresets?.some(p => p.id === "sustain_from_slur")) {
      // 連続した slur or articulation==="legato" のノートをまとめて区間化
      type Seg = { start: number; end: number };
      const segs: Seg[] = [];
      let cur: Seg | null = null;
      for (let i=0; i<merged.length; i++) {
        const n = merged[i];
        const isLeg = n.slur || n.articulation === "legato";
        const nStart = n.startTick;
        const nEnd = n.startTick + n.durTicks;
        if (isLeg) {
          if (!cur) cur = { start: nStart, end: nEnd };
          else cur.end = Math.max(cur.end, nEnd);
        } else {
          if (cur) { segs.push(cur); cur = null; }
        }
      }
      if (cur) segs.push(cur);

      for (const s of segs) {
        t.events.push({ type: "cc", tick: s.start, controller: 64, value: 127, channel: st.channel });
        t.events.push({ type: "cc", tick: s.end, controller: 64, value: 0, channel: st.channel });
      }
    }

    tracks.push(t);
  }

  const song: JsonMidiSong = { format: 1, ppq, tracks };
  return song;
}
