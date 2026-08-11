/**
 * Firmware version helpers shared by the web app and the CLI.
 *
 * AM32 EEPROM only carries two version bytes (`MAIN_REVISION` / `SUB_REVISION`,
 * major.minor). ARK ship releases also have a patch (and often a `-ark` tag)
 * that lives in the 32-byte `.file_name` region as a second C-string after the
 * board `FILE_NAME`:
 *
 *   `ARK_4IN1_F051\03.0.2-ark\0...`
 *
 * Older images only store `FILE_NAME`; those fall back to the EEPROM pair.
 */

import { decodeBytesZ } from './text';

/**
 * Accept a firmware name that contains a run of name characters.
 *
 * Deliberately unanchored: its job is to reject an erased (`0xFF`) or empty
 * read, not to validate every character of a real board name.
 */
export const FIRMWARE_NAME_PATTERN = /[A-Z0-9_]+/;

/**
 * A full ARK / AM32 ship version as it appears in artifact names and (when
 * present) the second C-string of the `.file_name` region.
 *
 * Examples: `3.0.2-ark`, `3.0-ark`, `2.18`, `2.20`.
 */
export const FIRMWARE_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/;

export interface ParsedFirmwareNameRegion {
    /** Board identity (`FILE_NAME`), e.g. `ARK_4IN1_F051`. Null when absent. */
    fileName: string | null
    /**
     * Full ship version from the optional second C-string, e.g. `3.0.2-ark`.
     * Null when the image only stores `FILE_NAME` (pre-ARK-patch firmwares and
     * stock AM32).
     */
    firmwareVersion: string | null
}

/**
 * Parse the 32-byte `.file_name` flash region below the EEPROM page.
 *
 * Layout: `FILE_NAME\0[VERSION\0][padding 0x00 or 0xFF]`.
 */
export function parseFirmwareNameRegion (bytes: ArrayLike<number>): ParsedFirmwareNameRegion {
    const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as ArrayLike<number>);

    if (view.length === 0 || isBlankNameRegion(view)) {
        return { fileName: null, firmwareVersion: null };
    }

    const fileName = decodeBytesZ(view).trim();
    if (!fileName || !FIRMWARE_NAME_PATTERN.test(fileName)) {
        return { fileName: null, firmwareVersion: null };
    }

    const firstNul = indexOfByte(view, 0);
    if (firstNul < 0 || firstNul + 1 >= view.length) {
        return { fileName, firmwareVersion: null };
    }

    let i = firstNul + 1;
    while (i < view.length && view[i] === 0) {
        i += 1;
    }
    if (i >= view.length || view[i] === 0xFF) {
        return { fileName, firmwareVersion: null };
    }

    const version = decodeBytesZ(view.subarray(i)).trim();
    if (!version || !FIRMWARE_VERSION_PATTERN.test(version)) {
        return { fileName, firmwareVersion: null };
    }

    return { fileName, firmwareVersion: version };
}

/**
 * Format the version the UI / CLI should show for a connected ESC.
 *
 * Prefers the embedded ship version from the name region when the firmware
 * provides one; otherwise `MAJOR.MINOR` from EEPROM (no zero-padding -- the
 * old `3.00` pad made ARK 3.0 look like `3.0.0`).
 */
export function formatEscFirmwareVersion (
    settings: { MAIN_REVISION?: unknown, SUB_REVISION?: unknown },
    embeddedVersion?: string | null
): string {
    if (embeddedVersion && FIRMWARE_VERSION_PATTERN.test(embeddedVersion)) {
        return embeddedVersion;
    }

    const major = settings.MAIN_REVISION;
    const minor = settings.SUB_REVISION;
    if (typeof major !== 'number' || typeof minor !== 'number' ||
        !Number.isFinite(major) || !Number.isFinite(minor)) {
        return '?';
    }

    return `${major}.${minor}`;
}

function isBlankNameRegion (view: Uint8Array): boolean {
    let allFf = true;
    let allZero = true;
    for (let i = 0; i < view.length; i += 1) {
        const b = view[i] as number;
        if (b !== 0xFF) {
            allFf = false;
        }
        if (b !== 0) {
            allZero = false;
        }
        if (!allFf && !allZero) {
            return false;
        }
    }
    return allFf || allZero;
}

function indexOfByte (view: Uint8Array, value: number): number {
    for (let i = 0; i < view.length; i += 1) {
        if (view[i] === value) {
            return i;
        }
    }
    return -1;
}
