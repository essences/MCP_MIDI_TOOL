import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export function resolveBaseDir() {
    // Keep item paths relative to a stable base, including arbitrarily named data roots.
    if (process.env.MIDI_TOOL_DATA_DIR?.trim())
        return path.dirname(path.resolve(process.env.MIDI_TOOL_DATA_DIR));
    return path.resolve(process.env.MCP_MIDI_BASE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
export function resolveDataDir(baseDir = resolveBaseDir()) {
    const configured = process.env.MIDI_TOOL_DATA_DIR?.trim();
    return configured && path.resolve(baseDir) === resolveBaseDir() ? path.resolve(configured) : path.resolve(baseDir, 'data');
}
export function resolveMidiDir(baseDir = resolveBaseDir()) { return path.join(resolveDataDir(baseDir), 'midi'); }
export function resolveExportDir(baseDir = resolveBaseDir()) { return path.join(resolveDataDir(baseDir), 'export'); }
// PID manifests are never adopted implicitly; select them explicitly for migration.
export function resolveManifestPath(baseDir = resolveBaseDir()) {
    return path.resolve(resolveDataDir(baseDir), process.env.MCP_MIDI_MANIFEST || 'manifest.json');
}
export async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
// Read fresh: atomic replacement makes reads inexpensive and avoids stale/deleted-file caches.
export async function readManifest(baseDir = resolveBaseDir()) {
    try {
        const value = JSON.parse(await fs.readFile(resolveManifestPath(baseDir), 'utf8'));
        if (!value || !Array.isArray(value.items))
            throw new Error('Invalid MIDI manifest: expected items array');
        return value;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { items: [] };
        throw error;
    }
}
async function withLock(manifestPath, fn) {
    await ensureDir(path.dirname(manifestPath));
    const lock = `${manifestPath}.lock`;
    const deadline = Date.now() + 10000;
    // Atomic exclusive file creation. A dead PID is recoverable; live/unknown owners never are.
    while (true) {
        try {
            const handle = await fs.open(lock, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid }));
            }
            finally {
                await handle.close();
            }
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            try {
                const stat = await fs.stat(lock);
                const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
                if (Number.isInteger(owner.pid) && owner.pid > 0 && Date.now() - stat.mtimeMs > 1000) {
                    try {
                        process.kill(owner.pid, 0);
                    }
                    catch (probe) {
                        if (probe.code === 'ESRCH') {
                            // Recovery itself is serialized, preventing two recoverers from deleting a new writer's lock.
                            const recovery = `${lock}.recovery`;
                            let recoveryHandle;
                            try {
                                recoveryHandle = await fs.open(recovery, 'wx', 0o600);
                                const current = await fs.stat(lock);
                                if (current.ino === stat.ino)
                                    await fs.unlink(lock);
                            }
                            catch { /* another recovery or lock changed */ }
                            finally {
                                if (recoveryHandle) {
                                    await recoveryHandle.close();
                                    await fs.unlink(recovery).catch(() => { });
                                }
                            }
                        }
                    }
                }
            }
            catch { /* incomplete lock metadata: wait, never steal */ }
            if (Date.now() >= deadline)
                throw new Error(`Timed out waiting for manifest lock: ${lock}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    try {
        return await fn();
    }
    finally {
        await fs.unlink(lock);
    }
}
async function atomicWrite(manifest, manifestPath) {
    const temp = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temp, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, manifestPath);
    }
    finally {
        await fs.unlink(temp).catch(() => { });
    }
}
export async function writeManifest(manifest, baseDir = resolveBaseDir()) {
    const target = resolveManifestPath(baseDir);
    await withLock(target, () => atomicWrite(manifest, target));
}
export async function updateManifest(mutator, baseDir = resolveBaseDir()) {
    return updateManifestAtPath(resolveManifestPath(baseDir), mutator);
}
export async function updateManifestAtPath(manifestPath, mutator) {
    return withLock(manifestPath, async () => {
        let manifest;
        try {
            manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            manifest = { items: [] };
        }
        if (!manifest || !Array.isArray(manifest.items))
            throw new Error('Invalid MIDI manifest: expected items array');
        await mutator(manifest);
        await atomicWrite(manifest, manifestPath);
        return manifest;
    });
}
export async function appendItem(item, baseDir = resolveBaseDir()) {
    await updateManifest(manifest => {
        if (manifest.items.some(existing => existing.id === item.id))
            throw new Error(`Duplicate fileId: ${item.id}`);
        manifest.items.push(item);
    }, baseDir);
}
export async function getItemById(fileId, baseDir = resolveBaseDir()) {
    return (await readManifest(baseDir)).items.find(item => item.id === fileId);
}
/** Serializes whole data operations; independent of the manifest lock, so callbacks may updateManifest. Nonreentrant. */
export async function withDataWriteLock(fn, baseDir = resolveBaseDir()) {
    return withLock(path.join(resolveDataDir(baseDir), '.data-write'), fn);
}
