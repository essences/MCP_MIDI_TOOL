import { spawn } from 'node:child_process';import { once } from 'node:events';
function spawnServer(){ return spawn(process.execPath,['./dist/index.js'],{cwd:process.cwd(),stdio:['pipe','pipe','inherit']}); }
function send(child,obj){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function recv(child){ const [buf]=await once(child.stdout,'data'); return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }
const SCORE = "#title:BarRangeTest\n#tempo:120\n#time:4/4\npiano: C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 | C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8 C4 8";
(async()=>{ const child=spawnServer(); send(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'dbg',version:'0.0.0'}}}); await recv(child); send(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json:SCORE, format:'score_dsl_v1', name:'bar_range.mid', overwrite:true }}}); const smf=await recv(child); console.log('json_to_smf resp', JSON.stringify(smf,null,2)); child.kill(); })();
