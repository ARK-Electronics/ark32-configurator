import * as Minio from 'minio';

/**
 * MinIO is only required for the hosted firmware catalog (release flash / downloads).
 * Local .hex flash does not use this.
 */
export const isMinioConfigured = () => {
    const endPoint = (process.env.MINIO_URL ?? '').trim();
    return endPoint.length > 0;
};

export const useMinio = () => {
    const endPoint = (process.env.MINIO_URL ?? '').trim();
    if (!endPoint) {
        throw new Error('MINIO_URL is not set (firmware catalog unavailable)');
    }

    return new Minio.Client({
        endPoint,
        port: Number(process.env.MINIO_PORT ?? 443),
        useSSL: (process.env.MINIO_USE_SSL ?? 'true') !== 'false',
        accessKey: process.env.MINIO_ACCESS_KEY ?? '',
        secretKey: process.env.MINIO_SECRET_KEY ?? ''
    });
};
