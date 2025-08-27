import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendItem, getItemById, readManifest, resolveMidiDir, resolveExportDir, resolveBaseDir, writeManifest } from "./storage.js";
import { zSong } from "./jsonSchema.js";
import { encodeToSmfBinary } from "./jsonToSmf.js";
import { decodeSmfToJson } from "./smfToJson.js";
import { compileScoreToJsonMidi } from "./scoreToJsonMidi.js";
// CoreMIDI (node-midi) は動的 import（macOS以外やCIでの存在を許容）
// node-midi (Input/Output) を遅延ロード（CI/環境未対応時は null を許容）
let MidiOutput: any = null;
let MidiInput: any = null;
async function loadMidi() {
  if (MidiOutput || MidiInput) return { MidiOutput, MidiInput };
  try {
    const mod: any = await import('midi');
    // ESM/CJS どちらの形でもクラス解決
    const Out = mod?.Output || mod?.default?.Output;
    const In = mod?.Input || mod?.default?.Input;
    MidiOutput = typeof Out === 'function' ? Out : null;
    MidiInput = typeof In === 'function' ? In : null;
  } catch {
    MidiOutput = null; MidiInput = null;
  }
  return { MidiOutput, MidiInput };
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
    // エラー分類（メッセージ/例外内容からコードとヒントを推定）
    const classifyError = (tool: string, err: any): { code: string; message: string; hint?: string; issues?: any[] } => {
      const rawMsg = (err?.message || String(err) || "").trim();
      const lower = rawMsg.toLowerCase();
      let code = "INTERNAL_ERROR";
      let hint: string | undefined;
      // 簡易的に Zod 風 issue 配列を抽出（err.issues があれば利用）
      const issues: any[] | undefined = Array.isArray(err?.issues) ? err.issues.map((i: any) => ({ path: i.path, message: i.message })) : undefined;
      if (/validation failed|compile failed|json validation failed/.test(lower)) {
        code = "VALIDATION_ERROR";
        hint = "入力JSON/Score DSL のスキーマを README と docs/specs を参照して修正してください (format指定推奨)";
      } else if (/not found/i.test(rawMsg)) {
        code = "NOT_FOUND";
        if (lower.includes("fileid")) hint = "有効な fileId を list_midi や json_to_smf の結果から指定してください";
      } else if (/required/.test(lower)) {
        code = "MISSING_PARAMETER";
        const m = rawMsg.match(/'(\w+)' is required/i); if (m) hint = `パラメータ ${m[1]} を arguments に追加してください`;
      } else if (/invalid note name|unsupported note item|invalid json/i.test(lower)) {
        code = "INPUT_FORMAT_ERROR";
        hint = "音名表記やJSON構造を再確認してください (例: C4, F#3, Bb5)";
      } else if (/size exceeds|too large|exceeds/i.test(lower)) {
        code = "LIMIT_EXCEEDED";
        hint = "データサイズを削減するか分割して append_to_smf を利用してください";
      } else if (/node-midi not available/i.test(lower)) {
        code = "DEVICE_UNAVAILABLE";
        hint = "出力デバイス利用不可。macOS/IAC かサポート環境で再試行、または dryRun を使用";
      }
      return { code, message: rawMsg, hint, ...(issues ? { issues } : {}) };
    };
    // Claude Desktop からの tools/list / resources/list / prompts/list への応答
    if (request.method === "tools/list") {
  const tools: any[] = [
    { name: "store_midi", description: "base64のMIDIを保存し、fileIdを返す", inputSchema: { type: "object", properties: { base64: { type: "string" }, name: { type: "string" } }, required: ["base64"] } },
  { name: "json_to_smf", description: "JSON曲データをSMFにコンパイルし保存", inputSchema: { type: "object", properties: { json: { anyOf: [ { type: "object" }, { type: "string" } ] }, format: { type: "string", enum: ["json_midi_v1", "score_dsl_v1"] }, name: { type: "string" } , overwrite: { type: "boolean" } }, required: ["json"] } },
  { name: "smf_to_json", description: "SMFを解析してJSON曲データに変換", inputSchema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } },
  { name: "append_to_smf", description: "既存SMFへJSON/Score DSLチャンクを追記（指定tick/末尾）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, json: { anyOf: [ { type: "object" }, { type: "string" } ] }, format: { type: "string", enum: ["json_midi_v1", "score_dsl_v1"] }, atTick: { type: "number" }, atEnd: { type: "boolean" }, gapTicks: { type: "number" }, trackIndex: { type: "number" }, outputName: { type: "string" } }, required: ["fileId", "json"] } },
  { name: "insert_sustain", description: "CC64(サスティン)のON/OFFを範囲に挿入", inputSchema: { type: "object", properties: { fileId: { type: "string" }, ranges: { type: "array", items: { type: "object", properties: { startTick: { type: "number" }, endTick: { type: "number" }, channel: { type: "number" }, trackIndex: { type: "number" }, valueOn: { type: "number" }, valueOff: { type: "number" } }, required: ["startTick", "endTick"] } } }, required: ["fileId", "ranges"] } },
  { name: "insert_cc", description: "任意のCC番号の値を範囲に挿入（ON/OFF相当の2値）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, controller: { type: "number" }, ranges: { type: "array", items: { type: "object", properties: { startTick: { type: "number" }, endTick: { type: "number" }, channel: { type: "number" }, trackIndex: { type: "number" }, valueOn: { type: "number" }, valueOff: { type: "number" } }, required: ["startTick", "endTick"] } } }, required: ["fileId", "controller", "ranges"] } },
        { name: "get_midi", description: "fileIdでMIDIメタ情報と任意でbase64を返す", inputSchema: { type: "object", properties: { fileId: { type: "string" }, includeBase64: { type: "boolean" } }, required: ["fileId"] } },
        { name: "list_midi", description: "保存済みMIDIの一覧（ページング）", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } } },
        { name: "export_midi", description: "fileIdをdata/exportへコピー", inputSchema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } },
        { name: "list_devices", description: "MIDI出力デバイス一覧（暫定）", inputSchema: { type: "object", properties: {} } },
  { name: "play_smf", description: "SMFを解析し再生（dryRunで送出なし解析のみ）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, portName: { type: "string" }, startMs: { type: "number" }, stopMs: { type: "number" }, dryRun: { type: "boolean" }, schedulerLookaheadMs: { type: "number" }, schedulerTickMs: { type: "number" } }, required: ["fileId"] } },
  { name: "get_playback_status", description: "再生ステータスを取得（進捗・総尺・デバイスなど）", inputSchema: { type: "object", properties: { playbackId: { type: "string" } }, required: ["playbackId"] } },
  { name: "playback_midi", description: "MIDI再生開始（PoC: durationMsで長さ指定可）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, portName: { type: "string" }, durationMs: { type: "number" } }, required: ["fileId"] } },
    { name: "trigger_notes", description: "単発でノート（単音/和音）を即時送出（耳トレ用・高速ワンショット）", inputSchema: { type: "object", properties: { notes: { anyOf: [ { type: "array", items: { type: "string" } }, { type: "array", items: { type: "number" } } ] }, velocity: { type: "number" }, durationMs: { type: "number" }, channel: { type: "number" }, program: { type: "number" }, portName: { type: "string" }, transpose: { type: "number" }, dryRun: { type: "boolean" } }, required: ["notes"] } },
  { name: "list_input_devices", description: "MIDI入力デバイス一覧（暫定）", inputSchema: { type: "object", properties: {} } },
  { name: "start_device_single_capture", description: "MIDI入力デバイスから単発(単音/和音)キャプチャ開始 (onsetWindow内で和音判定)", inputSchema: { type: "object", properties: { portName: { type: "string" }, onsetWindowMs: { type: "number" }, silenceMs: { type: "number" }, maxWaitMs: { type: "number" } } } },
  { name: "start_single_capture", description: "リアルタイム単発(単音/和音)キャプチャ開始 (onsetWindow内を和音と判定)", inputSchema: { type: "object", properties: { onsetWindowMs: { type: "number" }, silenceMs: { type: "number" }, maxWaitMs: { type: "number" } } } },
  { name: "feed_single_capture", description: "(テスト/内部) start_single_capture中の擬似MIDIイベント投入", inputSchema: { type: "object", properties: { captureId: { type: "string" }, events: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["on","off"] }, note: { type: "number" }, velocity: { type: "number" }, at: { type: "number" } }, required: ["kind","note","at"] } } }, required: ["captureId","events"] } },
  { name: "get_single_capture_status", description: "単発キャプチャ状態取得(完了時に結果返却)", inputSchema: { type: "object", properties: { captureId: { type: "string" } }, required: ["captureId"] } },
        { name: "stop_playback", description: "playbackIdを停止", inputSchema: { type: "object", properties: { playbackId: { type: "string" } }, required: ["playbackId"] } },
        { name: "find_midi", description: "名前でMIDIを検索（部分一致）", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
      ];
      return { tools } as any;
    }
    if (request.method === "resources/list") {
      return { resources: [] } as any;
    }
    if (request.method === "prompts/list") {
      // MCPクライアントから参照できる簡易プロンプトを提供
      const prompts = [
        { name: "score_dsl_quick_ref", description: "Score DSL v1の注意点（beatは整数、unit/offset、未対応articulation）" },
        { name: "trigger_notes_test_v9", description: "trigger_notes 検証用の手順（v9）" },
  { name: "single_capture_test_v1", description: "start_single_capture / feed / status / timeout の検証手順" },
      ];
      return { prompts } as any;
    }
    if (request.method === "prompts/get") {
      const p = request.params as { name?: string };
      const name = String(p?.name || "");
      if (name === "score_dsl_quick_ref") {
        const text = [
          "Score DSL v1 クイックリファレンス:",
          "- start.beat は整数のみ。半拍/3連などは unit/offset で指定",
          "  例) 2.5拍 → { start: { bar:1, beat:2, unit:2, offset:1 } }",
          "  例) 3連の2つ目/3つ目 → unit:3, offset:1 / 2",
          "- articulation 許容: staccato | tenuto | legato | accent | marcato",
          "  （diminuendo 等は未対応。velocity 段階変更や cc で代替）",
          "- 音名は C4, F#3, Bb5, Ab4, Db5 など（0..127内）",
          "- 付点:dots=1(×1.5)/2(×1.75), 連符: tuplet: { inSpaceOf, play }",
          "詳細: docs/specs/score_dsl_v1.md を参照",
        ].join("\n");
        // Claude互換: messages.content[].text で返す
        return { prompt: { name, description: "Score DSL v1 クイックリファレンス", messages: [ { role: "user", content: [ { type: "text", text } ] } ] } } as any;
      }
      if (name === "trigger_notes_test_v9") {
        const text = [
          "trigger_notes v9 テスト手順（要約）:",
          "- 準備: ツール一覧で trigger_notes / list_devices / get_playback_status / stop_playback 確認",
          "- T-1: 単音ドライラン { notes:[\"C4\"], velocity:96, durationMs:150, dryRun:true }",
          "- T-2: 和音ドライラン（音名） { notes:[\"C4\",\"E4\",\"G4\"], durationMs:200, dryRun:true }",
          "- T-3: 和音ドライラン（数値+transpose） { notes:[60,64,67], transpose:12, dryRun:true }",
          "- T-4: 実送出: list_devices→port選択→trigger_notes 実行→get_playback_status→0.3s待機→stop_playback",
          "- T-5: 異常系: { notes:[\"H4\"], dryRun:true } （エラー期待）",
          "詳細: docs/prompts/claude_test_prompts_v9_trigger_notes.md を参照",
        ].join("\n");
        return { prompt: { name, description: "trigger_notes v9 テスト要約", messages: [ { role: "user", content: [ { type: "text", text } ] } ] } } as any;
      }
      if (name === "single_capture_test_v1") {
        const text = [
          "single_capture v1 テスト手順:",
          "前提: start_single_capture / feed_single_capture / get_single_capture_status ツールが tools/list に出現すること。",
          "",
          "1. キャプチャ開始 (和音想定)",
          "   tools/call:start_single_capture { onsetWindowMs:80, silenceMs:150, maxWaitMs:3000 }",
          "   → captureId を取得",
          "2. 疑似イベント投入 (同一和音): feed_single_capture events = on(60@10), on(64@25), on(67@55), off 群(300,305,310)",
          "3. 約500ms 待機後 get_single_capture_status { captureId } → done=true, reason=completed, notes=[60,64,67], isChord=true 確認",
          "4. onsetWindow外ノート無視: 新規 start → feed: on(60@5), off(60@150), on(64@200), off(64@260) → 300ms後 status → notes=[60], isChord=false",
          "5. タイムアウト: start_single_capture { maxWaitMs:400 } → 500ms待機 → status → reason=timeout, notes=[]",
          "6. エッジ: feed_single_capture で無効note (-1 や 200) 送出 → エラー (invalid note) 期待",
          "7. 進行中ポーリング: (和音ケースで) 100ms時点 status → done=false で reason 未設定",
          "8. 再取得: 完了後に再度 status → 同一 result が安定して返ること",
          "",
          "参考JSON例 (手動送信時):",
          "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"start_single_capture\",\"arguments\":{\"onsetWindowMs\":80,\"silenceMs\":150,\"maxWaitMs\":3000}}}",
          "",
          "品質観点:",
          "- onsetWindow 超過ノートは無視され result に含まれない",
          "- timeout 時 result.notes 空, durationMs=0 近傍 (現実装は0以上)",
          "- reason='completed'|'timeout' 以外は出ない",
          "- 再取得で状態変化しない (イミュータブル結果)",
        ].join("\n");
        return { prompt: { name, description: "single_capture v1 テスト手順", messages: [ { role: "user", content: [ { type: "text", text } ] } ] } } as any;
      }
      throw new Error("Prompt not found");
    }

  if (request.method !== "tools/call") return undefined;
  const { name, arguments: args } = request.params as { name: string; arguments?: any };
  try {
    // 便利: 音名→MIDI番号（簡易）
    function nameToMidiLocal(s: string): number | undefined {
      const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(s).trim());
      if (!m) return undefined;
      const letter = m[1].toUpperCase();
      const acc = m[2];
      const oct = parseInt(m[3], 10);
      const baseMap: Record<string, number> = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
      let sem = baseMap[letter];
      if (sem === undefined) return undefined;
      if (acc === '#') sem += 1; else if (acc === 'b') sem -= 1;
      const midi = 12 * (oct + 1) + sem;
      if (midi < 0 || midi > 127) return undefined;
      return midi;
    }

    // trigger_notes: 単発でNoteOn→一定時間後NoteOff（和音対応）
    if (name === "trigger_notes") {
      const rawNotes = args?.notes;
      if (!Array.isArray(rawNotes) || rawNotes.length === 0) throw new Error("'notes' must be a non-empty array");
      const channel = Math.max(0, Math.min(15, Number(args?.channel ?? 0) | 0));
      const velocity = Math.max(1, Math.min(127, Number(args?.velocity ?? 100) | 0));
      const durationMs = Math.max(20, Math.min(10000, Number(args?.durationMs ?? 500) | 0));
      const transpose = Number.isFinite(Number(args?.transpose)) ? (Number(args?.transpose) | 0) : 0;
      const program = Number.isFinite(Number(args?.program)) ? (Number(args?.program) | 0) : undefined;
      const dryRun = !!args?.dryRun;

      // normalize notes to midi numbers
      const notes: number[] = [];
      for (const n of rawNotes) {
        if (typeof n === 'number' && Number.isFinite(n)) notes.push(Math.max(0, Math.min(127, (n|0) + transpose)));
        else if (typeof n === 'string') {
          const m = nameToMidiLocal(n);
          if (m === undefined) throw new Error(`invalid note name: ${n}`);
          notes.push(Math.max(0, Math.min(127, m + transpose)));
        } else {
          throw new Error(`unsupported note item: ${String(n)}`);
        }
      }

      const warnings: string[] = [];
      const playbackId = randomUUID();
      const registry: Map<string, any> = (globalThis as any).__playbacks = (globalThis as any).__playbacks || new Map();

      if (dryRun) {
        registry.set(playbackId, { type: 'oneshot', startedAt: Date.now(), scheduledEvents: notes.length*2, totalDurationMs: durationMs, cursor: notes.length*2, lastSentIndex: notes.length*2 - 1, lookahead: 0, tickInterval: 0, portName: undefined, done: true });
        return wrap({ ok: true, playbackId, scheduledNotes: notes.length, durationMs, warnings: warnings.length ? warnings : undefined });
      }

      // 実送出
      let portNameResolved: string | undefined;
      try {
        const { MidiOutput: OutCls } = await loadMidi();
        if (!OutCls) {
          warnings.push('node-midi not available: trigger is a no-op');
        } else {
          const out = new OutCls();
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
          try { portNameResolved = String(out.getPortName?.(target)); } catch {}

          // optional program change
          if (Number.isFinite(program as number)) {
            out.sendMessage([0xC0 | (channel & 0x0f), (program as number) & 0x7f]);
          }

          // note on for each note
          for (const n of notes) {
            out.sendMessage([0x90 | (channel & 0x0f), n & 0x7f, velocity & 0x7f]);
          }
          // schedule note off after duration
          const timeouts: any[] = [];
          const to = setTimeout(()=>{
            try {
              // 互換性重視: Note Off(0x80)ではなく Note On(0x90) velocity 0 を優先送出
              for (const n of notes) {
                out.sendMessage([0x90 | (channel & 0x0f), n & 0x7f, 0]);
              }
              // 状態更新（activeをクリアしdone=true）
              try {
                const reg: Map<string, any> | undefined = (globalThis as any).__playbacks;
                const st = reg?.get(playbackId);
                if (st) {
                  if (st.active && typeof st.active.clear === 'function') st.active.clear();
                  st.done = true;
                }
              } catch {}
            } finally {
              try { out.closePort(); } catch {}
            }
          }, durationMs);
          timeouts.push(to);

          // registry for optional stop_playback
          registry.set(playbackId, { type: 'oneshot', startedAt: Date.now(), scheduledEvents: notes.length*2, totalDurationMs: durationMs, intervalId: null, timeouts, active: new Set(notes.map(n=> `${channel}:${n}`)), out, cursor: notes.length*2, lastSentIndex: notes.length*2 - 1, lastSentAt: durationMs, lookahead: 0, tickInterval: 0, portName: portNameResolved, done: false });
        }
      } catch (e:any) {
        warnings.push(`trigger-warning: ${e?.message || String(e)}`);
      }

      return wrap({ ok: true, playbackId, scheduledNotes: notes.length, durationMs, portName: portNameResolved, warnings: warnings.length ? warnings : undefined }) as any;
    }

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

    // json_to_smf: validate/compile based on explicit format (if provided), then SMF保存
    if (name === "json_to_smf") {
      let json = args?.json;
      const format: string | undefined = typeof args?.format === 'string' ? String(args.format) : undefined;
      if (typeof json === 'string') {
        // 文字列で来た場合はまずJSON.parseを試みる（どちらのフォーマットでもJSONである想定）
        try { json = JSON.parse(json); } catch { /* 後続のバリデーションで明示エラー */ }
      }
      const fileNameInput: string | undefined = args?.name;
      if (!json) throw new Error("'json' is required for json_to_smf");
      
      let song: any;
      if (format === 'json_midi_v1') {
        // 明示: JSON MIDI v1 として検証
        try {
          song = zSong.parse(json);
        } catch (e: any) {
          const issues = e?.issues?.map?.((i: any)=> `${i.path?.join?.('.')}: ${i.message}`).join('; ');
          throw new Error(`json_midi_v1 validation failed: ${issues || e?.message || String(e)}`);
        }
      } else if (format === 'score_dsl_v1') {
        // 明示: Score DSL v1 をコンパイル→検証
        try {
          const compiled = compileScoreToJsonMidi(json);
          song = zSong.parse(compiled);
        } catch (e: any) {
          const issues = e?.issues?.map?.((i: any)=> `${i.path?.join?.('.')}: ${i.message}`).join('; ');
          throw new Error(`score_dsl_v1 compile/validation failed: ${issues || e?.message || String(e)}`);
        }
      } else {
        // 後方互換: まずJSON MIDI v1として検証→失敗ならScore DSL v1としてコンパイルを試行
        const parsed = zSong.safeParse(json);
        if (parsed.success) {
          song = parsed.data;
        } else {
          let compileErrMsg = "";
          try {
            const compiled = compileScoreToJsonMidi(json);
            try {
              song = zSong.parse(compiled);
            } catch (e2: any) {
              const z2 = e2?.issues?.map?.((i: any) => `${i.path?.join?.('.')}: ${i.message}`).join('; ');
              compileErrMsg = `compiled-json-invalid: ${z2 || e2?.message || String(e2)}`;
              throw e2;
            }
          } catch (e: any) {
            const issues = parsed.error.issues?.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            const baseMsg = issues || parsed.error?.message || "invalid json";
            const extra = compileErrMsg || e?.issues?.map?.((i: any)=> `${i.path?.join?.('.')}: ${i.message}`).join('; ') || e?.message || String(e);
            const msg = `${baseMsg}${extra ? ` | score-compile: ${extra}` : ''}`;
            throw new Error(`json validation failed (or score compile failed): ${msg}`);
          }
        }
      }
      const bin = encodeToSmfBinary(song);
      const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);

      const safeName = (fileNameInput && fileNameInput.trim().length > 0
        ? fileNameInput.trim()
        : `json-${Date.now()}.mid`);
      const nameWithExt = safeName.toLowerCase().endsWith(".mid") ? safeName : `${safeName}.mid`;

      const midiDir = resolveMidiDir();
      await fs.mkdir(midiDir, { recursive: true });
      const absPath = path.join(midiDir, nameWithExt);
      await fs.writeFile(absPath, data);

      const fileId = randomUUID();
      const base = resolveBaseDir();
      const relPath = path.relative(base, absPath);
      const createdAt = new Date().toISOString();
      const bytes = data.byteLength;
  const trackCount = Array.isArray(song.tracks) ? song.tracks.length : 0;
  const eventCount = Array.isArray(song.tracks) ? song.tracks.reduce((a: number, t: any)=> a + (Array.isArray(t.events)? t.events.length : 0), 0) : 0;

      const record = { id: fileId, name: nameWithExt, path: relPath, bytes, createdAt };
      await appendItem(record);
      inMemoryIndex.set(fileId, record);

  return wrap({ ok: true, fileId, path: relPath, bytes, createdAt, trackCount, eventCount }) as any;
    }

    // smf_to_json: read SMF, parse with @tonejs/midi, convert to JSON schema
    if (name === "smf_to_json") {
      const fileId: string | undefined = args?.fileId;
      if (!fileId) throw new Error("'fileId' is required for smf_to_json");

      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);
  const json = await decodeSmfToJson(buf);
  const bytes = buf.byteLength;
  const trackCount = Array.isArray(json.tracks) ? json.tracks.length : 0;
  const eventCount = Array.isArray(json.tracks) ? json.tracks.reduce((a: number, t: any)=> a + (Array.isArray(t.events)? t.events.length : 0), 0) : 0;
  return wrap({ ok: true, json, bytes, trackCount, eventCount }) as any;
    }

    // append_to_smf: 既存SMFにJSON/DSLのチャンクを追記
    if (name === "append_to_smf") {
      const fileId: string | undefined = args?.fileId;
      if (!fileId) throw new Error("'fileId' is required for append_to_smf");
      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const format: string | undefined = typeof args?.format === 'string' ? String(args.format) : undefined;
      let chunk = args?.json;
      if (typeof chunk === 'string') { try { chunk = JSON.parse(chunk); } catch {} }
      if (!chunk) throw new Error("'json' is required for append_to_smf");
      // 簡易形式サポート: { events:[...] } だけを渡された場合は単一トラックJSON MIDIにラップ
      if (chunk && !chunk.tracks && Array.isArray(chunk.events)) {
        const evs = chunk.events;
        // baseJson まだ未読なので ppq は既定 480 にフォールバック
        chunk = { ppq: 480, tracks: [ { channel: Number.isFinite(Number(chunk.channel)) ? chunk.channel : undefined, events: evs } ] };
      }

      // 1) 既存SMFをJSONへ
      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);
      const baseJson = await decodeSmfToJson(buf);

      // 2) 追記するチャンクをJSON MIDI v1 へ
      let addSong: any;
      if (format === 'json_midi_v1') {
        addSong = zSong.parse(chunk);
      } else if (format === 'score_dsl_v1') {
        const compiled = compileScoreToJsonMidi(chunk);
        addSong = zSong.parse(compiled);
      } else {
        // 後方互換（未指定）: まずJSON MIDI、失敗でDSL
        const parsed = zSong.safeParse(chunk);
        if (parsed.success) addSong = parsed.data; else addSong = zSong.parse(compileScoreToJsonMidi(chunk));
      }

      // 3) 追記位置の決定（atEnd優先→atTick→既定末尾）。gapTicksで隙間を空ける
      const atEnd: boolean = !!args?.atEnd;
      const atTickArg = Number.isFinite(Number(args?.atTick)) ? (args.atTick|0) : undefined;
      const gapTicks = Number.isFinite(Number(args?.gapTicks)) ? Math.max(0, args.gapTicks|0) : 0;
      const trackIndex = Number.isFinite(Number(args?.trackIndex)) ? Math.max(0, args.trackIndex|0) : undefined;

      // 既存末尾tickを計測
      const trackEndTicks: number[] = baseJson.tracks.map((tr: any) => {
        let last = 0;
        for (const ev of (tr.events||[])) {
          if (typeof ev.tick === 'number') {
            if (ev.type === 'note') last = Math.max(last, ev.tick + (ev.duration||0));
            else last = Math.max(last, ev.tick);
          }
        }
        return last;
      });
      const globalEnd = trackEndTicks.length ? Math.max(...trackEndTicks) : 0;

      // 追加対象トラックの選定（指定なければ「最初の音源トラック or 0」）
      let tgt = trackIndex;
      if (!Number.isFinite(tgt as number)) {
        const cand = baseJson.tracks.findIndex((tr: any)=> (tr.events||[]).some((e:any)=> e.type!=="meta.tempo" && e.type!=="meta.timeSignature" && e.type!=="meta.keySignature"));
        tgt = (cand >= 0 ? cand : 0);
      }
      if (!baseJson.tracks[tgt!]) baseJson.tracks[tgt!] = { events: [] };

      // 4) 挿入オフセットの算出
      const insertTick = atEnd ? (trackEndTicks[tgt!] ?? globalEnd) + gapTicks : (atTickArg ?? (globalEnd + gapTicks));

      // 5) 追加曲の各イベントを insertTick へ相対シフトして追記
      const dst = baseJson.tracks[tgt!];
      for (const tr of addSong.tracks) {
        for (const ev of tr.events) {
          if (ev.type === 'meta.tempo' || ev.type === 'meta.timeSignature' || ev.type === 'meta.keySignature') {
            // グローバルメタは track0 に入れる（tickはそのまま/または末尾配置も可）。今回は相対で末尾に付ける
            const tick = insertTick + (ev.tick|0);
            if (!baseJson.tracks[0]) baseJson.tracks[0] = { events: [] };
            baseJson.tracks[0].events.push({ ...ev, tick });
          } else {
            const tick = insertTick + (ev.tick|0);
            dst.events.push({ ...ev, tick });
          }
        }
      }

      // 6) 正規化（簡易: tickでソート、NoteOff順はエンコーダ側のordで制御）
      for (const tr of baseJson.tracks) {
        tr.events.sort((a:any,b:any)=>{
          const ta=a.tick|0, tb=b.tick|0; if (ta!==tb) return ta-tb; return String(a.type).localeCompare(String(b.type));
        });
      }

      // 7) SMFへ再エンコード→保存（新規名指定があれば複製）
      const bin = encodeToSmfBinary(baseJson);
      const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
      const midiDir = resolveMidiDir();
      await fs.mkdir(midiDir, { recursive: true });
      const outName = (typeof args?.outputName === 'string' && args.outputName.trim().length>0) ? args.outputName.trim() : item.name;
      const nameWithExt = outName.toLowerCase().endsWith('.mid') ? outName : `${outName}.mid`;
      const absOut = path.join(midiDir, nameWithExt);
      await fs.writeFile(absOut, data);

      const base = resolveBaseDir();
      const relPath = path.relative(base, absOut);
      const bytes = data.byteLength;

      // マニフェスト更新（同名上書きなら既存レコードもあり得る）
      if (nameWithExt === item.name) {
        // 同一ファイルを更新：bytesを更新
        const manifest = await readManifest();
        const rec = manifest.items.find(i=> i.id === item!.id);
        if (rec) { rec.bytes = bytes; rec.path = relPath; }
        await writeManifest(manifest);
        inMemoryIndex.set(item.id, { ...item, bytes, path: relPath });
        return wrap({ ok: true, fileId: item.id, name: nameWithExt, path: relPath, bytes, insertedAtTick: insertTick });
      } else {
        const newId = randomUUID();
        const createdAt = new Date().toISOString();
        const rec = { id: newId, name: nameWithExt, path: relPath, bytes, createdAt };
        await appendItem(rec);
        inMemoryIndex.set(newId, rec);
        return wrap({ ok: true, fileId: newId, name: nameWithExt, path: relPath, bytes, insertedAtTick: insertTick });
      }
    }

    // --- 単発キャプチャ管理 ---------------------------------------------
    type CaptureState = {
      id: string;
      startedAt: number; // epoch ms
      onsetWindowMs: number;
      silenceMs: number;
      maxWaitMs: number;
      originMs?: number; // 最初のNoteOn(=和音起点)
      lastEventAt?: number; // 相対ms (origin基準ではなく capture開始基準)
      notes: Map<number, { onAt: number; offAt?: number; velocity: number }>;
      done: boolean;
      reason?: 'completed' | 'timeout';
      result?: any;
      // デバイスキャプチャ用
      inputInstance?: any; // node-midi Input
      inputPortName?: string;
  finalizeOnRelease?: boolean; // 全ノートOff時に即確定（silenceMs待機をスキップ）
    };
    const captureRegistry: Map<string, CaptureState> = (globalThis as any).__singleCaptures = (globalThis as any).__singleCaptures || new Map();

    function finalizeCapture(st: CaptureState, reason: 'completed' | 'timeout' = 'completed') {
      if (st.done) return;
      st.done = true;
      st.reason = reason;
      // まだオフになっていないノートは lastEventAt か maxWaitMs 終了時点でオフ扱い
      const endRel = (()=>{
        let latest = 0;
        for (const v of st.notes.values()) {
          const off = (v.offAt !== undefined ? v.offAt : (st.lastEventAt ?? 0));
          if (off > latest) latest = off;
        }
        return latest;
      })();
      // 結果整形
      const entries = Array.from(st.notes.entries()).map(([n,v])=>({ note: n, onAt: v.onAt, offAt: v.offAt ?? endRel, velocity: v.velocity }));
      entries.sort((a,b)=> a.note - b.note);
      const notes = entries.map(e=> e.note);
      const velocities = entries.map(e=> e.velocity);
      const startRel = st.originMs !== undefined ? (st.originMs - st.startedAt) : 0;
      const durationMs = endRel - (st.originMs !== undefined ? (st.originMs - st.startedAt) : 0);
      st.result = { notes, velocities, durationMs: Math.max(0,durationMs), isChord: notes.length > 1 };
    }

    function maybeAutoFinalize(st: CaptureState) {
      if (st.done) return;
      const nowMs = Date.now();
      const elapsedSinceStart = nowMs - st.startedAt;
      if (elapsedSinceStart >= st.maxWaitMs) {
        // 期待仕様: 既にノートが発生し全ノートOff状態なら 'completed' 扱い。未入力または入力途中なら 'timeout'
        if (st.originMs) {
          const anyActiveLate = Array.from(st.notes.values()).some(v=> v.offAt === undefined);
            if (!anyActiveLate) { finalizeCapture(st, 'completed'); return; }
        }
        finalizeCapture(st, 'timeout'); return;
      }
      if (!st.originMs) return; // まだ最初のon無しだが maxWaitMs は既に上で判定済
      // 全ノートoff & サイレンス経過
      const anyActive = Array.from(st.notes.values()).some(v=> v.offAt === undefined);
      if (!anyActive) {
        if (st.finalizeOnRelease) {
          finalizeCapture(st, 'completed');
        } else {
          const lastOff = Math.max(...Array.from(st.notes.values()).map(v=> v.offAt ?? 0), 0);
          if ((elapsedSinceStart - lastOff) >= st.silenceMs) finalizeCapture(st, 'completed');
        }
      }
    }

    if (name === 'start_single_capture') {
      const onsetWindowMs = Number.isFinite(Number(args?.onsetWindowMs)) ? Math.max(10, Math.min(500, Number(args.onsetWindowMs))) : 80;
      const silenceMs = Number.isFinite(Number(args?.silenceMs)) ? Math.max(50, Math.min(2000, Number(args.silenceMs))) : 150;
      const maxWaitMs = Number.isFinite(Number(args?.maxWaitMs)) ? Math.max(200, Math.min(10000, Number(args.maxWaitMs))) : 3000;
      const finalizeOnRelease = !!args?.finalizeOnRelease;
      const id = randomUUID();
      const st: CaptureState = { id, startedAt: Date.now(), onsetWindowMs, silenceMs, maxWaitMs, notes: new Map(), done: false, finalizeOnRelease };
      captureRegistry.set(id, st);
  return wrap({ ok: true, captureId: id, onsetWindowMs, silenceMs, maxWaitMs, finalizeOnRelease }) as any;
    }

    // --- MIDI入力デバイス列挙 ---
    if (name === 'list_input_devices') {
      await loadMidi();
      if (!MidiInput) throw new Error('node-midi not available for input');
      const inp = new MidiInput();
      const count = typeof inp.getPortCount === 'function' ? inp.getPortCount() : 0;
      const devices: Array<{ index: number; name: string }> = [];
      for (let i=0;i<count;i++) {
        let nm = '';
        try { nm = inp.getPortName(i) || `input:${i}`; } catch { nm = `input:${i}`; }
        devices.push({ index:i, name: nm });
      }
      try { if (typeof inp.closePort === 'function') inp.closePort(); } catch {}
      return wrap({ ok: true, devices }) as any;
    }

    // --- デバイスからの単発キャプチャ開始 ---
    if (name === 'start_device_single_capture') {
      await loadMidi();
      if (!MidiInput) throw new Error('node-midi not available for input');
      const onsetWindowMs = Number.isFinite(Number(args?.onsetWindowMs)) ? Math.max(10, Math.min(500, Number(args.onsetWindowMs))) : 80;
      const silenceMs = Number.isFinite(Number(args?.silenceMs)) ? Math.max(50, Math.min(2000, Number(args.silenceMs))) : 150;
      const maxWaitMs = Number.isFinite(Number(args?.maxWaitMs)) ? Math.max(200, Math.min(10000, Number(args.maxWaitMs))) : 3000;
      const finalizeOnRelease = !!args?.finalizeOnRelease;
      const reqPortName: string | undefined = args?.portName;
      // 列挙しターゲットポートを決定
      const temp = new MidiInput();
      const count = typeof temp.getPortCount === 'function' ? temp.getPortCount() : 0;
      const ports: string[] = [];
      for (let i=0;i<count;i++) { try { ports.push(temp.getPortName(i) || `input:${i}`); } catch { ports.push(`input:${i}`); } }
      let index = 0;
      if (reqPortName) {
        const found = ports.findIndex(p=> p === reqPortName || p.includes(reqPortName));
        if (found >= 0) index = found; else throw new Error(`input port not found: ${reqPortName}`);
      }
      // 実インスタンスを利用 (temp をそのまま使うと closePort タイミングが煩雑なので再利用)
      const inp = temp; // reuse
      try { inp.openPort(index); } catch { try { inp.closePort(); } catch {}; throw new Error(`failed to open input port index=${index}`); }
      // システムリアルタイム/アクティブセンシング無視 (APIによっては ignoreTypes が存在)
      try { if (typeof inp.ignoreTypes === 'function') inp.ignoreTypes(false, false, false); } catch {}

      const id = randomUUID();
  const st: CaptureState = { id, startedAt: Date.now(), onsetWindowMs, silenceMs, maxWaitMs, notes: new Map(), done: false, inputInstance: inp, inputPortName: ports[index], finalizeOnRelease };
      captureRegistry.set(id, st);

      // メッセージハンドラ
      const handler = (delta: number, message: number[]) => {
        try {
          const status = message[0] | 0;
          const type = status & 0xF0;
            const note = message[1] | 0;
            const velocity = message[2] | 0;
            const at = Date.now() - st.startedAt; // relative ms
            if (type === 0x90 && velocity > 0) {
              if (!st.originMs) st.originMs = st.startedAt + at;
              const within = (st.startedAt + at - (st.originMs)) <= st.onsetWindowMs;
              if (within) {
                if (!st.notes.has(note)) st.notes.set(note, { onAt: at, velocity: Math.max(1, Math.min(127, velocity)) });
              } else {
                // onsetWindow外は無視（単発設計）
              }
              st.lastEventAt = at;
            } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
              const entry = st.notes.get(note);
              if (entry && entry.offAt === undefined) entry.offAt = at;
              st.lastEventAt = at;
            }
            maybeAutoFinalize(st);
            if (st.done) {
              // 完了したらポートを閉じイベントを解除
              try { if (typeof inp.closePort === 'function') inp.closePort(); } catch {}
            }
        } catch {
          // 例外は握りつぶし（キャプチャ継続）。致命的状況ではクライアントポーリングで timeout/結果取得可能。
        }
      };
      try { inp.on('message', handler); } catch { /* 一部実装差異 */ }

  return wrap({ ok: true, captureId: id, portName: ports[index], onsetWindowMs, silenceMs, maxWaitMs, finalizeOnRelease, mode: 'device' }) as any;
    }

    if (name === 'feed_single_capture') {
      const captureId: string | undefined = args?.captureId;
      const events: any[] | undefined = args?.events;
      if (!captureId) throw new Error("'captureId' is required for feed_single_capture");
      if (!Array.isArray(events) || events.length === 0) throw new Error("'events' must be non-empty array");
      const st = captureRegistry.get(captureId);
      if (!st) throw new Error(`captureId not found: ${captureId}`);
      if (st.done) return wrap({ ok: true, captureId, done: true, ignored: true }) as any;
      const base = st.startedAt;
      for (const ev of events) {
        const kind = ev?.kind;
        const note = Number(ev?.note);
        const velRaw = Number(ev?.velocity);
        const at = Number(ev?.at);
        if (!Number.isFinite(note) || note < 0 || note > 127) throw new Error(`invalid note: ${ev?.note}`);
        if (!Number.isFinite(at) || at < 0) throw new Error(`invalid at ms: ${ev?.at}`);
        const atAbs = base + at; // absolute ms
        if (kind === 'on') {
          if (!st.originMs) st.originMs = atAbs;
          // onsetWindow内→和音メンバ
          const within = (atAbs - st.originMs) <= st.onsetWindowMs;
          if (within) {
            if (!st.notes.has(note)) st.notes.set(note, { onAt: at, velocity: Number.isFinite(velRaw)? Math.max(1, Math.min(127, velRaw)) : 100 });
          } else {
            // onsetWindow超過の新しいNoteOnは無視（単発キャプチャ設計）
          }
          st.lastEventAt = at;
        } else if (kind === 'off') {
          const entry = st.notes.get(note);
          if (entry && entry.offAt === undefined) {
            entry.offAt = at;
          }
          st.lastEventAt = at;
        } else {
          throw new Error(`event.kind must be 'on'|'off'`);
        }
      }
      // 自動完了判定
      maybeAutoFinalize(st);
      return wrap({ ok: true, captureId, done: st.done }) as any;
    }

  if (name === 'get_single_capture_status') {
      const captureId: string | undefined = args?.captureId;
      if (!captureId) throw new Error("'captureId' is required for get_single_capture_status");
      const st = captureRegistry.get(captureId);
      if (!st) throw new Error(`captureId not found: ${captureId}`);
      maybeAutoFinalize(st);
  if (st.done && !st.result) finalizeCapture(st, st.reason || 'completed');
  return wrap({ ok: true, captureId, done: st.done, reason: st.reason, result: st.result }) as any;
    }

    // insert_sustain: 指定範囲に CC64 (Sustain) on/off を挿入
    if (name === "insert_sustain") {
      const fileId: string | undefined = args?.fileId;
      const ranges: Array<{ startTick: number; endTick: number; channel?: number; trackIndex?: number; valueOn?: number; valueOff?: number }>|undefined = args?.ranges;
      if (!fileId) throw new Error("'fileId' is required for insert_sustain");
      if (!Array.isArray(ranges) || ranges.length === 0) throw new Error("'ranges' must be a non-empty array");

      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);
      const json = await decodeSmfToJson(buf);

      // デフォルトの挿入先トラック/チャンネルを推定
      const pickTrackIndex = (): number => {
        // 音源イベントのある最初のトラック
        const cand = json.tracks.findIndex((tr: any)=> (tr.events||[]).some((e:any)=> e.type!=='meta.tempo' && e.type!=='meta.timeSignature' && e.type!=='meta.keySignature'));
        return cand >= 0 ? cand : 0;
      };
      const ensureTrack = (idx: number) => { if (!json.tracks[idx]) json.tracks[idx] = { events: [] }; };
      const guessChannelFromTrack = (tr: any): number|undefined => {
        if (Number.isFinite(Number(tr?.channel))) return (tr.channel|0);
        const ev = (tr?.events||[]).find((e:any)=> (e.channel!==undefined));
        if (ev && Number.isFinite(Number(ev.channel))) return (ev.channel|0);
        return undefined;
      };

      for (const r of ranges) {
        const start = Math.max(0, Number((r as any).startTick|0));
        const end = Math.max(start, Number((r as any).endTick|0));
        const rr: any = r as any;
        const onRaw = rr.valueOn;
        const offRaw = rr.valueOff;
        const valueOn = Number.isFinite(Number(onRaw)) ? Math.max(0, Math.min(127, Number(onRaw))) : 127;
        const valueOff = Number.isFinite(Number(offRaw)) ? Math.max(0, Math.min(127, Number(offRaw))) : 0;
        // 挿入先
        const tIdx = Number.isFinite(Number(rr.trackIndex)) ? Math.max(0, Number(rr.trackIndex)) : pickTrackIndex();
        ensureTrack(tIdx);
        // channel受理: 1-16（外部表記）→内部0-15 / 0-15（内部表記）も許容
        let chVal: number | undefined = Number.isFinite(Number(rr.channel)) ? Number(rr.channel) : guessChannelFromTrack(json.tracks[tIdx]);
        let ch: number;
        if (Number.isFinite(Number(chVal))) {
          const c = Number(chVal);
          if (c >= 1 && c <= 16) ch = c - 1; else ch = c; // 外部表記なら-1
        } else {
          ch = 0;
        }
        if (!Number.isFinite(ch as number)) ch = 0;
        ch = Math.max(0, Math.min(15, ch as number));

        json.tracks[tIdx].events.push({ type: 'cc', tick: start, controller: 64, value: valueOn, channel: ch });
        json.tracks[tIdx].events.push({ type: 'cc', tick: end, controller: 64, value: valueOff, channel: ch });
        // 近傍の重複を軽減（同tickに複数が重ならないよう簡易除去）
        json.tracks[tIdx].events = json.tracks[tIdx].events.filter((ev:any, i:number, arr:any[])=>{
          if (ev.type !== 'cc' || ev.controller !== 64) return true;
          const key = `${ev.tick}:${ev.value}:${ev.channel ?? 'x'}`;
          const first = arr.findIndex((e:any)=> e.type==='cc' && e.controller===64 && (e.tick|0)===(ev.tick|0) && (e.value|0)===(ev.value|0) && ((e.channel??'x')===(ev.channel??'x')));
          return first === i;
        }).sort((a:any,b:any)=> (a.tick|0)-(b.tick|0));
      }

      // 再エンコードして保存（上書き）
      const bin = encodeToSmfBinary(json);
      const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
      const midiDir = resolveMidiDir();
      await fs.mkdir(midiDir, { recursive: true });
      const absOut = path.join(midiDir, item.name);
      await fs.writeFile(absOut, data);
      const base = resolveBaseDir();
      const relPath = path.relative(base, absOut);
      const bytes = data.byteLength;

      // マニフェスト更新
      const manifest = await readManifest();
      const rec = manifest.items.find(i=> i.id === item!.id);
      if (rec) { rec.bytes = bytes; rec.path = relPath; }
      await writeManifest(manifest);
      inMemoryIndex.set(item.id, { ...item, bytes, path: relPath });

      return wrap({ ok: true, fileId: item.id, name: item.name, path: relPath, bytes }) as any;
    }

    // insert_cc: 指定範囲に任意CCの on/off を挿入
    if (name === "insert_cc") {
      const fileId: string | undefined = args?.fileId;
      const controller: number | undefined = args?.controller;
      const ranges: Array<{ startTick: number; endTick: number; channel?: number; trackIndex?: number; valueOn?: number; valueOff?: number }>|undefined = args?.ranges;
      if (!fileId) throw new Error("'fileId' is required for insert_cc");
      if (!Number.isFinite(Number(controller))) throw new Error("'controller' is required (0-127)");
      const ctrl = Math.max(0, Math.min(127, Number(controller)));
      if (!Array.isArray(ranges) || ranges.length === 0) throw new Error("'ranges' must be a non-empty array");

      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);
      const json = await decodeSmfToJson(buf);

      const pickTrackIndex = (): number => {
        const cand = json.tracks.findIndex((tr: any)=> (tr.events||[]).some((e:any)=> e.type!=='meta.tempo' && e.type!=='meta.timeSignature' && e.type!=='meta.keySignature'));
        return cand >= 0 ? cand : 0;
      };
      const ensureTrack = (idx: number) => { if (!json.tracks[idx]) json.tracks[idx] = { events: [] }; };
      const guessChannelFromTrack = (tr: any): number|undefined => {
        if (Number.isFinite(Number(tr?.channel))) return (tr.channel|0);
        const ev = (tr?.events||[]).find((e:any)=> (e.channel!==undefined));
        if (ev && Number.isFinite(Number(ev.channel))) return (ev.channel|0);
        return undefined;
      };

      for (const r of ranges) {
        const start = Math.max(0, Number((r as any).startTick|0));
        const end = Math.max(start, Number((r as any).endTick|0));
        const rr: any = r as any;
        const onRaw = rr.valueOn;
        const offRaw = rr.valueOff;
        const valueOn = Number.isFinite(Number(onRaw)) ? Math.max(0, Math.min(127, Number(onRaw))) : 127;
        const valueOff = Number.isFinite(Number(offRaw)) ? Math.max(0, Math.min(127, Number(offRaw))) : 0;
        const tIdx = Number.isFinite(Number(rr.trackIndex)) ? Math.max(0, Number(rr.trackIndex)) : pickTrackIndex();
        ensureTrack(tIdx);
        // channel 1-16外部表記→内部0-15
        let chVal: number | undefined = Number.isFinite(Number(rr.channel)) ? Number(rr.channel) : guessChannelFromTrack(json.tracks[tIdx]);
        let ch: number;
        if (Number.isFinite(Number(chVal))) {
          const c = Number(chVal);
          if (c >= 1 && c <= 16) ch = c - 1; else ch = c;
        } else {
          ch = 0;
        }

        json.tracks[tIdx].events.push({ type: 'cc', tick: start, controller: ctrl, value: valueOn, channel: ch });
        json.tracks[tIdx].events.push({ type: 'cc', tick: end, controller: ctrl, value: valueOff, channel: ch });
        json.tracks[tIdx].events = json.tracks[tIdx].events.filter((ev:any, i:number, arr:any[])=>{
          if (ev.type !== 'cc' || ev.controller !== ctrl) return true;
          const key = `${ev.tick}:${ev.value}:${ev.channel ?? 'x'}`;
          const first = arr.findIndex((e:any)=> e.type==='cc' && e.controller===ctrl && (e.tick|0)===(ev.tick|0) && (e.value|0)===(ev.value|0) && ((e.channel??'x')===(ev.channel??'x')));
          return first === i;
        }).sort((a:any,b:any)=> (a.tick|0)-(b.tick|0));
      }

      const bin = encodeToSmfBinary(json);
      const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
      const midiDir = resolveMidiDir();
      await fs.mkdir(midiDir, { recursive: true });
      const absOut = path.join(midiDir, item.name);
      await fs.writeFile(absOut, data);
      const base = resolveBaseDir();
      const relPath = path.relative(base, absOut);
      const bytes = data.byteLength;

      const manifest = await readManifest();
      const rec = manifest.items.find(i=> i.id === item!.id);
      if (rec) { rec.bytes = bytes; rec.path = relPath; }
      await writeManifest(manifest);
      inMemoryIndex.set(item.id, { ...item, bytes, path: relPath });

      return wrap({ ok: true, fileId: item.id, name: item.name, path: relPath, bytes }) as any;
    }

    // play_smf: parse SMF and schedule playback (or dryRun for analysis only)
    if (name === "play_smf") {
      const fileId: string | undefined = args?.fileId;
      const startMs: number | undefined = Number.isFinite(Number(args?.startMs)) ? Number(args?.startMs) : undefined;
      const stopMs: number | undefined = Number.isFinite(Number(args?.stopMs)) ? Number(args?.stopMs) : undefined;
  const dryRun: boolean = !!args?.dryRun;
  const schedulerLookaheadMs: number | undefined = Number.isFinite(Number(args?.schedulerLookaheadMs)) ? Math.max(10, Math.min(1000, Number(args?.schedulerLookaheadMs))) : undefined;
  const schedulerTickMs: number | undefined = Number.isFinite(Number(args?.schedulerTickMs)) ? Math.max(5, Math.min(200, Number(args?.schedulerTickMs))) : undefined;
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
  let totalDurationMs = 0;
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
          // クリップにより NoteOn が残り NoteOff が失われるケースに対応: 欠落Offを合成
          const lastBoundary = Number.isFinite(e) ? e : (events.length ? events[events.length-1]!.tMs : s);
          const onMap = new Map<string, Ev>();
          const synthOff: Ev[] = [];
          for (const ev of events) {
            const key = `${ev.ch}:${ev.n}`;
            if (ev.kind === 'on') onMap.set(key, ev);
            else onMap.delete(key);
          }
          for (const [key, onEv] of onMap) {
            synthOff.push({ tMs: Math.max(onEv.tMs + 5, lastBoundary), kind: 'off', ch: onEv.ch, n: onEv.n, v: 0 });
          }
          if (synthOff.length) {
            events.push(...synthOff);
            events.sort((a,b)=> a.tMs - b.tMs || (a.kind==='off'? -1: 1));
          }
        }
        scheduledEvents = events.length;
        if (events.length > 0) {
          totalDurationMs = events[events.length - 1]!.tMs;
        }
      } catch (e: any) {
        warnings.push(`parse-warning: ${e?.message || String(e)}`);
      }

      const playbackId = randomUUID();
      const registry: Map<string, any> = (globalThis as any).__playbacks = (globalThis as any).__playbacks || new Map();

      // dryRun: 解析のみで即返す
      if (dryRun || events.length === 0) {
        registry.set(playbackId, { fileId, startedAt: Date.now(), scheduledEvents, totalDurationMs, dryRun: true });
        return wrap({ ok: true, playbackId, scheduledEvents, totalDurationMs, warnings: warnings.length ? warnings : undefined }) as any;
      }

      // 実再生: ルックアヘッドスケジューラ
      const state: {
        type: 'smf';
        fileId: string;
        startedAt: number;
        scheduledEvents: number;
        totalDurationMs: number;
  intervalId: any;
        timeouts: any[];
        active: Set<string>;
        out?: any;
        cursor: number;
        lastSentIndex: number;
        lastSentAt: number;
        lookahead: number;
        tickInterval: number;
        portIndex?: number;
        portName?: string;
        done?: boolean;
      } = {
  type: 'smf', fileId, startedAt: Date.now(), scheduledEvents, totalDurationMs, intervalId: null, timeouts: [], active: new Set(), out: undefined,
  cursor: 0, lastSentIndex: -1, lastSentAt: 0, lookahead: schedulerLookaheadMs ?? 50, tickInterval: schedulerTickMs ?? 10, portIndex: undefined, portName: undefined, done: false
      };

      // 出力デバイスを開く（macOS以外でもnode-midiがあれば開く）
  try {
        const { MidiOutput: OutCls } = await loadMidi();
        if (OutCls) {
          const out = new OutCls();
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
      state.portIndex = target;
      try { state.portName = String(out.getPortName?.(target)); } catch {}
        } else {
          warnings.push('node-midi not available: playback is a no-op');
        }
      } catch (e:any) {
        warnings.push(`open-output-warning: ${e?.message || String(e)}`);
      }

    const lookahead = state.lookahead; // ms
    const tickInterval = state.tickInterval; // ms
      const t0 = performance.now();
      (state as any).__t0 = t0;
    let cursor = 0;
      function schedule(ev: Ev, idx: number){
        // NoteOn/Off メッセージ生成
        // Note Offは Note On(velocity 0) を優先
        const isOn = ev.kind === 'on';
        const status = (0x90) | (ev.ch & 0x0f);
        const msg = [status, ev.n & 0x7f, isOn ? (ev.v & 0x7f) : 0];
        const due = t0 + ev.tMs - performance.now();
        const to = setTimeout(()=>{
          try {
            if (state.out) state.out.sendMessage(msg);
            // active管理（ハングノート回避）
            const key = `${ev.ch}:${ev.n}`;
            if (isOn) state.active.add(key); else state.active.delete(key);
      state.lastSentAt = performance.now() - t0;
          } catch {}
        }, Math.max(0, due));
        state.timeouts.push(to);
        state.lastSentIndex = Math.max(state.lastSentIndex, idx);
      }
      const intervalId = setInterval(()=>{
        const now = performance.now();
        const playhead = now - t0;
        const windowEnd = playhead + lookahead;
        while (cursor < events.length && events[cursor].tMs <= windowEnd) {
          schedule(events[cursor], cursor);
          cursor++;
        }
    state.cursor = cursor;
      if (cursor >= events.length) {
            clearInterval(intervalId);
            // 再生完了時の安全フラッシュ: CC64=0, CC123, 残留ノートのvel0 Off、ポートクローズ
            try {
              if (state.out) {
                const chSet = new Set<number>();
                for (const ev of events) chSet.add((ev.ch|0) & 0x0f);
                for (const ch of chSet) {
                  // CC64 (Sustain) OFF
                  try { state.out.sendMessage([0xB0 | ch, 64, 0]); } catch {}
                }
                // 残留ノートがあれば個別にOff
                if (state.active && state.active.size) {
                  try {
                    const chSet2 = new Set<number>();
                    for (const key of Array.from(state.active)) {
                      const [chStr, nStr] = String(key).split(":");
                      const ch = (Number(chStr)|0) & 0x0f; const n = Number(nStr)|0;
                      chSet2.add(ch);
                      try { state.out.sendMessage([0x90 | ch, n & 0x7f, 0]); } catch {}
                    }
                    // CC123 All Notes Off
                    for (const ch of chSet2) { try { state.out.sendMessage([0xB0 | ch, 123, 0]); } catch {} }
                    state.active.clear();
                  } catch {}
                } else {
                  // active が空でも CC123 を送っておく（保険）
                  try {
                    for (const ch of chSet) { try { state.out.sendMessage([0xB0 | ch, 123, 0]); } catch {} }
                  } catch {}
                }
                try { state.out.closePort(); } catch {}
              }
            } catch {}
        state.done = true;
          }
      }, tickInterval);
      state.intervalId = intervalId;

      registry.set(playbackId, state);
    return wrap({ ok: true, playbackId, scheduledEvents, totalDurationMs, warnings: warnings.length ? warnings : undefined }) as any;
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
          const { MidiOutput: OutCls } = await loadMidi();
          if (OutCls) {
            const out = new OutCls();
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
        const { MidiOutput: OutCls } = await loadMidi();
        if (OutCls) {
          const out = new OutCls();
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
            // まず CC123 All Notes Off をアクティブなチャンネルに送出（安全網）
            const chSet = new Set<number>();
            for (const key of Array.from(st.active)) {
              const [chStr] = String(key).split(":");
              chSet.add((Number(chStr)|0) & 0x0f);
            }
            for (const ch of chSet) {
              st.out.sendMessage([0xB0 | ch, 123, 0]);
            }
            // 念のため個別ノートにも Note On(vel0) を送る
            for (const key of Array.from(st.active)) {
              const [chStr, nStr] = String(key).split(":");
              const ch = Number(chStr)|0; const n = Number(nStr)|0;
              st.out.sendMessage([0x90 | (ch & 0x0f), n & 0x7f, 0]);
            }
          } catch {}
        }
        // 出力を閉じる
        if (st.out) { try { st.out.closePort(); } catch {} }
        map!.delete(playbackId);
      }
      return wrap({ ok: true }) as any;
    }

    // get_playback_status: 再生進捗と状態を返す
    if (name === "get_playback_status") {
      const playbackId: string | undefined = args?.playbackId;
      if (!playbackId) throw new Error("'playbackId' is required for get_playback_status");
      const map: Map<string, any> | undefined = (globalThis as any).__playbacks;
      const st = map?.get(playbackId);
      if (!st) return wrap({ ok: false, error: 'not_found' }) as any;
      const now = performance.now();
      const elapsedMs = now - (st.__t0 || now); // __t0 未保持でも0扱い
      const resp = {
        ok: true,
        type: st.type,
        fileId: st.fileId,
        scheduledEvents: st.scheduledEvents,
        totalDurationMs: st.totalDurationMs ?? undefined,
        cursor: st.cursor ?? undefined,
        lastSentIndex: st.lastSentIndex ?? undefined,
        lastSentAt: st.lastSentAt ?? undefined,
        lookahead: st.lookahead ?? undefined,
        tickInterval: st.tickInterval ?? undefined,
        portIndex: st.portIndex ?? undefined,
        portName: st.portName ?? undefined,
        activeNotes: st.active ? Array.from(st.active) : [],
        done: !!st.done,
      };
      return wrap(resp) as any;
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
    } catch (err: any) {
      // 例外をクライアントに伝達可能な構造化エラーへ変換
      const classified = classifyError(name, err);
      return wrap({ ok: false, error: { tool: name, ...classified } });
    }
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
