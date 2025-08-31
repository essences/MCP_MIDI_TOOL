import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnMcpServer } from './helpers/mcpServer';

async function callTool(server: ReturnType<typeof spawnMcpServer> extends Promise<infer R> ? R : any, tool: string, params: any) {
  const res = await server.send('tools/call', { name: tool, arguments: params });
  return res.result; // server returns JSON-RPC envelope
}

describe('append_to_smf global meta guard', () => {
  let server: any;
  beforeAll(async () => { server = await spawnMcpServer(); });
  afterAll(async () => { if (server) await server.shutdown(); });

  it('deduplicates identical global meta when appending score_dsl chunk', async () => {
    const baseResp = await callTool(server, 'json_to_smf', { format:'score_dsl_v1', name:'meta_base.mid', json: {
      ppq:480,
      meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'C',mode:'minor'}, tempo:{bpm:120} },
      tracks:[ { channel:1, events:[ { type:'note', note:'C4', start:{bar:1,beat:1}, duration:{ value:'1/4'} } ] } ]
    }});
    expect(baseResp.ok).toBe(true);
    const fileId = baseResp.fileId;
    const appendResp = await callTool(server, 'append_to_smf', { fileId, format:'score_dsl_v1', atEnd:true, json:{
      ppq:480,
      meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'C',mode:'minor'}, tempo:{bpm:120} },
      tracks:[ { channel:1, events:[ { type:'note', note:'E4', start:{bar:1,beat:1}, duration:{ value:'1/4'} } ] } ]
    }});
    expect(appendResp.ok).toBe(true);
    const jsonResp = await callTool(server, 'smf_to_json', { fileId: appendResp.fileId });
    const metaEvents = jsonResp.json.tracks[0].events.filter((e:any)=> e.type?.startsWith('meta.'));
    const keySigs = metaEvents.filter((e:any)=> e.type==='meta.keySignature');
    expect(keySigs.length).toBe(1);
  });

  it('ignores differing keySignature without allowKeyChange', async () => {
    const baseResp = await callTool(server, 'json_to_smf', { format:'score_dsl_v1', name:'meta_key_guard.mid', json: {
      ppq:480,
      meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'C',mode:'minor'}, tempo:{bpm:120} },
      tracks:[ { channel:1, events:[ { type:'note', note:'C4', start:{bar:1,beat:1}, duration:{ value:'1/4'} } ] } ]
    }});
    expect(baseResp.ok).toBe(true);
    const fileId = baseResp.fileId;
    const appendResp = await callTool(server, 'append_to_smf', { fileId, format:'score_dsl_v1', atEnd:true, json:{
      ppq:480,
      meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'Eb',mode:'minor'}, tempo:{bpm:120} },
      tracks:[ { channel:1, events:[ { type:'note', note:'E4', start:{bar:1,beat:1}, duration:{ value:'1/4'} } ] } ]
    }});
    expect(appendResp.ok).toBe(true);
    const jsonResp = await callTool(server, 'smf_to_json', { fileId: appendResp.fileId });
    const keySigs = jsonResp.json.tracks[0].events.filter((e:any)=> e.type==='meta.keySignature');
    expect(keySigs.length).toBe(1);
    expect(keySigs[0].sf).toBe(0);
  });

  it('allows differing keySignature when allowKeyChange & keepGlobalMeta are true', async () => {
    const baseResp = await callTool(server, 'json_to_smf', { format:'score_dsl_v1', name:'meta_key_change.mid', json: {
      ppq:480,
      meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'C',mode:'minor'}, tempo:{bpm:120} },
      tracks:[ { channel:1, events:[ { type:'note', note:'C4', start:{bar:1,beat:1}, duration:{ value:'1/4'} } ] } ]
    }});
    expect(baseResp.ok).toBe(true);
    const fileId = baseResp.fileId;
    const appendResp = await callTool(server, 'append_to_smf', { fileId, format:'score_dsl_v1', atEnd:true, allowKeyChange:true, keepGlobalMeta:true, json:{
      ppq:480,
      meta:{ timeSignature:{numerator:4,denominator:4}, keySignature:{root:'Eb',mode:'minor'}, tempo:{bpm:120} },
      tracks:[ { channel:1, events:[ { type:'note', note:'E4', start:{bar:1,beat:1}, duration:{ value:'1/4'} } ] } ]
    }});
    expect(appendResp.ok).toBe(true);
    const jsonResp = await callTool(server, 'smf_to_json', { fileId: appendResp.fileId });
    const keySigs = jsonResp.json.tracks[0].events.filter((e:any)=> e.type==='meta.keySignature');
    expect(keySigs.length).toBe(2);
  });
});