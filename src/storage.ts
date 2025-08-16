import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MidiItem = {
  id: string;
  name: string;
  path: string; // relative to baseDir
  bytes: number;
  createdAt: string; // ISO
};

export type Manifest = { items: MidiItem[] };

function resolveBaseDir(): string {
  // 優先: 環境変数で明示されたベースディレクトリ
  const envBase = process.env.MCP_MIDI_BASE_DIR;
  if (envBase && envBase.trim().length > 0) return path.resolve(envBase);
  // フォールバック: 本モジュール(dist/storage.js)の親ディレクトリ=プロジェクトルート想定
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(distDir, "..");
  return rootDir;
}

export function resolveDataDir(baseDir = resolveBaseDir()) {
  return path.resolve(baseDir, "data");
}

export function resolveMidiDir(baseDir = resolveBaseDir()) {
  return path.resolve(resolveDataDir(baseDir), "midi");
}

export function resolveExportDir(baseDir = resolveBaseDir()) {
  return path.resolve(resolveDataDir(baseDir), "export");
}

export function resolveManifestPath(baseDir = resolveBaseDir()) {
  const file = process.env.MCP_MIDI_MANIFEST || `manifest.${process.pid}.json`;
  return path.resolve(resolveDataDir(baseDir), file);
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readManifest(baseDir = resolveBaseDir()): Promise<Manifest> {
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

export async function writeManifest(manifest: Manifest, baseDir = resolveBaseDir()) {
  const manifestPath = resolveManifestPath(baseDir);
  await ensureDir(resolveDataDir(baseDir));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

export async function appendItem(item: MidiItem, baseDir = resolveBaseDir()) {
  const manifest = await readManifest(baseDir);
  manifest.items.push(item);
  await writeManifest(manifest, baseDir);
}

export async function getItemById(fileId: string, baseDir = resolveBaseDir()): Promise<MidiItem | undefined> {
  const manifest = await readManifest(baseDir);
  return manifest.items.find(i => i.id === fileId);
}
