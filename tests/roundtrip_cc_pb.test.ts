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

describe("roundtrip cc/pitchbend", () => {
  it("JSON→SMF→JSON でCCとPBが概ね往復する", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const song = {
      format: 1,
      ppq: 480,
      tracks: [
        {
          name: "Ctrl&PB",
          channel: 0,
          events: [
            { type: "meta.tempo", tick: 0, usPerQuarter: 500000 },
            { type: "cc", tick: 0, controller: 1, value: 64 },
            { type: "pitchBend", tick: 120, value: 2000 },
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 240 },
          ],
        },
      ],
    };

    // to SMF
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: song } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // back to JSON
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res2 = await readLine(child);
    const body2 = JSON.parse(res2.result.content[0].text);
    expect(body2.ok).toBe(true);

    const tr0 = body2.json.tracks[0];
    const types = tr0.events.map((e: any) => e.type);
    expect(types).toContain("cc");
    expect(types).toContain("pitchBend");

    child.kill();
  }, 15000);
});
