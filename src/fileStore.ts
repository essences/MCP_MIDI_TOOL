import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type MidiItem, readManifest, resolveBaseDir, resolveMidiDir, updateManifest, withDataWriteLock } from './storage.js';
export function safeMidiName(name: string): string {
  if (!name || !name.trim() || name === '.' || name === '..' || /[\\/\0]/.test(name) || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error('Invalid MIDI name: use a plain filename');
  return /\.midi?$/i.test(name) ? name : `${name}.mid`;
}
export interface SaveMidiRecordOptions { name: string; overwrite?: boolean; fileId?: string }
export async function saveMidiRecord(data: Uint8Array, options: SaveMidiRecordOptions, baseDir = resolveBaseDir()): Promise<MidiItem & { fileId: string }> {
  return withDataWriteLock(() => saveMidiRecordUnlocked(data, options, baseDir), baseDir);
}
/** Only call while holding withDataWriteLock for this base directory. */
export async function saveMidiRecordUnlocked(data: Uint8Array, options: SaveMidiRecordOptions, baseDir = resolveBaseDir()): Promise<MidiItem & { fileId: string }> {
  const name = safeMidiName(options.name);
    const manifest = await readManifest(baseDir);
    const byId = options.fileId ? manifest.items.find(item => item.id === options.fileId) : undefined;
    const named = manifest.items.filter(item => item.name === name);
    if (named.length > 1) throw new Error(`Ambiguous registered MIDI name: ${name}`);
    const existing = named[0];
    if (existing && options.fileId && existing.id !== options.fileId) throw new Error(`MIDI name belongs to another fileId: ${name}`);
    if (byId && byId.name !== name) throw new Error(`Renaming existing fileId is unsupported: ${byId.id}`);
    const midiDir = resolveMidiDir(baseDir);
    await fs.mkdir(midiDir, { recursive: true });
    if ((await fs.lstat(midiDir)).isSymbolicLink()) throw new Error('MIDI directory must not be a symlink');
    const destination = existing ? path.resolve(baseDir, existing.path) : path.join(midiDir, name);
    const relative = path.relative(midiDir, destination);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Registered MIDI path escapes MIDI directory');
    // Real directories prevent symlink ancestors from redirecting a write outside the data root.
    const realMidi = await fs.realpath(midiDir);
    const realParent = await fs.realpath(path.dirname(destination));
    if (realParent !== realMidi) throw new Error('MIDI destination must be directly inside MIDI directory');
    const aliases = manifest.items.filter(item => path.resolve(baseDir, item.path) === destination && item.id !== existing?.id);
    if (aliases.length) throw new Error('MIDI destination belongs to another fileId');
    let exists = false;
    try { const stat = await fs.lstat(destination); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MIDI destination is not a regular file'); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if ((exists || existing) && !options.overwrite) throw new Error(`MIDI file already exists: ${name}`);
    const item: MidiItem = { id: existing?.id ?? options.fileId ?? randomUUID(), name, path: path.relative(baseDir, destination), bytes: data.byteLength, createdAt: existing?.createdAt ?? new Date().toISOString() };
    const temp = `${destination}.${randomUUID()}.tmp`;
    const previousData = exists ? await fs.readFile(destination) : undefined;
    let replaced = false;
    let created = false;
    try {
      if (!exists) { await fs.writeFile(destination, data, { flag: 'wx' }); created = true; }
      else { await fs.writeFile(temp, data, { flag: 'wx' }); await fs.rename(temp, destination); replaced = true; }
      await updateManifest(current => {
        const conflict = current.items.find(entry => (entry.id === item.id || entry.name === item.name || path.resolve(baseDir, entry.path) === destination) && entry.id !== existing?.id);
        if (conflict) throw new Error(`Concurrent manifest conflict: ${conflict.id}`);
        const index = current.items.findIndex(entry => entry.id === item.id);
        if (index < 0) current.items.push(item); else current.items[index] = item;
      }, baseDir);
    } catch (error) {
      if (created) await fs.unlink(destination).catch(() => {});
      if (replaced && previousData) {
        await fs.writeFile(temp, previousData, { flag: 'wx' });
        await fs.rename(temp, destination);
      }
      throw error;
    }
    finally { await fs.unlink(temp).catch(() => {}); }
    return { ...item, fileId: item.id };
}
