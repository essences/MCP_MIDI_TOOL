#!/usr/bin/env node
// Minimal MCP handshake/connectivity test resembling a generic MCP client (e.g., Codex CLI)
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer() {
  const child = spawn(process.execPath, ['./dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', (e) => console.error('[server:error]', e));
  child.stderr.on('data', (d) => process.stderr.write('[server:stderr] ' + String(d)));
  return child;
}

function send(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

let acc = '';
async function readById(child, id) {
  while (true) {
    const [buf] = await once(child.stdout, 'data');
    acc += String(buf);
    const parts = acc.split(/\r?\n/).filter(l => l.trim().length > 0);
    for (const p of parts) {
      try {
        const j = JSON.parse(p);
        if (j && j.id === id) {
          // cut consumed part from acc buffer
          const idx = acc.indexOf(p);
          acc = acc.slice(idx + p.length + 1);
          return j;
        }
      } catch { /* wait for more */ }
    }
  }
}

async function main() {
  const child = spawnServer();
  try {
    // initialize (as Codex would)
    send(child, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'codex-connect-test', version:'0.0.1' } } });
    const initRes = await readById(child, 1);
    if (initRes.error) throw new Error('initialize failed: ' + JSON.stringify(initRes.error));

    // tools/list
    send(child, { jsonrpc:'2.0', id:2, method:'tools/list', params:{} });
    const toolsRes = await readById(child, 2);
    if (toolsRes.error) throw new Error('tools/list failed: ' + JSON.stringify(toolsRes.error));
    const tools = toolsRes.result?.tools || [];

    // resources/list
    send(child, { jsonrpc:'2.0', id:3, method:'resources/list', params:{} });
    const resRes = await readById(child, 3);
    if (resRes.error) throw new Error('resources/list failed: ' + JSON.stringify(resRes.error));
    const resources = resRes.result?.resources || [];

    // prompts/list
    send(child, { jsonrpc:'2.0', id:4, method:'prompts/list', params:{} });
    const promptsRes = await readById(child, 4);
    if (promptsRes.error) throw new Error('prompts/list failed: ' + JSON.stringify(promptsRes.error));
    const prompts = promptsRes.result?.prompts || [];

    // summary
    console.log(JSON.stringify({ ok:true, tools: tools.map(t=>t.name), resources: resources.map(r=>r.name), prompts: prompts.map(p=>p.name) }, null, 2));
  } catch (e) {
    console.error('[connect-test:fail]', e?.stack || String(e));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
  }
}

main();
