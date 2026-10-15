import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveSongAsSmf,loadSmfAsJson,insertControllerRanges,insertSustainRanges,exportMidiFile,analyzeSmfDryRun} from '../src/directApi.js';
const song={format:1,ppq:480,tracks:[{channel:2,events:[
  {type:'meta.tempo',tick:0,usPerQuarter:500000},
  {type:'meta.tempo',tick:480,usPerQuarter:1000000},
  {type:'note',tick:0,pitch:60,velocity:100,duration:960,channel:2},
  {type:'cc',tick:240,controller:1,value:50,channel:2},
  {type:'cc',tick:240,controller:64,value:50,channel:2},
]}]};
describe.sequential('direct convenience API delegates to common engine',()=>{
 let dir:string;
 beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'midi-direct-'));vi.stubEnv('MIDI_TOOL_DATA_DIR',path.join(dir,'data'));vi.stubEnv('MCP_MIDI_MANIFEST','manifest.json');});
 afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(dir,{recursive:true,force:true});});
 it('preserves IDs on overwrite, throws coded errors, and integrates tempo changes',async()=>{
  const first=await saveSongAsSmf({json:song,format:'json_midi_v1',name:'direct.mid'});
  await expect(saveSongAsSmf({json:song,format:'json_midi_v1',name:'direct.mid'})).rejects.toMatchObject({code:'ALREADY_EXISTS'});
  expect((await saveSongAsSmf({json:song,format:'json_midi_v1',name:'direct.mid',overwrite:true})).fileId).toBe(first.fileId);
  const analysis=await analyzeSmfDryRun(first.fileId);expect(analysis.totalDurationMs).toBe(1500);expect(analysis.scheduledEvents).toBe(4);
  const loaded=await loadSmfAsJson(first.fileId);expect(loaded.fileId).toBe(first.fileId);expect(loaded.trackCount).toBeGreaterThan(0);
  await expect(loadSmfAsJson('missing')).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('uses documented additive generic CC semantics and replacement sustain semantics',async()=>{
  const saved=await saveSongAsSmf({json:song,name:'controls.mid',format:'json_midi_v1'});
  const inserted=await insertControllerRanges({fileId:saved.fileId,controller:1,ranges:[{startTick:0,endTick:480,channel:3,valueOn:100,valueOff:0}],outputName:'copy.mid'});
  expect(inserted.fileId).not.toBe(saved.fileId);expect(inserted.rangeCount).toBe(1);
  const copied=await loadSmfAsJson(inserted.fileId);
  expect(copied.json.tracks.flatMap((t:any)=>t.events)).toContainEqual(expect.objectContaining({type:'cc',controller:1,tick:240,value:50,channel:2}));
  await insertSustainRanges({fileId:saved.fileId,ranges:[{startTick:0,endTick:480,channel:3,valueOn:127,valueOff:0}]});
  const changed=await loadSmfAsJson(saved.fileId);
  expect(changed.json.tracks.flatMap((t:any)=>t.events).filter((e:any)=>e.type==='cc'&&e.controller===64).map((e:any)=>e.tick)).toEqual([0,480]);
 });
 it('exports through safe names and rejects overwrite without explicit authorization',async()=>{
  const saved=await saveSongAsSmf({json:song,name:'export.mid',format:'json_midi_v1'});
  const exported=await exportMidiFile(saved.fileId,'copy.mid');expect(exported.exportedPath).toBe(exported.exportPath);
  expect((await fs.readFile(path.join(dir,exported.exportedPath))).subarray(0,4).toString()).toBe('MThd');
  await expect(exportMidiFile(saved.fileId,'../escape.mid')).rejects.toMatchObject({code:'INPUT_FORMAT_ERROR'});
  await expect(exportMidiFile(saved.fileId,'copy.mid')).rejects.toHaveProperty('code');
 });
});
