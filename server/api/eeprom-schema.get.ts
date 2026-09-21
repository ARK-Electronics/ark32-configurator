import { join } from 'node:path';
import { loadNodeSchema, latestGithubSchema } from '../../packages/am32-node/src/eeprom-schema';
import type { SchemaAsset } from 'am32-core/eeprom/schema-loader';
import { isMinioConfigured, useMinio } from '~/composables/useMinio';

/** Same release bucket as firmware, including offline mirrored deployments. */
async function latestMirroredSchema (): Promise<SchemaAsset | null> {
    const minio = useMinio();
    const releases = new Map<string, { name: string; lastModified: Date; schemaPath?: string }>();
    for await (const object of minio.listObjectsV2('releases', '', true)) {
        const folder = object.name?.split('/')[0];
        if (!folder || !object.name?.includes('/') || folder.endsWith('-rc')) { continue; }
        const release: { name: string; lastModified: Date; schemaPath?: string } = releases.get(folder) ?? { name: folder, lastModified: object.lastModified ?? new Date(0) };
        if (object.name === `${folder}/eeprom.json`) { release.schemaPath = object.name; }
        releases.set(folder, release);
    }
    const candidates = [...releases.values()];
    // The mirror is updated newest-first; release version, not upload time, determines latest.
    candidates.sort((a, b) => {
        const aa = a.name.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
        const bb = b.name.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
        if (aa && bb) {
            for (let i = 1; i <= 3; i++) {
                const delta = Number(bb[i] ?? 0) - Number(aa[i] ?? 0);
                if (delta) { return delta; }
            }
        }
        return b.lastModified.getTime() - a.lastModified.getTime();
    });
    const candidate = candidates[0];
    if (!candidate?.schemaPath) { return null; }
    const stat = await minio.statObject('releases', candidate.schemaPath);
    const sha256 = stat.metaData?.sha256;
    return { url: await minio.presignedGetObject('releases', candidate.schemaPath, 300), ...(typeof sha256 === 'string' ? { sha256 } : {}) };
}

export default defineEventHandler(async () => {
    const options = {
        cacheDir: process.env.ARK32_SCHEMA_CACHE_DIR || join(process.cwd(), '.cache', 'ark32'),
        owner: process.env.GITHUB_FIRMWARE_OWNER || 'ARK-Electronics',
        repo: process.env.GITHUB_FIRMWARE_REPO || 'ARK32',
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
        bundledOnly: process.env.NODE_ENV === 'test',
        log: (message: string) => console.info(`[eeprom-schema] ${message}`)
    };
    return await loadNodeSchema({
        ...options,
        latest: async () => {
            if (isMinioConfigured()) {
                try {
                    const mirrored = await latestMirroredSchema();
                    if (mirrored) { return mirrored; }
                } catch (error) { options.log(`Mirror unavailable: ${String(error)}`); }
            }
            return await latestGithubSchema(options);
        }
    });
});
