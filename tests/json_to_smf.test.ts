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

describe("json_to_smf tool", () => {
  it("最小のJSON曲をSMFとして保存し、fileIdを返す", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest-client", version: "0.0.1" },
      },
    });
    await readLine(child);

    const song = {
      format: 1,
      ppq: 480,
      tracks: [
        {
          name: "Piano",
          channel: 0,
          events: [
            { type: "meta.tempo", tick: 0, usPerQuarter: 500000 },
            { type: "program", tick: 0, program: 0 },
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 240 },
          ],
        },
      ],
    };

    sendLine(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "json_to_smf", arguments: { json: song, name: "from_json.mid" } },
    });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();

    // Claude互換ラッピングのcontent配列が付与されている
    expect(res.result?.content?.[0]?.type).toBe("text");
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(typeof body.fileId).toBe("string");

    child.kill();
  }, 15000);
});
