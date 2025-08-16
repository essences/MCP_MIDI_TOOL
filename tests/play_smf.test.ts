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

// 最小のSMF: ヘッダ+トラック( C4 を四分音符で1音 )
const SMF_BASE64 = Buffer.from([
  0x4d,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, 0x00,0x00, 0x00,0x01, 0x01,0xe0,
  0x4d,0x54,0x72,0x6b, 0x00,0x00,0x00,0x0d,
  0x00, 0x90, 0x3c, 0x40, // delta=0 NoteOn C4 vel64
  0x83,0x60,               // delta=0x0360 (可変長: 0x83 0x60) ~ 0x1b0? (簡易)
  0x80, 0x3c, 0x40,        // NoteOff C4
  0x00, 0xff, 0x2f, 0x00   // End of Track
]).toString('base64');


describe("play_smf", () => {
  it("SMFを保存して解析件数が返る", async () => {
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
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_midi", arguments: { base64: SMF_BASE64, name: "single_note.mid" } } });
    const storeResp = await readLine(child);
    expect(storeResp.error).toBeUndefined();
    const fileId = storeResp.result.fileId as string;

    // 解析（再生はまだしない）
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "play_smf", arguments: { fileId } } });
    const psResp = await readLine(child);
    expect(psResp.error).toBeUndefined();
    expect(psResp.result.ok).toBe(true);
    expect(typeof psResp.result.playbackId).toBe("string");
    expect(psResp.result.scheduledEvents).toBeGreaterThanOrEqual(2); // NoteOn/Off

    child.kill();
  }, 15000);
});
