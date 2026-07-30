/**
 * `ark32 info` and `ark32 enumerate`.
 *
 * `info` deliberately stops at `connect()` and does **not** enter passthrough --
 * block 5's design decision 10, for the same reason the app stopped doing it: on
 * ArduPilot, entering passthrough holds every ESC in its bootloader for as long as
 * the session lasts. Asking what flight controller this is should not stop the
 * motors.
 */

import type { Am32Session, FcInfo } from 'am32-core/session';
import { SessionError } from 'am32-core/errors';
import { EXIT_OK, exitCodeForTargets } from '../exit';
import type { CommandOutcome } from '../report';

/** The FC facts, in one shape shared by `info` and `enumerate`. */
export function fcData (fc: FcInfo, escCount: number | null): Record<string, unknown> {
    return {
        fc: {
            variant: fc.variantId || null,
            apiVersion: `${fc.apiVersion.major}.${fc.apiVersion.minor}`,
            /**
             * `MSP_MOTOR_CONFIG` byte 6 -- the authoritative *motor* count on both
             * firmwares. Not the same number as `escCount`, which is the
             * `MSP_SET_PASSTHROUGH` reply and the only thing that bounds which
             * channels can be addressed. On Betaflight the two can differ.
             */
            motorCount: fc.motorCount,
            escCount,
            connectMs: fc.connectMs,
            waitedForMavlinkWindow: fc.waitedForMavlinkWindow,
            battery: fc.battery
                ? {
                    cells: fc.battery.cells,
                    capacityMah: fc.battery.capacityMah,
                    voltage: fc.battery.voltage,
                    mahDrawn: fc.battery.mahDrawn,
                    amps: fc.battery.amps,
                    state: fc.battery.state
                }
                : null
        }
    };
}

export function commandInfo (fc: FcInfo): CommandOutcome {
    const lines = [
        `flight controller  ${fc.variantId || 'unknown'}`,
        `MSP API            ${fc.apiVersion.major}.${fc.apiVersion.minor}`,
        `motors             ${fc.motorCount}`,
        `connected in       ${fc.connectMs}ms${fc.waitedForMavlinkWindow ? ' (after the MAVLink idle window)' : ''}`
    ];

    if (fc.battery) {
        lines.push(`battery            ${fc.battery.voltage.toFixed(2)}V, ${fc.battery.cells} cell(s)`);
    }

    return { data: fcData(fc, null), lines, exitCode: EXIT_OK };
}

/**
 * `ark32 enumerate`.
 *
 * A flight controller that entered passthrough and reported **zero** channels is
 * reported as a connect-class failure (exit 2) rather than as an empty success.
 * It is not a partial result -- no ESC failed, because none was addressable -- and
 * every other command would be equally impossible against this FC, which is what
 * exit 2 tells a script. Betaflight reaches this state on a board with no
 * configured motor outputs: `esc4wayProcess` is installed unconditionally
 * (`msp.c:328-333` is not guarded by the count), so the FC really does enter
 * passthrough with nothing behind it.
 */
export function commandEnumerate (
    fc: FcInfo,
    escCount: number,
    results: Awaited<ReturnType<Am32Session['enumerate']>>
): CommandOutcome {
    if (escCount === 0) {
        throw new SessionError(
            'passthrough',
            'the flight controller entered 4-way passthrough and reported 0 ESCs, ' +
            'so there is nothing to address. On Betaflight this is a board with no ' +
            'configured motor outputs.'
        );
    }

    const escs = results.map(result => ({
        esc: result.target + 1,
        target: result.target,
        ok: result.ok,
        mcu: result.ok ? result.info?.meta.am32.mcuType ?? null : null,
        firmwareName: result.ok ? result.info?.meta.am32.fileName ?? null : null,
        firmwareVersion: result.ok
            ? `${String(result.info?.settings.MAIN_REVISION ?? '?')}.${String(result.info?.settings.SUB_REVISION ?? '?')}`
            : null,
        bootloaderVersion: result.ok ? result.info?.bootloader.version ?? null : null,
        layoutRevision: result.ok ? result.info?.settings.LAYOUT_REVISION ?? null : null,
        ...(result.ok ? {} : { error: result.error ?? null })
    }));

    const lines = escs.map(esc => (esc.ok
        ? `ESC #${esc.esc}  ok     ${esc.firmwareName ?? 'unnamed'} ` +
          `v${esc.firmwareVersion}  bootloader ${String(esc.bootloaderVersion)}  ` +
          `layout ${String(esc.layoutRevision)}`
        : `ESC #${esc.esc}  FAILED ${esc.error ?? ''}`));

    return {
        data: { ...fcData(fc, escCount), escs },
        lines,
        exitCode: exitCodeForTargets(results.map(result => ({ ok: result.ok })))
    };
}
