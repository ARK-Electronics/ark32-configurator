/**
 * Where every protocol timeout comes from.
 *
 * Audit item C in issue #3: the flash write path passed a 200 ms literal for an
 * operation the FC itself budgets ~700 ms for, so a legitimate page write was
 * abandoned as a timeout. The fix is not a bigger literal -- it is that call
 * sites stop naming timeouts at all. They ask the policy, which derives the
 * number from the flight controller's own published budgets.
 *
 * Every constant below is a firmware fact with a citation. If you change one,
 * change it because the firmware changed.
 *
 * ArduPilot (`~/code/jake/ardupilot/libraries/AP_BLHeli/AP_BLHeli.cpp`):
 *   :593   soft serial to the ESCs is 19200 8N1
 *   :705   `BL_ReadBuf` -> `serial_read_bytes(buf, req_bytes, req_bytes * 1000)`
 *          microseconds, i.e. 1 ms per byte, over `len + 3` bytes when the MCU
 *          is connected (payload + CRC16 + ACK)
 *   :899   `BL_SendCMDSetBuffer` header ACK `BL_GetACK(5)`
 *   :912   `BL_SendCMDSetBuffer` payload ACK `BL_GetACK(40)`
 *   :941   `BL_WriteFlash` -> `BL_WriteA(CMD_PROG_FLASH, ..., 500)`
 *   :1211  `cmd_DeviceWriteEEprom` -> `BL_WriteA(CMD_PROG_EEPROM, ..., 3000)`
 *   :876   `BL_PageErase` -> `BL_GetACK(3000)`
 *   :760   `BL_SendCMDSetAddress` -> `BL_GetACK()`, default 2 ms (AP_BLHeli.h:278)
 *   :592   `MSP_SET_PASSTHROUGH` declares `EXPECT_DELAY_MS(1000)` and replies
 *          only after `serial_setup_output` returns
 *
 * Betaflight (`~/code/ark/betaflight/src/main/io/serial_4way_avrootloader.c`):
 *   :69    `START_BIT_TIMEOUT_MS 2` -- a per-byte start-bit timeout, so a read
 *          of n bytes can take 2 ms per byte, twice ArduPilot's budget
 *   :275   `BL_SendCMDSetBuffer` header ACK `BL_GetACK(2)` (~4 ms)
 *   :277   payload ACK `BL_GetACK(40)` -- a raw retry count, ~80 ms
 *   :332   flash program `BL_WriteA(CMD_PROG_FLASH, ..., 500 / 2)` ~500 ms
 *   :327   EEPROM write `BL_WriteA(CMD_PROG_EEPROM, ..., 3000 / 2)` ~3000 ms
 *   :320   `BL_PageErase` -> `BL_GetACK(3000 / 2)` ~3000 ms
 *   :264   `BL_SendCMDSetAddress` -> `BL_GetACK(2)` ~4 ms
 * and `src/main/io/serial_4way.c:608`: `cmd_DeviceReset` busy-waits 300 ms
 * before it answers.
 */

import { FOUR_WAY_COMMANDS, FOUR_WAY_RESPONSE_OVERHEAD } from '../framing/fourway';
import { MSP_COMMANDS } from '../framing/msp';

/**
 * Which flight controller is in the path. `generic` is used before detection
 * and takes the worse of the two budgets for every derivation, so an unknown FC
 * is never given a timeout that is too tight.
 */
export type FcVariant = 'ardupilot' | 'betaflight' | 'generic';

/** Soft serial from the FC to the ESCs (AP_BLHeli.cpp:593, BF BIT_TIME 52us). */
export const SOFT_SERIAL_BAUD = 19200;

/** USB CDC link from the host to the FC. Nominal; real bulk transfers are faster. */
export const HOST_LINK_BAUD = 115200;

/** 8N1: one start bit, eight data bits, one stop bit. */
const BITS_PER_BYTE = 10;

/**
 * Host-side slack on top of the FC's own budget: USB scheduling, the browser
 * task queue and the FC's main loop. Deliberately one named number rather than
 * a sprinkling of round-ups, so hardware bring-up has exactly one knob to turn.
 */
export const HOST_MARGIN_MS = 250;

/** Bytes the FC adds to a soft-serial read reply: CRC16 (2) + ACK (1). */
const BL_READ_OVERHEAD_BYTES = 3;

/** `BL_SendCMDSetAddress` ACK budget: 2 ms on ArduPilot, ~4 ms on Betaflight. */
const SET_ADDRESS_MS = 8;

/** `BL_SendCMDSetBuffer`: header ACK (5 ms / ~4 ms) then payload ACK (40 ms / ~80 ms). */
const SET_BUFFER_MS = 8 + 80;

/** `BL_WriteA(CMD_PROG_FLASH, ...)` ACK budget on both firmwares. */
const PROG_FLASH_ACK_MS = 500;

/** `BL_WriteA(CMD_PROG_EEPROM, ...)` and `BL_PageErase` on both firmwares. */
const PROG_EEPROM_ACK_MS = 3000;

/** Betaflight's `cmd_DeviceReset` busy-wait (serial_4way.c:608). */
const DEVICE_RESET_MS = 300;

/**
 * Floors from issue #3 section 2. A floor is a minimum, not a target: the
 * derivation wins whenever it is larger.
 */
export const TIMEOUT_FLOORS = {
    msp: 500,
    fourWayRead: 500,
    fourWayWriteFlash: 900,
    fourWayWriteEeprom: 3200,
    /**
     * Interface-level commands (init flash, test alive, exit, get name). Not in
     * the FC budget table -- entering the ESC bootloader is ESC-side timing the
     * FC does not bound -- so this keeps the value the app shipped before block
     * 2, which real hardware is known to work with.
     */
    fourWayInterface: 1000
} as const;

/**
 * ArduPilot's `MSP_SET_PASSTHROUGH` reply waits for `serial_setup_output` and
 * the firmware declares up to 1000 ms for it (AP_BLHeli.cpp:592). The plan's
 * table floors all MSP at 500 ms; that is too tight for this one command.
 */
export const MSP_PASSTHROUGH_MS = 1000 + HOST_MARGIN_MS;

/** Time to shift `bytes` bytes through an 8N1 line at `baud`, in milliseconds. */
export function wireMs (bytes: number, baud: number): number {
    return Math.ceil((Math.max(0, bytes) * BITS_PER_BYTE * 1000) / baud);
}

/** Per-byte soft-serial read budget the FC allows itself. */
function readBudgetPerByteMs (variant: FcVariant): number {
    // ArduPilot: req_bytes * 1000us. Betaflight: START_BIT_TIMEOUT_MS per byte.
    return variant === 'ardupilot' ? 1 : 2;
}

export interface TimeoutPolicyOptions {
    variant?: FcVariant
    /**
     * Multiplier applied to every derived timeout. Exists for the CLI's
     * `--timeout-scale` and for widening everything at once on a slow host,
     * instead of editing literals at call sites.
     */
    scale?: number
    marginMs?: number
}

/**
 * Timeouts keyed on `(command, payloadSize, fcVariant)`.
 *
 * Immutable: {@link withVariant} returns a new policy, so a session can adopt
 * the detected FC without any call site having to be told about it.
 */
export class TimeoutPolicy {
    readonly variant: FcVariant;
    readonly scale: number;
    readonly marginMs: number;

    constructor (options: TimeoutPolicyOptions = {}) {
        this.variant = options.variant ?? 'generic';
        this.scale = options.scale ?? 1;
        this.marginMs = options.marginMs ?? HOST_MARGIN_MS;
    }

    withVariant (variant: FcVariant): TimeoutPolicy {
        return variant === this.variant
            ? this
            : new TimeoutPolicy({ variant, scale: this.scale, marginMs: this.marginMs });
    }

    /** MSP over the host link. `MSP_SET_PASSTHROUGH` is the slow one. */
    forMsp (command: number): number {
        const base = command === MSP_COMMANDS.MSP_SET_PASSTHROUGH
            ? MSP_PASSTHROUGH_MS
            : TIMEOUT_FLOORS.msp + this.marginMs;
        return this.apply(base, TIMEOUT_FLOORS.msp);
    }

    /**
     * A 4-way exchange, end to end: host -> FC over USB, FC -> ESC over soft
     * serial, the bootloader's own ACK budget, and back.
     *
     * `payloadBytes` is the size of the data the *ESC* moves: the requested
     * byte count for a read, the written length for a write. It is not the
     * number of 4-way params, which for a read is 1.
     */
    forFourWay (command: FOUR_WAY_COMMANDS, payloadBytes = 0): number {
        switch (command) {
        case FOUR_WAY_COMMANDS.cmd_DeviceRead:
        case FOUR_WAY_COMMANDS.cmd_DeviceReadEEprom:
        case FOUR_WAY_COMMANDS.cmd_DeviceVerify:
            return this.apply(this.readMs(payloadBytes), TIMEOUT_FLOORS.fourWayRead);

        case FOUR_WAY_COMMANDS.cmd_DeviceWrite:
            return this.apply(
                this.writeMs(payloadBytes, PROG_FLASH_ACK_MS),
                TIMEOUT_FLOORS.fourWayWriteFlash
            );

        case FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom:
        case FOUR_WAY_COMMANDS.cmd_DevicePageErase:
        case FOUR_WAY_COMMANDS.cmd_DeviceEraseAll:
            return this.apply(
                this.writeMs(payloadBytes, PROG_EEPROM_ACK_MS),
                TIMEOUT_FLOORS.fourWayWriteEeprom
            );

        case FOUR_WAY_COMMANDS.cmd_DeviceReset:
            return this.apply(
                DEVICE_RESET_MS + this.hostRoundTripMs(payloadBytes) + this.marginMs,
                TIMEOUT_FLOORS.fourWayRead
            );

        default:
            return this.apply(
                this.hostRoundTripMs(payloadBytes) + this.marginMs,
                TIMEOUT_FLOORS.fourWayInterface
            );
        }
    }

    /** `wire(n) + BL_ReadBuf(n x per-byte budget) + set address + margin`. */
    private readMs (bytes: number): number {
        const framed = bytes + BL_READ_OVERHEAD_BYTES;
        return wireMs(framed, SOFT_SERIAL_BAUD) +
            framed * readBudgetPerByteMs(this.variant) +
            SET_ADDRESS_MS +
            this.hostRoundTripMs(bytes) +
            this.marginMs;
    }

    /** `wire(n) + set buffer ACKs + program ACK + set address + margin`. */
    private writeMs (bytes: number, programAckMs: number): number {
        return wireMs(bytes, SOFT_SERIAL_BAUD) +
            SET_BUFFER_MS +
            programAckMs +
            SET_ADDRESS_MS +
            this.hostRoundTripMs(bytes) +
            this.marginMs;
    }

    /** The 4-way frames themselves, on the USB link to the FC. */
    private hostRoundTripMs (payloadBytes: number): number {
        return wireMs(payloadBytes + 2 * FOUR_WAY_RESPONSE_OVERHEAD, HOST_LINK_BAUD);
    }

    private apply (derived: number, floor: number): number {
        return Math.ceil(Math.max(derived, floor) * this.scale);
    }
}

/** The policy used before an FC has been identified. */
export const DEFAULT_TIMEOUT_POLICY = new TimeoutPolicy();
