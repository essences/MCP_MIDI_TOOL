import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decodeSmfToJson } from './smfToJson.js';
import { updateManifestAtPath } from './storage.js';
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function read(pathname) {
    try {
        const value = JSON.parse(await fs.readFile(pathname, 'utf8'));
        if (!value || !Array.isArray(value.items))
            throw new Error(`Invalid manifest: ${pathname}`);
        return value;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { items: [] };
        throw error;
    }
}
async function scan(dir) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const result = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            result.push(...await scan(full));
        else if (entry.isFile() && /\.(mid|midi)$/i.test(entry.name))
            result.push(full);
    }
    return result;
}
/** Read-only analysis. Neither source nor target directories are created. */
export async function analyzeDataMigration(options) {
    const targetManifestPath = path.resolve(options.targetDataDir, 'manifest.json');
    const report = { entries: [], issues: [], unregisteredFiles: [], importedIds: [], targetManifestPath, dryRun: true };
    const seen = new Map();
    const registered = new Set();
    for (const manifestPath of options.sourceManifestPaths) {
        // A missing explicitly selected manifest is an error, not an empty migration.
        await fs.access(manifestPath);
        for (const item of (await read(manifestPath)).items) {
            const sourcePath = path.resolve(options.sourceBaseDir, item.path);
            registered.add(sourcePath);
            const entry = { item, manifestPath: path.resolve(manifestPath), sourcePath };
            report.entries.push(entry);
            try {
                const content = await fs.readFile(sourcePath);
                entry.sha256 = hash(content);
                try {
                    await decodeSmfToJson(content);
                }
                catch {
                    report.issues.push({ kind: 'invalid-smf', id: item.id, paths: [sourcePath] });
                }
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
                report.issues.push({ kind: 'missing', id: item.id, paths: [sourcePath] });
            }
            const previous = seen.get(item.id);
            if (previous)
                report.issues.push({ kind: previous.sha256 && previous.sha256 === entry.sha256 ? 'duplicate-id' : 'id-conflict', id: item.id, paths: [previous.sourcePath, sourcePath] });
            else
                seen.set(item.id, entry);
        }
    }
    for (let index = 0; index < report.entries.length; index++) {
        const entry = report.entries[index];
        const previous = report.entries.slice(0, index).find(other => other.item.name === entry.item.name && other.item.id !== entry.item.id);
        if (previous)
            report.issues.push({ kind: 'name-conflict', id: entry.item.id, paths: [previous.sourcePath, entry.sourcePath] });
    }
    const target = await read(targetManifestPath);
    for (const item of target.items) {
        const sameName = report.entries.find(entry => entry.item.name === item.name && entry.item.id !== item.id);
        if (sameName)
            report.issues.push({ kind: 'name-conflict', id: sameName.item.id, paths: [sameName.sourcePath, item.path] });
        const source = seen.get(item.id);
        if (source)
            report.issues.push({ kind: 'id-conflict', id: item.id, paths: [source.sourcePath, path.resolve(path.dirname(path.resolve(options.targetDataDir)), item.path)] });
    }
    report.unregisteredFiles = (await scan(path.resolve(options.sourceBaseDir, 'data'))).filter(file => !registered.has(file));
    return report;
}
/** Explicit opt-in copy import. Dry-run is the default; source files are never changed. */
export async function importDataMigration(options) {
    const report = await analyzeDataMigration(options);
    if (options.dryRun !== false)
        return report;
    if (report.issues.length)
        throw new Error(`Migration blocked: ${JSON.stringify(report.issues)}`);
    const targetBase = path.dirname(path.resolve(options.targetDataDir));
    const created = [];
    try {
        await updateManifestAtPath(report.targetManifestPath, async (manifest) => {
            for (const entry of report.entries) {
                if (manifest.items.some(item => item.id === entry.item.id))
                    throw new Error(`Migration fileId conflict: ${entry.item.id}`);
            }
            for (const entry of report.entries) {
                const content = await fs.readFile(entry.sourcePath);
                if (hash(content) !== entry.sha256)
                    throw new Error(`Source changed during migration: ${entry.sourcePath}`);
                const destination = path.join(path.resolve(options.targetDataDir), 'midi', `${randomUUID()}.mid`);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, content, { flag: 'wx' });
                created.push(destination);
                if (hash(await fs.readFile(destination)) !== entry.sha256)
                    throw new Error(`Copy verification failed: ${destination}`);
                entry.targetPath = destination;
                manifest.items.push({ ...entry.item, path: path.relative(targetBase, destination), bytes: content.length });
                report.importedIds.push(entry.item.id);
            }
        });
    }
    catch (error) {
        await Promise.all(created.map(destination => fs.unlink(destination).catch(() => { })));
        throw error;
    }
    report.dryRun = false;
    return report;
}
