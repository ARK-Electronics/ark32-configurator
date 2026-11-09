/**
 * ARK32 EEPROM layout 3 -> 4: carry over the ramp an ESC actually flew.
 *
 * Every ARK release from 3.0.1-ark to 32.0 is layout 3, and all of them scaled
 * `max_ramp` (byte 5) by 14.8 V / pack voltage, clamped to 0.5x-1.5x, then
 * truncated it to whole duty counts per 20 kHz tick (ARK32 `runtime_loop.c`
 * `GOV_RAMP_VREF_CV`, `settings.c`). The stored number is therefore not the rate
 * the vehicle flew: the factory 2.0 %/ms ran at 1.0 on any pack above 14.8 V.
 * Layout 4 (ARK32 PR #128) runs the stored value exactly, so the same page
 * would ramp up to twice as fast after a firmware update.
 *
 * The firmware never rewrites the byte. Its first boot stamps layout 4 over the
 * page, after which a layout-3 page can no longer be recognised, so the
 * migration happens here, in `Am32Session.flash`, which reads the page before
 * it writes the image.
 *
 * Only ARK pages migrate. Upstream AM32 never scaled its ramp, and its own
 * layout 4 (2.21: `brake_on_zero_throttle` and `demag_comp` at bytes 13-14,
 * reserved in ARK32) leaves every byte ARK32 uses where it was, so an upstream
 * page already means what ARK32 layout 4 means.
 */

import { EepromLayout } from './layout';

/** The layout that scaled the ramp. */
export const SCALED_RAMP_LAYOUT = 3;
/** The first layout that runs the ramp exactly. */
export const EXACT_RAMP_LAYOUT = 4;
/**
 * `MAIN_REVISION` of every ARK release that wrote a scaled-ramp page: 3 for
 * 3.0.x-ark and 3.0.3, 32 for 32.0. Upstream AM32 is on 2.x and never scaled.
 */
export const SCALED_RAMP_FIRMWARE_MAJORS: readonly number[] = [3, 32];
/**
 * Per-cell voltage the migration evaluates the old ramp at. A full LiPo is the
 * highest voltage the pack sees, which made layout 3 ramp slowest, so the
 * migrated value is never faster than anything the vehicle flew on that pack.
 */
export const FULL_CHARGE_CELL_VOLTS = 4.2;
/** Cell counts the configurator accepts for a migration. */
export const MIN_PACK_CELLS = 1;
export const MAX_PACK_CELLS = 16;

/** `GOV_RAMP_VREF_CV`: 14.80 V in the firmware's centivolts. */
const RAMP_VREF_CENTIVOLTS = 1480;
/** `RAMP_SPEED_STARTUP` / `_LOW_RPM` / `_HIGH_RPM`: whole counts per tick, both layouts. */
const REGIME_CAPS = { startup: 2, lowRpm: 6, highRpm: 16 } as const;
/** The schema's raw range for `MAX_RAMP`. */
const MIN_RAMP_RAW = 1;
const MAX_RAMP_RAW = 200;

/** A rate per ramp regime, in tenths of %/ms (the unit `MAX_RAMP` is stored in). */
export interface RampRates {
    startup: number;
    lowRpm: number;
    highRpm: number;
}

/** What {@link migrateScaledRamp} decided, for logs, the CLI and the UI. */
export interface RampMigrationReport {
    /** Stored `MAX_RAMP` before, raw tenths of %/ms. */
    from: number;
    /** Stored `MAX_RAMP` after, raw tenths of %/ms. Runs exactly under layout 4. */
    to: number;
    cells: number;
    /** The pack voltage the old ramp was evaluated at (full charge). */
    volts: number;
    /** What layout-3 firmware ran for `from` at `volts`, per regime. */
    flew: RampRates;
}

/** Layout 3's scale, Q8 of 14.8 V / pack, clamped to 0.5x-1.5x; 1x below 6 V. */
function scaleQ8 (centivolts: number): number {
    if (centivolts <= 600) {
        return 256;
    }
    return Math.min(384, Math.max(128, Math.floor((RAMP_VREF_CENTIVOLTS * 256) / centivolts)));
}

/**
 * The rate layout-3 firmware ran for a stored `MAX_RAMP` at a pack voltage.
 *
 * Mirrors the firmware exactly. Below 10 (fine mode) the scaled step is applied
 * once every 10th tick in every regime. From 10 up, each regime takes
 * `min(cap, floor(raw / 10))` counts per tick, and the scaled count is truncated
 * with a floor of 1. One count per tick is 1 %/ms (duty 0..2000 at 20 kHz).
 */
export function scaledRampRates (raw: number, packVolts: number): RampRates {
    const scale = scaleQ8(Math.round(packVolts * 100));
    const scaled = (counts: number): number => Math.max(1, Math.floor((counts * scale) / 256));
    if (raw < 10) {
        const tenths = scaled(raw);
        return { startup: tenths, lowRpm: tenths, highRpm: tenths };
    }
    const whole = Math.floor(raw / 10);
    return {
        startup: 10 * scaled(Math.min(REGIME_CAPS.startup, whole)),
        lowRpm: 10 * scaled(Math.min(REGIME_CAPS.lowRpm, whole)),
        highRpm: 10 * scaled(Math.min(REGIME_CAPS.highRpm, whole))
    };
}

/**
 * The layout-4 value for a layout-3 ramp on a pack of `cells` cells.
 *
 * Layout 4 has one rate for every regime (capped 2/6/16 as before), and
 * layout 3 could run a different rate in each, so one number cannot reproduce
 * all three. The migration takes the slowest, evaluated at full charge, so the
 * new firmware never ramps faster than the old one did on this pack in any
 * regime. In practice the startup regime sets it: any stored ramp of 1.0 or more
 * becomes 1.0 above 14.8 V. A pilot who wants the old high-rpm punch back raises
 * the setting, which now means exactly what it says.
 */
export function migrateScaledRamp (raw: number, cells: number): RampMigrationReport {
    if (!Number.isInteger(cells) || cells < MIN_PACK_CELLS || cells > MAX_PACK_CELLS) {
        throw new RangeError(`pack cell count must be a whole number from ${MIN_PACK_CELLS} to ${MAX_PACK_CELLS}, got ${cells}`);
    }
    const volts = Math.round(cells * FULL_CHARGE_CELL_VOLTS * 100) / 100;
    const flew = scaledRampRates(raw, volts);
    const slowest = Math.min(flew.startup, flew.lowRpm, flew.highRpm);
    const to = Math.min(MAX_RAMP_RAW, Math.max(MIN_RAMP_RAW, slowest));
    return { from: raw, to, cells, volts, flew };
}

/**
 * True when flashing an image of `imageLayout` over `page` needs the ramp
 * migrated: the page is an ARK layout-3 page, and the image runs layout 4 or
 * later. `imageLayout` is null for an image that does not declare its layout
 * (every image built before ARK32 PR #134), which never migrates.
 */
export function needsRampMigration (page: Uint8Array, imageLayout: number | null): boolean {
    return imageLayout !== null && imageLayout >= EXACT_RAMP_LAYOUT &&
        page[EepromLayout.LAYOUT_REVISION.offset] === SCALED_RAMP_LAYOUT &&
        SCALED_RAMP_FIRMWARE_MAJORS.includes(page[EepromLayout.MAIN_REVISION.offset] ?? -1);
}

/**
 * The migrated page: `MAX_RAMP` replaced and the layout byte set to 4, nothing
 * else touched. Setting the layout byte makes the migration happen once: a
 * second flash before the ESC has booted reads a layout-4 page and leaves it
 * alone, rather than scaling an already-migrated value again. The new
 * firmware still stamps its own version bytes on first boot, and a later
 * layout upgrades from 4 itself.
 */
export function applyRampMigration (page: Uint8Array, cells: number): { page: Uint8Array, report: RampMigrationReport } {
    const report = migrateScaledRamp(page[EepromLayout.MAX_RAMP.offset] ?? 0, cells);
    const out = new Uint8Array(page);
    out[EepromLayout.MAX_RAMP.offset] = report.to;
    out[EepromLayout.LAYOUT_REVISION.offset] = EXACT_RAMP_LAYOUT;
    return { page: out, report };
}

/** `2.0` from raw `20`. */
export function formatRampRaw (raw: number): string {
    return (raw / 10).toFixed(1);
}

/** One line for logs and the CLI: `ramp 2.0 -> 1.0 %/ms (flew 1.0/1.0/1.0 on 6S)`. */
export function describeRampMigration (report: RampMigrationReport): string {
    const flew = [report.flew.startup, report.flew.lowRpm, report.flew.highRpm].map(formatRampRaw);
    const ran = flew.every(rate => rate === flew[0]) ? flew[0] : flew.join('/');
    return `ramp ${formatRampRaw(report.from)} -> ${formatRampRaw(report.to)} %/ms ` +
        `(layout 3 ran ${ran} %/ms on ${report.cells}S at full charge; layout 4 runs the setting exactly)`;
}
