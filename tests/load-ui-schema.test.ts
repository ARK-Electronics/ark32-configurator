import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadUiSchema, refreshUiSchema } from '../utils/load-ui-schema';
import { BUNDLED_SCHEMA, BUNDLED_SCHEMA_SHA256 } from 'am32-core/eeprom/schema';

afterEach(() => vi.unstubAllGlobals());

describe('UI session schema refresh', () => {
    it('uses validated runtime schema from release endpoint', async () => {
        const schema = structuredClone(BUNDLED_SCHEMA);
        schema.version = '1.2.0';
        const result = { schema, source: 'cached', sha256: 'a'.repeat(64) };
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: () => result });
        vi.stubGlobal('fetch', fetcher);
        expect(await loadUiSchema()).toEqual(result);
        expect(fetcher).toHaveBeenCalledWith('/api/eeprom-schema', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('falls back to bundle on offline and newer schema language', async () => {
        const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
            ok: true,
            json: () => ({ schema: { ...BUNDLED_SCHEMA, version: '2.0.0' }, source: 'fetched', sha256: 'a'.repeat(64) })
        });
        vi.stubGlobal('fetch', fetcher);
        for (let i = 0; i < 2; i++) {
            expect(await loadUiSchema()).toEqual({ schema: BUNDLED_SCHEMA, source: 'bundled', sha256: BUNDLED_SCHEMA_SHA256 });
        }
    });

    it('shares startup in-flight work and refreshes before the next connect', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: () => ({ schema: BUNDLED_SCHEMA, source: 'fetched', sha256: BUNDLED_SCHEMA_SHA256 }) });
        vi.stubGlobal('fetch', fetcher);
        await Promise.all([refreshUiSchema(), refreshUiSchema()]);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await refreshUiSchema();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
