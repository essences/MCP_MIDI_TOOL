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

describe("insert_cc - multiple ranges", () => {
  it("複数の非重複レンジにCC11をそれぞれON/OFFで挿入", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const base = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 }, { type: "meta.timeSignature", tick: 0, numerator: 4, denominator: 4 } ] },
  { channel: 1, events: [ { type: "program", tick: 0, program: 0 }, { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 1920 } ] }
      ]
    };

    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: base, format: "json_midi_v1", name: "cc_multi.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    const ranges = [
      { startTick: 0, endTick: 240, valueOn: 100, valueOff: 30 },
      { startTick: 480, endTick: 720, valueOn: 90, valueOff: 20 },
      { startTick: 960, endTick: 1200, valueOn: 80, valueOff: 10 },
    ];

    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "insert_cc", arguments: { fileId, controller: 11, ranges } } });
    const res2 = await readLine(child);
    const body2 = res2.result?.content?.[0]?.text ? JSON.parse(res2.result.content[0].text) : res2.result;
    expect(body2.ok).toBe(true);

    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res3 = await readLine(child);
    const body3 = JSON.parse(res3.result.content[0].text);

    const evs = body3.json.tracks.flatMap((t:any)=> t.events||[]).filter((e:any)=> e.type==="cc" && e.controller===11);
    const has = (tick:number, value:number) => evs.some((e:any)=> e.tick===tick && e.value===value);
    // ON points
    expect(has(0,100)).toBe(true);
    expect(has(480,90)).toBe(true);
    expect(has(960,80)).toBe(true);
    // OFF points
    expect(has(240,30)).toBe(true);
    expect(has(720,20)).toBe(true);
    expect(has(1200,10)).toBe(true);

    child.kill();
  }, 20000);
});
