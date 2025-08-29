import { spawn } from 'node:child_process';import { once } from 'node:events';
function spawnServer(){ return spawn(process.execPath,['./dist/index.js'],{cwd:process.cwd(),stdio:['pipe','pipe','inherit']}); }
function send(child,obj){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function recv(child){ const [buf]=await once(child.stdout,'data'); return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }
const SCORE="#title:BarRangeTest\n#tempo:120\n#time:4/4\npiano: C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 | C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8";
(async()=>{ const c=spawnServer(); send(c,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'dbg',version:'0'}}}); await recv(c); send(c,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{json:SCORE,format:'score_dsl_v1',name:'bar_range.mid',overwrite:true}}}); const smf=await recv(c); const fileId=smf.result.fileId; console.log('fileId',fileId);
 send(c,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{fileId,dryRun:true}}}); const all=await recv(c); console.log('ALL', all.result.scheduledEvents, all.result.extractionMode, all.result.warnings);
 send(c,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'play_smf',arguments:{fileId,dryRun:true,startBar:1,endBar:1}}}); const bar1=await recv(c); console.log('BAR1', bar1.result.scheduledEvents, bar1.result.extractionMode, bar1.result.warnings);
 c.kill(); })();
