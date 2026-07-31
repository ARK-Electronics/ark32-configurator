/**
 * `ark32 flash` and `ark32 reset`.
 *
 * Neither takes a timeout, and there is nowhere to pass one: the page-write budget
 * comes from `TimeoutPolicy`, derived from the flight controller's own published
 * numbers. The call site that passed 200 ms for an operation ArduPilot budgets
 * ~700 ms for was audit item **C**, and `--timeout-scale` exists so that a slow
 * host widens *every* derivation at once rather than one literal at one site.
 */

import { parseHex } from 'am32-core/hex';
import type { McuInfo } from 'am32-core/mcu';
import { findFirmwareAsset } from 'am32-core/releases';
import type { Am32Session } from 'am32-core/session';
import type { EscSelector } from '../args';
import type { CliEnv } from '../env';
import { exitCodeForTargets } from '../exit';
import type { CommandOutcome } from '../report';
import { CatalogError, downloadAsset, type FirmwareRelease, type ReleaseAsset } from './releases';
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

/**
 * `ark32 flash --esc all --release TAG`.
 *
 * The tag was resolved to a release before anything was opened; what cannot be
 * decided earlier is *which asset*, because that hangs on each ESC's own
 * firmware name, read from the 32 bytes below its EEPROM. So the shape per
 * channel is: read the identity, match an asset (`am32-core/releases`, the
 * same matcher the web flash dialog uses), download it once per distinct
 * asset, and hand the very same `session.flash` the `--hex` path uses. An ESC
 * with no readable name fails that channel rather than guessing -- `--hex`
 * with `--allow-mcu-mismatch` is the deliberate-override path for those.
 */
export async function commandFlashRelease (
    session: Am32Session,
    selector: EscSelector,
    escCount: number,
    release: FirmwareRelease,
    env: CliEnv,
    options: { allowMcuMismatch: boolean, verify: boolean }
): Promise<CommandOutcome> {
    const downloads = new Map<string, Promise<string>>();
    const download = (asset: ReleaseAsset): Promise<string> => {
        const started = downloads.get(asset.name) ?? (async () => {
            const text = await downloadAsset(env, asset);
            // The same pre-parse the --hex path gets in run.ts: a malformed
            // asset must fail before the boot byte is touched.
            const parsed = parseHex(text);
            if (!parsed || parsed.data.length === 0) {
                throw new CatalogError(`${asset.name} is not a valid Intel HEX file`);
            }
            return text;
        })();
        downloads.set(asset.name, started);
        return started;
    };

    const chosen = new Map<number, ReleaseAsset>();
    const outcomes = await forEachTarget(selector, escCount, async (target): Promise<McuInfo> => {
        const identity = await session.readEsc(target);
        const fileName = identity.meta.am32.fileName;
        if (!fileName) {
            throw new CatalogError(
                'reports no firmware name, so no release asset can be chosen for it; ' +
                'flash a local file with --hex --allow-mcu-mismatch'
            );
        }

        const asset = findFirmwareAsset(release.assets, fileName);
        if (!asset) {
            throw new CatalogError(`release ${release.tag} carries no asset for ${fileName}`);
        }

        const hex = await download(asset);
        chosen.set(target, asset);
        return session.flash(target, hex, options);
    });

    const escs = outcomes.map((outcome): OutcomeSummary & {
        firmwareName: string | null
        firmwareVersion: string | null
        bootByte: number | null
        asset: string | null
    } => {
        const info = outcome.value;
        const asset = chosen.get(outcome.target)?.name ?? null;
        if (!outcome.ok || !info) {
            return {
                ...summariseOutcome(outcome),
                firmwareName: null,
                firmwareVersion: null,
                bootByte: null,
                asset
            };
        }
        const bootByte = info.settings.BOOT_BYTE;
        return {
            ...summariseOutcome(outcome),
            firmwareName: info.meta.am32.fileName ?? null,
            firmwareVersion:
                `${String(info.settings.MAIN_REVISION ?? '?')}.${String(info.settings.SUB_REVISION ?? '?')}`,
            bootByte: typeof bootByte === 'number' ? bootByte : null,
            asset
        };
    });

    const lines = escs.map(esc => (esc.ok
        ? `ESC #${esc.esc}  flashed ${esc.asset ?? '?'} -> ${esc.firmwareName ?? 'unnamed'} ` +
          `v${esc.firmwareVersion ?? '?'}  boot byte 0x${(esc.bootByte ?? 0).toString(16).padStart(2, '0')}`
        : `ESC #${esc.esc}  FAILED ${esc.error ?? ''}`));

    return { data: { tag: release.tag, escs }, lines, exitCode: exitCodeForTargets(outcomes) };
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
