/**
 * The GitHub catalog client, against a stubbed `httpGet` -- no network anywhere.
 *
 * The mapping and the failure taxonomy are the tests' whole subject:
 * `CatalogError` is what `run()` turns into exit 2, so which failures produce
 * it is specified behaviour.
 */

import { describe, expect, it } from 'vitest';
import type { CliEnv, HttpResponse } from '../env';
import { CatalogError, commandReleases, downloadAsset, fetchFirmwareReleases } from './releases';

/** The two members this module touches, with everything else set to throw. */
function envWith (
    httpGet: (url: string, headers?: Record<string, string>) => Promise<HttpResponse>,
    token: string | null = null
): CliEnv {
    const refuse = (what: string) => () => {
        throw new Error(`the release commands must not touch ${what}`);
    };
    return {
        stdout: refuse('stdout'),
        stderr: refuse('stderr'),
        readFile: refuse('the filesystem'),
        readTextFile: refuse('the filesystem'),
        writeFile: refuse('the filesystem'),
        ensureDir: refuse('the filesystem'),
        joinPath: refuse('the filesystem'),
        openPort: refuse('a serial port'),
        listPorts: refuse('a serial port'),
        httpGet,
        firmware: { owner: 'ARK-Electronics', repo: 'ARK32', token },
        version: '0.0.0-test'
    };
}

const NIGHTLY = {
    tag_name: 'nightly',
    prerelease: true,
    published_at: '2026-07-30T06:56:32Z',
    assets: [
        { name: 'AM32_ARK_4IN1_F051_3.0-ark.hex', browser_download_url: 'https://example.test/ark' },
        { name: 'AM32_REF_G431_3.0-ark.hex', browser_download_url: 'https://example.test/g431' }
    ]
};

describe('fetchFirmwareReleases', () => {
    it('maps the GitHub shape and remembers what it asked for', async () => {
        const asked: { url?: string, headers?: Record<string, string> } = {};
        const releases = await fetchFirmwareReleases(envWith((url, headers) => {
            asked.url = url;
            asked.headers = headers;
            return Promise.resolve({ status: 200, body: JSON.stringify([NIGHTLY]) });
        }));

        expect(asked.url).toBe('https://api.github.com/repos/ARK-Electronics/ARK32/releases?per_page=30');
        expect(asked.headers?.['user-agent']).toBe('ark32-cli');
        expect(asked.headers?.authorization).toBeUndefined();
        expect(releases).toEqual([{
            tag: 'nightly',
            prerelease: true,
            publishedAt: '2026-07-30T06:56:32Z',
            assets: [
                { name: 'AM32_ARK_4IN1_F051_3.0-ark.hex', downloadUrl: 'https://example.test/ark' },
                { name: 'AM32_REF_G431_3.0-ark.hex', downloadUrl: 'https://example.test/g431' }
            ]
        }]);
    });

    it('sends the token as a bearer when one is configured', async () => {
        let authorization: string | undefined;
        await fetchFirmwareReleases(envWith((_url, headers) => {
            authorization = headers?.authorization;
            return Promise.resolve({ status: 200, body: '[]' });
        }, 'tok123'));

        expect(authorization).toBe('Bearer tok123');
    });

    it('turns a 403 into a CatalogError that names the rate limit', async () => {
        const failure = fetchFirmwareReleases(envWith(() => Promise.resolve({ status: 403, body: '' })));
        await expect(failure).rejects.toBeInstanceOf(CatalogError);
        await expect(failure).rejects.toThrow(/GITHUB_TOKEN/);
    });

    it('turns a network failure into a CatalogError', async () => {
        const failure = fetchFirmwareReleases(envWith(() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))));
        await expect(failure).rejects.toBeInstanceOf(CatalogError);
        await expect(failure).rejects.toThrow(/api.github.com/);
    });

    it('turns a non-JSON answer into a CatalogError instead of a crash', async () => {
        const failure = fetchFirmwareReleases(envWith(() => Promise.resolve({ status: 200, body: '<html>' })));
        await expect(failure).rejects.toBeInstanceOf(CatalogError);
    });
});

describe('downloadAsset', () => {
    it('hands back the body of a 200', async () => {
        const env = envWith(() => Promise.resolve({ status: 200, body: ':00000001FF\n' }));
        await expect(downloadAsset(env, { name: 'a.hex', downloadUrl: 'https://example.test/a' }))
            .resolves.toBe(':00000001FF\n');
    });

    it('names the asset in an HTTP failure', async () => {
        const env = envWith(() => Promise.resolve({ status: 404, body: '' }));
        const failure = downloadAsset(env, { name: 'a.hex', downloadUrl: 'https://example.test/a' });
        await expect(failure).rejects.toBeInstanceOf(CatalogError);
        await expect(failure).rejects.toThrow(/a\.hex/);
    });
});

describe('commandReleases', () => {
    it('prints one row per release and counts only hex assets', async () => {
        const outcome = await commandReleases(envWith(() => Promise.resolve({
            status: 200,
            body: JSON.stringify([
                NIGHTLY,
                { tag_name: 'v2.20', prerelease: false, published_at: '2026-06-01T00:00:00Z', assets: [] }
            ])
        })));

        expect(outcome.exitCode).toBe(0);
        expect(outcome.lines).toEqual([
            'nightly  prerelease  2026-07-30  2 hex asset(s)',
            'v2.20    release     2026-06-01  0 hex asset(s)'
        ]);
    });

    it('says so when there is nothing at all', async () => {
        const outcome = await commandReleases(envWith(() => Promise.resolve({ status: 200, body: '[]' })));
        expect(outcome.exitCode).toBe(0);
        expect(outcome.lines).toEqual(['ARK-Electronics/ARK32 has no releases']);
    });
});
