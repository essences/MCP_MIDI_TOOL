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

// Minimal single-note SMF (same base as play_smf test)
const SMF_BASE64 = Buffer.from([
  0x4d,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, 0x00,0x00, 0x00,0x01, 0x01,0xe0,
  0x4d,0x54,0x72,0x6b, 0x00,0x00,0x00,0x0d,
  0x00, 0x90, 0x3c, 0x40,
  0x83,0x60,
  0x80, 0x3c, 0x40,
  0x00, 0xff, 0x2f, 0x00
]).toString('base64');

describe("smf_to_json tool", () => {
  it("SMFをJSONへ解析し、トラックとイベントを含む構造を返す", async () => {
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

  // save SMF (auto-generate unique name to avoid cross-test collision)
  sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_midi", arguments: { base64: SMF_BASE64 } } });
    const storeResp = await readLine(child);
    const fileId = storeResp.result.fileId as string;

    // convert to JSON
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res = await readLine(child);
    expect(res.error).toBeUndefined();

    // Claude互換ラップ
    expect(res.result?.content?.[0]?.type).toBe("text");
    const body = JSON.parse(res.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.json?.ppq).toBeGreaterThan(0);
    expect(Array.isArray(body.json?.tracks)).toBe(true);

    child.kill();
  }, 15000);
});
