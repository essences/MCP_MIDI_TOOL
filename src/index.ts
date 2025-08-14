import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Minimal MCP server with no tools yet, only handshake/info
async function main() {
  const transport = new StdioServerTransport();
  const server = new Server(
    { name: "mcp-midi-tool", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // fallbackで tools/call を最小実装（store_midi のみ対応）
  (server as any).fallbackRequestHandler = async (request: any) => {
    if (request.method !== "tools/call") return undefined;
    const { name, arguments: args } = request.params as { name: string; arguments?: any };

    // store_midi: Base64を保存して manifest を更新
    if (name === "store_midi") {
      const base64: string | undefined = args?.base64;
      const fileNameInput: string | undefined = args?.name;
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB
      if (!base64) throw new Error("'base64' is required for store_midi (path input not yet supported)");

      const data = Buffer.from(base64, "base64");
      if (!Number.isFinite(data.byteLength) || data.byteLength <= 0) throw new Error("Decoded data is empty or invalid");
      if (data.byteLength > MAX_BYTES) throw new Error(`MIDI size exceeds 10MB limit: ${data.byteLength}`);

      const safeName = (fileNameInput && fileNameInput.trim().length > 0 ? fileNameInput.trim() : `untitled-${Date.now()}.mid`);
      const nameWithExt = safeName.toLowerCase().endsWith(".mid") ? safeName : `${safeName}.mid`;

      const midiDir = path.resolve(process.cwd(), "data", "midi");
      const absPath = path.join(midiDir, nameWithExt);
      await fs.mkdir(midiDir, { recursive: true });
      await fs.writeFile(absPath, data);

      const fileId = randomUUID();
      const relPath = path.relative(process.cwd(), absPath);
      const createdAt = new Date().toISOString();
      const bytes = data.byteLength;

      const manifestPath = path.resolve(process.cwd(), "data", "manifest.json");
      let manifest: any = { items: [] };
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        manifest = JSON.parse(raw);
        if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.items)) manifest = { items: [] };
      } catch {}

      manifest.items.push({ id: fileId, name: nameWithExt, path: relPath, bytes, createdAt });
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      return { ok: true, fileId, path: relPath, bytes, createdAt } as any;
    }

    // get_midi: manifest から検索してメタ情報（および任意でbase64）を返却
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

  throw new Error(`Tool ${name} not found`);
  };

  await server.connect(transport);

  // Keep process alive until client closes the connection
  await new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
  transport.onerror = (err: Error) => reject(err);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
