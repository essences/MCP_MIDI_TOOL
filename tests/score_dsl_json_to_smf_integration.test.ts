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

describe("json_to_smf accepts Score DSL v1 (fallback)", () => {
  it("compiles and saves SMF from DSL input (object)", async () => {
    const child = spawnServer();

    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const score = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 },
        title: "Score DSL Demo"
      },
      tracks: [
        {
          name: "Lead",
          channel: 1, // 外部表記1-16
          program: 0,
          events: [
            { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" }, articulation: "staccato", velocity: 96 },
            { type: "note", note: "D4", start: { bar: 1, beat: 2 }, duration: { value: "1/8", dots: 1 }, articulation: "accent", velocity: 90 },
            { type: "note", note: "E4", start: { bar: 1, beat: 3 }, duration: { value: "1/8", tuplet: { inSpaceOf: 2, play: 3 } }, slur: true, velocity: 84 },
            { type: "note", note: "F4", start: { bar: 1, beat: 4 }, duration: { value: "1/4" }, articulation: "tenuto", velocity: 80 }
          ]
        }
      ]
    };

    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: score, name: "score_dsl_demo.mid", overwrite: true } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(typeof body.fileId).toBe("string");
    expect(body.eventCount).toBeGreaterThan(0);
    child.kill();
  }, 15000);

  it("compiles and saves SMF from DSL input when json is a string", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const scoreStr = JSON.stringify({
      ppq: 480,
      meta: { timeSignature: { numerator: 4, denominator: 4 }, keySignature: { root: "C", mode: "major" }, tempo: { bpm: 120 } },
      tracks: [ { channel: 1, program: 0, events: [ { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" } } ] } ] // 外部表記1-16
    });
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: scoreStr, name: "score_dsl_demo2.mid", overwrite: true } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(typeof body.fileId).toBe("string");
    child.kill();
  }, 15000);
});
