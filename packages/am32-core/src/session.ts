/**
 * `Am32Session` -- the one programmatic interface to a flight controller and
 * its ESCs.
 *
 * Everything above this line is a client: the Nuxt app (block 5) and the `ark32`
 * CLI (block 7) both drive it, so there is never a second protocol stack. Rules
 * the firmware imposes are enforced *here*, where a caller cannot get them
 * wrong, rather than documented in a comment a caller can skip:
 *
 *  - **`connect()` probes before it waits.** ArduPilot hands the port to MSP
 *    only after 4 s with no valid MAVLink; Betaflight has no such rule. The app
 *    paid the wait unconditionally, so every Betaflight connect cost 4.5 s for
 *    nothing. Audit item **H**. See `fc/msp-session.ts` for why probing first is
 *    sound and not merely optimistic.
 *  - **`enumerate()` returns per-target results and never throws on a partial
 *    failure.** The old handler pushed an entry with no `data` when an ESC
 *    failed and then dereferenced `.data.settingsBuffer` across all of them, so
 *    one bad channel took the other three down with a `TypeError` out of a click
 *    handler. Audit item **B**. Partial enumeration is the expected case here,
 *    not an exception.
 *  - **MSP is refused while in passthrough.** On Betaflight the frame is
 *    swallowed unanswered (serial_4way.c:453-461); on ArduPilot it is *worse* --
 *    a `$` between 4-way frames silently leaves passthrough and calls
 *    `serial_end()` (AP_BLHeli.cpp:1242-1246), disconnecting every ESC, so the
 *    reply arrives and the *next* 4-way command is the one that fails. The plan
 *    calls ArduPilot's behaviour "multiplexed"; it is a mode switch with a side
 *    effect. Either way the answer is the same: do not.
 *  - **No timeout is a parameter.** They all come from `TimeoutPolicy`, which
 *    adopts the FC's own budgets once `connect()` has identified it.
 *
 * Not here yet, deliberately: `writeSettings`, `applyDefaults` and `flash` are
 * block 6, which owns read-back verification and page handling. They are absent
 * rather than stubbed -- a method that exists and does not verify is how audit
 * item **A** survived this long.
 */

import { VirtualClock, createSystemClock, type Clock } from './clock';
import { decodeSettings } from './eeprom/codec';
import { EEPROM_SIZE, EepromLayout, type EscSettings } from './eeprom/layout';
import { SessionError, describeError } from './errors';
import {
    SessionEmitter,
    type LogLevel,
    type SessionEventName,
    type SessionListener,
    type SessionState
} from './events';
import { FourWaySession } from './esc/fourway-session';
import { MspSession, type FcInfo } from './fc/msp-session';
import { Link, type LinkOptions } from './link/link';
import { DEFAULT_TIMEOUT_POLICY, TimeoutPolicy } from './link/timeout-policy';
import { Mcu, createMcuInfo, type McuInfo } from './mcu';
import { decodeBytesZ } from './text';
import type { Transport } from './transport';

export type { FcApiVersion, FcBattery, FcInfo } from './fc/msp-session';
export type { FcQuirks, MspInPassthrough } from './fc/quirks';
export { SessionError } from './errors';
export type { SessionErrorReason } from './errors';
export type {
    EscEvent,
    LogEvent,
    ProgressEvent,
    SessionEventName,
    SessionEvents,
    SessionState,
    StateEvent
} from './events';

/**
 * One channel's outcome from {@link Am32Session.enumerate}.
 *
 * `ok: false` carries an `error` string and no `info`; there is no third shape,
 * which is what makes the caller's `if (result.ok)` exhaustive.
 *
 * Note `am32-sim` exports an unrelated `EscResult` describing one *bootloader
 * operation* (`{ ack, data, durationMs, returnedBytes }`). The two are
 * structurally disjoint, so TypeScript separates them, but a file importing both
 * should alias one.
 */
export interface EscResult {
    /** Zero-based channel, as `cmd_DeviceInitFlash` numbers them. */
    target: number;
    ok: boolean;
    info?: McuInfo;
    error?: string;
}

export interface Am32SessionOptions {
    transport: Transport;
    /** Real time in production, {@link VirtualClock} in tests. */
    clock?: Clock;
    policy?: TimeoutPolicy;
    link?: Omit<LinkOptions, 'clock'>;

    /** Total attempts for a routine 4-way exchange. */
    fourWayRetries?: number;
    /** Total attempts for `cmd_DeviceInitFlash`. */
    initFlashRetries?: number;
    /** Total attempts for a routine MSP exchange. */
    mspRetries?: number;

    /** Budget for the probe-then-wait connect, including the idle window. */
    idleWindowMs?: number;
    /** Gap between polls inside the idle window. */
    pollIntervalMs?: number;

    /**
     * Settle after `MSP_SET_PASSTHROUGH` before the first soft-serial command.
     *
     * Carried over from the app unchanged, which is the conservative choice: it
     * is a number real hardware is known to work with and no hardware checkpoint
     * has run since. Betaflight's `esc4wayInit` calls `motorDisable()` and
     * reconfigures the motor pins as inputs (serial_4way.c:141-152), and
     * ArduPilot's `MSP_SET_PASSTHROUGH` declares `EXPECT_DELAY_MS(1000)` for
     * `serial_setup_output` (AP_BLHeli.cpp:592). Free under a virtual clock.
     */
    passthroughSettleMs?: number;

    /**
     * Settle between ESC channels during an enumerate.
     *
     * Also carried over from the app: PR #1 added it because leftover
     * soft-serial state disproportionately killed the last channel.
     */
    interEscDelayMs?: number;

    /** Baud rate for `transport.open()` when `connect()` has to open it. */
    baudRate?: number;
}

const DEFAULT_PASSTHROUGH_SETTLE_MS = 2000;
const DEFAULT_INTER_ESC_DELAY_MS = 300;
const DEFAULT_BAUD_RATE = 115200;

/**
 * The AM32 firmware name lives in the 32 bytes below the EEPROM page
 * (`ADDRESS_MAGIC_FILE_NAME`, AM32-bootloader `main.c:556-559`).
 */
const FIRMWARE_NAME_BYTES = 32;

/**
 * Accept a firmware name that contains a run of name characters.
 *
 * Deliberately the app's unanchored test rather than a stricter anchored one:
 * its real job is to reject an erased (`0xFF`) or empty read, and tightening it
 * would newly reject any real name with a character outside the class -- which
 * would silently break the firmware-catalog lookup, whose key is this string.
 */
const FIRMWARE_NAME_PATTERN = /[A-Z0-9_]+/;

export class Am32Session {
    private readonly transport: Transport;
    private readonly clock: Clock;
    private readonly link: Link;
    private readonly msp: MspSession;
    private readonly fourWay: FourWaySession;
    private readonly emitter = new SessionEmitter();

    private readonly passthroughSettleMs: number;
    private readonly interEscDelayMs: number;
    private readonly baudRate: number;

    private stateValue: SessionState = 'idle';
    private fcInfo: FcInfo | null = null;
    private escCountValue = 0;

    constructor (options: Am32SessionOptions) {
        this.transport = options.transport;
        this.clock = options.clock ?? createSystemClock();
        this.passthroughSettleMs = Math.max(0, options.passthroughSettleMs ?? DEFAULT_PASSTHROUGH_SETTLE_MS);
        this.interEscDelayMs = Math.max(0, options.interEscDelayMs ?? DEFAULT_INTER_ESC_DELAY_MS);
        this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;

        const log = (level: LogLevel, message: string) => this.emitter.emit('log', { level, message });
        const policy = options.policy ?? DEFAULT_TIMEOUT_POLICY;

        this.link = new Link(this.transport, {
            ...options.link,
            clock: this.clock,
            log: options.link?.log ?? (message => log('info', message))
        });

        this.msp = new MspSession({
            link: this.link,
            clock: this.clock,
            policy,
            log,
            retries: options.mspRetries,
            idleWindowMs: options.idleWindowMs,
            pollIntervalMs: options.pollIntervalMs
        });

        this.fourWay = new FourWaySession({
            link: this.link,
            policy,
            log,
            retries: options.fourWayRetries,
            initRetries: options.initFlashRetries
        });
    }

    // ---- state -------------------------------------------------------------

    get state (): SessionState {
        return this.stateValue;
    }

    /** Null until {@link connect} succeeds. */
    get fc (): FcInfo | null {
        return this.fcInfo;
    }

    /**
     * Channels the FC said it will address, from the `MSP_SET_PASSTHROUGH`
     * reply. Zero until {@link enterPassthrough} has run.
     */
    get escCount (): number {
        return this.escCountValue;
    }

    get inPassthrough (): boolean {
        return this.stateValue === 'passthrough' || this.stateValue === 'enumerating';
    }

    /** Link counters -- attempts, timeouts, drains, discarded bytes. */
    get stats () {
        return this.link.stats;
    }

    on<K extends SessionEventName> (event: K, listener: SessionListener<K>): () => void {
        return this.emitter.on(event, listener);
    }

    // ---- lifecycle ---------------------------------------------------------

    /**
     * Identify the flight controller, opening the transport first if the caller
     * has not.
     *
     * Betaflight is answered on the first frame; ArduPilot pays the MAVLink idle
     * window only when it actually has one to sit out.
     */
    async connect (): Promise<FcInfo> {
        if (this.stateValue === 'disconnected') {
            throw new SessionError('transport', 'session already disconnected; build a new one');
        }
        this.requireMspAvailable('connect');

        this.setState('connecting');
        this.emitter.emit('progress', { phase: 'connect', current: 0, total: 1 });

        if (!this.transport.isOpen) {
            try {
                await this.transport.open({ baudRate: this.baudRate });
            } catch (error) {
                this.setState('idle');
                throw new SessionError('transport', `could not open the port: ${describeError(error)}`, {
                    cause: error
                });
            }
        }

        let info: FcInfo;
        try {
            info = await this.msp.connect();
        } catch (error) {
            this.setState('idle');
            throw error;
        }

        // One place adopts the FC's budgets; every call site below inherits them.
        this.fourWay.policy = this.msp.policy;
        this.fcInfo = info;
        this.setState('connected');

        this.emitter.emit('log', {
            level: 'info',
            message: `connected to ${info.variantId || 'an unknown FC'} ` +
                `(MSP API ${info.apiVersion.major}.${info.apiVersion.minor}, ` +
                `${info.motorCount} motor(s)) in ${info.connectMs}ms` +
                (info.waitedForMavlinkWindow ? ', after the MAVLink idle window' : '')
        });
        this.emitter.emit('progress', { phase: 'connect', current: 1, total: 1 });

        return info;
    }

    /**
     * Enter 4-way passthrough and return the channel count the FC reports.
     *
     * A count of zero is not an error and not a state to stay in. Betaflight
     * installs the blocking `esc4wayProcess` **unconditionally**, even when it
     * has just answered that there are no ESCs (msp.c:328-333 is not guarded by
     * the count), so a host that shrugs at zero is left trapped in a loop with
     * nothing to talk to and only `cmd_InterfaceExit` gets it out. So: exit, log
     * it, and return 0.
     */
    async enterPassthrough (): Promise<number> {
        this.requireConnected();

        if (this.inPassthrough) {
            return this.escCountValue;
        }

        this.emitter.emit('progress', { phase: 'passthrough', current: 0, total: 1 });
        const count = await this.msp.enterPassthrough();

        // The FC is in passthrough from the moment it sends that reply, whatever
        // the count was -- so the state has to move before any early return, or
        // an exit would be skipped and the next MSP call would hang.
        this.escCountValue = count;
        this.setState('passthrough');

        if (count === 0) {
            this.emitter.emit('log', {
                level: 'warn',
                message: 'the FC reports 0 ESCs but entered passthrough anyway; leaving it'
            });
            await this.exitPassthrough();
            return 0;
        }

        this.emitter.emit('log', { level: 'info', message: `passthrough ready, ${count} ESC(s)` });

        if (this.passthroughSettleMs > 0) {
            await this.clock.sleep(this.passthroughSettleMs);
        }

        this.emitter.emit('progress', { phase: 'passthrough', current: 1, total: 1 });
        return count;
    }

    /** Leave passthrough. Safe to call when not in it. */
    async exitPassthrough (): Promise<void> {
        if (!this.inPassthrough) {
            return;
        }
        await this.fourWay.exit();
        this.setState('connected');
    }

    /**
     * Walk every channel the FC reports and read it.
     *
     * **Never throws because a channel failed** -- that is audit item **B**. It
     * throws only when there is nothing to enumerate: no connection, or
     * passthrough itself refused.
     */
    async enumerate (): Promise<EscResult[]> {
        this.requireConnected();

        const count = await this.enterPassthrough();
        if (count === 0) {
            return [];
        }

        this.setState('enumerating');
        const results: EscResult[] = [];

        try {
            for (let target = 0; target < count; target += 1) {
                this.emitter.emit('esc', { target, status: 'reading' });
                this.emitter.emit('progress', { phase: 'enumerate', current: target, total: count, target });

                try {
                    const info = await this.readEsc(target);
                    results.push({ target, ok: true, info });
                    this.emitter.emit('esc', { target, status: 'ok', info });
                } catch (error) {
                    const message = describeError(error);
                    results.push({ target, ok: false, error: message });
                    this.emitter.emit('esc', { target, status: 'error', error: message });
                    this.emitter.emit('log', { level: 'error', message: `ESC #${target + 1}: ${message}` });
                }

                if (target < count - 1 && this.interEscDelayMs > 0) {
                    await this.clock.sleep(this.interEscDelayMs);
                }
            }
        } finally {
            if (this.stateValue === 'enumerating') {
                this.setState('passthrough');
            }
        }

        this.emitter.emit('progress', { phase: 'enumerate', current: count, total: count });
        return results;
    }

    /**
     * Select `target`, read its identity and its whole 192-byte EEPROM image.
     *
     * Note what it does *not* do: the app's `getInfo` wrote to the ESC when it
     * saw `BOOT_LOADER_REVISION === 0xFF`, a read with a surprising side effect
     * -- and one that never worked, because the bootloader force-overwrites
     * byte 2 with its own version inside every EEPROM write
     * (AM32-bootloader `main.c:517-525`). Block 6 removes it from the app; there
     * was never a reason to reproduce it here.
     */
    async readEsc (target: number): Promise<McuInfo> {
        this.requirePassthrough();

        const flash = await this.fourWay.initFlash(target).catch((error: unknown) => {
            throw new SessionError('esc-init', `ESC #${target + 1} did not enter its bootloader`, {
                cause: error,
                target
            });
        });

        const info = createMcuInfo(flash.params);

        // The signature decides the EEPROM offset, the page size and the flash
        // layout, so an unrecognised one is not something to carry forward: it
        // would send the very next read to an address invented out of a default.
        let mcu: Mcu;
        try {
            mcu = new Mcu(info.meta.signature);
        } catch (error) {
            throw new SessionError(
                'esc-init',
                `ESC #${target + 1}: unknown MCU signature 0x${info.meta.signature.toString(16).toUpperCase()}`,
                { cause: error, target }
            );
        }
        const eepromOffset = mcu.getEepromOffset();

        const nameBytes = await this.fourWay.readAddress(eepromOffset - FIRMWARE_NAME_BYTES, FIRMWARE_NAME_BYTES);
        const fileName = decodeBytesZ(nameBytes);
        if (FIRMWARE_NAME_PATTERN.test(fileName)) {
            info.meta.am32.fileName = fileName;
            info.meta.am32.mcuType = fileName.slice(fileName.lastIndexOf('_') + 1);
        }

        // The bootloader pin code arrives in the init-flash reply, not the EEPROM.
        info.bootloader.input = info.meta.input;

        const buffer = await this.fourWay.readAddress(eepromOffset, EEPROM_SIZE);
        // The ESC's own layout revision, read from the image rather than from the
        // settings object that is about to be built out of it -- passing the
        // latter is what silently disabled version gating before block 1b.
        const layoutRevision = buffer[EepromLayout.LAYOUT_REVISION.offset] ?? 0;
        info.settings = decodeSettings(buffer, layoutRevision);
        info.settingsBuffer = buffer;

        const [valid, pin] = Mcu.parseBootLoaderPin(info.bootloader.input);
        if (valid) {
            info.bootloader.valid = true;
            info.bootloader.pin = pin;
            info.bootloader.version = (info.settings.BOOT_LOADER_REVISION as number | undefined) ?? 0;
        } else {
            this.emitter.emit('log', {
                level: 'warn',
                message: `ESC #${target + 1}: invalid bootloader pin ${info.bootloader.input}`
            });
        }

        return info;
    }

    /** The decoded settings for one channel. See {@link readEsc} for the image. */
    async readSettings (target: number): Promise<EscSettings> {
        const info = await this.readEsc(target);
        return info.settings;
    }

    /** `cmd_DeviceReset` -- leave the bootloader and run the application again. */
    async reset (target: number): Promise<void> {
        this.requirePassthrough();
        this.emitter.emit('progress', { phase: 'reset', current: 0, total: 1, target });
        await this.fourWay.reset(target);
        this.emitter.emit('progress', { phase: 'reset', current: 1, total: 1, target });
    }

    /**
     * Leave passthrough if we are in it, stop listening, and close the port.
     *
     * Terminal: a disconnected session cannot be reconnected, because the link's
     * RX subscription is gone with it. Build a new one.
     */
    async disconnect (): Promise<void> {
        if (this.stateValue === 'disconnected') {
            return;
        }

        if (this.inPassthrough) {
            await this.exitPassthrough().catch((error: unknown) => {
                this.emitter.emit('log', {
                    level: 'warn',
                    message: `could not leave passthrough cleanly: ${describeError(error)}`
                });
            });
        }

        this.link.dispose();
        await this.transport.close().catch((error: unknown) => {
            this.emitter.emit('log', {
                level: 'warn',
                message: `could not close the port: ${describeError(error)}`
            });
        });

        this.fcInfo = null;
        this.escCountValue = 0;
        this.setState('disconnected');
    }

    // ---- internals ---------------------------------------------------------

    private setState (state: SessionState): void {
        if (state === this.stateValue) {
            return;
        }
        const previous = this.stateValue;
        this.stateValue = state;
        this.emitter.emit('state', { state, previous });
    }

    private requireConnected (): void {
        if (!this.fcInfo) {
            throw new SessionError('not-connected', 'call connect() first');
        }
    }

    /**
     * Refuse to put an MSP frame on the wire while the FC is in passthrough.
     *
     * Betaflight discards it unanswered, so the caller just waits out a timeout.
     * ArduPilot is worse: the `$` drops it out of 4-way and calls `serial_end()`
     * (AP_BLHeli.cpp:1242-1246), so the MSP reply *arrives* and every ESC is
     * quietly disconnected -- the failure then surfaces on some later 4-way
     * command, a long way from its cause. This is the API enforcing a rule
     * rather than documenting one.
     */
    private requireMspAvailable (what: string): void {
        if (!this.inPassthrough) {
            return;
        }
        const behaviour = this.fcInfo?.quirks.mspInPassthrough ?? 'ignored';
        throw new SessionError(
            'passthrough',
            `${what}: MSP is not available in 4-way passthrough (this FC ${
                behaviour === 'exits-passthrough'
                    ? 'would silently leave passthrough and disconnect every ESC'
                    : 'discards the frame unanswered'
            }). Call exitPassthrough() first.`
        );
    }

    private requirePassthrough (): void {
        if (!this.inPassthrough) {
            throw new SessionError(
                'passthrough',
                'not in 4-way passthrough; call enterPassthrough() or enumerate() first'
            );
        }
    }
}

/**
 * Re-exported so a caller that only imports `am32-core/session` still has the
 * clocks, the quirk records and the types it needs. Block 5's
 * `no-restricted-imports` rule makes this the only door into the core from a
 * Vue component, so everything a component legitimately needs has to come
 * through it.
 */
export { VirtualClock, createSystemClock };
export {
    ARDUPILOT_QUIRKS,
    BETAFLIGHT_QUIRKS,
    GENERIC_QUIRKS,
    quirksForFcVariantId,
    quirksForVariant
} from './fc/quirks';
export type { Clock, McuInfo, Transport };
export type { EscSettings, McuSettings } from './eeprom/layout';
export type { FcVariant } from './link/timeout-policy';
