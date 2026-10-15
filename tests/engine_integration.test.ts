import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMidiEngine} from '../src/engine.js';
import {buildPlaybackPlan} from '../src/playbackPlan.js';

class Output {
  static instances:Output[]=[];
  static fail=false;
  messages:number[][]=[];
  closed=false;
  constructor(){Output.instances.push(this);}
  getPortCount(){return 1;}
  getPortName(){return 'Fake expressive output';}
  openPort(){}
  closePort(){this.closed=true;}
  sendMessage(bytes:number[]){if(Output.fail)throw new Error('fake send failed');this.messages.push(bytes);}
}
const note=(pitch=60)=>({type:'note',tick:0,channel:2,pitch,velocity:100,duration:480});
const song=(pitch=60)=>({format:1,ppq:480,tracks:[{events:[{type:'meta.tempo',tick:0,usPerQuarter:500000},note(pitch)]}]});

describe.sequential('engine safe storage and expressive playback integration',()=>{
  let dir:string;let engine:ReturnType<typeof createMidiEngine>;
  const compose=(name:string,json:any=song(),overwrite=false)=>engine.call('json_to_smf',{format:'json_midi_v1',json,name,overwrite});
  beforeEach(async()=>{
    dir=await fs.mkdtemp(path.join(os.tmpdir(),'midi-engine-integration-'));
    vi.stubEnv('MCP_MIDI_BASE_DIR',dir);vi.stubEnv('MCP_MIDI_MANIFEST','manifest.json');
    Output.instances=[];Output.fail=false;engine=createMidiEngine({midi:{Output}});
  });
  afterEach(async()=>{await engine.dispose();vi.useRealTimers();vi.unstubAllEnvs();await fs.rm(dir,{recursive:true,force:true});});

  it('rejects collisions, preserves fileId on explicit overwrite and validates imported SMF',async()=>{
    const first=await compose('same.mid');expect(first.ok).toBe(true);
    expect(await compose('same.mid')).toMatchObject({ok:false,error:{code:'ALREADY_EXISTS'}});
    const overwritten=await compose('same.mid',song(67),true);expect(overwritten.fileId).toBe(first.fileId);
    const decoded=await engine.call('smf_to_json',{fileId:first.fileId});
    expect(decoded.json.tracks.flatMap((t:any)=>t.events)).toContainEqual(expect.objectContaining({pitch:67}));
    expect((await engine.call('list_midi')).items).toHaveLength(1);
    expect(await engine.call('store_midi',{name:'invalid.mid',base64:Buffer.from('not MIDI').toString('base64')})).toMatchObject({ok:false});
    const data=(await engine.call('get_midi',{fileId:first.fileId,includeBase64:true})).base64;
    expect(await engine.call('store_midi',{name:'same.mid',base64:data})).toMatchObject({ok:false,error:{code:'ALREADY_EXISTS'}});
    expect((await engine.call('store_midi',{name:'same.mid',base64:data,overwrite:true})).fileId).toBe(first.fileId);
  });

  it('serializes independent edit calls without losing either appended chunk',async()=>{
    const saved=await compose('append.mid');const second=createMidiEngine({midi:{}});
    try{
      const results=await Promise.all([engine.call('append_to_smf',{fileId:saved.fileId,json:song(62),format:'json_midi_v1',atEnd:true}),second.call('append_to_smf',{fileId:saved.fileId,json:song(64),format:'json_midi_v1',atEnd:true})]);
      expect(results.map(r=>r.ok)).toEqual([true,true]);
      const decoded=await engine.call('smf_to_json',{fileId:saved.fileId});
      const notes=decoded.json.tracks.flatMap((t:any)=>t.events).filter((e:any)=>e.type==='note').sort((a:any,b:any)=>a.tick-b.tick);
      expect(notes.map((n:any)=>n.tick)).toEqual([0,480,960]);
      expect(notes.map((n:any)=>n.pitch).sort()).toEqual([60,62,64]);
    }finally{await second.dispose();}
  });

  it('rejects unsafe edit names and conflicting copy outputs while keeping the original readable',async()=>{
    const saved=await compose('source.mid');
    expect(await engine.call('append_to_smf',{fileId:saved.fileId,json:song(62),format:'json_midi_v1',outputName:'../escaped.mid'})).toMatchObject({ok:false,error:{code:'INPUT_FORMAT_ERROR'}});
    const results=await Promise.all([62,64].map(pitch=>engine.call('append_to_smf',{fileId:saved.fileId,json:song(pitch),format:'json_midi_v1',outputName:'copy.mid'})));
    expect(results.map(r=>r.ok).sort()).toEqual([false,true]);
    expect((await engine.call('list_midi')).items).toHaveLength(2);
    const decoded=await engine.call('smf_to_json',{fileId:saved.fileId});
    expect(decoded.json.tracks.flatMap((t:any)=>t.events).filter((e:any)=>e.type==='note')).toHaveLength(1);
    expect(await fs.access(path.join(dir,'data','escaped.mid')).then(()=>true,()=>false)).toBe(false);
  });

  it('sends the same multi-tempo CC/program/PB plan reported by dry-run, preserving channel',async()=>{
    const expressive={format:1,ppq:480,tracks:[{events:[
      {type:'meta.tempo',tick:0,usPerQuarter:500000},{type:'meta.tempo',tick:480,usPerQuarter:1000000},
      {type:'program',tick:0,channel:2,program:17},
      {type:'cc',tick:0,channel:2,controller:64,value:127},
      {type:'pitchBend',tick:120,channel:2,value:2048},
      {type:'aftertouch.channel',tick:120,channel:2,pressure:70},
      {type:'aftertouch.poly',tick:120,channel:2,pitch:60,pressure:80},
      {type:'pitchBend',tick:240,channel:2,value:0},
      {type:'program',tick:360,channel:2,program:18},
      {type:'cc',tick:720,channel:2,controller:64,value:0},
      {...note(),duration:960},
    ]}]};
    const saved=await compose('expressive.mid',expressive);expect(saved.ok).toBe(true);
    const decoded=await engine.call('smf_to_json',{fileId:saved.fileId});
    const plan=buildPlaybackPlan(decoded.json);
    const dry=await engine.call('play_smf',{fileId:saved.fileId,dryRun:true});
    expect(dry).toMatchObject({ok:true,scheduledEvents:plan.events.length,totalDurationMs:1500});
    expect(Output.instances).toHaveLength(0);
    vi.useFakeTimers({toFake:['performance','setTimeout','clearTimeout','setInterval','clearInterval']});
    const play=await engine.call('play_smf',{fileId:saved.fileId});
    expect(play.scheduledEvents).toBe(dry.scheduledEvents);
    await vi.advanceTimersByTimeAsync(1510);
    const out=Output.instances.at(-1)!;
    expect(out.messages.slice(0,plan.events.length)).toEqual(plan.events.map(event=>event.bytes));
    expect(out.messages).toContainEqual([0xc2,17]);expect(out.messages).toContainEqual([0xc2,18]);
    expect(out.messages).toContainEqual([0xb2,64,127]);expect(out.messages).toContainEqual([0xb2,64,0]);
    expect(out.messages).toContainEqual([0xe2,0,80]);expect(out.messages).toContainEqual([0xe2,0,64]);
    expect(out.messages).toContainEqual([0xd2,70]);expect(out.messages).toContainEqual([0xa2,60,80]);
    expect(out.messages).toContainEqual([0x82,60,0]);expect(out.closed).toBe(true);
    expect((await engine.call('get_playback_status',{playbackId:play.playbackId})).done).toBe(true);
    expect(await engine.call('stop_playback',{playbackId:play.playbackId})).toMatchObject({ok:true});
    expect(await engine.call('get_playback_status',{playbackId:play.playbackId})).toMatchObject({ok:true,done:true});
  });

  it('exposes failed playback status and emits JSON-safe snapshots without live objects',async()=>{
    const saved=await compose('failure.mid');Output.fail=true;
    vi.useFakeTimers({toFake:['performance','setTimeout','clearTimeout','setInterval','clearInterval']});
    const played=await engine.call('play_smf',{fileId:saved.fileId});await vi.advanceTimersByTimeAsync(1);
    expect(await engine.call('get_playback_status',{playbackId:played.playbackId})).toMatchObject({ok:true,done:true,error:{code:'MIDI_SEND_FAILED',message:'fake send failed'}});
    const snapshot=JSON.parse(JSON.stringify(engine.snapshot()));
    expect(snapshot.playbacks[0]).toMatchObject({id:played.playbackId,done:true,error:{code:'MIDI_SEND_FAILED'}});
    snapshot.playbacks[0].error.message='caller mutation';
    expect((await engine.call('get_playback_status',{playbackId:played.playbackId})).error.message).toBe('fake send failed');
    expect(snapshot.playbacks[0]).not.toHaveProperty('out');expect(snapshot.playbacks[0]).not.toHaveProperty('timeouts');
    expect(engine.getActivity().playbacks).toBe(0);
  });
});
