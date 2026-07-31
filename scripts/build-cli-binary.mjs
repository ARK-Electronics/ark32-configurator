#!/usr/bin/env node
/**
 * Build the standalone `ark32` for the host platform, plus the runtime it needs.
 *
 * Issue #3 section 6 asks for "single-file binaries ... for users without Node.
 * Five artifacts, one codebase", and is explicit about the one place that claim
 * bends: "`serialport` is a native N-API module, so no JS bundler -- esbuild,
 * `pkg`, Node SEA, `bun --compile` -- can produce one universal artifact. Each
 * target needs its own `.node` binding compiled in."
 *
 * So each artifact is a **directory**, archived per target:
 *
 *   ark32[.exe]              the SEA: Node plus the whole bundled CLI, one file
 *   node_modules/serialport  the native runtime, and only for hardware commands
 *
 * `--sim`, `--help` and `--version` work from the executable alone.
 * `packages/am32-node/src/serialport-loader.ts` resolves the sibling copy, and its
 * candidate list is where that layout is written down.
 *
 * ## Why `node_modules` is copied rather than installed
 *
 * `CLAUDE.md` forbids `npm install` in this repo, and it does not need one:
 * `@serialport/bindings-cpp` ships prebuilds for *every* target inside its own
 * tarball (`prebuilds/linux-x64`, `darwin-x64+arm64`, `win32-x64`, ...), so the
 * copy Yarn already installed is correct for all five. That also means this script
 * needs no network and no compiler.
 *
 * ## Why `require` is not enough inside a SEA
 *
 * Node's SEA gives the injected main script a `require` that "can only be used to
 * load built-in modules". A dynamic `import()` of an absolute `file:` URL goes
 * through the ESM loader instead and does work -- which is exactly why the loader's
 * second candidate is a `file:` URL and not a bare specifier.
 *
 * Usage: node scripts/build-cli-binary.mjs [--out DIR]
 */

import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const pkgDir = join(repo, 'packages', 'am32-cli');

/** Stable across Node versions; Node's own SEA documentation specifies it. */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const outIndex = process.argv.indexOf('--out');
const outDir = outIndex === -1
    ? join(pkgDir, 'dist', 'standalone')
    : join(process.cwd(), process.argv[outIndex + 1] ?? 'standalone');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exeName = isWindows ? 'ark32.exe' : 'ark32';

const run = (command, args, options = {}) =>
    execFileSync(command, args, { stdio: 'inherit', ...options });

const say = (message) => process.stdout.write(`${message}\n`);

// ---- 1. the bundle ---------------------------------------------------------

run(process.execPath, [join(here, 'build-cli.mjs')]);

const cjs = join(pkgDir, 'dist', 'ark32.cjs');
if (!existsSync(cjs)) {
    throw new Error('build-cli.mjs did not produce dist/ark32.cjs');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ---- 2. the SEA blob -------------------------------------------------------

/**
 * The blob is built from a **throwaway copy** of the bundle, and that is not
 * incidental.
 *
 * Node bakes the main script's path into the executable and uses it as the parent
 * for bare-specifier resolution -- so a blob built from
 * `packages/am32-cli/dist/ark32.cjs` produces a binary that resolves
 * `import('serialport')` out of *this repo's* `node_modules`, on any machine that
 * happens to have that path. It looked like a success when I first tested it: the
 * standalone binary listed real serial ports from a directory with no
 * `node_modules` anywhere above it, because it had reached back into the build
 * tree.
 *
 * Building from a directory that is then deleted makes the bare specifier fail
 * exactly as it will on a user's machine, so the beside-the-executable candidate is
 * the one that runs -- and can therefore be tested.
 */
const staging = mkdtempSync(join(tmpdir(), 'ark32-sea-'));
const stagedMain = join(staging, 'ark32.cjs');
cpSync(cjs, stagedMain);

const seaConfig = join(staging, 'sea-config.json');
const blob = join(pkgDir, 'dist', 'ark32.blob');
writeFileSync(seaConfig, `${JSON.stringify({
    main: stagedMain,
    output: blob,
    disableExperimentalSEAWarning: true,
    // Off deliberately: a code cache is tied to the exact V8 version that built
    // it, and a stale one is a crash rather than a slow start.
    useCodeCache: false,
    useSnapshot: false
}, null, 2)}\n`);

run(process.execPath, ['--experimental-sea-config', seaConfig]);
rmSync(staging, { recursive: true, force: true });

// ---- 3. inject it into a copy of Node --------------------------------------

const exe = join(outDir, exeName);
cpSync(process.execPath, exe);
chmodSync(exe, 0o755);

if (isMac) {
    // postject cannot inject into a signed Mach-O, and macOS will not run an
    // unsigned one. Strip, inject, then ad-hoc sign.
    try {
        run('codesign', ['--remove-signature', exe]);
    } catch {
        say('  (no existing signature to remove)');
    }
}

const postject = join(repo, 'node_modules', '.bin', isWindows ? 'postject.cmd' : 'postject');
run(postject, [
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse', SENTINEL_FUSE,
    ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : [])
]);

if (isMac) {
    run('codesign', ['--sign', '-', exe]);
}

// ---- 4. stage the native runtime beside it ---------------------------------

/**
 * Copy `serialport` and its transitive dependencies out of the repo's own
 * `node_modules`.
 *
 * Resolved from the hoisted root rather than by `require.resolve`, because a
 * nested copy would be missed and a hoisted one found twice. Optional and peer
 * dependencies are skipped: `serialport`'s tree has none that matter at runtime,
 * and following them would drag in build tooling.
 */
function stageRuntime (rootPackage, destination) {
    const seen = new Set();
    const queue = [rootPackage];

    while (queue.length > 0) {
        const name = queue.shift();
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);

        const from = join(repo, 'node_modules', name);
        const manifestPath = join(from, 'package.json');
        if (!existsSync(manifestPath)) {
            throw new Error(
                `${name} is not in node_modules. Run 'yarn install' before building the binary.`
            );
        }

        cpSync(from, join(destination, name), { recursive: true, dereference: true });

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (const dependency of Object.keys(manifest.dependencies ?? {})) {
            queue.push(dependency);
        }
    }

    return [...seen].sort();
}

const staged = stageRuntime('serialport', join(outDir, 'node_modules'));

// ---- 5. a README, because an archive with two things in it needs one -------

const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
writeFileSync(join(outDir, 'README.txt'), `ark32 ${version} -- standalone build for ${process.platform}-${process.arch}

  ./${exeName} --help

Keep ${exeName} and node_modules/ together. The executable is self-contained for
everything that does not touch a serial port -- --sim, --help, --version -- and
loads node_modules/serialport for the commands that do. serialport is a native
N-API addon, so it cannot be bundled into the executable; see
packages/am32-node/src/serialport-loader.ts in the source tree.

If you have Node 20 or newer, 'npm i -g @ark/am32-cli' is the simpler install.
`);

// ---- 6. say what was produced ---------------------------------------------

const size = statSync(exe).size;
say('');
say(`ark32 ${version} standalone for ${process.platform}-${process.arch}`);
say(`  ${exeName}  ${(size / 1024 / 1024).toFixed(1)} MiB`);
say(`  node_modules/  ${staged.length} packages: ${staged.join(' ')}`);
say(`  in ${outDir}`);
