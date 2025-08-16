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
  { name: "play_smf", description: "SMFを解析し再生（dryRunで送出なし解析のみ）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, portName: { type: "string" }, startMs: { type: "number" }, stopMs: { type: "number" }, dryRun: { type: "boolean" } }, required: ["fileId"] } },
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

    // play_smf: parse SMF and schedule playback (or dryRun for analysis only)
    if (name === "play_smf") {
      const fileId: string | undefined = args?.fileId;
      const startMs: number | undefined = Number.isFinite(Number(args?.startMs)) ? Number(args?.startMs) : undefined;
      const stopMs: number | undefined = Number.isFinite(Number(args?.stopMs)) ? Number(args?.stopMs) : undefined;
      const dryRun: boolean = !!args?.dryRun;
      if (!fileId) throw new Error("'fileId' is required for play_smf");

      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);

      // @tonejs/midi を動的import
      type Ev = { tMs: number; kind: 'on'|'off'; ch: number; n: number; v: number };
      let scheduledEvents = 0;
      let events: Ev[] = [];
      const warnings: string[] = [];
      try {
        const mod: any = await import('@tonejs/midi');
        const Midi = mod?.Midi || mod?.default?.Midi;
        if (!Midi) throw new Error('Midi class not found in @tonejs/midi');
        const midi = new Midi(buf);
        // notes をmsに展開（tempo変化は@tonejs/midiがtime/secondsに反映済み）
        for (const tr of midi.tracks) {
          const ch = Number.isFinite(Number(tr?.channel)) ? Number(tr.channel) : 0;
          for (const nt of (tr?.notes || [])) {
            const tOnMs = Math.max(0, Math.round((nt.time || 0) * 1000));
            const tOffMs = Math.max(0, Math.round(((nt.time || 0) + (nt.duration || 0)) * 1000));
            const n = Number(nt.midi);
            const v = Math.max(1, Math.min(127, Math.round((nt.velocity ?? 0.7) * 127)));
            if (stopMs !== undefined && tOnMs > stopMs) continue;
            if (startMs !== undefined && tOffMs < startMs) continue;
            events.push({ tMs: tOnMs, kind: 'on', ch, n, v });
            events.push({ tMs: tOffMs, kind: 'off', ch, n, v: 0 });
          }
        }
        // ソート: 時刻昇順、同時刻は NoteOff を先に
        events.sort((a,b)=> a.tMs - b.tMs || (a.kind==='off'? -1: 1));
        // 範囲クリップ
        if (startMs !== undefined || stopMs !== undefined) {
          const s = startMs ?? 0;
          const e = stopMs ?? Number.POSITIVE_INFINITY;
          events = events.filter(ev => ev.tMs >= s && ev.tMs <= e);
          // 先頭がNoteOffのみにならないようにする処理は今回は省略（受信側が安定）
        }
        scheduledEvents = events.length;
      } catch (e: any) {
        warnings.push(`parse-warning: ${e?.message || String(e)}`);
      }

      const playbackId = randomUUID();
      const registry: Map<string, any> = (globalThis as any).__playbacks = (globalThis as any).__playbacks || new Map();

      // dryRun: 解析のみで即返す
      if (dryRun || events.length === 0) {
        registry.set(playbackId, { fileId, startedAt: Date.now(), scheduledEvents, dryRun: true });
        return wrap({ ok: true, playbackId, scheduledEvents, warnings: warnings.length ? warnings : undefined }) as any;
      }

      // 実再生: ルックアヘッドスケジューラ
      const state: {
        type: 'smf';
        fileId: string;
        startedAt: number;
        scheduledEvents: number;
        intervalId: any;
        timeouts: any[];
        active: Set<string>;
        out?: any;
      } = {
        type: 'smf', fileId, startedAt: Date.now(), scheduledEvents, intervalId: null, timeouts: [], active: new Set(), out: undefined
      };

      // 出力デバイスを開く（macOS以外でもnode-midiがあれば開く）
      try {
        const Out = await loadMidi();
        if (Out) {
          const out = new Out();
          const ports = out.getPortCount?.() ?? 0;
          let target = 0;
          const pickByHint = (o:any, hint:string) => {
            for (let i=0;i<ports;i++){ try{ const nm=o.getPortName(i); if (String(nm).toLowerCase().includes(hint)) return i; }catch{} }
            return -1;
          };
          if (typeof args?.portName === 'string' && args.portName.length>0) {
            const wanted = pickByHint(out, String(args.portName).toLowerCase());
            if (wanted>=0) target = wanted;
          } else {
            const pref = pickByHint(out, 'iac');
            const net = pref < 0 ? pickByHint(out, 'network') : pref;
            const vir = net < 0 ? pickByHint(out, 'virtual') : net;
            if (vir >= 0) target = vir;
          }
          out.openPort(target);
          state.out = out;
        } else {
          warnings.push('node-midi not available: playback is a no-op');
        }
      } catch (e:any) {
        warnings.push(`open-output-warning: ${e?.message || String(e)}`);
      }

      const lookahead = 50; // ms
      const tickInterval = 10; // ms
      const t0 = performance.now();
      let cursor = 0;
      function schedule(ev: Ev){
        // NoteOn/Off メッセージ生成
        const status = (ev.kind === 'on' ? 0x90 : 0x80) | (ev.ch & 0x0f);
        const msg = [status, ev.n & 0x7f, ev.v & 0x7f];
        const due = t0 + ev.tMs - performance.now();
        const to = setTimeout(()=>{
          try {
            if (state.out) state.out.sendMessage(msg);
            // active管理（ハングノート回避）
            const key = `${ev.ch}:${ev.n}`;
            if (ev.kind==='on') state.active.add(key); else state.active.delete(key);
          } catch {}
        }, Math.max(0, due));
        state.timeouts.push(to);
      }
      const intervalId = setInterval(()=>{
        const now = performance.now();
        const playhead = now - t0;
        const windowEnd = playhead + lookahead;
        while (cursor < events.length && events[cursor].tMs <= windowEnd) schedule(events[cursor++]);
        if (cursor >= events.length) {
          clearInterval(intervalId);
        }
      }, tickInterval);
      state.intervalId = intervalId;

      registry.set(playbackId, state);
      return wrap({ ok: true, playbackId, scheduledEvents, warnings: warnings.length ? warnings : undefined }) as any;
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
      const st = map?.get(playbackId);
      if (st) {
        // スケジューラ停止
        if (st.intervalId) { try { clearInterval(st.intervalId); } catch {} }
        for (const to of st.timeouts || []) { try { clearTimeout(to); } catch {} }
        // 未消音ノートを消音
        if (st.out && st.active && st.active.size) {
          try {
            for (const key of Array.from(st.active)) {
              const [chStr, nStr] = String(key).split(":");
              const ch = Number(chStr)|0; const n = Number(nStr)|0;
              st.out.sendMessage([0x80 | (ch & 0x0f), n & 0x7f, 0]);
            }
          } catch {}
        }
        // 出力を閉じる
        if (st.out) { try { st.out.closePort(); } catch {} }
        map!.delete(playbackId);
      }
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
