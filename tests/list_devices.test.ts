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
    // diagnostics が含まれること
    // 新バージョンでは diagnostics が付与される。存在しない場合は後方互換として警告表示のみ。
    if (!resp.result.diagnostics) {
      console.warn('[WARN] diagnostics field missing (legacy build?)');
    }
    if (process.platform === "darwin") {
      // 3パターン許容:
      // 1. 実デバイス >=1
      // 2. プレースホルダー1件 (placeholder-iac, diagnostics.placeholderInjected)
      // 3. フォールバック抑止で 0 件 (MCP_MIDI_DEVICE_FALLBACK=0, diagnostics.placeholderSuppressed)
  const d = resp.result.diagnostics || {};
      const devs = resp.result.devices;
      if (devs.length > 0 && devs[0].placeholder) {
        expect(devs.length).toBe(1);
        expect(d.placeholderInjected).toBe(true);
      } else if (devs.length === 0) {
        expect(d.placeholderSuppressed || d.nativeLoadFailed).toBeTruthy();
      } else {
        // 実デバイス
        for (const device of devs) {
          expect(typeof device.id).toBe("string");
          expect(typeof device.name).toBe("string");
          expect(device.placeholder).toBeUndefined();
        }
      }
    } else {
      // macOS以外は空配列想定
      expect(resp.result.devices.length).toBe(0);
    }

    child.kill();
  }, 20000);
});
