import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeMidiName, saveMidiRecord } from '../src/fileStore.js';
import { readManifest } from '../src/storage.js';
const roots: string[] = [];
const env = { ...process.env };
afterEach(async () => { process.env = { ...env }; await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-store-')); roots.push(root); process.env.MIDI_TOOL_DATA_DIR = path.join(root, 'data'); delete process.env.MCP_MIDI_MANIFEST; return root; }
test('rejects escaping names', () => { for (const name of ['../x', '/tmp/x', 'a/b', 'a\\b', '.', '..', 'x\0y', 'C:evil']) expect(() => safeMidiName(name)).toThrow(); expect(safeMidiName('song')).toBe('song.mid'); });
test('concurrent name creation has one winner and overwrite preserves registration', async () => {
  const root = await setup();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => saveMidiRecord(new Uint8Array([1]), { name: 'song' })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const before = (await readManifest()).items[0];
  const replaced = await saveMidiRecord(new Uint8Array([2, 3]), { name: 'song', overwrite: true });
  expect(replaced.fileId).toBe(before.id); expect(replaced.id).toBe(before.id);
  expect((await readManifest()).items).toHaveLength(1);
  expect(await fs.readFile(path.resolve(root, replaced.path))).toEqual(Buffer.from([2, 3]));
  await expect(saveMidiRecord(new Uint8Array([4]), { name: 'song', fileId: 'different', overwrite: true })).rejects.toThrow('another fileId');
  await expect(saveMidiRecord(new Uint8Array([4]), { name: 'new', fileId: before.id, overwrite: true })).rejects.toThrow('Renaming');
});
test('refuses symlink destination', async () => {
  const root = await setup(); await fs.mkdir(path.join(root, 'data/midi'), { recursive: true });
  const outside = path.join(root, 'outside'); await fs.writeFile(outside, 'keep'); await fs.symlink(outside, path.join(root, 'data/midi/song.mid'));
  await expect(saveMidiRecord(new Uint8Array([4]), { name: 'song', overwrite: true })).rejects.toThrow('regular file');
  expect(await fs.readFile(outside, 'utf8')).toBe('keep');
});
