#!/usr/bin/env node
// MCPクライアント: trigger_notes -> 状態確認 (get_playback_status) -> stop_playback
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ const c=spawn(process.execPath,['./dist/index.js'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']}); c.stdout.on('data',d=>process.stdout.write('[SRV] '+d)); c.stderr.on('data',d=>process.stderr.write('[SRV-ERR] '+d)); return c; }
function send(c,obj){ c.stdin.write(JSON.stringify(obj)+'\n'); }
let acc='';
async function read(c){ while(true){ const [buf]=await once(c.stdout,'data'); acc+=buf.toString('utf8'); const lines=acc.split(/\r?\n/).filter(l=>l.trim()); for(const ln of lines){ try{ const j=JSON.parse(ln); if(j.jsonrpc==='2.0'){ acc=acc.slice(acc.indexOf(ln)+ln.length+1); return j; } }catch{} } } }

async function main(){
  const child=spawnServer();
  // initialize
  send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'trigger-client',version:'0.0.1'}}});
  await read(child);
  // list tools (optional)
  send(child,{jsonrpc:'2.0',id:2,method:'tools/list'}); await read(child);
  // trigger chord (C major) 1秒
  send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'trigger_notes',arguments:{notes:['C4','E4','G4'],velocity:110,durationMs:1000}}});
  const trig=await read(child); if(trig.error) throw new Error('trigger_notes failed');
  console.log('[PLAY] chord triggered');
  // wait ~300ms then attempt status (if implemented)
  await new Promise(r=>setTimeout(r,400));
  // stop_playback (may be no-op if not registered for trigger_notes)
  send(child,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'stop_playback',arguments:{playbackId: trig.result?.playbackId || 'unknown'}}});
  await read(child).catch(()=>{});
  child.kill();
  console.log('trigger_notes ワークフロースクリプト完了 (音が鳴ったかはMIDIデバイスで確認)');
}

main().catch(e=>{ console.error('Trigger workflow failed',e); process.exit(1); });