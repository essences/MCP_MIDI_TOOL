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
    for (const nt of (tr.notes || [])) {
      const tick = Math.max(0, Math.round(Number(nt.ticks) || 0));
      const duration = Math.max(1, Math.round(Number(nt.durationTicks) || 0));
      const pitch = Math.max(0, Math.min(127, Math.round(Number(nt.midi)))) as number;
      const velocity = Math.max(1, Math.min(127, Math.round(((Number(nt.velocity) || 0.7) * 127))));
      const ev: any = { type: "note", tick, pitch, velocity, duration };
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

  // Prepend tempo events into first track if exists; else create one
  if (tempoEvents.length > 0) {
    if (tracks.length === 0) {
      tracks.push({ name: undefined, channel: undefined, events: [...tempoEvents] });
    } else {
      tracks[0]!.events.unshift(...tempoEvents);
      tracks[0]!.events.sort((a: any, b: any) => a.tick - b.tick);
    }
  }

  const song: JsonMidiSong = { format, ppq, tracks } as JsonMidiSong;
  const parsed = zSong.parse(song);
  return parsed;
}
