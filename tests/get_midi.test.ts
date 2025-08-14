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

describe("get_midi tool (TDD)", () => {
  it("保存済みの fileId からメタ情報を取得できる", async () => {
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

    // まず store_midi で1件保存
    sendLine(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "store_midi",
        arguments: { base64: "AAEC", name: "get-test.mid" } // tiny bytes
      }
    });
    const storeResp = await readLine(child);
    expect(storeResp.error).toBeUndefined();
    const fileId = storeResp.result.fileId as string;

    // get_midi を呼び出し
    sendLine(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_midi",
        arguments: { fileId, includeBase64: false }
      }
    });
    const getResp = await readLine(child);

    expect(getResp.error).toBeUndefined();
    expect(getResp.result).toBeDefined();
    expect(typeof getResp.result.name).toBe("string");
    expect(typeof getResp.result.path).toBe("string");
    expect(typeof getResp.result.bytes).toBe("number");

    child.kill();
  }, 20000);
});
