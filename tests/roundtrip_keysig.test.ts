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

describe("roundtrip keySignature", () => {
  it("JSON→SMF→JSON でkeySignature(sf,mi)が先頭トラックに現れる", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const song = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [
          { type: "meta.tempo", tick: 0, usPerQuarter: 500000 },
          { type: "meta.keySignature", tick: 0, sf: 1, mi: 0 }, // G major
          { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 120 }
        ]}
      ]
    };

    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: song } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res2 = await readLine(child);
    const body2 = JSON.parse(res2.result.content[0].text);
    const tr0 = body2.json.tracks[0];
    const ks = tr0.events.find((e: any) => e.type === "meta.keySignature");
    expect(ks).toBeTruthy();
    expect(ks.sf).toBe(1);
    expect(ks.mi).toBe(0);

    child.kill();
  }, 15000);
});
