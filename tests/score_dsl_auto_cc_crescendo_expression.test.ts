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

describe("Score DSL autoCcPresets - crescendo_to_expression", () => {
  it("dynamic 変化に沿ってCC11がランプ状に生成される（端点含む）", async () => {
    const child = spawnServer();
    sendLine(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    await readLine(child);

    const score = {
      ppq: 480,
      meta: {
        timeSignature: { numerator: 4, denominator: 4 },
        keySignature: { root: "C", mode: "major" },
        tempo: { bpm: 120 },
        title: "AutoCC Cresc",
        autoCcPresets: [ { id: "crescendo_to_expression" } ]
      },
      tracks: [
        {
          name: "Lead",
          channel: 1,
          program: 0,
          events: [
            { type: "note", note: "C4", start: { bar:1, beat:1 }, duration: { value: "1/4" }, dynamic: "mp" },
            { type: "note", note: "D4", start: { bar:1, beat:2 }, duration: { value: "1/4" }, dynamic: "mf" },
            { type: "note", note: "E4", start: { bar:1, beat:3 }, duration: { value: "1/4" }, dynamic: "f" },
            { type: "note", note: "F4", start: { bar:1, beat:4 }, duration: { value: "1/4" } }
          ]
        }
      ]
    };

    // compile DSL to SMF
    sendLine(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "json_to_smf", arguments: { json: score, format: "score_dsl_v1", name: "auto_cc_cresc.mid", overwrite: true } } });
    const res1 = await readLine(child);
    const body1 = JSON.parse(res1.result.content[0].text);
    const fileId = body1.fileId as string;

    // roundtrip
    sendLine(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smf_to_json", arguments: { fileId } } });
    const res2 = await readLine(child);
    const body2 = JSON.parse(res2.result.content[0].text);

    const tracks = body2.json.tracks as any[];
    const cc11 = tracks.flatMap(t => (t.events||[])).filter((e:any)=> e.type==="cc" && e.controller===11);
    // 端点（mp@beat1 → mf@beat2 → f@beat3）の tick が含まれるか（ppq=480, 拍=480）
    const hasStart = cc11.some((e:any)=> e.tick===0 && e.value>0);
    const hasMid = cc11.some((e:any)=> e.tick===480 && e.value>0);
    const hasEnd = cc11.some((e:any)=> e.tick===960 && e.value>0);
    expect(hasStart && hasMid && hasEnd).toBe(true);

    // 値が単調非減少（クレッシェンド）
    const seq = cc11.filter((e:any)=> e.tick<=960).sort((a:any,b:any)=> a.tick-b.tick).map((e:any)=> e.value);
    for (let i=1;i<seq.length;i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i-1]);
    }

    child.kill();
  }, 20000);
});
