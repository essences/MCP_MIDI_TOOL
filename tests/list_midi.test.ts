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

describe("list_midi tool (TDD)", () => {
  it("ページングして items を返す（limit=1 で1件, total>=2）", async () => {
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

    // データを少なくとも2件保存
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_midi", arguments: { base64: "AAEC", name: "list-a.mid" } } });
    await readLine(child);
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "store_midi", arguments: { base64: "AAED", name: "list-b.mid" } } });
    await readLine(child);

    // list_midi (limit=1, offset=0)
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_midi", arguments: { limit: 1, offset: 0 } } });
    const resp1 = await readLine(child);
    expect(resp1.error).toBeUndefined();
    expect(resp1.result).toBeDefined();
    expect(resp1.result.items.length).toBe(1);
    expect(resp1.result.total).toBeGreaterThanOrEqual(2);

    // list_midi (limit=1, offset=1)
    sendLine(child, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_midi", arguments: { limit: 1, offset: 1 } } });
    const resp2 = await readLine(child);
    expect(resp2.error).toBeUndefined();
    expect(resp2.result.items.length).toBe(1);

    child.kill();
  }, 20000);
});
