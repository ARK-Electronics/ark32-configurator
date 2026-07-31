/**
 * `SimFc` -- a flight controller that speaks MSP and BLHeli 4-way passthrough,
 * with an ArduPilot and a Betaflight profile.
 *
 * It is a byte-stream state machine, not a request/response mock: bytes go in,
 * bytes come out, and the mode switching between MSP and 4-way is modelled the
 * way each firmware actually does it. That matters because the two firmwares
 * differ precisely there -- Betaflight's passthrough is a blocking loop that
 * stops answering MSP entirely, ArduPilot multiplexes the two protocols on a
 * per-byte basis -- and audit item **H** is the configurator not encoding that
 * difference anywhere.
 *
 * Framing is the core's (`am32-core/framing/*`). There is deliberately no second
 * implementation of MSP or 4-way in this package: if the simulator and the host
 * disagreed about framing, every test would prove only that the simulator agrees
 * with itself.
 *
 * All time comes from the injected {@link Clock}. Soft-serial durations are
 * charged per operation by {@link SimEsc} and added up here, so an exchange in
 * the simulator takes as long as the firmware says it should, and the timeout
 * policy is measured rather than assumed.
 */

import type { Clock } from 'am32-core/clock';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    FOUR_WAY_LOCAL_ESCAPE,
    FOUR_WAY_MAX_PARAMS,
    FOUR_WAY_REQUEST_OVERHEAD,
    FourWayFrameError,
    encodeFourWayResponse,
    isCompleteFourWayRequest,
    parseFourWayRequest,
    type FourWayRequest
} from 'am32-core/framing/fourway';
import {
    MSP_COMMANDS,
    MspFrameError,
    encodeMspV1,
    encodeMspV2,
    mspFrameLength,
    parseMspResponse,
    type MspFrame
} from 'am32-core/framing/msp';
import { SimEsc } from './esc';
import { INTERFACE_MODE_ARM_BLB, PROFILES, type FcProfile, type FcProfileName } from './profiles';
import type { SimEndpoint } from './transport';

const DOLLAR = 0x24; // '$'
const MAGIC_V1 = 0x4D; // 'M'
const MAGIC_V2 = 0x58; // 'X'
const DIR_REQUEST = 0x3C; // '<'

/** `MSP_PASSTHROUGH_ESC_4WAY` (BFm:204) / `PROTOCOL_4WAY` (AP_BLHeli.h:105). */
const PASSTHROUGH_MODE_4WAY = 0xFF;

/**
 * `ACK_D_GENERAL_ERROR`. ArduPilot answers a failed `MSP_SET_PASSTHROUGH` with
 * `msp_send_ack(ACK_D_GENERAL_ERROR)` (AP:593-595) -- a perfectly normal `$M>`
 * reply whose *command* field is 0x0F rather than 245. It is not an MSP error
 * frame; only the core's command-echo check catches it, which is exactly why
 * that check exists (audit **D**).
 */
const AP_PASSTHROUGH_FAILURE_COMMAND = 0x0F;

/** Betaflight's `cmd_DeviceReset` busy-wait when the request sets ADDR_L=1 (BF:604-611). */
const BF_ESC_REBOOT_HOLD_MS = 300;

/**
 * Inbound buffer cap. A 4-way request tops out at 263 bytes and an MSP v1
 * request at 262; the firmware's own input buffers are 256 params plus header.
 * Twice the largest frame is enough to reassemble anything real and small enough
 * that garbage cannot accumulate.
 */
const MAX_RX_BYTES = 512;

export interface SimFcBattery {
    cells: number
    capacityMah: number
    /** Pack voltage in volts. */
    voltage: number
    mahDrawn: number
    /** Pack current in amps. */
    current: number
}

export interface SimFcOptions {
    clock: Clock
    profile?: FcProfileName | FcProfile
    /** ESC count, or the instances themselves when a test needs to configure them. */
    escs?: number | SimEsc[]
    /**
     * `MSP_MOTOR_CONFIG` byte 6 and the `MSP_SET_PASSTHROUGH` reply. Defaults to
     * the ESC count. Set it to 0 to model an ArduPilot board whose outputs are
     * all analog PWM, where `num_motors` is legitimately zero on a flying
     * aircraft (AP:1460-1466).
     */
    motorCount?: number
    battery?: Partial<SimFcBattery>
}

const DEFAULT_BATTERY: SimFcBattery = {
    cells: 4,
    capacityMah: 1500,
    voltage: 16.4,
    mahDrawn: 0,
    current: 0
};

export class SimFc implements SimEndpoint {
    readonly profile: FcProfile;
    readonly escs: SimEsc[];
    readonly battery: SimFcBattery;

    /** MSP requests answered, 4-way frames handled, bytes dropped by the gate. */
    readonly counts = { msp: 0, fourWay: 0, gatedBytes: 0, badCrc: 0 };

    private readonly clock: Clock;
    private readonly listeners = new Set<(chunk: Uint8Array) => void>();
    private rx = new Uint8Array(0);
    private mode: 'msp' | 'fourway' = 'msp';
    private selected = 0;
    private motorCountValue: number;
    private lastDeviceInfo = new Uint8Array([0, 0, 0, INTERFACE_MODE_ARM_BLB]);
    private idleMs: number;
    private gateOpensAt: number;
    private readonly mspErrors = new Set<number>();
    /** The clock time the next scheduled reply is queued for -- keeps TX ordered. */
    private txReadyAt: number;

    // ---- fault knobs -------------------------------------------------------

    /**
     * Passthrough is a blocking loop: once in 4-way, MSP is not answered again
     * until `cmd_InterfaceExit`.
     *
     * Guards audit **H**: ArduPilot multiplexes MSP and 4-way on the same port,
     * Betaflight does not, and nothing in the configurator encoded that. With
     * this on, code that assumes ArduPilot's behaviour fails loudly instead of
     * hanging on a bench.
     */
    blockingFourWay: boolean;

    constructor (options: SimFcOptions) {
        this.clock = options.clock;
        this.profile = typeof options.profile === 'object'
            ? options.profile
            : PROFILES[options.profile ?? 'ardupilot'];

        this.escs = typeof options.escs === 'object'
            ? options.escs
            : Array.from({ length: options.escs ?? 4 }, () => new SimEsc());

        this.motorCountValue = options.motorCount ?? this.escs.length;
        this.battery = { ...DEFAULT_BATTERY, ...options.battery };
        this.blockingFourWay = this.profile.blockingFourWay;
        this.idleMs = this.profile.mavlinkIdleMs;
        this.gateOpensAt = this.clock.now() + this.idleMs;
        this.txReadyAt = this.clock.now();
    }

    // ---- knobs -------------------------------------------------------------

    /**
     * Milliseconds of MAVLink silence before ArduPilot hands the port to the
     * MSP/4-way handler (`protocol_timeout = 4000`, GCS:1944). Assigning re-arms
     * the window from *now*, which is how a test models a GCS frame arriving and
     * taking the port back.
     *
     * Only a **valid MAVLink frame** re-arms it in the real firmware
     * (`alternative.last_mavlink_ms = now_ms` at GCS:1977, reached only on
     * `MAVLINK_FRAMING_OK` at GCS:1974). Bytes arriving while the gate is shut
     * are read and offered to the MAVLink parser, which rejects them, so MSP
     * traffic never pushes the handoff back. That is the whole reason a
     * probe-then-wait connect works and the configurator's unconditional 4.5 s
     * wait is unnecessary -- audit **H**.
     */
    get mavlinkIdleGate (): number {
        return this.idleMs;
    }

    set mavlinkIdleGate (ms: number) {
        this.idleMs = Math.max(0, ms);
        this.gateOpensAt = this.clock.now() + this.idleMs;
    }

    /** True once the idle gate has opened and MSP is being answered. */
    get mspAvailable (): boolean {
        return this.clock.now() >= this.gateOpensAt;
    }

    /**
     * Make `command` fail.
     *
     * On Betaflight that is a `$M!` / `$X!` error frame, which is what it sends
     * for any command it cannot handle (BFm:4406-4408). ArduPilot has no error
     * frame at all: it answers an unhandled command with **silence**
     * (AP:601-604), and its one failure reply -- for `MSP_SET_PASSTHROUGH` --
     * is a normal frame carrying command 0x0F instead of 245 (AP:593-595).
     * Both shapes must be rejected rather than parsed as data, which is audit
     * item **D**.
     */
    mspError (command: number): this {
        this.mspErrors.add(command);
        return this;
    }

    /** Stop failing `command`, or every command when called with no argument. */
    clearMspError (command?: number): this {
        if (command === undefined) {
            this.mspErrors.clear();
        } else {
            this.mspErrors.delete(command);
        }
        return this;
    }

    // ---- state -------------------------------------------------------------

    /** True while the FC is in 4-way passthrough. */
    get inPassthrough (): boolean {
        return this.mode === 'fourway';
    }

    get motorCount (): number {
        return this.motorCountValue;
    }

    set motorCount (count: number) {
        this.motorCountValue = Math.max(0, Math.floor(count));
    }

    /** The ESC `cmd_DeviceInitFlash` last selected. */
    get selectedEsc (): SimEsc | undefined {
        return this.escs[this.selected];
    }

    // ---- SimEndpoint -------------------------------------------------------

    onTx (cb: (chunk: Uint8Array) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    onClose (): void {
        this.rx = new Uint8Array(0);
        this.mode = 'msp';
        for (const esc of this.escs) {
            esc.disconnect();
        }
    }

    receive (chunk: Uint8Array): void {
        if (!this.mspAvailable) {
            // GCS_Common reads the byte and hands it only to the MAVLink parser
            // while the gate is shut. Nothing buffers it, and it cannot parse as
            // MAVLink, so it does not push the handoff back.
            this.counts.gatedBytes += chunk.length;
            return;
        }

        const merged = new Uint8Array(this.rx.length + chunk.length);
        merged.set(this.rx, 0);
        merged.set(chunk, this.rx.length);
        // Both firmwares have a fixed input buffer -- Betaflight's `ParamBuf` is
        // 256 bytes and ArduPilot's `blheli.buf` 256 -- so an unbounded one here
        // would be both unfaithful and a way for injected garbage containing a
        // stray 0x2F to grow the buffer forever. Keep the tail: a frame that is
        // still arriving is at the end.
        this.rx = merged.length <= MAX_RX_BYTES ? merged : merged.slice(merged.length - MAX_RX_BYTES);

        this.pump();
    }

    // ---- byte pump ---------------------------------------------------------

    private pump (): void {
        for (;;) {
            if (this.rx.length === 0) {
                return;
            }
            const progressed = this.mode === 'fourway' ? this.pumpFourWay() : this.pumpMsp();
            if (!progressed) {
                return;
            }
        }
    }

    /**
     * Betaflight's 4-way loop scans byte by byte for `cmd_Local_Escape` and
     * throws everything else away (BF:457-461), which is why an MSP frame sent
     * during passthrough vanishes without a reply. ArduPilot instead escapes
     * back to MSP on a `$` seen between frames (AP:1242-1246).
     */
    private pumpFourWay (): boolean {
        const head = this.rx[0] as number;

        if (head === DOLLAR && !this.blockingFourWay) {
            // ArduPilot does not *multiplex* MSP and 4-way, as the plan's quirks
            // table says -- it switches mode, and the switch has a side effect:
            // AP:1244-1245 sets `escMode = PROTOCOL_NONE` and then calls
            // `serial_end()`, which tears down the soft-serial link and marks
            // every ESC disconnected. So an MSP frame sent during passthrough
            // succeeds and the *next* 4-way command is the one that fails, a
            // long way from the cause. Modelling only the mode change would hide
            // exactly that trap from the session tests.
            this.mode = 'msp';
            for (const esc of this.escs) {
                esc.disconnect();
            }
            return true;
        }
        if (head !== FOUR_WAY_LOCAL_ESCAPE) {
            this.rx = this.rx.slice(1);
            return true;
        }
        if (!isCompleteFourWayRequest(this.rx)) {
            return false;
        }

        const claimed = (this.rx[4] as number) === 0 ? FOUR_WAY_MAX_PARAMS : (this.rx[4] as number);
        const length = claimed + FOUR_WAY_REQUEST_OVERHEAD;
        const frame = this.rx.slice(0, length);
        this.rx = this.rx.slice(length);

        try {
            this.handleFourWay(parseFourWayRequest(frame));
        } catch (error) {
            if (!(error instanceof FourWayFrameError) || error.reason !== 'checksum') {
                throw error;
            }
            this.counts.badCrc += 1;
            if (this.profile.repliesToBadFourWayCrc) {
                // Betaflight answers, echoing the command and address it read.
                this.reply(encodeFourWayResponse(
                    frame[1] as number,
                    [0],
                    FOUR_WAY_ACK.ACK_I_INVALID_CRC,
                    ((frame[2] as number) << 8) | (frame[3] as number)
                ), 0);
            }
        }
        return true;
    }

    private pumpMsp (): boolean {
        const head = this.rx[0] as number;

        // ArduPilot enters 4-way on a bare '/' with no MSP handshake at all
        // (AP:1247-1251). Betaflight only ever enters via MSP_SET_PASSTHROUGH.
        // Both escapes are governed by the one knob, so turning it off gives a
        // Betaflight profile ArduPilot's multiplexing and nothing else changes.
        if (head === FOUR_WAY_LOCAL_ESCAPE && !this.blockingFourWay) {
            this.mode = 'fourway';
            return true;
        }
        if (head !== DOLLAR) {
            this.rx = this.rx.slice(1);
            return true;
        }
        if (this.rx.length < 3) {
            return false;
        }

        const magic = this.rx[1] as number;
        const acceptable = magic === MAGIC_V1 || (magic === MAGIC_V2 && this.profile.acceptsMspV2);
        if (!acceptable || this.rx[2] !== DIR_REQUEST) {
            this.rx = this.rx.slice(1);
            return true;
        }

        const length = mspFrameLength(this.rx);
        if (length === null || this.rx.length < length) {
            return false;
        }

        const frame = this.rx.slice(0, length);
        this.rx = this.rx.slice(length);

        try {
            this.handleMsp(parseMspResponse(frame));
        } catch (error) {
            if (!(error instanceof MspFrameError)) {
                throw error;
            }
            // Both firmwares drop a bad-checksum frame in silence
            // (AP:238-242, BFs:213-218).
            this.counts.badCrc += 1;
        }
        return true;
    }

    // ---- MSP ---------------------------------------------------------------

    /**
     * Only ever reached with `mode === 'msp'`. Betaflight's blocking loop is
     * enforced in {@link pumpFourWay}, which eats the bytes before they are ever
     * framed -- a second guard here would look load-bearing and never run.
     */
    private handleMsp (frame: MspFrame): void {
        this.counts.msp += 1;

        if (this.mspErrors.has(frame.command)) {
            this.replyMspFailure(frame);
            return;
        }

        const payload = this.mspPayload(frame);
        if (payload === null) {
            // Unknown command: an error frame on Betaflight, silence on
            // ArduPilot (BFm:4406-4408 vs AP:601-604).
            if (this.profile.mspErrorFrames) {
                this.replyMsp(frame, new Uint8Array(0), 'error');
            }
            return;
        }

        this.replyMsp(frame, payload, 'response');

        if (frame.command === MSP_COMMANDS.MSP_SET_PASSTHROUGH && this.passthroughRequested(frame)) {
            // Betaflight installs `esc4wayProcess` unconditionally -- even when
            // it just told the host there are zero ESCs (BFm:330-332).
            this.mode = 'fourway';
        }
    }

    private passthroughRequested (frame: MspFrame): boolean {
        return frame.payload.length === 0 || frame.payload[0] === PASSTHROUGH_MODE_4WAY;
    }

    /** Null means "no handler", which is not the same as an empty payload. */
    private mspPayload (frame: MspFrame): Uint8Array | null {
        switch (frame.command) {
        case MSP_COMMANDS.MSP_API_VERSION:
            return Uint8Array.from(this.profile.apiVersion);

        case MSP_COMMANDS.MSP_FC_VARIANT:
            return Uint8Array.from(
                Array.from(this.profile.fcVariant).map(c => c.charCodeAt(0))
            );

        case MSP_COMMANDS.MSP_FC_VERSION:
            return Uint8Array.from(this.profile.fcVersion);

        case MSP_COMMANDS.MSP_BATTERY_STATE:
            return this.batteryState();

        case MSP_COMMANDS.MSP_MOTOR:
            return this.motorValues();

        case MSP_COMMANDS.MSP_MOTOR_CONFIG:
            return this.motorConfig();

        case MSP_COMMANDS.MSP_UID:
            return Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

        case MSP_COMMANDS.MSP_SET_PASSTHROUGH:
            return Uint8Array.from([this.passthroughRequested(frame) ? this.motorCountValue : 0]);

        default:
            return null;
        }
    }

    /** `MSP_MOTOR`: eight little-endian u16 slots, always, on both firmwares. */
    private motorValues (): Uint8Array {
        const payload = new Uint8Array(16);
        for (let i = 0; i < 8; i += 1) {
            const value = i < this.motorCountValue ? this.profile.idleMotorValue : 0;
            payload[i * 2] = value & 0xFF;
            payload[i * 2 + 1] = (value >> 8) & 0xFF;
        }
        return payload;
    }

    /** `MSP_MOTOR_CONFIG`: byte 6 is the authoritative motor count on both. */
    private motorConfig (): Uint8Array {
        const payload = new Uint8Array(10);
        const write16 = (at: number, value: number) => {
            payload[at] = value & 0xFF;
            payload[at + 1] = (value >> 8) & 0xFF;
        };
        write16(0, this.profile.name === 'ardupilot' ? 1000 : 0);
        write16(2, 2000);
        write16(4, 1000);
        payload[6] = this.motorCountValue & 0xFF;
        payload[7] = 14;
        payload[8] = 0;
        payload[9] = 0;
        return payload;
    }

    private batteryState (): Uint8Array {
        const payload = new Uint8Array(11);
        const write16 = (at: number, value: number) => {
            payload[at] = value & 0xFF;
            payload[at + 1] = (value >> 8) & 0xFF;
        };
        payload[0] = this.battery.cells;
        write16(1, this.battery.capacityMah);
        payload[3] = Math.round(this.battery.voltage * 10) & 0xFF;
        write16(4, this.battery.mahDrawn);
        write16(6, Math.round(this.battery.current * 100));
        payload[8] = this.battery.cells > 0 ? 0 : 3;
        write16(9, Math.round(this.battery.voltage * 100));
        return payload;
    }

    private replyMspFailure (frame: MspFrame): void {
        if (this.profile.mspErrorFrames) {
            this.replyMsp(frame, new Uint8Array(0), 'error');
            return;
        }
        if (frame.command === MSP_COMMANDS.MSP_SET_PASSTHROUGH) {
            // AP:593-595. A well-formed reply whose command field is 0x0F.
            this.reply(encodeMspV1(AP_PASSTHROUGH_FAILURE_COMMAND, new Uint8Array(0), 'response'), 0);
        }
        // Otherwise silence, which is all ArduPilot has for any other command.
    }

    private replyMsp (frame: MspFrame, payload: Uint8Array, direction: 'response' | 'error'): void {
        // Betaflight mirrors the request's version (BFs:439); ArduPilot only
        // ever speaks v1 because it only ever parses v1.
        const bytes = frame.version === 2 && this.profile.acceptsMspV2
            ? encodeMspV2(frame.command, payload, direction)
            : encodeMspV1(frame.command, payload, direction);
        this.reply(bytes, 0);
    }

    // ---- 4-way -------------------------------------------------------------

    private handleFourWay (request: FourWayRequest): void {
        this.counts.fourWay += 1;

        // `cmd_DeviceInitFlash` and `cmd_DeviceReset` carry their own channel;
        // every other command acts on whichever one those last selected.
        const targetsOwnChannel =
            request.command === FOUR_WAY_COMMANDS.cmd_DeviceInitFlash ||
            request.command === FOUR_WAY_COMMANDS.cmd_DeviceReset;
        const target = targetsOwnChannel ? (request.params[0] ?? 0) : this.selected;
        const esc = this.escs[target];

        // The ESC's own latency, charged once per host-visible command rather
        // than once per bootloader operation. See SimEsc.slowMs for why.
        let cost = esc && this.commandTouchesEsc(request.command) ? esc.slowMs : 0;
        const spend = (ms: number) => {
            cost += ms;
        };

        const send = (params: ArrayLike<number>, ack: FOUR_WAY_ACK, address = request.address) => {
            const frame = encodeFourWayResponse(request.command, params, ack, address);
            this.reply(this.maybeCorrupt(frame), cost);
        };

        switch (request.command) {
        case FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive: {
            if (!esc?.isConnected) {
                // BF skips the whole body when disconnected and so answers OK
                // (BF:505); AP reports the error (AP:981-982).
                send([0], this.profile.name === 'ardupilot'
                    ? FOUR_WAY_ACK.ACK_D_GENERAL_ERROR
                    : FOUR_WAY_ACK.ACK_OK);
                return;
            }
            // AM32 answers CMD_KEEP_ALIVE with brERRORCOMMAND on purpose, and
            // both firmwares count that as success (BL:600-611, BFavr:244-247).
            const alive = esc.unsupportedCommand();
            spend(alive.durationMs);
            send([0], alive.ack === 'timeout'
                ? FOUR_WAY_ACK.ACK_D_GENERAL_ERROR
                : FOUR_WAY_ACK.ACK_OK);
            return;
        }

        case FOUR_WAY_COMMANDS.cmd_ProtocolGetVersion:
            send([this.profile.protocolVersion], FOUR_WAY_ACK.ACK_OK);
            return;

        case FOUR_WAY_COMMANDS.cmd_InterfaceGetName:
            send(this.profile.interfaceName, FOUR_WAY_ACK.ACK_OK);
            return;

        case FOUR_WAY_COMMANDS.cmd_InterfaceGetVersion:
            send(this.profile.interfaceVersion, FOUR_WAY_ACK.ACK_OK);
            return;

        case FOUR_WAY_COMMANDS.cmd_InterfaceExit:
            // Both reply first and leave passthrough afterwards
            // (BF:562,923-926; AP:1014-1027). Neither touches the ESCs on the
            // way out: a bootloader the host brought up stays up, exposed to
            // whatever the FC then drives on the motor lines. Getting back to
            // the firmware is the host's job (`cmd_DeviceReset`) -- modelling
            // an implicit reset here is what hid the host forgetting to.
            send([0], FOUR_WAY_ACK.ACK_OK);
            this.mode = 'msp';
            return;

        case FOUR_WAY_COMMANDS.cmd_InterfaceSetMode:
            if (this.profile.name === 'ardupilot') {
                // No validation at all, and the mode is echoed back (AP:1090-1091).
                send([request.params[0] ?? 0], FOUR_WAY_ACK.ACK_OK);
            } else {
                const mode = request.params[0] ?? 0;
                send([0], mode >= 1 && mode <= 4
                    ? FOUR_WAY_ACK.ACK_OK
                    : FOUR_WAY_ACK.ACK_I_INVALID_PARAM);
            }
            return;

        case FOUR_WAY_COMMANDS.cmd_DeviceInitFlash:
            this.initFlash(request, spend, send);
            return;

        case FOUR_WAY_COMMANDS.cmd_DeviceReset:
            this.deviceReset(request, spend, send);
            return;

        case FOUR_WAY_COMMANDS.cmd_DeviceRead:
            this.deviceRead(request, spend, send);
            return;

        case FOUR_WAY_COMMANDS.cmd_DeviceWrite:
            this.deviceWrite(request, spend, send);
            return;

        case FOUR_WAY_COMMANDS.cmd_DevicePageErase:
            this.pageErase(request, spend, send);
            return;

        case FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom:
            // AM32 does not implement CMD_PROG_EEPROM. ArduPilot discards the
            // failure and answers OK having written nothing (AP:1210-1212);
            // Betaflight has no imARM_BLB case so its pre-set error stands
            // (BF:815). Both are wrong; only one says so.
            send([0], this.profile.writeEepromSilentlySucceeds
                ? FOUR_WAY_ACK.ACK_OK
                : FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;

        case FOUR_WAY_COMMANDS.cmd_DeviceVerify: {
            // `CMD_VERIFY_FLASH_ARM` (0x04) is unimplemented in the AM32
            // bootloader (BL:674-675), so verify can never succeed against an
            // AM32 ESC -- verification has to be a read-back compare.
            if (!esc?.isConnected) {
                send([0], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
                return;
            }
            const result = esc.unsupportedCommand();
            spend(result.durationMs);
            send([0], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;
        }

        case FOUR_WAY_COMMANDS.cmd_DeviceReadEEprom:
        case FOUR_WAY_COMMANDS.cmd_DeviceEraseAll:
            // Neither firmware supports these for an ARM (AM32) target.
            send([0], FOUR_WAY_ACK.ACK_I_INVALID_CMD);
            return;

        default:
            send([0], FOUR_WAY_ACK.ACK_I_INVALID_CMD);
        }
    }

    private commandTouchesEsc (command: number): boolean {
        switch (command) {
        case FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive:
        case FOUR_WAY_COMMANDS.cmd_DeviceInitFlash:
        case FOUR_WAY_COMMANDS.cmd_DeviceReset:
        case FOUR_WAY_COMMANDS.cmd_DeviceRead:
        case FOUR_WAY_COMMANDS.cmd_DeviceWrite:
        case FOUR_WAY_COMMANDS.cmd_DevicePageErase:
        case FOUR_WAY_COMMANDS.cmd_DeviceVerify:
            return true;
        default:
            return false;
        }
    }

    private initFlash (
        request: FourWayRequest,
        spend: (ms: number) => void,
        send: (params: ArrayLike<number>, ack: FOUR_WAY_ACK, address?: number) => void
    ): void {
        const channel = request.params[0] ?? 0;

        if (channel >= this.escs.length || channel >= this.motorCountValue) {
            send([this.errorChannelByte(channel)], FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
            return;
        }

        this.selected = channel;
        const esc = this.escs[channel] as SimEsc;

        // Both firmwares retry the bootloader handshake three times
        // (BF:340, AP:1066-1078).
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = esc.connect();
            spend(result.durationMs);
            if (result.ack !== 'ok') {
                continue;
            }
            // The FC reverses BootInfo into deviceInfo (BFavr:225-227, AP:813-815).
            const info = Uint8Array.from([
                result.data[5] as number,
                result.data[4] as number,
                result.data[3] as number,
                INTERFACE_MODE_ARM_BLB
            ]);
            this.lastDeviceInfo = info;
            send(info, FOUR_WAY_ACK.ACK_OK);
            return;
        }

        if (this.profile.staleDeviceInfoOnConnectFailure) {
            // `SET_DISCONNECTED` only zeroes bytes 0-1, so 2-3 are whatever the
            // previous successful connect left there (BF:636-643).
            send(
                [0, 0, this.lastDeviceInfo[2] as number, this.lastDeviceInfo[3] as number],
                FOUR_WAY_ACK.ACK_D_GENERAL_ERROR
            );
        } else {
            send([channel], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
        }
    }

    private deviceReset (
        request: FourWayRequest,
        spend: (ms: number) => void,
        send: (params: ArrayLike<number>, ack: FOUR_WAY_ACK, address?: number) => void
    ): void {
        const channel = request.params[0] ?? 0;

        if (channel >= this.escs.length || channel >= this.motorCountValue) {
            send([this.errorChannelByte(channel)], FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
            return;
        }

        this.selected = channel;
        const esc = this.escs[channel] as SimEsc;
        const result = esc.reset();
        spend(result.durationMs);

        // Betaflight honours ADDR_L == 1 by holding the ESC's signal pin low for
        // 300 ms in a busy-wait (BF:604-611). ArduPilot has no equivalent.
        if (this.profile.name === 'betaflight' && (request.address & 0xFF) === 1) {
            spend(BF_ESC_REBOOT_HOLD_MS);
        }

        send([this.errorChannelByte(channel)], FOUR_WAY_ACK.ACK_OK);
    }

    private deviceRead (
        request: FourWayRequest,
        spend: (ms: number) => void,
        send: (params: ArrayLike<number>, ack: FOUR_WAY_ACK, address?: number) => void
    ): void {
        const esc = this.escs[this.selected];
        const length = (request.params[0] ?? 0) === 0 ? FOUR_WAY_MAX_PARAMS : (request.params[0] as number);

        if (!esc?.isConnected) {
            send([this.profile.failedReadByte], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;
        }

        const addressed = esc.setAddress(request.address);
        spend(addressed.durationMs);
        if (addressed.ack !== 'ok') {
            // ArduPilot's `BL_ReadA` returns false here without touching
            // `blheli.ack`, so it answers ACK_OK with one uninitialised byte
            // (AP:749-761,786). That is a genuine firmware bug and the host has
            // to survive it -- hence the profile flag rather than a shared path.
            send(
                [this.profile.failedReadByte],
                this.profile.readSetAddressFailureAcksOk
                    ? FOUR_WAY_ACK.ACK_OK
                    : FOUR_WAY_ACK.ACK_D_GENERAL_ERROR
            );
            return;
        }

        const result = esc.read(length);
        spend(result.durationMs);

        if (result.ack !== 'ok' || result.returnedBytes < length) {
            send([this.profile.failedReadByte], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;
        }

        send(result.data, FOUR_WAY_ACK.ACK_OK);
    }

    private deviceWrite (
        request: FourWayRequest,
        spend: (ms: number) => void,
        send: (params: ArrayLike<number>, ack: FOUR_WAY_ACK, address?: number) => void
    ): void {
        const esc = this.escs[this.selected];

        if (!esc?.isConnected) {
            send([0], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;
        }

        // Short-circuit, exactly as `BL_WriteA` does: `BL_SendCMDSetAddress`
        // failing means `CMD_SET_BUFFER` and `CMD_PROG_FLASH` are never put on
        // the wire (AP:915-942, BFavr:290-299). Carrying on would program the
        // payload at whatever address the *previous* write left behind, since
        // the bootloader does not move its pointer on a refused SET_ADDRESS.
        const addressed = esc.setAddress(request.address);
        spend(addressed.durationMs);
        if (addressed.ack !== 'ok') {
            send([0], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;
        }

        const buffered = esc.setBuffer(request.params);
        spend(buffered.durationMs);
        if (buffered.ack !== 'ok') {
            send([0], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            return;
        }

        const written = esc.programFlash();
        spend(written.durationMs);
        send([0], written.ack === 'ok' ? FOUR_WAY_ACK.ACK_OK : FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
    }

    private pageErase (
        request: FourWayRequest,
        spend: (ms: number) => void,
        send: (params: ArrayLike<number>, ack: FOUR_WAY_ACK, address?: number) => void
    ): void {
        const esc = this.escs[this.selected];
        const page = request.params[0] ?? 0;
        // imARM_BLB: page * 1024 (BF:675, AP:1115).
        const address = page << 10;

        if (!esc?.isConnected) {
            send([page], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR, this.pageEraseAddress(address));
            return;
        }

        const addressed = esc.setAddress(address);
        spend(addressed.durationMs);
        // Same short-circuit as the write path: `BL_PageErase` gives up when the
        // address handshake fails (AP:869-877, BFavr:314-321).
        const erased = addressed.ack === 'ok'
            ? esc.erasePage()
            : { ack: 'timeout' as const, durationMs: 0 };
        spend(erased.durationMs);

        const failed = addressed.ack !== 'ok' || erased.ack !== 'ok';
        // ArduPilot discards `BL_PageErase`'s return value, so it reports
        // success whatever happened (AP:1121); Betaflight reports it (BF:681).
        const ack = failed && this.profile.name === 'betaflight'
            ? FOUR_WAY_ACK.ACK_D_GENERAL_ERROR
            : FOUR_WAY_ACK.ACK_OK;
        send([page], ack, this.pageEraseAddress(address));
    }

    private pageEraseAddress (computed: number): number {
        return this.profile.pageEraseEchoesAddress ? computed : 0;
    }

    private errorChannelByte (channel: number): number {
        return this.profile.echoesChannelOnError ? channel : 0;
    }

    // ---- transmit ----------------------------------------------------------

    /**
     * Corrupt the frame's checksum when the selected ESC has `corruptCrc` armed.
     * Flipping the low CRC byte is enough: `parseFourWayResponse` rejects it, the
     * link retries with a drain, and the host must recover without poisoning the
     * next ESC.
     */
    private maybeCorrupt (frame: Uint8Array): Uint8Array {
        if (!this.escs[this.selected]?.takeCorruptCrc()) {
            return frame;
        }
        const corrupted = frame.slice();
        const last = corrupted.length - 1;
        corrupted[last] = ((corrupted[last] as number) ^ 0xFF) & 0xFF;
        return corrupted;
    }

    /**
     * Queue `bytes` for `afterMs` from now, never earlier than the previous
     * reply: the FC is a single serial line and cannot overtake itself.
     */
    private reply (bytes: Uint8Array, afterMs: number): void {
        const now = this.clock.now();
        const at = Math.max(now + Math.ceil(afterMs), this.txReadyAt);
        this.txReadyAt = at;
        this.clock.setTimeout(() => {
            for (const listener of [...this.listeners]) {
                listener(bytes);
            }
        }, at - now);
    }
}
