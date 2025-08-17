import { describe, it, expect } from "vitest";
import { compileScoreToJsonMidi } from "../src/scoreToJsonMidi.js";

describe("Score DSL → JSON MIDI v1 (advanced)", () => {
  it("supports tie merge and legato overlap clipping", () => {
    const score = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 }
      },
      tracks: [
        { channel: 0, program: 0, events: [
          { type: "note", note: "C4", start: { bar:1, beat:1 }, duration: { value: "1/4" } },
          // tieで直後に同pitchを連結（1/8）
          { type: "note", note: "C4", start: { bar:1, beat:2 }, duration: { value: "1/8" }, tie: true },
          // 次音（E4）で前音の伸長が食い込まないようクリップ
          { type: "note", note: "E4", start: { bar:1, beat:3 }, duration: { value: "1/4" }, articulation: "legato" },
        ]}
      ]
    };
    const json = compileScoreToJsonMidi(score);
    const t1 = json.tracks[1].events;
    const notes = t1.filter(e=> e.type === "note") as any[];
    expect(notes.length).toBe(2); // tieでC4は1つに結合
    // C4: 1/4(480)+1/8(240)=720, 次音開始tick=960なので最大 959 まで
    expect(notes[0].tick).toBe(0);
    expect(notes[0].pitch).toBe(60);
    expect(notes[0].duration).toBeLessThanOrEqual(959);
    // E4 legato は +10% で 480→528 だが次音なしなのでそのまま
    expect(notes[1]).toMatchObject({ tick: 960, pitch: 64, duration: 528 });
  });

  it("converts tempo changes and tuplets correctly", () => {
    const score = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "G", mode: "major" },
        tempo: { changes: [ { bar:1, beat:1, bpm: 120 }, { bar:2, beat:1, bpm: 90 } ] }
      },
      tracks: [
        { channel: 0, program: 0, events: [
          // 16分3連符（8分の空間に3つ）: base(1/16=120) → tuplet(2/3) → 80
          { type: "note", note: "G4", start: { bar:1, beat:1 }, duration: { value: "1/16", tuplet: { inSpaceOf: 2, play: 3 } } },
          { type: "note", note: "A4", start: { bar:1, beat:1, unit: 3, offset: 1 }, duration: { value: "1/16", tuplet: { inSpaceOf: 2, play: 3 } } },
          { type: "note", note: "B4", start: { bar:1, beat:1, unit: 3, offset: 2 }, duration: { value: "1/16", tuplet: { inSpaceOf: 2, play: 3 } } },
        ]}
      ]
    };
    const json = compileScoreToJsonMidi(score);
    // meta.tempo at bar1 beat1 (tick 0) and bar2 beat1 (tick 4/4 one bar = 1920)
    const t0 = json.tracks[0].events;
    const tempos = t0.filter(e=> e.type === "meta.tempo");
    expect(tempos.length).toBe(2);
    expect(tempos[0].tick).toBe(0);
    expect(tempos[1].tick).toBe(1920);
    // durations ~80 ticks for 16分3連
    const notes = json.tracks[1].events.filter(e=> e.type === "note") as any[];
    expect(notes).toHaveLength(3);
    for (const n of notes) expect(n.duration).toBeGreaterThanOrEqual(78);
    for (const n of notes) expect(n.duration).toBeLessThanOrEqual(82);
  });
});
