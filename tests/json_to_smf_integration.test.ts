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

describe("json_to_smf integration", () => {
  it("JSON(tempo, program, note)→SMF→play_smf(dryRun) でイベントが2件以上", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const song = {
      format: 1,
      ppq: 480,
      tracks: [
        {
          name: "Piano",
          channel: 1,
          events: [
            { type: "meta.tempo", tick: 0, usPerQuarter: 500000 },
            { type: "program", tick: 0, program: 0 },
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 240 },
          ],
        },
      ],
    };

    // json_to_smf
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: song, name: "it_json.mid" } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // play_smf dryRun
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "play_smf", arguments: { fileId, dryRun: true } } });
    const res2 = await readLine(child);
    const body2 = res2.result; // already wrapped by server
    expect(body2.ok).toBe(true);
    expect(body2.scheduledEvents).toBeGreaterThanOrEqual(2);

    child.kill();
  }, 15000);
});
