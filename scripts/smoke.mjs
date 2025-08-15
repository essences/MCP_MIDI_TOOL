#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STEPS = [];
function step(name) { const s = { name, ok: false, error: null, data: null }; STEPS.push(s); return s; }

function spawnServer() {
  const child = spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr?.on('data', d => { /* swallow, avoid noise */ });
  return child;
}

function sendLine(child, obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
async function readLine(child) {
  const [buf] = await once(child.stdout, 'data');
  const line = buf.toString('utf8').split(/\r?\n/)[0];
  return JSON.parse(line);
}

async function main() {
  const startedAt = new Date().toISOString();
  const result = { startedAt, node: process.version, steps: [] };
  const sInit = step('initialize');
  const sStore = step('store_midi');
  const sGet = step('get_midi');
  const sList = step('list_midi');
  const sExport = step('export_midi');
  let child;
  try {
    child = spawnServer();

    // initialize
    sendLine(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } } });
    const initResp = await readLine(child);
    sInit.ok = !!initResp?.result?.capabilities; sInit.data = initResp?.result ?? null;

    // store
    sendLine(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'store_midi', arguments: { base64: 'AQID', name: 'status.mid' } } });
    const stResp = await readLine(child);
    sStore.ok = !!stResp?.result?.ok; sStore.data = stResp?.result ?? null;
    const fileId = stResp?.result?.fileId;

    // get
    sendLine(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_midi', arguments: { fileId, includeBase64: false } } });
    const getResp = await readLine(child);
    sGet.ok = !!getResp?.result?.ok; sGet.data = getResp?.result ?? null;

    // list
    sendLine(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_midi', arguments: { limit: 1, offset: 0 } } });
    const listResp = await readLine(child);
    sList.ok = Array.isArray(listResp?.result?.items); sList.data = listResp?.result ?? null;

    // export
    sendLine(child, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'export_midi', arguments: { fileId } } });
    const expResp = await readLine(child);
    sExport.ok = !!expResp?.result?.ok; sExport.data = expResp?.result ?? null;
  } catch (e) {
    const msg = e?.stack || String(e);
    const current = STEPS.findLast(s => !s.ok);
    if (current && !current.error) current.error = msg;
  } finally {
    try { child?.kill(); } catch {}
  }

  const finishedAt = new Date().toISOString();
  result.finishedAt = finishedAt;
  result.steps = STEPS.map(s => ({ name: s.name, ok: s.ok, error: s.error, data: s.data }));

  const okAll = result.steps.every(s => s.ok);
  const emoji = okAll ? '✅' : '⚠️';
  const lines = [];
  lines.push(`# STATUS ${emoji}`);
  lines.push(`- Started: ${startedAt}`);
  lines.push(`- Finished: ${finishedAt}`);
  lines.push(`- Node: ${process.version}`);
  lines.push('');
  for (const s of result.steps) {
    lines.push(`## ${s.name} - ${s.ok ? 'PASS ✅' : 'FAIL ❌'}`);
    if (s.error) lines.push('Error: ' + s.error.split('\n')[0]);
    if (s.data) lines.push('Data: ' + JSON.stringify(s.data));
    lines.push('');
  }

  const outDir = path.resolve(process.cwd(), 'docs');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'STATUS.md'), lines.join('\n'), 'utf8');

  if (process.argv.includes('--summary')) {
    console.log(JSON.stringify({ ok: okAll, steps: result.steps.map(s => ({ name: s.name, ok: s.ok })) }, null, 2));
  } else {
    console.log(lines.slice(0, 10).join('\n'));
  }
}

main();
