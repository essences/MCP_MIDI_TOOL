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

export function resolveBaseDir(): string {
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

// シンプルなインメモリキャッシュ（初回遅延/頻回読み防止）
let manifestCache: { base: string; data: Manifest; mtimeMs: number } | null = null;
const cacheDisabled = () => process.env.MCP_MIDI_MANIFEST_NOCACHE === '1';

export async function readManifest(baseDir = resolveBaseDir()): Promise<Manifest> {
  const manifestPath = resolveManifestPath(baseDir);
  if (!cacheDisabled()) {
    // キャッシュ命中条件: baseDir一致 & ファイルのmtimeが変化していない
    try {
      const stat = await fs.stat(manifestPath);
      if (manifestCache && manifestCache.base === baseDir && manifestCache.mtimeMs === stat.mtimeMs) {
        return manifestCache.data;
      }
    } catch {
      if (manifestCache && manifestCache.base === baseDir) return manifestCache.data; // ファイル消失時は旧キャッシュ
    }
  }
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const m = JSON.parse(raw);
    const data: Manifest = (!m || typeof m !== 'object' || !Array.isArray(m.items)) ? { items: [] } : m as Manifest;
    if (!cacheDisabled()) {
      try {
        const stat = await fs.stat(manifestPath);
        manifestCache = { base: baseDir, data, mtimeMs: stat.mtimeMs };
      } catch { /* ignore */ }
    }
    return data;
  } catch {
    const data: Manifest = { items: [] };
    if (!cacheDisabled()) manifestCache = { base: baseDir, data, mtimeMs: 0 };
    return data;
  }
}

export async function writeManifest(manifest: Manifest, baseDir = resolveBaseDir()) {
  const manifestPath = resolveManifestPath(baseDir);
  await ensureDir(resolveDataDir(baseDir));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  // 書き込み後キャッシュ無効化（次回 read で再ロード）
  if (manifestCache && manifestCache.base === baseDir) manifestCache = null;
}

export async function appendItem(item: MidiItem, baseDir = resolveBaseDir()) {
  const manifest = await readManifest(baseDir);
  manifest.items.push(item);
  await writeManifest(manifest, baseDir); // writeManifest側でキャッシュ破棄
}

export async function getItemById(fileId: string, baseDir = resolveBaseDir()): Promise<MidiItem | undefined> {
  const manifest = await readManifest(baseDir);
  return manifest.items.find(i => i.id === fileId);
}
