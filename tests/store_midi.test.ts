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

describe("store_midi tool (TDD): initially unimplemented", () => {
  it("returns method not found / unimplemented error", async () => {
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

    // call tools/call for store_midi
    sendLine(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "store_midi",
        arguments: { base64: "ZmFrZQ==", name: "demo.mid" }
      }
    });
    const resp = await readLine(child);

    expect(resp.error).toBeDefined();
    // until implemented we accept -32601 (method not found) or custom error
    if (resp.error) {
      expect([ -32601, -32000, -32001 ]).toContain(resp.error.code);
    }

    child.kill();
  }, 20000);
});
