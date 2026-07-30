/**
 * The whole CLI, end to end, against the simulator.
 *
 * `run()` takes its filesystem and its hardware through {@link CliEnv}, so every
 * command and every exit code is reachable here with no serial port and no disk.
 * The simulator is *not* injected: `--sim` builds its own rig from
 * `createSimHarness`, which is the point (issue #3 section 3) -- a test that handed
 * `run()` a hand-built simulator would prove nothing about what `--sim` does on a
 * user's machine.
 *
 * The two commands issue #3's block-7 done-when names have a suite of their own at
 * the bottom, and `scripts/assert-cli-sim.sh` runs the same two lines against the
 * built binary. Both, because they check different things: this proves the
 * behaviour, the gate proves the *binary* has it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EepromLayout } from 'am32-core/eeprom/layout';
import { Mcu } from 'am32-core/mcu';
import { SessionError } from 'am32-core/errors';
import type { CliEnv, OpenPortRequest } from './env';
import { EXIT_CONNECT, EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from './exit';
import { run } from './run';

const FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/fixture.bin', import.meta.url)));

// ---- the fake environment ---------------------------------------------------

interface Result {
    code: number
    stdout: string
    stderr: string
    /** Files the run wrote, by path. */
    files: Map<string, Uint8Array>
    /** Parsed stdout. Throws if stdout is not exactly one JSON object. */
    json: () => Record<string, unknown>
}

interface FakeOptions {
    /** Seed the in-memory filesystem. */
    files?: Record<string, Uint8Array | string>
    /** What `openPort` does. Rejects by default: these tests are all --sim. */
    openPort?: (request: OpenPortRequest) => Promise<never>
    /** What `listPorts` returns. */
    listPorts?: () => Promise<{ path: string, vendorId?: string, productId?: string }[]>
}

async function cli (argv: string[], options: FakeOptions = {}): Promise<Result> {
    let stdout = '';
    let stderr = '';
    const written = new Map<string, Uint8Array>();
    const seeded = new Map<string, Uint8Array>();
    for (const [path, value] of Object.entries(options.files ?? {})) {
        seeded.set(path, typeof value === 'string' ? new TextEncoder().encode(value) : value);
    }

    const env: CliEnv = {
        stdout: (text) => {
            stdout += text;
        },
        stderr: (text) => {
            stderr += text;
        },
        readFile: (path) => {
            const bytes = seeded.get(path);
            return bytes
                ? Promise.resolve(bytes)
                : Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
        },
        readTextFile: (path) => {
            const bytes = seeded.get(path);
            return bytes
                ? Promise.resolve(new TextDecoder().decode(bytes))
                : Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
        },
        writeFile: (path, data) => {
            written.set(path, Uint8Array.from(data));
            return Promise.resolve();
        },
        ensureDir: () => Promise.resolve(),
        joinPath: (...parts) => parts.join('/'),
        openPort: options.openPort ?? (() => Promise.reject(
            new SessionError('transport', 'no serial port in this test')
        )),
        listPorts: options.listPorts ?? (() => Promise.resolve([])),
        version: '0.0.0-test'
    };

    const code = await run(argv, env);
    return {
        code,
        stdout,
        stderr,
        files: written,
        json: () => JSON.parse(stdout) as Record<string, unknown>
    };
}

/** Every `escs` entry of a JSON envelope. */
function escsOf (result: Result): Record<string, unknown>[] {
    return result.json().escs as Record<string, unknown>[];
}

// ---- Intel HEX generation (mirrors the simulator's own integration tests) ----

const FLASH_OFFSET = 0x08000000;

function hexRecord (type: number, address: number, data: number[]): string {
    const bytes = [data.length, (address >> 8) & 0xFF, address & 0xFF, type, ...data];
    const sum = bytes.reduce((acc, b) => (acc + b) & 0xFF, 0);
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
    return `:${[...bytes, (~sum + 1) & 0xFF].map(hex).join('')}`;
}

function intelHex (blocks: { address: number, data: number[] }[]): string {
    const lines = [hexRecord(0x04, 0, [(FLASH_OFFSET >> 24) & 0xFF, (FLASH_OFFSET >> 16) & 0xFF])];
    for (const block of blocks) {
        for (let at = 0; at < block.data.length; at += 16) {
            lines.push(hexRecord(
                0x00,
                (block.address - FLASH_OFFSET + at) & 0xFFFF,
                block.data.slice(at, at + 16)
            ));
        }
    }
    lines.push(hexRecord(0x01, 0, []));
    return `${lines.join('\n')}\n`;
}

/** A firmware image for the simulated F051, with the name block where the build puts it. */
function firmwareHex (name = 'ARK_4IN1_F051'): string {
    const mcu = new Mcu(0x1F06);
    const nameBlock = new Array<number>(32).fill(0);
    for (let i = 0; i < name.length && i < 31; i += 1) {
        nameBlock[i] = name.charCodeAt(i) & 0xFF;
    }
    return intelHex([
        { address: FLASH_OFFSET + mcu.getFirmwareStart(), data: Array.from({ length: 512 }, (_, i) => (i * 7) & 0xFE) },
        { address: FLASH_OFFSET + mcu.getEepromOffset() - 32, data: nameBlock }
    ]);
}

// ---- usage, help and version ------------------------------------------------

describe('ark32: usage', () => {
    it('prints help on stdout and exits 0', async () => {
        const result = await cli(['--help']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('Usage: ark32');
        expect(result.stderr).toBe('');
    });

    it('prints the version from the environment', async () => {
        const result = await cli(['--version']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout.trim()).toBe('0.0.0-test');
    });

    it('exits 3 on a bad command line, with nothing on stdout', async () => {
        const result = await cli(['enumrate', '--sim']);
        expect(result.code).toBe(EXIT_USAGE);
        // A script that pipes stdout must not receive half an answer.
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain("unknown command 'enumrate'");
        expect(result.stderr).toContain('--help');
    });
});

// ---- ports ------------------------------------------------------------------

describe('ark32 ports', () => {
    it('lists the simulated port under --sim', async () => {
        const result = await cli(['--sim', 'ports']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('sim');
        expect(result.stdout).toContain('am32-sim');
    });

    it('lists the OS ports with VID:PID', async () => {
        const result = await cli(['ports'], {
            listPorts: () => Promise.resolve([
                { path: '/dev/ttyACM0', vendorId: '0483', productId: '5740' },
                { path: '/dev/ttyS0' }
            ])
        });
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('/dev/ttyACM0');
        expect(result.stdout).toContain('0483:5740');
        // Unfiltered: a port with no VID is still a port the user may be holding.
        expect(result.stdout).toContain('/dev/ttyS0');
    });

    it('says so rather than failing when nothing is plugged in', async () => {
        const result = await cli(['ports']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('no serial ports found');
    });

    it('exits 2 when the native module will not load', async () => {
        const result = await cli(['ports'], {
            listPorts: () => Promise.reject(new SessionError('transport', 'could not load the serialport module'))
        });
        // Not reachable is not the same as empty: a caller has to be able to tell
        // "no ports" from "this build cannot see ports at all".
        expect(result.code).toBe(EXIT_CONNECT);
        expect(result.stderr).toContain('serialport module');
    });
});

// ---- info and enumerate -----------------------------------------------------

describe('ark32 info', () => {
    it('identifies the simulated ArduPilot and does not enter passthrough', async () => {
        const result = await cli(['--sim', '-v', 'info']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('ARDU');
        expect(result.stdout).toContain('motors             4');
        // Block 5's design decision 10: asking what FC this is must not hold every
        // ESC in its bootloader. So the state never reaches `passthrough`.
        expect(result.stderr).not.toContain('-> passthrough');
        expect(result.stderr).toContain('-> disconnected');
    });

    it('identifies the simulated Betaflight', async () => {
        const result = await cli(['--sim', '--fc', 'betaflight', 'info']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('BTFL');
    });

    it('exits 2 when no FC answers within the connect budget', async () => {
        // A MAVLink idle gate longer than the 8 s probe-then-wait budget is a GCS
        // that never lets go of the port.
        const result = await cli(['--sim', '--fault', 'fc=mavlinkIdleGate:100000', 'info']);
        expect(result.code).toBe(EXIT_CONNECT);
        expect(result.stderr).toContain('error:');
    });

    it('emits exactly one JSON object, on stdout, with logs on stderr', async () => {
        const result = await cli(['--sim', '-v', '--json', 'info']);
        expect(result.code).toBe(EXIT_OK);

        const envelope = result.json();
        expect(envelope.command).toBe('info');
        expect(envelope.ok).toBe(true);
        expect(envelope.exitCode).toBe(0);
        expect(envelope.simulated).toBe(true);
        expect((envelope.fc as Record<string, unknown>).variant).toBe('ARDU');
        expect(envelope.error).toBeNull();

        // The whole point of the rule: -v produced plenty of output and none of it
        // landed on stdout.
        expect(result.stderr.length).toBeGreaterThan(0);
        expect(result.stdout.trimEnd().endsWith('}')).toBe(true);
    });

    it('still emits one JSON object when the command failed', async () => {
        const result = await cli(['--sim', '--fault', 'fc=mavlinkIdleGate:100000', '--json', 'info']);
        expect(result.code).toBe(EXIT_CONNECT);
        const envelope = result.json();
        expect(envelope.ok).toBe(false);
        expect(envelope.exitCode).toBe(2);
        expect((envelope.error as Record<string, unknown>).reason).toBe('fc-detect');
    });
});

describe('ark32 enumerate', () => {
    it('exits 1 with three good results and one error when a channel is dead', async () => {
        const result = await cli(['--sim', '--escs', '4', '--fault', 'esc4=unresponsive', '--json', 'enumerate']);

        // Audit item B: a partial enumerate degrades, it does not throw.
        expect(result.code).toBe(EXIT_PARTIAL);
        const escs = escsOf(result);
        expect(escs.filter(esc => esc.ok)).toHaveLength(3);
        expect(escs.filter(esc => !esc.ok)).toHaveLength(1);
        expect(escs[3]?.esc).toBe(4);
        expect(escs[3]?.error).toContain('ESC #4');
    });

    it('exits 2 when the FC enters passthrough and reports no channels', async () => {
        // Betaflight installs esc4wayProcess unconditionally, so this is reachable
        // on a board with no configured motor outputs. Every other command would be
        // equally impossible, which is what exit 2 tells a script.
        const result = await cli(['--sim', '--escs', '0', 'enumerate']);
        expect(result.code).toBe(EXIT_CONNECT);
        expect(result.stderr).toContain('reported 0 ESCs');
    });

    it('works on the Betaflight profile too', async () => {
        const result = await cli(['--sim', '--fc', 'betaflight', '--escs', '2', '--json', 'enumerate']);
        expect(result.code).toBe(EXIT_OK);
        expect(escsOf(result)).toHaveLength(2);
    });
});

// ---- read and get -----------------------------------------------------------

describe('ark32 read', () => {
    it('writes one 192-byte image per channel', async () => {
        const result = await cli(['--sim', '--escs', '2', 'read', '--esc', 'all', '-o', 'out']);
        expect(result.code).toBe(EXIT_OK);

        expect([...result.files.keys()]).toEqual(['out/esc-1.bin', 'out/esc-2.bin']);
        const first = result.files.get('out/esc-1.bin') as Uint8Array;
        expect(first).toHaveLength(192);
        // The simulator's own CAN block and the firmware's reserved bytes, straight
        // off the wire -- so the dump is the ESC's image and not a re-encode of it.
        expect(Array.from(first.slice(176, 184))).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
        expect(Array.from(first.slice(13, 17))).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
        expect(result.stdout).toContain('wrote 192 bytes to out/esc-1.bin');
    });

    it('writes only the channels that answered', async () => {
        const result = await cli([
            '--sim', '--escs', '2', '--fault', 'esc1=unresponsive', 'read', '--esc', 'all', '-o', 'out'
        ]);
        expect(result.code).toBe(EXIT_PARTIAL);
        expect([...result.files.keys()]).toEqual(['out/esc-2.bin']);
    });

    it('reports a channel the FC will not address without pretending it is a usage error', async () => {
        const result = await cli(['--sim', '--escs', '2', '--json', 'read', '--esc', '5', '-o', 'out']);
        // Exit 3 has to keep meaning "nothing was attempted", and by the time the
        // channel count is known, a connect and a passthrough have happened.
        expect(result.code).toBe(EXIT_PARTIAL);
        expect(escsOf(result)[0]?.error).toContain('no ESC #5');
        expect(result.files.size).toBe(0);
    });
});

describe('ark32 get', () => {
    it('prints the named settings', async () => {
        const result = await cli(['--sim', '--escs', '1', 'get', '--esc', '1', 'TIMING_ADVANCE', 'MOTOR_POLES']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('TIMING_ADVANCE');
        expect(result.stdout).toMatch(/TIMING_ADVANCE\s+8/);
        expect(result.stdout).toMatch(/MOTOR_POLES\s+14/);
        expect(result.stdout).not.toContain('MOTOR_KV');
    });

    it('prints every field when given no keys', async () => {
        const result = await cli(['--sim', '--escs', '1', 'get', '--esc', '1']);
        expect(result.stdout).toContain('MOTOR_KV');
        expect(result.stdout).toContain('CAN_SETTINGS');
    });

    it('serialises byte fields as arrays, not as objects', async () => {
        const result = await cli(['--sim', '--escs', '1', '--json', 'get', '--esc', '1', 'CAN_SETTINGS']);
        const settings = escsOf(result)[0]?.settings as Record<string, unknown>;
        // A Uint8Array stringifies as {"0":32,"1":1,...}, which is unusable.
        // The simulated ESC's eight live CAN bytes, then `can.reserved[8]`.
        expect(settings.CAN_SETTINGS).toEqual([32, 1, 1, 10, 1, 200, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('exits 3 on an unknown setting name, before opening anything', async () => {
        const result = await cli(['--sim', 'get', '--esc', '1', 'TIMING_ADVENCE']);
        expect(result.code).toBe(EXIT_USAGE);
        expect(result.stderr).toContain("unknown setting 'TIMING_ADVENCE'");
    });
});

// ---- set --------------------------------------------------------------------

describe('ark32 set', () => {
    it('writes and verifies one field on every channel', async () => {
        const result = await cli([
            '--sim', '--escs', '4', '--json', 'set', '--esc', 'all', 'TIMING_ADVANCE=16'
        ]);
        expect(result.code).toBe(EXIT_OK);
        expect(escsOf(result)).toHaveLength(4);
        for (const esc of escsOf(result)) {
            expect(esc.changed).toBe(true);
            expect(esc.verified).toBe(true);
        }
    });

    it('reports a write it was told not to verify as unverified', async () => {
        const result = await cli([
            '--sim', '--escs', '1', '--json', 'set', '--esc', '1', 'TIMING_ADVANCE=16', '--no-verify'
        ]);
        expect(result.code).toBe(EXIT_OK);
        // Block 6's point: `WriteSettingsResult.verified` exists so the CLI can say
        // which of the two things it did, rather than printing "written" either way.
        expect(escsOf(result)[0]?.verified).toBe(false);
    });

    it('warns when nothing changed, because a skipped field looks the same', async () => {
        // The simulated ESC already holds 8, and `encodeSettings` silently skips a
        // field the layout revision excludes -- so "unchanged" covers both cases and
        // has to be said out loud.
        const result = await cli(['--sim', '--escs', '1', 'set', '--esc', '1', 'TIMING_ADVANCE=8']);
        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout).toContain('unchanged');
        expect(result.stderr).toContain('nothing changed');
    });

    it('accepts a byte list for a multi-byte field', async () => {
        const result = await cli([
            '--sim', '--escs', '1', '--json', 'set', '--esc', '1', 'CAN_SETTINGS=9,2,1,10,1,200,0,1'
        ]);
        expect(result.code).toBe(EXIT_OK);
        expect(escsOf(result)[0]?.changed).toBe(true);
        // Explicit is the whole difference from `write -i FILE`, which drops the CAN
        // block: here the user named the field.
        expect(result.stderr).toContain('identity or firmware bookkeeping');
    });

    it('exits 3 on a value that is not a byte', async () => {
        expect((await cli(['--sim', 'set', '--esc', '1', 'TIMING_ADVANCE=999'])).code).toBe(EXIT_USAGE);
        expect((await cli(['--sim', 'set', '--esc', '1', 'TIMING_ADVANCE=x'])).code).toBe(EXIT_USAGE);
        expect((await cli(['--sim', 'set', '--esc', '1', 'TIMING_ADVANCE'])).code).toBe(EXIT_USAGE);
        expect((await cli(['--sim', 'set', '--esc', '1', 'NOPE=1'])).code).toBe(EXIT_USAGE);
    });

    it('refuses BOOT_LOADER_REVISION, which would verify and change nothing', async () => {
        // Byte 2 is stamped by the bootloader inside every write to the EEPROM base
        // and is the one byte verification exempts, so a write would be reported as
        // verified while doing nothing at all.
        const result = await cli(['--sim', 'set', '--esc', '1', 'BOOT_LOADER_REVISION=5']);
        expect(result.code).toBe(EXIT_USAGE);
        expect(result.stderr).toContain('main.c:517-525');
    });

    it('exits 1 when a channel cannot be written', async () => {
        const result = await cli([
            '--sim', '--escs', '2', '--fault', 'esc2=unresponsive', '--json',
            'set', '--esc', 'all', 'TIMING_ADVANCE=16'
        ]);
        expect(result.code).toBe(EXIT_PARTIAL);
        expect(escsOf(result).map(esc => esc.ok)).toEqual([true, false]);
    });
});

// ---- write ------------------------------------------------------------------

describe('ark32 write', () => {
    const files = { 'fixture.bin': FIXTURE };

    it('applies a settings image to every channel', async () => {
        const result = await cli(
            ['--sim', '--escs', '4', '--json', 'write', '--esc', 'all', '-i', 'fixture.bin'],
            { files }
        );
        expect(result.code).toBe(EXIT_OK);
        for (const esc of escsOf(result)) {
            expect(esc.changed).toBe(true);
            expect(esc.verified).toBe(true);
        }
    });

    // The six identity and version fields the fixture plants hostile values in are
    // asserted against the simulated EEPROM in `commands/settings.test.ts`, where
    // the rig outlives the command and the bytes can actually be read back. Each
    // `cli()` call here builds a fresh rig, so a write and a read cannot see the
    // same ESC.

    it('exits 3 rather than opening a port when the file is unusable', async () => {
        expect((await cli(['--sim', 'write', '--esc', 'all', '-i', 'missing.bin'])).code)
            .toBe(EXIT_USAGE);

        const empty = await cli(['--sim', 'write', '--esc', 'all', '-i', 'empty.bin'], {
            files: { 'empty.bin': new Uint8Array(0) }
        });
        expect(empty.code).toBe(EXIT_USAGE);
        expect(empty.stderr).toContain('is empty');

        const big = await cli(['--sim', 'write', '--esc', 'all', '-i', 'big.bin'], {
            files: { 'big.bin': new Uint8Array(193) }
        });
        expect(big.code).toBe(EXIT_USAGE);
        expect(big.stderr).toContain('at most 192');
    });

    it('accepts a short image, which is what the served default files are', async () => {
        const short = new Uint8Array(48);
        short[EepromLayout.TIMING_ADVANCE.offset] = 22;
        const result = await cli(
            ['--sim', '--escs', '1', '--json', 'write', '--esc', '1', '-i', 'short.bin'],
            { files: { 'short.bin': short } }
        );
        expect(result.code).toBe(EXIT_OK);
        expect(escsOf(result)[0]?.changed).toBe(true);
    });
});

// ---- defaults ---------------------------------------------------------------

describe('ark32 defaults', () => {
    it('resets every channel with no network and no fixture', async () => {
        const result = await cli(['--sim', '--escs', '2', '--json', 'defaults', '--esc', 'all']);
        expect(result.code).toBe(EXIT_OK);
        for (const esc of escsOf(result)) {
            expect(esc.changed).toBe(true);
            expect(esc.verified).toBe(true);
        }
    });
});

// ---- flash and reset --------------------------------------------------------

describe('ark32 flash', () => {
    it('flashes a matching image and reports the post-flash boot byte', async () => {
        const result = await cli(
            ['--sim', '--escs', '1', '--json', 'flash', '--esc', '1', '--hex', 'fw.hex'],
            { files: { 'fw.hex': firmwareHex() } }
        );
        expect(result.code).toBe(EXIT_OK);
        const esc = escsOf(result)[0];
        expect(esc?.ok).toBe(true);
        // 0x01 is the bootloader's "there is a complete application here" marker, so
        // a 0 here would mean the flash bracket did not close.
        expect(esc?.bootByte).toBe(1);
    });

    it('exits 3 when the hex is not for this board, on every targeted channel', async () => {
        const result = await cli(
            ['--sim', '--escs', '1', '--json', 'flash', '--esc', '1', '--hex', 'wrong.hex'],
            { files: { 'wrong.hex': firmwareHex('OTHER_BOARD_F051') } }
        );
        // `image` is a bad argument that can only be discovered on the wire, and
        // every channel rejected it -- so nothing was written and 3 is honest.
        expect(result.code).toBe(EXIT_USAGE);
        expect(escsOf(result)[0]?.reason).toBe('image');
    });

    it('flashes a mismatched image when told to', async () => {
        const result = await cli(
            ['--sim', '--escs', '1', 'flash', '--esc', '1', '--hex', 'wrong.hex', '--allow-mcu-mismatch'],
            { files: { 'wrong.hex': firmwareHex('OTHER_BOARD_F051') } }
        );
        expect(result.code).toBe(EXIT_OK);
    });

    it('exits 3 on a malformed hex without opening anything', async () => {
        const result = await cli(
            ['--sim', 'flash', '--esc', '1', '--hex', 'notahex.txt'],
            { files: { 'notahex.txt': 'this is not an Intel HEX file\n' } }
        );
        expect(result.code).toBe(EXIT_USAGE);
        expect(result.stderr).toContain('not a valid Intel HEX file');
    });

    it('survives an ESC that answers 600 ms late', async () => {
        // Block 6's own done-when, reached through the CLI: the timeout policy has to
        // cover the FC's real budget plus the latency in the path.
        const result = await cli(
            ['--sim', '--escs', '1', '--fault', 'esc1=slowBy:600', 'flash', '--esc', '1', '--hex', 'fw.hex'],
            { files: { 'fw.hex': firmwareHex() } }
        );
        expect(result.code).toBe(EXIT_OK);
    });
});

describe('ark32 reset', () => {
    it('resets every channel', async () => {
        const result = await cli(['--sim', '--escs', '2', '--json', 'reset', '--esc', 'all']);
        expect(result.code).toBe(EXIT_OK);
        expect(escsOf(result).map(esc => esc.ok)).toEqual([true, true]);
    });
});

// ---- the teardown -----------------------------------------------------------

describe('ark32: the session is always torn down', () => {
    it('leaves passthrough and closes the port after a successful command', async () => {
        const result = await cli(['--sim', '--escs', '1', '-v', 'enumerate']);
        // A run that ended anywhere but `disconnected` left a real FC in
        // passthrough, which means every ESC is still held in its bootloader.
        expect(result.stderr).toContain('session passthrough -> connected');
        expect(result.stderr).toContain('-> disconnected');
    });

    it('and after a failing one', async () => {
        const result = await cli([
            '--sim', '--escs', '1', '--fault', 'esc1=unresponsive', '-v', 'enumerate'
        ]);
        expect(result.code).toBe(EXIT_PARTIAL);
        expect(result.stderr).toContain('-> disconnected');
    });
});

// ---- the plan's two done-when command lines --------------------------------

describe('issue #3 block 7 done-when', () => {
    it('`ark32 --sim enumerate --escs 4` succeeds with no hardware', async () => {
        const result = await cli(['--sim', 'enumerate', '--escs', '4']);

        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout.trimEnd().split('\n')).toHaveLength(4);
        for (let esc = 1; esc <= 4; esc += 1) {
            expect(result.stdout).toContain(`ESC #${esc}  ok     ARK_4IN1_F051`);
        }
    });

    it('`ark32 --sim write --esc all -i fixture.bin` succeeds with no hardware', async () => {
        const result = await cli(['--sim', 'write', '--esc', 'all', '-i', 'fixture.bin'], {
            files: { 'fixture.bin': FIXTURE }
        });

        expect(result.code).toBe(EXIT_OK);
        expect(result.stdout.trimEnd().split('\n')).toHaveLength(4);
        for (let esc = 1; esc <= 4; esc += 1) {
            expect(result.stdout).toContain(`ESC #${esc}  applied and verified`);
        }
    });
});
