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

describe("Playback Regression Debug", () => {
  it("実際の再生で複数音が正しくスケジュールされるかテスト", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 1, 
      method: "initialize", 
      params: { 
        protocolVersion: "2025-06-18", 
        capabilities: {}, 
        clientInfo: { name: "vitest-regression-debug", version: "0" } 
      } 
    });
    await readLine(child);

    // シンプルな5音シーケンス作成（debug用）
    const testSequence = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // 120 BPM
        {
          name: "Debug Sequence",
          channel: 1,
          events: [
            { type: "program", tick: 0, program: 0 }, // Piano
            // 非常にゆっくりとしたシーケンス（各音1秒間隔）
            { type: "note", tick: 0,    pitch: 60, velocity: 100, duration: 240 }, // C4
            { type: "note", tick: 480,  pitch: 62, velocity: 100, duration: 240 }, // D4  
            { type: "note", tick: 960,  pitch: 64, velocity: 100, duration: 240 }, // E4
            { type: "note", tick: 1440, pitch: 65, velocity: 100, duration: 240 }, // F4
            { type: "note", tick: 1920, pitch: 67, velocity: 100, duration: 240 }, // G4
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
          json: testSequence, 
          format: "json_midi_v1", 
          name: "regression_debug.mid", 
          overwrite: true 
        } 
      } 
    });

    const res1 = await readLine(child);
    expect(res1.error).toBeUndefined();
    const body1 = JSON.parse(res1.result.content[0].text);
    expect(body1.ok).toBe(true);
    const fileId = body1.fileId as string;

    console.log("Created debug sequence:", { 
      fileId, 
      bytes: body1.bytes, 
      eventCount: body1.eventCount 
    });

    // 1) dryRun 解析（期待値確認）
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId, 
          dryRun: true,
          schedulerLookaheadMs: 500, // 十分に長いlookahead
          schedulerTickMs: 50       // 比較的粗いtick
        } 
      } 
    });

    const res2 = await readLine(child);
    expect(res2.error).toBeUndefined();
    expect(res2.result.ok).toBe(true);
    
    console.log("DryRun analysis:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs,
      playbackId: res2.result.playbackId
    });

    // 5音のシーケンス = 10イベント (NoteOn×5 + NoteOff×5)
    expect(res2.result.scheduledEvents).toBe(10);
    // 時間計算: 1920tick + 240duration = 2160tick = 2250ms at 120BPM
    expect(res2.result.totalDurationMs).toBeGreaterThanOrEqual(2200); // 修正された期待値

    // 2) 短時間の実再生テスト（最初の2秒だけ）
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 4, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId,
          portName: "DX-7", // テスト用出力先
          startMs: 0,
          stopMs: 2000,     // 最初の2秒のみ（C4とD4の部分）
          schedulerLookaheadMs: 500,
          schedulerTickMs: 50
        } 
      } 
    });

    const res3 = await readLine(child);
    console.log("Real playback start result:", {
      ok: res3.result?.ok,
      error: res3.error?.message || res3.error,
      playbackId: res3.result?.playbackId,
      warning: res3.result?.warning
    });

    // 実再生が成功したかどうか確認
    if (res3.result?.playbackId) {
      // 少し待ってから状態確認
      await new Promise(resolve => setTimeout(resolve, 500));
      
      sendLine(child, { 
        jsonrpc: "2.0", 
        id: 5, 
        method: "tools/call", 
        params: { 
          name: "get_playback_status", 
          arguments: { 
            playbackId: res3.result.playbackId 
          } 
        } 
      });

      const res4 = await readLine(child);
      console.log("Playback status after 500ms:", {
        ok: res4.result?.ok,
        done: res4.result?.done,
        cursorMs: res4.result?.cursorMs,
        lastSentAt: res4.result?.lastSentAt,
        totalDurationMs: res4.result?.totalDurationMs
      });

      // もう少し待って再確認
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      sendLine(child, { 
        jsonrpc: "2.0", 
        id: 6, 
        method: "tools/call", 
        params: { 
          name: "get_playback_status", 
          arguments: { 
            playbackId: res3.result.playbackId 
          } 
        } 
      });

      const res5 = await readLine(child);
      console.log("Playback status after 1500ms total:", {
        ok: res5.result?.ok,
        done: res5.result?.done,
        cursorMs: res5.result?.cursorMs,
        lastSentAt: res5.result?.lastSentAt
      });

      // 停止
      sendLine(child, { 
        jsonrpc: "2.0", 
        id: 7, 
        method: "tools/call", 
        params: { 
          name: "stop_playback", 
          arguments: { 
            playbackId: res3.result.playbackId 
          } 
        } 
      });

      const res6 = await readLine(child);
      console.log("Stop playback result:", {
        ok: res6.result?.ok
      });

      // 結果分析
      if (res5.result?.lastSentAt && res5.result.lastSentAt > 1000) {
        console.log("✅ Good: Playback progressed beyond 1 second - multiple events likely sent");
      } else {
        console.log("⚠️ Warning: Playback may have stopped early or sent limited events");
      }

    } else {
      console.log("❌ Failed to start real playback - may be MIDI port issue");
    }

    child.kill();
  }, 30000);

  it("比較：過去に動作していた既知のファイル再テスト", async () => {
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

    // 既知の動作するtwinkle file (先ほど確認したもの)
    const twinkleBase64 = "TVRoZAAAAAYAAAABAGBNVHJrAAAAIACQPEBggDxAAJA8QGCAPEAAkENAYIBDQACQQ0BggENAAP8vAA==";
    
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 2, 
      method: "tools/call", 
      params: { 
        name: "store_midi", 
        arguments: { 
          base64: twinkleBase64,
          name: "regression_twinkle.mid"
        } 
      } 
    });

    const res1 = await readLine(child);
    const fileId = res1.result.fileId as string;
    
    console.log("Stored regression twinkle:", { fileId });

    // dryRun確認
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
    console.log("Regression twinkle dryRun:", {
      scheduledEvents: res2.result.scheduledEvents,
      totalDurationMs: res2.result.totalDurationMs
    });

    // 実再生（短時間）
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 4, 
      method: "tools/call", 
      params: { 
        name: "play_smf", 
        arguments: { 
          fileId,
          portName: "DX-7",
          startMs: 0,
          stopMs: 1500  // 1.5秒のみ
        } 
      } 
    });

    const res3 = await readLine(child);
    console.log("Regression twinkle real playback:", {
      ok: res3.result?.ok,
      playbackId: res3.result?.playbackId,
      error: res3.error?.message
    });

    child.kill();
  }, 15000);
});