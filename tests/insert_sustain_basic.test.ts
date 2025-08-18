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

describe("insert_sustain (CC64 on/off)", () => {
  it("指定範囲にCC64 127/0 を挿入する（track/channel継承）", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    // base JSON MIDI: 1小節のノート
    const base = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 }, { type: "meta.timeSignature", tick: 0, numerator: 4, denominator: 4 } ] },
        { channel: 0, events: [ { type: "program", tick: 0, program: 0 }, { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 960 } ] }
      ]
    };

    // json_to_smf
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: base, format: "json_midi_v1", name: "pedal_base.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // insert_sustain: 0..720tick にペダルON(127)/OFF(0)
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "insert_sustain", arguments: { fileId, ranges: [ { startTick: 0, endTick: 720 } ] } } });
    const res2 = await readLine(child);
    if (res2.error) { child.kill(); throw new Error(String(res2.error?.message || res2.error)); }
    const body2 = res2.result?.content?.[0]?.text ? JSON.parse(res2.result.content[0].text) : res2.result;
    expect(body2.ok).toBe(true);

    // smf_to_json で CC64 挿入を確認
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res3 = await readLine(child);
    const body3 = JSON.parse(res3.result.content[0].text);

    const tracks = body3.json.tracks as any[];
    let hasOn = false, hasOff = false;
    for (const tr of tracks) {
      for (const ev of tr.events || []) {
        if (ev.type === "cc" && ev.controller === 64 && ev.value === 127 && ev.tick === 0) hasOn = true;
        if (ev.type === "cc" && ev.controller === 64 && ev.value === 0 && ev.tick === 720) hasOff = true;
      }
    }
    expect(hasOn && hasOff).toBe(true);

    child.kill();
  }, 20000);
});
