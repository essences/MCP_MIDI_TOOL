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
  const t0 = performance.now();
  // ウォームアップ計測用オブジェクト（初回遅延要因の可視化）
  const warmup: any = { manifest: {}, schema: {}, midi: {} };
  const transport = new StdioServerTransport();
  const server = new Server(
    { name: "mcp-midi-tool", version: "0.1.0" },
  // prompts/resources を明示してクライアント側の探索フローと互換性を持たせる
  { capabilities: { tools: {}, prompts: {}, resources: {} } }
  );

  // ---- 初回ウォームアップ処理（計測） ----
  // 1. manifest スキャン（件数と時間）
  {
    const t1 = performance.now();
    let count = 0;
    try { count = (await readManifest()).items.length; } catch { /* ignore */ }
    const t2 = performance.now();
    warmup.manifest = { ms: +(t2 - t1).toFixed(1), items: count };
  }
  // 2. スキーマ / コンパイルパス ウォーム（極小DSLをコンパイル）
  {
    const t1 = performance.now();
    try {
      const dummyScore: any = { ppq: 480, meta: { timeSignature: { numerator: 4, denominator: 4 }, tempo: { bpm: 120 } }, tracks: [{ channel: 1, events: [] }] };
      await compileScoreToJsonMidi(dummyScore); // 結果は捨てる
      const t2 = performance.now();
      warmup.schema = { ms: +(t2 - t1).toFixed(1) };
    } catch (e: any) {
      const t2 = performance.now();
      warmup.schema = { ms: +(t2 - t1).toFixed(1), error: String(e?.message || e) };
    }
  }
  // 3. MIDI 出力デバイス利用可否の事前判定（dynamic import の JIT コスト顕在化）
  {
    const t1 = performance.now();
    let out = false; let inp = false;
    try { const r = await loadMidi(); out = !!r.MidiOutput; inp = !!r.MidiInput; } catch { /* ignore */ }
    const t2 = performance.now();
    warmup.midi = { ms: +(t2 - t1).toFixed(1), output: out, input: inp };
  }

  

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
      // 既に json_to_smf で加工された issues (path/message/code/expected/received) を尊重
      const rawIssues: any[] | undefined = Array.isArray(err?.issues) ? err.issues : undefined;
      const issues = rawIssues?.map(i => ({
        path: i.path,
        message: i.message,
        code: i.code,
        expected: i.expected,
        received: i.received
      }));
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
  { name: "clean_midi", description: "SMF内の重複メタ/トラックを正規化して新規fileId発行", inputSchema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } },
  { name: "append_to_smf", description: "既存SMFへJSON/Score DSLチャンクを追記（指定tick/末尾）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, json: { anyOf: [ { type: "object" }, { type: "string" } ] }, format: { type: "string", enum: ["json_midi_v1", "score_dsl_v1"] }, atTick: { type: "number" }, atEnd: { type: "boolean" }, gapTicks: { type: "number" }, trackIndex: { type: "number" }, preserveTrackStructure: { type: "boolean" }, trackMapping: { type: "array", items: { type: "number" } }, outputName: { type: "string" }, keepGlobalMeta: { type: "boolean", description: "追記チャンクに含まれる tempo/time/key メタを重複抑制せず保持 (既定:false)" }, allowKeyChange: { type: "boolean", description: "異なる keySignature を許可 (既定:false: 差異は無視)" } }, required: ["fileId", "json"] } },
  // keepGlobalMeta: 追記チャンク内の meta.(tempo|timeSignature|keySignature) をそのまま保持する（既定 false: 重複を自動的に抑制）
  // allowKeyChange: keySignature が異なる場合にエラーにせず保持（既定 false: 差異は警告し無視）
  { name: "insert_sustain", description: "CC64(サスティン)のON/OFFを範囲に挿入", inputSchema: { type: "object", properties: { fileId: { type: "string" }, ranges: { type: "array", items: { type: "object", properties: { startTick: { type: "number" }, endTick: { type: "number" }, channel: { type: "number" }, trackIndex: { type: "number" }, valueOn: { type: "number" }, valueOff: { type: "number" } }, required: ["startTick", "endTick"] } } }, required: ["fileId", "ranges"] } },
  { name: "insert_cc", description: "任意のCC番号の値を範囲に挿入（ON/OFF相当の2値）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, controller: { type: "number" }, ranges: { type: "array", items: { type: "object", properties: { startTick: { type: "number" }, endTick: { type: "number" }, channel: { type: "number" }, trackIndex: { type: "number" }, valueOn: { type: "number" }, valueOff: { type: "number" } }, required: ["startTick", "endTick"] } } }, required: ["fileId", "controller", "ranges"] } },
  { name: "extract_bars", description: "SMFファイルの指定小節範囲をJSON MIDI形式で抽出", inputSchema: { type: "object", properties: { fileId: { type: "string" }, startBar: { type: "number", minimum: 1 }, endBar: { type: "number", minimum: 1 }, format: { type: "string", enum: ["json_midi_v1", "score_dsl_v1"], default: "json_midi_v1" } }, required: ["fileId", "startBar", "endBar"] } },
  { name: "replace_bars", description: "SMFファイルの指定小節範囲をJSONデータで置換", inputSchema: { type: "object", properties: { fileId: { type: "string" }, startBar: { type: "number", minimum: 1 }, endBar: { type: "number", minimum: 1 }, json: {}, format: { type: "string", enum: ["json_midi_v1", "score_dsl_v1"], default: "json_midi_v1" }, outputName: { type: "string" } }, required: ["fileId", "startBar", "endBar", "json"] } },
        { name: "get_midi", description: "fileIdでMIDIメタ情報と任意でbase64を返す", inputSchema: { type: "object", properties: { fileId: { type: "string" }, includeBase64: { type: "boolean" } }, required: ["fileId"] } },
        { name: "list_midi", description: "保存済みMIDIの一覧（ページング）", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } } },
        { name: "export_midi", description: "fileIdをdata/exportへコピー", inputSchema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } },
        { name: "list_devices", description: "MIDI出力デバイス一覧（暫定）", inputSchema: { type: "object", properties: {} } },
  { name: "play_smf", description: "SMFを解析し再生（dryRunで送出なし解析のみ）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, portName: { type: "string" }, startMs: { type: "number" }, stopMs: { type: "number" }, startBar: { type: "number" }, endBar: { type: "number" }, dryRun: { type: "boolean" }, schedulerLookaheadMs: { type: "number" }, schedulerTickMs: { type: "number" } }, required: ["fileId"] } },
  { name: "get_playback_status", description: "再生ステータスを取得（進捗・総尺・デバイスなど）", inputSchema: { type: "object", properties: { playbackId: { type: "string" } }, required: ["playbackId"] } },
  { name: "playback_midi", description: "MIDI再生開始（PoC: durationMsで長さ指定可）", inputSchema: { type: "object", properties: { fileId: { type: "string" }, portName: { type: "string" }, durationMs: { type: "number" } }, required: ["fileId"] } },
    { name: "trigger_notes", description: "単発でノート（単音/和音）を即時送出（耳トレ用・高速ワンショット）", inputSchema: { type: "object", properties: { notes: { anyOf: [ { type: "array", items: { type: "string" } }, { type: "array", items: { type: "number" } } ] }, velocity: { type: "number" }, durationMs: { type: "number" }, channel: { type: "number" }, program: { type: "number" }, portName: { type: "string" }, transpose: { type: "number" }, dryRun: { type: "boolean" } }, required: ["notes"] } },
  { name: "list_input_devices", description: "MIDI入力デバイス一覧（暫定）", inputSchema: { type: "object", properties: {} } },
  { name: "start_device_single_capture", description: "MIDI入力デバイスから単発(単音/和音)キャプチャ開始 (onsetWindow内で和音判定)", inputSchema: { type: "object", properties: { portName: { type: "string" }, onsetWindowMs: { type: "number" }, silenceMs: { type: "number" }, maxWaitMs: { type: "number" } } } },
  { name: "start_single_capture", description: "リアルタイム単発(単音/和音)キャプチャ開始 (onsetWindow内を和音と判定)", inputSchema: { type: "object", properties: { onsetWindowMs: { type: "number" }, silenceMs: { type: "number" }, maxWaitMs: { type: "number" } } } },
  { name: "feed_single_capture", description: "(テスト/内部) start_single_capture中の擬似MIDIイベント投入", inputSchema: { type: "object", properties: { captureId: { type: "string" }, events: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["on","off"] }, note: { type: "number" }, velocity: { type: "number" }, at: { type: "number" } }, required: ["kind","note","at"] } } }, required: ["captureId","events"] } },
  { name: "get_single_capture_status", description: "単発キャプチャ状態取得(完了時に結果返却)", inputSchema: { type: "object", properties: { captureId: { type: "string" } }, required: ["captureId"] } },
  { name: "start_continuous_recording", description: "MIDI入力デバイスから継続的な演奏記録を開始", inputSchema: { type: "object", properties: { portName: { type: "string" }, ppq: { type: "number", minimum: 96, maximum: 1920 }, maxDurationMs: { type: "number", minimum: 10000, maximum: 3600000 }, idleTimeoutMs: { type: "number", minimum: 5000, maximum: 120000 }, silenceTimeoutMs: { type: "number", minimum: 2000, maximum: 60000 }, channelFilter: { type: "array", items: { type: "number", minimum: 1, maximum: 16 } }, eventTypeFilter: { type: "array", items: { type: "string", enum: ["note", "cc", "pitchBend", "program"] } } }, required: [] } },
  { name: "get_continuous_recording_status", description: "記録セッションの現在状態・進捗・メトリクス取得", inputSchema: { type: "object", properties: { recordingId: { type: "string" } }, required: ["recordingId"] } },
  { name: "stop_continuous_recording", description: "継続記録セッション手動終了・SMF生成保存・fileId発行", inputSchema: { type: "object", properties: { recordingId: { type: "string" }, name: { type: "string" }, overwrite: { type: "boolean" } }, required: ["recordingId"] } },
  { name: "list_continuous_recordings", description: "進行中・完了済み記録セッション一覧取得（デバッグ・監視用）", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["active", "completed", "all"], default: "active" }, limit: { type: "number", default: 10, maximum: 50 } }, required: [] } },
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
      const rawChannelInput = args?.channel;
      let channel: number; // 内部0-15
      let resolvedChannelExternal: number; // 外部1-16
      const warnings: string[] = [];
      if (rawChannelInput === undefined) {
        channel = 0;
        resolvedChannelExternal = 1;
      } else {
        const num = Number(rawChannelInput);
        if (!Number.isFinite(num)) throw new Error("channel must be a number (1-16)");
        if (num >= 1 && num <= 16) {
          // 正常な外部表記
            resolvedChannelExternal = num | 0;
            channel = (num - 1) | 0;
        } else if (num >= 0 && num <= 15) {
          // 旧実装互換: 内部値が直接渡されたケース
          channel = num | 0;
          resolvedChannelExternal = (num + 1) | 0;
          warnings.push(`channel value ${num} interpreted as legacy internal (0-15). Use 1-16 external next time -> external ${resolvedChannelExternal}.`);
        } else {
          throw new Error("channel out of range (expected 1-16)");
        }
      }
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

  // warnings は上部で定義・利用
      const playbackId = randomUUID();
      const registry: Map<string, any> = (globalThis as any).__playbacks = (globalThis as any).__playbacks || new Map();

      if (dryRun) {
        registry.set(playbackId, { type: 'oneshot', startedAt: Date.now(), scheduledEvents: notes.length*2, totalDurationMs: durationMs, cursor: notes.length*2, lastSentIndex: notes.length*2 - 1, lookahead: 0, tickInterval: 0, portName: undefined, done: true });
        return wrap({ ok: true, playbackId, scheduledNotes: notes.length, durationMs, channel: resolvedChannelExternal, internalChannel: channel, warnings: warnings.length ? warnings : undefined });
      }

      // 実送出
      let portNameResolved: string | undefined;
  // extractionMode を外側スコープで保持（dryRun 応答にも含める）
  let extractionMode: 'simple' | 'precise' = 'simple';
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

  return wrap({ ok: true, playbackId, scheduledNotes: notes.length, durationMs, portName: portNameResolved, channel: resolvedChannelExternal, internalChannel: channel, warnings: warnings.length ? warnings : undefined }) as any;
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
      const originalInputIsString = typeof json === 'string';
      if (originalInputIsString) {
        // まずJSON.parseを試みる（失敗したら DSL 文字列の可能性）
        try { json = JSON.parse(json as string); } catch { /* 後段で DSL パスへ */ }
      }
      const fileNameInput: string | undefined = args?.name;
      if (!json) throw new Error("'json' is required for json_to_smf");
      // 形式ヒューリスティック検出: 期待と異なる場合は早期に FORMAT_MISMATCH を返し、ユーザーが正しい format 指定やデータ修正をしやすくする
      const detectFormat = (obj: any): 'json_midi_v1' | 'score_dsl_v1' | 'unknown' => {
        try {
          if (obj && typeof obj === 'object') {
            if (obj.format === 1 && typeof obj.ppq === 'number' && Array.isArray(obj.tracks)) {
              // tick ベースイベントがあれば JSON MIDI とみなす
              for (const t of obj.tracks) {
                if (t && Array.isArray(t.events)) {
                  if (t.events.some((ev: any)=> typeof ev?.tick === 'number')) return 'json_midi_v1';
                }
              }
            }
            // start / duration を含む DSL イベントパターン
            if (typeof obj.ppq === 'number' && Array.isArray(obj.tracks)) {
              for (const t of obj.tracks) {
                if (t && Array.isArray(t.events)) {
                  if (t.events.some((ev: any)=> ev && ev.start && (ev.start.bar || ev.start.beat) && ev.duration)) return 'score_dsl_v1';
                }
              }
            }
          }
        } catch {/* ignore */}
        return 'unknown';
      };

      const detected = detectFormat(json);
      if (format && detected !== 'unknown' && format !== detected) {
        // 指定フォーマットと内容の推定が食い違う場合
        throw new Error(`FORMAT_MISMATCH: expected=${format} detected=${detected} | 提供されたデータは ${detected} 形式らしく見えます。"format" を ${detected} に変更するかデータ構造を ${format} の仕様に合わせてください。`);
      }
      
      let song: any;
      if (format === 'json_midi_v1') {
        // 明示: JSON MIDI v1 として検証
        try {
          song = zSong.parse(json);
        } catch (e: any) {
          const zIssues: any[] = Array.isArray(e?.issues) ? e.issues : [];
          const summary = zIssues.slice(0,5).map((i:any,idx:number)=> `${idx}(${i.path?.join?.('.')||'(root)'}:${i.message})`).join(' | ');
          const detailLines = zIssues.map((i:any,idx:number)=> {
            const pathStr = i.path?.join?.('.') || '(root)';
            const code = i.code || 'ZOD_ERROR';
            const exp = (i as any).expected !== undefined ? ` expected=${JSON.stringify((i as any).expected)}` : '';
            const rec = (i as any).received !== undefined ? ` received=${JSON.stringify((i as any).received)}` : '';
            return `#${idx} path=${pathStr} code=${code} msg=${i.message}${exp}${rec}`;
          }).join('\n');
          const more = zIssues.length > 5 ? ` ...(and ${zIssues.length-5} more)` : '';
          const errMsg = `json_midi_v1 validation failed: ${summary || (e?.message || String(e))}${more}\n--- details ---\n${detailLines}`;
          const err2: any = new Error(errMsg);
          if (zIssues.length) {
            err2.issues = zIssues.map((i:any)=> ({ path: i.path, message: i.message, code: i.code, expected: (i as any).expected, received: (i as any).received }));
          }
          throw err2;
        }
      } else if (format === 'score_dsl_v1') {
        // 明示: Score DSL v1 をコンパイル→検証
        try {
          let inputForCompile = json;
          let directJsonMidi: any | undefined;
          // 簡易 DSL 文字列 (旧テスト互換) をオブジェクト形式へ変換
          if (originalInputIsString && typeof json === 'string') {
            try {
              const lines = (json as string).split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
              let title: string|undefined; let tempo: number|undefined; let timeSig: {numerator:number;denominator:number}|undefined;
              const trackSpecs: { name:string; tokens:string[] }[] = [];
              for (const ln of lines) {
                if (ln.startsWith('#title:')) title = ln.slice(7).trim();
                else if (ln.startsWith('#tempo:')) tempo = Number(ln.slice(7).trim());
                else if (ln.startsWith('#time:')) { const m = ln.slice(6).trim().match(/(\d+)\/(\d+)/); if (m) timeSig = { numerator:Number(m[1]), denominator:Number(m[2]) }; }
                else {
                  const m = ln.match(/^(\w+):\s*(.+)$/); if (m) { trackSpecs.push({ name:m[1], tokens:m[2].split(/\s+/) }); }
                }
              }
              const ppq = 480;
              const numerator = timeSig?.numerator ?? 4; const denominator = (timeSig?.denominator ?? 4) as 1|2|4|8|16;
              const tracks:any[] = [];
              const barTicks = ppq * numerator; // 4/4 固定で denominator=4 前提
              for (const ts of trackSpecs) {
                const events:any[] = [];
                let curBar = 1; let curTickInBar = 0;
                let i=0;
                while (i < ts.tokens.length) {
                  const token = ts.tokens[i];
                  if (token === '|') { curBar++; curTickInBar = 0; i++; continue; }
                  const lenToken = ts.tokens[i+1];
                  if (!lenToken) break;
                  const lenMap: Record<string, number> = { '8': Math.round(ppq/2), '4': ppq, '2': ppq*2, '1': ppq*4 };
                  const durTicks = lenMap[lenToken] ?? Math.round(ppq/2);
                  const globalTick = (curBar-1)*barTicks + curTickInBar;
                  // note name to midi (simple)
                  const m = /^([A-Ga-g])(#|b)?(\d)$/.exec(token.trim());
                  let pitch: number | undefined;
                  if (m){
                    const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
                    let base = names.indexOf((m[1].toUpperCase())+(m[2]||''));
                    if (base===-1){ const enh: any = { Db:'C#', Eb:'D#', Gb:'F#', Ab:'G#', Bb:'A#' }; const k = (m[1].toUpperCase())+(m[2]||''); if (enh[k]) base = names.indexOf(enh[k]); }
                    const oct = Number(m[3]); if (base>=0 && Number.isFinite(oct)) pitch = base + (oct+1)*12;
                  }
                  if (pitch !== undefined) {
                    events.push({ type:'note', tick: globalTick, pitch, velocity:80, duration: durTicks });
                  }
                  curTickInBar += durTicks;
                  i += 2;
                }
                tracks.push({ name: ts.name, channel:0, program:0, events });
              }
              directJsonMidi = { format:1, ppq, tracks };
            } catch {/* fallback: そのまま compile */}
          }
          if (directJsonMidi) {
            song = zSong.parse(directJsonMidi);
          } else {
            const compiled = compileScoreToJsonMidi(inputForCompile);
            song = zSong.parse(compiled);
          }
        } catch (e: any) {
          // Zod 由来の issues を構造化し、全件を詳細ラインで表示
          const issuesArr: any[] = Array.isArray(e?.issues) ? e.issues : [];
          const summary = issuesArr.slice(0,5).map((i:any,idx:number)=> `${idx}(${i.path?.join?.('.')||'(root)'}:${i.message})`).join(' | ');
          const detailLines = issuesArr.map((i:any,idx:number)=> {
            const pathStr = i.path?.join?.('.') || '(root)';
            const code = i.code || 'ZOD_ERROR';
            const exp = (i as any).expected !== undefined ? ` expected=${JSON.stringify((i as any).expected)}` : '';
            const rec = (i as any).received !== undefined ? ` received=${JSON.stringify((i as any).received)}` : '';
            return `#${idx} path=${pathStr} code=${code} msg=${i.message}${exp}${rec}`;
          }).join('\n');
          const more = issuesArr.length > 5 ? ` ...(and ${issuesArr.length-5} more)` : '';
          const msg = `score_dsl_v1 compile/validation failed: ${summary || (e?.message || String(e))}${more}\n--- details ---\n${detailLines}`;
          const err2: any = new Error(msg);
          if (issuesArr.length) err2.issues = issuesArr.map(i => ({ path: i.path, message: i.message, code: i.code, expected: (i as any).expected, received: (i as any).received }));
          throw err2;
        }
      } else {
        // 後方互換: まずJSON MIDI v1として検証→失敗ならScore DSL v1としてコンパイルを試行
        const parsed = zSong.safeParse(json);
        if (parsed.success) {
          song = parsed.data;
        } else {
          // 2段階エラー収集 (JSON MIDI→Score DSL) を詳細化
          const jsonIssues = parsed.error.issues?.map(i => ({ path: i.path.join('.'), message: i.message }));
          let dslCompileError: any = null;
            try {
              const compiled = compileScoreToJsonMidi(json);
              try {
                song = zSong.parse(compiled);
              } catch (e2: any) {
                const z2 = e2?.issues?.map?.((i: any) => `${i.path?.join?.('.')}: ${i.message}`).join('; ');
                dslCompileError = { stage: 'compiled-json-invalid', detail: z2 || e2?.message || String(e2) };
                throw e2;
              }
            } catch (e: any) {
              if (!dslCompileError) {
                const extra = e?.issues?.map?.((i: any)=> `${i.path?.join?.('.')}: ${i.message}`).join('; ') || e?.message || String(e);
                dslCompileError = { stage: 'compile', detail: extra };
              }
              const aggregate = {
                ok: false,
                error: {
                  kind: 'auto_detect_failed',
                  message: 'Neither JSON MIDI v1 nor Score DSL v1 could be validated/compiled',
                  tried: {
                    json_midi_v1: jsonIssues,
                    score_dsl_v1: dslCompileError,
                  }
                }
              };
              throw new Error("AUTO_DETECT_FAILED: " + JSON.stringify(aggregate.error));
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

    // clean_midi: 重複メタ/チャネル別トラック統合（新規ファイル生成）
    if (name === "clean_midi") {
      const fileId: string | undefined = args?.fileId;
      if (!fileId) throw new Error("'fileId' is required for clean_midi");
      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);
      const absPath = path.resolve(resolveBaseDir(), item.path);
      const { cleanMidiFile } = await import('./cleanMidi.js');
      const result = await cleanMidiFile(absPath);
      return wrap({ ok: true, ...result });
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

      // 2.5) グローバルメタ制御: keepGlobalMeta / allowKeyChange フラグ処理
      const keepGlobalMeta = !!args?.keepGlobalMeta;
      const allowKeyChange = !!args?.allowKeyChange;
      // 既存の最初の keySignature / timeSignature / tempo を取得
      const existingMeta = { key: undefined as any, time: undefined as any, tempo: undefined as any };
      for (const ev of (baseJson.tracks[0]?.events||[])) {
        if (!existingMeta.key && ev.type === 'meta.keySignature') existingMeta.key = { sf: ev.sf, mi: ev.mi };
        if (!existingMeta.time && ev.type === 'meta.timeSignature') existingMeta.time = { numerator: ev.numerator, denominator: ev.denominator };
        if (!existingMeta.tempo && ev.type === 'meta.tempo') existingMeta.tempo = { usPerQuarter: ev.usPerQuarter };
        if (existingMeta.key && existingMeta.time && existingMeta.tempo) break;
      }
      // 追記チャンク内のグローバルメタを検査
      if (!keepGlobalMeta) {
        for (const tr of addSong.tracks) {
          tr.events = tr.events.filter((ev: any) => {
            if (ev.type === 'meta.keySignature') {
              if (existingMeta.key) {
                // 既存キーと異なり allowKeyChange でない → 無視
                if (!allowKeyChange && (existingMeta.key.sf !== ev.sf || existingMeta.key.mi !== ev.mi)) {
                  return false;
                }
                // 同一キーは重複除去
                if (existingMeta.key.sf === ev.sf && existingMeta.key.mi === ev.mi) return false;
              }
            }
            if (ev.type === 'meta.timeSignature') {
              if (existingMeta.time) {
                if (existingMeta.time.numerator === ev.numerator && existingMeta.time.denominator === ev.denominator) return false; // 重複除去
              }
            }
            if (ev.type === 'meta.tempo') {
              if (existingMeta.tempo) {
                if (existingMeta.tempo.usPerQuarter === ev.usPerQuarter) return false;
              }
            }
            return true;
          });
        }
      }

      // 3) 追記位置の決定（atEnd優先→atTick→既定末尾）。gapTicksで隙間を空ける
      const atEnd: boolean = !!args?.atEnd;
      const atTickArg = Number.isFinite(Number(args?.atTick)) ? (args.atTick|0) : undefined;
      const gapTicks = Number.isFinite(Number(args?.gapTicks)) ? Math.max(0, args.gapTicks|0) : 0;
      const trackIndex = Number.isFinite(Number(args?.trackIndex)) ? Math.max(0, args.trackIndex|0) : undefined;
      const preserveTrackStructure = !!args?.preserveTrackStructure;
      const trackMapping = Array.isArray(args?.trackMapping) ? args.trackMapping.map((n: any) => Math.max(0, Number(n) || 0)) : undefined;

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

      // 4) 挿入オフセットの算出（グローバルまたは指定トラックの末尾）
      let insertTick: number;
      if (preserveTrackStructure) {
        // トラック構造保持モード：グローバル末尾基準
        insertTick = atEnd ? globalEnd + gapTicks : (atTickArg ?? (globalEnd + gapTicks));
      } else {
        // 従来モード：単一トラック指定
        let tgt = trackIndex;
        if (!Number.isFinite(tgt as number)) {
          const cand = baseJson.tracks.findIndex((tr: any)=> (tr.events||[]).some((e:any)=> e.type!=="meta.tempo" && e.type!=="meta.timeSignature" && e.type!=="meta.keySignature"));
          tgt = (cand >= 0 ? cand : 0);
        }
        if (!baseJson.tracks[tgt!]) baseJson.tracks[tgt!] = { events: [] };
        insertTick = atEnd ? (trackEndTicks[tgt!] ?? globalEnd) + gapTicks : (atTickArg ?? (globalEnd + gapTicks));
      }

      // 5) 追加曲の各イベントを insertTick へ相対シフトして追記
      if (preserveTrackStructure) {
        // トラック構造保持モード：各トラックを個別に追記
        for (let srcTrackIdx = 0; srcTrackIdx < addSong.tracks.length; srcTrackIdx++) {
          const srcTrack = addSong.tracks[srcTrackIdx];
          let dstTrackIdx: number;
          
          if (trackMapping && trackMapping[srcTrackIdx] !== undefined) {
            // 明示的マッピング指定
            dstTrackIdx = trackMapping[srcTrackIdx];
          } else {
            // 自動配置：既存トラック数から追記
            dstTrackIdx = baseJson.tracks.length + srcTrackIdx;
          }
          
          // 対象トラックを確保（配列の長さを動的に拡張）
          while (baseJson.tracks.length <= dstTrackIdx) {
            baseJson.tracks.push({ events: [] });
          }
          if (!baseJson.tracks[dstTrackIdx]) {
            baseJson.tracks[dstTrackIdx] = { events: [] };
          }
          
          for (const ev of srcTrack.events) {
            if (ev.type === 'meta.tempo' || ev.type === 'meta.timeSignature' || ev.type === 'meta.keySignature') {
              // グローバルメタは track0 に入れる
              const tick = insertTick + (ev.tick|0);
              if (!baseJson.tracks[0]) baseJson.tracks[0] = { events: [] };
              baseJson.tracks[0].events.push({ ...ev, tick });
            } else {
              const tick = insertTick + (ev.tick|0);
              baseJson.tracks[dstTrackIdx].events.push({ ...ev, tick });
            }
          }
        }
      } else {
        // 従来モード：全トラックを1つに統合
        let tgt = trackIndex;
        if (!Number.isFinite(tgt as number)) {
          const cand = baseJson.tracks.findIndex((tr: any)=> (tr.events||[]).some((e:any)=> e.type!=="meta.tempo" && e.type!=="meta.timeSignature" && e.type!=="meta.keySignature"));
          tgt = (cand >= 0 ? cand : 0);
        }
        if (!baseJson.tracks[tgt!]) baseJson.tracks[tgt!] = { events: [] };
        
        const dst = baseJson.tracks[tgt!];
        for (const tr of addSong.tracks) {
          for (const ev of tr.events) {
            if (ev.type === 'meta.tempo' || ev.type === 'meta.timeSignature' || ev.type === 'meta.keySignature') {
              // グローバルメタは track0 に入れる
              const tick = insertTick + (ev.tick|0);
              if (!baseJson.tracks[0]) baseJson.tracks[0] = { events: [] };
              baseJson.tracks[0].events.push({ ...ev, tick });
            } else {
              const tick = insertTick + (ev.tick|0);
              dst.events.push({ ...ev, tick });
            }
          }
        }
      }

      // 6) 正規化（簡易: tickでソート、NoteOff順はエンコーダ側のordで制御）
      for (const tr of baseJson.tracks) {
        tr.events.sort((a:any,b:any)=>{
          const ta=a.tick|0, tb=b.tick|0; if (ta!==tb) return ta-tb; return String(a.type).localeCompare(String(b.type));
        });
      }

      // 6.5) keySignature 差異検出警告 (allowKeyChange=false で保持された場合は既にフィルタ済み)
      let warnings: string[] | undefined;
      // 重複メタ (tick0 同種) をここでも最終チェックして prune
      const t0 = baseJson.tracks[0];
      if (t0) {
        const seen = new Set<string>();
        t0.events = t0.events.filter((ev:any)=>{
          if (ev?.type && ['meta.tempo','meta.timeSignature','meta.keySignature'].includes(ev.type) && (ev.tick||0)===0) {
            if (seen.has(ev.type)) { (warnings ||= []).push(`duplicate_meta_pruned:${ev.type}`); return false; }
            seen.add(ev.type);
          }
          return true;
        });
      }
      // 大きなギャップ検知: insertTick が既存末尾より >1小節相当 (ppq*4) の場合
      const ppqForGap = baseJson.ppq || 480;
      const barTicks = ppqForGap * 4; // 4/4前提 (timeSig 変化未サポート部位)
      const maxPrevTick = Math.max(0, ...baseJson.tracks.flatMap((t:any)=> t.events.map((e:any)=> e.tick||0)));
      if (insertTick - maxPrevTick > barTicks) {
        (warnings ||= []).push(`large_gap_detected:${insertTick-maxPrevTick}`);
      }
      if (allowKeyChange && !keepGlobalMeta) {
        // フィルタ除去された可能性を示す通知（差異があったことを明示できれば理想だが元イベントは捨てている）
        // 実装簡易化のためスキップ; 将来: 差異検出時にフラグ設定
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
  return wrap({ ok: true, fileId: item.id, name: nameWithExt, path: relPath, bytes, insertedAtTick: insertTick, warnings });
      } else {
        const newId = randomUUID();
        const createdAt = new Date().toISOString();
        const rec = { id: newId, name: nameWithExt, path: relPath, bytes, createdAt };
        await appendItem(rec);
        inMemoryIndex.set(newId, rec);
  return wrap({ ok: true, fileId: newId, name: nameWithExt, path: relPath, bytes, insertedAtTick: insertTick, warnings });
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

    // --- 継続記録セッション管理 -----------------------------------------
    type ContinuousRecordingSession = {
      id: string;
      startedAt: number; // epoch ms
      firstInputAt?: number; // epoch ms
      lastInputAt?: number; // epoch ms
      status: 'waiting_for_input' | 'recording' | 'completed' | 'timeout_idle' | 'timeout_silence' | 'timeout_max_duration' | 'stopped_manually' | 'error';
      reason?: string;
      // 設定値
      ppq: number;
      maxDurationMs: number;
      idleTimeoutMs: number;
      silenceTimeoutMs: number;
      channelFilter?: number[]; // 1-16 external representation
      eventTypeFilter: string[]; // 'note', 'cc', 'pitchBend', 'program'
      // MIDI入力管理
      inputInstance?: any; // node-midi Input
      inputPortName?: string;
      // イベントバッファ
      events: Array<{
        tick: number;
        type: string;
        channel?: number; // 内部0-15
        [key: string]: any;
      }>;
      // タイマー管理
      idleTimer?: NodeJS.Timeout;
      silenceTimer?: NodeJS.Timeout;
      maxDurationTimer?: NodeJS.Timeout;
      // メトリクス
      eventCount: number;
      eventBreakdown: Record<string, number>;
      channelActivity: Record<string, number>;
    };

    const continuousRecordingRegistry: Map<string, ContinuousRecordingSession> = 
      (globalThis as any).__continuousRecordings = (globalThis as any).__continuousRecordings || new Map();

    // 24時間自動削除クリーンアップ
    function cleanupOldSessions() {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24時間
      
      for (const [sessionId, session] of continuousRecordingRegistry.entries()) {
        // 完了から24時間経過したセッションを削除
        if (session.status === 'completed' || 
            session.status.startsWith('timeout_') || 
            session.status === 'stopped_manually' ||
            session.status === 'error') {
          const endTime = session.lastInputAt || session.startedAt;
          if (now - endTime > maxAge) {
            // MIDI入力ポートがまだ開いていれば閉じる
            if (session.inputInstance) {
              try {
                if (typeof session.inputInstance.closePort === 'function') {
                  session.inputInstance.closePort();
                }
              } catch {
                // クローズエラーは無視
              }
            }
            continuousRecordingRegistry.delete(sessionId);
          }
        }
      }
    }

    // 定期的なクリーンアップ（5分毎）
    const cleanupInterval = setInterval(cleanupOldSessions, 5 * 60 * 1000);
    // プロセス終了時にクリーンアップ停止
    process.once('exit', () => clearInterval(cleanupInterval));

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

    // --- 継続記録ツール実装 ---------------------------------------------
    
    // 継続記録セッション管理関数
    function createContinuousSession(
      portName: string,
      ppq: number,
      maxDurationMs: number,
      idleTimeoutMs: number,
      silenceTimeoutMs: number,
      channelFilter?: number[],
      eventTypeFilter?: string[]
    ): ContinuousRecordingSession {
      const id = randomUUID();
      const session: ContinuousRecordingSession = {
        id,
        startedAt: Date.now(),
        status: 'waiting_for_input',
        ppq,
        maxDurationMs,
        idleTimeoutMs,
        silenceTimeoutMs,
        channelFilter,
        eventTypeFilter: eventTypeFilter || ['note', 'cc', 'pitchBend', 'program'],
        inputPortName: portName,
        events: [],
        eventCount: 0,
        eventBreakdown: {},
        channelActivity: {}
      };
      return session;
    }

    // セッション終了処理（クリーンアップ）
    function finalizeSession(session: ContinuousRecordingSession, reason: string) {
      // reasonは常に設定（既に終了済みでも更新）
      session.reason = reason;

      // 既に終了済みの場合はクリーンアップをスキップ
      if (session.status.startsWith('timeout_') || session.status === 'completed' || session.status === 'stopped_manually') {
        // reasonは設定したので、クリーンアップ処理のみスキップ
        if (!session.idleTimer && !session.silenceTimer && !session.maxDurationTimer) {
          return; // 既にクリーンアップ済み
        }
      }

      // タイマークリア
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = undefined;
      }
      if (session.silenceTimer) {
        clearTimeout(session.silenceTimer);
        session.silenceTimer = undefined;
      }
      if (session.maxDurationTimer) {
        clearTimeout(session.maxDurationTimer);
        session.maxDurationTimer = undefined;
      }

      // MIDI入力クローズ
      if (session.inputInstance) {
        try {
          session.inputInstance.closePort();
        } catch {}
        session.inputInstance = undefined;
      }
    }

    // サイレンスタイマー開始
    function startSilenceTimer(session: ContinuousRecordingSession) {
      // 既存のサイレンスタイマーをクリア
      if (session.silenceTimer) {
        clearTimeout(session.silenceTimer);
      }

      session.silenceTimer = setTimeout(async () => {
        const currentSession = continuousRecordingRegistry.get(session.id);
        if (currentSession && currentSession.status === 'recording') {
          currentSession.status = 'timeout_silence';
          finalizeSession(currentSession, 'silence_timeout');
          
          // 自動SMF保存
          try {
            await saveContinuousRecordingAsSmf(currentSession);
          } catch (error) {
            console.error('Failed to auto-save recording on silence timeout:', error);
          }
          
          continuousRecordingRegistry.set(currentSession.id, currentSession);
        }
      }, session.silenceTimeoutMs);
    }

    // 継続記録セッションをSMFとして保存
    async function saveContinuousRecordingAsSmf(
      session: ContinuousRecordingSession, 
      name?: string, 
      overwrite?: boolean
    ): Promise<{
      fileId: string;
      name: string;
      path: string;
      bytes: number;
      durationMs: number;
      eventCount: number;
      ppq: number;
      trackCount: number;
    }> {
      // ファイル名生成・重複回避
      const timestamp = new Date(session.startedAt);
      const defaultName = `recording-${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')}-${String(timestamp.getHours()).padStart(2, '0')}${String(timestamp.getMinutes()).padStart(2, '0')}${String(timestamp.getSeconds()).padStart(2, '0')}.mid`;
      let filename = name || defaultName;
      
      // 重複回避（overwriteが false の場合）
      if (!overwrite) {
        let counter = 1;
        const originalFilename = filename;
        const baseName = filename.replace(/\.mid$/, '');
        
        // 既存ファイルをチェック
        while (true) {
          try {
            const testPath = path.resolve(resolveBaseDir(), 'data/midi', filename);
            await fs.access(testPath);
            // ファイルが存在する場合、番号付きファイル名を生成
            filename = `${baseName}_${counter}.mid`;
            counter++;
          } catch {
            // ファイルが存在しない場合、このファイル名を使用
            break;
          }
        }
      }

      // JSON MIDI形式に変換
      const jsonMidi = {
        format: 0 as const,
        ppq: session.ppq,
        tracks: [
          {
            events: session.events as any // 型チェックをスキップ（実行時は正しいイベント形式）
          }
        ]
      };

      // 既存のjson_to_smf機能を活用してSMFバイナリを生成
      const smfBuffer = encodeToSmfBinary(jsonMidi);
      
      // ファイル保存とマニフェスト追加
      const fileId = randomUUID();
      const filePath = `data/midi/${filename}`;
      
      // 実際のファイル書き込み
      const absolutePath = path.resolve(resolveBaseDir(), filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, smfBuffer);
      
      // マニフェストに追加
      const item = {
        id: fileId,
        name: filename,
        bytes: smfBuffer.length,
        path: filePath,
        createdAt: Date.now().toString()
      };
      
      await appendItem(item);

      return {
        fileId,
        name: filename,
        path: filePath,
        bytes: smfBuffer.length,
        durationMs: session.lastInputAt ? (session.lastInputAt - session.startedAt) : 0,
        eventCount: session.eventCount,
        ppq: session.ppq,
        trackCount: 1
      };
    }

    function msToTick(relativeMs: number, ppq: number): number {
      // 仮の固定テンポ120BPM (500000 us/quarter)
      const usPerQuarter = 500000;
      const ticksPerMs = (ppq * 1000) / usPerQuarter;
      return Math.round(relativeMs * ticksPerMs);
    }

    // 小節計算ヘルパー関数
    function barToTick(bar: number, ppq: number, timeSignature: { numerator: number; denominator: number } = { numerator: 4, denominator: 4 }): number {
      // 小節1から開始（bar=1は tick=0）
      const barIndex = bar - 1;
      const ticksPerBeat = ppq * (4 / timeSignature.denominator); // 4分音符基準
      const ticksPerBar = ticksPerBeat * timeSignature.numerator;
      return Math.round(barIndex * ticksPerBar);
    }

    function tickToBar(tick: number, ppq: number, timeSignature: { numerator: number; denominator: number } = { numerator: 4, denominator: 4 }): number {
      const ticksPerBeat = ppq * (4 / timeSignature.denominator);
      const ticksPerBar = ticksPerBeat * timeSignature.numerator;
      const barIndex = Math.floor(tick / ticksPerBar);
      return barIndex + 1; // 小節1から開始
    }

    function extractTimeSignatureFromJson(jsonMidi: any): { numerator: number; denominator: number } {
      // JSON MIDIからタイムシグネチャを抽出
      if (jsonMidi?.tracks) {
        for (const track of jsonMidi.tracks) {
          if (track?.events) {
            for (const event of track.events) {
              if (event?.type === 'meta.timeSignature' && event.numerator && event.denominator) {
                return { numerator: event.numerator, denominator: event.denominator };
              }
            }
          }
        }
      }
      return { numerator: 4, denominator: 4 }; // デフォルト4/4拍子
    }

    function addEventToSession(session: ContinuousRecordingSession, midiBytes: number[], relativeMs: number) {
      // メモリ制限チェック（イベント数上限: 100,000）
      if (session.events.length >= 100000) {
        session.status = 'error';
        session.reason = 'event_limit_exceeded';
        finalizeSession(session, 'event_limit_exceeded');
        return;
      }

      // 推定メモリサイズチェック（セッション全体で10MB上限）
      const estimatedMemoryBytes = session.events.length * 50; // イベントあたり約50バイト推定
      if (estimatedMemoryBytes >= 10 * 1024 * 1024) { // 10MB
        session.status = 'error';
        session.reason = 'memory_limit_exceeded';
        finalizeSession(session, 'memory_limit_exceeded');
        return;
      }

      const status = midiBytes[0] || 0;
      const type = status & 0xF0;
      const channel = status & 0x0F; // 内部0-15
      const externalChannel = channel + 1; // 外部1-16

      // チャンネルフィルター適用
      if (session.channelFilter && !session.channelFilter.includes(externalChannel)) {
        return;
      }

      const tick = msToTick(relativeMs, session.ppq);
      let eventType = '';
      let event: any = { tick, channel };

      if (type === 0x90 && midiBytes.length >= 3) { // Note On
        const velocity = midiBytes[2] || 0;
        if (velocity > 0) {
          eventType = 'note';
          event = {
            ...event,
            type: 'note',
            pitch: midiBytes[1] || 0,
            velocity,
            // duration は Note Off で計算（今は仮値）
            duration: session.ppq
          };
        } else {
          // Velocity 0 は Note Off扱い - 今は無視
          return;
        }
      } else if (type === 0x80 && midiBytes.length >= 3) { // Note Off
        // Note Off処理は後で実装 - 今は無視
        return;
      } else if (type === 0xB0 && midiBytes.length >= 3) { // Control Change
        eventType = 'cc';
        event = {
          ...event,
          type: 'cc',
          controller: midiBytes[1] || 0,
          value: midiBytes[2] || 0
        };
      } else if (type === 0xE0 && midiBytes.length >= 3) { // Pitch Bend
        eventType = 'pitchBend';
        const value = ((midiBytes[2] || 0) << 7) | (midiBytes[1] || 0);
        event = {
          ...event,
          type: 'pitchBend',
          value: value - 8192 // -8192 to +8191
        };
      } else if (type === 0xC0 && midiBytes.length >= 2) { // Program Change
        eventType = 'program';
        event = {
          ...event,
          type: 'program',
          program: midiBytes[1] || 0
        };
      } else {
        return; // 未対応イベント
      }

      // イベントタイプフィルター適用
      if (!session.eventTypeFilter.includes(eventType)) {
        return;
      }

      // イベント追加
      session.events.push(event);
      session.eventCount++;
      session.eventBreakdown[eventType] = (session.eventBreakdown[eventType] || 0) + 1;
      session.channelActivity[externalChannel.toString()] = (session.channelActivity[externalChannel.toString()] || 0) + 1;
      session.lastInputAt = Date.now();

      // 最初の入力で状態変更
      if (session.status === 'waiting_for_input') {
        session.status = 'recording';
        session.firstInputAt = Date.now();
        // idleTimer をクリア
        if (session.idleTimer) {
          clearTimeout(session.idleTimer);
          session.idleTimer = undefined;
        }
      }

      // サイレンスタイマーをリセット（新しい入力があったため）
      startSilenceTimer(session);
    }

    if (name === 'start_continuous_recording') {
      await loadMidi();
      if (!MidiInput) throw new Error('node-midi not available for input');
      
      // マルチセッション制限チェック（最大3セッション同時）
      const activeSessions = Array.from(continuousRecordingRegistry.values()).filter(s => 
        s.status === 'waiting_for_input' || s.status === 'recording'
      );
      if (activeSessions.length >= 3) {
        const error = classifyError('start_continuous_recording', new Error("Maximum concurrent recording sessions (3) exceeded"));
        return wrap({ ok: false, error }) as any;
      }
      
      // パラメータ解析
      const ppq = Number.isFinite(Number(args?.ppq)) ? Math.max(96, Math.min(1920, Number(args.ppq))) : 480;
      const maxDurationMs = Number.isFinite(Number(args?.maxDurationMs)) ? Math.max(1000, Math.min(3600000, Number(args.maxDurationMs))) : 300000;
      const idleTimeoutMs = Number.isFinite(Number(args?.idleTimeoutMs)) ? Math.max(1000, Math.min(120000, Number(args.idleTimeoutMs))) : 30000;
      const silenceTimeoutMs = Number.isFinite(Number(args?.silenceTimeoutMs)) ? Math.max(1000, Math.min(60000, Number(args.silenceTimeoutMs))) : 10000;
      const reqPortName: string | undefined = args?.portName;
      const channelFilter: number[] | undefined = Array.isArray(args?.channelFilter) ? args.channelFilter.filter((n: any) => Number.isInteger(n) && n >= 1 && n <= 16) : undefined;
      const eventTypeFilter: string[] | undefined = Array.isArray(args?.eventTypeFilter) ? args.eventTypeFilter.filter((s: any) => typeof s === 'string' && ['note', 'cc', 'pitchBend', 'program'].includes(s)) : undefined;

      // 入力ポート決定
      const temp = new MidiInput();
      const count = typeof temp.getPortCount === 'function' ? temp.getPortCount() : 0;
      const ports: string[] = [];
      for (let i = 0; i < count; i++) {
        try {
          ports.push(temp.getPortName(i) || `input:${i}`);
        } catch {
          ports.push(`input:${i}`);
        }
      }
      
      let index = 0;
      if (reqPortName) {
        const found = ports.findIndex(p => p === reqPortName || p.includes(reqPortName));
        if (found >= 0) index = found;
        else throw new Error(`input port not found: ${reqPortName}`);
      }

      const actualPortName = ports[index] || 'unknown';
      
      // セッション作成
      const session = createContinuousSession(
        actualPortName,
        ppq,
        maxDurationMs,
        idleTimeoutMs,
        silenceTimeoutMs,
        channelFilter,
        eventTypeFilter
      );

      // MIDI入力設定
      const inp = temp; // reuse temp instance
      try {
        inp.openPort(index);
      } catch {
        try { inp.closePort(); } catch {}
        throw new Error(`failed to open input port index=${index}`);
      }

      try {
        if (typeof inp.ignoreTypes === 'function') inp.ignoreTypes(false, false, false);
      } catch {}

      session.inputInstance = inp;

      // メッセージハンドラ設定
      const handler = (delta: number, message: number[]) => {
        try {
          const now = Date.now();
          const relativeMs = now - session.startedAt;
          
          if (session.status === 'waiting_for_input' || session.status === 'recording') {
            addEventToSession(session, message, relativeMs);
          }
        } catch {
          // エラーは握りつぶし
        }
      };

      inp.on('message', handler);

      // タイマー設定
      session.idleTimer = setTimeout(async () => {
        const currentSession = continuousRecordingRegistry.get(session.id);
        if (currentSession && currentSession.status === 'waiting_for_input') {
          currentSession.status = 'timeout_idle';
          finalizeSession(currentSession, 'idle_timeout');
          
          // 自動SMF保存
          try {
            await saveContinuousRecordingAsSmf(currentSession);
          } catch (error) {
            console.error('Failed to auto-save recording on idle timeout:', error);
          }
          
          continuousRecordingRegistry.set(currentSession.id, currentSession);
        }
      }, idleTimeoutMs);

      session.maxDurationTimer = setTimeout(async () => {
        const currentSession = continuousRecordingRegistry.get(session.id);
        if (currentSession && (currentSession.status === 'waiting_for_input' || currentSession.status === 'recording')) {
          currentSession.status = 'timeout_max_duration';
          finalizeSession(currentSession, 'max_duration');
          
          // 自動SMF保存
          try {
            await saveContinuousRecordingAsSmf(currentSession);
          } catch (error) {
            console.error('Failed to auto-save recording on max duration timeout:', error);
          }
          
          continuousRecordingRegistry.set(currentSession.id, currentSession);
        }
      }, maxDurationMs);

      // レジストリ登録
      continuousRecordingRegistry.set(session.id, session);

      return wrap({
        ok: true,
        recordingId: session.id,
        portName: actualPortName,
        ppq,
        maxDurationMs,
        idleTimeoutMs,
        silenceTimeoutMs,
        channelFilter,
        eventTypeFilter: session.eventTypeFilter,
        startedAt: new Date(session.startedAt).toISOString(),
        status: session.status
      }) as any;
    }

    if (name === 'get_continuous_recording_status') {
      const recordingId: string | undefined = args?.recordingId;
      if (!recordingId) throw new Error("'recordingId' is required for get_continuous_recording_status");
      
      const session = continuousRecordingRegistry.get(recordingId);
      if (!session) throw new Error(`recording session not found: ${recordingId}`);

      const now = Date.now();
      const currentDurationMs = now - session.startedAt;
      
      // タイムアウトの自動チェック（状態遷移は各タイマーが担当）
      let timeUntilTimeout = 0;
      if (session.status === 'waiting_for_input') {
        const idleRemaining = Math.max(0, session.idleTimeoutMs - currentDurationMs);
        const maxDurationRemaining = Math.max(0, session.maxDurationMs - currentDurationMs);
        timeUntilTimeout = Math.min(idleRemaining, maxDurationRemaining);
      } else if (session.status === 'recording' && session.lastInputAt) {
        const silenceElapsed = now - session.lastInputAt;
        const silenceRemaining = Math.max(0, session.silenceTimeoutMs - silenceElapsed);
        const maxDurationRemaining = Math.max(0, session.maxDurationMs - currentDurationMs);
        timeUntilTimeout = Math.min(silenceRemaining, maxDurationRemaining);
      } else if (session.status === 'recording') {
        // recording状態だがlastInputAtがない場合（通常起こらないが安全のため）
        timeUntilTimeout = Math.max(0, session.maxDurationMs - currentDurationMs);
      }

      return wrap({
        ok: true,
        recordingId: session.id,
        status: session.status,
        startedAt: new Date(session.startedAt).toISOString(),
        firstInputAt: session.firstInputAt ? new Date(session.firstInputAt).toISOString() : undefined,
        lastInputAt: session.lastInputAt ? new Date(session.lastInputAt).toISOString() : undefined,
        currentDurationMs,
        eventCount: session.eventCount,
        eventBreakdown: session.eventBreakdown,
        channelActivity: session.channelActivity,
        timeUntilTimeout,
        reason: session.reason,
        estimatedFileSizeBytes: session.eventCount * 8 + 1024, // 概算
        portName: session.inputPortName
      }) as any;
    }

    if (name === 'stop_continuous_recording') {
      const recordingId: string | undefined = args?.recordingId;
      const requestedName: string | undefined = args?.name;
      const overwrite: boolean = args?.overwrite ?? false;

      if (!recordingId) throw new Error("'recordingId' is required for stop_continuous_recording");
      
      const session = continuousRecordingRegistry.get(recordingId);
      if (!session) throw new Error(`recording session not found: ${recordingId}`);

      // 手動終了の場合、セッション状態を更新
      if (!session.status.startsWith('timeout_') && session.status !== 'completed') {
        session.status = 'stopped_manually';
        finalizeSession(session, 'manual_stop');
      }

      // SMF生成・保存
      const savedFile = await saveContinuousRecordingAsSmf(session, requestedName, overwrite);

      // レジストリから削除（クリーンアップ）
      continuousRecordingRegistry.delete(recordingId);

      return wrap({
        ok: true,
        recordingId,
        fileId: savedFile.fileId,
        name: savedFile.name,
        path: savedFile.path,
        bytes: savedFile.bytes,
        durationMs: savedFile.durationMs,
        eventCount: savedFile.eventCount,
        ppq: savedFile.ppq,
        trackCount: savedFile.trackCount,
        reason: session.reason || 'manual_stop',
        recordingStartedAt: new Date(session.startedAt).toISOString(),
        recordingEndedAt: session.lastInputAt ? new Date(session.lastInputAt).toISOString() : new Date(session.startedAt).toISOString(),
        savedAt: new Date().toISOString()
      }) as any;
    }

    if (name === 'list_continuous_recordings') {
      const statusFilter: string = args?.status || 'active';
      const limit: number = Math.max(1, Math.min(50, args?.limit || 10));

      const allSessions = Array.from(continuousRecordingRegistry.values());
      
      // フィルター適用
      let filteredSessions = allSessions;
      if (statusFilter === 'active') {
        filteredSessions = allSessions.filter(s => 
          s.status === 'waiting_for_input' || s.status === 'recording'
        );
      } else if (statusFilter === 'completed') {
        filteredSessions = allSessions.filter(s => 
          s.status === 'completed' || 
          s.status === 'timeout_idle' || 
          s.status === 'timeout_silence' || 
          s.status === 'timeout_max_duration' || 
          s.status === 'stopped_manually'
        );
      }
      // statusFilter === 'all' の場合はフィルターなし

      // 制限適用（新しいものから順）
      const sortedSessions = filteredSessions
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit);

      // レスポンス形式に変換
      const recordings = sortedSessions.map(session => {
        const now = Date.now();
        const durationMs = session.lastInputAt 
          ? session.lastInputAt - session.startedAt
          : now - session.startedAt;

        const recording: any = {
          recordingId: session.id,
          status: session.status,
          startedAt: new Date(session.startedAt).toISOString(),
          durationMs: Math.max(0, durationMs),
          eventCount: session.events.length,
          portName: session.inputPortName || 'unknown'
        };

        // 完了セッションの場合は追加情報
        if (session.status === 'completed' || 
            session.status.startsWith('timeout_') || 
            session.status === 'stopped_manually') {
          if (session.lastInputAt) {
            recording.endedAt = new Date(session.lastInputAt).toISOString();
          }
          if (session.reason) {
            recording.reason = session.reason;
          }
          // fileIdは保存後に設定されるが、現在の実装ではセッション終了と同時にレジストリから削除される
          // 将来的な拡張では保存されたfileId情報を含める可能性がある
          recording.fileId = null;
          recording.name = null;
        } else {
          recording.fileId = null;
        }

        return recording;
      });

      // 統計情報
      const activeCount = allSessions.filter(s => 
        s.status === 'waiting_for_input' || s.status === 'recording'
      ).length;
      const completedCount = allSessions.filter(s => 
        s.status === 'completed' || 
        s.status === 'timeout_idle' || 
        s.status === 'timeout_silence' || 
        s.status === 'timeout_max_duration' || 
        s.status === 'stopped_manually'
      ).length;

      return wrap({
        ok: true,
        recordings,
        total: allSessions.length,
        activeCount,
        completedCount
      }) as any;
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

    // extract_bars: 指定小節範囲をJSON MIDI形式で抽出
    if (name === "extract_bars") {
      const fileId: string | undefined = args?.fileId;
      const startBar: number | undefined = args?.startBar;
      const endBar: number | undefined = args?.endBar;
      const format: string = args?.format || "json_midi_v1";

      if (!fileId) throw new Error("'fileId' is required for extract_bars");
      if (!Number.isFinite(Number(startBar)) || Number(startBar) < 1) throw new Error("'startBar' must be >= 1");
      if (!Number.isFinite(Number(endBar)) || Number(endBar) < 1) throw new Error("'endBar' must be >= 1");
      if (Number(startBar) > Number(endBar)) throw new Error("'startBar' must be <= 'endBar'");

      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);
      const json = await decodeSmfToJson(buf);

      // タイムシグネチャを抽出
      const timeSignature = extractTimeSignatureFromJson(json);
      const ppq = json.ppq || 480;

      // 小節範囲をtickに変換
      const startTick = barToTick(Number(startBar), ppq, timeSignature);
      const endTick = barToTick(Number(endBar) + 1, ppq, timeSignature); // 終了小節の次の小節の開始tick

      // 指定範囲のイベントを抽出
      const extractedJson = {
        ppq,
        tracks: json.tracks.map((track: any) => {
          const filteredEvents = (track.events || [])
            .filter((event: any) => {
              const eventTick = event.tick || 0;
              return eventTick >= startTick && eventTick < endTick;
            })
            .map((event: any) => ({
              ...event,
              tick: event.tick - startTick // 相対tickに変換
            }));
          
          return {
            ...track,
            events: filteredEvents
          };
        })
      };

      // Score DSL形式が要求された場合は変換（将来拡張）
      if (format === "score_dsl_v1") {
        // 現在は未実装、JSON MIDI形式で返却
        console.warn("Score DSL v1 export is not yet implemented, returning JSON MIDI v1");
      }

      return wrap({
        ok: true,
        fileId,
        startBar: Number(startBar),
        endBar: Number(endBar),
        startTick,
        endTick,
        json: extractedJson,
        ppq,
        timeSignature,
        eventCount: extractedJson.tracks.reduce((sum: number, track: any) => sum + (track.events?.length || 0), 0),
        durationTicks: endTick - startTick
      }) as any;
    }

    // replace_bars: 指定小節範囲をJSONデータで置換
    if (name === "replace_bars") {
      const fileId: string | undefined = args?.fileId;
      const startBar: number | undefined = args?.startBar;
      const endBar: number | undefined = args?.endBar;
      const jsonData: any = args?.json;
      const format: string = args?.format || "json_midi_v1";
      const outputName: string | undefined = args?.outputName;

      if (!fileId) throw new Error("'fileId' is required for replace_bars");
      if (!Number.isFinite(Number(startBar)) || Number(startBar) < 1) throw new Error("'startBar' must be >= 1");
      if (!Number.isFinite(Number(endBar)) || Number(endBar) < 1) throw new Error("'endBar' must be >= 1");
      if (Number(startBar) > Number(endBar)) throw new Error("'startBar' must be <= 'endBar'");
      if (!jsonData) throw new Error("'json' is required for replace_bars");

      let item: ItemRec | undefined = inMemoryIndex.get(fileId);
      if (!item) item = (await getItemById(fileId)) as ItemRec | undefined;
      if (!item) throw new Error(`fileId not found: ${fileId}`);

      const absPath = path.resolve(resolveBaseDir(), item.path);
      const buf = await fs.readFile(absPath);
      const originalJson = await decodeSmfToJson(buf);

      // タイムシグネチャを抽出
      const timeSignature = extractTimeSignatureFromJson(originalJson);
      const ppq = originalJson.ppq || 480;

      // 小節範囲をtickに変換
      const startTick = barToTick(Number(startBar), ppq, timeSignature);
      const endTick = barToTick(Number(endBar) + 1, ppq, timeSignature);

      // 置換用JSONデータの処理
      let replacementJson: any;
      if (typeof jsonData === 'string') {
        try {
          replacementJson = JSON.parse(jsonData);
        } catch {
          throw new Error("Invalid JSON string in 'json' parameter");
        }
      } else {
        replacementJson = jsonData;
      }

      // Score DSL形式の場合はコンパイル
      if (format === "score_dsl_v1") {
        try {
          replacementJson = compileScoreToJsonMidi(replacementJson);
        } catch (err: any) {
          throw new Error(`Score DSL compilation failed: ${err.message}`);
        }
      }

      // 置換処理：指定範囲のイベントを削除し、新しいイベントを追加
      const modifiedJson = {
        ...originalJson,
        tracks: originalJson.tracks.map((track: any, trackIndex: number) => {
          // 指定範囲外のイベントを保持
          const eventsOutsideRange = (track.events || [])
            .filter((event: any) => {
              const eventTick = event.tick || 0;
              return eventTick < startTick || eventTick >= endTick;
            });

          // 置換用データから全トラックのイベントを取得（SMF→JSONで統合されている可能性があるため）
          let replacementEvents: any[] = [];
          
          if (trackIndex === 0) {
            // 統合されたトラックの場合、置換データの全非メタイベントを統合
            for (const replacementTrack of (replacementJson.tracks || [])) {
              const trackEvents = (replacementTrack.events || [])
                .filter((event: any) => !event.type?.startsWith('meta.')) // メタイベント除外
                .map((event: any) => ({
                  ...event,
                  tick: (event.tick || 0) + startTick, // 絶対tickに変換
                  channel: event.channel !== undefined ? event.channel : replacementTrack.channel // トラックのチャンネルを継承
                }));
              replacementEvents.push(...trackEvents);
            }
          } else if (replacementJson.tracks?.[trackIndex]) {
            // 対応するトラックがある場合はそのイベントを使用
            replacementEvents = (replacementJson.tracks[trackIndex].events || [])
              .map((event: any) => ({
                ...event,
                tick: (event.tick || 0) + startTick // 絶対tickに変換
              }));
          }

          return {
            ...track,
            events: [...eventsOutsideRange, ...replacementEvents].sort((a: any, b: any) => (a.tick || 0) - (b.tick || 0))
          };
        })
      };

      // SMFファイルとして保存
      const bin = encodeToSmfBinary(modifiedJson);
      const data = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
      const midiDir = resolveMidiDir();
      await fs.mkdir(midiDir, { recursive: true });

      // 出力ファイル名の決定
      let finalName: string;
      if (outputName) {
        finalName = outputName.endsWith('.mid') ? outputName : `${outputName}.mid`;
      } else {
        const baseName = item.name.replace(/\.mid$/i, '');
        finalName = `${baseName}_bars${startBar}-${endBar}.mid`;
      }

      const absOut = path.join(midiDir, finalName);
      await fs.writeFile(absOut, data);
      const base = resolveBaseDir();
      const relPath = path.relative(base, absOut);
      const bytes = data.byteLength;

      // 新しいファイルとしてmanifestに登録
      const newFileId = `replace_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const newItem: ItemRec = {
        id: newFileId,
        name: finalName,
        path: relPath,
        bytes,
        createdAt: new Date().toISOString()
      };

      await appendItem(newItem as any);
      inMemoryIndex.set(newFileId, newItem);

      return wrap({
        ok: true,
        originalFileId: fileId,
        newFileId,
        name: finalName,
        path: relPath,
        bytes,
        startBar: Number(startBar),
        endBar: Number(endBar),
        startTick,
        endTick,
        replacedEventCount: replacementJson.tracks?.reduce((sum: number, track: any) => sum + (track.events?.length || 0), 0) || 0,
        totalEventCount: modifiedJson.tracks.reduce((sum: number, track: any) => sum + (track.events?.length || 0), 0)
      }) as any;
    }

    // play_smf: parse SMF and schedule playback (or dryRun for analysis only)
    if (name === "play_smf") {
      const fileId: string | undefined = args?.fileId;
  const startMs: number | undefined = Number.isFinite(Number(args?.startMs)) ? Number(args?.startMs) : undefined;
  const stopMs: number | undefined = Number.isFinite(Number(args?.stopMs)) ? Number(args?.stopMs) : undefined;
  // 新規: 小節範囲指定（ms指定が存在する場合は優先される）
  const startBar: number | undefined = Number.isFinite(Number(args?.startBar)) ? Math.max(1, Math.floor(Number(args?.startBar))) : undefined;
  const endBar: number | undefined = Number.isFinite(Number(args?.endBar)) ? Math.max(1, Math.floor(Number(args?.endBar))) : undefined;
  const dryRun: boolean = !!args?.dryRun;
  const schedulerLookaheadMs: number | undefined = Number.isFinite(Number(args?.schedulerLookaheadMs)) ? Math.max(10, Math.min(1000, Number(args?.schedulerLookaheadMs))) : undefined;
  const schedulerTickMs: number | undefined = Number.isFinite(Number(args?.schedulerTickMs)) ? Math.max(5, Math.min(200, Number(args?.schedulerTickMs))) : undefined;
      if (!fileId) throw new Error("'fileId' is required for play_smf");

  // 小節範囲抽出モード識別用（precise/simple）
  let extractionMode: 'simple' | 'precise' = 'simple';
  // debug: 精密抽出時の中間JSONを返すための変数（環境変数 MCP_MIDI_PLAY_SMF_DEBUG_JSON がtruthyな場合のみ応答に含める）
  let debugExtracted: any | undefined;

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
        // --- 精密小節抽出モード: ms指定なし かつ bar指定あり かつ env が simple でない場合 ---
        const hasTempoChange = Array.isArray((midi as any).header?.tempos) && (midi as any).header.tempos.length > 1;
        const hasTimeSigChange = Array.isArray((midi as any).header?.timeSignatures) && (midi as any).header.timeSignatures.length > 1;
        // 条件拡張: startBar > 1 の抽出でも精密モードを使用 (R11 tempo crossing RED テストを GREEN 化する初期段階)
        // 将来: 実際に途中テンポ/拍子変化が無いケースでは simple に戻す最適化を再検討可
        const wantPreciseBar = (startBar !== undefined || endBar !== undefined)
          && startMs === undefined && stopMs === undefined
          && (process.env.MCP_MIDI_PLAY_SMF_BAR_MODE !== 'simple')
          && (hasTempoChange || hasTimeSigChange || (startBar !== undefined && startBar > 1));
  // 上位に宣言済み extractionMode を使用
        if (wantPreciseBar) {
          try {
            // (1) 既存の smf_to_json ロジックを再利用するため一旦 json 化
            const baseJson = await (async ()=>{
              const mod = await import('./smfToJson.js');
              const fn: any = (mod as any).decodeSmfToJson || (mod as any).default?.decodeSmfToJson || (mod as any).default || (mod as any).smfToJson;
              if (typeof fn !== 'function') throw new Error('decodeSmfToJson function not found');
              const arrBuf = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
              return fn(arrBuf);
            })();
            const sBar = startBar ?? 1;
            const eBar = endBar ?? sBar;
            // (2) 既存 extract_bars 相当ロジック簡易コピー（将来共通化）
            const ppq = baseJson.ppq || 480;
            // ヘルパ: bar→tick (拍子変化対応: 最後に現れた定義を使用)
            const timeSigs = baseJson.tracks.flatMap((t:any)=> (t.events||[]).filter((e:any)=> e.type==='meta.timeSignature')).sort((a:any,b:any)=> a.tick-b.tick);
            const tempoEvts = baseJson.tracks.flatMap((t:any)=> (t.events||[]).filter((e:any)=> e.type==='meta.tempo')).sort((a:any,b:any)=> a.tick-b.tick);
            const getEffectiveTS = (tick:number)=>{
              let cur = { numerator:4, denominator:4 };
              for (const ts of timeSigs){ if (ts.tick<=tick) cur={ numerator:ts.numerator, denominator:ts.denominator }; else break; }
              return cur;
            };
            // 近似: barToTick を逐次生成
            const barToTickCache = new Map<number, number>();
            function barToTick(bar:number): number {
              if (barToTickCache.has(bar)) return barToTickCache.get(bar)!;
              if (bar===1){ barToTickCache.set(1,0); return 0; }
              // 前のバー末尾tick + 1バー長
              const prevTick = barToTick(bar-1);
              const ts = getEffectiveTS(prevTick);
              const ticksPerBar = ppq * ts.numerator * (4/ts.denominator);
              const val = prevTick + ticksPerBar;
              barToTickCache.set(bar, val);
              return val;
            }
            const startTick = barToTick(sBar);
            const endTickExclusive = barToTick(eBar+1);
            // (3) 範囲抽出 & 正規化
            const newTracks:any[] = [];
            for (const tr of baseJson.tracks){
              const evs = [] as any[];
              const activeNotes = new Map<string, any>();
              for (const ev of (tr.events||[])){
                const tk = ev.tick ?? 0;
                if (tk < startTick || tk >= endTickExclusive) {
                  // ノート跨ぎ: start < startTick < end
                  if (ev.type==='note' && ev.tick < startTick && (ev.tick + ev.duration) > startTick){
                    // 跨ぎノートを 0tick から開始し残余のみ
                    const remain = (ev.tick + ev.duration) - startTick;
                    evs.push({ ...ev, tick:0, duration: remain });
                  }
                  continue;
                }
                // 範囲内
                if (typeof tk === 'number') {
                  const shifted = { ...ev, tick: tk - startTick };
                  if (shifted.type==='note') shifted.duration = Math.max(1, Math.min(shifted.duration, endTickExclusive - tk));
                  evs.push(shifted);
                }
              }
              if (evs.length) newTracks.push({ ...tr, events: evs });
            }
            // track0 メタ再シード: 最新 tempo/timeSig/keySig を 0tick に配置
            const seedMeta:any[] = [];
            const latest = (list:any[], pred:(e:any)=>boolean)=>{
              let sel; for(const e of list){ if (e.tick<=startTick && pred(e)) sel=e; else if (e.tick>startTick) break; } return sel;
            };
            const latestTS = latest(timeSigs, ()=>true); if (latestTS) seedMeta.push({ type:'meta.timeSignature', tick:0, numerator:latestTS.numerator, denominator:latestTS.denominator });
            const keySigs = baseJson.tracks.flatMap((t:any)=> (t.events||[]).filter((e:any)=> e.type==='meta.keySignature')).sort((a:any,b:any)=> a.tick-b.tick);
            const latestKS = latest(keySigs, ()=>true); if (latestKS) seedMeta.push({ type:'meta.keySignature', tick:0, sf:latestKS.sf, mi:latestKS.mi });
            const latestTempo = latest(tempoEvts, ()=>true); if (latestTempo) seedMeta.push({ type:'meta.tempo', tick:0, usPerQuarter: latestTempo.usPerQuarter });
            // 既存 track0 を先頭に（なければ生成）
            const track0 = { events: seedMeta };
            const extracted = { ppq, tracks: [track0, ...newTracks] };
            // --- 追加: CC / PitchBend 状態シード (段階: 任意CC + 将来pitchBend) ---
            try {
              const ccEventsAll = baseJson.tracks.flatMap((t:any)=> (t.events||[]).filter((e:any)=> e.type==='cc' && typeof e.controller==='number'));
              // controller × channel の最新を抽出 (tick <= startTick)
              const latestPerKey = new Map<string, any>();
              for (const ev of ccEventsAll.sort((a:any,b:any)=> (a.tick|0)-(b.tick|0))) {
                if ((ev.tick|0) <= startTick) {
                  const ch = Number.isFinite(Number(ev.channel)) ? (ev.channel|0) : 0;
                  const key = `${ch}:${ev.controller}`;
                  latestPerKey.set(key, ev);
                } else {
                  break;
                }
              }
              for (const [key, ev] of latestPerKey.entries()) {
                if (typeof ev.value === 'number') {
                  track0.events.push({ type:'cc', tick:0, controller: ev.controller, value: ev.value, channel: ev.channel });
                }
              }
              // pitchBend シード: チャンネル毎に startTick 以前の最新値を 0tick に再注入
              try {
                const pbEventsAll = baseJson.tracks.flatMap((t:any)=> (t.events||[]).filter((e:any)=> e.type==='pitchBend'));
                if (process.env.MCP_MIDI_PLAY_SMF_DEBUG_JSON) {
                  // デバッグ: startTick 以前/以後の pitchBend 一覧
                  const dbgBefore = pbEventsAll.filter((e:any)=> (e.tick|0) <= startTick).map((e:any)=>({tick:e.tick,value:e.value,channel:e.channel}));
                  const dbgAfter = pbEventsAll.filter((e:any)=> (e.tick|0) > startTick).map((e:any)=>({tick:e.tick,value:e.value,channel:e.channel}));
                  (track0 as any).events.push({ type:'meta.marker', tick:0, text:`DBG_PB<= ${JSON.stringify(dbgBefore).slice(0,200)}` });
                  (track0 as any).events.push({ type:'meta.marker', tick:0, text:`DBG_PB> ${JSON.stringify(dbgAfter).slice(0,200)}` });
                }
                const latestPBPerCh = new Map<number, any>();
                for (const ev of pbEventsAll.sort((a:any,b:any)=> (a.tick|0)-(b.tick|0))) {
                  if ((ev.tick|0) <= startTick) {
                    const ch = Number.isFinite(Number(ev.channel)) ? (ev.channel|0) : 0;
                    latestPBPerCh.set(ch, ev);
                  } else {
                    break;
                  }
                }
                for (const [ch, ev] of latestPBPerCh.entries()) {
                  if (typeof ev.value === 'number') {
                    track0.events.push({ type:'pitchBend', tick:0, value: ev.value, channel: ch });
                  }
                }
              } catch {/* ignore pitchBend seed errors */}
            } catch {/* 非致命 */}
            // (4) JSON→SMF バッファ化（メモリのみ）
            const mod2 = await import('./jsonToSmf.js');
            const encFn: any = (mod2 as any).encodeToSmfBinary || (mod2 as any).default?.encodeToSmfBinary || (mod2 as any).default;
            if (typeof encFn !== 'function') throw new Error('encodeToSmfBinary function not found');
            const smfBin = encFn(extracted as any);
            // 再度 Midi に読み込み直し
            const midi2 = new Midi(Buffer.from(smfBin));
            // midi2.tracks の channel 値も 1-16 の可能性があるため後段処理で統一的に (play_smf 本体側で) 正規化する
            // 元 midi を置き換え (後続処理は同じ)
            (midi as any)._tracks = midi2.tracks; // 内部差し替え（簡易）
            extractionMode = 'precise';
            // 精密抽出成功: simplified フラグと区別し 'bar-range applied' 文字列を含めない
            warnings.push(`bar-range precise extraction (startBar=${sBar}, endBar=${eBar})`);
            if (process.env.MCP_MIDI_PLAY_SMF_DEBUG_JSON) {
              debugExtracted = extracted; // 応答へ含める
            }
            // 以降は通常ノート展開へ
          } catch (ex:any) {
            warnings.push(`bar-range precise extraction failed fallback simple: ${ex?.message||ex}`);
          }
        }
        // notes をmsに展開（tempo変化は@tonejs/midiがtime/secondsに反映済み）
        for (const tr of midi.tracks) {
          // @tonejs/midi の track.channel が 1-16 で返る環境があり得るため正規化 (外部1-16 -> 内部0-15)
          let chRaw = Number.isFinite(Number(tr?.channel)) ? Number(tr.channel) : 0;
          let ch: number;
          if (chRaw >= 1 && chRaw <= 16) ch = (chRaw - 1) | 0; else ch = (chRaw | 0) & 0x0f;
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
        // 範囲クリップ: 1) ms指定 2) 小節指定 (simple モードのみ)
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
  } else if ((startBar !== undefined || endBar !== undefined) && extractionMode==='simple') {
          // simple モード（互換フォールバック）
          let bpm = 120;
          if (midi.header?.tempos?.length) bpm = midi.header.tempos[0].bpm || bpm;
          let numerator = 4, denominator = 4;
          if (midi.header?.timeSignatures?.length) {
            const ts = midi.header.timeSignatures[0].timeSignature || [4,4];
            numerator = ts[0] || 4; denominator = ts[1] || 4;
          }
          const quarterMs = 60000 / bpm;
          const barMs = quarterMs * numerator * (4 / denominator);
          const sBar = startBar ?? 1;
          const eBar = endBar ?? Number.MAX_SAFE_INTEGER;
          const sMs = (sBar - 1) * barMs;
          const eMs = eBar * barMs;
          events = events.filter(ev => ev.tMs >= sMs && ev.tMs <= eMs);
          const lastBoundary = Number.isFinite(eMs) ? eMs : (events.length ? events[events.length-1]!.tMs : sMs);
          const onMap = new Map<string, Ev>();
            const synthOff: Ev[] = [];
            for (const ev of events) {
              const key = `${ev.ch}:${ev.n}`;
              if (ev.kind === 'on') onMap.set(key, ev); else onMap.delete(key);
            }
            for (const [key, onEv] of onMap) {
              synthOff.push({ tMs: Math.max(onEv.tMs + 5, lastBoundary), kind: 'off', ch: onEv.ch, n: onEv.n, v: 0 });
            }
            if (synthOff.length) { events.push(...synthOff); events.sort((a,b)=> a.tMs - b.tMs || (a.kind==='off'? -1: 1)); }
          warnings.push(`bar-range applied (startBar=${startBar ?? ''}, endBar=${endBar ?? ''}) tempo/timeSig simplified`);
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
  // extractionMode を返却（precise 成功時は simplified warning を含まない想定）
  return wrap({ ok: true, playbackId, scheduledEvents, totalDurationMs, extractionMode, ...(debugExtracted ? { debug: { extracted: debugExtracted } } : {}), warnings: warnings.length ? warnings : undefined }) as any;
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

  // ready シグナル（JSON 1 行）: テストヘルパはこれを待機してからリクエスト送信
  const tReady = performance.now();
  const totalMs = +(tReady - t0).toFixed(1);
  // manifest キャッシュ状態の可視化: 環境変数で無効化されているか
  const manifestCacheEnabled = process.env.MCP_MIDI_MANIFEST_NOCACHE === '1' ? false : true;
  // 大量マニフェスト閾値（デフォルト5000, 環境変数で上書き可能）
  const manifestThreshold = Number.isFinite(Number(process.env.MCP_MIDI_MANIFEST_THRESHOLD)) ? Number(process.env.MCP_MIDI_MANIFEST_THRESHOLD) : 5000;
  const manifestItems = Number(warmup?.manifest?.items || 0);
  const manifestItemsThresholdExceeded = manifestItems >= manifestThreshold;
  if (manifestItemsThresholdExceeded) {
    try { process.stderr.write(`[WARN] manifest item count high: ${manifestItems} >= ${manifestThreshold}\n`); } catch { /* ignore */ }
  }
  const readyPayload = { ready: true, coldStartMs: totalMs, warmup, manifestCache: manifestCacheEnabled ? 'enabled' : 'disabled', manifestItemsThresholdExceeded, manifestThreshold };
  // 既存テスト互換性のため ready 行はデフォルト非出力。必要なテスト/クライアントのみ MCP_MIDI_EMIT_READY=1 を指定。
  if (process.env.MCP_MIDI_EMIT_READY === '1') {
    try { process.stdout.write(JSON.stringify(readyPayload) + "\n"); } catch { /* ignore */ }
  }

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
