import { basename, extname } from 'path';
import { isMinioConfigured, useMinio } from '~/composables/useMinio';

const MIME_TYPES: Record<string, string> = {
    '.hex': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.zip': 'application/zip',
    '.txt': 'text/plain; charset=utf-8'
};

type DownloadPayload = {
    bucketName: string,
    objectPath: string
};

function parsePayload (value: string): DownloadPayload {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DownloadPayload>;

    if (!payload.bucketName || !payload.objectPath) {
        throw new Error('Invalid download payload');
    }

    return {
        bucketName: payload.bucketName,
        objectPath: payload.objectPath.replace(':', '/')
    };
}

function getContentDisposition (fileName: string) {
    const escapedFileName = fileName.replace(/(["\\])/g, '\\$1');

    return `attachment; filename="${escapedFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export default defineEventHandler(async (event) => {
    const name = getRouterParam(event, 'name');

    if (!name) {
        throw createError({
            statusCode: 404,
            statusMessage: 'not found'
        });
    }

    let payload: DownloadPayload;

    try {
        payload = parsePayload(name);
    } catch {
        throw createError({
            statusCode: 400,
            statusMessage: 'invalid file request'
        });
    }

    if (!isMinioConfigured()) {
        throw createError({
            statusCode: 503,
            statusMessage: 'object storage not configured'
        });
    }

    const minioClient = useMinio();

    try {
        const fileName = basename(payload.objectPath);
        const contentType = MIME_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
        const stat = await minioClient.statObject(payload.bucketName, payload.objectPath);
        const stream = await minioClient.getObject(payload.bucketName, payload.objectPath);

        setResponseHeader(event, 'Content-Type', contentType);
        setResponseHeader(event, 'Content-Disposition', getContentDisposition(fileName));
        setResponseHeader(event, 'Content-Length', stat.size);

        return sendStream(event, stream);
    } catch {
        throw createError({
            statusCode: 404,
            statusMessage: 'not found'
        });
    }
});
