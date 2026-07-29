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

const databaseUrl = readEnv('DATABASE_URL');
const mysqlHost = readEnv('MYSQL_HOST') || readEnv('NUXT_MARIADB_HOST');

console.info('[start] NODE_ENV=', readEnv('NODE_ENV'));
console.info('[start] HOST=', readEnv('HOST') || readEnv('NITRO_HOST'));
console.info('[start] PORT=', readEnv('PORT'));
console.info(
    '[start] DATABASE_URL set=',
    Boolean(databaseUrl),
    databaseUrl
        ? `(host hint: ${databaseUrl.replace(/^.*@/, '').replace(/\/.*$/, '')})`
        : ''
);
console.info('[start] MYSQL_HOST=', mysqlHost || '(unset)');

if (isUsableDatabaseUrl(databaseUrl)) {
    console.info('[start] Running prisma migrate deploy…');
    const migrate = spawnSync(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
        { stdio: 'inherit', env: process.env, shell: false }
    );
    if (migrate.status !== 0) {
        console.error(
            '[start] prisma migrate deploy failed (exit',
            migrate.status,
            '). Booting app anyway — fix DATABASE_URL / DB connectivity.'
        );
    }
} else {
    console.warn(
        '[start] Skipping migrations: set a real DATABASE_URL (Sevalla internal MySQL/MariaDB host, not 127.0.0.1).'
    );
}

console.info('[start] Starting Nitro…');
const server = spawnSync('node', ['.output/server/index.mjs'], {
    stdio: 'inherit',
    env: process.env,
    shell: false
});
process.exit(server.status ?? 1);
