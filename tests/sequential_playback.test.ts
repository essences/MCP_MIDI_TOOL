import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";

function spawnServer() {
  const command = process.execPath; // node
  const args = ["./dist/index.js"]; // built server
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

describe("Sequential MIDI Playback Test", () => {
  it("時系列シーケンス: C4→D4→E4→F4の順次再生", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 1, 
      method: "initialize", 
      params: { 
        protocolVersion: "2025-06-18", 
        capabilities: {}, 
        clientInfo: { name: "vitest", version: "0" } 
      } 
    });
    await readLine(child);

    // 時系列でのシーケンシャルなメロディ作成
    const sequentialJson = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // 120 BPM
        {
          name: "Sequential Melody",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 }, // Piano
            // 4分音符刻みでC4→D4→E4→F4
            { type: "note", tick: 0,    pitch: 60, velocity: 100, duration: 480 }, // C4 (1拍目)
            { type: "note", tick: 480,  pitch: 62, velocity: 100, duration: 480 }, // D4 (2拍目)
            { type: "note", tick: 960,  pitch: 64, velocity: 100, duration: 480 }, // E4 (3拍目)
            { type: "note", tick: 1440, pitch: 65, velocity: 100, duration: 480 }, // F4 (4拍目)
          ],
        },
      ],
    };

    // json_to_smf で保存
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "json_to_smf", 
        arguments: { 
          json: sequentialJson, 
          format: "json_midi_v1", 
          name: "sequential_test.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    const fileId = body1.fileId as string;

    console.log("Sequential SMF creation:", { 
      fileId, 
      bytes: body1.bytes, 
      trackCount: body1.trackCount, 
      eventCount: body1.eventCount 
    });

    // play_smf でdryRun解析
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true,
          schedulerLookaheadMs: 100, // 長めのlookahead
          schedulerTickMs: 10        // 細かいtick
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    // 4音のシーケンス = 8イベント (NoteOn×4 + NoteOff×4)
    expect(res2.result.scheduledEvents).toBe(8);
    // 時間計算を修正: tick1440 + duration480 = 1920tick = 2000ms at 120BPM
    expect(res2.result.totalDurationMs).toBeGreaterThanOrEqual(1900); // 修正された期待値
    
    console.log("Sequential playback analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs,
      playbackId: res2.result.playbackId
    });

    child.kill();
  }, 20000);

  it("長時間シーケンス: 8音のスケール再生", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 1, 
      method: "initialize", 
      params: { 
        protocolVersion: "2025-06-18", 
        capabilities: {}, 
        clientInfo: { name: "vitest", version: "0" } 
      } 
    });
    await readLine(child);

    // Cメジャースケール（C4-C5）
    const scaleNotes = [60, 62, 64, 65, 67, 69, 71, 72]; // C D E F G A B C
    const events = scaleNotes.map((pitch, index) => ({
      type: "note" as const,
      tick: index * 240, // 8分音符間隔 (ppq=480なので240tick)
      pitch,
      velocity: 100 - (index * 5), // だんだん弱く
      duration: 200 // 少し短め
    }));

    const scaleJson = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 600000 } ] }, // 100 BPM (slower)
        {
          name: "Scale Sequence",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 }, // Piano
            ...events
          ],
        },
      ],
    };

    // json_to_smf で保存
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "json_to_smf", 
        arguments: { 
          json: scaleJson, 
          format: "json_midi_v1", 
          name: "scale_sequence.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    const fileId = body1.fileId as string;

    // play_smf でdryRun解析
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true,
          schedulerLookaheadMs: 200, // より長いlookahead
          schedulerTickMs: 20
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    // 8音のシーケンス = 16イベント (NoteOn×8 + NoteOff×8)
    expect(res2.result.scheduledEvents).toBe(16);
    // tick計算: (7*240) + 200duration = 1880tick = 約2350ms at 100BPM
    expect(res2.result.totalDurationMs).toBeGreaterThanOrEqual(2300); // 修正された期待値
    
    console.log("Scale sequence analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs
    });

    child.kill();
  }, 20000);

  it("Score DSLシーケンス: DSL記法での時系列メロディ", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 1, 
      method: "initialize", 
      params: { 
        protocolVersion: "2025-06-18", 
        capabilities: {}, 
        clientInfo: { name: "vitest", version: "0" } 
      } 
    });
    await readLine(child);

    // Score DSL での時系列メロディ
    const sequentialDsl = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 }
      },
      tracks: [
        {
          channel: 1,
          program: 0,
          events: [
            // 1小節目: 各拍に1音ずつ
            { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/4" } },
            { type: "note", note: "D4", start: { bar: 1, beat: 2 }, duration: { value: "1/4" } },
            { type: "note", note: "E4", start: { bar: 1, beat: 3 }, duration: { value: "1/4" } },
            { type: "note", note: "F4", start: { bar: 1, beat: 4 }, duration: { value: "1/4" } },
            // 2小節目: 8分音符で (unit/offset記法を修正)
            { type: "note", note: "G4", start: { bar: 2, beat: 1 }, duration: { value: "1/8" } },
            { type: "note", note: "A4", start: { bar: 2, beat: 2 }, duration: { value: "1/8" } },
            { type: "note", note: "B4", start: { bar: 2, beat: 3 }, duration: { value: "1/8" } },
            { type: "note", note: "C5", start: { bar: 2, beat: 4 }, duration: { value: "1/4" } },
          ]
        }
      ]
    };

    // json_to_smf でコンパイル
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "json_to_smf", 
        arguments: { 
          json: sequentialDsl, 
          format: "score_dsl_v1", 
          name: "dsl_sequence.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    const fileId = body1.fileId as string;

    // 解析確認
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true,
          schedulerLookaheadMs: 150,
          schedulerTickMs: 15
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    // 8音のシーケンス = 16イベント
    expect(res2.result.scheduledEvents).toBe(16);
    // 2小節分の時間 = 8拍分 = 4000ms at 120BPM
    expect(res2.result.totalDurationMs).toBeGreaterThanOrEqual(3800); // 2小節分
    
    console.log("DSL sequence analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs
    });

    child.kill();
  }, 20000);

  it("スケジューラー範囲テスト: 短いlookaheadでの動作", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 1, 
      method: "initialize", 
      params: { 
        protocolVersion: "2025-06-18", 
        capabilities: {}, 
        clientInfo: { name: "vitest", version: "0" } 
      } 
    });
    await readLine(child);

    // 短時間間隔のテストパターン
    const rapidJson = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // 120 BPM
        {
          name: "Rapid Sequence",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 },
            // 16分音符間隔 (120tick)
            { type: "note", tick: 0,   pitch: 60, velocity: 100, duration: 100 },
            { type: "note", tick: 120, pitch: 62, velocity: 100, duration: 100 },
            { type: "note", tick: 240, pitch: 64, velocity: 100, duration: 100 },
            { type: "note", tick: 360, pitch: 65, velocity: 100, duration: 100 },
            { type: "note", tick: 480, pitch: 67, velocity: 100, duration: 100 },
          ],
        },
      ],
    };

    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "json_to_smf", 
        arguments: { 
          json: rapidJson, 
          format: "json_midi_v1", 
          name: "rapid_sequence.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // 短いlookaheadでテスト
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true,
          schedulerLookaheadMs: 25,  // 短い lookahead
          schedulerTickMs: 5         // 細かいtick
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    // 5音のシーケンス = 10イベント
    expect(res2.result.scheduledEvents).toBe(10);
    
    console.log("Rapid sequence with short lookahead:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs
    });

    child.kill();
  }, 20000);
});