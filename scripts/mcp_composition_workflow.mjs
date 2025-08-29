#!/usr/bin/env node
// 作曲E2E: Score DSL -> SMF -> bar抽出 -> 部分編集置換 -> 追記 -> precise再生dryRun
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ const c = spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio:['pipe','pipe','pipe']}); c.stdout.on('data',d=>process.stdout.write('[SRV] '+d)); c.stderr.on('data',d=>process.stderr.write('[SRV-ERR] '+d)); return c; }
function send(child,obj){ child.stdin.write(JSON.stringify(obj)+'\n'); }
let acc='';
async function read(child){
  while(true){
    const [buf] = await once(child.stdout,'data');
    acc += buf.toString('utf8');
    const parts = acc.split(/\r?\n/).filter(l=>l.trim().length>0);
    for(const p of parts){
      try { const j = JSON.parse(p); if(j.jsonrpc==='2.0') { acc = acc.slice(acc.indexOf(p)+p.length+1); return j; } } catch{/*ignore*/}
    }
  }
}

async function main(){
  const child = spawnServer();
  send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'compose-client',version:'0.0.1'}}});
  await read(child);

  const SCORE = `#title:ComposeFlow\n#tempo:120\n#time:4/4\n` +
    `piano: C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 | C5 8 C5 8 C5 8 C5 8 C5 8 C5 8 C5 8 C5 8`;

  // 1) DSL -> SMF
  send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{json:SCORE,format:'score_dsl_v1',name:'compose_base.mid',overwrite:true}}});
  const smf = await read(child); if(smf.error){ console.error('[json_to_smf error]', smf.error); }
  const fileId = smf.result?.fileId; if(!fileId) throw new Error('json_to_smf failed');
  console.log('[1] Base SMF fileId', fileId);

  // 2) bar2 抽出 (JSON)
  send(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'extract_bars',arguments:{fileId,startBar:2,endBar:2}}});
  const ext = await read(child); if(!ext.result?.json) throw new Error('extract_bars failed');
  console.log('[2] Extracted bar2 events', ext.result.json.tracks?.[0]?.events?.length);

  // 3) 置換: bar2 をシンプルな上昇2音に差し替え
  const replacement = { ppq: ext.result.json.ppq, tracks:[{ events:[ {type:'note',tick:0,pitch:60,velocity:100,duration:480},{type:'note',tick:480,pitch:64,velocity:100,duration:480} ]}] };
  send(child,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'replace_bars',arguments:{fileId,startBar:2,endBar:2,json:replacement}}});
  const rep = await read(child); if(!rep.result?.newFileId) throw new Error('replace_bars failed');
  const newFileId = rep.result.newFileId; console.log('[3] Replaced bar2 newFileId', newFileId);

  // 4) 末尾追記: 1小節追加 (DSL)
  const ADD = { ppq:480, meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{ root:'C', mode:'major' }, tempo:{bpm:120} }, tracks:[ { channel:0, events:[
    { type:'note', note:'C5', start:{bar:1,beat:1}, duration:{value:'1/4'} },
    { type:'note', note:'A4', start:{bar:1,beat:2}, duration:{value:'1/4'} },
    { type:'note', note:'F4', start:{bar:1,beat:3}, duration:{value:'1/4'} },
    { type:'note', note:'G4', start:{bar:1,beat:4}, duration:{value:'1/4'} },
  ] } ] };
  send(child,{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'append_to_smf',arguments:{fileId:newFileId,json:ADD,format:'score_dsl_v1',atEnd:true,gapTicks:0}}});
  const ap = await read(child); if(!ap.result?.fileId) throw new Error('append_to_smf failed');
  const finalId = ap.result.fileId; console.log('[4] Appended finalId', finalId);

  // 5) 精密 bar3 dryRun 再生 (startBar=3)
  send(child,{jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'play_smf',arguments:{fileId:finalId,dryRun:true,startBar:3,endBar:3}}});
  const play = await read(child); if(!play.result?.scheduledEvents) throw new Error('play_smf failed');
  console.log('[5] play_smf bar3 scheduledEvents', play.result.scheduledEvents, 'extractionMode', play.result.extractionMode);

  child.kill();
  console.log('\n作曲E2Eワークフロー SUCCESS');
}

main().catch(e=>{ console.error('Composition workflow failed', e); process.exit(1); });