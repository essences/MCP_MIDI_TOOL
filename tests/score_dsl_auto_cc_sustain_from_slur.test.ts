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

describe("Score DSL autoCcPresets - sustain_from_slur", () => {
  it("slur/legato 区間にCC64(127/0)が自動付与される", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const score = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 },
        title: "AutoCC Demo",
        autoCcPresets: [ { id: "sustain_from_slur" } ]
      },
      tracks: [
        {
          name: "LegatoLead",
          channel: 1,
          program: 0,
          events: [
            { type: "note", note: "C4", start: { bar:1, beat:1 }, duration: { value: "1/4" }, slur: true },
            { type: "note", note: "D4", start: { bar:1, beat:2 }, duration: { value: "1/4" }, articulation: "legato" },
            { type: "note", note: "E4", start: { bar:1, beat:3 }, duration: { value: "1/4" } }
          ]
        }
      ]
    };

    // compile DSL to SMF
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: score, format: "score_dsl_v1", name: "auto_cc_slur.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // roundtrip
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res2 = await readLine(child);
    const body2 = JSON.parse(res2.result.content[0].text);

  const tracks = body2.json.tracks as any[];
  const evs = tracks.flatMap(t => (t.events||[])).filter((e:any)=> e.type==="cc" && e.controller===64);
    const hasOn = evs.some((e:any)=> e.value===127);
    const hasOff = evs.some((e:any)=> e.value===0);
    expect(hasOn && hasOff).toBe(true);

    child.kill();
  }, 20000);
});
