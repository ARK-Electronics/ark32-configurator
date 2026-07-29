/**
 * Byte-preserving EEPROM codec.
 *
 * This is the codec half of audit item A in issue #3. The old pair
 * (`utils/buffer-to-settings.ts` + `utils/object-to-settings-array.ts`) had two
 * compounding faults:
 *
 *   1. Any field larger than two bytes that was not `STARTUP_MELODY` was
 *      round-tripped **as a UTF-8 string** -- `TextDecoder().decode().trim()`
 *      out, `charCodeAt()` back in. For `CAN_SETTINGS` that meant a `can_node`
 *      of `0x20` (a space) was deleted by `.trim()`, shifting the whole block
 *      left one byte, and a `filter_hz` of `0xC8` decoded to U+FFFD and came
 *      back as 253.
 *   2. Encoding started from a `0xFF` fill rather than from the ESC's read-back
 *      buffer, so every byte the layout does not name -- the firmware's
 *      `reserved_eeprom_3[4]` at 13-16, `can.reserved[8]` at 184-191, and every
 *      version-gated field the running layout revision excludes -- was
 *      overwritten with 0xFF on every save.
 *
 * Both are fixed here by construction: multi-byte fields are opaque bytes, and
 * encoding starts from a copy of the read-back image.
 */

import type { EepromField, McuSettings } from './layout';
import { EEPROM_SIZE, EepromLayout, NUMBER_ARRAY_FIELDS } from './layout';

const LAYOUT_ENTRIES: [string, EepromField][] = Object.entries(EepromLayout);

/** True when a field exists at the given layout revision. */
function fieldApplies (field: EepromField, layoutRevision: number): boolean {
    if (field.maxEepromVersion !== undefined && layoutRevision > field.maxEepromVersion) {
        return false;
    }
    if (field.minEepromVersion !== undefined && layoutRevision < field.minEepromVersion) {
        return false;
    }
    return true;
}

/**
 * Decode a settings image into named fields.
 *
 * Single-byte fields decode to numbers, `STARTUP_MELODY` to `number[]` (what
 * the RTTTL editor produces and consumes), and every other multi-byte field --
 * today only `CAN_SETTINGS` -- to an opaque `Uint8Array` copy. Nothing is
 * decoded as a string.
 *
 * Fields that do not fit entirely inside `buffer` are omitted rather than
 * decoded from undefined bytes, so a short image (a settings dump saved by an
 * older build, which was 184 bytes) decodes to whatever it does contain.
 */
export function decodeSettings (buffer: Uint8Array, layoutRevision: number): McuSettings {
    const settings: McuSettings = {};

    for (const [name, field] of LAYOUT_ENTRIES) {
        if (!fieldApplies(field, layoutRevision)) {
            continue;
        }
        if (field.size < 1) {
            throw new RangeError(`eeprom field ${name} has size ${field.size}`);
        }
        if (field.offset + field.size > buffer.length) {
            continue;
        }

        if (field.size === 1) {
            settings[name] = buffer[field.offset] as number;
        } else if (NUMBER_ARRAY_FIELDS.has(name)) {
            settings[name] = Array.from(buffer.subarray(field.offset, field.offset + field.size));
        } else {
            settings[name] = buffer.slice(field.offset, field.offset + field.size);
        }
    }

    return settings;
}

/**
 * Re-encode named fields onto a base image.
 *
 * `base` must be the ESC's read-back buffer: every byte the layout does not
 * name, and every field excluded at this layout revision, is carried through
 * untouched. Only fields present in `settings` are written, so a partial patch
 * is a legitimate input.
 *
 * A multi-byte value shorter than its field is zero-padded and a longer one is
 * truncated, matching what the old encoder did for the startup melody.
 */
export function encodeSettings (
    base: Uint8Array,
    settings: Partial<McuSettings>,
    layoutRevision: number
): Uint8Array {
    if (base.length !== EEPROM_SIZE) {
        throw new RangeError(
            `settings base buffer must be ${EEPROM_SIZE} bytes, got ${base.length}`
        );
    }

    const out = new Uint8Array(base);

    for (const [name, field] of LAYOUT_ENTRIES) {
        if (!fieldApplies(field, layoutRevision)) {
            continue;
        }

        const value = settings[name];
        if (value === undefined) {
            continue;
        }

        if (field.offset + field.size > out.length) {
            throw new RangeError(
                `eeprom field ${name} at ${field.offset}+${field.size} does not fit ${out.length} bytes`
            );
        }

        if (field.size === 1) {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new TypeError(`eeprom field ${name} must be a number, got ${typeof value}`);
            }
            out[field.offset] = value & 0xFF;
            continue;
        }

        if (typeof value === 'number') {
            throw new TypeError(`eeprom field ${name} is ${field.size} bytes and must not be a number`);
        }

        for (let i = 0; i < field.size; i += 1) {
            out[field.offset + i] = i < value.length ? ((value[i] as number) & 0xFF) : 0;
        }
    }

    return out;
}

/**
 * Convenience for the common read-modify-write: decode `base`, apply `patch`
 * over the decoded fields, and encode back onto `base`.
 */
export function patchSettings (
    base: Uint8Array,
    patch: Partial<McuSettings>,
    layoutRevision: number
): Uint8Array {
    return encodeSettings(base, { ...decodeSettings(base, layoutRevision), ...patch }, layoutRevision);
}
