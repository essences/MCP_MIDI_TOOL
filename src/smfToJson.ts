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
