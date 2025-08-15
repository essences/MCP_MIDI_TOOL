import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendItem, getItemById, readManifest } from "./storage.js";

// 同一プロセス内の直近保存レコードのインメモリ索引（テストの並列実行耐性向上のため）
type ItemRec = { id: string; name: string; path: string; bytes: number; createdAt: string };
const inMemoryIndex = new Map<string, ItemRec>();

// プロセス分離されたマニフェスト（並列テストによる破損回避）
function getManifestPath() {
  const file = process.env.MCP_MIDI_MANIFEST || `manifest.${process.pid}.json`;
  return path.resolve(process.cwd(), "data", file);
}

// Minimal MCP server with tools: store_midi, get_midi, list_midi, export_midi, list_devices
async function main() {
  const transport = new StdioServerTransport();
  const server = new Server(
    { name: "mcp-midi-tool", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // fallback handler for tools/call
  (server as any).fallbackRequestHandler = async (request: any) => {
    if (request.method !== "tools/call") return undefined;
    const { name, arguments: args } = request.params as { name: string; arguments?: any };

    // store_midi: save base64 to data/midi and update manifest
    if (name === "store_midi") {
      const base64: string | undefined = args?.base64;
      const fileNameInput: string | undefined = args?.name;
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB
      
      if (!base64) throw new Error("'base64' is required for store_midi");
      
      const data = Buffer.from(base64, "base64");
      if (!Number.isFinite(data.byteLength) || data.byteLength <= 0) {
        throw new Error("Decoded data is empty or invalid");
      }
      if (data.byteLength > MAX_BYTES) {
        throw new Error(`MIDI size exceeds 10MB limit: ${data.byteLength}`);
      }

      const safeName = (fileNameInput && fileNameInput.trim().length > 0 
        ? fileNameInput.trim() 
        : `untitled-${Date.now()}.mid`);
      const nameWithExt = safeName.toLowerCase().endsWith(".mid") 
        ? safeName 
        : `${safeName}.mid`;

      const midiDir = path.resolve(process.cwd(), "data", "midi");
      const absPath = path.join(midiDir, nameWithExt);
      await fs.mkdir(midiDir, { recursive: true });
      await fs.writeFile(absPath, data);

      const fileId = randomUUID();
      const relPath = path.relative(process.cwd(), absPath);
      const createdAt = new Date().toISOString();
      const bytes = data.byteLength;

      // Update manifest
  const record = { id: fileId, name: nameWithExt, path: relPath, bytes, createdAt };
  await appendItem(record);

  // インメモリにも格納
  inMemoryIndex.set(fileId, record);

      return { ok: true, fileId, path: relPath, bytes, createdAt } as any;
    }

    // get_midi: retrieve file metadata and optionally base64 content
    if (name === "get_midi") {
      const fileId: string | undefined = args?.fileId;
      const includeBase64: boolean = !!args?.includeBase64;
      
      if (!fileId) throw new Error("'fileId' is required for get_midi");

  let item: ItemRec | undefined = inMemoryIndex.get(fileId);
  if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(process.cwd(), item!.path);
      const buf = includeBase64 ? await fs.readFile(absPath) : undefined;
      const base64 = includeBase64 && buf ? buf.toString("base64") : undefined;

      return {
        ok: true,
        fileId: item.id,
        name: item.name,
        path: item.path,
        bytes: item.bytes,
        createdAt: item.createdAt,
        ...(includeBase64 && base64 ? { base64 } : {}),
      } as any;
    }

    // list_midi: paginated list of MIDI files from manifest
    if (name === "list_midi") {
      const limitRaw = args?.limit;
      const offsetRaw = args?.offset;
      const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0 
        ? Math.min(Number(limitRaw), 100) 
        : 20;
      const offset = Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) >= 0 
        ? Number(offsetRaw) 
        : 0;

  let items: Array<{ id: string; name: string; path: string; bytes: number; createdAt: string }> = [];
  try { items = (await readManifest()).items; } catch { items = []; }

      const total = items.length;
      const slice = items.slice(offset, offset + limit);
      return { ok: true, total, items: slice } as any;
    }

    // export_midi: copy file to data/export directory
    if (name === "export_midi") {
      const fileId: string | undefined = args?.fileId;
      
      if (!fileId) throw new Error("'fileId' is required for export_midi");

  const item = await getItemById(fileId);
      
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const srcAbs = path.resolve(process.cwd(), item.path);
      const exportDir = path.resolve(process.cwd(), "data", "export");
      await fs.mkdir(exportDir, { recursive: true });
      const destAbs = path.join(exportDir, item.name);
      await fs.copyFile(srcAbs, destAbs);
      const exportPath = path.relative(process.cwd(), destAbs);

      return { ok: true, exportPath } as any;
    }

    // list_devices: CoreMIDI output devices (macOS only)
    if (name === "list_devices") {
      const devices: Array<{ id: string; name: string }> = [];
      
      if (process.platform === "darwin") {
        // Minimal implementation with fixed devices
        // Real implementation would use node-midi or AudioToolbox FFI
        devices.push(
          { id: "builtin-synth", name: "Built-in Synthesizer" },
          { id: "iac-bus-1", name: "IAC Driver Bus 1" }
        );
      }
      
      return { ok: true, devices } as any;
    }

    // playback_midi: start MIDI playback (stubbed)
    if (name === "playback_midi") {
      const fileId: string | undefined = args?.fileId;
      const portName: string | undefined = args?.portName;
      if (!fileId) throw new Error("'fileId' is required for playback_midi");

      // ファイル存在チェック
      const manifestPath = getManifestPath();
      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) {
        try {
          const raw = await fs.readFile(manifestPath, "utf8");
          const manifest = JSON.parse(raw) as { items: ItemRec[] };
          item = manifest.items.find((x) => x.id === fileId);
        } catch {}
      }
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      // macOS 以外はダミー成功（実再生は未対応）
      const playbackId = randomUUID();
      // 簡易的にメモリに開始状態を記録
      (globalThis as any).__playbacks = (globalThis as any).__playbacks || new Map();
      (globalThis as any).__playbacks.set(playbackId, { fileId, portName: portName || null, startedAt: Date.now() });

      return { ok: true, playbackId } as any;
    }

    // stop_playback: stop a running playback (stubbed)
    if (name === "stop_playback") {
      const playbackId: string | undefined = args?.playbackId;
      if (!playbackId) throw new Error("'playbackId' is required for stop_playback");
      const map: Map<string, any> | undefined = (globalThis as any).__playbacks;
      if (map && map.has(playbackId)) map.delete(playbackId);
      return { ok: true } as any;
    }

    throw new Error(`Tool ${name} not found`);
  };

  await server.connect(transport);

  // Keep process alive until client closes connection
  await new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
    transport.onerror = (err: Error) => reject(err);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
