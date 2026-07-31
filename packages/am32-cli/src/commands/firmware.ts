/**
 * `ark32 flash` and `ark32 reset`.
 *
 * Neither takes a timeout, and there is nowhere to pass one: the page-write budget
 * comes from `TimeoutPolicy`, derived from the flight controller's own published
 * numbers. The call site that passed 200 ms for an operation ArduPilot budgets
 * ~700 ms for was audit item **C**, and `--timeout-scale` exists so that a slow
 * host widens *every* derivation at once rather than one literal at one site.
 */

import type { Am32Session } from 'am32-core/session';
import type { EscSelector } from '../args';
import { exitCodeForTargets } from '../exit';
import type { CommandOutcome } from '../report';
import { forEachTarget, summariseOutcome, type OutcomeSummary } from './targets';

/**
 * `ark32 flash --esc 1|all --hex FILE`.
 *
 * `hex` has already been parsed once by the caller, so an unreadable or malformed
 * file is exit 3 before anything is put on the wire. What is left for the session
 * is the check it can only do per channel: whether the image's embedded firmware
 * name matches the ESC in front of it. That failure comes back as `reason: 'image'`
 * and, when *every* targeted channel rejects the hex for it, becomes exit 3 too --
 * see `exit.ts`.
 */
export async function commandFlash (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    hex: string,
    options: { allowMcuMismatch: boolean, verify: boolean }
): Promise<CommandOutcome> {
    const outcomes = await forEachTarget(selector, escCount, target => session.flash(target, hex, {
        allowMcuMismatch: options.allowMcuMismatch,
        verify: options.verify
    }));

    const escs = outcomes.map((outcome): OutcomeSummary & {
        firmwareName: string | null
        firmwareVersion: string | null
        /**
         * The post-flash boot byte, re-read from the ESC. `0x01` means the
         * bootloader will hand over to the application; `0x00` is the marker
         * `flash()` sets before it starts streaming and clears afterwards, so a
         * `0` here means the bracket did not close and the board is sitting in
         * its bootloader.
         */
        bootByte: number | null
    } => {
        const info = outcome.value;
        if (!outcome.ok || !info) {
            return {
                ...summariseOutcome(outcome),
                firmwareName: null,
                firmwareVersion: null,
                bootByte: null
            };
        }
        const bootByte = info.settings.BOOT_BYTE;
        return {
            ...summariseOutcome(outcome),
            firmwareName: info.meta.am32.fileName ?? null,
            firmwareVersion:
                `${String(info.settings.MAIN_REVISION ?? '?')}.${String(info.settings.SUB_REVISION ?? '?')}`,
            bootByte: typeof bootByte === 'number' ? bootByte : null
        };
    });

    const lines = escs.map(esc => (esc.ok
        ? `ESC #${esc.esc}  flashed ${esc.firmwareName ?? 'unnamed'} ` +
          `v${esc.firmwareVersion ?? '?'}  boot byte 0x${(esc.bootByte ?? 0).toString(16).padStart(2, '0')}`
        : `ESC #${esc.esc}  FAILED ${esc.error ?? ''}`));

    return { data: { escs }, lines, exitCode: exitCodeForTargets(outcomes) };
}

/** `ark32 reset --esc all` -- `cmd_DeviceReset`, leave the bootloader, run the firmware. */
export async function commandReset (
    session: Am32Session,
    selector: EscSelector,
    escCount: number
): Promise<CommandOutcome> {
    const outcomes = await forEachTarget(selector, escCount, target => session.reset(target));

    const escs = outcomes.map(summariseOutcome);
    const lines = escs.map(esc => (esc.ok
        ? `ESC #${esc.esc}  reset`
        : `ESC #${esc.esc}  FAILED ${esc.error ?? ''}`));

    return { data: { escs }, lines, exitCode: exitCodeForTargets(outcomes) };
}
