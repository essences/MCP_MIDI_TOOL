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

describe("list_devices tool (TDD)", () => {
  it("CoreMIDIの出力デバイス一覧を返す（macOSのみ対応）", async () => {
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
    await readLine(child); // ignore init result

    // list_devices
    sendLine(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "list_devices",
        arguments: {}
      }
    });
    const resp = await readLine(child);

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeDefined();
    expect(resp.result.ok).toBe(true);
    expect(Array.isArray(resp.result.devices)).toBe(true);
    
    // macOSなら少なくとも1つはデバイスがあるはず（仮想含む）
    if (process.platform === "darwin") {
      expect(resp.result.devices.length).toBeGreaterThan(0);
      // 各デバイスは { id, name } の形式
      for (const device of resp.result.devices) {
        expect(typeof device.id).toBe("string");
        expect(typeof device.name).toBe("string");
      }
    } else {
      // macOS以外では空配列またはエラー
      expect(resp.result.devices.length).toBe(0);
    }

    child.kill();
  }, 20000);
});
