/**
 * What the settings commands put in the patch -- and, for `write`, what they
 * deliberately leave out.
 *
 * The end-to-end suite in `run.test.ts` builds a fresh simulated rig per command,
 * so it can prove a write *succeeded* but never that a byte the file carried did
 * not land. This file holds the rig across the write and reads the simulated
 * EEPROM afterwards, which is the only place the six dropped fields can actually
 * be observed. That distinction cost a vacuous test on the first pass: a `write`
 * followed by a second `write` on a new rig asserted nothing at all.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EEPROM_SIZE, EepromLayout } from 'am32-core/eeprom/layout';
import { DEFAULTS_PRESERVED_FIELDS } from 'am32-core/eeprom/defaults';
import { Am32Session } from 'am32-core/session';
import type { SimEsc } from 'am32-sim/esc';
import { parseArgs, type GlobalOptions } from '../args';
import { Reporter } from '../report';
import { createSimRig, driveVirtualClock } from '../sim';
import type { CliEnv } from '../env';
import { commandDefaults, commandWrite, imagePatch, parseAssignment, validateSettingsImage } from './settings';

const FIXTURE = new Uint8Array(readFileSync(new URL('../../fixtures/fixture.bin', import.meta.url)));

/** The values `fixture.bin` plants in the six fields a write must not carry. */
const FIXTURE_HOSTILE = {
    BOOT_BYTE: 0x00,
    LAYOUT_REVISION: 0x02,
    BOOT_LOADER_REVISION: 0x63,
    MAIN_REVISION: 0x09,
    SUB_REVISION: 0x63
};

/** What the simulated ESC holds before anything is written. */
const SIM_ESC = {
    BOOT_BYTE: 0x01,
    LAYOUT_REVISION: 3,
    BOOT_LOADER_REVISION: 18,
    MAIN_REVISION: 2,
    SUB_REVISION: 20,
    CAN_BLOCK: [32, 1, 1, 10, 1, 200, 0, 1],
    TIMING_ADVANCE: 8
};

function globalsFor (argv: string[]): GlobalOptions {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'args') {
        throw new Error('the test\'s own command line does not parse');
    }
    return parsed.globals;
}

function silentReporter (globals: GlobalOptions): { reporter: Reporter, stderr: () => string } {
    let stderr = '';
    const env = {
        stdout: () => {},
        stderr: (text: string) => {
            stderr += text;
        }
    } as unknown as CliEnv;
    return { reporter: new Reporter(env, globals), stderr: () => stderr };
}

/** A simulated rig in passthrough, with the session the CLI would have built. */
async function rig (argv: string[]) {
    const globals = globalsFor(argv);
    const sim = createSimRig(globals);
    await sim.harness.open();

    const session = new Am32Session({ transport: sim.harness.transport, clock: sim.clock });
    const drive = <T>(work: () => Promise<T>): Promise<T> => driveVirtualClock(sim.clock, work());

    await drive(() => session.connect());
    const escCount = await drive(() => session.enterPassthrough());

    return { ...sim, session, escCount, drive, esc: sim.harness.escs[0] as SimEsc };
}

// ---- imagePatch -------------------------------------------------------------

describe('imagePatch', () => {
    it('drops every field in DEFAULTS_PRESERVED_FIELDS', () => {
        const patch = imagePatch(FIXTURE, 3);

        for (const field of DEFAULTS_PRESERVED_FIELDS) {
            expect(patch[field]).toBeUndefined();
        }
        // All six, not just the CAN block -- which is the one difference from the
        // web app's `applySettings`. See the comment on `imagePatch`.
        expect(DEFAULTS_PRESERVED_FIELDS).toHaveLength(6);
    });

    it('keeps every tunable the file carries', () => {
        const patch = imagePatch(FIXTURE, 3);

        expect(patch.TIMING_ADVANCE).toBe(26);
        expect(patch.MOTOR_POLES).toBe(14);
        expect(Array.isArray(patch.STARTUP_MELODY)).toBe(true);
        expect((patch.STARTUP_MELODY as number[]).slice(0, 8)).toEqual([128, 64, 32, 16, 8, 4, 2, 1]);
    });

    it('decodes with the revision it is given, not a fixed one', () => {
        // The eight fields at 0x05-0x0C are revision-3 only. Block 6 found the app
        // clamping this number to 2 while the server clamped it to 3; the CLI takes
        // it from the ESC.
        expect(imagePatch(FIXTURE, 3).MAX_RAMP).toBeDefined();
        expect(imagePatch(FIXTURE, 2).MAX_RAMP).toBeUndefined();
    });
});

// ---- validateSettingsImage --------------------------------------------------

describe('validateSettingsImage', () => {
    it('accepts anything from one byte to a full page', () => {
        expect(validateSettingsImage(new Uint8Array(1), 'f.bin')).toBeNull();
        expect(validateSettingsImage(new Uint8Array(48), 'f.bin')).toBeNull();
        expect(validateSettingsImage(new Uint8Array(EEPROM_SIZE), 'f.bin')).toBeNull();
    });

    it('rejects an empty file and anything over a page', () => {
        expect(validateSettingsImage(new Uint8Array(0), 'f.bin')).toContain('is empty');
        expect(validateSettingsImage(new Uint8Array(EEPROM_SIZE + 1), 'f.bin')).toContain('at most 192');
    });
});

// ---- parseAssignment --------------------------------------------------------

describe('parseAssignment', () => {
    it('parses a single-byte field', () => {
        expect(parseAssignment('TIMING_ADVANCE=16')).toEqual({ key: 'TIMING_ADVANCE', value: 16 });
    });

    it('parses a byte list for a multi-byte field', () => {
        expect(parseAssignment('CAN_SETTINGS=32,1,1,10')).toEqual({
            key: 'CAN_SETTINGS',
            value: [32, 1, 1, 10]
        });
    });

    it('rejects a value that does not fit in a byte, or a field', () => {
        expect(parseAssignment('TIMING_ADVANCE=256')).toContain('does not fit in a byte');
        expect(parseAssignment('TIMING_ADVANCE=1,2')).toContain('is one byte');
        expect(parseAssignment('CAN_SETTINGS=' + Array(17).fill('1').join(','))).toContain('is 16 bytes');
    });

    it('rejects an unknown field and a missing =', () => {
        expect(parseAssignment('NOPE=1')).toContain("unknown setting 'NOPE'");
        expect(parseAssignment('TIMING_ADVANCE')).toContain('needs KEY=VALUE');
        expect(parseAssignment('=16')).toContain('needs KEY=VALUE');
    });

    it('refuses BOOT_LOADER_REVISION and cites the firmware', () => {
        const message = parseAssignment('BOOT_LOADER_REVISION=5');
        expect(message).toContain('cannot be written');
        expect(message).toContain('main.c:517-525');
    });
});

// ---- commandWrite, against the simulated EEPROM -----------------------------

describe('commandWrite: what reaches the ESC', () => {
    it('writes the tunables and leaves all six identity fields exactly as they were', async () => {
        const h = await rig(['--sim', '--escs', '1', 'write', '--esc', '1', '-i', 'fixture.bin']);
        const { reporter } = silentReporter(globalsFor(['--sim', 'enumerate']));

        const outcome = await h.drive(() => commandWrite(h.session, [0], h.escCount, FIXTURE, true, reporter));
        expect(outcome.exitCode).toBe(0);

        const after = h.esc.eeprom;

        // The tunable the fixture exists to change.
        expect(after[EepromLayout.TIMING_ADVANCE.offset]).toBe(26);
        expect(after[EepromLayout.TIMING_ADVANCE.offset]).not.toBe(SIM_ESC.TIMING_ADVANCE);

        // ...and every one of the six the file must not carry. The fixture plants a
        // hostile value in each, so `toBe(the ESC's own value)` is a real assertion
        // rather than "the byte happened to already match".
        expect(after[EepromLayout.BOOT_BYTE.offset]).toBe(SIM_ESC.BOOT_BYTE);
        expect(after[EepromLayout.BOOT_BYTE.offset]).not.toBe(FIXTURE_HOSTILE.BOOT_BYTE);
        expect(after[EepromLayout.LAYOUT_REVISION.offset]).toBe(SIM_ESC.LAYOUT_REVISION);
        expect(after[EepromLayout.BOOT_LOADER_REVISION.offset]).toBe(SIM_ESC.BOOT_LOADER_REVISION);
        expect(after[EepromLayout.MAIN_REVISION.offset]).toBe(SIM_ESC.MAIN_REVISION);
        expect(after[EepromLayout.SUB_REVISION.offset]).toBe(SIM_ESC.SUB_REVISION);
        expect(Array.from(after.slice(176, 184))).toEqual(SIM_ESC.CAN_BLOCK);

        // Audit item A's other half: bytes the layout does not name at all.
        expect(Array.from(after.slice(13, 17))).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);

        // The melody the file *does* carry, so the drop is selective rather than
        // "multi-byte fields are skipped".
        expect(Array.from(after.slice(0x30, 0x38))).toEqual([128, 64, 32, 16, 8, 4, 2, 1]);
    });

    it('would have written the boot byte if the drop were removed', async () => {
        // The mutation this test exists for, stated as a positive: `set` names the
        // field explicitly, and that path *does* write it. So the byte is reachable,
        // and `write` not writing it is a decision rather than an accident.
        const h = await rig(['--sim', '--escs', '1', 'write', '--esc', '1', '-i', 'fixture.bin']);
        const { reporter } = silentReporter(globalsFor(['--sim', 'enumerate']));

        await h.drive(() => h.session.writeSettings(0, { BOOT_BYTE: 0x00 }, { verify: true }));
        expect(h.esc.eeprom[EepromLayout.BOOT_BYTE.offset]).toBe(0x00);

        // ...and a `write` from the fixture on top of that does not restore it,
        // because it does not touch the byte in either direction.
        await h.drive(() => commandWrite(h.session, [0], h.escCount, FIXTURE, true, reporter));
        expect(h.esc.eeprom[EepromLayout.BOOT_BYTE.offset]).toBe(0x00);
    });

    it('reports a channel that could not be written without throwing', async () => {
        const h = await rig([
            '--sim', '--escs', '2', '--fault', 'esc2=unresponsive', 'write', '--esc', 'all', '-i', 'f.bin'
        ]);
        const { reporter } = silentReporter(globalsFor(['--sim', 'enumerate']));

        const outcome = await h.drive(() => commandWrite(h.session, 'all', h.escCount, FIXTURE, true, reporter));

        expect(outcome.exitCode).toBe(1);
        expect(outcome.lines[0]).toContain('applied and verified');
        expect(outcome.lines[1]).toContain('FAILED');
    });
});

describe('commandDefaults: what reaches the ESC', () => {
    it('resets the tunables and keeps the CAN block and the boot byte', async () => {
        const h = await rig(['--sim', '--escs', '1', 'defaults', '--esc', '1']);
        const { reporter } = silentReporter(globalsFor(['--sim', 'enumerate']));

        const outcome = await h.drive(() => commandDefaults(h.session, [0], h.escCount, true, reporter));
        expect(outcome.exitCode).toBe(0);

        const after = h.esc.eeprom;
        // AM32's own default_settings[] value at 0x17, so this needed no network.
        expect(after[EepromLayout.TIMING_ADVANCE.offset]).toBe(26);
        expect(after[EepromLayout.BOOT_BYTE.offset]).toBe(SIM_ESC.BOOT_BYTE);
        expect(after[EepromLayout.LAYOUT_REVISION.offset]).toBe(SIM_ESC.LAYOUT_REVISION);
        expect(Array.from(after.slice(176, 184))).toEqual(SIM_ESC.CAN_BLOCK);
        // `apply defaults` has always cleared the melody: tune[0] == 0xFF is the
        // "no melody" marker.
        expect(after[0x30]).toBe(0xFF);
    });
});
