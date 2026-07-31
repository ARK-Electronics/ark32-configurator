/**
 * The 4-way half of the session: everything that reaches an ESC, through the
 * flight controller's passthrough.
 *
 * Two rules live here that used to live nowhere:
 *
 *  1. **No call site names a timeout.** Every exchange asks the `TimeoutPolicy`,
 *     keyed on the command, the bytes the *ESC* moves and the detected FC. Audit
 *     item **C** was `writeHex(i, hex, 200)` reaching a page write the firmware
 *     budgets ~700 ms for; the fix is not a bigger literal, it is that there is
 *     no parameter to pass one into.
 *  2. **A read is validated on length, not on the ACK.** ArduPilot answers a
 *     `cmd_DeviceRead` whose `CMD_SET_ADDRESS` handshake failed with `ACK_OK`
 *     and **one byte of uninitialised stack** -- `BL_ReadA` returns false at
 *     AP_BLHeli.cpp:786 without ever touching `blheli.ack` (:749-761), into a
 *     reply buffer that is a VLA nothing writes (:1098-1103). Every failed read
 *     on both firmwares comes back with exactly one param byte, so the rule is:
 *     *if you asked for N > 1 bytes and got fewer back, it is a failed read
 *     whatever the ACK says.* Blocks 1b and 2 both left this open; it closes
 *     here, in `validate`, so a short read retries with a drain exactly like a
 *     timeout instead of being handed up as data.
 */

import { countDifferences, firstDifference } from '../bytes';
import { SessionError, causedBySessionError, describeError } from '../errors';
import type { LogLevel } from '../events';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    FOUR_WAY_MAX_PARAMS,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse,
    type FourWayResponse
} from '../framing/fourway';
import type { Link } from '../link/link';
import { DEFAULT_TIMEOUT_POLICY, TimeoutPolicy } from '../link/timeout-policy';

/**
 * Total attempts for a routine 4-way exchange.
 *
 * Ten, matching what the app's `FOUR_WAY_DEFAULT_RETRIES` has always meant --
 * `retries` is *total attempts*, not extra ones (block 2's note, design decision
 * 1). Soft-serial to an ESC is genuinely lossy; this is the number PR #1's
 * hardening settled on and hardware is known to work with it.
 */
export const FOUR_WAY_DEFAULT_RETRIES = 10;

/** `cmd_DeviceInitFlash` is the flaky one -- it is the ESC entering its bootloader. */
export const FOUR_WAY_INIT_RETRIES = 10;

/**
 * The retry ladder for `cmd_DeviceInitFlash`: quick, SILENT, quick, quick,
 * SILENT, ... The long rungs are the load-bearing part, and they are
 * deliberate silences, not backoff.
 *
 * The AM32 *application* has no boot-init detector at all: the only road from
 * a running app to the bootloader is its unarmed signal-loss watchdog, 2.0 s
 * after the line goes quiet (AM32 `Src/faults.c:83-108`). Two consequences,
 * both seen on an ARK 4in1 with the factory v15 bootloader behind Betaflight:
 *
 *  - An init attempt whose TX lands in the freshly-reset bootloader's ~55 ms
 *    boot window bounces the ESC back to its app -- v15's float phase jumps on
 *    any low, software reset or not (`main.c:884`).
 *  - Once the app is running, *our own retries are what keep it alive*: the
 *    edges re-arm its input detection and the detect tones keep zeroing the
 *    signal-loss counter, so any steady retry cadence -- fixed or growing --
 *    fails every remaining attempt. The storm sustains the blindness it is
 *    trying to break.
 *
 * So the ladder goes silent for 3.6 s every third attempt: startup tune
 * (~1.4 s, tones hold the counter) + the 2.0 s watchdog + boot margin. A
 * bounced ESC starves in that silence, resets, and the next attempt finds its
 * bootloader resident and alone on the line. The quick rungs cover the common
 * cases -- already in the bootloader, or reset completed between attempts --
 * and cost nothing when the ESC answers first time.
 */
export const FOUR_WAY_INIT_RETRY_DELAYS_MS: readonly number[] =
    [300, 3600, 300, 300, 3600, 300, 300, 3600, 300];

export interface FourWaySessionOptions {
    link: Link;
    policy?: TimeoutPolicy;
    log?: (level: LogLevel, message: string) => void;
    retries?: number;
    initRetries?: number;
}

export interface FourWayCommandOptions {
    params?: ArrayLike<number>;
    address?: number;
    /** Total attempts. Defaults to the session's. */
    retries?: number;
    /** Per-retry delay ladder. See {@link FOUR_WAY_INIT_RETRY_DELAYS_MS}. */
    retryDelaysMs?: readonly number[];
    /**
     * Bytes the *ESC* moves, which is what the timeout scales with: the
     * requested count for a read, the written length for a write. Not the 4-way
     * param count -- for a read that is 1, and using it silently collapses the
     * derived budget to the floor.
     */
    payloadBytes?: number;
    /**
     * Reject a reply carrying fewer params than this, whatever the ACK says.
     * See the file header.
     */
    expectParams?: number;
}

const ackName = (ack: number): string => FOUR_WAY_ACK[ack] ?? `0x${ack.toString(16)}`;

export class FourWaySession {
    private readonly link: Link;
    private readonly log: (level: LogLevel, message: string) => void;
    private readonly retries: number;
    private readonly initRetries: number;

    /** Replaced by the session once the FC is known, so budgets follow the FC. */
    policy: TimeoutPolicy;

    constructor (options: FourWaySessionOptions) {
        this.link = options.link;
        this.policy = options.policy ?? DEFAULT_TIMEOUT_POLICY;
        this.log = options.log ?? (() => {});
        this.retries = Math.max(1, options.retries ?? FOUR_WAY_DEFAULT_RETRIES);
        this.initRetries = Math.max(1, options.initRetries ?? FOUR_WAY_INIT_RETRIES);
    }

    /**
     * One 4-way exchange. Resolves only with an `ACK_OK` reply of the expected
     * shape; anything else is retried with a drain and then thrown.
     */
    async command (command: FOUR_WAY_COMMANDS, options: FourWayCommandOptions = {}): Promise<FourWayResponse> {
        const params = options.params ?? [0];
        const label = FOUR_WAY_COMMANDS[command] ?? `4-way 0x${command.toString(16)}`;
        const captured: { response?: FourWayResponse, ack?: number } = {};

        try {
            await this.link.request(
                encodeFourWayRequest(command, params, options.address ?? 0),
                {
                    probe: isCompleteFourWayFrame,
                    timeout: this.policy.forFourWay(command, options.payloadBytes ?? params.length),
                    retries: options.retries ?? this.retries,
                    retryDelaysMs: options.retryDelaysMs,
                    label,
                    validate: (response) => {
                        const decoded = parseFourWayResponse(response);
                        captured.ack = decoded.ack;

                        // Command echo, the 4-way half of the check block 1b
                        // added for MSP (audit **D**: "whatever frame arrives is
                        // returned as the answer to whatever was just sent").
                        // Both firmwares echo the command they read
                        // (AP_BLHeli.cpp:610-623, serial_4way.c:896-919).
                        //
                        // What it guards: an exchange that gives up after its
                        // attempts can leave a reply in flight, and a stale frame
                        // that lands after the next drain's quiet window
                        // satisfies the next probe. Without this, a leftover
                        // ACK_OK `cmd_DeviceRead` reply is accepted as
                        // `cmd_DeviceInitFlash`'s device info and `createMcuInfo`
                        // builds an MCU signature out of EEPROM bytes.
                        //
                        // The *address* is deliberately not checked: ArduPilot
                        // forces `cmd_DevicePageErase`'s echoed address to 0x0000
                        // (AP:1122) where Betaflight echoes the computed one
                        // (BF:675-680), so an address check would be wrong on one
                        // firmware or the other.
                        if (decoded.command !== command) {
                            throw new SessionError(
                                'esc-command',
                                `${label}: reply echoes command 0x${decoded.command.toString(16)}, not ` +
                                `0x${command.toString(16)} -- a frame left over from an earlier exchange`
                            );
                        }

                        if (decoded.ack !== FOUR_WAY_ACK.ACK_OK) {
                            throw new SessionError(
                                'esc-command',
                                `${label}: ${ackName(decoded.ack)}`,
                                { ack: decoded.ack }
                            );
                        }

                        if (options.expectParams !== undefined && decoded.params.length < options.expectParams) {
                            throw new SessionError(
                                'esc-read',
                                `${label}: asked for ${options.expectParams} byte(s), got ${decoded.params.length} ` +
                                `with ${ackName(decoded.ack)} -- a short reply is a failed operation whatever the ACK says`,
                                { ack: decoded.ack }
                            );
                        }

                        captured.response = decoded;
                    }
                }
            );
        } catch (error) {
            // `Link.request` wraps a `validate` rejection in a LinkError, so the
            // reason this exchange really failed is one level down. Flattening
            // it to `esc-command` would lose the short-read distinction the
            // validator exists to make.
            const inner = causedBySessionError(error);
            throw new SessionError(inner?.reason ?? 'esc-command', `${label} failed: ${describeError(error)}`, {
                cause: error,
                ack: inner?.ack ?? captured.ack
            });
        }

        if (!captured.response) {
            throw new SessionError('esc-command', `${label}: link resolved with no response`);
        }
        return captured.response;
    }

    /**
     * `cmd_DeviceInitFlash` -- select a channel and bring its bootloader up.
     *
     * Both firmwares retry the bootloader handshake three times internally
     * (AP_BLHeli.cpp:1066-1078, serial_4way.c:340) before answering, so the ten
     * attempts here sit on top of thirty ESC-side ones.
     *
     * No `expectParams` here on purpose. A four-byte device-info check would
     * look load-bearing and never run: both firmwares report a failed connect
     * with a non-OK ACK (AP:1081-1083, BF:636-643), which the ACK check already
     * catches, and neither can answer `ACK_OK` with a short device info. The
     * shape that *is* worth checking -- a signature no MCU variant knows -- is
     * checked where it is reachable, in `Am32Session.readEsc`.
     */
    initFlash (target: number, retries?: number): Promise<FourWayResponse> {
        return this.command(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, {
            params: [target],
            retries: retries ?? this.initRetries,
            retryDelaysMs: FOUR_WAY_INIT_RETRY_DELAYS_MS
        });
    }

    /**
     * Read `bytes` from `address`, or throw.
     *
     * `bytes === 256` goes on the wire as a param count of 0, which is how both
     * firmwares encode the maximum.
     */
    async readAddress (address: number, bytes: number, retries?: number): Promise<Uint8Array> {
        const response = await this.command(FOUR_WAY_COMMANDS.cmd_DeviceRead, {
            params: [bytes === FOUR_WAY_MAX_PARAMS ? 0 : bytes],
            address,
            retries,
            payloadBytes: bytes,
            expectParams: bytes
        });
        return response.params;
    }

    /**
     * `cmd_DeviceWrite` -- program `data` at `address`.
     *
     * There is no length check to make here: unlike a read, a write's reply
     * carries no payload worth counting, and both firmwares report a refused
     * program with a non-OK ACK, which the ACK check already catches.
     *
     * Three rules the *bootloader* imposes on the caller, all confirmed against
     * `AM32-bootloader/Mcu/f051/Src/eeprom.c:20-22,34-44,62`:
     *
     *  - `address` and `data.length` must both be even.
     *  - The page is erased **only** when `address` is page-aligned, so pages must
     *    be streamed in ascending order and each page's first write must land on
     *    its boundary. A write into a page that was never erased can only clear
     *    bits, so the bootloader's own `memcmp` verify fails and it answers an
     *    error -- exactly like real flash.
     *  - A write to the EEPROM base has payload byte 2 replaced by the
     *    bootloader's own version (`main.c:517-524`), so `BOOT_LOADER_REVISION`
     *    never round-trips.
     */
    async write (address: number, data: ArrayLike<number>): Promise<void> {
        await this.command(FOUR_WAY_COMMANDS.cmd_DeviceWrite, {
            params: data,
            address,
            payloadBytes: data.length
        });
    }

    /**
     * Read `expected.length` bytes back from `address` and compare them.
     *
     * Returns what the ESC actually holds, so the caller can keep it rather than
     * keep what it sent. Throws `SessionError('esc-verify')` on a mismatch, naming
     * the first differing byte -- a hardware checkpoint that only learns "the write
     * did not verify" has nothing to go on.
     *
     * **Why this exists when the bootloader already verifies its own writes.**
     * `save_flash_nolib` ends in a `memcmp` and returns false on a mismatch
     * (`Mcu/f051/Src/eeprom.c:61-62`), which the bootloader reports as a bad ACK
     * (`bootloader/main.c:527-528`), so a *programming* failure is loud. The gap is
     * in the flight controller: `BL_WriteA` leaks `ACK_OK` when its final
     * `BL_GetACK` times out (`AP_BLHeli.cpp:928-932`), so a write the ESC never
     * confirmed -- or never received, since the FC gives up before
     * `CMD_PROG_FLASH` on some paths -- reaches the host as a success.
     *
     * `exempt` is for bytes the ESC legitimately changes. There is exactly one:
     * see {@link BOOTLOADER_STAMPED_OFFSET}.
     *
     * Deliberately **not** a `validate` on the write's own exchange, which is where
     * block 2 put every other check of this kind. A write's reply carries no
     * payload, so there is nothing in it to compare -- verification needs a second
     * exchange, and `validate` cannot start one (it runs inside the link's mutex).
     * The retry therefore has to live above the link. See
     * `Am32Session.writeFirmware` for the page-granularity that goes with it.
     */
    async verifyRange (
        address: number,
        expected: Uint8Array,
        options: { exempt?: ReadonlySet<number>, what?: string } = {}
    ): Promise<Uint8Array> {
        const actual = await this.readAddress(address, expected.length);
        const diff = firstDifference(expected, actual, options.exempt);

        if (diff !== null) {
            const differing = countDifferences(expected, actual, options.exempt);
            throw new SessionError(
                'esc-verify',
                `${options.what ?? 'the write'} did not verify: byte ${diff} at ` +
                `0x${(address + diff).toString(16).toUpperCase()} reads ` +
                `0x${(actual[diff] ?? 0).toString(16).toUpperCase()}, wrote ` +
                `0x${(expected[diff] ?? 0).toString(16).toUpperCase()} ` +
                `(${differing} of ${expected.length} byte(s) differ)`
            );
        }

        return actual;
    }

    /**
     * `cmd_DeviceReset` -- run the application again on `target`.
     *
     * `rebootEsc` sets the request's address low byte to 1, which Betaflight
     * honours by driving the ESC's signal line LOW for 300 ms after the
     * restart command (serial_4way.c:588,604-611). That low hold is what makes
     * the reset *unconditional*: the AM32 bootloader leaves for the app after
     * 20 ms of continuous low (`invalid_command = 101`, bootloader
     * main.c:432 in v15, :718-724 in v18) even when its serial parser is
     * desynced and the restart command itself arrived as garbage. ArduPilot
     * ignores the address bytes entirely (AP_BLHeli.cpp:1030-1051), so the
     * flag costs nothing there. The 300 ms is already in the reset budget
     * (`DEVICE_RESET_MS` in the timeout policy).
     */
    async reset (target: number, options: { rebootEsc?: boolean } = {}): Promise<void> {
        await this.command(FOUR_WAY_COMMANDS.cmd_DeviceReset, {
            params: [target],
            address: options.rebootEsc ? 1 : 0
        });
    }

    /** True if the selected channel's bootloader is still answering. */
    async testAlive (): Promise<boolean> {
        try {
            await this.command(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, { retries: 1 });
            return true;
        } catch (error) {
            this.log('info', `cmd_InterfaceTestAlive: ${describeError(error)}`);
            return false;
        }
    }

    /**
     * Leave passthrough. One attempt, reply ignored: both firmwares send the ACK
     * and *then* tear the interface down (serial_4way.c:923-926,
     * AP_BLHeli.cpp:1014-1027), so waiting on it buys nothing, and if the FC has
     * already left there is nothing to wait for.
     */
    async exit (): Promise<void> {
        await this.link.request(encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceExit), {
            probe: isCompleteFourWayFrame,
            timeout: this.policy.forFourWay(FOUR_WAY_COMMANDS.cmd_InterfaceExit),
            retries: 1,
            label: 'cmd_InterfaceExit'
        }).catch((error: unknown) => {
            this.log('info', `cmd_InterfaceExit: ${describeError(error)}`);
            return null;
        });
    }
}
