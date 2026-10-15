import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendItem, readManifest, resolveBaseDir, resolveDataDir, resolveManifestPath } from '../src/storage.js';
const dirs: string[] = [];
const old = { ...process.env };
afterEach(async () => { process.env = { ...old }; await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-v2-')); dirs.push(root); process.env.MIDI_TOOL_DATA_DIR = path.join(root, 'custom'); delete process.env.MCP_MIDI_MANIFEST; return root; }
test('actual root, stable manifest, deleted manifests and alternate filenames', async () => {
  const root = await setup();
  expect(resolveBaseDir()).toBe(root); expect(resolveDataDir()).toBe(path.join(root, 'custom')); expect(resolveManifestPath()).toBe(path.join(root, 'custom', 'manifest.json'));
  await appendItem({ id: 'a', name: 'a', path: 'custom/a.mid', bytes: 0, createdAt: '' });
  expect((await readManifest()).items).toHaveLength(1);
  process.env.MCP_MIDI_MANIFEST = 'other.json'; expect((await readManifest()).items).toHaveLength(0);
  delete process.env.MCP_MIDI_MANIFEST;
  await fs.unlink(resolveManifestPath()); expect((await readManifest()).items).toHaveLength(0);
});
test('separate processes append without lost registrations', async () => {
  await setup();
  await Promise.all(Array.from({ length: 8 }, (_, n) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {appendItem} from './src/storage.ts'; await appendItem({id:'${n}',name:'x',path:'x',bytes:0,createdAt:''});`], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  expect(new Set((await readManifest()).items.map(item => item.id)).size).toBe(8);
});
test('malformed manifest fails without replacement and dead owner lock recovers', async () => {
  await setup();
  await fs.mkdir(resolveDataDir(), { recursive: true });
  await fs.writeFile(resolveManifestPath(), '{broken');
  await expect(appendItem({ id: 'a', name: 'a', path: 'a', bytes: 0, createdAt: '' })).rejects.toThrow();
  expect(await fs.readFile(resolveManifestPath(), 'utf8')).toBe('{broken');
  await fs.unlink(resolveManifestPath());
  const lock = `${resolveManifestPath()}.lock`;
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647 }));
  await fs.utimes(lock, new Date(0), new Date(0));
  await appendItem({ id: 'a', name: 'a', path: 'a', bytes: 0, createdAt: '' });
  expect((await readManifest()).items).toHaveLength(1);
});
test('default fixed manifest shares fileIds across processes without new data-root environment', async () => {
  const root = await setup(); delete process.env.MIDI_TOOL_DATA_DIR; delete process.env.MCP_MIDI_MANIFEST; process.env.MCP_MIDI_BASE_DIR = root;
  expect(resolveManifestPath()).toBe(path.join(root, 'data', 'manifest.json'));
  const run = (source: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  await run("import {appendItem} from './src/storage.ts'; await appendItem({id:'shared-default',name:'song.mid',path:'data/midi/song.mid',bytes:0,createdAt:''});");
  expect(JSON.parse(await run("import {getItemById} from './src/storage.ts'; console.log(JSON.stringify(await getItemById('shared-default')));"))).toMatchObject({ id: 'shared-default' });
  await fs.writeFile(path.join(root, 'data/manifest.12345.json'), JSON.stringify({ items: [{ id: 'legacy-only' }] }));
  expect((await readManifest()).items.map(item => item.id)).toEqual(['shared-default']);
});
