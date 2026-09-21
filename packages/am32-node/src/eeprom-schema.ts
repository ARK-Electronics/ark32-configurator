/** Persistent schema loader for CLI, server, and Electron hosts (pass userData as cacheDir). */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSchema, type LoadedSchema, type SchemaAsset, type SchemaCache } from 'am32-core/eeprom/schema-loader';
import { DEFAULT_FIRMWARE_OWNER, DEFAULT_FIRMWARE_REPO } from 'am32-core/releases';

export interface NodeSchemaOptions {
    /** GitHub Enterprise/API fixture override; defaults to public GitHub. */
    apiBaseUrl?: string;
    cacheDir?: string;
    owner?: string;
    repo?: string;
    token?: string | null;
    bundledOnly?: boolean;
    log?: (message: string) => void;
    latest?: () => Promise<SchemaAsset | null>;
    download?: (url: string) => Promise<string>;
}

export function nodeSchemaCache (directory: string): SchemaCache {
    const path = join(directory, 'eeprom.json');
    return {
        read: async () => {
            try { return await readFile(path, 'utf8'); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
                throw error;
            }
        },
        write: async (json) => {
            await mkdir(directory, { recursive: true });
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, json, { mode: 0o600 });
                await rename(temporary, path);
            } finally { await unlink(temporary).catch(() => {}); }
        }
    };
}

export async function latestGithubSchema (options: NodeSchemaOptions = {}): Promise<SchemaAsset | null> {
    const owner = options.owner ?? DEFAULT_FIRMWARE_OWNER;
    const repo = options.repo ?? DEFAULT_FIRMWARE_REPO;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (options.token) { headers.Authorization = `Bearer ${options.token}`; }
    const response = await fetch(`${options.apiBaseUrl ?? 'https://api.github.com'}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`, {
        headers, signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) { return null; }
    if (!response.ok) { throw new Error(`GitHub latest release: HTTP ${response.status}`); }
    const release = await response.json() as { assets?: { name: string; browser_download_url: string; digest?: string | null }[] };
    const asset = release.assets?.find(asset => asset.name === 'eeprom.json');
    if (!asset) { return null; }
    return { url: asset.browser_download_url, ...(asset.digest?.startsWith('sha256:') ? { sha256: asset.digest.slice(7) } : {}) };
}

export async function loadNodeSchema (options: NodeSchemaOptions = {}): Promise<LoadedSchema> {
    return await loadSchema({
        cache: nodeSchemaCache(options.cacheDir ?? join(homedir(), '.cache', 'ark32')),
        bundledOnly: options.bundledOnly,
        log: options.log,
        latest: options.latest ?? (() => latestGithubSchema(options)),
        download: options.download ?? (async (url) => {
            const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!response.ok) { throw new Error(`EEPROM asset: HTTP ${response.status}`); }
            // A schema is metadata, so cap malformed responses before parsing/caching.
            const text = await response.text();
            if (text.length > 2 * 1024 * 1024) { throw new Error('EEPROM schema asset exceeds 2 MiB'); }
            return text;
        }),
        sha256: text => Promise.resolve(createHash('sha256').update(text).digest('hex'))
    });
}
