#!/usr/bin/env node
import { analyzeSmfDryRun, saveSongAsSmf } from "../lib/directApi.js";

function scoreDsl() {
  return {
    ppq: 480,
    meta: {
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { root: "C", mode: "major" },
      tempo: { bpm: 110 },
      title: "Direct Skill Demo"
    },
    tracks: [
      {
        channel: 1,
        program: 0,
        events: [
          { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" } },
          { type: "note", note: "E4", start: { bar: 1, beat: 2 }, duration: { value: "1/4" } },
          { type: "note", note: "G4", start: { bar: 1, beat: 3 }, duration: { value: "1/4" } },
          { type: "note", note: "C5", start: { bar: 1, beat: 4 }, duration: { value: "1/4" } }
        ]
      }
    ]
  };
}

async function main() {
  const saved = await saveSongAsSmf({
    json: scoreDsl(),
    format: "score_dsl_v1",
    name: "skill_direct_compose.mid"
  });
  const dryRun = await analyzeSmfDryRun(saved.fileId);
  console.log(JSON.stringify({ ok: true, saved, dryRun }, null, 2));
}

main().catch((error) => {
  console.error("[direct_compose_and_analyze]", error?.stack || String(error));
  process.exitCode = 1;
});
