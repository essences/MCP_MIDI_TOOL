import { parseMidi } from 'midi-file';
import { zSong } from './jsonSchema.js';
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (pitch) => `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
// midi-file exposes text as byte-valued JS characters; our writer uses UTF-8.
const text = (value) => Buffer.from(value, 'latin1').toString('utf8').slice(0, 128);
/** Decode the event types represented by JsonMidiSong, retaining original SMF tracks.
 * NoteOff pairs FIFO within each track/channel/pitch. Unclosed notes end at track end;
 * unmatched NoteOff and SMF events outside the JSON schema are omitted.
 */
export async function decodeSmfToJson(buf) {
    let midi;
    try {
        midi = parseMidi(buf);
    }
    catch (error) {
        throw new Error(`Invalid SMF: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (midi.header.framesPerSecond !== undefined || midi.header.ticksPerFrame !== undefined)
        throw new Error('Unsupported SMF SMPTE time division; PPQ timing is required');
    if (midi.header.format !== 0 && midi.header.format !== 1)
        throw new Error(`Unsupported SMF format ${midi.header.format}; only formats 0 and 1 are supported`);
    const ppq = midi.header.ticksPerBeat;
    if (typeof ppq !== 'number' || !Number.isInteger(ppq) || ppq < 24 || ppq > 15360)
        throw new Error(`Unsupported SMF PPQ ${ppq}; JSON MIDI supports 24..15360`);
    const tracks = midi.tracks.map(track => {
        let tick = 0;
        let name;
        const events = [];
        const channels = new Set();
        const pending = new Map();
        for (const raw of track) {
            tick += raw.deltaTime;
            if (!Number.isSafeInteger(tick) || tick < 0)
                throw new Error('Invalid SMF event tick');
            const channel = 'channel' in raw ? raw.channel : undefined;
            if (channel !== undefined && !('meta' in raw))
                channels.add(channel);
            const key = 'noteNumber' in raw ? `${channel}:${raw.noteNumber}` : '';
            switch (raw.type) {
                case 'noteOn': {
                    if (raw.velocity === 0) {
                        const active = pending.get(key)?.shift();
                        if (active)
                            active.duration = Math.max(1, tick - active.tick);
                        break;
                    }
                    const event = { type: 'note', tick, channel, pitch: raw.noteNumber, note: noteName(raw.noteNumber), velocity: raw.velocity, duration: 1 };
                    events.push(event);
                    const queue = pending.get(key) || [];
                    queue.push(event);
                    pending.set(key, queue);
                    break;
                }
                case 'noteOff': {
                    const active = pending.get(key)?.shift();
                    if (active)
                        active.duration = Math.max(1, tick - active.tick);
                    break;
                }
                case 'controller':
                    events.push({ type: 'cc', tick, channel, controller: raw.controllerType, value: raw.value });
                    break;
                case 'programChange':
                    events.push({ type: 'program', tick, channel, program: raw.programNumber });
                    break;
                case 'pitchBend':
                    events.push({ type: 'pitchBend', tick, channel, value: raw.value });
                    break;
                case 'channelAftertouch':
                    events.push({ type: 'aftertouch.channel', tick, channel, pressure: raw.amount });
                    break;
                case 'noteAftertouch':
                    events.push({ type: 'aftertouch.poly', tick, channel, pitch: raw.noteNumber, pressure: raw.amount });
                    break;
                case 'setTempo':
                    events.push({ type: 'meta.tempo', tick, usPerQuarter: raw.microsecondsPerBeat });
                    break;
                case 'timeSignature':
                    events.push({ type: 'meta.timeSignature', tick, numerator: raw.numerator, denominator: raw.denominator });
                    break;
                case 'keySignature':
                    events.push({ type: 'meta.keySignature', tick, sf: raw.key, mi: raw.scale });
                    break;
                case 'marker':
                    events.push({ type: 'meta.marker', tick, text: text(raw.text) });
                    break;
                case 'trackName': {
                    const value = text(raw.text);
                    name ??= value;
                    events.push({ type: 'meta.trackName', tick, text: value });
                    break;
                }
            }
        }
        for (const queue of pending.values())
            for (const event of queue)
                event.duration = Math.max(1, tick - event.tick);
        return { ...(name === undefined ? {} : { name }), ...(channels.size === 1 ? { channel: [...channels][0] } : {}), events };
    });
    return zSong.parse({ format: midi.header.format, ppq, tracks });
}
