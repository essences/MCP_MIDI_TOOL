#!/usr/bin/env node
import { createLocalToolClient } from "../lib/localToolClient.mjs";

const PLAY_FILE_ID = process.env.PLAY_FILE_ID;
const PLAY_PORT_NAME = process.env.PLAY_PORT_NAME || "IACドライバ バス1";
const RECORD_PORT_NAME = process.env.RECORD_PORT_NAME || "KeyLab 61 mk3 MIDI";
const OUTPUT_NAME = process.env.OUTPUT_NAME || "play_and_record_take.mid";
const PRE_ROLL_MS = Number(process.env.PRE_ROLL_MS || 250);
const POST_ROLL_MS = Number(process.env.POST_ROLL_MS || 1500);
const MAX_DURATION_MS = Number(process.env.MAX_DURATION_MS || 30000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 12000);
const SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS || 4000);
const POLL_MS = Number(process.env.POLL_MS || 500);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!PLAY_FILE_ID) {
    throw new Error("PLAY_FILE_ID is required");
  }

  const client = createLocalToolClient();
  try {
    await client.initialize({ name: "play-and-record-together", version: "0.0.1" });

    const orchestrationStartedAt = new Date().toISOString();
    const recordingStart = await client.callTool("start_continuous_recording", {
      portName: RECORD_PORT_NAME,
      maxDurationMs: MAX_DURATION_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS
    });
    const recordingId = recordingStart.recordingId;
    if (!recordingId) throw new Error("recordingId missing");

    await sleep(PRE_ROLL_MS);

    const playbackStartRequestedAt = new Date().toISOString();
    const playback = await client.callTool("play_smf", {
      fileId: PLAY_FILE_ID,
      portName: PLAY_PORT_NAME
    });
    const playbackId = playback.playbackId;
    if (!playbackId) throw new Error("playbackId missing");

    console.log(JSON.stringify({
      phase: "started",
      orchestrationStartedAt,
      playbackStartRequestedAt,
      recording: {
        recordingId,
        portName: RECORD_PORT_NAME,
        startedAt: recordingStart.startedAt,
        maxDurationMs: recordingStart.maxDurationMs
      },
      playback: {
        playbackId,
        portName: PLAY_PORT_NAME,
        scheduledEvents: playback.scheduledEvents,
        totalDurationMs: playback.totalDurationMs
      }
    }, null, 2));

    let lastRecordingStatus = null;
    let lastPlaybackStatus = null;
    const deadline = Date.now() + MAX_DURATION_MS + POST_ROLL_MS + 5000;
    let playbackDoneAt = null;

    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const [recordingStatus, playbackStatus] = await Promise.all([
        client.callTool("get_continuous_recording_status", { recordingId }),
        client.callTool("get_playback_status", { playbackId })
      ]);
      lastRecordingStatus = recordingStatus;
      lastPlaybackStatus = playbackStatus;

      console.log(JSON.stringify({
        phase: "status",
        recordingStatus,
        playbackStatus
      }, null, 2));

      if (playbackStatus?.done && !playbackDoneAt) {
        playbackDoneAt = Date.now();
      }

      const recordingFinished =
        String(recordingStatus?.status || "").startsWith("timeout_") ||
        recordingStatus?.status === "completed" ||
        recordingStatus?.status === "stopped_manually";

      if (recordingFinished) break;
      if (playbackDoneAt && Date.now() - playbackDoneAt >= POST_ROLL_MS) break;
    }

    const stopped = await client.callTool("stop_continuous_recording", {
      recordingId,
      name: OUTPUT_NAME,
      overwrite: true
    });

    const syncSummary = {
      orchestrationStartedAt,
      playbackStartRequestedAt,
      recordingStartedAt: recordingStart.startedAt,
      recordingFirstInputAt: lastRecordingStatus?.firstInputAt,
      recordingLastInputAt: lastRecordingStatus?.lastInputAt,
      playbackTotalDurationMs: lastPlaybackStatus?.totalDurationMs ?? playback.totalDurationMs,
      playbackLastSentAtMs: lastPlaybackStatus?.lastSentAt,
      playbackDone: !!lastPlaybackStatus?.done,
      note: "Playback and recording were run in the same bundled server process. Exact sample-accurate sync is not guaranteed, but process-level start coordination is preserved."
    };

    console.log(JSON.stringify({
      phase: "stopped",
      syncSummary,
      lastRecordingStatus,
      lastPlaybackStatus,
      stopped
    }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("[play_and_record_together]", error?.stack || String(error));
  process.exitCode = 1;
});
