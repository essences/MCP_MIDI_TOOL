#!/usr/bin/env node
import { analyzeSmfDryRun, loadSmfAsJson } from "../lib/directApi.js";

const FILE_ID = process.env.FILE_ID;

async function main() {
  if (!FILE_ID) throw new Error("FILE_ID is required");
  const loaded = await loadSmfAsJson(FILE_ID);
  const dryRun = await analyzeSmfDryRun(FILE_ID);
  const summary = {
    fileId: FILE_ID,
    trackCount: loaded.trackCount,
    eventCount: loaded.eventCount,
    ppq: loaded.json.ppq,
    tracks: loaded.json.tracks.map((track, index) => ({
      index,
      channel: track.channel,
      events: track.events.length
    }))
  };
  console.log(JSON.stringify({ ok: true, summary, dryRun }, null, 2));
}

main().catch((error) => {
  console.error("[direct_file_summary]", error?.stack || String(error));
  process.exitCode = 1;
});
