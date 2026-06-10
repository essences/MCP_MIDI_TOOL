#!/usr/bin/env node
import { loadSmfAsJson, saveSongAsSmf } from "../lib/directApi.js";

const PORT_NAME_HINT = process.env.PORT_NAME || "IACドライバ バス1";

function scoreDsl() {
  return {
    ppq: 480,
    meta: {
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { root: "C", mode: "major" },
      tempo: { bpm: 112 },
      title: "Direct Skill Tune"
    },
    tracks: [
      {
        channel: 1,
        program: 0,
        events: [
          { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" } },
          { type: "note", note: "E4", start: { bar: 1, beat: 2 }, duration: { value: "1/4" } },
          { type: "note", note: "G4", start: { bar: 1, beat: 3 }, duration: { value: "1/4" } },
          { type: "note", note: "E4", start: { bar: 1, beat: 4 }, duration: { value: "1/4" } },
          { type: "note", note: "D4", start: { bar: 2, beat: 1 }, duration: { value: "1/4" } },
          { type: "note", note: "F4", start: { bar: 2, beat: 2 }, duration: { value: "1/4" } },
          { type: "note", note: "A4", start: { bar: 2, beat: 3 }, duration: { value: "1/4" } },
          { type: "note", note: "G4", start: { bar: 2, beat: 4 }, duration: { value: "1/4" } }
        ]
      },
      {
        channel: 2,
        program: 32,
        events: [
          { type: "note", note: "C3", start: { bar: 1, beat: 1 }, duration: { value: "1" } },
          { type: "note", note: "G2", start: { bar: 2, beat: 1 }, duration: { value: "1" } }
        ]
      }
    ]
  };
}

function firstTempoUsPerQuarter(song) {
  for (const track of song.tracks || []) {
    for (const event of track.events || []) {
      if (event.type === "meta.tempo") return event.usPerQuarter;
    }
  }
  return 500000;
}

function buildPlaybackEvents(song) {
  const events = [];
  for (const track of song.tracks || []) {
    const defaultChannel = Number.isFinite(Number(track.channel)) ? Number(track.channel) | 0 : 0;
    for (const event of track.events || []) {
      if (event.type === "program") {
        const channel = Number.isFinite(Number(event.channel)) ? Number(event.channel) | 0 : defaultChannel;
        events.push({ tick: event.tick | 0, bytes: [0xc0 | (channel & 0x0f), event.program & 0x7f] });
      } else if (event.type === "cc") {
        const channel = Number.isFinite(Number(event.channel)) ? Number(event.channel) | 0 : defaultChannel;
        events.push({ tick: event.tick | 0, bytes: [0xb0 | (channel & 0x0f), event.controller & 0x7f, event.value & 0x7f] });
      } else if (event.type === "note") {
        const channel = Number.isFinite(Number(event.channel)) ? Number(event.channel) | 0 : defaultChannel;
        events.push({ tick: event.tick | 0, bytes: [0x90 | (channel & 0x0f), event.pitch & 0x7f, event.velocity & 0x7f] });
        events.push({ tick: (event.tick + event.duration) | 0, bytes: [0x90 | (channel & 0x0f), event.pitch & 0x7f, 0] });
      }
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  return events;
}

async function main() {
  const saved = await saveSongAsSmf({
    json: scoreDsl(),
    format: "score_dsl_v1",
    name: "skill_direct_tune.mid"
  });
  const loaded = await loadSmfAsJson(saved.fileId);
  const song = loaded.json;
  const usPerQuarter = firstTempoUsPerQuarter(song);
  const msPerTick = usPerQuarter / 1000 / (song.ppq || 480);
  const playbackEvents = buildPlaybackEvents(song);

  const midiMod = await import("midi");
  const Output = midiMod.Output || midiMod.default?.Output;
  if (!Output) throw new Error("No MIDI Output class available");

  const output = new Output();
  const count = output.getPortCount?.() || 0;
  const names = [];
  for (let i = 0; i < count; i++) {
    try {
      names.push(output.getPortName(i));
    } catch {
      names.push(`port:${i}`);
    }
  }
  const index = names.findIndex((name) => String(name).includes(PORT_NAME_HINT));
  if (index < 0) throw new Error(`Target port not found: ${PORT_NAME_HINT}`);

  output.openPort(index);
  try {
    let lastTick = 0;
    for (const event of playbackEvents) {
      const waitMs = Math.max(0, Math.round((event.tick - lastTick) * msPerTick));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      output.sendMessage(event.bytes);
      lastTick = event.tick;
    }
  } finally {
    try { output.closePort(); } catch {}
  }

  console.log(JSON.stringify({
    ok: true,
    fileId: saved.fileId,
    port: names[index],
    eventCount: playbackEvents.length
  }, null, 2));
}

main().catch((error) => {
  console.error("[direct_compose_and_play]", error?.stack || String(error));
  process.exitCode = 1;
});
