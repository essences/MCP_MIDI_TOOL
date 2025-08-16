import { zSong, type JsonMidiSong } from "./jsonSchema.js";

export async function decodeSmfToJson(buf: Uint8Array | Buffer): Promise<JsonMidiSong> {
  const mod: any = await import("@tonejs/midi");
  const Midi = mod?.Midi || mod?.default?.Midi;
  if (!Midi) throw new Error("@tonejs/midi Midi class not found");
  const midi = new Midi(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));

  const ppq: number = Number(midi.header?.ppq) || 480;
  const format: 0 | 1 = 1;

  // Build tempo events on track 0
  const tempoEvents = (midi.header?.tempos || []).map((t: any) => ({
    type: "meta.tempo" as const,
    tick: Number(t.ticks) || 0,
    usPerQuarter: Math.max(1, Math.round(60000000 / (Number(t.bpm) || 120)))
  }));
  const tsEvents = (midi.header?.timeSignatures || []).map((ts: any) => {
    const tick = Number(ts.ticks) || 0;
    const arr = (ts.timeSignature || []) as number[];
    const numerator = Number(arr?.[0]) || 4;
    const denominator = Number(arr?.[1]) || 4;
    return { type: "meta.timeSignature" as const, tick, numerator, denominator };
  });
  // Key Signature events from header (fallback to per-track if header missing)
  const KEY_TO_SF_MAJOR: Record<string, number> = {
    "Cb": -7, "Gb": -6, "Db": -5, "Ab": -4, "Eb": -3, "Bb": -2, "F": -1,
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7,
  };
  const KEY_TO_SF_MINOR: Record<string, number> = {
    "Ab": -7, "Eb": -6, "Bb": -5, "F": -4, "C": -3, "G": -2, "D": -1,
    "A": 0, "E": 1, "B": 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7,
  };
  function normKey(k: any): string | undefined {
    if (!k) return undefined;
    const s = String(k).trim();
    // Normalize casing: first letter upper, rest as-is to preserve #/b
    return s.length ? (s[0].toUpperCase() + s.slice(1)) : undefined;
  }
  const headerKS = (midi.header?.keySignatures || []).map((ks: any) => {
    const tick = Number(ks.ticks) || 0;
    const key = normKey(ks.key);
    const scale = String(ks.scale || ks.mode || "major").toLowerCase();
    const mi = scale === "minor" ? 1 : 0;
    // Some implementations may provide sf directly
    let sf: number | undefined = Number.isFinite(Number((ks as any).sf)) ? Number((ks as any).sf) : undefined;
    if (!Number.isFinite(sf as number)) {
      const map = mi ? KEY_TO_SF_MINOR : KEY_TO_SF_MAJOR;
      sf = key && key in map ? map[key] : 0;
    }
    sf = Math.max(-7, Math.min(7, Math.round(sf!)));
    return { type: "meta.keySignature" as const, tick, sf, mi };
  });
  // Fallback search on tracks if header empty
  const trackKS = headerKS.length > 0 ? [] : ([] as any[]).concat(
    ...midi.tracks.map((tr: any) => (tr.keySignatures || []).map((ks: any) => {
      const tick = Number(ks.ticks) || 0;
      const key = normKey(ks.key);
      const scale = String(ks.scale || ks.mode || "major").toLowerCase();
      const mi = scale === "minor" ? 1 : 0;
      let sf: number | undefined = Number.isFinite(Number((ks as any).sf)) ? Number((ks as any).sf) : undefined;
      if (!Number.isFinite(sf as number)) {
        const map = mi ? KEY_TO_SF_MINOR : KEY_TO_SF_MAJOR;
        sf = key && key in map ? map[key] : 0;
      }
      sf = Math.max(-7, Math.min(7, Math.round(sf!)));
      return { type: "meta.keySignature" as const, tick, sf, mi };
    }))
  );
  const ksEvents = headerKS.length > 0 ? headerKS : trackKS;

  const tracks = midi.tracks.map((tr: any) => {
    const name: string | undefined = tr.name || undefined;
    const channel: number | undefined = Number.isFinite(Number(tr.channel)) ? Number(tr.channel) : undefined;
    const events: any[] = [];

    // Program change (put at tick 0 if known)
    const prog = Number.isFinite(Number(tr.instrument?.number)) ? Number(tr.instrument.number) : undefined;
    if (prog !== undefined) {
      events.push({ type: "program", tick: 0, program: Math.max(0, Math.min(127, prog)), ...(channel !== undefined ? { channel } : {}) });
    }

  // Notes
    function midiToName(m: number): string {
      const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;
      const n = Math.max(0, Math.min(127, Math.round(m)));
      const name = names[n % 12];
      const oct = Math.floor(n / 12) - 1; // MIDI: C-1=0
      return `${name}${oct}`;
    }
    for (const nt of (tr.notes || [])) {
      const tick = Math.max(0, Math.round(Number(nt.ticks) || 0));
      const duration = Math.max(1, Math.round(Number(nt.durationTicks) || 0));
      const pitch = Math.max(0, Math.min(127, Math.round(Number(nt.midi)))) as number;
      const velocity = Math.max(1, Math.min(127, Math.round(((Number(nt.velocity) || 0.7) * 127))));
      const ev: any = { type: "note", tick, pitch, note: midiToName(pitch), velocity, duration };
      if (channel !== undefined) ev.channel = channel;
      events.push(ev);
    }

    // Control Changes: controlChanges is a dict of controller -> event[]
    const ccDict = (tr as any).controlChanges || {};
    for (const [numStr, arr] of Object.entries(ccDict)) {
      const controller = Math.max(0, Math.min(127, Number(numStr) || 0));
      for (const cc of (arr as any[])) {
        const tick = Math.max(0, Math.round(Number((cc as any).ticks) || 0));
        let v = Number((cc as any).value);
        if (!Number.isFinite(v)) v = 0;
        // Tone's CC value may be 0..1; scale to 0..127 if so
        if (v >= 0 && v <= 1) v = Math.round(v * 127);
        const value = Math.max(0, Math.min(127, Math.round(v)));
        const ev: any = { type: "cc", tick, controller, value };
        if (channel !== undefined) ev.channel = channel;
        events.push(ev);
      }
    }

    // Pitch Bend (if available)
    for (const pb of (tr.pitchBends || [])) {
      const tick = Math.max(0, Math.round(Number(pb.ticks) || 0));
      const value14 = Math.max(0, Math.min(16383, Math.round(Number(pb.value) || 8192)));
      const value = value14 - 8192;
      const ev: any = { type: "pitchBend", tick, value };
      if (channel !== undefined) ev.channel = channel;
      events.push(ev);
    }

    // Marker and others if available
    for (const mk of (tr.markers || [])) {
      const tick = Math.max(0, Math.round(Number(mk.ticks) || 0));
      events.push({ type: "meta.marker", tick, text: String(mk.text || "").slice(0,128) });
    }

    // Track name as meta
    if (name) {
      events.unshift({ type: "meta.trackName", tick: 0, text: String(name).slice(0, 128) });
    }

    // Sort events by tick
    events.sort((a, b) => a.tick - b.tick);
    return { name, channel, events };
  });

  // Prepend tempo/timeSignature/keySignature events into first track if exists; else create one
  if (tempoEvents.length > 0 || tsEvents.length > 0 || ksEvents.length > 0) {
    if (tracks.length === 0) {
      tracks.push({ name: undefined, channel: undefined, events: [...tempoEvents, ...tsEvents, ...ksEvents] });
    } else {
      tracks[0]!.events.unshift(...tempoEvents, ...tsEvents, ...ksEvents);
      tracks[0]!.events.sort((a: any, b: any) => a.tick - b.tick);
    }
  }

  const song: JsonMidiSong = { format, ppq, tracks } as JsonMidiSong;
  const parsed = zSong.parse(song);
  return parsed;
}
