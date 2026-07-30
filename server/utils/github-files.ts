import { Octokit } from 'octokit';

type GithubAsset = {
    name: string;
    browser_download_url: string;
};

type GithubRelease = {
    tag_name: string;
    prerelease: boolean;
    assets: GithubAsset[];
};

const CACHE_TTL_MS = 10 * 60 * 1000;

const memoryCache = new Map<string, { expires: number; folder: BlobFolder }>();

function env (name: string): string | undefined {
    const value = process.env[name];
    return value !== undefined && value !== '' ? value : undefined;
}

function getOctokit () {
    const token = env('GITHUB_TOKEN') || env('GH_TOKEN');
    return token ? new Octokit({ auth: token }) : new Octokit();
}

function versionFolderName (tag: string, prerelease: boolean): string {
    return prerelease && !tag.endsWith('-rc') ? `${tag}-rc` : tag;
}

function toBlobFolder (
    folderName: string,
    releases: GithubRelease[],
    includePrereleases: boolean
): BlobFolder {
    const children: BlobFolder[] = [];

    for (const release of releases) {
        if (!includePrereleases && release.prerelease) {
            continue;
        }

        const name = versionFolderName(release.tag_name, release.prerelease);
        const files: BlobFolderFile[] = release.assets.map((asset) => {
            // Proxy through our API so browser fetch() is same-origin (no CORS)
            const proxyUrl = `/api/github-asset?url=${encodeURIComponent(asset.browser_download_url)}`;
            return {
                name: asset.name,
                url: proxyUrl,
                downloadUrl: proxyUrl
            };
        });

        if (files.length === 0) {
            continue;
        }

        children.push({
            name,
            children: [],
            files
        });
    }

    // Newest first (GitHub already returns newest first; keep stable)
    return {
        name: folderName,
        children,
        files: []
    };
}

/**
 * List firmware / bootloader assets from GitHub Releases (no MinIO required).
 */
export async function getGithubReleaseFolder (options: {
    folderName: string;
    owner: string;
    repo: string;
    includePrereleases: boolean;
    /** Optional semver floor filter is not applied — UI sorts by tag name. */
}): Promise<BlobFolder> {
    const cacheKey = [
        options.owner,
        options.repo,
        options.folderName,
        options.includePrereleases ? 'pre' : 'stable'
    ].join(':');

    const cached = memoryCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        return cached.folder;
    }

    const octokit = getOctokit();
    const releases: GithubRelease[] = [];

    // Paginate a reasonable number of recent releases
    for (let page = 1; page <= 5; page++) {
        const { data } = await octokit.rest.repos.listReleases({
            owner: options.owner,
            repo: options.repo,
            per_page: 30,
            page
        });

        if (data.length === 0) {
            break;
        }

        for (const release of data) {
            releases.push({
                tag_name: release.tag_name,
                prerelease: release.prerelease,
                assets: (release.assets ?? []).map(a => ({
                    name: a.name,
                    browser_download_url: a.browser_download_url
                }))
            });
        }

        if (data.length < 30) {
            break;
        }
    }

    const folder = toBlobFolder(
        options.folderName,
        releases,
        options.includePrereleases
    );

    memoryCache.set(cacheKey, {
        expires: Date.now() + CACHE_TTL_MS,
        folder
    });

    console.info(
        `[github-files] ${options.owner}/${options.repo}: ${folder.children.length} version(s), prereleases=${options.includePrereleases}`
    );

    return folder;
}

function firmwareOwner (): string {
    return env('GITHUB_FIRMWARE_OWNER') || 'ARK-Electronics';
}

function firmwareRepo (): string {
    return env('GITHUB_FIRMWARE_REPO') || 'ARK32';
}

function bootloaderOwner (): string {
    return env('GITHUB_BOOTLOADER_OWNER') || 'ARK-Electronics';
}

function bootloaderRepo (): string {
    return env('GITHUB_BOOTLOADER_REPO') || 'ARK32-bootloader';
}

export const GITHUB_FILE_SOURCES = {
    get releases () {
        return {
            owner: firmwareOwner(),
            repo: firmwareRepo(),
            folderName: 'releases' as const
        };
    },
    get bootloader () {
        return {
            owner: bootloaderOwner(),
            repo: bootloaderRepo(),
            folderName: 'bootloader' as const
        };
    }
};
