import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_SCHEMA } from './schema';
import { bundledSchemaInfo, loadSchema } from './schema-loader';

const sha256 = (text: string) => Promise.resolve(createHash('sha256').update(text).digest('hex'));
function fixture () {
    const schema = structuredClone(BUNDLED_SCHEMA);
    schema.version = '1.2.0';
    const json = JSON.stringify(schema);
    let cached: string | null = null;
    const download = vi.fn(() => Promise.resolve(json));
    const latest = vi.fn(async () => ({ url: 'https://example.test/eeprom.json', sha256: await sha256(json) }));
    const cache = { read: () => Promise.resolve(cached), write: (text: string) => { cached = text; return Promise.resolve(); } };
    return { schema, json, options: { latest, download, sha256, cache }, setCached: (text: string) => { cached = text; } };
}

describe('latest EEPROM release asset policy', () => {
    it('fetches latest metadata, caches by content SHA256, and skips unchanged downloads', async () => {
        const { options, schema, json } = fixture();
        expect(await loadSchema(options)).toEqual({ schema, source: 'fetched', sha256: await sha256(json) });
        expect(await loadSchema(options)).toEqual({ schema, source: 'cached', sha256: await sha256(json) });
        expect(options.latest).toHaveBeenCalledTimes(2);
        expect(options.download).toHaveBeenCalledTimes(1);
    });
    it('uses the bundle offline with a cold cache and a validated cache when warm', async () => {
        const { options, schema } = fixture();
        options.latest.mockRejectedValueOnce(new Error('offline'));
        expect(await loadSchema(options)).toEqual(bundledSchemaInfo());
        await loadSchema(options);
        options.latest.mockRejectedValueOnce(new Error('offline'));
        expect((await loadSchema(options)).schema).toEqual(schema);
        expect((await loadSchema({ ...options, latest: () => Promise.resolve(null) })).source).toBe('cached');
    });
    it('uses the bundle for incompatible language major even with an older cached schema', async () => {
        const { options, json } = fixture();
        await loadSchema(options);
        const incompatible = json.replace('"version":"1.2.0"', '"version":"2.0.0"');
        options.latest.mockResolvedValueOnce({ url: 'next', sha256: await sha256(incompatible) });
        options.download.mockResolvedValueOnce(incompatible);
        expect(await loadSchema(options)).toEqual(bundledSchemaInfo());
    });
    it('refuses corrupt cache and asset digests', async () => {
        const { options, setCached } = fixture();
        setCached('invalid');
        options.latest.mockResolvedValueOnce({ url: 'next', sha256: '0'.repeat(64) });
        expect(await loadSchema(options)).toEqual(bundledSchemaInfo());
    });
    it('does no IO for simulator/test fallback', async () => {
        const { options } = fixture();
        const read = vi.spyOn(options.cache, 'read');
        expect(await loadSchema({ ...options, bundledOnly: true })).toEqual(bundledSchemaInfo());
        expect(options.latest).not.toHaveBeenCalled();
        expect(options.download).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });
});
