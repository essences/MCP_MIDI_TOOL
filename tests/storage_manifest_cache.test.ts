import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// NOTE: storage.ts は内部にインメモリキャッシュを保持するため、
// 同一プロセス内で参照が同一オブジェクトかどうかを調べてキャッシュ動作を検証する。

describe('storage manifest cache behavior', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'mcp-midi-cache-test-'));
  const manifestName = `manifest.${process.pid}.${Date.now()}.json`;
  const prevEnv: Record<string, string | undefined> = {
    MCP_MIDI_BASE_DIR: process.env.MCP_MIDI_BASE_DIR,
    MCP_MIDI_MANIFEST: process.env.MCP_MIDI_MANIFEST,
    MCP_MIDI_MANIFEST_NOCACHE: process.env.MCP_MIDI_MANIFEST_NOCACHE,
  };

  beforeAll(() => {
    process.env.MCP_MIDI_BASE_DIR = base; // テスト専用ベース
    process.env.MCP_MIDI_MANIFEST = manifestName;
    delete process.env.MCP_MIDI_MANIFEST_NOCACHE; // キャッシュ有効状態
  });

  afterAll(() => {
    // 後片付け（失敗しても無視）
    try { rmSync(base, { recursive: true, force: true }); } catch {}
    Object.entries(prevEnv).forEach(([k,v]) => {
      if (v === undefined) delete (process.env as any)[k]; else process.env[k] = v;
    });
  });

  it('caches manifest object between reads and invalidates after write', async () => {
    // 動的 import で最新ロジック参照
    const storage = await import('../src/storage.ts');
    const { readManifest, writeManifest } = storage as any;

    const m1 = await readManifest();
    expect(Array.isArray(m1.items)).toBe(true);
    expect(m1.items.length).toBe(0);

    const m2 = await readManifest();
    // キャッシュ: 参照同一
    expect(m2).toBe(m1);

    const newItem = { id: randomUUID(), name: 'a.mid', path: 'data/midi/a.mid', bytes: 10, createdAt: new Date().toISOString() };
    const updated = { items: [newItem] };
    await writeManifest(updated);

    const m3 = await readManifest();
    expect(m3.items.length).toBe(1);
    // write 後は新しいオブジェクト参照になる（無効化確認）
    expect(m3).not.toBe(m1);

    const m4 = await readManifest();
    // 直後は再びキャッシュヒットで同一参照
    expect(m4).toBe(m3);
  });

  it('disables cache when MCP_MIDI_MANIFEST_NOCACHE=1', async () => {
    process.env.MCP_MIDI_MANIFEST_NOCACHE = '1';
    const storage = await import('../src/storage.ts');
    const { readManifest } = storage as any;

    const a = await readManifest();
    const b = await readManifest();
    // キャッシュ無効: 毎回新インスタンス（参照が異なる）
    expect(b).not.toBe(a);
    // items 内容は同じ長さ
    expect(Array.isArray(a.items) && Array.isArray(b.items)).toBe(true);
    expect(a.items.length).toBe(b.items.length);
  });
});
