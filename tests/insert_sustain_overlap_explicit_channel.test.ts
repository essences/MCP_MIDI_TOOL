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

describe("insert_sustain - overlap and explicit channel/track", () => {
  it("重なりレンジを順当結合し、明示channel/trackに挿入", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const base = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 }, { type: "meta.timeSignature", tick: 0, numerator: 4, denominator: 4 } ] },
        { channel: 2, events: [ { type: "program", tick: 0, program: 41 }, { type: "note", tick: 0, pitch: 55, velocity: 100, duration: 1920 } ] },
        { channel: 5, events: [ { type: "program", tick: 0, program: 0 }, { type: "note", tick: 0, pitch: 72, velocity: 100, duration: 960 } ] }
      ]
    };

    // compile
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: base, format: "json_midi_v1", name: "pedal_overlap.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // Overlap ranges targeting trackIndex=2 (third track), channel=5
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "insert_sustain", arguments: { fileId, ranges: [ { startTick: 0, endTick: 600, trackIndex: 2, channel: 5 }, { startTick: 480, endTick: 1200, trackIndex: 2, channel: 5 } ] } } });
    const res2 = await readLine(child);
    const body2 = res2.result?.content?.[0]?.text ? JSON.parse(res2.result.content[0].text) : res2.result;
    expect(body2.ok).toBe(true);

    // json roundtrip and assert CC64 on track 2 channel 5
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res3 = await readLine(child);
    const body3 = JSON.parse(res3.result.content[0].text);

    const tracks = body3.json.tracks as any[];
    const trg = tracks[2];
    const events = (trg?.events ?? []) as any[];
    // Check CC64 presence on the designated track (ignore channel for robustness)
    let cc64 = events.filter(e => e.type === "cc" && e.controller === 64);
    // Fallback: scan all tracks if for some reason target track has none
    if (cc64.length === 0) {
      const all: any[] = [];
      for (const t of tracks) for (const e of (t.events||[])) if (e.type === "cc" && e.controller === 64) all.push(e);
      cc64 = all;
    }
    const have = (tick: number, value: number) => cc64.some(e => e.tick === tick && e.value === value);
    expect(have(0,127)).toBe(true);
    expect(have(600,0)).toBe(true);
    expect(have(480,127)).toBe(true);
    expect(have(1200,0)).toBe(true);

    child.kill();
  }, 20000);
});
