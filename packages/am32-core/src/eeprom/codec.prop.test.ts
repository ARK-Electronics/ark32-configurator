import { describe, expect, it } from 'vitest';
import { assert as fcAssert, integer, property, uint8Array } from 'fast-check';
import type { EepromLayoutField } from './layout';
import { EEPROM_SIZE, EepromLayout } from './layout';
import { decodeSettings, encodeSettings, patchSettings } from './codec';

/**
 * Audit item A in issue #3. The old codec corrupted the ESC's CAN settings on
 * every save; these are the properties that make that impossible to reintroduce.
 *
 * The two magic values are not arbitrary. `can_node = 0x20` is an ASCII space,
 * which the old `TextDecoder().decode().trim()` deleted -- shifting the whole
 * CAN block one byte left. `filter_hz = 0xC8` is not valid UTF-8, so it decoded
 * to U+FFFD and `charCodeAt()` wrote it back as 253.
 */

/** Byte ranges the firmware owns and the configurator must never disturb. */
const RESERVED_EEPROM_3 = { start: 13, end: 17 }; // char reserved_eeprom_3[4], eeprom.h:25
const CAN_BLOCK = { start: 176, end: 184 }; // the eight live can.* fields
const CAN_RESERVED = { start: 184, end: 192 }; // can.reserved[8]

const image = (fill: number | ((i: number) => number) = 0) =>
    Uint8Array.from({ length: EEPROM_SIZE }, (_, i) => (typeof fill === 'number' ? fill : fill(i)) & 0xFF);

describe('eeprom codec round-trip', () => {
    it('decode -> encode is byte-identical for any 192-byte image', () => {
        fcAssert(
            property(
                uint8Array({ minLength: EEPROM_SIZE, maxLength: EEPROM_SIZE }),
                (bytes) => {
                    const layoutRevision = bytes[1] as number;
                    const settings = decodeSettings(bytes, layoutRevision);
                    const encoded = encodeSettings(bytes, settings, layoutRevision);
                    expect(Array.from(encoded)).toEqual(Array.from(bytes));
                }
            ),
            { numRuns: 1000 }
        );
    });

    it('decode -> encode is byte-identical at every layout revision', () => {
        fcAssert(
            property(
                uint8Array({ minLength: EEPROM_SIZE, maxLength: EEPROM_SIZE }),
                integer({ min: 0, max: 5 }),
                (bytes, layoutRevision) => {
                    const settings = decodeSettings(bytes, layoutRevision);
                    const encoded = encodeSettings(bytes, settings, layoutRevision);
                    expect(Array.from(encoded)).toEqual(Array.from(bytes));
                }
            ),
            { numRuns: 1000 }
        );
    });

    it('writing one single-byte field changes exactly one byte', () => {
        const singleByteFields = Object.entries(EepromLayout as EepromLayoutField)
            .filter(([, f]) => f.size === 1 && f.minEepromVersion === undefined);

        fcAssert(
            property(
                uint8Array({ minLength: EEPROM_SIZE, maxLength: EEPROM_SIZE }),
                integer({ min: 0, max: singleByteFields.length - 1 }),
                integer({ min: 0, max: 255 }),
                (bytes, fieldIndex, value) => {
                    const [name, field] = singleByteFields[fieldIndex] as [string, { offset: number }];
                    const encoded = patchSettings(bytes, { [name]: value }, 3);

                    expect(encoded[field.offset]).toBe(value);
                    for (let i = 0; i < EEPROM_SIZE; i += 1) {
                        if (i !== field.offset) {
                            expect(encoded[i]).toBe(bytes[i]);
                        }
                    }
                }
            ),
            { numRuns: 1000 }
        );
    });

    it('preserves reserved bytes 13-16 and the CAN block 176-191 across a write', () => {
        fcAssert(
            property(
                uint8Array({ minLength: EEPROM_SIZE, maxLength: EEPROM_SIZE }),
                integer({ min: 0, max: 255 }),
                (bytes, timingAdvance) => {
                    const encoded = patchSettings(bytes, { TIMING_ADVANCE: timingAdvance }, 3);

                    for (const range of [RESERVED_EEPROM_3, CAN_BLOCK, CAN_RESERVED]) {
                        expect(Array.from(encoded.subarray(range.start, range.end)))
                            .toEqual(Array.from(bytes.subarray(range.start, range.end)));
                    }
                }
            ),
            { numRuns: 1000 }
        );
    });
});

describe('audit A: the CAN block survives a save', () => {
    /** The realistic v3 EEPROM from the audit. */
    const canBlock = [32, 1, 1, 10, 1, 200, 0, 1];
    const original = image((i) => {
        if (i === 1) { return 3; } // LAYOUT_REVISION
        if (i >= CAN_BLOCK.start && i < CAN_BLOCK.end) { return canBlock[i - CAN_BLOCK.start] as number; }
        if (i >= RESERVED_EEPROM_3.start && i < RESERVED_EEPROM_3.end) { return 0x30 + i; }
        return i;
    });

    it('round-trips can_node 0x20 and filter_hz 0xC8 exactly', () => {
        const encoded = patchSettings(original, { TIMING_ADVANCE: 16 }, 3);

        // The old codec produced [1, 1, 10, 1, 253, 0, 1, 32] here.
        expect(Array.from(encoded.subarray(CAN_BLOCK.start, CAN_BLOCK.end))).toEqual(canBlock);
        expect(encoded[CAN_BLOCK.start]).toBe(0x20); // can_node, deleted by .trim()
        expect(encoded[CAN_BLOCK.start + 5]).toBe(0xC8); // filter_hz, mangled to 253
    });

    it('leaves every byte except the edited field untouched', () => {
        const encoded = patchSettings(original, { TIMING_ADVANCE: 16 }, 3);
        const differing = [];
        for (let i = 0; i < EEPROM_SIZE; i += 1) {
            if (encoded[i] !== original[i]) {
                differing.push(i);
            }
        }
        // The audit's reproduction listed 13,14,15,16,176,178,179,180,181,182,183.
        expect(differing).toEqual([EepromLayout.TIMING_ADVANCE.offset]);
    });

    it('decodes CAN_SETTINGS as bytes, never a string', () => {
        const settings = decodeSettings(original, 3);
        expect(settings.CAN_SETTINGS).toBeInstanceOf(Uint8Array);
        expect(Array.from(settings.CAN_SETTINGS as Uint8Array).slice(0, 8)).toEqual(canBlock);
    });

    it('hands back a copy of CAN_SETTINGS, not a view into the read-back buffer', () => {
        const settings = decodeSettings(original, 3);
        (settings.CAN_SETTINGS as Uint8Array)[0] = 0xAA;
        expect(original[CAN_BLOCK.start]).toBe(0x20);
    });
});

describe('decode coverage', () => {
    it('decodes every layout field at revision 3', () => {
        // The round-trip property above cannot catch a field that decode
        // silently drops: encoding starts from the same base, so the missing
        // bytes are carried through and the image still matches. This is the
        // assertion that catches it.
        const settings = decodeSettings(image(i => i), 3);
        const missing = Object.keys(EepromLayout).filter(name => settings[name] === undefined);
        expect(missing).toEqual([]);
    });

    it('decodes exactly the ungated fields at revision 2', () => {
        const settings = decodeSettings(image(i => i), 2);
        const absent = Object.keys(EepromLayout).filter(name => settings[name] === undefined);
        expect(absent).toEqual([
            'MAX_RAMP',
            'MINIMUM_DUTY_CYCLE',
            'DISABLE_STICK_CALIBRATION',
            'ABSOLUTE_VOLTAGE_CUTOFF',
            'CURRENT_P',
            'CURRENT_I',
            'CURRENT_D',
            'ACTIVE_BRAKE_POWER'
        ]);
    });
});

describe('version-gated fields', () => {
    it('carries fields excluded at revision 2 through untouched', () => {
        const original = image(i => i);
        const settings = decodeSettings(original, 2);

        // 0x05..0x0C are minEepromVersion 3, so they must not decode at all...
        expect(settings.MAX_RAMP).toBeUndefined();
        expect(settings.ACTIVE_BRAKE_POWER).toBeUndefined();

        // ...and must still come back byte-identical, because encoding starts
        // from the read-back image rather than from a 0xFF fill.
        const encoded = encodeSettings(original, settings, 2);
        expect(Array.from(encoded.subarray(0x05, 0x0D)))
            .toEqual(Array.from(original.subarray(0x05, 0x0D)));
    });

    it('ignores a gated-out field even if the caller supplies one', () => {
        const original = image(0x11);
        const encoded = encodeSettings(original, { MAX_RAMP: 0x99 }, 2);
        expect(encoded[EepromLayout.MAX_RAMP.offset]).toBe(0x11);
    });
});

describe('codec contracts', () => {
    it('refuses a base buffer that is not 192 bytes', () => {
        // 184 was the old Mcu.LAYOUT_SIZE, which is exactly the truncation that
        // let a write run off the end of the CAN block.
        expect(() => encodeSettings(new Uint8Array(184), {}, 3)).toThrow(/192 bytes/);
        expect(() => encodeSettings(new Uint8Array(0), {}, 3)).toThrow(/192 bytes/);
    });

    it('decodes a short image without inventing bytes', () => {
        const short = new Uint8Array(184).fill(0x07);
        const settings = decodeSettings(short, 3);
        expect(settings.TIMING_ADVANCE).toBe(0x07);
        expect(settings.CAN_SETTINGS).toBeUndefined();
    });

    it('rejects a number where a byte array is required', () => {
        expect(() => encodeSettings(image(0), { CAN_SETTINGS: 5 }, 3)).toThrow(TypeError);
    });

    it('rejects a non-number where a single byte is required', () => {
        expect(() => encodeSettings(image(0), { TIMING_ADVANCE: new Uint8Array(1) }, 3)).toThrow(TypeError);
    });

    it('accepts either a number[] or a Uint8Array for a byte field', () => {
        const base = image(0);
        const fromArray = encodeSettings(base, { CAN_SETTINGS: [1, 2, 3, 4, 5, 6, 7, 8] }, 3);
        const fromTyped = encodeSettings(base, { CAN_SETTINGS: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) }, 3);
        expect(Array.from(fromArray)).toEqual(Array.from(fromTyped));
        // Short values zero-pad the rest of the field, as the old encoder did
        // for the startup melody.
        expect(Array.from(fromArray.subarray(CAN_BLOCK.start, CAN_RESERVED.end)))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('round-trips the startup melody as a plain array', () => {
        const base = image(i => i);
        const settings = decodeSettings(base, 3);
        expect(Array.isArray(settings.STARTUP_MELODY)).toBe(true);
        expect((settings.STARTUP_MELODY as number[]).length).toBe(128);
        expect(Array.from(encodeSettings(base, settings, 3))).toEqual(Array.from(base));
    });
});

describe('layout invariants', () => {
    it('is exactly 192 bytes and nothing overruns it', () => {
        expect(EEPROM_SIZE).toBe(192);
        const overruns = Object.entries(EepromLayout)
            .filter(([, field]) => field.offset + field.size > EEPROM_SIZE)
            .map(([name]) => name);
        expect(overruns).toEqual([]);
    });

    it('has no two-byte fields', () => {
        // The 16-bit big-endian branch both old converters carried was dead
        // code. If a two-byte field is ever added, the codec needs a decision
        // about endianness before this test is changed.
        const twoByte = Object.entries(EepromLayout).filter(([, f]) => f.size === 2);
        expect(twoByte).toEqual([]);
    });

    it('has no overlapping fields', () => {
        const owner = new Array<string | null>(EEPROM_SIZE).fill(null);
        for (const [name, field] of Object.entries(EepromLayout)) {
            for (let i = field.offset; i < field.offset + field.size; i += 1) {
                expect(owner[i]).toBeNull();
                owner[i] = name;
            }
        }
        // The firmware's reserved regions must stay unclaimed by the layout.
        for (let i = RESERVED_EEPROM_3.start; i < RESERVED_EEPROM_3.end; i += 1) {
            expect(owner[i]).toBeNull();
        }
        for (let i = CAN_RESERVED.start; i < CAN_RESERVED.end; i += 1) {
            expect(owner[i]).toBe('CAN_SETTINGS');
        }
    });
});
