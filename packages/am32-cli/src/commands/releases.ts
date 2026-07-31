/**
 * `ark32 releases`, and the GitHub half of `ark32 flash --release`.
 *
 * The CLI asks `api.github.com` directly -- CORS constrains the browser and
 * nothing else (issue #3 section 4), so unlike the web app there is no proxy in
 * this path. Which asset fits which ESC is decided by `am32-core/releases`,
 * shared with the web flash dialog, so the two clients cannot drift apart on
 * the naming convention.
 */

import { describeError } from 'am32-core/errors';
import type { CliEnv } from '../env';
import { EXIT_OK } from '../exit';
import type { CommandOutcome } from '../report';

/**
 * A failure reaching the release catalog or its assets. Exit code 2, the same
 * claim an unreachable flight controller makes: nothing was learned, and the
 * fix is environmental (network, rate limit, repo name) rather than in the
 * arguments or on an ESC.
 */
export class CatalogError extends Error {
    constructor (message: string, options: { cause?: unknown } = {}) {
        super(message, options);
        this.name = 'CatalogError';
    }
}

export interface ReleaseAsset {
    name: string
    downloadUrl: string
}

export interface FirmwareRelease {
    tag: string
    prerelease: boolean
    /** ISO timestamp, or null for a draft. */
    publishedAt: string | null
    assets: ReleaseAsset[]
}

/** One page is plenty: the whole point of the rolling `nightly` is recency. */
const RELEASES_PER_PAGE = 30;

interface GithubAsset {
    name?: unknown
    browser_download_url?: unknown
}

interface GithubRelease {
    tag_name?: unknown
    prerelease?: unknown
    published_at?: unknown
    assets?: unknown
}

export async function fetchFirmwareReleases (env: CliEnv): Promise<FirmwareRelease[]> {
    const { owner, repo, token } = env.firmware;
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_PAGE}`;
    const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        // Required by the GitHub API; requests without one are rejected.
        'user-agent': 'ark32-cli'
    };
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }

    const response = await env.httpGet(url, headers).catch((error: unknown) => {
        throw new CatalogError(`cannot reach api.github.com: ${describeError(error)}`, { cause: error });
    });

    if (response.status !== 200) {
        throw new CatalogError(
            `GitHub answered ${response.status} listing ${owner}/${repo} releases` +
            (response.status === 403 ? ' -- likely the anonymous rate limit; set GITHUB_TOKEN' : '')
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch (error) {
        throw new CatalogError('GitHub answered something that is not JSON', { cause: error });
    }
    if (!Array.isArray(parsed)) {
        throw new CatalogError('GitHub answered JSON that is not a release list');
    }

    return (parsed as GithubRelease[]).map(release => ({
        tag: typeof release.tag_name === 'string' ? release.tag_name : '',
        prerelease: release.prerelease === true,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
        assets: (Array.isArray(release.assets) ? (release.assets as GithubAsset[]) : [])
            .filter(asset => typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
            .map(asset => ({
                name: asset.name as string,
                downloadUrl: asset.browser_download_url as string
            }))
    })).filter(release => release.tag !== '');
}

/**
 * Download one asset and hand back its text. HTTP and network failures both
 * become {@link CatalogError}; whether that fails one ESC or the whole command
 * is the caller's business.
 */
export async function downloadAsset (env: CliEnv, asset: ReleaseAsset): Promise<string> {
    const response = await env.httpGet(asset.downloadUrl, {
        accept: 'application/octet-stream',
        'user-agent': 'ark32-cli'
    }).catch((error: unknown) => {
        throw new CatalogError(`downloading ${asset.name}: ${describeError(error)}`, { cause: error });
    });

    if (response.status !== 200) {
        throw new CatalogError(`downloading ${asset.name}: GitHub answered ${response.status}`);
    }
    return response.body;
}

/** `ark32 releases` -- the catalog, newest first, as GitHub orders it. */
export async function commandReleases (env: CliEnv): Promise<CommandOutcome> {
    const releases = await fetchFirmwareReleases(env);
    const source = `${env.firmware.owner}/${env.firmware.repo}`;

    const rows = releases.map((release) => {
        const hexCount = release.assets.filter(asset => asset.name.endsWith('.hex')).length;
        return {
            tag: release.tag,
            prerelease: release.prerelease,
            publishedAt: release.publishedAt,
            hexAssets: hexCount,
            assets: release.assets.map(asset => asset.name)
        };
    });

    const tagWidth = Math.max(0, ...rows.map(row => row.tag.length));
    const lines = rows.length === 0
        ? [`${source} has no releases`]
        : rows.map(row => `${row.tag.padEnd(tagWidth)}  ${row.prerelease ? 'prerelease' : 'release   '}  ` +
            `${row.publishedAt?.slice(0, 10) ?? 'unpublished'}  ${row.hexAssets} hex asset(s)`);

    return { data: { source, releases: rows }, lines, exitCode: EXIT_OK };
}
