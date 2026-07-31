#!/usr/bin/env node
/**
 * Bundle `ark32` into `packages/am32-cli/dist/`.
 *
 * The rest of this repo has no build step -- Nuxt consumes `am32-core` straight
 * from TypeScript source, and `yarn test` runs the packages as source too. The CLI
 * is the one thing that needs one, for two reasons that are both about shipping it
 * to someone else's machine: `npm i -g @ark/am32-cli` has to install one package
 * rather than four unpublished workspace ones, and the standalone binaries need a
 * single script for Node's SEA to embed.
 *
 * Two outputs, and the difference matters:
 *
 *  - **`ark32.mjs`** -- ESM, what `package.json`'s `bin` points at, what the npm
 *    install runs.
 *  - **`ark32.cjs`** -- CommonJS, for `node --experimental-sea-config`. Node's SEA
 *    only takes a CJS main script, which is also why `src/main.ts` uses `.then()`
 *    rather than top-level await: esbuild cannot lower TLA into CJS.
 *
 * `serialport` is **external** in both. It is an N-API addon, so no bundler can
 * inline its `.node` binding -- issue #3 section 6 says as much -- and
 * `packages/am32-node/src/serialport-loader.ts` is where the two shipping forms'
 * resolution is written down.
 *
 * Usage:
 *   node scripts/build-cli.mjs           # both outputs
 *   node scripts/build-cli.mjs --check   # verify the version, build nothing
 */

import { chmodSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const pkgDir = join(repo, 'packages', 'am32-cli');
const outDir = join(pkgDir, 'dist');

const SHEBANG = '#!/usr/bin/env node';

/**
 * The manifest and `src/version.ts` must agree.
 *
 * The version is a constant in the source rather than a `package.json` read
 * because the bundle ships with no manifest beside it. This is what stops that
 * duplication from drifting: a release whose `--version` lies is worse than one
 * that fails to build.
 */
function checkVersion () {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const source = readFileSync(join(pkgDir, 'src', 'version.ts'), 'utf8');
    const match = /VERSION = '([^']+)'/.exec(source);

    if (!match) {
        throw new Error('packages/am32-cli/src/version.ts does not export a VERSION string');
    }
    if (match[1] !== manifest.version) {
        throw new Error(
            `version drift: package.json says ${manifest.version}, ` +
            `src/version.ts says ${match[1]}. Change both.`
        );
    }
    return manifest.version;
}

const version = checkVersion();

if (process.argv.includes('--check')) {
    process.stdout.write(`ark32 ${version}: version.ts and package.json agree\n`);
    process.exit(0);
}

// A stale bundle that looks fresh is the failure mode block 6 lost an hour to.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
    entryPoints: [join(pkgDir, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    // Matches .nvmrc (v20.20.2), which is what CI builds with and the floor
    // `engines.node` declares.
    target: 'node20',
    external: ['serialport'],
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    banner: { js: SHEBANG }
};

await build({ ...common, format: 'esm', outfile: join(outDir, 'ark32.mjs') });
await build({ ...common, format: 'cjs', outfile: join(outDir, 'ark32.cjs') });

for (const name of ['ark32.mjs', 'ark32.cjs']) {
    const path = join(outDir, name);
    // esbuild writes 0644, and `package.json`'s `bin` points straight at this file.
    // Yarn chmods a bin link at install time, so without this a *rebuild* silently
    // leaves `node_modules/.bin/ark32` unexecutable until the next `yarn install` --
    // which is exactly how the gate found it.
    chmodSync(path, 0o755);

    const size = statSync(path).size;
    const head = readFileSync(path, 'utf8').slice(0, SHEBANG.length);
    if (head !== SHEBANG) {
        throw new Error(`${name} lost its shebang`);
    }
    process.stdout.write(`ark32 ${version}  ${name}  ${(size / 1024).toFixed(0)} KiB\n`);
}
