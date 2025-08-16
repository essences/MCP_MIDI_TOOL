#!/usr/bin/env node
// MCP stdio E2E smoke: initialize -> json_to_smf -> play_smf(dryRun) -> smf_to_json
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

function sendLine(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function readLine(child) {
  const [buf] = await once(child.stdout, 'data');
  const line = String(buf).split(/\r?\n/).filter(Boolean)[0];
  return JSON.parse(line);
}

function makeSong() {
  return {
    format: 1,
    ppq: 480,
    tracks: [
      { events: [ { type: 'meta.tempo', tick: 0, usPerQuarter: 500000 } ] },
      { channel: 0, events: [
        { type: 'program', tick: 0, program: 0 },
        { type: 'note', tick: 0, pitch: 60, velocity: 100, duration: 240 }
      ]}
    ]
  };
}

async function main() {
  const child = spawnServer();
  try {
    // initialize
    sendLine(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
    const initRes = await readLine(child);
    if (initRes.error) throw new Error('initialize failed: ' + JSON.stringify(initRes.error));

    // json_to_smf
    const song = makeSong();
    sendLine(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'json_to_smf', arguments: { json: song, name: 'smoke.mid', overwrite: true } } });
    const res1 = await readLine(child);
    if (res1.error) throw new Error('json_to_smf failed: ' + JSON.stringify(res1.error));
    const body1 = JSON.parse(res1.result.content[0].text);
    const { fileId, bytes, trackCount, eventCount } = body1;
    if (!fileId) throw new Error('fileId missing from json_to_smf response');

    // play_smf dryRun
    sendLine(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'play_smf', arguments: { fileId, dryRun: true } } });
    const res2 = await readLine(child);
    if (res2.error || !res2.result?.ok) throw new Error('play_smf dryRun failed: ' + JSON.stringify(res2.error || res2.result));
    const { scheduledEvents, totalDurationMs } = res2.result;

    // smf_to_json
    sendLine(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'smf_to_json', arguments: { fileId } } });
    const res3 = await readLine(child);
    if (res3.error) throw new Error('smf_to_json failed: ' + JSON.stringify(res3.error));
    const body3 = JSON.parse(res3.result.content[0].text);
    const roundtripPpq = body3.json?.ppq;

    // summary
    console.log(JSON.stringify({ ok: true, fileId, bytes, trackCount, eventCount, scheduledEvents, totalDurationMs, roundtripPpq }, null, 2));
    child.kill();
  } catch (e) {
    console.error('[smoke:fail]', e?.stack || String(e));
    try { child.kill(); } catch {}
    process.exit(1);
  }
}

main();
