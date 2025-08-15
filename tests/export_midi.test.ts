import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

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

describe("export_midi tool (TDD)", () => {
  it("保存済みの fileId を data/export にエクスポートし、exportPath を返す", async () => {
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

    // 1) 保存
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_midi", arguments: { base64: "AQID", name: "export-src.mid" } } });
    const storeResp = await readLine(child);
    expect(storeResp.error).toBeUndefined();
    const fileId = storeResp.result.fileId as string;

    // 2) エクスポート
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "export_midi", arguments: { fileId } } });
    const expResp = await readLine(child);

    expect(expResp.error).toBeUndefined();
    expect(expResp.result).toBeDefined();
    expect(expResp.result.ok).toBe(true);
    expect(typeof expResp.result.exportPath).toBe("string");

    // 3) 実ファイル存在確認
    const abs = path.resolve(process.cwd(), expResp.result.exportPath as string);
    const st = await fs.stat(abs);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBeGreaterThan(0);

    child.kill();
  }, 20000);
});
