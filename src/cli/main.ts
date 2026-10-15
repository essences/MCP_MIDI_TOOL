import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMidiEngine } from '../engine.js';
import { analyzeDataMigration, importDataMigration } from '../dataMigration.js';
import { callRuntime, failure } from '../local/client.js';
import { recordForeground, playAndRecord } from '../workflows.js';
import { parse, InputError, help, validateRequired, validateWorkflow } from './commands.js';
async function input(file:string):Promise<Buffer>{if(file!=='-')return fs.readFile(file);const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
async function json(file:string){try{return JSON.parse((await input(file)).toString('utf8'));}catch(error:any){throw new InputError(`Cannot read JSON ${file}: ${error.message}`);}}
function object(value:any){if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('Arguments must be a JSON object');return value;}
export async function execute(argv:string[]):Promise<{result:any;exitCode:number}>{
  try{
    const {command,operation,options,args:flags}=parse(argv);
    const dataDir=path.resolve(options['data-dir']||process.env.MIDI_TOOL_DATA_DIR||fileURLToPath(new URL('../../data/',import.meta.url)));
    process.env.MIDI_TOOL_DATA_DIR=dataDir;process.env.MCP_MIDI_MANIFEST='manifest.json';
    let args:any=options['args-file']?object(await json(options['args-file'])):{};
    if(options.input){if(command==='import')args.base64=(await input(options.input)).toString('base64');else if(['compose','append','bars replace'].includes(command))args.json=await json(options.input);else args={...args,...object(await json(options.input))};}args={...args,...flags};
    let result:any;
    if(command==='record'||command==='play-record'){
      validateWorkflow(command,args);const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
      try{const dependencies={client:(operation:string,arguments_:Record<string,any>,autostart=false)=>callRuntime(dataDir,operation,arguments_,autostart),signal:controller.signal};result=command==='record'?await recordForeground(args,dependencies):await playAndRecord(args,dependencies);}
      finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
    }else if(command.startsWith('runtime '))result=await callRuntime(dataDir,command.replace(' ','.'));
    else if(command.startsWith('migrate ')){
      if(!options['source-base']||!Array.isArray(options.manifests)||!options.manifests.every((v:any)=>typeof v==='string'))throw new InputError('Migration requires --source-base and --manifests JSON string array');
      const migration={sourceBaseDir:path.resolve(options['source-base']),sourceManifestPaths:options.manifests.map((v:string)=>path.resolve(v)),targetDataDir:dataDir};
      result={ok:true,report:command==='migrate analyze'?await analyzeDataMigration(migration):await importDataMigration({...migration,dryRun:!options.apply})};
    }else if(command==='doctor'){
      const engine=createMidiEngine();try{result={ok:true,node:process.version,platform:process.platform,dataDir,output:await engine.call('list_devices',{}),input:await engine.call('list_input_devices',{})};}finally{await engine.dispose();}
    }else{
      const op=operation!;validateRequired(op,args);
      const stateful=/capture|recording|playback/.test(op)||(['play_smf','trigger_notes'].includes(op)&&!args.dryRun);
      const autostart=op.startsWith('start_')||['play_smf','trigger_notes','playback_midi'].includes(op);
      if(stateful)result=await callRuntime(dataDir,op,args,autostart);else{const engine=createMidiEngine();try{result=await engine.call(op,args);}finally{await engine.dispose();}}
      if(['play_smf','trigger_notes'].includes(op)&&!args.dryRun&&!options.background&&result.ok){const started=result;const deadline=Date.now()+Math.max(30000,Number(result.totalDurationMs||result.durationMs||0)+15000);while(Date.now()<deadline){await new Promise(r=>setTimeout(r,50));const status=await callRuntime(dataDir,'get_playback_status',{playbackId:started.playbackId});if(!status.ok){result=status;break;}if(status.error){result={ok:false,error:status.error,playbackId:started.playbackId};break;}if(status.done){result={...started,done:true};break;}}if(!result.done&&result.ok){await callRuntime(dataDir,'stop_playback',{playbackId:started.playbackId});result=failure('TIMEOUT','Playback completion timed out');}}
    }
    return {result,exitCode:result.ok?0:1};
  }catch(error:any){const cli=error instanceof InputError;return {result:failure(cli?'INPUT_ERROR':'INTERNAL_ERROR',error.message),exitCode:cli?2:1};}
}
export async function runCli(argv:string[]=process.argv.slice(2)){
  if(argv.includes('--help')){process.stdout.write(help);return;}
  const {result,exitCode}=await execute(argv);process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=exitCode;
}
if(process.argv[1]?.match(/main\.(js|ts)$/))void runCli();
