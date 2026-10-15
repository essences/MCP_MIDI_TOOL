import { afterEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeDataMigration, importDataMigration } from '../src/dataMigration.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-')); dirs.push(root);
  await fs.mkdir(path.join(root, 'data/midi'), { recursive: true });
  const manifest = path.join(root, 'data/manifest.old.json');
  const item = { id: 'preserve-me', name: 'song', path: 'data/midi/song.mid', bytes: 4, createdAt: '2020-01-01' };
  await fs.writeFile(path.join(root, item.path), Buffer.from('4d546864000000060000000101e04d54726b0000000400ff2f00', 'hex'));
  await fs.writeFile(manifest, JSON.stringify({ items: [item] }));
  return { root, manifest, item, options: { sourceBaseDir: root, sourceManifestPaths: [manifest], targetDataDir: path.join(root, 'destination') } };
}
test('dry-run diagnoses missing, conflicting and unregistered files without writes', async () => {
  const { root, manifest, item, options } = await setup();
  await fs.writeFile(manifest, JSON.stringify({ items: [item, { ...item, path: '/missing/song.mid' }] }));
  await fs.writeFile(path.join(root, 'data/midi/unregistered.mid'), 'extra');
  const report = await importDataMigration(options);
  expect(report.issues.map(issue => issue.kind)).toEqual(['missing', 'id-conflict']);
  expect(report.unregisteredFiles).toEqual([path.join(root, 'data/midi/unregistered.mid')]);
  await expect(fs.access(options.targetDataDir)).rejects.toThrow();
  expect((await fs.readdir(path.join(root, 'data/midi'))).length).toBe(2);
});
test('copy import preserves IDs and bytes, source remains, repeat ID conflicts', async () => {
  const { root, item, options } = await setup();
  const report = await importDataMigration({ ...options, dryRun: false });
  expect(report.importedIds).toEqual([item.id]);
  const target = JSON.parse(await fs.readFile(report.targetManifestPath, 'utf8'));
  const copied = await fs.readFile(path.resolve(root, target.items[0].path));
  expect(copied).toEqual(await fs.readFile(path.join(root, item.path)));
  expect(report.entries[0].sha256).toHaveLength(64);
  expect((await analyzeDataMigration(options)).issues[0].kind).toBe('id-conflict');
});
test('invalid SMF and same-name registrations are reported without copying', async () => {
  const { root, manifest, item, options } = await setup();
  await fs.writeFile(path.join(root, 'data/midi/bad.mid'), 'not midi');
  await fs.writeFile(manifest, JSON.stringify({ items: [item, { ...item, id: 'other', path: 'data/midi/bad.mid' }] }));
  const report = await analyzeDataMigration(options);
  expect(report.issues.map(issue => issue.kind)).toContain('invalid-smf');
  expect(report.issues.map(issue => issue.kind)).toContain('name-conflict');
  await expect(importDataMigration({ ...options, dryRun: false })).rejects.toThrow('Migration blocked');
  await expect(fs.access(options.targetDataDir)).rejects.toThrow();
});

test('failed import removes copies it created without touching sources', async () => {
  const { root, manifest, item, options } = await setup();
  const second = path.join(root, 'data/midi/second.mid');
  await fs.copyFile(path.join(root, item.path), second);
  await fs.writeFile(manifest, JSON.stringify({ items: [item, { ...item, id: 'second', name: 'second', path: 'data/midi/second.mid' }] }));
  const original = fs.readFile.bind(fs);
  let secondReads = 0;
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === second && ++secondReads === 2) throw new Error('simulated source read failure');
    return original(...args);
  }) as typeof fs.readFile);
  try { await expect(importDataMigration({ ...options, dryRun: false })).rejects.toThrow('simulated'); }
  finally { spy.mockRestore(); }
  expect(await fs.readdir(path.join(options.targetDataDir, 'midi'))).toEqual([]);
  await expect(fs.access(path.join(root, item.path))).resolves.toBeUndefined();
  await expect(fs.access(second)).resolves.toBeUndefined();
  await expect(fs.access(path.join(options.targetDataDir, 'manifest.json'))).rejects.toThrow();
});
