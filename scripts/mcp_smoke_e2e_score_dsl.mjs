#!/usr/bin/env node
// Score DSL stdio E2E: initialize -> json_to_smf(DSL) -> play_smf(dryRun) -> smf_to_json
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() {
  const command = process.execPath; // node
  const args = ['./dist/index.js'];
  const child = spawn(command, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', (e) => console.error('[server:error]', e));
  child.stderr.on('data', (d) => process.stderr.write(String(d)));
  return child;
}

function sendLine(child, obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
async function readLine(child) { const [buf] = await once(child.stdout, 'data'); const line = String(buf).split(/\r?\n/).filter(Boolean)[0]; return JSON.parse(line); }

function makeScore() {
  return {
    ppq: 480,
    meta: { timeSignature: { numerator: 4, denominator: 4 }, keySignature: { root: 'C', mode: 'major' }, tempo: { bpm: 120 }, title: 'Score DSL Demo' },
    tracks: [ { name: 'Lead', channel: 0, program: 0, events: [
      { type: 'note', note: 'C4', start: { bar: 1, beat: 1 }, duration: { value: '1/4' }, articulation: 'staccato', velocity: 96 },
      { type: 'note', note: 'D4', start: { bar: 1, beat: 2 }, duration: { value: '1/8', dots: 1 }, articulation: 'accent', velocity: 90 },
      { type: 'note', note: 'E4', start: { bar: 1, beat: 3 }, duration: { value: '1/8', tuplet: { inSpaceOf: 2, play: 3 } }, slur: true, velocity: 84 },
      { type: 'note', note: 'F4', start: { bar: 1, beat: 4 }, duration: { value: '1/4' }, articulation: 'tenuto', velocity: 80 }
    ] } ]
  };
}

async function main() {
  const child = spawnServer();
  try {
    // initialize
    sendLine(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-dsl', version: '0' } } });
    const initRes = await readLine(child); if (initRes.error) throw new Error('initialize failed: ' + JSON.stringify(initRes.error));

    // json_to_smf with DSL (object)
    const score = makeScore();
    sendLine(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'json_to_smf', arguments: { json: score, name: 'smoke_dsl.mid', overwrite: true } } });
    const res1 = await readLine(child); if (res1.error) throw new Error('json_to_smf failed: ' + JSON.stringify(res1.error));
    const body1 = JSON.parse(res1.result.content[0].text);
    const { fileId, bytes, trackCount, eventCount } = body1; if (!fileId) throw new Error('fileId missing');

    // play_smf dryRun
    sendLine(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'play_smf', arguments: { fileId, dryRun: true } } });
    const res2 = await readLine(child); if (res2.error || !res2.result?.ok) throw new Error('play_smf dryRun failed: ' + JSON.stringify(res2.error || res2.result));
    const { scheduledEvents, totalDurationMs } = res2.result;

    // smf_to_json
    sendLine(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'smf_to_json', arguments: { fileId } } });
    const res3 = await readLine(child); if (res3.error) throw new Error('smf_to_json failed: ' + JSON.stringify(res3.error));
    const body3 = JSON.parse(res3.result.content[0].text);

    console.log(JSON.stringify({ ok: true, fileId, bytes, trackCount, eventCount, scheduledEvents, totalDurationMs, ppq: body3.json?.ppq }, null, 2));
    child.kill();
  } catch (e) {
    console.error('[smoke-dsl:fail]', e?.stack || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

main();
