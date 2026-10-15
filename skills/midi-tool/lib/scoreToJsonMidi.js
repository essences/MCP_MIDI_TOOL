import { zScore } from "./scoreSchema.js";
// --- helpers ---
const dynToVel = { pp: 32, p: 48, mp: 64, mf: 80, f: 96, ff: 112 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const NOTE_MAP = (() => {
    const map = {};
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    for (let midi = 0; midi <= 127; midi++) {
        const octave = Math.floor(midi / 12) - 1;
        const name = names[midi % 12] + String(octave);
        map[name] = midi;
    }
    // add flats
    const enh = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
    for (const [sharp, flat] of Object.entries(enh)) {
        for (let o = -1; o <= 9; o++) {
            const m = map[sharp + o];
            if (m !== undefined)
                map[flat + o] = m;
        }
    }
    return map;
})();
function nameToMidi(note) {
    if (!note)
        return undefined;
    const key = note.toUpperCase().replace("B#", "C").replace("E#", "F");
    return NOTE_MAP[key] ?? NOTE_MAP[note];
}
function bpmToUsPerQuarter(bpm) { return Math.round(1_000_000 * 60 / bpm); }
function noteTicksFromNotation(ppq, value) {
    switch (value) {
        case "1": return ppq * 4;
        case "1/2": return ppq * 2;
        case "1/4": return ppq;
        case "1/8": return Math.round(ppq / 2);
        case "1/16": return Math.round(ppq / 4);
        case "1/32": return Math.round(ppq / 8);
        default: throw new Error("Unsupported notation value: " + value);
    }
}
function durationSpecToTicks(ppq, spec) {
    const dots = spec.dots ?? 0;
    let base = 0;
    if (typeof spec.value === "string")
        base = noteTicksFromNotation(ppq, spec.value);
    else {
        base = Math.round((ppq * 4) * (spec.value.numerator / spec.value.denominator));
    }
    let factor = 1;
    if (dots === 1)
        factor = 1.5;
    else if (dots === 2)
        factor = 1.75;
    let ticks = Math.round(base * factor);
    if (spec.tuplet)
        ticks = Math.round(ticks * (spec.tuplet.inSpaceOf / spec.tuplet.play));
    return Math.max(1, ticks);
}
function positionToTick(ppq, pos, numerator, denominator) {
    const beatTicks = Math.round(ppq * (4 / denominator));
    const barTicks = beatTicks * numerator;
    const offset = pos.unit && pos.offset ? Math.round((beatTicks / pos.unit) * pos.offset) : 0;
    const barIndex = Math.max(0, pos.bar - 1);
    const beatIndex = Math.max(0, pos.beat - 1);
    return barIndex * barTicks + beatIndex * beatTicks + offset;
}
function ksToSfMi(root, mode) {
    const order = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    const sfMap = { Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7 };
    let sf = sfMap[root] ?? 0;
    if (mode === "minor") {
        // relative minor is -3 steps in circle; approximate using major table minus 3 accidentals
        // More precise mapping can be added later
        sf = clamp(sf - 3, -7, 7);
    }
    return { sf, mi: mode === "minor" ? 1 : 0 };
}
export function compileScoreToJsonMidi(input) {
    const parsed = zScore.parse(input);
    const { ppq, meta } = parsed;
    const num = meta.timeSignature.numerator;
    const den = meta.timeSignature.denominator;
    const track0 = { events: [] };
    track0.events.push({ type: "meta.timeSignature", tick: 0, numerator: num, denominator: den });
    const ks = ksToSfMi(meta.keySignature.root, meta.keySignature.mode);
    track0.events.push({ type: "meta.keySignature", tick: 0, sf: ks.sf, mi: ks.mi });
    if ("bpm" in meta.tempo) {
        track0.events.push({ type: "meta.tempo", tick: 0, usPerQuarter: bpmToUsPerQuarter(meta.tempo.bpm) });
    }
    else {
        for (const ch of meta.tempo.changes) {
            const t = positionToTick(ppq, { bar: ch.bar, beat: ch.beat }, num, den);
            track0.events.push({ type: "meta.tempo", tick: t, usPerQuarter: bpmToUsPerQuarter(ch.bpm) });
        }
    }
    if (meta.title)
        track0.events.push({ type: "meta.trackName", tick: 0, text: meta.title });
    const tracks = [track0];
    for (const st of parsed.tracks) {
        const t = { name: st.name, events: [] };
        if (st.name)
            t.events.push({ type: "meta.trackName", tick: 0, text: st.name });
        // チャンネル変換: 外部表記1-16 → 内部表記0-15
        const internalChannel = st.channel - 1;
        t.events.push({ type: "program", tick: 0, program: st.program, channel: internalChannel });
        const tmp = [];
        for (const ev of st.events) {
            if (ev.type === "note") {
                const pitch = typeof ev.pitch === "number" ? ev.pitch : nameToMidi(ev.note);
                if (pitch === undefined)
                    throw new Error("Note pitch unresolved");
                const startTick = positionToTick(ppq, ev.start, num, den);
                const dur = durationSpecToTicks(ppq, ev.duration);
                let velocity = ev.velocity ?? (ev.dynamic ? dynToVel[ev.dynamic] ?? 80 : 80);
                if (ev.articulation === "accent")
                    velocity = clamp(velocity + 15, 1, 127);
                if (ev.articulation === "marcato")
                    velocity = clamp(velocity + 25, 1, 127);
                tmp.push({ pitch, startTick, durTicks: dur, velocity, articulation: ev.articulation, dynamic: ev.dynamic, tie: ev.tie, slur: ev.slur });
            }
            else if (ev.type === "marker" || ev.type === "trackName") {
                const tick = positionToTick(ppq, ev.at, num, den);
                t.events.push({ type: ev.type === "marker" ? "meta.marker" : "meta.trackName", tick, text: ev.text });
            }
            else if (ev.type === "cc") {
                const tick = positionToTick(ppq, ev.at, num, den);
                if (typeof ev.cc !== "number" || typeof ev.value !== "number")
                    continue;
                t.events.push({ type: "cc", tick, controller: ev.cc, value: ev.value, channel: internalChannel });
            }
            else if (ev.type === "pitchBend") {
                const tick = positionToTick(ppq, ev.at, num, den);
                if (typeof ev.bend !== "number")
                    continue;
                t.events.push({ type: "pitchBend", tick, value: ev.bend, channel: internalChannel });
            }
        }
        // sort by startTick, then pitch
        tmp.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
        // tie merge: extend previous if same pitch and contiguous/overlapping
        const merged = [];
        for (const n of tmp) {
            const last = merged[merged.length - 1];
            if (last && n.tie && last.pitch === n.pitch && n.startTick <= (last.startTick + last.durTicks + 1)) {
                last.durTicks = Math.max(last.durTicks, (n.startTick + n.durTicks) - last.startTick);
            }
            else {
                merged.push({ ...n });
            }
        }
        // apply articulations affecting duration and legato overlap
        for (let i = 0; i < merged.length; i++) {
            const n = merged[i];
            const next = merged[i + 1];
            if (n.articulation === "staccato")
                n.durTicks = Math.max(1, Math.round(n.durTicks * 0.5));
            if (n.articulation === "tenuto")
                n.durTicks = Math.max(1, Math.round(n.durTicks * 1.05));
            if (n.articulation === "legato" || n.slur) {
                const overlap = Math.max(5, Math.round(n.durTicks * 0.1));
                n.durTicks += overlap;
            }
            if (next) {
                const maxEnd = next.startTick - 1;
                const end = n.startTick + n.durTicks;
                if (end > maxEnd)
                    n.durTicks = Math.max(1, maxEnd - n.startTick);
            }
        }
        for (const n of merged) {
            t.events.push({ type: "note", tick: n.startTick, pitch: n.pitch, velocity: n.velocity, duration: n.durTicks, channel: internalChannel });
        }
        // autoCcPresets: sustain_from_slur（slur/legatoの持続区間にCC64 on/off）
        if (meta.autoCcPresets?.some(p => p.id === "sustain_from_slur")) {
            const segs = [];
            let cur = null;
            for (let i = 0; i < merged.length; i++) {
                const n = merged[i];
                const isLeg = n.slur || n.articulation === "legato";
                const nStart = n.startTick;
                const nEnd = n.startTick + n.durTicks;
                if (isLeg) {
                    if (!cur)
                        cur = { start: nStart, end: nEnd };
                    else
                        cur.end = Math.max(cur.end, nEnd);
                }
                else {
                    if (cur) {
                        segs.push(cur);
                        cur = null;
                    }
                }
            }
            if (cur)
                segs.push(cur);
            for (const s of segs) {
                t.events.push({ type: "cc", tick: s.start, controller: 64, value: 127, channel: internalChannel });
                t.events.push({ type: "cc", tick: s.end, controller: 64, value: 0, channel: internalChannel });
            }
        }
        // autoCcPresets: crescendo_to_expression（dynamic変化に合わせてCC11をランプ）
        if (meta.autoCcPresets?.some(p => p.id === "crescendo_to_expression")) {
            const dynToVal = (d) => {
                if (!d)
                    return undefined;
                const v = dynToVel[d];
                return typeof v === 'number' ? clamp(Math.round(v), 1, 127) : undefined;
            };
            const pts = [];
            let lastVal;
            for (const n of merged) {
                const v = dynToVal(n.dynamic);
                if (v !== undefined) {
                    if (lastVal === undefined || v !== lastVal) {
                        pts.push({ tick: n.startTick, value: v });
                        lastVal = v;
                    }
                }
            }
            // 少なくとも2点必要（区間がないとランプ不可）
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i];
                const b = pts[i + 1];
                if (b.tick <= a.tick)
                    continue;
                // a→b を線形補間: 端点 + 中間をppq/4ごと（粗すぎるとイベント過多、細すぎない程度）
                const start = a.tick;
                const end = b.tick;
                const span = end - start;
                const step = Math.max(1, Math.round(ppq / 4));
                const emit = (tk, val) => t.events.push({ type: "cc", tick: tk, controller: 11, value: clamp(Math.round(val), 0, 127), channel: internalChannel });
                emit(start, a.value);
                for (let tk = start + step; tk < end; tk += step) {
                    const ratio = (tk - start) / span;
                    const val = a.value + (b.value - a.value) * ratio;
                    emit(tk, val);
                }
                emit(end, b.value);
            }
        }
        tracks.push(t);
    }
    const song = { format: 1, ppq, tracks };
    return song;
}
