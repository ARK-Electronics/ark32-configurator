import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SCHEMA } from 'am32-core/eeprom/schema';
import { bundledSchemaInfo } from 'am32-core/eeprom/schema-loader';
import { latestGithubSchema, loadNodeSchema } from './eeprom-schema';

/** Real HTTP and filesystem boundaries; no live GitHub or user's cache. */
it('loads the latest HTTP fixture asset and reuses one SHA256-addressed disk cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'ark32-schema-test-'));
    const schema = structuredClone(BUNDLED_SCHEMA);
    schema.version = '1.2.0';
    let json = JSON.stringify(schema);
    let unavailable = false;
    let assetRequests = 0;
    let latestRequests = 0;
    let origin = '';
    const server = createServer((request, response) => {
        if (unavailable) { response.writeHead(503).end('offline'); return; }
        if (request.url?.endsWith('/releases/latest')) {
            latestRequests++;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
                tag_name: 'v32.1',
                assets: [{
                    name: 'eeprom.json',
                    browser_download_url: `${origin}/asset/eeprom.json`,
                    digest: `sha256:${createHash('sha256').update(json).digest('hex')}`
                }]
            }));
        } else if (request.url === '/asset/eeprom.json') {
            assetRequests++;
            response.end(json);
        } else { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('fixture has no TCP address'); }
    origin = `http://127.0.0.1:${address.port}`;
    const options = { apiBaseUrl: origin, cacheDir, owner: 'fixture', repo: 'ARK32' };
    try {
        const first = await loadNodeSchema(options);
        expect(first.source).toBe('fetched');
        expect(first.schema.version).toBe('1.2.0');
        expect(await readFile(join(cacheDir, 'eeprom.json'), 'utf8')).toBe(json);
        const second = await loadNodeSchema(options);
        expect(second.source).toBe('cached');
        expect(second.sha256).toBe(first.sha256);
        expect(assetRequests).toBe(1);
        expect(latestRequests).toBe(2);
        unavailable = true;
        expect((await loadNodeSchema(options)).source).toBe('cached');
        expect(await loadNodeSchema({ ...options, cacheDir: join(cacheDir, 'cold') })).toEqual(bundledSchemaInfo());
        unavailable = false;
        schema.version = '2.0.0'; json = JSON.stringify(schema);
        expect(await loadNodeSchema(options)).toEqual(bundledSchemaInfo());
        expect(JSON.parse(await readFile(join(cacheDir, 'eeprom.json'), 'utf8')).version).toBe('1.2.0');
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(cacheDir, { recursive: true, force: true });
    }
});

describe('missing latest release assets', () => {
    it('returns null when the latest release has no eeprom.json', async () => {
        const server = createServer((_request, response) => response.end(JSON.stringify({ assets: [{ name: 'firmware.hex' }] })));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') { throw new Error('fixture has no TCP address'); }
        try {
            expect(await latestGithubSchema({ apiBaseUrl: `http://127.0.0.1:${address.port}` })).toBeNull();
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
});
