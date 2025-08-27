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

describe("json_to_smf with format=score_dsl_v1", () => {
  it("compiles Score DSL and saves SMF", async () => {
    const child = spawnServer();

    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const score = {
      ppq: 480,
      meta: { timeSignature: { numerator: 4, denominator: 4 }, tempo: { bpm: 120 }, keySignature: { root: "C", mode: "major" } },
      tracks: [ { channel: 1, program: 0, events: [ { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" } } ] } ]
    };

    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: score, format: "score_dsl_v1", name: "from_dsl_v1.mid" } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(typeof body.fileId).toBe("string");
    child.kill();
  }, 15000);

  it("fails clearly if invalid DSL", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const badDsl = { tracks: [] }; // missing required meta/ppq etc
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: badDsl, format: "score_dsl_v1" } } });
    const res = await readLine(child);
    expect(res.result?.error?.message).toMatch(/score_dsl_v1 compile\/validation failed|score-compile/i);
    child.kill();
  }, 15000);
});
