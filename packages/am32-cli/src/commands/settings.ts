/**
 * The five settings commands: `read`, `get`, `set`, `write`, `defaults`.
 *
 * All of them are byte-preserving, and none of them is byte-preserving *here* --
 * `Am32Session.writeSettings` builds every outgoing image from a fresh read of the
 * ESC and overwrites only named fields, which is audit item **A**'s fix. What this
 * file owns is which fields end up in the patch, and that is a product decision
 * with one sharp edge; see {@link imagePatch}.
 */

import { decodeSettings } from 'am32-core/eeprom/codec';
import { DEFAULTS_PRESERVED_FIELDS } from 'am32-core/eeprom/defaults';
import { EEPROM_SIZE, EepromLayout, type EscSettings } from 'am32-core/eeprom/layout';
import type { Am32Session, WriteSettingsResult } from 'am32-core/session';
import type { McuInfo } from 'am32-core/mcu';
import type { EscSelector } from '../args';
import type { CliEnv } from '../env';
import { exitCodeForTargets } from '../exit';
import { formatSettingValue, type CommandOutcome, type Reporter } from '../report';
import { forEachTarget, summariseOutcome, type OutcomeSummary, type TargetOutcome } from './targets';

/** Layout field names, for validating `get` and `set` keys before connecting. */
export const SETTING_KEYS: readonly string[] = Object.keys(EepromLayout);

/**
 * The one field `set` refuses.
 *
 * `BOOT_LOADER_REVISION` is EEPROM byte 2, and the bootloader overwrites it with
 * its own version inside every write to the EEPROM base
 * (`AM32-bootloader/bootloader/main.c:517-525`). It is also the one byte read-back
 * verification exempts, precisely because it can never round-trip -- so a
 * `set BOOT_LOADER_REVISION=5` would be *reported as verified* while changing
 * nothing at all. Refusing it is the API-makes-the-rule-unreachable principle
 * applied to a command line: a lie that verifies is worse than an error.
 */
export const UNWRITABLE_KEYS: readonly string[] = ['BOOT_LOADER_REVISION'];

const MAX_BYTE = 0xFF;

export interface Assignment {
    key: string
    value: number | number[]
}

/** `KEY=VALUE` from the command line, or a message for exit code 3. */
export function parseAssignment (operand: string): Assignment | string {
    const eq = operand.indexOf('=');
    if (eq < 1) {
        return `set needs KEY=VALUE, got '${operand}'`;
    }

    const key = operand.slice(0, eq);
    const raw = operand.slice(eq + 1);

    const field = (EepromLayout as Record<string, { size: number } | undefined>)[key];
    if (!field) {
        return `unknown setting '${key}'. 'ark32 get --esc 1' lists every name this ESC has.`;
    }
    if (UNWRITABLE_KEYS.includes(key)) {
        return `${key} cannot be written: the bootloader replaces EEPROM byte 2 with its ` +
            'own version inside every write to the settings page (AM32-bootloader main.c:517-525), ' +
            'so a write would verify and change nothing.';
    }

    const parts = raw.split(',').map(part => part.trim());
    const bytes: number[] = [];
    for (const part of parts) {
        if (!/^\d+$/.test(part)) {
            return `${key}: '${raw}' is not a byte value. ` +
                (field.size === 1 ? 'Expected 0-255.' : `Expected up to ${field.size} comma-separated bytes.`);
        }
        const byte = Number(part);
        if (byte > MAX_BYTE) {
            return `${key}: ${byte} does not fit in a byte (0-255)`;
        }
        bytes.push(byte);
    }

    if (field.size === 1) {
        if (bytes.length !== 1) {
            return `${key} is one byte; got ${bytes.length} values`;
        }
        return { key, value: bytes[0] as number };
    }

    if (bytes.length > field.size) {
        return `${key} is ${field.size} bytes; got ${bytes.length} values`;
    }
    return { key, value: bytes };
}

/**
 * The patch a settings *file* contributes.
 *
 * **Six fields are dropped, and this is the block's one deliberate difference
 * from the web app.** `DEFAULTS_PRESERVED_FIELDS` -- the boot byte, the layout
 * revision, the bootloader version, the two firmware-version bytes and the CAN
 * block -- are an ESC's identity and its firmware's own bookkeeping, not tunables
 * that belong in a saved configuration. The app's `applySettings` drops only
 * `CAN_SETTINGS` (block 5's design decision 13); this drops all six, because:
 *
 *  - **The boot byte is the dangerous one.** A file saved from a half-flashed ESC
 *    has byte 0 = `0x00`, which is the bootloader's "there is no complete
 *    application here" marker (`main.c:306-319`). Writing that onto a working ESC
 *    leaves it sitting in its bootloader, and in an unattended CLI there is no
 *    dialog to notice it in.
 *  - **The layout revision is the subtle one.** Writing 3 onto an older ESC makes
 *    the firmware's own migration skip (`AM32/Src/settings.c:23-36`), so fields
 *    the migration would have populated are read as whatever was in flash. Block 6
 *    established this for `applyDefaults`; it is the same hazard from the same
 *    bytes.
 *  - **The firmware version bytes would lie** about what the ESC is running, and
 *    the configurator's firmware-catalog lookup keys on them.
 *  - **`CAN_SETTINGS`** is per-ESC identity: `write --esc all` from one file would
 *    give an ARK DroneCAN board four ESCs with the same node ID.
 *
 * Nothing is lost by this: `writeSettings` leaves an omitted field exactly as the
 * ESC had it, so a restore of an ESC's own backup is byte-identical either way.
 * And `ark32 set` can still write four of the six explicitly, one field at a time,
 * where the user has named it and the CLI warns.
 */
export function imagePatch (image: Uint8Array, layoutRevision: number): Partial<EscSettings> {
    const patch = decodeSettings(image, layoutRevision);
    for (const field of DEFAULTS_PRESERVED_FIELDS) {
        delete patch[field];
    }
    return patch;
}

/** A settings file this CLI will not even try to write. */
export function validateSettingsImage (bytes: Uint8Array, path: string): string | null {
    if (bytes.length === 0) {
        return `${path} is empty`;
    }
    if (bytes.length > EEPROM_SIZE) {
        return `${path} is ${bytes.length} bytes; a settings image is at most ${EEPROM_SIZE}`;
    }
    // Shorter is fine and is the normal case: the served default images are 48
    // bytes, and `decodeSettings` simply omits every field that does not fit.
    return null;
}

// ---- read ------------------------------------------------------------------

export interface ReadFile {
    path: string
    bytes: Uint8Array
}

/**
 * `ark32 read --esc all -o DIR`.
 *
 * The files are collected here and written by the caller, *after* the session has
 * closed. Two reasons: a `--sim` run drives a virtual clock, and a filesystem
 * await inside that region has no timer for the pump to advance; and a partial
 * failure should not leave half a directory written before the error appears.
 */
export async function commandRead (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    outDir: string,
    env: CliEnv
): Promise<{ outcome: CommandOutcome, files: ReadFile[] }> {
    const outcomes = await forEachTarget(selector, escCount, target => session.readEsc(target));

    const files: ReadFile[] = [];
    const escs = outcomes.map((outcome): OutcomeSummary & {
        file: string | null
        bytes: number
        firmwareName: string | null
    } => {
        const info = outcome.value;
        if (!outcome.ok || !info) {
            return { ...summariseOutcome(outcome), file: null, bytes: 0, firmwareName: null };
        }
        const path = env.joinPath(outDir, `esc-${outcome.esc}.bin`);
        files.push({ path, bytes: info.settingsBuffer });
        return {
            ...summariseOutcome(outcome),
            file: path,
            bytes: info.settingsBuffer.length,
            firmwareName: info.meta.am32.fileName ?? null
        };
    });

    const lines = escs.map(esc => (esc.ok
        ? `ESC #${esc.esc}  wrote ${esc.bytes} bytes to ${String(esc.file)}`
        : `ESC #${esc.esc}  FAILED ${esc.error ?? ''}`));

    return {
        outcome: { data: { outDir, escs }, lines, exitCode: exitCodeForTargets(outcomes) },
        files
    };
}

// ---- get -------------------------------------------------------------------

/** `ark32 get --esc 1 [KEY...]`. No keys means every field this ESC has. */
export async function commandGet (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    keys: readonly string[]
): Promise<CommandOutcome> {
    const outcomes = await forEachTarget(selector, escCount, target => session.readEsc(target));

    const lines: string[] = [];
    const escs = outcomes.map((outcome) => {
        if (!outcome.ok || !outcome.value) {
            lines.push(`ESC #${outcome.esc}  FAILED ${outcome.error ?? ''}`);
            return { ...summariseOutcome(outcome), settings: null };
        }

        const settings = outcome.value.settings;
        const wanted = keys.length > 0 ? keys : Object.keys(settings);
        const picked: Record<string, number | number[] | Uint8Array> = {};

        lines.push(`ESC #${outcome.esc}`);
        for (const key of wanted) {
            const value = settings[key];
            if (value === undefined) {
                // A field the layout has but this ESC's revision does not. Saying
                // so beats printing nothing, which reads as "the key was wrong".
                lines.push(`  ${key.padEnd(28)} -  (not present at layout revision ` +
                    `${String(settings.LAYOUT_REVISION ?? '?')})`);
                continue;
            }
            picked[key] = value;
            lines.push(`  ${key.padEnd(28)} ${formatSettingValue(value)}`);
        }

        return { ...summariseOutcome(outcome), settings: picked };
    });

    return { data: { escs }, lines, exitCode: exitCodeForTargets(outcomes) };
}

// ---- the three write paths -------------------------------------------------

/** Shared reporting for `set`, `write` and `defaults`. */
function writeOutcome (
    outcomes: TargetOutcome<WriteSettingsResult>[],
    reporter: Reporter,
    what: string
): CommandOutcome {
    const escs = outcomes.map((outcome): OutcomeSummary & { changed: boolean, verified: boolean } => {
        const result = outcome.value;
        if (!outcome.ok || !result) {
            return { ...summariseOutcome(outcome), changed: false, verified: false };
        }
        if (!result.changed) {
            // Worth saying out loud: `encodeSettings` silently skips a field the
            // ESC's layout revision excludes, so "nothing changed" covers both
            // "already set" and "this ESC has no such field".
            reporter.warn(
                `ESC #${outcome.esc}: nothing changed -- the values are already those bytes, ` +
                'or the field does not exist at this ESC\'s layout revision'
            );
        }
        return { ...summariseOutcome(outcome), changed: result.changed, verified: result.verified };
    });

    const lines = escs.map(esc => (esc.ok
        ? `ESC #${esc.esc}  ${esc.changed ? what : 'unchanged'}` +
          `${esc.changed ? (esc.verified ? ' and verified' : ' (NOT verified)') : ''}`
        : `ESC #${esc.esc}  FAILED ${esc.error ?? ''}`));

    return { data: { escs }, lines, exitCode: exitCodeForTargets(outcomes) };
}

/** `ark32 set --esc all KEY=VALUE...`. */
export async function commandSet (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    assignments: readonly Assignment[],
    verify: boolean,
    reporter: Reporter
): Promise<CommandOutcome> {
    const patch: Partial<EscSettings> = {};
    for (const assignment of assignments) {
        patch[assignment.key] = assignment.value;
        if (DEFAULTS_PRESERVED_FIELDS.includes(assignment.key as never)) {
            reporter.warn(
                `${assignment.key} is identity or firmware bookkeeping rather than a tunable; ` +
                'writing it because you named it explicitly'
            );
        }
    }

    const outcomes = await forEachTarget(
        selector,
        escCount,
        target => session.writeSettings(target, patch, { verify })
    );
    return writeOutcome(outcomes, reporter, 'written');
}

/** `ark32 write --esc all -i FILE`. */
export async function commandWrite (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    image: Uint8Array,
    verify: boolean,
    reporter: Reporter
): Promise<CommandOutcome> {
    const outcomes = await forEachTarget(selector, escCount, async (target) => {
        // The ESC's own layout revision decides how the file decodes. Taking it from
        // the ESC rather than from a flag or a constant is block 6's finding: the app
        // clamped anything above 3 to 2 while the server clamped it to 3, and both
        // were guesses about a number the ESC is holding.
        //
        // The failure is asymmetric, and worth knowing before "simplifying" this to a
        // constant. Too *high* a revision is harmless: `writeSettings` calls
        // `encodeSettings` with the revision read off the ESC's own image, so a field
        // the ESC does not have is dropped there whatever this patch contains. Too
        // *low* silently omits fields the ESC does have -- decoding a revision-3
        // ESC's file at revision 2 loses the eight tunables at 0x05-0x0C, with
        // `changed: true` and no warning. Both directions are pinned in
        // `settings.test.ts`.
        const info: McuInfo = await session.readEsc(target);
        const layoutRevision = (info.settings.LAYOUT_REVISION as number | undefined) ?? 0;
        return session.writeSettings(target, imagePatch(image, layoutRevision), { verify });
    });
    return writeOutcome(outcomes, reporter, 'applied');
}

/** `ark32 defaults --esc all`. */
export async function commandDefaults (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    verify: boolean,
    reporter: Reporter
): Promise<CommandOutcome> {
    // No image and no network: `applyDefaults` uses AM32's own `default_settings[]`,
    // embedded in the core by block 6 for exactly this caller.
    const outcomes = await forEachTarget(
        selector,
        escCount,
        target => session.applyDefaults(target, { verify })
    );
    return writeOutcome(outcomes, reporter, 'reset to defaults');
}
