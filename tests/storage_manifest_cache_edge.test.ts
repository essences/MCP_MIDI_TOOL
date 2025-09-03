import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * 目的:
 *  1. 高速連続 append/write で mtime が同一 ms でも整合性が崩れないこと
 *  2. stat 失敗時にキャッシュされた内容を返し、再生成で復旧できること
 */
describe('storage manifest cache edge cases', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'mcp-midi-cache-edge-'));
  const manifestName = `edge-manifest.${process.pid}.${Date.now()}.json`;
  const prevEnv: Record<string, string | undefined> = {
    MCP_MIDI_BASE_DIR: process.env.MCP_MIDI_BASE_DIR,
    MCP_MIDI_MANIFEST: process.env.MCP_MIDI_MANIFEST,
    MCP_MIDI_MANIFEST_NOCACHE: process.env.MCP_MIDI_MANIFEST_NOCACHE,
  };

  beforeAll(() => {
    process.env.MCP_MIDI_BASE_DIR = base;
    process.env.MCP_MIDI_MANIFEST = manifestName;
    delete process.env.MCP_MIDI_MANIFEST_NOCACHE; // キャッシュ有効
  });

  afterAll(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
    Object.entries(prevEnv).forEach(([k,v]) => {
      if (v === undefined) delete (process.env as any)[k]; else process.env[k] = v;
    });
  });

  it('rapid consecutive appendItem calls do not drop items (mtime collision resilience)', async () => {
    const storage = await import('../src/storage.ts');
    const { appendItem, readManifest } = storage as any;

    const count = 5;
    // ほぼ同タイミングで逐次 append（シリアルだが速く）
    for (let i = 0; i < count; i++) {
      await appendItem({
        id: randomUUID(),
        name: `f${i}.mid`,
        path: `data/midi/f${i}.mid`,
        bytes: 10 + i,
        createdAt: new Date().toISOString()
      });
    }

    const m = await readManifest();
    expect(m.items.length).toBe(count);
    const ids = new Set(m.items.map((it: any) => it.id));
    expect(ids.size).toBe(count); // 重複なし
  });

  it('falls back to cached data when manifest file disappears, then rebuilds on new write', async () => {
    const storage = await import('../src/storage.ts');
    const { readManifest, writeManifest, resolveManifestPath, resolveBaseDir } = storage as any;

    // 初期書き込み
    await writeManifest({ items: [ { id: 'A', name: 'a.mid', path: 'data/midi/a.mid', bytes: 1, createdAt: new Date().toISOString() } ] });
    const first = await readManifest();
    expect(first.items.length).toBe(1);

    // ファイルを削除( rename → 別名退避 )
    const manifestPath = resolveManifestPath(resolveBaseDir());
    const backupPath = manifestPath + '.bak';
    renameSync(manifestPath, backupPath);

    // 削除状態で read → キャッシュ品が返る（items=1 を維持）
    const cached = await readManifest();
    expect(cached.items.length).toBe(1);

    // 新しいマニフェストを再生成 (空) → writeManifestでキャッシュ無効化
    await writeManifest({ items: [] });
    const after = await readManifest();
    expect(after.items.length).toBe(0);

    // 後片付け: 退避ファイル削除
    try { await fsp.unlink(backupPath); } catch {}
  });
});
