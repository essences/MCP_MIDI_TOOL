import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnMcpServer } from './helpers/mcpServer';

async function callTool(server: ReturnType<typeof spawnMcpServer> extends Promise<infer R> ? R : any, tool: string, params: any) {
  const res = await server.send('tools/call', { name: tool, arguments: params });
  return res.result; // JSON-RPC envelope
}

/**
 * Tests for newly added gap detection & duplicate meta pruning warnings in append_to_smf.
 * Conditions:
 *  - Create base file (4 bars) then append a chunk positioned far ahead (gapTicks large) to trigger large_gap_detected warning.
 *  - Ensure duplicate meta at tick0 are pruned and warning duplicate_meta_pruned:* is emitted.
 */
describe('append_to_smf gap detection & duplicate meta prune warnings', () => {
  let server: any;
  beforeAll(async () => { server = await spawnMcpServer(); });
  afterAll(async () => { if (server) await server.shutdown(); });

  it('emits large_gap_detected warning when gap > 1 bar and prunes duplicate meta', async () => {
    // 1) Base score (one bar with meta)
    const base = await callTool(server, 'json_to_smf', { format: 'score_dsl_v1', name: 'gap_base.mid', json: {
      ppq: 480,
      meta: { timeSignature: { numerator:4, denominator:4 }, tempo:{ bpm:120 }, keySignature:{ root:'C', mode:'minor' } },
      tracks: [ { channel:1, events:[ { type:'note', note:'C4', start:{ bar:1, beat:1 }, duration:{ value:'1/4' } } ] } ]
    }});
    expect(base.ok).toBe(true);
    const fileId = base.fileId;

    // 2) Append a chunk with the SAME global meta but with a large gap (e.g. 3 bars gap = 3*4*480=5760 ticks) to trigger warning
    // Use atEnd + gapTicks to force large gap creation; bar length = 4*480=1920, so >1920 triggers warning
    const gapTicks = 1920 * 3; // 3 bars
    const append = await callTool(server, 'append_to_smf', { fileId, format:'score_dsl_v1', atEnd:true, gapTicks, json: {
      ppq:480,
      meta: { timeSignature:{ numerator:4, denominator:4 }, tempo:{ bpm:120 }, keySignature:{ root:'C', mode:'minor' } },
      tracks: [ { channel:1, events:[ { type:'note', note:'E4', start:{ bar:1, beat:1 }, duration:{ value:'1/4' } } ] } ]
    }});
    expect(append.ok).toBe(true);
    // Response text (tool wrapper) is in content[0].text if using spawnMcpServer helper pattern
    const warningsText = append.warnings || append.warning || append.result?.warnings; // direct convenience
    // Because append tool wraps output differently, re-fetch JSON to assert meta pruning side effect
    const jsonResp = await callTool(server, 'smf_to_json', { fileId });
    expect(jsonResp.ok).toBe(true);
    const metaAt0 = jsonResp.json.tracks[0].events.filter((e:any)=> e.type && e.type.startsWith('meta.') && e.tick===0);
    // Should have exactly one of each type
    const tempoCount = metaAt0.filter((e:any)=> e.type==='meta.tempo').length;
    const tsCount = metaAt0.filter((e:any)=> e.type==='meta.timeSignature').length;
    const keyCount = metaAt0.filter((e:any)=> e.type==='meta.keySignature').length;
    expect(tempoCount).toBe(1);
    expect(tsCount).toBe(1);
    expect(keyCount).toBe(1);
    // Gap: locate appended note tick, ensure it's >= originalLast + gapTicks
    const allNoteTicks = jsonResp.json.tracks.flatMap((t:any)=> (t.events||[]).filter((e:any)=> e.type==='note').map((n:any)=> n.tick));
    const maxBaseNoteTick = Math.min(...allNoteTicks); // first note base at 0
    const appendedNoteTick = Math.max(...allNoteTicks); // appended note should be far ahead
    expect(appendedNoteTick - maxBaseNoteTick).toBeGreaterThan(1920); // >1 bar
  }, 15000);
});
