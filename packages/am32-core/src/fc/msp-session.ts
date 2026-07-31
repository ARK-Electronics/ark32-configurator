/**
 * The MSP half of the session: identify the flight controller, read the facts
 * that matter, and get into and out of 4-way passthrough.
 *
 * This is where audit item **H** is fixed. The app waited 4.5 s before its first
 * MSP frame on *every* connect, because ArduPilot only hands the port to the
 * alternative-protocol handler after 4 s with no inbound MAVLink. Betaflight has
 * no such rule, so every Betaflight connect paid the tax for nothing.
 *
 * {@link MspSession.connect} inverts that: it probes immediately and only enters
 * the idle window **on failure**. That is sound rather than optimistic, because
 * ArduPilot's window is re-armed exclusively by a valid MAVLink frame
 * (`alternative.last_mavlink_ms = now_ms` at GCS_Common.cpp:1977, reached only
 * on `MAVLINK_FRAMING_OK` at :1974). An MSP probe is not MAVLink, so it can
 * never push the handoff back -- the failed probes cost nothing but themselves.
 *
 * All time comes from the injected `Clock`; there is not a millisecond literal
 * at a call site anywhere below. See `../link/timeout-policy.ts`.
 */

import type { Clock } from '../clock';
import { SessionError, describeError } from '../errors';
import type { LogLevel } from '../events';
import {
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    isCompleteFourWayFrame
} from '../framing/fourway';
import {
    MSP_COMMANDS,
    encodeMspCommand,
    isCompleteMspFrame,
    parseMspResponse,
    type MspFrame
} from '../framing/msp';
import type { Link } from '../link/link';
import { DEFAULT_TIMEOUT_POLICY, TimeoutPolicy } from '../link/timeout-policy';
import { decodeBytes } from '../text';
import { GENERIC_QUIRKS, quirksForFcVariantId, type FcQuirks } from './quirks';

export interface FcApiVersion {
    /** MSP protocol version -- 0 on both firmwares today. */
    protocol: number;
    major: number;
    minor: number;
}

export interface FcBattery {
    cells: number;
    capacityMah: number;
    /** Pack voltage in volts. */
    voltage: number;
    mahDrawn: number;
    /** Pack current in amps. */
    amps: number;
    /** `MSP_BATTERY_STATE` byte 8: 0 OK, 1 warning, 2 critical, 3 not present. */
    state: number;
}

export interface FcInfo {
    /** Which timeout budgets and quirks apply. */
    variant: FcQuirks['variant'];
    /** The raw `MSP_FC_VARIANT` string, e.g. `ARDU`, `BTFL`, `INAV`. */
    variantId: string;
    apiVersion: FcApiVersion;
    /**
     * `MSP_MOTOR_CONFIG` byte 6 -- the authoritative motor count on both
     * firmwares (AP_BLHeli.cpp:520, msp.c:1509). Not `MSP_MOTOR`, which counts
     * eight on a disarmed Betaflight and zero on a `mixed_type` ArduPilot.
     */
    motorCount: number;
    quirks: FcQuirks;
    /** Best effort: null when the FC does not answer `MSP_BATTERY_STATE`. */
    battery: FcBattery | null;
    /** Milliseconds `connect()` took, idle window included. Diagnostics. */
    connectMs: number;
    /** True when the connect had to sit out the ArduPilot MAVLink window. */
    waitedForMavlinkWindow: boolean;
}

export interface MspSessionOptions {
    link: Link;
    clock: Clock;
    policy?: TimeoutPolicy;
    log?: (level: LogLevel, message: string) => void;
    /** Total attempts for one MSP exchange. 1 sends the frame once. */
    retries?: number;
    /**
     * Upper bound on the probe-then-wait connect, measured from its first frame.
     *
     * ArduPilot's window is 4 s from the last valid MAVLink frame, and the host
     * cannot know when that was -- a GCS may have let go a moment ago. 8 s gives
     * the window room to open plus a poll or two, and is still shorter than the
     * ~10.7 s worst case the app's fixed wait plus five retries could reach.
     */
    idleWindowMs?: number;
    /** Gap between polls inside the idle window. */
    pollIntervalMs?: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_IDLE_WINDOW_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/** `MSP_FC_VARIANT` is four raw ASCII bytes: no NUL, no length prefix. */
const FC_VARIANT_LENGTH = 4;

function u16 (payload: Uint8Array, at: number): number {
    return (payload[at] ?? 0) | ((payload[at + 1] ?? 0) << 8);
}

export class MspSession {
    private readonly link: Link;
    private readonly clock: Clock;
    private readonly log: (level: LogLevel, message: string) => void;
    private readonly retries: number;
    private readonly idleWindowMs: number;
    private readonly pollIntervalMs: number;

    /** Adopted from the detected FC by {@link connect}; starts `generic`. */
    policy: TimeoutPolicy;

    constructor (options: MspSessionOptions) {
        this.link = options.link;
        this.clock = options.clock;
        this.policy = options.policy ?? DEFAULT_TIMEOUT_POLICY;
        this.log = options.log ?? (() => {});
        this.retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
        this.idleWindowMs = Math.max(0, options.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS);
        this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }

    /**
     * One MSP exchange. Rejects rather than resolving null, and rejects a reply
     * that is an error frame or does not echo the command -- both checks live in
     * `validate`, so the link retries them exactly like a timeout, with a drain
     * in between.
     */
    async request (command: MSP_COMMANDS, payload?: Uint8Array, retries?: number): Promise<MspFrame> {
        // A holder rather than a `let`: the assignment happens inside the
        // validator, which TypeScript's control-flow analysis cannot see, so a
        // plain local would still be narrowed to `null` at the return.
        const captured: { frame?: MspFrame } = {};

        await this.link.request(encodeMspCommand(command, payload), {
            probe: isCompleteMspFrame,
            timeout: this.policy.forMsp(command),
            retries: retries ?? this.retries,
            label: MSP_COMMANDS[command] ?? `MSP ${command}`,
            validate: (response) => {
                captured.frame = parseMspResponse(response, { expectCommand: command });
            }
        });

        if (!captured.frame) {
            throw new SessionError('transport', `${MSP_COMMANDS[command] ?? command}: link resolved with no frame`);
        }
        return captured.frame;
    }

    /** {@link request}, but null instead of throwing. For probes and optional data. */
    async tryRequest (command: MSP_COMMANDS, payload?: Uint8Array, retries?: number): Promise<MspFrame | null> {
        try {
            return await this.request(command, payload, retries);
        } catch (error) {
            this.log('info', `${MSP_COMMANDS[command] ?? command}: ${describeError(error)}`);
            return null;
        }
    }

    /**
     * Probe, then -- only if that failed -- wait out the ArduPilot MAVLink
     * window, then identify the FC.
     *
     * The three steps, in order, each of which exists because of something the
     * firmware actually does:
     *
     *  1. **Probe `MSP_API_VERSION` immediately.** Betaflight answers the first
     *     well-formed frame on a freshly opened port with no warm-up at all, and
     *     so does an ArduPilot whose window is already open. This is the whole
     *     Betaflight fast path.
     *  2. **Escape 4-way and probe again.** A previous session that died in
     *     passthrough leaves the FC in `esc4wayProcess`, where MSP is discarded
     *     unanswered (serial_4way.c:453-461) until `cmd_InterfaceExit`. One exit
     *     frame is much cheaper than concluding "no FC".
     *  3. **Poll through the idle window.** Only ArduPilot needs this, and only
     *     when a GCS has been on the port recently.
     */
    async connect (): Promise<FcInfo> {
        const startedAt = this.clock.now();

        let api = await this.tryRequest(MSP_COMMANDS.MSP_API_VERSION, undefined, 1);
        let waited = false;

        if (!api) {
            this.log('info', 'no MSP reply; escaping 4-way passthrough in case a previous session left us there');
            await this.escapeFourWay();
            api = await this.tryRequest(MSP_COMMANDS.MSP_API_VERSION, undefined, 1);
        }

        if (!api) {
            this.log(
                'info',
                `no MSP reply; waiting up to ${this.idleWindowMs}ms for the ArduPilot MAVLink window ` +
                '(close Mission Planner / QGroundControl if this times out)'
            );
            waited = true;
            api = await this.pollUntilMspAnswers(startedAt);
        }

        if (!api) {
            throw new SessionError(
                'fc-detect',
                `no MSP reply after ${this.clock.now() - startedAt}ms. ` +
                'Is a ground station holding the port, or is the board in DFU?'
            );
        }

        const apiVersion: FcApiVersion = {
            protocol: api.payload[0] ?? 0,
            major: api.payload[1] ?? 0,
            minor: api.payload[2] ?? 0
        };

        const variantFrame = await this.tryRequest(MSP_COMMANDS.MSP_FC_VARIANT);
        const variantId = variantFrame
            ? decodeBytes(variantFrame.payload, 0, Math.min(FC_VARIANT_LENGTH, variantFrame.payload.length)).trim()
            : '';
        const quirks = variantId ? quirksForFcVariantId(variantId) : GENERIC_QUIRKS;

        // Adopt the FC's budgets once, here, so no call site below ever has to
        // be told which flight controller it is talking to.
        this.policy = this.policy.withVariant(quirks.variant);
        this.log('info', `FC variant ${variantId || 'unknown'} -> ${quirks.variant} timeouts`);

        const motorConfig = await this.tryRequest(MSP_COMMANDS.MSP_MOTOR_CONFIG);
        const motorCount = motorConfig?.payload[6] ?? 0;

        const battery = this.decodeBattery(await this.tryRequest(MSP_COMMANDS.MSP_BATTERY_STATE, undefined, 1));

        return {
            variant: quirks.variant,
            variantId,
            apiVersion,
            motorCount,
            quirks,
            battery,
            connectMs: this.clock.now() - startedAt,
            waitedForMavlinkWindow: waited
        };
    }

    /**
     * `MSP_SET_PASSTHROUGH` with an empty payload, which means 4-way on both
     * firmwares (AP_BLHeli.cpp:574-575, msp.c:301-303).
     *
     * Returns the single reply byte: `num_motors` on ArduPilot (AP:581,597) and
     * `esc4wayInit()`'s ESC count on Betaflight (msp.c:328). That number, not
     * `MSP_MOTOR_CONFIG`'s, is how many channels the FC will let us address.
     */
    async enterPassthrough (): Promise<number> {
        let frame: MspFrame;
        try {
            frame = await this.request(MSP_COMMANDS.MSP_SET_PASSTHROUGH);
        } catch (error) {
            // The FC enters passthrough the moment it *sends* that reply, so a
            // reply we never see leaves it in the 4-way loop while we believe it
            // is not -- and on Betaflight every later MSP frame is then
            // swallowed unanswered until someone sends `cmd_InterfaceExit`.
            // Historically that is the state a user escapes by replugging USB.
            // One exit frame costs nothing when the FC was never in passthrough:
            // Betaflight's MSP parser discards a stray `/`, and ArduPilot enters
            // 4-way on it and leaves again on the same frame.
            await this.escapeFourWay();

            // ArduPilot's own failure reply is `msp_send_ack(ACK_D_GENERAL_ERROR)`
            // (AP:594) -- a perfectly well-formed `$M>` frame whose *command*
            // field is 0x0F rather than 245, so what surfaces here is the
            // command-echo rejection block 1b added, not a timeout.
            throw new SessionError('passthrough', `MSP_SET_PASSTHROUGH failed: ${describeError(error)}`, {
                cause: error
            });
        }
        return frame.payload[0] ?? 0;
    }

    /**
     * Send one `cmd_InterfaceExit` and ignore whatever comes back.
     *
     * Encoded here as raw bytes rather than through `esc/fourway-session.ts`
     * because at this point there is no session: we do not know whether the FC
     * is in passthrough, whether it will answer, or even whether it exists. The
     * FC stops answering the instant it leaves passthrough, so a reply is not
     * something to wait for.
     */
    private async escapeFourWay (): Promise<void> {
        // `2F 34 0000 01 00 <crc16>` -- cmd_InterfaceExit, one zero param.
        await this.link.request(encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceExit), {
            probe: isCompleteFourWayFrame,
            timeout: this.policy.forFourWay(FOUR_WAY_COMMANDS.cmd_InterfaceExit),
            retries: 1,
            label: 'cmd_InterfaceExit'
        }).catch(() => null);

        await this.link.drain();
    }

    /**
     * Poll `MSP_API_VERSION` until it answers or the window budget is spent.
     *
     * Each poll is a single attempt: retrying inside the window buys nothing,
     * because the reason for the silence is time passing rather than a lost
     * frame. Bytes sent while ArduPilot's window is shut are read and handed to
     * the MAVLink parser, which rejects them -- they are lost, and crucially
     * they do **not** re-arm the window.
     */
    private async pollUntilMspAnswers (startedAt: number): Promise<MspFrame | null> {
        const deadline = startedAt + this.idleWindowMs;

        while (this.clock.now() < deadline) {
            await this.clock.sleep(this.pollIntervalMs);
            const frame = await this.tryRequest(MSP_COMMANDS.MSP_API_VERSION, undefined, 1);
            if (frame) {
                this.log('info', `MSP answered after ${this.clock.now() - startedAt}ms`);
                return frame;
            }
        }

        return null;
    }

    /** `MSP_BATTERY_STATE`: 11 bytes, little-endian (msp.c `MSP_BATTERY_STATE`). */
    private decodeBattery (frame: MspFrame | null): FcBattery | null {
        if (!frame || frame.payload.length < 9) {
            return null;
        }
        const p = frame.payload;
        return {
            cells: p[0] ?? 0,
            capacityMah: u16(p, 1),
            // Byte 3 is decivolts; bytes 9-10 are the same value in centivolts
            // and are the ones to trust when the pack is over 25.5 V.
            voltage: p.length >= 11 ? u16(p, 9) / 100 : (p[3] ?? 0) / 10,
            mahDrawn: u16(p, 4),
            amps: u16(p, 6) / 100,
            state: p[8] ?? 0
        };
    }
}
