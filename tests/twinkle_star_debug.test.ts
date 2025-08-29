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

describe("Twinkle Twinkle Star Debug", () => {
  it("実際のtwinkle_twinkle_melody.midファイルの解析", async () => {
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

    // list_midi でtwinkleファイルを探す
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "list_midi", 
        arguments: { limit: 50 } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    
    console.log("Available MIDI files:", body1.items.map((item: any) => ({
      name: item.name,
      fileId: item.id,
      bytes: item.bytes
    })));

    // twinkleファイルを特定
    const twinkleItem = body1.items.find((item: any) => 
      item.name.includes("twinkle")
    );
    
    if (!twinkleItem) {
      console.log("twinkle_twinkle_melody.mid not found in list");
      child.kill();
      return;
    }

    const fileId = twinkleItem.id;
    console.log("Found twinkle file:", { fileId, name: twinkleItem.name, bytes: twinkleItem.bytes });

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
    
    console.log("SMF structure:", {
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
          events: (track.events || []).slice(0, 10).map((ev: any) => ({
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
          schedulerLookaheadMs: 200,
          schedulerTickMs: 20 
        } 
      } 
    });

    const res3 = await readLine(child);
    expect(res3.error).toBeUndefined();
    expect(res3.result.ok).toBe(true);
    
    console.log("DryRun playback analysis:", {
      scheduledEvents: res3.result.scheduledEvents,
      totalDurationMs: res3.result.totalDurationMs,
      playbackId: res3.result.playbackId
    });

    // 実際の再生テスト（短時間）
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 5, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId,
          portName: "DX-7", // 仮の出力先
          startMs: 0,
          stopMs: 3000, // 最初の3秒だけ
          schedulerLookaheadMs: 200,
          schedulerTickMs: 20
        } 
      } 
    });

    const res4 = await readLine(child);
    console.log("Real playback result:", {
      ok: res4.result?.ok,
      error: res4.error,
      playbackId: res4.result?.playbackId
    });

    // 少し待ってから状態確認
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (res4.result?.playbackId) {
      sendLine(child, { 
        jsonrpc: "2.0", 
        id: 6, 
        method: "tools/call", 
        params: { 
          name: "get_playback_status", 
          arguments: { 
            playbackId: res4.result.playbackId 
          } 
        } 
      });

      const res5 = await readLine(child);
      console.log("Playback status:", {
        ok: res5.result?.ok,
        cursorMs: res5.result?.cursorMs,
        lastSentAt: res5.result?.lastSentAt,
        done: res5.result?.done
      });
    }

    child.kill();
  }, 30000);

  it("きらきら星メロディの手作り版で比較テスト", async () => {
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

    // きらきら星のメロディを手作り
    const twinkleJson = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // 120 BPM
        {
          name: "Twinkle Manual",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 }, // Piano
            // キラキラ光る（ドドソソララソ）
            { type: "note", tick: 0,    pitch: 60, velocity: 100, duration: 480 }, // C4
            { type: "note", tick: 480,  pitch: 60, velocity: 100, duration: 480 }, // C4
            { type: "note", tick: 960,  pitch: 67, velocity: 100, duration: 480 }, // G4
            { type: "note", tick: 1440, pitch: 67, velocity: 100, duration: 480 }, // G4
            { type: "note", tick: 1920, pitch: 69, velocity: 100, duration: 480 }, // A4
            { type: "note", tick: 2400, pitch: 69, velocity: 100, duration: 480 }, // A4
            { type: "note", tick: 2880, pitch: 67, velocity: 100, duration: 960 }, // G4 (長め)
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
          json: twinkleJson, 
          format: "json_midi_v1", 
          name: "twinkle_manual_test.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    const fileId = body1.fileId as string;

    console.log("Manual twinkle SMF:", { 
      fileId, 
      bytes: body1.bytes, 
      eventCount: body1.eventCount 
    });

    // dryRun 解析
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
    
    console.log("Manual twinkle analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs
    });

    // 7音のメロディ = 14イベント (NoteOn×7 + NoteOff×7)
    expect(res2.result.scheduledEvents).toBe(14);

    child.kill();
  }, 20000);
});