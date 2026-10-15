import { zSong, type JsonMidiSong } from './jsonSchema.js';
export interface PlaybackEvent { tMs: number; bytes: number[]; kind: 'on' | 'off' | 'state'; ch: number; n?: number; v?: number }
export interface PlaybackPlan { events: PlaybackEvent[]; totalDurationMs: number; scheduledEvents: number; extractionMode: 'simple' | 'precise'; debug?: { extracted?: any }; warnings: string[] }
export interface PlaybackPlanOptions { startBar?: number; endBar?: number; startMs?: number; stopMs?: number }
function pitch(event: { pitch?: number; note?: string }): number {
  if (event.pitch !== undefined) return event.pitch;
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(event.note || '');
  if (!match) throw new Error('Note requires pitch or note name');
  const n = (Number(match[3]) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()]!) + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
  if (n < 0 || n > 127) throw new Error('Note name is outside MIDI range');
  return n;
}
export function buildPlaybackPlan(input: JsonMidiSong, options: PlaybackPlanOptions = {}): PlaybackPlan {
  const song = zSong.parse(input);
  for (const [key, value] of Object.entries(options)) {
    if (!['startBar', 'endBar', 'startMs', 'stopMs'].includes(key)) throw new Error(`Unknown playback range: ${key}`);
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < (key.endsWith('Bar') ? 1 : 0) || (key.endsWith('Bar') && !Number.isInteger(value)))) throw new Error(`Invalid ${key}`);
  }
  if ((options.startBar !== undefined || options.endBar !== undefined) && (options.startMs !== undefined || options.stopMs !== undefined)) throw new Error('Choose bar range or millisecond range');
  const all = song.tracks.flatMap((track, trackIndex) => track.events.map(event => ({ event, trackIndex, ch: event.type.startsWith('meta.') ? 0 : ('channel' in event ? event.channel : undefined) ?? track.channel ?? 0 }))).sort((a, b) => a.event.tick - b.event.tick);
  const tempos: { tick: number; ms: number; tempo: number }[] = [{ tick: 0, ms: 0, tempo: 500000 }];
  for (const { event } of all) if (event.type === 'meta.tempo') {
    const last = tempos[tempos.length - 1];
    const point = { tick: event.tick, ms: last.ms + (event.tick - last.tick) * last.tempo / song.ppq / 1000, tempo: event.usPerQuarter };
    if (last.tick === point.tick) tempos[tempos.length - 1] = point; else tempos.push(point);
  }
  const tickMs = (tick: number) => { const point = [...tempos].reverse().find(point => point.tick <= tick)!; return point.ms + (tick - point.tick) * point.tempo / song.ppq / 1000; };
  const msTick = (ms: number) => { const point = [...tempos].reverse().find(point => point.ms <= ms)!; return point.tick + (ms - point.ms) * song.ppq * 1000 / point.tempo; };
  const signatures: { tick: number; bar: number; length: number }[] = [{ tick: 0, bar: 1, length: song.ppq * 4 }];
  for (const { event } of all) if (event.type === 'meta.timeSignature') {
    const last = signatures[signatures.length - 1];
    const bars = (event.tick - last.tick) / last.length;
    if (!Number.isInteger(bars) && (options.startBar !== undefined || options.endBar !== undefined)) throw new Error('Time signature change must occur at a bar boundary');
    const point = { tick: event.tick, bar: last.bar + bars, length: song.ppq * event.numerator * 4 / event.denominator };
    if (event.tick === last.tick) signatures[signatures.length - 1] = point; else signatures.push(point);
  }
  const barTick = (bar: number) => { const point = [...signatures].reverse().find(point => point.bar <= bar)!; return point.tick + (bar - point.bar) * point.length; };
  const songEndTick = all.reduce((end, { event }) => Math.max(end, event.tick + (event.type === 'note' ? event.duration : 0)), 0);
  const bars = options.startBar !== undefined || options.endBar !== undefined;
  const startTick = bars ? barTick(options.startBar ?? 1) : msTick(options.startMs ?? 0);
  const endTick = bars ? barTick((options.endBar ?? options.startBar ?? 1) + 1) : options.stopMs === undefined ? songEndTick : msTick(options.stopMs);
  if (endTick < startTick || ((bars || options.stopMs !== undefined) && endTick === startTick)) throw new Error('Playback range end must follow start');
  const includeEndState = !bars && options.stopMs === undefined;
  const inRange = (tick: number) => tick >= startTick && (tick < endTick || (includeEndState && tick === endTick));
  const start = tickMs(startTick), end = tickMs(endTick);
  const events: PlaybackEvent[] = [];
  const seeded = new Map<string, PlaybackEvent>();
  const extracted: any = { ...song, tracks: song.tracks.map(track => ({ ...track, events: [] })) };
  for (const { event, ch, trackIndex } of all) {
    if (event.type === 'note') {
      const n = pitch(event);
      const finish = event.tick + event.duration;
      if (event.tick >= endTick || finish <= startTick) continue;
      const from = Math.max(event.tick, startTick), to = Math.min(finish, endTick);
      events.push({ tMs: tickMs(from) - start, bytes: [0x90 | ch, n, event.velocity], kind: 'on', ch, n, v: event.velocity });
      events.push({ tMs: tickMs(to) - start, bytes: [0x80 | ch, n, 0], kind: 'off', ch, n, v: 0 });
      extracted.tracks[trackIndex].events.push({ ...event, tick: from - startTick, duration: to - from });
      continue;
    }
    let bytes: number[] | undefined, key = `${ch}:${event.type}`;
    switch (event.type) {
      case 'cc': bytes = [0xb0 | ch, event.controller, event.value]; key += `:${event.controller}`; break;
      case 'program': bytes = [0xc0 | ch, event.program]; break;
      case 'pitchBend': { const value = event.value + 8192; bytes = [0xe0 | ch, value & 127, value >> 7]; break; }
      case 'aftertouch.channel': bytes = [0xd0 | ch, event.pressure]; break;
      case 'aftertouch.poly': bytes = [0xa0 | ch, event.pitch, event.pressure]; key += `:${event.pitch}`; break;
    }
    if (inRange(event.tick)) extracted.tracks[trackIndex].events.push({ ...event, tick: event.tick - startTick });
    if (bytes) {
      const planned: PlaybackEvent = { tMs: Math.max(0, tickMs(event.tick) - start), bytes, kind: 'state', ch };
      if (event.tick < startTick) seeded.set(key, planned);
      else if (inRange(event.tick)) events.push(planned);
    }
  }
  events.unshift(...seeded.values());
  const rank = { off: 0, state: 1, on: 2 };
  events.sort((a, b) => a.tMs - b.tMs || rank[a.kind] - rank[b.kind]);
  return { events, totalDurationMs: Math.max(0, end - start), scheduledEvents: events.length, extractionMode: bars ? 'precise' : 'simple', debug: { extracted }, warnings: [] };
}
