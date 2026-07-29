#!/usr/bin/env node
/**
 * Production entrypoint for Sevalla / Docker.
 * - Never runs migrations against localhost / missing DATABASE_URL
 * - Always boots the Nitro server so the site stays up even if DB is wrong
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

function readEnv (name) {
    // Dynamic access — avoids build-time env inlining traps
    return process.env[name];
}

function isUsableDatabaseUrl (url) {
    if (!url || typeof url !== 'string') {
        return false;
    }
    const trimmed = url.trim();
    if (!trimmed) {
        return false;
    }
    // Refuse loopback / generate placeholders — those will never work in Sevalla
    if (
        /127\.0\.0\.1|localhost|prisma-generate\.invalid|@build:build@/i.test(
            trimmed
        )
    ) {
        return false;
    }
    return /^mysql(s)?:\/\//i.test(trimmed);
}

// Sevalla injects DB_URL by default; also accept DATABASE_URL
const databaseUrl = readEnv('DATABASE_URL') || readEnv('DB_URL');
const mysqlHost =
    readEnv('MYSQL_HOST') ||
    readEnv('DB_HOST') ||
    readEnv('NUXT_MARIADB_HOST');

console.info('[start] NODE_ENV=', readEnv('NODE_ENV'));
console.info('[start] HOST=', readEnv('HOST') || readEnv('NITRO_HOST'));
console.info('[start] PORT=', readEnv('PORT'));
console.info(
    '[start] DATABASE_URL/DB_URL set=',
    Boolean(databaseUrl),
    databaseUrl
        ? `(host hint: ${databaseUrl.replace(/^.*@/, '').replace(/\/.*$/, '')})`
        : ''
);
console.info('[start] DB_HOST/MYSQL_HOST=', mysqlHost || '(unset)');

if (isUsableDatabaseUrl(databaseUrl)) {
    // Prisma CLI reads DATABASE_URL — mirror Sevalla's DB_URL if needed
    const migrateEnv = {
        ...process.env,
        DATABASE_URL: databaseUrl
    };
    console.info('[start] Running prisma migrate deploy…');
    const migrate = spawnSync(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
        { stdio: 'inherit', env: migrateEnv, shell: false }
    );
    if (migrate.status !== 0) {
        console.error(
            '[start] prisma migrate deploy failed (exit',
            migrate.status,
            '). Booting app anyway — fix DB_URL / DATABASE_URL / DB connectivity.'
        );
    }
} else if (mysqlHost && !isUsableDatabaseUrl(databaseUrl)) {
    // Build a URL from Sevalla discrete vars so migrate still works
    const user = readEnv('DB_USERNAME') || readEnv('DB_USER') || readEnv('MYSQL_USER');
    const password = readEnv('DB_PASSWORD') || readEnv('MYSQL_PASSWORD') || '';
    const database = readEnv('DB_DATABASE') || readEnv('DB_NAME') || readEnv('MYSQL_DATABASE');
    const port = readEnv('DB_PORT') || readEnv('MYSQL_PORT') || '3306';
    if (user && database && mysqlHost && !/127\.0\.0\.1|localhost/i.test(mysqlHost)) {
        const built = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${mysqlHost}:${port}/${database}`;
        console.info('[start] Built DATABASE_URL from DB_* vars; running migrate…');
        const migrate = spawnSync(
            process.execPath,
            ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
            {
                stdio: 'inherit',
                env: { ...process.env, DATABASE_URL: built },
                shell: false
            }
        );
        if (migrate.status !== 0) {
            console.error(
                '[start] prisma migrate deploy failed (exit',
                migrate.status,
                '). Booting app anyway.'
            );
        }
    } else {
        console.warn(
            '[start] Skipping migrations: need DB_URL/DATABASE_URL or complete DB_* vars (not localhost).'
        );
    }
} else {
    console.warn(
        '[start] Skipping migrations: set DB_URL or DATABASE_URL (Sevalla internal host, not 127.0.0.1).'
    );
}

console.info('[start] Starting Nitro…');
const server = spawnSync('node', ['.output/server/index.mjs'], {
    stdio: 'inherit',
    env: process.env,
    shell: false
});
process.exit(server.status ?? 1);
