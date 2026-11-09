import { describe, expect, it } from 'vitest';
import { EEPROM_SIZE, EepromLayout } from './layout';
import {
    EXACT_RAMP_LAYOUT,
    applyRampMigration,
    describeRampMigration,
    migrateScaledRamp,
    needsRampMigration,
    scaledRampRates
} from './ramp-migration';

/** Startup/low/high in %/ms, the way ARK32 PR #128 tabulates layout 3. */
function flew (raw: number, volts: number): string {
    const rates = scaledRampRates(raw, volts);
    const parts = [rates.startup, rates.lowRpm, rates.highRpm].map(r => String(r / 10));
    return parts.every(p => p === parts[0]) ? parts[0] as string : parts.join('/');
}

function page (options: { layout?: number, major?: number, ramp?: number } = {}): Uint8Array {
    const bytes = new Uint8Array(EEPROM_SIZE).fill(0);
    bytes[EepromLayout.BOOT_BYTE.offset] = 1;
    bytes[EepromLayout.LAYOUT_REVISION.offset] = options.layout ?? 3;
    bytes[EepromLayout.MAIN_REVISION.offset] = options.major ?? 32;
    bytes[EepromLayout.MAX_RAMP.offset] = options.ramp ?? 20;
    bytes[100] = 0xA5;
    return bytes;
}

describe('scaledRampRates (layout 3 as flown)', () => {
    // The table in ARK32 PR #128, "What a layout-3 ramp actually flew", derived
    // from the firmware. Columns: 11.1 / 14.8 / 16.8 / 22.2 / 25.2 / 44.4 V.
    const volts = [11.1, 14.8, 16.8, 22.2, 25.2, 44.4];
    const table: [number, string[]][] = [
        [3, ['0.3', '0.3', '0.2', '0.1', '0.1', '0.1']],
        [5, ['0.6', '0.5', '0.4', '0.3', '0.2', '0.2']],
        [10, ['1', '1', '1', '1', '1', '1']],
        [20, ['2', '2', '1', '1', '1', '1']],
        [40, ['2/5/5', '2/4/4', '1/3/3', '1/2/2', '1/2/2', '1/2/2']],
        [160, ['2/7/21', '2/6/16', '1/5/14', '1/3/10', '1/3/9', '1/3/8']]
    ];
    for (const [raw, expected] of table) {
        it(`stored ${raw / 10} %/ms`, () => {
            expect(volts.map(v => flew(raw, v))).toEqual(expected);
        });
    }

    it('runs a stored 0 at the one-count floor, as the firmware does', () => {
        expect(scaledRampRates(0, 22.2)).toEqual({ startup: 1, lowRpm: 1, highRpm: 1 });
    });

    it('does not scale below 6 V (no battery reading)', () => {
        expect(flew(160, 5)).toBe('2/6/16');
    });
});

describe('migrateScaledRamp', () => {
    it('turns the factory 2.0 into the 1.0 a 4S-6S vehicle flew', () => {
        for (const cells of [4, 5, 6, 8, 12]) {
            expect(migrateScaledRamp(20, cells).to).toBe(10);
        }
    });

    it('keeps 2.0 on 3S, where layout 3 ran it unscaled at full charge', () => {
        expect(migrateScaledRamp(20, 3).to).toBe(20);
    });

    it('evaluates at full charge, the slowest point of the pack', () => {
        const report = migrateScaledRamp(5, 6);
        expect(report.volts).toBe(25.2);
        // 0.5 %/ms flew 0.3 at 6S nominal and 0.2 at full charge.
        expect(report.to).toBe(2);
    });

    it('takes the slowest regime, so no regime ramps faster than before', () => {
        // 16 %/ms on 6S flew 1/3/9 at full charge.
        const report = migrateScaledRamp(160, 6);
        expect(report.flew).toEqual({ startup: 10, lowRpm: 30, highRpm: 90 });
        expect(report.to).toBe(10);
    });

    it('can raise a fine setting that layout 3 boosted on a small pack', () => {
        // 0.7 %/ms on 3S flew 0.8 at full charge (and 0.9 at nominal).
        expect(migrateScaledRamp(7, 3).to).toBe(8);
    });

    it('never stores 0, which the schema does not allow', () => {
        expect(migrateScaledRamp(0, 6).to).toBe(1);
    });

    it('rejects a cell count that is not a pack', () => {
        expect(() => migrateScaledRamp(20, 0)).toThrow(RangeError);
        expect(() => migrateScaledRamp(20, 17)).toThrow(RangeError);
        expect(() => migrateScaledRamp(20, 4.5)).toThrow(RangeError);
    });
});

describe('needsRampMigration', () => {
    it('migrates an ARK layout-3 page for a layout-4 image', () => {
        expect(needsRampMigration(page({ major: 32 }), 4)).toBe(true);
        expect(needsRampMigration(page({ major: 3 }), 4)).toBe(true);
        expect(needsRampMigration(page(), 5)).toBe(true);
    });

    it('leaves an upstream AM32 page alone: upstream never scaled the ramp', () => {
        expect(needsRampMigration(page({ major: 2 }), 4)).toBe(false);
    });

    it('leaves the page alone for an image that does not declare layout 4', () => {
        expect(needsRampMigration(page(), null)).toBe(false);
        expect(needsRampMigration(page(), 3)).toBe(false);
    });

    it('does not migrate twice', () => {
        expect(needsRampMigration(page({ layout: EXACT_RAMP_LAYOUT }), 4)).toBe(false);
    });
});

describe('applyRampMigration', () => {
    it('rewrites the ramp and the layout byte and nothing else', () => {
        const before = page({ ramp: 20 });
        const { page: after, report } = applyRampMigration(before, 6);
        expect(report).toMatchObject({ from: 20, to: 10, cells: 6 });
        expect(after[EepromLayout.MAX_RAMP.offset]).toBe(10);
        expect(after[EepromLayout.LAYOUT_REVISION.offset]).toBe(EXACT_RAMP_LAYOUT);
        const changed = Array.from(after.keys()).filter(i => after[i] !== before[i]);
        expect(changed).toEqual([EepromLayout.LAYOUT_REVISION.offset, EepromLayout.MAX_RAMP.offset]);
        // The input is not modified in place.
        expect(before[EepromLayout.MAX_RAMP.offset]).toBe(20);
    });

    it('describes the change in one line', () => {
        expect(describeRampMigration(migrateScaledRamp(160, 6)))
            .toBe('ramp 16.0 -> 1.0 %/ms (layout 3 ran 1.0/3.0/9.0 %/ms on 6S at full charge; layout 4 runs the setting exactly)');
        expect(describeRampMigration(migrateScaledRamp(20, 6)))
            .toBe('ramp 2.0 -> 1.0 %/ms (layout 3 ran 1.0 %/ms on 6S at full charge; layout 4 runs the setting exactly)');
    });
});
