#!/usr/bin/env node
import {
  analyzeSmfDryRun,
  exportMidiFile,
  insertSustainRanges,
  loadSmfAsJson,
} from "../lib/directApi.js";

const FILE_ID = process.env.FILE_ID;

async function main() {
  if (!FILE_ID) throw new Error("FILE_ID is required");

  const loaded = await loadSmfAsJson(FILE_ID);
  const song = loaded.json;
  let minTick = Number.MAX_SAFE_INTEGER;
  let maxTick = 0;
  let trackIndexWithNotes = 0;
  let guessedChannel = 0;
  let cc64Count = 0;
  let cc64OnCount = 0;
  const noteChannelFreq = new Map();
  const cc64ChannelFreq = new Map();

  song.tracks.forEach((track, trackIndex) => {
    const trackChannel = Number.isFinite(Number(track.channel)) ? Number(track.channel) | 0 : undefined;
    for (const event of track.events || []) {
      if (event.type === "note") {
        if (event.tick < minTick) {
          minTick = event.tick;
          trackIndexWithNotes = trackIndex;
        }
        if (event.tick + event.duration > maxTick) maxTick = event.tick + event.duration;
        if (trackChannel !== undefined) {
          guessedChannel = trackChannel;
          noteChannelFreq.set(trackChannel, (noteChannelFreq.get(trackChannel) || 0) + 1);
        }
      }
      if (event.type === "cc" && event.controller === 64) {
        cc64Count += 1;
        if (event.value >= 64) cc64OnCount += 1;
        const eventChannel = Number.isFinite(Number(event.channel))
          ? Number(event.channel) | 0
          : (trackChannel ?? 0);
        cc64ChannelFreq.set(eventChannel, (cc64ChannelFreq.get(eventChannel) || 0) + 1);
      }
    }
  });

  if (minTick === Number.MAX_SAFE_INTEGER) {
    minTick = 0;
    maxTick = song.ppq * 4;
  }

  let mainNoteChannel = guessedChannel;
  for (const [channel, count] of noteChannelFreq.entries()) {
    if ((noteChannelFreq.get(mainNoteChannel) || 0) < count) mainNoteChannel = channel;
  }

  let inserted = null;
  if (cc64OnCount === 0 || !(cc64ChannelFreq.get(mainNoteChannel) > 0)) {
    inserted = await insertSustainRanges({
      fileId: FILE_ID,
      ranges: [{
        startTick: minTick,
        endTick: maxTick,
        channel: mainNoteChannel + 1,
        trackIndex: trackIndexWithNotes,
        valueOn: 127,
        valueOff: 0,
        removeExisting: true
      }]
    });
  }

  const exported = await exportMidiFile(FILE_ID);
  const dryRun = await analyzeSmfDryRun(FILE_ID);
  console.log(JSON.stringify({
    ok: true,
    fileId: FILE_ID,
    inferred: {
      minTick,
      maxTick,
      trackIndexWithNotes,
      mainNoteChannelExternal: mainNoteChannel + 1,
      cc64Count,
      cc64OnCount
    },
    inserted,
    exported,
    dryRun
  }, null, 2));
}

main().catch((error) => {
  console.error("[direct_inspect_and_fix_sustain]", error?.stack || String(error));
  process.exitCode = 1;
});
