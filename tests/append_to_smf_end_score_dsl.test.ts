import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";

function spawnServer() {
  const command = process.execPath; // node
  const args = ["./dist/index.js"]; // built server
  const child = spawn(command, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  return child;
}

function sendLine(child: any, obj: any) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

async function readLine(child: any) {
  const [buf] = (await once(child.stdout, "data")) as [Buffer];
  const line = buf.toString("utf8").split(/\r?\n/)[0];
  return JSON.parse(line);
}

describe("append_to_smf (atEnd + gapTicks) with Score DSL", () => {
  it("末尾にScore DSLチャンクを追記し、イベント件数と総尺が増えること/insertedAtTickの位置にノートが存在すること", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    // base JSON MIDI (トラック1に短いノート)
    const base = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] },
        {
          name: "Piano",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 },
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 480 },
          ],
        },
      ],
    };

    // json_to_smf
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: base, format: "json_midi_v1", name: "append_base.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // play_smf dryRun (before)
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "play_smf", arguments: { fileId, dryRun: true } } });
    const res2 = await readLine(child);
    expect(res2.result.ok).toBe(true);
    const beforeCount = res2.result.scheduledEvents as number;
    const beforeMs = res2.result.totalDurationMs as number;

    // append_to_smf with Score DSL at end + gapTicks
    const dslChunk = {
      ppq: 480,
      meta: { timeSignature: { numerator: 4, denominator: 4 }, keySignature: { root: "C", mode: "major" }, tempo: { bpm: 120 } },
      tracks: [
        { channel: 1, events: [ { type: "note", note: "G4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" } } ] }
      ]
    };
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "append_to_smf", arguments: { fileId, json: dslChunk, format: "score_dsl_v1", atEnd: true, gapTicks: 240 } } });
  const res3 = await readLine(child);
  if (res3.error) { child.kill(); throw new Error(String(res3.error?.message || res3.error)); }
  const body3 = res3.result?.content?.[0]?.text ? JSON.parse(res3.result.content[0].text) : res3.result;
  expect(body3.ok).toBe(true);
  const insertedAtTick = body3.insertedAtTick as number;
    expect(typeof insertedAtTick).toBe("number");
    expect(insertedAtTick).toBeGreaterThanOrEqual(0);

    // play_smf dryRun (after)
    sendLine(child, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "play_smf", arguments: { fileId, dryRun: true } } });
  const res4 = await readLine(child);
  if (res4.error) { child.kill(); throw new Error(String(res4.error?.message || res4.error)); }
  const body4 = res4.result?.content?.[0]?.text ? JSON.parse(res4.result.content[0].text) : res4.result;
  expect(body4.ok).toBe(true);
  expect(body4.scheduledEvents).toBeGreaterThan(beforeCount);
  expect(body4.totalDurationMs).toBeGreaterThan(beforeMs);

    // smf_to_json で insertedAtTick に開始ノートが存在することを確認
    sendLine(child, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
  const res5 = await readLine(child);
  if (res5.error) { child.kill(); throw new Error(String(res5.error?.message || res5.error)); }
  const body5 = res5.result?.content?.[0]?.text ? JSON.parse(res5.result.content[0].text) : res5.result;
    const tracks = body5.json.tracks as any[];
    let found = false;
    for (const tr of tracks) {
      for (const ev of tr.events || []) {
        if (ev.type === "note" && Math.abs((ev.tick|0) - (insertedAtTick|0)) <= 1) { found = true; break; }
      }
      if (found) break;
    }
    expect(found).toBe(true);

    child.kill();
  }, 20000);
});
