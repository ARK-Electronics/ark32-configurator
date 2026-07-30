/**
 * The only file that names the `serialport` package.
 *
 * It is reached through a dynamic `import()` so that `ark32 --sim`, `ark32
 * --help` and the whole test suite never load an N-API addon they have no use
 * for. That matters more than it sounds: a native module that fails to load
 * (wrong ABI, missing prebuild, a musl host) would otherwise make every command
 * fail, including the ones with no hardware in them.
 *
 * ## Why there is a candidate list
 *
 * Two shipping forms, per issue #3 section 6, and they resolve the module
 * differently:
 *
 *  - **npm.** `serialport` is a real dependency, so a bare `import('serialport')`
 *    finds it. `@serialport/bindings-cpp` ships prebuilds for linux x64/arm64,
 *    darwin x64+arm64 and win32 x64/arm64/ia32 inside its own tarball, so this
 *    needs no compiler and no download.
 *  - **The single-file binaries.** A bundled executable has no `node_modules`
 *    around it and no package resolution root, so the bare specifier fails. The
 *    per-target archive puts the target's `serialport` next to the executable,
 *    and {@link serialPortCandidates} is where that layout is written down.
 *
 * The plan is explicit that this is the one place the "single file" claim bends:
 * "`serialport` is a native N-API module, so no JS bundler can produce one
 * universal artifact. Each target needs its own `.node` binding compiled in."
 * Everything else in the binary is one file.
 */

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NodePortInfo, SerialPortModuleLike } from './serialport-types';

/** How a module specifier is loaded. Injected so the fallback chain is testable. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

export interface LoadSerialPortOptions {
    importModule?: ModuleImporter
    /** Overrides the default chain. Mostly for tests. */
    candidates?: readonly string[]
    /** Defaults to `process.execPath`. */
    execPath?: string
}

/**
 * Specifiers to try, in order.
 *
 * The bare specifier first, always: on an npm install it is the only correct
 * answer, and trying a path first would silently prefer a stale copy sitting
 * next to some unrelated executable.
 */
export function serialPortCandidates (execPath: string): string[] {
    const beside = join(dirname(execPath), 'node_modules', 'serialport', 'dist', 'index.js');
    return ['serialport', pathToFileURL(beside).href];
}

function looksLikeTheModule (value: unknown): value is SerialPortModuleLike {
    const candidate: unknown = (value as { SerialPort?: unknown } | null)?.SerialPort;
    if (typeof candidate !== 'function') {
        return false;
    }
    return typeof (candidate as { list?: unknown }).list === 'function';
}

/**
 * The advice that goes with a failure, kept next to the failure so the CLI does
 * not have to know how this package is installed.
 */
export const SERIALPORT_MISSING_HINT =
    'ark32 needs the native `serialport` module to reach a real flight controller. ' +
    'Install the CLI from npm (`npm i -g @ark/am32-cli`), or run against the ' +
    'simulator with `--sim`, which needs no hardware and no native module.';

export class SerialPortUnavailableError extends Error {
    constructor (readonly attempts: { specifier: string, error: string }[]) {
        super(
            `could not load the serialport module. ${SERIALPORT_MISSING_HINT}\n` +
            attempts.map(a => `  tried ${a.specifier}: ${a.error}`).join('\n')
        );
        this.name = 'SerialPortUnavailableError';
    }
}

/**
 * Load `serialport`, or throw a {@link SerialPortUnavailableError} that says
 * every specifier it tried and why each one failed.
 *
 * A module that loads but is not the package we expect is a failure too -- an
 * empty namespace object from a half-installed dependency would otherwise
 * surface as `undefined is not a constructor` a long way from here.
 */
export async function loadSerialPortModule (
    options: LoadSerialPortOptions = {}
): Promise<SerialPortModuleLike> {
    const importModule = options.importModule ?? (specifier => import(specifier));
    const candidates = options.candidates ?? serialPortCandidates(options.execPath ?? process.execPath);

    const attempts: { specifier: string, error: string }[] = [];
    for (const specifier of candidates) {
        try {
            const loaded = await importModule(specifier);
            if (looksLikeTheModule(loaded)) {
                return loaded;
            }
            attempts.push({
                specifier,
                error: 'loaded, but does not export a SerialPort class with a list() method'
            });
        } catch (error) {
            attempts.push({ specifier, error: error instanceof Error ? error.message : String(error) });
        }
    }

    throw new SerialPortUnavailableError(attempts);
}

/**
 * Every serial port the OS knows about.
 *
 * Unfiltered on purpose: the app's port picker filters on a vendor-ID allow-list
 * because a browser prompt has to, but a CLI that hides the port the user is
 * holding is worse than one that lists a few they do not want. `ark32 ports`
 * prints VID:PID so they can tell.
 */
export async function listSerialPorts (options: LoadSerialPortOptions = {}): Promise<NodePortInfo[]> {
    const { SerialPort } = await loadSerialPortModule(options);
    return SerialPort.list();
}
