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

describe("append_to_smf multi-track preservation", () => {
  it("preserveTrackStructure=true で複数トラックを個別に追記", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    // ベースSMF: 2トラック構成
    const base = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] },
        {
          name: "Piano",
          channel: 0,
          events: [
            { type: "program", tick: 0, program: 0 },
            { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 480 }, // C4
          ],
        },
      ],
    };

    // json_to_smf でベース作成
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: base, format: "json_midi_v1", name: "multitrack_base.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // 追記用JSON: 2トラック構成（Drums + Strings）
    const multiTrackChunk = {
      format: 1,
      ppq: 480,
      tracks: [
        {
          name: "Drums",
          channel: 9, // Drumチャンネル
          events: [
            { type: "program", tick: 0, program: 0 }, // Drum kit (0-127範囲内)
            { type: "note", tick: 0, pitch: 36, velocity: 120, duration: 120 }, // Kick
          ],
        },
        {
          name: "Strings",
          channel: 1,
          events: [
            { type: "program", tick: 0, program: 48 }, // Strings
            { type: "note", tick: 0, pitch: 67, velocity: 80, duration: 960 }, // G4
          ],
        },
      ],
    };

    // preserveTrackStructure=true で追記
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "append_to_smf", 
        arguments: { 
          fileId, 
          json: multiTrackChunk, 
          format: "json_midi_v1", 
          atEnd: true, 
          gapTicks: 240,
          preserveTrackStructure: true 
        } 
      } 
    });

    const res2 = await readLine(child);
    if (res2.error) { 
      child.kill(); 
      console.error("Error in append_to_smf:", JSON.stringify(res2.error, null, 2));
      throw new Error(String(res2.error?.message || res2.error)); 
    }

    const body2 = res2.result?.content?.[0]?.text ? JSON.parse(res2.result.content[0].text) : res2.result;
    console.log("append_to_smf result:", JSON.stringify(body2, null, 2));
    expect(body2.ok).toBe(true);

    // 結果を確認: smf_to_json
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res3 = await readLine(child);
    if (res3.error) { 
      child.kill(); 
      throw new Error(String(res3.error?.message || res3.error)); 
    }

    const body3 = res3.result?.content?.[0]?.text ? JSON.parse(res3.result.content[0].text) : res3.result;
    const tracks = body3.json.tracks as any[];

    // トラック数が増加していることを確認（元2 + 追記2 = 4トラック以上）
    expect(tracks.length).toBeGreaterThanOrEqual(4);

    // 各トラックで期待されるイベントを確認
    let drumsFound = false;
    let stringsFound = false;
    let insertTick = 480 + 240; // ベース末尾(480) + gapTicks(240)

    for (const tr of tracks) {
      for (const ev of tr.events || []) {
        // Drums kick (pitch=36, channel=9)
        if (ev.type === "note" && ev.pitch === 36 && Math.abs(ev.tick - insertTick) <= 1) {
          drumsFound = true;
        }
        // Strings G4 (pitch=67, channel=1)
        if (ev.type === "note" && ev.pitch === 67 && Math.abs(ev.tick - insertTick) <= 1) {
          stringsFound = true;
        }
      }
    }

    expect(drumsFound).toBe(true);
    expect(stringsFound).toBe(true);

    child.kill();
  }, 20000);

  it("trackMapping指定で特定トラックにマッピング", async () => {
    const child = spawnServer();

    // initialize
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    // ベースSMF: 3トラック構成
    const base = {
      format: 1,
      ppq: 480,
      tracks: [
        { events: [ { type: "meta.tempo", tick: 0, usPerQuarter: 500000 } ] }, // Track 0: Meta
        { channel: 0, events: [ { type: "note", tick: 0, pitch: 60, velocity: 100, duration: 480 } ] }, // Track 1: Piano
        { channel: 1, events: [ { type: "note", tick: 0, pitch: 64, velocity: 100, duration: 480 } ] }, // Track 2: Bass
      ],
    };

    // json_to_smf でベース作成
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: base, format: "json_midi_v1", name: "mapping_base.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // 追記用JSON: 2トラック
    const mappingChunk = {
      format: 1,
      ppq: 480,
      tracks: [
        { channel: 2, events: [ { type: "note", tick: 0, pitch: 67, velocity: 100, duration: 240 } ] }, // 追記Track0 -> 既存Track1にマップ
        { channel: 3, events: [ { type: "note", tick: 0, pitch: 71, velocity: 100, duration: 240 } ] }, // 追記Track1 -> 既存Track2にマップ
      ],
    };

    // trackMapping=[1,2] で Track1,Track2 にそれぞれ追記
    sendLine(child, { 
      jsonrpc: "2.0", 
      id: 3, 
      method: "tools/call", 
      params: { 
        name: "append_to_smf", 
        arguments: { 
          fileId, 
          json: mappingChunk, 
          format: "json_midi_v1", 
          atEnd: true,
          preserveTrackStructure: true,
          trackMapping: [1, 2] // 追記Track0->Track1, 追記Track1->Track2
        } 
      } 
    });

    const res2 = await readLine(child);
    if (res2.error) { 
      child.kill(); 
      throw new Error(String(res2.error?.message || res2.error)); 
    }

    const body2 = res2.result?.content?.[0]?.text ? JSON.parse(res2.result.content[0].text) : res2.result;
    expect(body2.ok).toBe(true);

    // 結果確認
    sendLine(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res3 = await readLine(child);
    const body3 = res3.result?.content?.[0]?.text ? JSON.parse(res3.result.content[0].text) : res3.result;
    const tracks = body3.json.tracks as any[];

    // Track1に pitch=67 が、Track2に pitch=71 が追加されていることを確認
    let track1HasG4 = false;
    let track2HasB4 = false;

    if (tracks[1]) {
      track1HasG4 = (tracks[1].events || []).some((ev: any) => ev.type === "note" && ev.pitch === 67);
    }
    if (tracks[2]) {
      track2HasB4 = (tracks[2].events || []).some((ev: any) => ev.type === "note" && ev.pitch === 71);
    }

    expect(track1HasG4).toBe(true);
    expect(track2HasB4).toBe(true);

    child.kill();
  }, 20000);
});