import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import {EventEmitter} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {createMidiEngine} from '../src/engine.js';
import {decodeSmfToJson} from '../src/smfToJson.js';

class Input extends EventEmitter {
  static instances:Input[]=[];
  opened=false;
  closed=false;
  constructor(){super();Input.instances.push(this);}
  getPortCount(){return 1;}
  getPortName(){return 'Test keyboard';}
  openPort(){this.opened=true;}
  closePort(){this.closed=true;}
  ignoreTypes(){}
}
// Read the bytes actually saved, retaining overlapping same-pitch MIDI edges.
function readNoteEdges(buffer:Buffer){
  const edges:Array<{tick:number,status:number,pitch:number,velocity:number}>=[];
  let offset=14;
  while(offset<buffer.length){
    const length=buffer.readUInt32BE(offset+4);offset+=8;
    const end=offset+length; let tick=0;let running=0;
    const variable=()=>{let value=0,byte:number;do{byte=buffer[offset++];value=(value<<7)|(byte&127);}while(byte&128);return value;};
    while(offset<end){
      tick+=variable();let status=buffer[offset];
      if(status&128){offset++;running=status;}else status=running;
      if(status===0xff){offset++;const size=variable();offset+=size;continue;}
      if(status===0xf0||status===0xf7){const size=variable();offset+=size;continue;}
      const pitch=buffer[offset++];const kind=status&0xf0;
      const velocity=kind===0xc0||kind===0xd0?0:buffer[offset++];
      if(kind===0x80||kind===0x90)edges.push({tick,status,pitch,velocity});
    }
  }
  return edges;
}

describe.sequential('recording input correctness',()=>{
  let dir:string;let engine:ReturnType<typeof createMidiEngine>;
  const baseTime=new Date('2026-10-15T00:00:00Z');
  const at=(ms:number)=>vi.setSystemTime(baseTime.getTime()+ms);
  const input=()=>Input.instances.filter(i=>i.opened&&!i.closed).at(-1)!;
  const emit=(bytes:number[])=>input().emit('message',0,bytes);
  const stop=(id:string)=>engine.call('stop_continuous_recording',{recordingId:id,name:'take.mid'});
  const status=(id:string)=>engine.call('get_continuous_recording_status',{recordingId:id});
  const readSaved=async(result:any)=>{
    expect(result.ok).toBe(true);
    const item=JSON.parse(await fs.readFile(path.join(dir,'data','manifest.json'),'utf8')).items.find((i:any)=>i.id===result.fileId);
    return fs.readFile(path.resolve(dir,item.path));
  };
  beforeEach(async()=>{
    dir=await fs.mkdtemp(path.join(os.tmpdir(),'midi-recording-'));
    vi.stubEnv('MCP_MIDI_BASE_DIR',dir);vi.stubEnv('MCP_MIDI_MANIFEST','manifest.json');
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});vi.setSystemTime(baseTime);
    Input.instances=[];engine=createMidiEngine({midi:{Input}});
  });
  afterEach(async()=>{
    await engine.dispose().catch(()=>{});vi.useRealTimers();vi.unstubAllEnvs();await fs.rm(dir,{recursive:true,force:true});
  });

  it('writes release durations independently by channel and pairs repeated pitches FIFO',async()=>{
    const start=await engine.call('start_continuous_recording');
    emit([0x90,60,90]);at(100);emit([0x90,60,80]);emit([0x91,60,70]);
    at(300);emit([0x80,60,40]);at(400);emit([0x91,60,0]);at(600);emit([0x80,60,0]);
    const saved=await stop(start.recordingId);const bytes=await readSaved(saved);
    const edges=readNoteEdges(bytes);
    expect(edges.filter(e=>(e.status&15)===0).map(e=>[e.tick,e.velocity])).toEqual([[0,90],[96,80],[288,0],[576,0]]);
    expect(edges.filter(e=>(e.status&15)===1).map(e=>[e.tick,e.velocity])).toEqual([[96,70],[384,0]]);
    const decoded=await decodeSmfToJson(bytes);
    const otherChannel=decoded.tracks.flatMap(t=>t.events).find((e:any)=>e.type==='note'&&e.channel===1) as any;
    expect(otherChannel).toMatchObject({tick:96,duration:288,pitch:60});
    expect(decoded.tracks.flatMap(t=>t.events)).toContainEqual(expect.objectContaining({type:'meta.tempo',usPerQuarter:500000}));
    const state=await status(start.recordingId);
    expect(state).toMatchObject({fileId:saved.fileId,saveStatus:'saved',tempoBpm:120,currentDurationMs:600});
    at(5000);expect((await status(start.recordingId)).currentDurationMs).toBe(600);
    expect(await stop(start.recordingId)).toEqual(saved);
  });

  it('holds notes through silence timeout and closes held notes at manual stop',async()=>{
    const start=await engine.call('start_continuous_recording',{silenceTimeoutMs:1000,maxDurationMs:10000});
    emit([0x92,67,100]);await vi.advanceTimersByTimeAsync(1500);
    expect((await status(start.recordingId)).status).toBe('recording');
    const saved=await stop(start.recordingId);const bytes=await readSaved(saved);
    expect(readNoteEdges(bytes).map(e=>[e.tick,e.status&15,e.velocity])).toEqual([[0,2,100],[1440,2,0]]);
    expect(input()).toBeUndefined();
  });

  it('starts silence timing on release and exposes the auto-saved file',async()=>{
    const start=await engine.call('start_continuous_recording',{silenceTimeoutMs:1000,maxDurationMs:10000});
    emit([0x90,65,100]);await vi.advanceTimersByTimeAsync(1500);emit([0x80,65,0]);
    await vi.advanceTimersByTimeAsync(900);expect((await status(start.recordingId)).status).toBe('recording');
    await vi.advanceTimersByTimeAsync(100);
    const saved=await stop(start.recordingId);
    expect((await status(start.recordingId))).toMatchObject({status:'timeout_silence',reason:'silence_timeout',fileId:saved.fileId,saveStatus:'saved'});
    expect(readNoteEdges(await readSaved(saved)).map(e=>e.tick)).toEqual([0,1440]);
  });

  it('shares one result for max timeout, manual stop and dispose, closing held notes at max',async()=>{
    const start=await engine.call('start_continuous_recording',{maxDurationMs:1000,idleTimeoutMs:10000});
    emit([0x90,69,100]);vi.advanceTimersByTime(1000); // Leave auto-save I/O pending while stop/dispose race.
    const [saved]=await Promise.all([stop(start.recordingId),engine.dispose()]);
    expect(saved.reason).toBe('max_duration');
    expect(readNoteEdges(await readSaved(saved)).map(e=>e.tick)).toEqual([0,960]);
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'data','manifest.json'),'utf8'));
    expect(manifest.items).toHaveLength(1);expect(Input.instances.every(i=>i.closed)).toBe(true);
  });

  it('closes held notes at dispose and persists before dispose resolves',async()=>{
    const start=await engine.call('start_continuous_recording');emit([0x90,72,88]);at(750);
    await engine.dispose();
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'data','manifest.json'),'utf8'));
    expect(manifest.items).toHaveLength(1);
    const edges=readNoteEdges(await fs.readFile(path.resolve(dir,manifest.items[0].path)));
    expect(edges.map(e=>e.tick)).toEqual([0,720]);expect(start.ok).toBe(true);
  });

  it('blocks concurrent recording and device capture on an occupied input',async()=>{
    const start=await engine.call('start_continuous_recording');
    expect(await engine.call('start_continuous_recording')).toMatchObject({ok:false,error:{code:'DEVICE_BUSY'}});
    expect(await engine.call('start_device_single_capture')).toMatchObject({ok:false,error:{code:'DEVICE_BUSY'}});
    expect(Input.instances.filter(i=>i.opened)).toHaveLength(1);
    await stop(start.recordingId);
    const capture=await engine.call('start_device_single_capture');expect(capture.ok).toBe(true);
    expect(await engine.call('start_continuous_recording')).toMatchObject({ok:false,error:{code:'DEVICE_BUSY'}});
  });

  it('applies channel and note filters before tracking held notes',async()=>{
    const start=await engine.call('start_continuous_recording',{channelFilter:[2],eventTypeFilter:['cc'],silenceTimeoutMs:1000});
    emit([0x91,60,100]);emit([0x90,61,100]);
    expect((await status(start.recordingId)).status).toBe('waiting_for_input');
    emit([0xb1,64,127]);await vi.advanceTimersByTimeAsync(1000);
    const saved=await stop(start.recordingId);
    expect(readNoteEdges(await readSaved(saved))).toEqual([]);
    expect((await status(start.recordingId)).eventCount).toBe(1);
  });

  it('uses the start name for automatic saves and rejects unsafe names before opening input',async()=>{
    expect(await engine.call('start_continuous_recording',{name:'../unsafe.mid'})).toMatchObject({ok:false,error:{code:'INPUT_FORMAT_ERROR'}});
    expect(Input.instances).toHaveLength(0);
    const start=await engine.call('start_continuous_recording',{name:'automatic.mid',idleTimeoutMs:1000});
    await vi.advanceTimersByTimeAsync(1000);
    const saved=await stop(start.recordingId);
    expect(saved.name).toBe('automatic.mid');
    expect((await readSaved(saved)).subarray(0,4).toString()).toBe('MThd');
    const next=await engine.call('start_continuous_recording',{name:'automatic.mid',idleTimeoutMs:1000});
    await vi.advanceTimersByTimeAsync(1000);
    expect((await stop(next.recordingId)).name).toBe('automatic_1.mid');
  });

  it('reports save failure in status and rejects dispose with the same failure',async()=>{
    const start=await engine.call('start_continuous_recording');emit([0x90,60,100]);at(100);
    await fs.mkdir(path.join(dir,'data'),{recursive:true});await fs.writeFile(path.join(dir,'data','midi'),'blocked');
    expect(await stop(start.recordingId)).toMatchObject({ok:false});
    expect(await status(start.recordingId)).toMatchObject({saveStatus:'failed',saveError:{code:'SAVE_FAILED'},result:{ok:false}});
    await expect(engine.dispose()).rejects.toThrow();
  });
});
