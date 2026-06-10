#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillRoot = path.resolve(__dirname, "..");
const serverPath = path.resolve(__dirname, "index.js");

export function createLocalToolClient(extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MCP_MIDI_BASE_DIR: skillRoot,
      MCP_MIDI_MANIFEST: "manifest.json",
      ...extraEnv
    }
  });

  let buffer = "";
  let nextId = 1;
  const waiters = new Map();

  child.stderr.on("data", (chunk) => process.stderr.write("[mcp-midi-skill] " + String(chunk)));
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.id && waiters.has(parsed.id)) {
        const resolve = waiters.get(parsed.id);
        waiters.delete(parsed.id);
        resolve(parsed);
      }
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => waiters.set(id, resolve));
  }

  async function initialize(clientInfo = { name: "portable-skill-client", version: "0.0.1" }) {
    const response = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo
    });
    if (response.error) throw new Error("initialize failed: " + JSON.stringify(response.error));
    return response;
  }

  function unwrap(response) {
    const result = response?.result;
    const text = result?.content?.[0]?.text;
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return result;
    }
  }

  async function listTools() {
    const response = await request("tools/list", {});
    if (response.error) throw new Error("tools/list failed: " + JSON.stringify(response.error));
    return unwrap(response)?.tools || response?.tools || [];
  }

  async function callTool(name, args = {}) {
    const response = await request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`${name} failed: ` + JSON.stringify(response.error));
    return unwrap(response);
  }

  function close() {
    try { child.kill(); } catch {}
  }

  return { initialize, listTools, callTool, close, skillRoot, serverPath };
}
