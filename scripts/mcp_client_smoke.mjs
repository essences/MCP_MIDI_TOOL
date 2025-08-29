#!/usr/bin/env node
// 簡易 MCP クライアント: サーバープロセスをspawnし initialize → tools/list → 代表ツール呼び出し を検証
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){
  const child = spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio:['pipe','pipe','pipe'] });
  child.stderr.on('data', d=> process.stderr.write(d));
  return child;
}
function send(child,obj){ child.stdin.write(JSON.stringify(obj)+'\n'); }
let buffer = '';
async function read(child){
  while(true){
    const [buf] = await once(child.stdout,'data');
    buffer += buf.toString('utf8');
    const lines = buffer.split(/\r?\n/).filter(l=>l.trim().length>0);
    // 末尾が改行で終わっていない場合は最後の一片は未完成とみなす
    const complete = buffer.endsWith('\n') ? lines : lines.slice(0,-1);
    if(complete.length){
      const line = complete[0];
      // 残余再構築
      const consumedLength = buffer.indexOf(line) + line.length + 1; // +1: 改行
      buffer = buffer.slice(consumedLength);
      try { return JSON.parse(line); } catch(e){ continue; }
    }
  }
}

async function main(){
  const child = spawnServer();
  send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'smoke-client',version:'0.0.1'}}});
  const initResp = await read(child);
  if(initResp.error) throw new Error('initialize failed '+JSON.stringify(initResp.error));
  console.log('[OK] initialize');
  send(child,{jsonrpc:'2.0',id:2,method:'tools/list'});
  const tools = await read(child);
  if(!tools.result || !Array.isArray(tools.result.tools)) throw new Error('tools/list invalid');
  console.log('[OK] tools/list count=', tools.result.tools.length);
  // 代表: json_to_smf → play_smf(dryRun)
  const SCORE = '#title:SmokeTest\n#tempo:120\n#time:4/4\n' + 'piano: C4 4 C4 4 C4 4 C4 4';
  send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'json_to_smf',arguments:{json:SCORE,format:'score_dsl_v1',name:'smoke_bar.mid',overwrite:true}}});
  const smf = await read(child);
  if(!smf.result?.fileId) throw new Error('json_to_smf fail');
  console.log('[OK] json_to_smf fileId', smf.result.fileId);
  send(child,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'play_smf',arguments:{fileId:smf.result.fileId,dryRun:true}}});
  const play = await read(child);
  if(!play.result?.scheduledEvents) throw new Error('play_smf dryRun fail');
  console.log('[OK] play_smf scheduledEvents', play.result.scheduledEvents);
  child.kill();
  console.log('\nMCP クライアントスモークテスト SUCCESS');
}

main().catch(e=>{ console.error('Smoke test failed', e); process.exit(1); });