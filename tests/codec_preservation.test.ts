import {describe,it,expect} from 'vitest';
import {parseMidi,writeMidi,type MidiData} from 'midi-file';
import {encodeToSmfBinary} from '../src/jsonToSmf.js';
import {decodeSmfToJson} from '../src/smfToJson.js';
import {zSong} from '../src/jsonSchema.js';
const raw=(data:MidiData)=>new Uint8Array(writeMidi(data));
describe('raw SMF codec preservation',()=>{
 it('round-trips signed bend center/endpoints, expressive events and metadata without synthetic programs',async()=>{
  const song=zSong.parse({format:0,ppq:960,tracks:[{name:'演奏',channel:2,events:[
   {type:'meta.tempo',tick:0,usPerQuarter:500000},{type:'meta.tempo',tick:480,usPerQuarter:1000000},
   {type:'meta.timeSignature',tick:0,numerator:3,denominator:4},{type:'meta.keySignature',tick:0,sf:-3,mi:1},
   {type:'program',tick:0,program:17},{type:'program',tick:360,program:18},
   {type:'cc',tick:120,controller:64,value:127},{type:'cc',tick:720,controller:64,value:0},
   ...[-8192,0,8191,2048].map((value,index)=>({type:'pitchBend',tick:index*100,value})),
   {type:'aftertouch.channel',tick:240,pressure:77},{type:'aftertouch.poly',tick:300,pitch:60,pressure:88},
   {type:'meta.marker',tick:480,text:'転調'},{type:'note',tick:0,note:'C-1',velocity:91,duration:960}
  ]}]});
  const decoded=await decodeSmfToJson(encodeToSmfBinary(song));expect(decoded.format).toBe(0);expect(decoded.ppq).toBe(960);expect(decoded.tracks).toHaveLength(1);const events=decoded.tracks[0].events;
  expect(events.filter(e=>e.type==='pitchBend').map(e=>(e as any).value)).toEqual([-8192,0,8191,2048]);
  expect(events.filter(e=>e.type==='program')).toEqual([{type:'program',tick:0,channel:2,program:17},{type:'program',tick:360,channel:2,program:18}]);
  expect(events).toContainEqual({type:'aftertouch.channel',tick:240,channel:2,pressure:77});expect(events).toContainEqual({type:'aftertouch.poly',tick:300,channel:2,pitch:60,pressure:88});
  expect(events).toContainEqual({type:'note',tick:0,channel:2,pitch:0,note:'C-1',velocity:91,duration:960});expect(events).toContainEqual({type:'meta.marker',tick:480,text:'転調'});expect(events).toContainEqual({type:'meta.keySignature',tick:0,sf:-3,mi:1});expect(events).toContainEqual({type:'meta.timeSignature',tick:0,numerator:3,denominator:4});
  expect(events.filter(e=>e.type==='meta.trackName')).toHaveLength(1);const again=await decodeSmfToJson(encodeToSmfBinary(decoded));expect(again).toEqual(decoded);
 });
 it('keeps original tracks and pairs overlapping same-pitch notes FIFO per channel',async()=>{
  const bytes=raw({header:{format:1,numTracks:2,ticksPerBeat:480},tracks:[[
   {deltaTime:10,type:'setTempo',microsecondsPerBeat:600000},{deltaTime:0,type:'endOfTrack'}
  ],[
   {deltaTime:0,type:'noteOn',channel:3,noteNumber:60,velocity:90},
   {deltaTime:10,type:'noteOn',channel:3,noteNumber:60,velocity:70},
   {deltaTime:0,type:'noteOn',channel:4,noteNumber:60,velocity:80},
   {deltaTime:20,type:'noteOff',channel:3,noteNumber:60,velocity:0},
   {deltaTime:10,type:'noteOff',channel:4,noteNumber:60,velocity:0},
   {deltaTime:10,type:'noteOff',channel:3,noteNumber:60,velocity:0},
   {deltaTime:0,type:'endOfTrack'}
  ]]});
  const song=await decodeSmfToJson(bytes);expect(song.tracks).toHaveLength(2);expect(song.tracks[0].events).toEqual([{type:'meta.tempo',tick:10,usPerQuarter:600000}]);expect(song.tracks[1].channel).toBeUndefined();
  expect(song.tracks[1].events.map((e:any)=>[e.tick,e.channel,e.duration])).toEqual([[0,3,30],[10,3,40],[10,4,30]]);expect(song.tracks.flatMap(t=>t.events).filter(e=>e.type==='program')).toEqual([]);expect(await decodeSmfToJson(encodeToSmfBinary(song))).toEqual(song);
 });
 it('rejects SMPTE and asynchronous format2 rather than inventing PPQ',async()=>{
  await expect(decodeSmfToJson(raw({header:{format:2,numTracks:1,ticksPerBeat:480},tracks:[[{deltaTime:0,type:'endOfTrack'}]]}))).rejects.toThrow('format 2');
  await expect(decodeSmfToJson(raw({header:{format:0,numTracks:1,framesPerSecond:25,ticksPerFrame:40},tracks:[[{deltaTime:0,type:'endOfTrack'}]]}))).rejects.toThrow('SMPTE');
 });
 it('interprets raw center pitch bend and velocity-zero note releases exactly',async()=>{
  const song=await decodeSmfToJson(raw({header:{format:0,numTracks:1,ticksPerBeat:480},tracks:[[{deltaTime:0,type:'pitchBend',channel:0,value:0},{deltaTime:0,type:'noteOn',channel:0,noteNumber:60,velocity:100},{deltaTime:120,type:'noteOn',channel:0,noteNumber:60,velocity:0},{deltaTime:0,type:'endOfTrack'}]]}));expect(song.tracks[0].events).toContainEqual({type:'pitchBend',tick:0,channel:0,value:0});expect((song.tracks[0].events.find(e=>e.type==='note') as any).duration).toBe(120);
 });
});
