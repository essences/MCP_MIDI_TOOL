import { promises as fs } from "node:fs";
import path from "node:path";

export type MidiItem = {
  id: string;
  name: string;
  path: string; // relative to baseDir
  bytes: number;
  createdAt: string; // ISO
};

export type Manifest = { items: MidiItem[] };

export function resolveDataDir(baseDir = process.cwd()) {
  return path.resolve(baseDir, "data");
}

export function resolveMidiDir(baseDir = process.cwd()) {
  return path.resolve(resolveDataDir(baseDir), "midi");
}

export function resolveExportDir(baseDir = process.cwd()) {
  return path.resolve(resolveDataDir(baseDir), "export");
}

export function resolveManifestPath(baseDir = process.cwd()) {
  return path.resolve(resolveDataDir(baseDir), "manifest.json");
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readManifest(baseDir = process.cwd()): Promise<Manifest> {
  const manifestPath = resolveManifestPath(baseDir);
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object" || !Array.isArray(m.items)) return { items: [] };
    return m as Manifest;
  } catch {
    return { items: [] };
  }
}

export async function writeManifest(manifest: Manifest, baseDir = process.cwd()) {
  const manifestPath = resolveManifestPath(baseDir);
  await ensureDir(resolveDataDir(baseDir));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

export async function appendItem(item: MidiItem, baseDir = process.cwd()) {
  const manifest = await readManifest(baseDir);
  manifest.items.push(item);
  await writeManifest(manifest, baseDir);
}

export async function getItemById(fileId: string, baseDir = process.cwd()): Promise<MidiItem | undefined> {
  const manifest = await readManifest(baseDir);
  return manifest.items.find(i => i.id === fileId);
}
