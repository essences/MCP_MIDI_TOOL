import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";

function spawnServer() {
  const command = process.execPath; // node
  const args = ["./dist/index.js"];
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

describe("playback_midi / stop_playback (TDD)", () => {
  it("保存→再生開始→停止が成功する（macOS限定検証）", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest-client", version: "0.0.1" }
      }
    });
    await readLine(child);

    // 保存
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_midi", arguments: { base64: "AQIDBA", name: "play.mid" } } });
    const storeResp = await readLine(child);
    expect(storeResp.error).toBeUndefined();
    const fileId = storeResp.result.fileId as string;

    if (process.platform !== "darwin") {
      // macOS以外は検証スキップ（早期終了）
      child.kill();
      return;
    }

    // 再生開始
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "playback_midi", arguments: { fileId, portName: "IAC Driver Bus 1" } } });
    const pbResp = await readLine(child);
    expect(pbResp.error).toBeUndefined();
    expect(pbResp.result.ok).toBe(true);
    expect(typeof pbResp.result.playbackId).toBe("string");
    const playbackId = pbResp.result.playbackId as string;

    // 停止
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stop_playback", arguments: { playbackId } } });
    const stopResp = await readLine(child);
    expect(stopResp.error).toBeUndefined();
    expect(stopResp.result.ok).toBe(true);

    child.kill();
  }, 20000);
});
