import { describe, it, expect } from "vitest";
import { compileScoreToJsonMidi } from "../src/scoreToJsonMidi.js";

describe("Score DSL → JSON MIDI v1", () => {
  it("compiles meta and basic notes with articulations", () => {
    const score = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 },
        title: "DSL Demo"
      },
      tracks: [
        {
          name: "Lead",
          channel: 0,
          program: 0,
          events: [
            { type: "note", note: "C4", start: { bar:1, beat:1 }, duration: { value: "1/4" }, articulation: "staccato", velocity: 100 },
            { type: "note", note: "D4", start: { bar:1, beat:2 }, duration: { value: "1/8", dots: 1 }, articulation: "accent", velocity: 90 },
            { type: "note", note: "E4", start: { bar:1, beat:3 }, duration: { value: "1/8", tuplet: { inSpaceOf: 2, play: 3 } }, slur: true, velocity: 80 },
            { type: "note", note: "F4", start: { bar:1, beat:4 }, duration: { value: "1/4" }, articulation: "tenuto", velocity: 70 }
          ]
        }
      ]
    };

    const json = compileScoreToJsonMidi(score);
    expect(json.ppq).toBe(480);
    expect(json.tracks.length).toBe(2); // meta + lead

    const t0 = json.tracks[0].events;
    expect(t0.find(e=> e.type==="meta.timeSignature" && e.tick===0)).toBeTruthy();
    expect(t0.find(e=> e.type==="meta.keySignature" && e.tick===0)).toBeTruthy();
    expect(t0.find(e=> e.type==="meta.tempo" && e.tick===0)).toBeTruthy();

  const t1 = json.tracks[1].events;
  // program イベントが tick=0 に存在すること（順序には依存しない）
  const hasProgramAtZero = t1.some((e: any)=> e.type === "program" && e.tick === 0 && e.program === 0 && e.channel === 0);
  expect(hasProgramAtZero).toBe(true);

    // notes
    const notes = t1.filter(e=> e.type === "note") as any[];
    expect(notes.length).toBe(4);

    // C4 at bar1 beat1 -> tick 0, quarter 480, staccato x0.5 => 240
    expect(notes[0]).toMatchObject({ tick: 0, pitch: 60, duration: 240, velocity: 100 });

    // D4 at beat2 -> tick 480; dotted 8th = 360, accent +15 velocity= min(127,90+15)=105
    expect(notes[1]).toMatchObject({ tick: 480, pitch: 62, duration: 360, velocity: 105 });

    // E4 at beat3 -> tick 960; 8th triplet = 160; slur adds overlap but capped before next start (beat4 -> 1440), so <= 1440-960=480; after 10% overlap: 160+16=176
    expect(notes[2].tick).toBe(960);
    expect(notes[2].pitch).toBe(64);
    expect(notes[2].duration).toBeGreaterThanOrEqual(160);
    expect(notes[2].duration).toBeLessThanOrEqual(480);

    // F4 at beat4 -> tick 1440; quarter 480 * 1.05 tenuto => 504 (rounded), no next so stays 504
    expect(notes[3]).toMatchObject({ tick: 1440, pitch: 65, duration: 504, velocity: 70 });
  });
});
