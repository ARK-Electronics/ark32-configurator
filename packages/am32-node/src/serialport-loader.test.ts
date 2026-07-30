/**
 * The `serialport` loader's fallback chain and its failure message.
 *
 * The chain matters because `ark32` ships in two forms that resolve the module
 * differently (issue #3 section 6) and only one of them can be exercised here --
 * an npm install resolves the bare specifier, a standalone binary resolves a path
 * next to the executable. Both are covered with an injected importer, so the case
 * this machine cannot reproduce is still pinned.
 *
 * The failure message matters because it is the only thing a user sees when a
 * native module will not load, and "cannot find module" with no context is how
 * that turns into a support thread.
 */

import { describe, expect, it } from 'vitest';
import {
    SERIALPORT_MISSING_HINT,
    SerialPortUnavailableError,
    listSerialPorts,
    loadSerialPortModule,
    serialPortCandidates
} from './serialport-loader';
import type { NodePortInfo } from './serialport-types';

/** A stand-in for the package: only the two members the loader checks for. */
function fakeModule (ports: NodePortInfo[] = []) {
    class FakeSerialPort {
        static list (): Promise<NodePortInfo[]> {
            return Promise.resolve(ports);
        }
    }
    return { SerialPort: FakeSerialPort };
}

describe('serialPortCandidates', () => {
    it('tries the bare specifier first', () => {
        const [first] = serialPortCandidates('/opt/ark32/ark32');

        // An npm install is the only case where the bare specifier is correct, and
        // preferring a path would silently pick up a stale copy sitting next to
        // some unrelated executable.
        expect(first).toBe('serialport');
    });

    it('then a copy beside the executable, as a file: URL', () => {
        const candidates = serialPortCandidates('/opt/ark32/ark32');

        expect(candidates).toHaveLength(2);
        expect(candidates[1]).toBe('file:///opt/ark32/node_modules/serialport/dist/index.js');
    });
});

describe('loadSerialPortModule', () => {
    it('returns the first candidate that loads', async () => {
        const tried: string[] = [];
        const module = await loadSerialPortModule({
            candidates: ['first', 'second'],
            importModule: (specifier) => {
                tried.push(specifier);
                return Promise.resolve(fakeModule());
            }
        });

        expect(tried).toEqual(['first']);
        expect(typeof module.SerialPort.list).toBe('function');
    });

    it('falls through to the next candidate when one throws', async () => {
        const tried: string[] = [];
        const module = await loadSerialPortModule({
            candidates: ['serialport', 'file:///opt/ark32/node_modules/serialport/dist/index.js'],
            importModule: (specifier) => {
                tried.push(specifier);
                if (specifier === 'serialport') {
                    return Promise.reject(new Error("Cannot find module 'serialport'"));
                }
                return Promise.resolve(fakeModule());
            }
        });

        // This is the standalone-binary path: no node_modules around the
        // executable's resolution root, so the bare specifier cannot work.
        expect(tried).toHaveLength(2);
        expect(module.SerialPort).toBeTypeOf('function');
    });

    it('rejects a module that loads but is not the package', async () => {
        // A half-installed dependency resolves to an empty namespace object. Without
        // this check that surfaces as "undefined is not a constructor" a long way
        // from here.
        await expect(loadSerialPortModule({
            candidates: ['serialport'],
            importModule: () => Promise.resolve({})
        })).rejects.toThrow(SerialPortUnavailableError);

        await expect(loadSerialPortModule({
            candidates: ['serialport'],
            importModule: () => Promise.resolve({ SerialPort: { } })
        })).rejects.toThrow('does not export a SerialPort class');
    });

    it('names every specifier it tried, and why each failed', async () => {
        const failure = await loadSerialPortModule({
            candidates: ['serialport', 'file:///opt/ark32/node_modules/serialport/dist/index.js'],
            importModule: specifier => Promise.reject(new Error(`no ${specifier}`)),
            execPath: '/opt/ark32/ark32'
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(SerialPortUnavailableError);
        const error = failure as SerialPortUnavailableError;
        expect(error.attempts.map(a => a.specifier)).toEqual([
            'serialport',
            'file:///opt/ark32/node_modules/serialport/dist/index.js'
        ]);
        expect(error.message).toContain(SERIALPORT_MISSING_HINT);
        expect(error.message).toContain('tried serialport: no serialport');
        // The hint has to name --sim: a user whose native module will not load can
        // still do everything that does not touch hardware.
        expect(error.message).toContain('--sim');
    });

    it('derives its candidates from execPath when none are given', async () => {
        const tried: string[] = [];
        await loadSerialPortModule({
            execPath: '/opt/ark32/ark32',
            importModule: (specifier) => {
                tried.push(specifier);
                return Promise.reject(new Error('nope'));
            }
        }).catch(() => {});

        expect(tried).toEqual(serialPortCandidates('/opt/ark32/ark32'));
    });
});

describe('listSerialPorts', () => {
    it('returns the module\'s listing untouched', async () => {
        const ports: NodePortInfo[] = [
            { path: '/dev/ttyACM0', vendorId: '0483', productId: '5740', manufacturer: 'ARK' },
            { path: '/dev/ttyS0' }
        ];

        const listed = await listSerialPorts({
            candidates: ['serialport'],
            importModule: () => Promise.resolve(fakeModule(ports))
        });

        // Unfiltered on purpose: a CLI that hides the port the user is holding is
        // worse than one that lists a few they do not want. `ark32 ports` prints
        // VID:PID so they can tell which is which.
        expect(listed).toEqual(ports);
    });

    it('propagates the loader failure rather than reporting no ports', async () => {
        await expect(listSerialPorts({
            candidates: ['serialport'],
            importModule: () => Promise.reject(new Error('no binding for linux-riscv64'))
        })).rejects.toThrow('no binding for linux-riscv64');
    });
});
