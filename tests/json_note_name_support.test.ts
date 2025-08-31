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

describe("note name support", () => {
  it("json_to_smf で note 名(C4等)を受け付けて再生可能、smf_to_json で note 名を付与", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const song = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] },
  { channel: 1, events: [
          { type: "program", tick: 0, program: 0 },
          { type: "note", tick: 0, note: "C4", velocity: 100, duration: 240 },
          { type: "note", tick: 480, note: "E4", velocity: 100, duration: 240 },
          { type: "note", tick: 960, note: "G4", velocity: 100, duration: 240 }
        ]}
      ]
    } as any;

    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: song, name: "note_name_test.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res2 = await readLine(child);
  const body2 = JSON.parse(res2.result.content[0].text);
  const noteTrack = body2.json.tracks.find((t: any) => Array.isArray(t.events) && t.events.some((e: any) => e.type === "note"));
  expect(noteTrack).toBeTruthy();
  const evs = noteTrack.events.filter((e: any) => e.type === "note");
    expect(evs[0].pitch).toBe(60);
    expect(evs[0].note).toBe("C4");
    expect(evs[1].pitch).toBe(64);
    expect(evs[1].note).toBe("E4");
    expect(evs[2].pitch).toBe(67);
    expect(evs[2].note).toBe("G4");

    child.kill();
  }, 20000);
});
