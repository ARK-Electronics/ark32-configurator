import { promiseTimeout } from '@vueuse/core';
import { isMinioConfigured, useMinio } from '~/composables/useMinio';
import {
    GITHUB_FILE_SOURCES,
    getGithubReleaseFolder
} from '~/server/utils/github-files';

type CachedObject = {
    key: string,
    value: string | null
};

type SectionConfig = {
    filterName: string,
    folderName: string,
    bucketName: string,
    cacheNamespace: string,
    storageName: string,
    nested: boolean,
    includePrereleaseFilter?: boolean
};

function delay (ms: number) {
    return promiseTimeout(ms);
}

function getObjectPath (cacheNamespace: string, key: string) {
    if (key.startsWith(`${cacheNamespace}:`) || key.startsWith(`${cacheNamespace}/`)) {
        return key.slice(cacheNamespace.length + 1);
    }

    return key;
}

function buildDownloadUrl (bucketName: string, objectPath: string) {
    const payload = Buffer.from(JSON.stringify({
        bucketName,
        objectPath
    })).toString('base64url');

    return `/api/file/${payload}`;
}

function buildFileEntry (name: string, url: string, bucketName: string, objectPath: string): BlobFolderFile {
    const file: BlobFolderFile = {
        name,
        url
    };

    if (url && name.toLowerCase().endsWith('.hex')) {
        file.downloadUrl = buildDownloadUrl(bucketName, objectPath);
    }

    return file;
}

async function getCachedObjects (
    minioClient: ReturnType<typeof useMinio>,
    cache: ReturnType<typeof useStorage>,
    bucketName: string,
    cacheNamespace: string
): Promise<CachedObject[]> {
    const stream = minioClient.listObjectsV2(bucketName, '', true, '');

    return await new Promise((resolve, reject) => {
        stream.on('error', (err) => {
            reject(err);
        });

        stream.on('data', async (obj) => {
            if (obj.name && !(await cache.hasItem(`${cacheNamespace}:${obj.name}`))) {
                const url = await minioClient.presignedUrl('get', bucketName, obj.name, 24 * 60 * 60);
                await cache.setItem(
                    `${cacheNamespace}:${obj.name}`,
                    `${url}`,
                    {
                        ttl: (24 * 60 * 60) - 1
                    }
                );
            }
        });

        stream.on('end', async () => {
            await delay(200);
            const keys = await cache.getKeys(cacheNamespace);
            const result: CachedObject[] = [];

            for (const key of keys) {
                result.push({
                    key,
                    value: (await cache.getItem(key))?.toString() ?? ''
                });
            }

            resolve(result);
        });
    });
}

function buildNestedFolder (
    folderName: string,
    entries: CachedObject[],
    bucketName: string,
    cacheNamespace: string,
    includePrereleases = true
) {
    const folder = {
        name: folderName,
        children: [] as BlobFolder[],
        files: [] as BlobFolderFile[]
    };

    for (const entry of entries) {
        const objectPath = getObjectPath(cacheNamespace, entry.key);
        // Support both "v1.0/file.hex" (MinIO paths) and "v1.0:file.hex" keys
        const parts = objectPath.includes('/')
            ? objectPath.split('/').filter(Boolean)
            : objectPath.split(':').filter(Boolean);

        const fileOrVersion = parts[0];
        const subParts = parts.slice(1);

        if (!fileOrVersion) {
            continue;
        }

        if (!includePrereleases && fileOrVersion.endsWith('-rc')) {
            continue;
        }

        if (subParts.length > 0) {
            let subfolder = folder.children.find(sf => sf.name === fileOrVersion);

            if (!subfolder) {
                subfolder = {
                    name: fileOrVersion,
                    files: [],
                    children: []
                };
                folder.children.push(subfolder);
            }

            subfolder.files.push({
                ...buildFileEntry(subParts.join('/'), entry.value ?? '', bucketName, objectPath.replace(/:/g, '/'))
            });
        } else {
            folder.files.push(buildFileEntry(fileOrVersion, entry.value ?? '', bucketName, objectPath));
        }
    }

    return folder;
}

function buildFlatFolder (folderName: string, entries: CachedObject[], bucketName: string, cacheNamespace: string) {
    return {
        name: folderName,
        children: [] as BlobFolder[],
        files: entries.filter(entry => entry.value).map((entry) => {
            const objectPath = getObjectPath(cacheNamespace, entry.key);

            return buildFileEntry(
                objectPath.split(/[/:]/).pop() ?? objectPath,
                entry.value ?? '',
                bucketName,
                objectPath
            );
        })
    };
}

function emptyFolder (name: string): BlobFolder {
    return { name, children: [], files: [] };
}

async function getSectionFromGithub (
    filterName: string,
    includePrereleases: boolean
): Promise<BlobFolder | null> {
    if (filterName === 'releases') {
        const src = GITHUB_FILE_SOURCES.releases;
        return await getGithubReleaseFolder({
            ...src,
            includePrereleases
        });
    }
    if (filterName === 'bootloader') {
        const src = GITHUB_FILE_SOURCES.bootloader;
        return await getGithubReleaseFolder({
            ...src,
            includePrereleases: true
        });
    }
    return null;
}

export default defineEventHandler(async (event) => {
    const query = getQuery(event);
    const includePrereleases = query.prereleases !== undefined;
    const filter = query.filter?.toString().split(',') ?? ['releases', 'kiss-ultra-releases', 'bootloader', 'tools', 'unlocker'];

    const sectionConfigs: SectionConfig[] = [
        {
            filterName: 'releases',
            folderName: 'releases',
            bucketName: 'releases',
            cacheNamespace: 'releases',
            storageName: 'releases',
            nested: true,
            includePrereleaseFilter: true
        },
        {
            filterName: 'kiss-ultra-releases',
            folderName: 'kiss-ultra-releases',
            bucketName: 'kiss-ultra-releases',
            cacheNamespace: 'kiss-ultra-releases',
            storageName: 'kiss-ultra-releases',
            nested: true
        },
        {
            filterName: 'bootloader',
            folderName: 'bootloader',
            bucketName: 'bootloaders',
            cacheNamespace: 'bootloaders',
            storageName: 'bootloaders',
            nested: true
        },
        {
            filterName: 'tools',
            folderName: 'tools',
            bucketName: 'am32-tools',
            cacheNamespace: 'tools',
            storageName: 'tools',
            nested: false
        },
        {
            filterName: 'unlocker',
            folderName: 'unlocker',
            bucketName: 'unlocker',
            cacheNamespace: 'unlocker',
            storageName: 'unlocker',
            nested: true
        }
    ];

    const useMinioBackend = isMinioConfigured();
    const minioClient = useMinioBackend ? useMinio() : null;
    const folders: BlobFolder[] = [];

    if (!useMinioBackend) {
        console.info('[api/files] MinIO not configured — using GitHub Releases for firmware/bootloader');
    }

    for (const section of sectionConfigs) {
        if (!filter.includes(section.filterName)) {
            continue;
        }

        try {
            if (!useMinioBackend || !minioClient) {
                const githubFolder = await getSectionFromGithub(
                    section.filterName,
                    section.includePrereleaseFilter ? includePrereleases : true
                );
                folders.push(githubFolder ?? emptyFolder(section.folderName));
                continue;
            }

            const cache = useStorage(section.storageName);
            const entries = await getCachedObjects(
                minioClient,
                cache,
                section.bucketName,
                section.cacheNamespace
            );

            folders.push(section.nested
                ? buildNestedFolder(
                    section.folderName,
                    entries,
                    section.bucketName,
                    section.cacheNamespace,
                    section.includePrereleaseFilter ? includePrereleases : true
                )
                : buildFlatFolder(section.folderName, entries, section.bucketName, section.cacheNamespace));
        } catch (err) {
            console.error(`[api/files] failed for ${section.filterName}:`, err);

            // Fall back to GitHub for firmware sections if MinIO fails
            try {
                const githubFolder = await getSectionFromGithub(
                    section.filterName,
                    section.includePrereleaseFilter ? includePrereleases : true
                );
                if (githubFolder) {
                    folders.push(githubFolder);
                    continue;
                }
            } catch (ghErr) {
                console.error(`[api/files] GitHub fallback failed for ${section.filterName}:`, ghErr);
            }

            folders.push(emptyFolder(section.folderName));
        }
    }

    return {
        data: folders
    };
});
