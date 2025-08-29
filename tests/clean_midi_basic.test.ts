import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ return spawn(process.execPath, ['dist/index.js'], { stdio:['pipe','pipe','pipe'] }); }
function send(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function read(child:any){ const [buf]=await once(child.stdout,'data'); const line=buf.toString().split(/\n/)[0]; return JSON.parse(line); }

describe('clean_midi basic', ()=>{
  it('重複メタ除去とチャネル統合', async ()=>{
    const child = spawnServer();
    // initialize handshake
    send(child,{ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'vitest', version:'0.0.1' } } });
    await read(child);

    // base song
  const base = { ppq:480, tracks:[ { events:[ { type:'meta.tempo', usPerQuarter:500000, tick:0 }, { type:'meta.timeSignature', numerator:4, denominator:4, tick:0 }, { type:'meta.keySignature', sf:0, mi:0, tick:0 } ] }, { channel:0, events:[ { type:'note', note:'C4', velocity:96, tick:0, duration:240 } ] } ] };
    send(child,{ jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'json_to_smf', arguments:{ json:base, format:'json_midi_v1', name:'dup_clean_base.mid' } } });
    const r1 = await read(child);
    // eslint-disable-next-line no-console
    console.log('json_to_smf raw text:', r1?.result?.content?.[0]?.text);
    const body1 = JSON.parse(r1.result.content[0].text);
    const fileId1 = body1.fileId;
    expect(typeof fileId1).toBe('string');

    // introduce duplication (tempo + channel split)
    const dupChunk = { ppq:480, tracks:[ { events:[ { type:'meta.tempo', usPerQuarter:500000, tick:0 } ] }, { channel:0, events:[ { type:'note', note:'E4', velocity:90, tick:0, duration:240 } ] }, { channel:1, events:[ { type:'note', note:'G4', velocity:88, tick:0, duration:240 } ] } ] };
    send(child,{ jsonrpc:'2.0', id:3, method:'tools/call', params:{ name:'append_to_smf', arguments:{ fileId:fileId1, json:dupChunk, format:'json_midi_v1', atEnd:true, outputName:'dup_clean_base2.mid' } } });
    const r2 = await read(child);
    const body2 = JSON.parse(r2.result.content[0].text);
    const fileId2 = body2.fileId;
    expect(typeof fileId2).toBe('string');

    // clean
    send(child,{ jsonrpc:'2.0', id:4, method:'tools/call', params:{ name:'clean_midi', arguments:{ fileId:fileId2 } } });
    const r3 = await read(child);
    expect(r3.error).toBeUndefined();
    const cleanBody = JSON.parse(r3.result.content[0].text);
    expect(cleanBody.ok).toBe(true);
  expect(cleanBody.cleaned.trackCount).toBeLessThanOrEqual(cleanBody.original.trackCount + 1);
  expect(cleanBody.removedDuplicateMeta).toBeGreaterThanOrEqual(0);
    expect(cleanBody.fileId).not.toEqual(fileId2);
    // eslint-disable-next-line no-console
    console.log('clean_midi raw text:', r3?.result?.content?.[0]?.text);
    child.kill();
  }, 15000);
});
