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

describe("Polyphony Playback Test", () => {
  it("複数音の同時再生: trigger_notesで和音が正しく送出される", async () => {
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

    // C major triad (C4-E4-G4) を同時送出
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "trigger_notes", 
        arguments: { 
          notes: ["C4", "E4", "G4"], 
          velocity: 100, 
          durationMs: 1000,
          channel: 1,
          dryRun: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    
    expect(body1.ok).toBe(true);
    expect(body1.scheduledNotes).toBe(3); // 3音同時
    expect(body1.durationMs).toBe(1000);
    console.log("Chord trigger_notes result:", body1);

    child.kill();
  }, 15000);

  it("SMF和音再生: JSON MIDIで同時和音を作成して再生確認", async () => {
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

    // 同時和音のJSON MIDI作成
    const chordJson = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // 120 BPM
        {
          name: "Piano Chord",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 }, // Piano
            // 同時和音: 全て tick=0 で開始
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 1920 }, // C4
            { type: "note", tick: 0, pitch: 64, velocity: 100, duration: 1920 }, // E4  
            { type: "note", tick: 0, pitch: 67, velocity: 100, duration: 1920 }, // G4
            // 次の和音: tick=1920 で開始
            { type: "note", tick: 1920, pitch: 65, velocity: 100, duration: 1920 }, // F4
            { type: "note", tick: 1920, pitch: 69, velocity: 100, duration: 1920 }, // A4
            { type: "note", tick: 1920, pitch: 72, velocity: 100, duration: 1920 }, // C5
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
          json: chordJson, 
          format: "json_midi_v1", 
          name: "chord_test.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    const fileId = body1.fileId as string;

    console.log("SMF creation result:", { fileId, bytes: body1.bytes, eventCount: body1.eventCount });

    // play_smf でdryRun解析
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true 
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    // 同時和音の解析結果を確認
    expect(res2.result.scheduledEvents).toBeGreaterThanOrEqual(12); // 6音×NoteOn/Off = 12以上
    expect(res2.result.totalDurationMs).toBeGreaterThanOrEqual(3000); // 2小節分の時間
    
    console.log("SMF playback analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs,
      playbackId: res2.result.playbackId
    });

    child.kill();
  }, 20000);

  it("Score DSL和音再生: DSL記法で和音を作成して解析", async () => {
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

    // Score DSL で和音作成
    const chordDsl = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 }
      },
      tracks: [
        {
          channel: 1, // 外部表記
          program: 0,
          events: [
            // 1小節目の和音 (全て同時開始)
            { type: "note", note: "C4", start: { bar: 1, beat: 1 }, duration: { value: "1/2" } },
            { type: "note", note: "E4", start: { bar: 1, beat: 1 }, duration: { value: "1/2" } },
            { type: "note", note: "G4", start: { bar: 1, beat: 1 }, duration: { value: "1/2" } },
            // 1小節目3拍の和音
            { type: "note", note: "F4", start: { bar: 1, beat: 3 }, duration: { value: "1/2" } },
            { type: "note", note: "A4", start: { bar: 1, beat: 3 }, duration: { value: "1/2" } },
            { type: "note", note: "C5", start: { bar: 1, beat: 3 }, duration: { value: "1/2" } },
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
          json: chordDsl, 
          format: "score_dsl_v1", 
          name: "chord_dsl.mid", 
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
          dryRun: true 
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    // 和音イベント数確認
    expect(res2.result.scheduledEvents).toBeGreaterThanOrEqual(12); // 6音×2 = 12イベント以上
    
    console.log("DSL chord analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs
    });

    child.kill();
  }, 20000);

  it("polyphony stress test: 10音同時再生", async () => {
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

    // 10音同時再生（C4からB5まで）
    const notes10 = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5"];
    
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "trigger_notes", 
        arguments: { 
          notes: notes10, 
          velocity: 80, 
          durationMs: 2000,
          dryRun: true 
        } 
      } 
    });

    const res = await readLine(child);
    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    
    expect(body.ok).toBe(true);
    expect(body.scheduledNotes).toBe(10); // 10音同時確認
    
    console.log("10-note polyphony test:", body);

    child.kill();
  }, 15000);
});