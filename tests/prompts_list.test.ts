import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";

function spawnServer() {
  const command = process.execPath; // node
  const args = ["./dist/index.js"];
  const child = spawn(command, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr?.on("data", (d) => {
    process.stderr.write(`[server] ${d}`);
  });
  return child;
}

function encodeLine(obj: any): string {
  return JSON.stringify(obj) + "\n";
}

async function readOneLineJson(stream: Readable): Promise<any> {
  let buffer = Buffer.alloc(0);
  while (true) {
    const [piece] = (await once(stream, "data")) as [Buffer];
    buffer = Buffer.concat([buffer, piece]);
    const nl = buffer.indexOf("\n");
    if (nl === -1) continue;
    const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
    return JSON.parse(line);
  }
}

describe("prompts/list responds with empty array", () => {
  it("returns { prompts: [] }", async () => {
    const child = spawnServer();

    // initialize
    child.stdin!.write(encodeLine({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest-client", version: "0.0.1" },
      },
    }));
    const initResp = await readOneLineJson(child.stdout!);
    expect(initResp.result).toBeDefined();

    // prompts/list
    child.stdin!.write(encodeLine({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} }));
    const resp = await readOneLineJson(child.stdout!);
    expect(resp.id).toBe(2);
    expect(resp.result).toBeDefined();
    expect(Array.isArray(resp.result.prompts)).toBe(true);
    child.kill();
  }, 20000);
});
