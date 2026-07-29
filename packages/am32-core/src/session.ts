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
 * `writeSettings` and `flash` arrived in block 5 rather than block 4 for a
 * structural reason worth recording: block 5 deletes the app's `src/communication`
 * stack, and it has no choice -- a `SerialPort` can be opened once, and two
 * `Link`s over one transport would each have their own mutex, so the legacy stack
 * and this session cannot share a port. The app's Save and Flash buttons
 * therefore have nowhere else to call. What they are is a behaviour-preserving
 * move of the code the app already ran. **Block 6 still owns read-back
 * verification** (which must exempt EEPROM byte 2, the one the bootloader stamps
 * with its own version) **and `applyDefaults`.**
 */

import { VirtualClock, createSystemClock, type Clock } from './clock';
import { decodeSettings, encodeSettings } from './eeprom/codec';
import { EEPROM_SIZE, EepromLayout, type EscSettings } from './eeprom/layout';
import { SessionError, causedBySessionError, describeError } from './errors';
import {
    SessionEmitter,
    type LogLevel,
    type SessionEventName,
    type SessionListener,
    type SessionState
} from './events';
import { FourWaySession } from './esc/fourway-session';
import { MspSession, type FcInfo } from './fc/msp-session';
import { fillImage, parseHex, type HexData } from './hex';
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

/**
 * What {@link Am32Session.writeSettings} did.
 *
 * The plan's API sketch has it returning `EscSettings`; it returns this instead
 * because the caller needs two more things the settings object cannot carry. The
 * app mirrors `image` into its `settingsBuffer` -- the buffer a *later* write
 * starts from, and what `EscView` reads the boot byte out of -- and `changed`
 * distinguishes "written" from "there was nothing to write", which is a log line
 * the app has always produced.
 */
export interface WriteSettingsResult {
    /** Zero-based channel. */
    target: number;
    /**
     * False when the patch encoded to the same 192 bytes the ESC already had, in
     * which case nothing was put on the wire.
     */
    changed: boolean;
    /** The settings as they now stand, decoded from the image below. */
    settings: EscSettings;
    /**
     * The 192 bytes written.
     *
     * Careful: this is what the host *sent*. A write to the EEPROM base has byte
     * 2 replaced by the bootloader's own version (AM32-bootloader
     * `main.c:517-524`), so the ESC's byte 2 may differ. Any read-back
     * verification block 6 adds has to exempt it.
     */
    image: Uint8Array;
}

export interface FlashOptions {
    /**
     * Write the image even though its embedded firmware name does not match the
     * ESC's. The app's "Ignore current mcu layout" checkbox, and block 7's
     * `--allow-mcu-mismatch`.
     */
    allowMcuMismatch?: boolean;
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

/**
 * Bytes per `cmd_DeviceWrite` while streaming a firmware image.
 *
 * 256 is the 4-way parameter maximum and what the app has always used. Each
 * chunk is even-length and 256-aligned, which is what the bootloader's
 * halfword programming and its erase-on-page-aligned-write rule require.
 */
const FLASH_CHUNK_BYTES = 0x100;

/** Byte-for-byte comparison. `compare()` from the app, which the core cannot import. */
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

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

    /**
     * Mutex: the tail of the chain of session operations.
     *
     * `Link` serialises one *exchange*; this serialises one *sequence of them*,
     * and the difference is the whole ball game. A 4-way `cmd_DeviceRead` acts on
     * whichever channel the last `cmd_DeviceInitFlash` selected, so two
     * overlapping `enumerate()` calls interleave into the link's single FIFO and
     * steal each other's channel selection -- one run comes back with ESC #0's
     * EEPROM image filed under target 1, `ok: true`, no error and no warning.
     * Block 6's `writeSettings` builds its outgoing buffer from that image, so
     * the same race writes one ESC's settings into another.
     *
     * Every public method's guard is a synchronous check before its first
     * `await`, and `setState` only happens after one resolves. Without this
     * chain those guards are decorative: a second caller passes them all while
     * the first is still in flight. Two clicks on a Read button is enough.
     */
    private tail: Promise<unknown> = Promise.resolve();

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
    connect (): Promise<FcInfo> {
        return this.exclusive(() => this.connectImpl());
    }

    private async connectImpl (): Promise<FcInfo> {
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
    enterPassthrough (): Promise<number> {
        return this.exclusive(() => this.enterPassthroughImpl());
    }

    private async enterPassthroughImpl (): Promise<number> {
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
            await this.exitPassthroughImpl();
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
    exitPassthrough (): Promise<void> {
        return this.exclusive(() => this.exitPassthroughImpl());
    }

    private async exitPassthroughImpl (): Promise<void> {
        if (!this.inPassthrough) {
            return;
        }
        await this.fourWay.exit();
        // The count belonged to that passthrough session. Keeping it would leave
        // `escCount` reporting channels nobody can address, against what the
        // getter promises.
        this.escCountValue = 0;
        this.setState('connected');
    }

    /**
     * Walk every channel the FC reports and read it.
     *
     * **Never throws because a channel failed** -- that is audit item **B**. It
     * throws only when there is nothing to enumerate: no connection, or
     * passthrough itself refused.
     */
    enumerate (): Promise<EscResult[]> {
        return this.exclusive(() => this.enumerateImpl());
    }

    private async enumerateImpl (): Promise<EscResult[]> {
        this.requireConnected();

        const count = await this.enterPassthroughImpl();
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
                    const info = await this.readEscImpl(target);
                    results.push({ target, ok: true, info });
                    this.emitter.emit('esc', { target, status: 'ok', info });
                } catch (error) {
                    // Already prefixed with the channel by `readEscImpl`, so
                    // every failure names the ESC it belongs to whether it came
                    // from the init-flash or from a read.
                    const message = describeError(error);
                    results.push({ target, ok: false, error: message });
                    this.emitter.emit('esc', { target, status: 'error', error: message });
                    this.emitter.emit('log', { level: 'error', message });
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
    readEsc (target: number): Promise<McuInfo> {
        return this.exclusive(() => this.readEscImpl(target));
    }

    /**
     * Every failure that comes out of here names its channel, and carries
     * `SessionError.target`.
     *
     * Not cosmetic: `EscResult.error` is the only thing block 5 has to show for a
     * failed channel, and without this only the init-flash path said which ESC it
     * meant. A read failure surfaced as a bare
     * `cmd_DeviceRead failed: no complete response within 500ms`.
     */
    private readEscImpl (target: number): Promise<McuInfo> {
        this.requirePassthrough();
        return this.labelled(target, () => this.readEscUnlabelled(target));
    }

    /**
     * `cmd_DeviceInitFlash` plus the MCU variant it implies.
     *
     * Every per-channel operation starts here, because 4-way is stateful: a read
     * or a write acts on whichever channel the last init-flash selected.
     */
    private async selectTarget (target: number): Promise<{ info: McuInfo, mcu: Mcu }> {
        const flash = await this.fourWay.initFlash(target).catch((error: unknown) => {
            throw new SessionError('esc-init', 'did not enter its bootloader', { cause: error, target });
        });

        const info = createMcuInfo(flash.params);

        // The signature decides the EEPROM offset, the page size and the flash
        // layout, so an unrecognised one is not something to carry forward: it
        // would send the very next read to an address invented out of a default.
        try {
            return { info, mcu: new Mcu(info.meta.signature) };
        } catch (error) {
            throw new SessionError(
                'esc-init',
                `unknown MCU signature 0x${info.meta.signature.toString(16).toUpperCase()}`,
                { cause: error, target }
            );
        }
    }

    private async readEscUnlabelled (target: number): Promise<McuInfo> {
        const { info, mcu } = await this.selectTarget(target);
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
    readSettings (target: number): Promise<EscSettings> {
        return this.exclusive(() => this.readEscImpl(target).then(info => info.settings));
    }

    /**
     * Apply `patch` to one channel's settings, preserving every byte it does not
     * name.
     *
     * The outgoing image is built from a **fresh read of the ESC**, not from
     * whatever the caller last saw, and only the layout's named, version-applicable
     * fields are overwritten. That is what keeps the firmware's
     * `reserved_eeprom_3[4]` at 13-16, the live CAN fields at 176-183 and
     * `can.reserved[8]` at 184-191 intact -- audit item **A**. The old encoder
     * started from a `0xFF` fill and routed anything wider than two bytes through
     * a UTF-8 string, which deleted a `can_node` of `0x20` and turned a `filter_hz`
     * of `0xC8` into 253.
     *
     * Reading first costs one 192-byte exchange and buys two things: a patch is a
     * legitimate input (the caller does not have to hold a whole image), and a
     * byte another client moved since the last read is not silently reverted.
     *
     * ⚠️ **Not verified yet.** Block 6 owns read-back verification, and its
     * verification must exempt byte 2 -- the bootloader force-overwrites it with
     * its own version inside every EEPROM write (AM32-bootloader
     * `main.c:517-524`), so a byte-for-byte compare of the whole image always
     * fails there.
     */
    writeSettings (target: number, patch: Partial<EscSettings>): Promise<WriteSettingsResult> {
        return this.exclusive(() => this.writeSettingsImpl(target, patch));
    }

    private writeSettingsImpl (target: number, patch: Partial<EscSettings>): Promise<WriteSettingsResult> {
        this.requirePassthrough();

        return this.labelled(target, async () => {
            const { mcu } = await this.selectTarget(target);
            const eepromOffset = mcu.getEepromOffset();

            const base = await this.fourWay.readAddress(eepromOffset, EEPROM_SIZE);
            const layoutRevision = base[EepromLayout.LAYOUT_REVISION.offset] ?? 0;
            const image = encodeSettings(base, patch, layoutRevision);

            if (bytesEqual(image, base)) {
                this.emitter.emit('log', {
                    level: 'info',
                    message: `ESC #${target + 1}: no changed settings to write`
                });
                return { target, changed: false, settings: decodeSettings(base, layoutRevision), image: base };
            }

            this.emitter.emit('progress', { phase: 'write', current: 0, total: 1, target });
            // One `cmd_DeviceWrite` of the whole 192 bytes, at the page base. It
            // has to be the whole struct: the write erases the page first, so a
            // partial sub-range would program without erasing and fail the
            // bootloader's own memcmp. `cmd_DeviceWriteEEprom` is not an option --
            // AM32 answers `CMD_PROG_EEPROM` with `brERRORCOMMAND`
            // (AM32-bootloader main.c:674-675) while ArduPilot can still report
            // ACK_OK for it.
            await this.fourWay.write(eepromOffset, image);
            this.emitter.emit('progress', { phase: 'write', current: 1, total: 1, target });
            this.emitter.emit('log', { level: 'info', message: `ESC #${target + 1}: settings written` });

            return { target, changed: true, settings: decodeSettings(image, layoutRevision), image };
        });
    }

    /**
     * Flash an Intel HEX firmware image to one channel, then reset it and read it
     * back.
     *
     * The shape, and why each step is where it is:
     *
     *  1. **Check the image against the ESC in front of us**, unless the caller
     *     opted out. The app compared every flash against channel 0's firmware
     *     name; this reads the name off the channel it is about to write, which is
     *     the only one that matters on a mixed board.
     *  2. **Clear EEPROM byte 0, then stream, then set it back to 1.** The
     *     bootloader jumps to the application only when that byte is `0x01` or
     *     `0xFF` (AM32-bootloader `main.c:306-319`, `CHECK_EEPROM_BEFORE_JUMP`
     *     defaults on), so `0x00` means "there is no complete application here".
     *     A flash that dies half way therefore leaves a board that comes up in its
     *     bootloader instead of running half an image. `EscView` renders that
     *     state as "Flash was unsuccessful".
     *  3. **Ascending, page-aligned, 256-byte chunks from the firmware start up to
     *     the EEPROM page.** The bootloader erases a page only when the write
     *     address is page-aligned (`Mcu/f051/Src/eeprom.c:34-44`), so the order is
     *     not a style choice; and the application image genuinely ends where the
     *     EEPROM page begins (`STM32F051K6TX_FLASH.ld:43-46`), with the 32-byte
     *     firmware-name block as its last bytes.
     *  4. **Reset and re-read.** The caller gets the ESC's actual post-flash state
     *     rather than the image it asked for.
     *
     * No timeout is a parameter: the page-write budget comes from `TimeoutPolicy`.
     * The call site that passed 200 ms for an operation the FC budgets ~700 ms for
     * was audit item **C**.
     *
     * Block 6 owns the verify pass (`cmd_DeviceVerify` cannot help -- AM32 answers
     * `CMD_VERIFY_FLASH_ARM` with `brERRORCOMMAND`, so it has to be a read-back)
     * and should decide whether a failed chunk retries from its page base, the way
     * AM32's own bootloader updater does (`AM32/Src/bootloader_update.c:78-108`).
     */
    flash (target: number, hex: string, options: FlashOptions = {}): Promise<McuInfo> {
        return this.exclusive(() => this.flashImpl(target, hex, options));
    }

    private flashImpl (target: number, hex: string, options: FlashOptions): Promise<McuInfo> {
        this.requirePassthrough();

        return this.labelled(target, async () => {
            const parsed = parseHex(hex);
            if (!parsed || parsed.data.length === 0) {
                throw new SessionError('image', 'not a valid Intel HEX file', { target });
            }

            const { mcu } = await this.selectTarget(target);
            const last = parsed.data[parsed.data.length - 1] as HexData;
            const image = fillImage(parsed, last.address + last.bytes - mcu.getFlashOffset(), mcu.getFlashOffset());
            if (!image) {
                throw new SessionError(
                    'image',
                    `the hex addresses flash this ${mcu.getName()} does not have`,
                    { target }
                );
            }

            if (!options.allowMcuMismatch) {
                await this.checkImageMatchesEsc(target, image, mcu);
            }

            const eepromOffset = mcu.getEepromOffset();
            const settingsImage = await this.fourWay.readAddress(eepromOffset, EEPROM_SIZE);

            await this.writeBootByte(eepromOffset, settingsImage, 0x00);
            await this.writeFirmware(target, image, mcu);
            await this.writeBootByte(eepromOffset, settingsImage, 0x01);

            this.emitter.emit('progress', { phase: 'reset', current: 0, total: 1, target });
            await this.fourWay.reset(target);
            this.emitter.emit('progress', { phase: 'reset', current: 1, total: 1, target });
            await this.clock.sleep(Mcu.RESET_DELAY_MS);

            this.emitter.emit('progress', { phase: 'read', current: 0, total: 1, target });
            const info = await this.readEscUnlabelled(target);
            this.emitter.emit('progress', { phase: 'read', current: 1, total: 1, target });
            this.emitter.emit('esc', { target, status: 'ok', info });

            return info;
        });
    }

    /**
     * Reject a hex built for a different board before anything is written.
     *
     * Both halves of the app's check, against the *target* channel's own name:
     * the MCU suffix (`..._F051`) and the layout prefix (`ARK_4IN1_...`). An ESC
     * whose name does not read back -- a fresh or half-flashed board -- skips the
     * check rather than becoming unflashable, which is what the app did by
     * accident and is the right behaviour on purpose: that board is exactly the
     * one that needs flashing.
     */
    private async checkImageMatchesEsc (target: number, image: Uint8Array, mcu: Mcu): Promise<void> {
        const nameAt = mcu.getEepromOffset() - FIRMWARE_NAME_BYTES;
        const hexName = decodeBytesZ(image.subarray(nameAt, nameAt + FIRMWARE_NAME_BYTES)).trim();
        if (!FIRMWARE_NAME_PATTERN.test(hexName)) {
            throw new SessionError(
                'image',
                'the hex carries no firmware name at the expected address, so it cannot be checked ' +
                'against this ESC -- it is probably built for another MCU, or too old. ' +
                'Flash it anyway with allowMcuMismatch.',
                { target }
            );
        }

        const escName = decodeBytesZ(
            await this.fourWay.readAddress(nameAt, FIRMWARE_NAME_BYTES)
        ).trim();
        if (!FIRMWARE_NAME_PATTERN.test(escName)) {
            this.emitter.emit('log', {
                level: 'warn',
                message: `ESC #${target + 1}: no firmware name to check the hex against; flashing ${hexName}`
            });
            return;
        }

        const escMcuType = escName.slice(escName.lastIndexOf('_') + 1);
        if (!hexName.endsWith(escMcuType)) {
            throw new SessionError(
                'image',
                `invalid MCU type in the hex: the ESC is a ${escMcuType} and the hex is ${hexName}`,
                { target }
            );
        }

        const hexLayout = hexName.slice(0, hexName.lastIndexOf('_'));
        const escLayout = escName.slice(0, escName.lastIndexOf('_'));
        if (hexLayout !== escLayout) {
            throw new SessionError(
                'image',
                `layout does not match: the ESC runs ${escLayout} and the hex is ${hexLayout}`,
                { target }
            );
        }
    }

    /** Rewrite the settings page with byte 0 forced to `value`. */
    private async writeBootByte (eepromOffset: number, settingsImage: Uint8Array, value: number): Promise<void> {
        const image = new Uint8Array(settingsImage);
        image[EepromLayout.BOOT_BYTE.offset] = value;
        await this.fourWay.write(eepromOffset, image);
    }

    /**
     * Stream the application region, in ascending 256-byte chunks.
     *
     * The bounds are derived from the MCU variant rather than the app's hardcoded
     * pages 4..0x40. The floor matters: `firmware_start` is 0x1000 on the F051 and
     * the ARM64K part but 0x4000 on the NXP one, and writing below the
     * bootloader's `APPLICATION_ADDRESS` is refused outright
     * (AM32-bootloader `main.c:443-446`). The ceiling matters more: the app's
     * 0x40 was the *end of flash*, so a hex whose records reached that far would
     * have taken the settings page with it. The application image ends where the
     * EEPROM page begins.
     */
    private async writeFirmware (target: number, image: Uint8Array, mcu: Mcu): Promise<void> {
        const begin = mcu.getFirmwareStart();
        const end = Math.min(image.length, mcu.getEepromOffset());
        const total = Math.max(0, end - begin);

        this.emitter.emit('progress', { phase: 'flash', current: 0, total, target });
        if (total === 0) {
            this.emitter.emit('log', {
                level: 'warn',
                message: `ESC #${target + 1}: the hex contains nothing above the firmware start; nothing written`
            });
            return;
        }

        let written = 0;
        for (let address = begin; address < end; address += FLASH_CHUNK_BYTES) {
            const chunk = image.subarray(address, Math.min(address + FLASH_CHUNK_BYTES, end));
            await this.fourWay.write(address, chunk);
            written += chunk.length;
            this.emitter.emit('progress', { phase: 'flash', current: written, total, target });
        }
    }

    /** `cmd_DeviceReset` -- leave the bootloader and run the application again. */
    reset (target: number): Promise<void> {
        return this.exclusive(() => this.resetImpl(target));
    }

    private async resetImpl (target: number): Promise<void> {
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
    disconnect (): Promise<void> {
        return this.exclusive(() => this.disconnectImpl());
    }

    private async disconnectImpl (): Promise<void> {
        if (this.stateValue === 'disconnected') {
            return;
        }

        if (this.inPassthrough) {
            await this.exitPassthroughImpl().catch((error: unknown) => {
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

    /**
     * Run `work` after every operation queued before it, in call order.
     *
     * The same promise-chain shape `Link` uses one layer down, and for the same
     * reason: overlapping callers become impossible rather than unlikely. The
     * chain is `.catch`ed after each link so a rejected operation cannot wedge
     * the queue -- that is the other half of "always settles".
     *
     * Public methods take this; the `*Impl` methods they delegate to do not, so
     * `enumerate` can call `enterPassthroughImpl` without deadlocking on a lock
     * it already holds.
     */
    private exclusive<T> (work: () => Promise<T>): Promise<T> {
        const result = this.tail.then(work);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    /**
     * Run `work` and make sure anything it throws says which ESC it belonged to.
     *
     * Not cosmetic: `EscResult.error` is the only thing a client has to show for a
     * failed channel, and before this only the init-flash path named one. A read
     * failure surfaced as a bare
     * `cmd_DeviceRead failed: no complete response within 500ms`.
     *
     * The reason and the ACK are carried up from the innermost `SessionError`,
     * because `Link.request` wraps whatever `validate` throws in a `LinkError` --
     * so `esc-read` for a short reply as against `esc-command` for a refused ACK
     * is one or two levels down. Flattening that loses exactly the information
     * the session exists to keep.
     */
    private async labelled<T> (target: number, work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            const inner = causedBySessionError(error);
            throw new SessionError(
                inner?.reason ?? 'esc-command',
                `ESC #${target + 1}: ${describeError(error)}`,
                { cause: error, target, ack: inner?.ack }
            );
        }
    }

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
