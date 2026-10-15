function writeUint32BE(n) {
    const b = new Uint8Array(4);
    b[0] = (n >>> 24) & 0xff;
    b[1] = (n >>> 16) & 0xff;
    b[2] = (n >>> 8) & 0xff;
    b[3] = n & 0xff;
    return b;
}
function writeVarLen(n) {
    // MIDI variable length quantity
    let buffer = n & 0x7f;
    const bytes = [];
    while ((n >>= 7)) {
        buffer <<= 8;
        buffer |= ((n & 0x7f) | 0x80);
    }
    // unfold
    while (true) {
        bytes.push(buffer & 0xff);
        if (buffer & 0x80)
            buffer >>= 8;
        else
            break;
    }
    return bytes;
}
function textToBytes(s) {
    return Array.from(new TextEncoder().encode(s));
}
function buildTrackBody(events) {
    events.sort((a, b) => a.tick - b.tick || a.ord - b.ord);
    let lastTick = 0;
    const out = [];
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
function buildTrackChunk(events) {
    const body = buildTrackBody(events);
    const len = body.length;
    const chunk = new Uint8Array(4 + 4 + len);
    chunk.set([0x4d, 0x54, 0x72, 0x6b], 0);
    chunk.set(writeUint32BE(len), 4);
    chunk.set(body, 8);
    return chunk;
}
export function encodeToSmfBinary(song) {
    const ppq = song.ppq ?? 480;
    if (song.format !== undefined && song.format !== 0 && song.format !== 1)
        throw new Error("Unsupported SMF format; expected 0 or 1");
    if (!Number.isInteger(ppq) || ppq < 24 || ppq > 15360)
        throw new Error("Unsupported SMF PPQ; expected 24..15360");
    const format = (song.format === 0 ? 0 : 1);
    // 音名→MIDIノート番号（C4=60基準）
    const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    function nameToMidi(n) {
        if (!n)
            return undefined;
        const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(n.trim());
        if (!m)
            return undefined;
        let [_, L, acc, octStr] = m;
        const letter = L.toUpperCase();
        const base = NOTE_BASE[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
        if (base === undefined)
            return undefined;
        const oct = Number(octStr);
        if (!Number.isFinite(oct))
            return undefined;
        const midi = base + (oct + 1) * 12; // MIDI: C-1=0 → C4(=60)
        return (midi >= 0 && midi <= 127) ? midi : undefined;
    }
    // Prepare per-track EncEvent lists
    const makeEncEventsForTrack = (trackIndex) => {
        const tr = song.tracks[trackIndex];
        const chDefault = Number.isFinite(Number(tr.channel)) ? tr.channel : undefined;
        const enc = [];
        // track name meta at tick of the earliest event (default 0)
        if (tr.name && !tr.events.some(e => e.type === "meta.trackName")) {
            const nameBytes = textToBytes(String(tr.name).slice(0, 128));
            enc.push({ tick: 0, ord: 0, bytes: [0xff, 0x03, ...writeVarLen(nameBytes.length), ...nameBytes] });
        }
        for (const e of tr.events) {
            if (e.type === "meta.tempo") {
                const uspq = Math.max(1, e.usPerQuarter | 0);
                enc.push({ tick: e.tick, ord: -10, bytes: [0xff, 0x51, 3, (uspq >>> 16) & 255, (uspq >>> 8) & 255, uspq & 255] });
                continue;
            }
            if (e.type === "program") {
                const ch = Number.isFinite(Number(e.channel)) ? e.channel : (chDefault ?? 0);
                const prog = Math.max(0, Math.min(127, e.program | 0));
                enc.push({ tick: e.tick, ord: 10, bytes: [0xc0 | (ch & 0x0f), prog] });
                continue;
            }
            if (e.type === "cc") {
                const ch = Number.isFinite(Number(e.channel)) ? e.channel : (chDefault ?? 0);
                const ctrl = Math.max(0, Math.min(127, e.controller | 0));
                const val = Math.max(0, Math.min(127, e.value | 0));
                enc.push({ tick: e.tick, ord: 20, bytes: [0xb0 | (ch & 0x0f), ctrl, val] });
                continue;
            }
            if (e.type === "pitchBend") {
                const ch = Number.isFinite(Number(e.channel)) ? e.channel : (chDefault ?? 0);
                const v14 = Math.max(-8192, Math.min(8191, e.value | 0)) + 8192; // 0..16383
                const lsb = v14 & 0x7f, msb = (v14 >> 7) & 0x7f;
                enc.push({ tick: e.tick, ord: 30, bytes: [0xe0 | (ch & 0x0f), lsb, msb] });
                continue;
            }
            if (e.type === "aftertouch.channel" || e.type === "aftertouch.poly") {
                const ch = e.channel ?? chDefault ?? 0;
                const pressure = Math.max(0, Math.min(127, e.pressure | 0));
                const bytes = e.type === "aftertouch.channel" ? [0xd0 | (ch & 15), pressure] : [0xa0 | (ch & 15), Math.max(0, Math.min(127, e.pitch | 0)), pressure];
                enc.push({ tick: e.tick, ord: 40, bytes });
                continue;
            }
            if (e.type === "note") {
                const ch = Number.isFinite(Number(e.channel)) ? e.channel : (chDefault ?? 0);
                const nRaw = e.pitch ?? nameToMidi(e.note);
                if (nRaw === undefined || !Number.isFinite(Number(nRaw)))
                    throw new Error("Note requires a valid pitch or note name");
                const n = Math.max(0, Math.min(127, Number(nRaw) | 0));
                const v = Math.max(1, Math.min(127, e.velocity | 0));
                const tOn = e.tick | 0;
                const tOff = Math.max(tOn, tOn + (e.duration | 0));
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
                const dd = Math.round(Math.log2(e.denominator));
                enc.push({ tick: e.tick, ord: -9, bytes: [0xff, 0x58, 4, e.numerator & 255, dd, 24, 8] });
                continue;
            }
            if (e.type === "meta.keySignature") {
                enc.push({ tick: e.tick, ord: -8, bytes: [0xff, 0x59, 2, e.sf & 255, e.mi & 255] });
                continue;
            }
            // unimplemented types are ignored for now (future work)
        }
        return enc;
    };
    // Preserve metadata in each original track. Format 0 explicitly merges all tracks.
    const trackChunks = [];
    if (format === 0) {
        const merged = [];
        for (let i = 0; i < song.tracks.length; i++)
            merged.push(...makeEncEventsForTrack(i));
        trackChunks.push(buildTrackChunk(merged));
    }
    else {
        for (let i = 0; i < song.tracks.length; i++)
            trackChunks.push(buildTrackChunk(makeEncEventsForTrack(i)));
        if (!trackChunks.length)
            trackChunks.push(buildTrackChunk([]));
    }
    const ntrks = trackChunks.length;
    const header = new Uint8Array(14);
    header.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, (format >> 8) & 0xff, format & 0xff, (ntrks >> 8) & 0xff, ntrks & 0xff, (ppq >> 8) & 0xff, ppq & 0xff]);
    const totalLen = header.length + trackChunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(totalLen);
    out.set(header, 0);
    let off = header.length;
    for (const trk of trackChunks) {
        out.set(trk, off);
        off += trk.length;
    }
    return out;
}
