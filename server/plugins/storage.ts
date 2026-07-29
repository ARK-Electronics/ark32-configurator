import redisDriver from 'unstorage/drivers/redis';

export default defineNitroPlugin(() => {
    const storage = useStorage();
    const redisHost =
        process.env.REDIS_HOST ||
        process.env.NUXT_REDIS_HOST ||
        (useRuntimeConfig().redis.host as string | undefined);

    // Without Redis, leave default memory drivers so the app still boots on Sevalla.
    if (!redisHost) {
        console.warn(
            '[storage] REDIS_HOST unset — using in-memory caches (fine for basic deploys).'
        );
        return;
    }

    const port = Number(
        process.env.REDIS_PORT ||
        process.env.NUXT_REDIS_PORT ||
        useRuntimeConfig().redis.port ||
        6379
    );

    const tools = redisDriver({
        base: 'redis',
        host: redisHost,
        port,
        db: 0
    });

    const releases = redisDriver({
        base: 'redis',
        host: redisHost,
        port,
        db: 1
    });

    const bootloaders = redisDriver({
        base: 'redis',
        host: redisHost,
        port,
        db: 2
    });

    const binaries = redisDriver({
        base: 'redis',
        host: redisHost,
        port,
        db: 3
    });

    const schema = redisDriver({
        base: 'redis',
        host: redisHost,
        port,
        db: 4
    });

    const kissUltra = redisDriver({
        base: 'redis',
        host: redisHost,
        port,
        db: 5
    });

    storage.mount('tools', tools);
    storage.mount('releases', releases);
    storage.mount('bootloaders', bootloaders);
    storage.mount('binaries', binaries);
    storage.mount('schema', schema);
    storage.mount('kiss-ultra', kissUltra);
});
