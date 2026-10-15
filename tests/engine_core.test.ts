import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createMidiEngine } from '../src/engine.js';

const song = { format: 1, ppq: 480, tracks: [{ events: [
  {type:'meta.tempo',tick:0,usPerQuarter:500000},
  {type:'meta.tempo',tick:480,usPerQuarter:1000000},
  {type:'note',tick:0,channel:0,pitch:60,velocity:100,duration:960},
] }] };

class FakeOutput {
  static instances: FakeOutput[] = [];
  messages: number[][]=[];
  closed=false;
  constructor(){FakeOutput.instances.push(this);}
  getPortCount(){return 1;}
  getPortName(){return 'Fake output';}
  openPort(){}
  closePort(){this.closed=true;}
  sendMessage(bytes:number[]){if(this.closed)throw new Error('closed'); this.messages.push(bytes);}
}
class FakeInput extends EventEmitter {
  static instances: FakeInput[]=[];
  closed=false;
  constructor(){super(); FakeInput.instances.push(this);}
  getPortCount(){return 1;}
  getPortName(){return 'Fake input';}
  openPort(){}
  ignoreTypes(){}
  closePort(){this.closed=true;}
}

describe.sequential('MCP-free engine',()=>{
  let dir:string;
  let engine:ReturnType<typeof createMidiEngine>;
  beforeEach(async()=>{
    dir=await fs.mkdtemp(path.join(os.tmpdir(),'midi-engine-'));
    vi.stubEnv('MCP_MIDI_BASE_DIR',dir);
    vi.stubEnv('MCP_MIDI_MANIFEST','manifest.json');
    engine=createMidiEngine({midi:{Output:FakeOutput,Input:FakeInput}});
    FakeOutput.instances=[]; FakeInput.instances=[];
  });
  afterEach(async()=>{vi.useRealTimers(); await engine.dispose(); vi.unstubAllEnvs(); await fs.rm(dir,{recursive:true,force:true});});

  it('composes, decodes and dry-runs the same tempo map without native devices',async()=>{
    const saved=await engine.call('json_to_smf',{json:song,format:'json_midi_v1',name:'tempo.mid'});
    expect(saved.ok).toBe(true); expect(saved.content).toBeUndefined();
    const decoded=await engine.call('smf_to_json',{fileId:saved.fileId});
    expect(decoded.ok).toBe(true);
    expect(decoded.json.tracks.flatMap((t:any)=>t.events).filter((e:any)=>e.type==='note')).toEqual(expect.arrayContaining([expect.objectContaining({pitch:60,duration:960})]));
    const dry=await engine.call('play_smf',{fileId:saved.fileId,dryRun:true});
    expect(dry.ok).toBe(true);
    // The raw SMF decoder retains the two note edges without inventing a program event.
    expect(dry.scheduledEvents).toBe(2); expect(dry.totalDurationMs).toBeCloseTo(1500,0);
    expect(FakeOutput.instances).toHaveLength(0);
    expect(engine.getActivity()).toEqual({playbacks:0,recordings:0,captures:0});
    const second=createMidiEngine({midi:{}});
    try{expect((await second.call('get_midi',{fileId:saved.fileId})).fileId).toBe(saved.fileId);}finally{await second.dispose();}
  });

  it('retains capture state across calls and isolates engine instances',async()=>{
    const capture=await engine.call('start_single_capture',{finalizeOnRelease:true});
    expect(engine.getActivity().captures).toBe(1);
    await engine.call('feed_single_capture',{captureId:capture.captureId,events:[{kind:'on',note:60,velocity:90,at:0},{kind:'on',note:64,velocity:80,at:20},{kind:'off',note:60,at:100},{kind:'off',note:64,at:120}]});
    const status=await engine.call('get_single_capture_status',{captureId:capture.captureId});
    expect(status).toMatchObject({ok:true,done:true,reason:'completed',result:{notes:[60,64],velocities:[90,80],durationMs:120,isChord:true}});
    expect(engine.getActivity().captures).toBe(0);
    const other=createMidiEngine({midi:{}});
    try{expect(await other.call('get_single_capture_status',{captureId:capture.captureId})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});}finally{await other.dispose();}
  });

  it('keeps a lookahead-scheduled final note alive until its due time',async()=>{
    const saved=await engine.call('json_to_smf',{json:{...song,tracks:[{events:song.tracks[0].events.map(event=>event.type==='note'?{...event,channel:1}:event)}]},format:'json_midi_v1',name:'play.mid'});
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']});
    const play=await engine.call('play_smf',{fileId:saved.fileId,schedulerLookaheadMs:100,schedulerTickMs:10});
    expect(play.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(1450);
    const out=FakeOutput.instances.at(-1)!;
    expect(out.closed).toBe(false);
    expect((await engine.call('get_playback_status',{playbackId:play.playbackId})).done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(out.messages).toContainEqual([0x81,60,0]); expect(out.closed).toBe(true);
    expect(engine.getActivity().playbacks).toBe(0);
  });

  it('returns structured device failures and rejects unmatched output hints',async()=>{
    const missing=createMidiEngine({midi:{}});
    try{expect(await missing.call('trigger_notes',{notes:[60]})).toMatchObject({ok:false,error:{code:'DEVICE_UNAVAILABLE'}});}finally{await missing.dispose();}
    expect(await engine.call('trigger_notes',{notes:[60],portName:'absent'})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
    expect(FakeOutput.instances.flatMap(o=>o.messages)).toHaveLength(0);
  });

  it('disposes recording ports, awaits saved SMF and saves a stopped session only once',async()=>{
    const started=await engine.call('start_continuous_recording');
    expect(started.ok).toBe(true);
    FakeInput.instances.at(-1)!.emit('message',0,[0x90,60,100]);
    const stopped=await engine.call('stop_continuous_recording',{recordingId:started.recordingId,name:'take.mid'});
    const again=await engine.call('stop_continuous_recording',{recordingId:started.recordingId,name:'duplicate.mid'});
    expect(stopped.ok).toBe(true); expect(again.fileId).toBe(stopped.fileId);
    const second=await engine.call('start_continuous_recording');
    FakeInput.instances.at(-1)!.emit('message',0,[0x90,64,80]);
    expect(second.ok).toBe(true);
    await engine.dispose(); await engine.dispose();
    expect(FakeInput.instances.every(i=>i.closed)).toBe(true);
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'data','manifest.json'),'utf8'));
    expect(manifest.items).toHaveLength(2);
    for(const item of manifest.items){const bytes=await fs.readFile(path.resolve(dir,item.path));expect(bytes.subarray(0,4).toString()).toBe('MThd');}
    expect(await engine.call('list_midi')).toMatchObject({ok:false,error:{code:'ENGINE_DISPOSED'}});
  });
});
