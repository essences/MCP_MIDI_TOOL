import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnMcpServer } from './helpers/mcpServer';

describe('ready payload manifest threshold flag', () => {
  it('sets manifestItemsThresholdExceeded when item count >= threshold', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'mcp-midi-threshold-'));
    const manifestName = 'manifest.shared.json';
    const threshold = 50; // 下げた閾値でテスト高速化
    const items = Array.from({ length: threshold + 1 }).map((_, i) => ({
      id: `id-${i}`,
      name: `f${i}.mid`,
      path: `data/midi/f${i}.mid`,
      bytes: 10 + i,
      createdAt: new Date().toISOString()
    }));
    // data ディレクトリとマニフェスト作成
    const dataDir = path.join(base, 'data');
    const fs = await import('node:fs');
    fs.mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, manifestName), JSON.stringify({ items }, null, 2), 'utf8');

    const server = await spawnMcpServer(6000, {
      MCP_MIDI_BASE_DIR: base,
      MCP_MIDI_MANIFEST: manifestName,
      MCP_MIDI_MANIFEST_THRESHOLD: String(threshold),
      MCP_MIDI_EMIT_READY: '1'
    });
    expect(server.ready).toBe(true);
    expect(server.readyPayload).toBeDefined();
    expect(server.readyPayload.manifestItemsThresholdExceeded).toBe(true);
    expect(server.readyPayload.manifestThreshold).toBe(threshold);
    expect(server.readyPayload.warmup?.manifest?.items).toBe(threshold + 1);
    await server.shutdown();
  });
});
