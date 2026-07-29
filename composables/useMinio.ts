import * as Minio from 'minio';

/** Dynamic env read — avoid Nitro baking empty placeholders at build time. */
function env (name: string): string | undefined {
    const value = process.env[name];
    return value !== undefined && value !== '' ? value : undefined;
}

/**
 * Sevalla / production: set MINIO_URL (hostname only, no protocol),
 * MINIO_ACCESS_KEY, MINIO_SECRET_KEY. Optional MINIO_PORT (default 443),
 * MINIO_USE_SSL (default true).
 */
export function isMinioConfigured (): boolean {
    const endPoint = env('MINIO_URL') || env('MINIO_ENDPOINT');
    const accessKey = env('MINIO_ACCESS_KEY');
    const secretKey = env('MINIO_SECRET_KEY');
    return Boolean(endPoint && accessKey && secretKey);
}

export const useMinio = () => {
    const endPoint = env('MINIO_URL') || env('MINIO_ENDPOINT');
    if (!endPoint) {
        throw new Error(
            'MinIO is not configured. Set MINIO_URL, MINIO_ACCESS_KEY, and MINIO_SECRET_KEY, ' +
            'or rely on the GitHub releases fallback for firmware files.'
        );
    }

    // Allow full URLs in env; MinIO client wants host only
    const host = endPoint
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '');

    const port = Number(env('MINIO_PORT') || 443);
    const useSSL = (env('MINIO_USE_SSL') ?? 'true').toLowerCase() !== 'false';

    return new Minio.Client({
        endPoint: host,
        port,
        useSSL,
        accessKey: env('MINIO_ACCESS_KEY') ?? '',
        secretKey: env('MINIO_SECRET_KEY') ?? ''
    });
};
