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

describe("Real Twinkle File Debug", () => {
  it("実際のtwinkle_twinkle_melody.midファイル（base64から登録）", async () => {
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

    // 実際のファイル内容をbase64で登録
    const twinkleBase64 = "TVRoZAAAAAYAAAABAGBNVHJrAAAAIACQPEBggDxAAJA8QGCAPEAAkENAYIBDQACQQ0BggENAAP8vAA==";
    
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "store_midi", 
        arguments: { 
          base64: twinkleBase64,
          name: "twinkle_debug.mid"
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const fileId = res1.result.fileId as string;
    
    console.log("Stored twinkle file:", { 
      fileId, 
      bytes: res1.result.bytes || "unknown" 
    });

    // smf_to_json で内容解析
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "smf_to_json", 
        arguments: { fileId } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    const body2 = JSON.parse(res2.result.content[0].text);
    expect(body2.ok).toBe(true);
    
    console.log("Real twinkle SMF structure:", {
      format: body2.json.format,
      ppq: body2.json.ppq,
      trackCount: body2.json.tracks?.length,
      eventCount: body2.eventCount
    });

    // 各トラックの詳細
    if (body2.json.tracks) {
      body2.json.tracks.forEach((track: any, index: number) => {
        console.log(`Track ${index}:`, {
          channel: track.channel,
          eventCount: track.events?.length || 0,
          events: (track.events || []).map((ev: any) => ({
            type: ev.type,
            tick: ev.tick,
            pitch: ev.pitch,
            note: ev.note,
            velocity: ev.velocity,
            duration: ev.duration
          }))
        });
      });
    }

    // dryRun 解析
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 4, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true,
          schedulerLookaheadMs: 500, // 長めのlookahead
          schedulerTickMs: 10
        } 
      } 
    });

    const res3 = await readLine(child);
    expect(res3.error).toBeUndefined();
    expect(res3.result.ok).toBe(true);
    
    console.log("Real twinkle dryRun analysis:", {
      scheduledEvents: res3.result.scheduledEvents,
      totalDurationMs: res3.result.totalDurationMs,
      playbackId: res3.result.playbackId
    });

    // 実際に複数の音が含まれているかを確認
    if (res3.result.scheduledEvents <= 2) {
      console.log("⚠️ WARNING: Only", res3.result.scheduledEvents, "events scheduled - this suggests the MIDI may only have 1 note!");
    } else {
      console.log("✅ Good:", res3.result.scheduledEvents, "events scheduled - multiple notes detected");
    }

    child.kill();
  }, 20000);

  it("比較：手作りの正常なtwinkleメロディ", async () => {
    const child = spawnServer();

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

    // きらきら星の正しいメロディ（ドドソソララソ・ファファミミレレド）
    const properTwinkleJson = {
      format: 1,
      ppq: 96, // シンプルなPPQ
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // 120 BPM
        {
          name: "Proper Twinkle",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 },
            // "Twinkle, twinkle, little star" (C C G G A A G)
            { type: "note", tick: 0,   pitch: 60, velocity: 100, duration: 96 },  // C4
            { type: "note", tick: 96,  pitch: 60, velocity: 100, duration: 96 },  // C4  
            { type: "note", tick: 192, pitch: 67, velocity: 100, duration: 96 },  // G4
            { type: "note", tick: 288, pitch: 67, velocity: 100, duration: 96 },  // G4
            { type: "note", tick: 384, pitch: 69, velocity: 100, duration: 96 },  // A4
            { type: "note", tick: 480, pitch: 69, velocity: 100, duration: 96 },  // A4
            { type: "note", tick: 576, pitch: 67, velocity: 100, duration: 192 }, // G4 (longer)
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
          json: properTwinkleJson, 
          format: "json_midi_v1", 
          name: "proper_twinkle.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    console.log("Proper twinkle creation:", { 
      fileId, 
      bytes: body1.bytes, 
      eventCount: body1.eventCount 
    });

    // dryRun解析  
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
    const body2 = JSON.parse(res2.result.content[0].text);
    
    console.log("Proper twinkle analysis:", {
      scheduledEvents: body2.scheduledEvents,
      totalDurationMs: body2.totalDurationMs
    });

    // 7音のメロディなので14イベント期待
    expect(body2.scheduledEvents).toBe(14);

    child.kill();
  }, 20000);
});