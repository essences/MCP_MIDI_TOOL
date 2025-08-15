import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
      const manifestPath = path.resolve(process.cwd(), "data", "manifest.json");
      let manifest: any = { items: [] };
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        manifest = JSON.parse(raw);
        if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.items)) {
          manifest = { items: [] };
        }
      } catch {}

      manifest.items.push({ id: fileId, name: nameWithExt, path: relPath, bytes, createdAt });
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      return { ok: true, fileId, path: relPath, bytes, createdAt } as any;
    }

    // get_midi: retrieve file metadata and optionally base64 content
    if (name === "get_midi") {
      const fileId: string | undefined = args?.fileId;
      const includeBase64: boolean = !!args?.includeBase64;
      
      if (!fileId) throw new Error("'fileId' is required for get_midi");

      const manifestPath = path.resolve(process.cwd(), "data", "manifest.json");
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as { items: Array<{ id: string; name: string; path: string; bytes: number; createdAt: string }> };
      const item = manifest.items.find((x) => x.id === fileId);
      
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(process.cwd(), item.path);
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

      const manifestPath = path.resolve(process.cwd(), "data", "manifest.json");
      let items: Array<{ id: string; name: string; path: string; bytes: number; createdAt: string }> = [];
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(raw);
        if (manifest && Array.isArray(manifest.items)) items = manifest.items;
      } catch {}

      const total = items.length;
      const slice = items.slice(offset, offset + limit);
      return { ok: true, total, items: slice } as any;
    }

    // export_midi: copy file to data/export directory
    if (name === "export_midi") {
      const fileId: string | undefined = args?.fileId;
      
      if (!fileId) throw new Error("'fileId' is required for export_midi");

      const manifestPath = path.resolve(process.cwd(), "data", "manifest.json");
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as { items: Array<{ id: string; name: string; path: string }> };
      const item = manifest.items.find((x) => x.id === fileId);
      
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
