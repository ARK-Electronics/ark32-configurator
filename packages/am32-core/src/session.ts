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

import { bytesEqual } from './bytes';
import { VirtualClock, createSystemClock, type Clock } from './clock';
import { decodeSettings, encodeSettings } from './eeprom/codec';
import {
    DEFAULTS_PRESERVED_FIELDS,
    DEFAULT_SETTINGS_IMAGE,
    DEFAULT_STARTUP_MELODY
} from './eeprom/defaults';
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
    /**
     * True when the ESC's own bytes were confirmed by a read.
     *
     * False only when the caller passed `{ verify: false }` *and* something was
     * written. A `changed: false` result is `verified: true`: the fresh read the
     * patch was encoded onto is itself the proof that the ESC holds these bytes.
     */
    verified: boolean;
    /** The settings as they now stand, decoded from the image below. */
    settings: EscSettings;
    /**
     * The 192 bytes the ESC holds.
     *
     * With verification on this is the **read-back** image, so byte 2 carries the
     * bootloader's real version rather than whatever the host sent -- which is what
     * makes it safe for a client to mirror into a `settingsBuffer` and start the
     * next write from. With `{ verify: false }` it is what the host sent, and byte
     * 2 is then a guess (the bootloader replaces it inside every write to the
     * EEPROM base, `AM32-bootloader/main.c:517-525`).
     */
    image: Uint8Array;
}

export interface WriteSettingsOptions {
    /**
     * Read the page back and compare it, byte for byte, before reporting success.
     * Default true.
     *
     * The plan's `writeSettings(target, patch, opts?)` third parameter, and block
     * 7's `--no-verify`. Turning it off saves one 192-byte exchange per ESC and
     * gives up the only thing that catches a write the flight controller reported
     * as OK without the ESC ever confirming it (`AP_BLHeli.cpp:928-932`).
     */
    verify?: boolean;
}

export interface ApplyDefaultsOptions extends WriteSettingsOptions {
    /**
     * The default image to apply. Defaults to AM32's own `default_settings[]`
     * (see `eeprom/defaults.ts`), which needs no network and is what makes this
     * usable from the CLI and from a deployment with no firmware catalog.
     *
     * A shorter image is fine and is the normal case: the served
     * `/api/eeprom/<board>?version=N` files are the same 48 bytes, and every field
     * that does not fit is simply not part of the patch.
     */
    image?: Uint8Array;
    /**
     * Layout revision to decode `image` with. Defaults to the ESC's own, read
     * from the page this write is about to be built on.
     *
     * The plan sketches this as a positional `applyDefaults(target,
     * layoutRevision)`. It is an option because the right value is the ESC's, and a
     * caller that has to supply it can get it wrong -- the app used to clamp
     * anything above 3 to 2 while the server clamped it to 3.
     */
    layoutRevision?: number;
}

export interface FlashOptions {
    /**
     * Write the image even though its embedded firmware name does not match the
     * ESC's. The app's "Ignore current mcu layout" checkbox, and block 7's
     * `--allow-mcu-mismatch`.
     */
    allowMcuMismatch?: boolean;
    /**
     * Read every chunk back and compare it before moving on. Default true.
     *
     * It roughly doubles the wire time of a flash, and it is what turns a
     * corrupted page from an unrecoverable failure into a retried one -- see
     * `writeFirmware`.
     */
    verify?: boolean;
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
     * The number is set by the *ESC*, not the FC. An AM32 application has no
     * boot-init detector; the only road to its bootloader is the unarmed
     * signal-loss watchdog, exactly 2.0 s after passthrough starves the DShot
     * stream (`Src/faults.c:83-108`, 40000 ticks at 20 kHz). The app's 2000 ms
     * inherited from the web app sat precisely on that boundary, so the first
     * init-flash raced the ESC's own reset -- and an attempt whose TX landed in
     * the bootloader's ~55 ms boot window bounced it back to the app
     * (bootloader v15 jumps on any float-phase low, `main.c:884`), after which
     * the retry traffic itself kept re-arming the app's input detection so it
     * never starved again. Seen on hardware as ~30% of single-ESC commands
     * failing all ten init attempts. 2500 ms waits the reset out: by the first
     * TX the bootloader is resident, listening, and alone on the line. Free
     * under a virtual clock.
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

const DEFAULT_PASSTHROUGH_SETTLE_MS = 2500;
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

/**
 * The one byte a write to the EEPROM base does not read back.
 *
 * A `CMD_PROG_FLASH` whose address is *exactly* `EEPROM_START_ADD` and whose
 * payload is longer than two bytes has `payLoadBuffer[2]` replaced with the
 * bootloader's own `BOOTLOADER_VERSION` before anything reaches flash
 * (`AM32-bootloader/bootloader/main.c:517-525`; the version is 18 at
 * `Inc/version.h:5`). Re-verified with a subagent for this block, together with
 * the two facts that make the exemption exactly this narrow: it is the **only**
 * substitution anywhere on the write path, and the read path returns raw flash
 * with no special case for the EEPROM page. So bytes 0, 1 and 3..191 must match
 * byte for byte, and byte 2 never can.
 *
 * Note the condition is the address being *equal* to the base, not merely inside
 * the page -- a mid-page write is not patched. Since a settings write must be the
 * whole page anyway (see `writeSettingsImpl`), that distinction never bites, but
 * it is why the exemption belongs to the settings-page write rather than to
 * `verifyRange` in general.
 */
const BOOTLOADER_STAMPED_OFFSET = EepromLayout.BOOT_LOADER_REVISION.offset;

const EEPROM_VERIFY_EXEMPT: ReadonlySet<number> = new Set([BOOTLOADER_STAMPED_OFFSET]);

/**
 * Write-then-verify attempts for one settings page or one firmware page.
 *
 * Four, which is AM32's own `BL_MAX_PAGE_ATTEMPTS`
 * (`AM32/Src/bootloader_update.c:44`): the firmware's bootloader updater programs
 * a 256-byte chunk, compares it, and on a mismatch restarts at the page base,
 * giving up on the whole update after four attempts at any one page. This code
 * does the same thing from the other side of the 4-way link, so it uses the same
 * number rather than inventing one.
 *
 * These attempts sit **on top of** the link's ten per exchange. The two are not
 * redundant: the link retries an exchange that failed, and this retries an
 * exchange that *succeeded* and did not take effect.
 */
const PAGE_WRITE_ATTEMPTS = 4;

/**
 * Marker for a failure that erasing the page and writing it again could repair.
 *
 * Thrown by `writeAndVerifyRange` and caught by the two retry loops, so that
 * *where* a failure came from decides whether to write again -- rather than a
 * predicate over error reasons, which cannot tell a rejected write from a rejected
 * read (both are `esc-command` with an ACK) and so cannot answer the question.
 */
class RetryablePageFailure extends Error {
    constructor (readonly failure: unknown) {
        super(describeError(failure));
        this.name = 'RetryablePageFailure';
    }
}

/**
 * True when the ESC answered and said no, as against not answering.
 *
 * `ack` is set only when `validate` had a reply to parse, so a non-OK ACK has one
 * and a timeout does not. Note this does **not** identify a dead channel: an
 * unresponsive ESC makes the *flight controller* answer `ACK_D_GENERAL_ERROR` on
 * its behalf, so a pulled signal wire looks exactly like a bootloader that refused
 * the write. Telling those apart is what the read-back is for.
 */
function rejectedByEsc (error: unknown): boolean {
    const inner = causedBySessionError(error);
    return inner?.reason === 'esc-command' && inner.ack !== undefined;
}

/** True when a read-back showed the ESC holding something else. */
function isVerifyMismatch (error: unknown): boolean {
    return causedBySessionError(error)?.reason === 'esc-verify';
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

        // Every channel the FC reports, not only the ones this session
        // touched. Entering passthrough starves the DShot stream for all of
        // them, and ~2 s in each ESC's unarmed signal-loss watchdog resets it
        // into a bootloader that sits resident on the idle-high line (AM32
        // `Src/faults.c:83-108`) -- whether or not the session ever addressed
        // that channel. Leave one there and the FC's resumed DShot lands in
        // its bootloader, which v17-and-older wedge on; seen on hardware as
        // `get --esc 2` reliably stranding ESCs 1, 3 and 4. Best-effort and
        // per-channel; `rebootEsc` because on Betaflight the 300 ms line hold
        // walks even a desynced bootloader out to the app, and a channel still
        // running its firmware just discards the bytes.
        for (let target = 0; target < this.escCountValue; target += 1) {
            try {
                await this.fourWay.reset(target, { rebootEsc: true });
            } catch (error) {
                this.emitter.emit('log', {
                    level: 'warn',
                    message: `ESC #${target + 1}: cmd_DeviceReset on the way out failed: ${describeError(error)}`
                });
            }
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
     * **It verifies by read-back** unless the caller opts out, exempting exactly
     * one byte: see {@link BOOTLOADER_STAMPED_OFFSET}.
     */
    writeSettings (
        target: number,
        patch: Partial<EscSettings>,
        options: WriteSettingsOptions = {}
    ): Promise<WriteSettingsResult> {
        return this.exclusive(() => this.writeSettingsImpl(target, () => patch, options));
    }

    /**
     * Reset one channel to defaults, preserving its identity.
     *
     * `image` defaults to AM32's own `default_settings[]`, so this needs no
     * network: the CLI and a deployment with no firmware catalog get the same
     * behaviour the web app gets from `/api/eeprom/<board>`. See
     * `eeprom/defaults.ts` for the bytes and their provenance.
     *
     * Six fields are **not** written even though the default image contains them
     * -- the boot byte, the layout revision, the bootloader version, the two
     * firmware-version bytes and the CAN block. Each one is an ESC's identity
     * rather than a tunable, and the reasons are in
     * {@link DEFAULTS_PRESERVED_FIELDS}. The app used to write all of them: the
     * layout revision is the one that mattered, because setting an older ESC's
     * revision to 3 makes the firmware's own migration skip
     * (`AM32/Src/settings.c:23-36`).
     */
    applyDefaults (target: number, options: ApplyDefaultsOptions = {}): Promise<WriteSettingsResult> {
        const image = options.image ?? DEFAULT_SETTINGS_IMAGE;
        return this.exclusive(() => this.writeSettingsImpl(
            target,
            (_base, escRevision) => {
                const revision = options.layoutRevision ?? escRevision;
                const patch = decodeSettings(image, revision);
                for (const field of DEFAULTS_PRESERVED_FIELDS) {
                    delete patch[field];
                }
                // A 48-byte default image carries no melody, and *apply defaults*
                // has always cleared it: `tune[0] == 0xFF` is the "no melody"
                // marker (`AM32/Src/sounds.c:242`) and what a factory image ships.
                // A caller who hands over a full 192-byte image with a tune in it
                // keeps that tune.
                patch.STARTUP_MELODY ??= [...DEFAULT_STARTUP_MELODY];
                this.emitter.emit('log', {
                    level: 'info',
                    message: `ESC #${target + 1}: applying ${
                        options.image ? `${image.length} bytes of supplied defaults` : 'AM32\'s built-in defaults'
                    } as a layout-revision-${revision} image`
                });
                return patch;
            },
            options
        ));
    }

    /**
     * `patchFor` is handed the ESC's current image and its layout revision, so a
     * caller that needs either -- `applyDefaults` needs the revision to decode its
     * default image -- does not have to pay for a second read to get it.
     */
    private writeSettingsImpl (
        target: number,
        patchFor: (base: Uint8Array, layoutRevision: number) => Partial<EscSettings>,
        options: WriteSettingsOptions
    ): Promise<WriteSettingsResult> {
        this.requirePassthrough();
        const verify = options.verify !== false;

        return this.labelled(target, async () => {
            const { mcu } = await this.selectTarget(target);
            const eepromOffset = mcu.getEepromOffset();

            const base = await this.fourWay.readAddress(eepromOffset, EEPROM_SIZE);
            const layoutRevision = base[EepromLayout.LAYOUT_REVISION.offset] ?? 0;
            const image = encodeSettings(base, patchFor(base, layoutRevision), layoutRevision);

            if (bytesEqual(image, base)) {
                this.emitter.emit('log', {
                    level: 'info',
                    message: `ESC #${target + 1}: no changed settings to write`
                });
                return {
                    target,
                    changed: false,
                    // The read this was built from is the proof.
                    verified: true,
                    settings: decodeSettings(base, layoutRevision),
                    image: base
                };
            }

            this.emitter.emit('progress', { phase: 'write', current: 0, total: 1, target });
            const written = await this.writeSettingsPage(
                eepromOffset,
                image,
                `ESC #${target + 1}: the settings page`,
                verify
            );
            this.emitter.emit('progress', { phase: 'write', current: 1, total: 1, target });
            this.emitter.emit('log', {
                level: 'info',
                message: `ESC #${target + 1}: settings written${verify ? ' and verified' : ' (not verified)'}`
            });

            return {
                target,
                changed: true,
                verified: verify,
                settings: decodeSettings(written, layoutRevision),
                image: written
            };
        });
    }

    /**
     * Write the whole 192-byte settings page, and prove it landed.
     *
     * Returns what the ESC actually holds afterwards, which differs from what was
     * sent at byte 2 and nowhere else.
     *
     * **The write has to be the whole struct at the page base. Do not "optimise"
     * it into a partial write.** A write to the page base erases the whole page
     * first (`Mcu/f051/Src/eeprom.c:34-44`), so a 16-byte write at `eepromOffset`
     * succeeds with `ACK_OK` and blanks bytes 16-191 -- the startup melody and the
     * entire CAN block. (A *mid-page* sub-range fails instead, on the bootloader's
     * own memcmp, because flash can only clear bits. The dangerous shape is the one
     * that looks safest.)
     *
     * `cmd_DeviceWriteEEprom` is not an option either: AM32 answers
     * `CMD_PROG_EEPROM` with `brERRORCOMMAND` (`main.c:674-675`), and both host
     * firmwares report that as an error for an ARM target -- ArduPilot's
     * `cmd_DeviceWriteEEprom` takes the `default:` branch for `imARM_BLB` and sets
     * `ACK_D_GENERAL_ERROR` (`AP_BLHeli.cpp:1214`; the ACK_OK-swallowing path at
     * `:1211` is `imATM_BLB` only).
     */
    private async writeSettingsPage (
        eepromOffset: number,
        image: Uint8Array,
        what: string,
        verify: boolean
    ): Promise<Uint8Array> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await this.writeAndVerifyRange(eepromOffset, image, {
                    exempt: EEPROM_VERIFY_EXEMPT,
                    what,
                    verify
                });
            } catch (error) {
                if (!(error instanceof RetryablePageFailure)) {
                    throw error;
                }
                if (attempt >= PAGE_WRITE_ATTEMPTS) {
                    throw error.failure;
                }
                this.emitter.emit('log', {
                    level: 'warn',
                    message: `${what} did not verify; writing it again ` +
                        `(attempt ${attempt + 1} of ${PAGE_WRITE_ATTEMPTS})`
                });
            }
        }
    }

    /**
     * Write one range and read it back, or throw.
     *
     * The single place both write paths decide what a failure *means*, because the
     * two ways a write can fail are not distinguishable from the reply:
     *
     *  - **The ESC rejected the write.** That is a non-OK ACK, and it covers two
     *    completely different situations. Either the bootloader's own `memcmp`
     *    failed, so the page is partially programmed with bits that cannot be set
     *    back (`Mcu/f051/Src/eeprom.c:56-62`) and only a re-erase can repair it -- or
     *    the channel has gone away, and the *flight controller* answered
     *    `ACK_D_GENERAL_ERROR` on the ESC's behalf. Both firmwares collapse them to
     *    the same ACK, so **the read-back is the arbiter**: a rejected write is not
     *    treated as fatal, it sends us to look. If the read works, the ESC is alive
     *    and the page is the problem. If the read fails too, the channel is gone and
     *    the write's own error is what the caller wants to see.
     *  - **The ESC accepted a write that did not take effect** -- ArduPilot's leaked
     *    `ACK_OK` (`AP_BLHeli.cpp:928-932`). Nothing but the read-back finds this.
     *
     * With `verify: false` there is no arbiter, so a rejected write stays fatal.
     */
    private async writeAndVerifyRange (
        address: number,
        data: Uint8Array,
        options: { what: string, verify: boolean, exempt?: ReadonlySet<number> }
    ): Promise<Uint8Array> {
        let rejected: unknown = null;

        try {
            await this.fourWay.write(address, data);
        } catch (error) {
            if (!options.verify || !rejectedByEsc(error)) {
                throw error;
            }
            rejected = error;
        }

        if (!options.verify) {
            return data;
        }

        let actual: Uint8Array;
        try {
            actual = await this.fourWay.verifyRange(address, data, {
                exempt: options.exempt,
                what: options.what
            });
        } catch (error) {
            if (isVerifyMismatch(error)) {
                throw new RetryablePageFailure(rejected ?? error);
            }
            // The read failed as well, so this is not a page that can be repaired --
            // it is a channel that has stopped talking. Report the first failure.
            throw rejected ?? error;
        }

        if (rejected) {
            this.emitter.emit('log', {
                level: 'warn',
                message: `${options.what}: the write was refused but the bytes read back correct ` +
                    `(${describeError(rejected)})`
            });
        }
        return actual;
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
     * Every write is read back and compared (`{ verify: false }` opts out).
     * `cmd_DeviceVerify` cannot do this -- AM32 answers `CMD_VERIFY_FLASH_ARM` with
     * `brERRORCOMMAND` (`main.c:674-675`) -- so it is a read-back, and the retry is
     * at page granularity for the reason in `writeFirmware`.
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

            const verify = options.verify !== false;
            const eepromOffset = mcu.getEepromOffset();
            const settingsImage = await this.fourWay.readAddress(eepromOffset, EEPROM_SIZE);

            await this.writeBootByte(target, eepromOffset, settingsImage, 0x00, verify);
            await this.writeFirmware(target, image, mcu, verify);
            await this.writeBootByte(target, eepromOffset, settingsImage, 0x01, verify);

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

    /**
     * Rewrite the settings page with byte 0 forced to `value`.
     *
     * Verified like any other settings write, and for a specific reason: if the
     * write that clears byte 0 silently does nothing, the whole safety property of
     * the bracket is gone -- the flash would proceed over a board that still claims
     * to hold a complete application, so a failure part way through would leave it
     * booting half an image instead of its bootloader.
     */
    private async writeBootByte (
        target: number,
        eepromOffset: number,
        settingsImage: Uint8Array,
        value: number,
        verify: boolean
    ): Promise<void> {
        const image = new Uint8Array(settingsImage);
        image[EepromLayout.BOOT_BYTE.offset] = value;
        await this.writeSettingsPage(
            eepromOffset,
            image,
            `ESC #${target + 1}: the boot byte (0x${value.toString(16).padStart(2, '0')})`,
            verify
        );
    }

    /**
     * Stream the application region, one 1024-byte page at a time in 256-byte
     * chunks, reading each chunk back before moving on.
     *
     * The bounds are derived from the MCU variant rather than the app's hardcoded
     * pages 4..0x40. The floor matters: `firmware_start` is 0x1000 on the F051 and
     * the ARM64K part but 0x4000 on the NXP one, and writing below the
     * bootloader's `APPLICATION_ADDRESS` is refused outright
     * (AM32-bootloader `main.c:443-446`). The ceiling matters more: the app's
     * 0x40 was the *end of flash*, so a hex whose records reached that far would
     * have taken the settings page with it. The application image ends where the
     * EEPROM page begins.
     *
     * **The retry granularity is the page, not the chunk, and that is the whole
     * reason this loop is shaped the way it is.** Flash can only clear bits, and a
     * page is erased only by a write to its base
     * (`AM32-bootloader/Mcu/f051/Src/eeprom.c:34-44`) -- so re-sending one 256-byte
     * chunk into a page that has already been programmed cannot repair it, and will
     * usually fail the bootloader's own memcmp instead. Restarting at the page base
     * re-erases and reprograms, which is exactly what AM32's own bootloader updater
     * does: `off = page_base; continue;` bounded by `BL_MAX_PAGE_ATTEMPTS`
     * (`AM32/Src/bootloader_update.c:79-116`, the reason spelled out at `:99-104`).
     * Block 5 shipped the chunk-level retry the link gives for free and recorded
     * that it was not the firmware's model; this is the model.
     */
    private async writeFirmware (target: number, image: Uint8Array, mcu: Mcu, verify: boolean): Promise<void> {
        const begin = mcu.getFirmwareStart();
        const end = Math.min(image.length, mcu.getEepromOffset());
        const total = Math.max(0, end - begin);
        const pageSize = mcu.getPageSize();

        this.emitter.emit('progress', { phase: 'flash', current: 0, total, target });
        if (total === 0) {
            this.emitter.emit('log', {
                level: 'warn',
                message: `ESC #${target + 1}: the hex contains nothing above the firmware start; nothing written`
            });
            return;
        }

        // A bar that goes backwards is the usual symptom of a miscounted page
        // loop, so a page being written a second time pauses it rather than
        // rewinding it.
        let highWater = 0;

        for (let pageBase = begin; pageBase < end; pageBase += pageSize) {
            const pageEnd = Math.min(pageBase + pageSize, end);

            for (let attempt = 1; ; attempt += 1) {
                try {
                    for (let address = pageBase; address < pageEnd;) {
                        const chunk = this.flashChunk(image, address, pageEnd);
                        await this.writeAndVerifyRange(address, chunk, {
                            what: `ESC #${target + 1}: the page at 0x${pageBase.toString(16).toUpperCase()}`,
                            verify
                        });
                        address += chunk.length;

                        const done = Math.min(total, address - begin);
                        if (done > highWater) {
                            highWater = done;
                            this.emitter.emit('progress', { phase: 'flash', current: done, total, target });
                        }
                    }
                    break;
                } catch (error) {
                    if (!(error instanceof RetryablePageFailure)) {
                        throw error;
                    }
                    if (attempt >= PAGE_WRITE_ATTEMPTS) {
                        throw error.failure;
                    }
                    this.emitter.emit('log', {
                        level: 'warn',
                        message: `ESC #${target + 1}: the page at 0x${pageBase.toString(16).toUpperCase()} ` +
                            'did not verify; re-writing it from its base ' +
                            `(attempt ${attempt + 1} of ${PAGE_WRITE_ATTEMPTS})`
                    });
                }
            }
        }
    }

    /**
     * One chunk of the image at `address`, never past `limit`, always an even
     * number of bytes.
     *
     * `save_flash_nolib` refuses an odd length outright, because it programs
     * halfwords (`Mcu/f051/Src/eeprom.c:20-22`) -- and it refuses it *after* an
     * aligned write has already erased the page, so the failure mode is an ESC
     * whose last page is blank. A real AM32 build ends on the 32-byte firmware-name
     * block so its image length is even; a hand-built or mis-linked hex need not
     * be. The pad byte is `0xFF`, which programs no bits and reads back from erased
     * flash unchanged, so it costs nothing and verifies.
     *
     * The pad can never spill into the settings page: `address` is always even (it
     * starts at a page base and advances by even lengths), so an odd length means
     * an odd `limit`, and every page boundary and the EEPROM offset itself are
     * even.
     */
    private flashChunk (image: Uint8Array, address: number, limit: number): Uint8Array {
        const stop = Math.min(address + FLASH_CHUNK_BYTES, limit);
        const chunk = image.subarray(address, stop);
        if (chunk.length % 2 === 0) {
            return chunk;
        }
        const padded = new Uint8Array(chunk.length + 1).fill(0xFF);
        padded.set(chunk);
        return padded;
    }

    /** `cmd_DeviceReset` -- leave the bootloader and run the application again. */
    reset (target: number): Promise<void> {
        return this.exclusive(() => this.resetImpl(target));
    }

    private async resetImpl (target: number): Promise<void> {
        this.requirePassthrough();
        this.emitter.emit('progress', { phase: 'reset', current: 0, total: 1, target });
        // The user-facing "leave the bootloader" -- rebootEsc so it works even
        // on a bootloader whose serial parser is past talking to (see
        // FourWaySession.reset). The mid-flash reset deliberately does not use
        // it: its read-back re-connects immediately and verifies itself.
        await this.fourWay.reset(target, { rebootEsc: true });
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
