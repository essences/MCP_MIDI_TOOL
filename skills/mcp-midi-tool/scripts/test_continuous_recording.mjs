#!/usr/bin/env node
import { createLocalToolClient } from "../lib/localToolClient.mjs";

const PORT_NAME = process.env.PORT_NAME || "KeyLab 61 mk3 MIDI";
const MAX_DURATION_MS = Number(process.env.MAX_DURATION_MS || 15000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 8000);
const SILENCE_TIMEOUT_MS = Number(process.env.SILENCE_TIMEOUT_MS || 3000);
const OUTPUT_NAME = process.env.OUTPUT_NAME || "portable_record_test.mid";

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const client = createLocalToolClient();
  try {
    await client.initialize({ name: "test-continuous-recording", version: "0.0.1" });
    const started = await client.callTool("start_continuous_recording", {
      portName: PORT_NAME,
      maxDurationMs: MAX_DURATION_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS
    });
    const recordingId = started.recordingId;
    if (!recordingId) throw new Error("recordingId missing");

    console.log(JSON.stringify({
      phase: "started",
      recordingId,
      portName: PORT_NAME,
      message: "Play now"
    }, null, 2));

    const deadline = Date.now() + MAX_DURATION_MS + 5000;
    let lastStatus = null;
    while (Date.now() < deadline) {
      await sleep(1000);
      const status = await client.callTool("get_continuous_recording_status", { recordingId });
      lastStatus = status;
      console.log(JSON.stringify({ phase: "status", status }, null, 2));
      if (status?.done || status?.status === "completed" || String(status?.status || "").startsWith("timeout_")) {
        break;
      }
    }

    const stopped = await client.callTool("stop_continuous_recording", {
      recordingId,
      name: OUTPUT_NAME,
      overwrite: true
    });
    console.log(JSON.stringify({
      phase: "stopped",
      lastStatus,
      stopped
    }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("[test_continuous_recording]", error?.stack || String(error));
  process.exitCode = 1;
});
