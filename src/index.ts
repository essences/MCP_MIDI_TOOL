import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendItem, getItemById, readManifest, resolveMidiDir, resolveExportDir, resolveBaseDir } from "./storage.js";
// CoreMIDI (node-midi) は動的 import（macOS以外やCIでの存在を許容）
let MidiOutput: any = null;
async function loadMidi() {
  if (MidiOutput) return MidiOutput;
  try {
    const mod: any = await import('midi');
    // ESM/CJS どちらの形でも Output を解決
    const Out = mod?.Output || mod?.default?.Output;
    MidiOutput = typeof Out === 'function' ? Out : null;
  } catch {
    MidiOutput = null;
  }
  return MidiOutput;
}

// 同一プロセス内の直近保存レコードのインメモリ索引（テストの並列実行耐性向上のため）
type ItemRec = { id: string; name: string; path: string; bytes: number; createdAt: string };
const inMemoryIndex = new Map<string, ItemRec>();

// マニフェストは storage.ts 経由で参照（getItemById/readManifest）

// Minimal MCP server with tools: store_midi, get_midi, list_midi, export_midi, list_devices
async function main() {
  const transport = new StdioServerTransport();
  const server = new Server(
    { name: "mcp-midi-tool", version: "0.1.0" },
  // prompts/resources を明示してクライアント側の探索フローと互換性を持たせる
  { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );

  

  // fallback handler for tools/call
  (server as any).fallbackRequestHandler = async (request: any) => {
    // Claude での表示互換: tools/call のレスポンスに content 配列を付与
    const wrap = (data: any) => ({
      ...data,
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    });
    // Claude Desktop からの tools/list / resources/list / prompts/list への応答
    if (request.method === "tools/list") {
      const tools: any[] = [
        { name: "store_midi", description: "base64のMIDIを保存し、fileIdを返す", inputSchema: { type: "object", properties: { base64: { type: "string" }, name: { type: "string" } }, required: ["base64"] } },
        { name: "get_midi", description: "fileIdでMIDIメタ情報と任意でbase64を返す", inputSchema: { type: "object", properties: { fileId: { type: "string" }, includeBase64: { type: "boolean" } }, required: ["fileId"] } },
        { name: "list_midi", description: "保存済みMIDIの一覧（ページング）", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } } },
        { name: "export_midi", description: "fileIdをdata/exportへコピー", inputSchema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } },
        { name: "list_devices", description: "MIDI出力デバイス一覧（暫定）", inputSchema: { type: "object", properties: {} } },
  { name: "playback_midi", description: "MIDI再生開始（PoC: durationMsで長さ指定可）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, portName: { type: "string" }, durationMs: { type: "number" } }, required: ["fileId"] } },
        { name: "stop_playback", description: "playbackIdを停止", inputSchema: { type: "object", properties: { playbackId: { type: "string" } }, required: ["playbackId"] } },
        { name: "find_midi", description: "名前でMIDIを検索（部分一致）", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
      ];
      return { tools } as any;
    }
    if (request.method === "resources/list") {
      return { resources: [] } as any;
    }
    if (request.method === "prompts/list") {
      // 現時点ではプロンプトは未提供。空配列を返す。
      return { prompts: [] } as any;
    }
    if (request.method === "prompts/get") {
      // 利用予定なし。呼ばれた場合は存在しない旨のエラーを返す。
      throw new Error("Prompt not found");
    }

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

  const midiDir = resolveMidiDir();
  const absPath = path.join(midiDir, nameWithExt);
  await fs.mkdir(midiDir, { recursive: true });
      await fs.writeFile(absPath, data);

      const fileId = randomUUID();
  // ルートは storage.resolveBaseDir() 起点で data 相対を記録
  const base = resolveBaseDir();
  const relPath = path.relative(base, absPath);
      const createdAt = new Date().toISOString();
      const bytes = data.byteLength;

      // Update manifest
  const record = { id: fileId, name: nameWithExt, path: relPath, bytes, createdAt };
  await appendItem(record);

  // インメモリにも格納
  inMemoryIndex.set(fileId, record);

  return wrap({ ok: true, fileId, path: relPath, bytes, createdAt }) as any;
    }

    // get_midi: retrieve file metadata and optionally base64 content
    if (name === "get_midi") {
      const fileId: string | undefined = args?.fileId;
      const includeBase64: boolean = !!args?.includeBase64;
      
      if (!fileId) throw new Error("'fileId' is required for get_midi");

  let item: ItemRec | undefined = inMemoryIndex.get(fileId);
  if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      
      if (!item) throw new Error(`fileId not found: ${fileId}`);

  const absPath = path.resolve(resolveBaseDir(), item!.path);
      const buf = includeBase64 ? await fs.readFile(absPath) : undefined;
      const base64 = includeBase64 && buf ? buf.toString("base64") : undefined;

      return wrap({
        ok: true,
        fileId: item.id,
        name: item.name,
        path: item.path,
        bytes: item.bytes,
        createdAt: item.createdAt,
        ...(includeBase64 && base64 ? { base64 } : {}),
      }) as any;
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
  return wrap({ ok: true, total, items: slice }) as any;
    }

    // export_midi: copy file to data/export directory
    if (name === "export_midi") {
      const fileId: string | undefined = args?.fileId;
      
      if (!fileId) throw new Error("'fileId' is required for export_midi");

  const item = await getItemById(fileId);
      
      if (!item) throw new Error(`fileId not found: ${fileId}`);

  const srcAbs = path.resolve(resolveBaseDir(), item.path);
  const exportDir = resolveExportDir();
  await fs.mkdir(exportDir, { recursive: true });
      const destAbs = path.join(exportDir, item.name);
      await fs.copyFile(srcAbs, destAbs);
  const exportPath = path.relative(resolveBaseDir(), destAbs);

  return wrap({ ok: true, exportPath }) as any;
    }

    // list_devices: CoreMIDI output devices (macOS only)
    if (name === "list_devices") {
      const devices: Array<{ id: string; name: string }> = [];
      if (process.platform === "darwin") {
        try {
          const Out = await loadMidi();
          if (Out) {
            const out = new Out();
            const count = typeof out.getPortCount === "function" ? out.getPortCount() : 0;
            for (let i = 0; i < count; i++) {
              try {
                const n = out.getPortName(i);
                devices.push({ id: String(i), name: String(n) });
              } catch {}
            }
          }
        } catch {}
        // フォールバック（少なくとも1つ返す）
        if (devices.length === 0) {
          devices.push({ id: "iac-bus-1", name: "IAC Driver Bus 1" });
        }
      }
      return wrap({ ok: true, devices }) as any;
    }

    // playback_midi: start MIDI playback (stubbed)
  if (name === "playback_midi") {
  const fileId: string | undefined = args?.fileId;
  const portName: string | undefined = args?.portName;
  const durationMsRaw = args?.durationMs;
  const durationMs = Number.isFinite(Number(durationMsRaw)) && Number(durationMsRaw) > 0 ? Math.min(Number(durationMsRaw), 2000) : 300;
      if (!fileId) throw new Error("'fileId' is required for playback_midi");

  // ファイル存在チェック（インメモリ→ストレージ）
  let item: ItemRec | undefined = inMemoryIndex.get(fileId);
  if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      // macOSで node-midi が利用可能な場合のみ、即時に開閉する簡易送出でPoC
      let playbackId = randomUUID();
      if (process.platform === 'darwin') {
        const Out = await loadMidi();
        if (Out) {
          const out = new Out();
          const ports = out.getPortCount();
          // ポート選択: 指定があれば部分一致（大文字小文字無視）、無ければIAC/Network/Virtual優先、無ければ0
          let target = 0;
          const pickByHint = (hint: string) => {
            for (let i = 0; i < ports; i++) {
              try {
                const name = out.getPortName(i);
                if (String(name).toLowerCase().includes(hint)) return i;
              } catch {}
            }
            return -1;
          };
          if (typeof portName === 'string' && portName.length > 0) {
            const wanted = pickByHint(String(portName).toLowerCase());
            if (wanted >= 0) target = wanted;
          } else {
            const pref = pickByHint('iac');
            const net = pref < 0 ? pickByHint('network') : pref;
            const vir = net < 0 ? pickByHint('virtual') : net;
            if (vir >= 0) target = vir;
          }
          try {
            out.openPort(target);
            // 簡易確認: Middle C を短く鳴らす（Note On/Off）
            out.sendMessage([0x90, 60, 100]);
            // 指定時間だけ維持
            await new Promise(res => setTimeout(res, durationMs));
            out.sendMessage([0x80, 60, 0]);
          } finally {
            try { out.closePort(); } catch {}
          }
        }
      }

      // メモリ状態に記録
      (globalThis as any).__playbacks = (globalThis as any).__playbacks || new Map();
      (globalThis as any).__playbacks.set(playbackId, { fileId, portName: portName || null, startedAt: Date.now() });

  return wrap({ ok: true, playbackId }) as any;
    }

    // stop_playback: stop a running playback (stubbed)
    if (name === "stop_playback") {
      const playbackId: string | undefined = args?.playbackId;
      if (!playbackId) throw new Error("'playbackId' is required for stop_playback");
      const map: Map<string, any> | undefined = (globalThis as any).__playbacks;
      if (map && map.has(playbackId)) map.delete(playbackId);
  return wrap({ ok: true }) as any;
    }

    // find_midi: name部分一致で候補を返す（UX補助）
    if (name === "find_midi") {
      const q: string = String(args?.query || "").trim();
      if (!q) return wrap({ ok: true, items: [] }) as any;
      const manifest = await readManifest();
      const qLower = q.toLowerCase();
      const items = manifest.items.filter(i => i.name.toLowerCase().includes(qLower));
  return wrap({ ok: true, items }) as any;
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
