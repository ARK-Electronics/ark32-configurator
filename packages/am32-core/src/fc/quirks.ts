/**
 * Flight-controller quirks, encoded rather than commented.
 *
 * Issue #3 section 2 puts these in a table and audit item **H** is the
 * configurator not encoding them anywhere: it paid ArduPilot's 4 s MAVLink-idle
 * tax on every Betaflight connect, and it had nothing at all to say about
 * Betaflight's blocking passthrough. Here they are data, so the session branches
 * on a record rather than on `if (variant === ...)` scattered through the flow.
 *
 * Every field carries its firmware citation, re-read against the current trees:
 *   AP  = `~/code/jake/ardupilot/libraries/AP_BLHeli/AP_BLHeli.cpp`
 *   GCS = `~/code/jake/ardupilot/libraries/GCS_MAVLink/GCS_Common.cpp`
 *   BF  = `~/code/ark/betaflight/src/main/io/serial_4way.c`
 *   BFm = `~/code/ark/betaflight/src/main/msp/msp.c`
 *   BFs = `~/code/ark/betaflight/src/main/msp/msp_serial.c`
 *
 * Two facts that are true of *both* firmwares, so they are written down here
 * rather than turned into fields nothing branches on:
 *
 *  - **`MSP_MOTOR` is not a motor count.** ArduPilot reports zero for every
 *    motor when outputs are `mixed_type` (AP:533-535) and Betaflight idles a
 *    stopped motor at `PWM_RANGE_MIN` = 1000, so counting non-zero slots gives
 *    8. The authoritative count is `MSP_MOTOR_CONFIG` byte 6 on both
 *    (AP:520, BFm:1509).
 *  - **`MSP_SET_PASSTHROUGH` takes either no payload or `[mode, argument]`**,
 *    and an empty payload means 4-way on both (AP:574-575, BFm:301-303). The
 *    session sends the empty form, which is what the app has always sent.
 */

import type { FcVariant } from '../link/timeout-policy';

/** What an MSP frame does to a flight controller that is in 4-way passthrough. */
export type MspInPassthrough =
    /**
     * Swallowed with no reply. Betaflight's `esc4wayProcess` is a `while (1)`
     * that scans for `cmd_Local_Escape` and discards every other byte
     * (BF:453-461); MSP does not run again until `cmd_InterfaceExit` (BF:923-926).
     */
    | 'ignored'
    /**
     * Silently leaves passthrough. A `$` seen between 4-way frames sets
     * `escMode = PROTOCOL_NONE` and calls `serial_end()` (AP:1242-1246), which
     * tears down the soft-serial link and marks every ESC disconnected. So the
     * reply arrives -- and the next 4-way command fails, having lost the
     * bootloader session it depended on.
     */
    | 'exits-passthrough';

export interface FcQuirks {
    readonly variant: FcVariant;

    /**
     * MSP is answered on a freshly opened port with no warm-up.
     *
     * False for ArduPilot: `GCS_MAVLINK::update_receive` only offers a byte to
     * the alternative-protocol handler once `now_ms - last_mavlink_ms >
     * protocol_timeout`, `protocol_timeout = 4000` (GCS:1944-1947). True for
     * Betaflight, which has no time-based gate on MSP at all.
     */
    readonly mspAvailableImmediately: boolean;

    /**
     * Milliseconds of MAVLink silence before the port is handed over.
     *
     * The window is re-armed only by a **valid MAVLink frame**:
     * `alternative.last_mavlink_ms = now_ms` appears exactly once, at GCS:1977,
     * reached only on `MAVLINK_FRAMING_OK` (GCS:1974). Bytes that arrive while
     * the window is shut are read (GCS:1943) and handed to the MAVLink parser,
     * which rejects them -- they are *consumed and lost*, not buffered.
     *
     * That is what makes probe-then-wait correct: polling during the window
     * costs nothing except the requests it loses, so there is no reason to pay
     * the wait up front. Audit **H**.
     */
    readonly mavlinkIdleMs: number;

    /** See {@link MspInPassthrough}. Either way: do not send MSP in passthrough. */
    readonly mspInPassthrough: MspInPassthrough;

    /**
     * The FC enters 4-way on a bare `/` with no `MSP_SET_PASSTHROUGH`
     * (AP:1247-1251, requires `MSP_IDLE` and a disarmed vehicle). Betaflight's
     * MSP parser discards the byte instead.
     *
     * The session uses this only to explain a failure; it always asks with
     * `MSP_SET_PASSTHROUGH`, because ArduPilot's bare-escape path skips
     * `serial_setup_output` and is documented as less reliable (AP:590-591).
     */
    readonly entersFourWayOnBareEscape: boolean;

    /**
     * An unhandled MSP command draws a `$M!` error frame (BFm:4406-4408) rather
     * than silence (AP:601-604). Both shapes must fail rather than parse as
     * data -- audit **D**, closed in `framing/msp.ts`.
     */
    readonly mspErrorFrames: boolean;

    /**
     * A `cmd_DeviceRead` whose `CMD_SET_ADDRESS` handshake failed can come back
     * **`ACK_OK` carrying one byte of uninitialised stack**: `BL_ReadA` returns
     * false at AP:786 without ever touching `blheli.ack` (AP:749-761), and the
     * reply buffer is a VLA that is never written (AP:1098-1103). Betaflight
     * reports `ACK_D_GENERAL_ERROR` with a deterministic zero (BF:465-467).
     *
     * This is why every read is validated on **length** and not on the ACK
     * alone. See `esc/fourway-session.ts`.
     */
    readonly readSetAddressFailureAcksOk: boolean;

    /** `MSP_FC_VARIANT` strings that select this record. */
    readonly fcVariantIds: readonly string[];
}

export const ARDUPILOT_QUIRKS: FcQuirks = {
    variant: 'ardupilot',
    mspAvailableImmediately: false,
    mavlinkIdleMs: 4000,
    mspInPassthrough: 'exits-passthrough',
    entersFourWayOnBareEscape: true,
    mspErrorFrames: false,
    readSetAddressFailureAcksOk: true,
    fcVariantIds: ['ARDU']
};

/**
 * INAV ships Betaflight's `serial_4way` unchanged, including its blocking
 * passthrough loop and its per-byte start-bit read timeout, so it inherits this
 * record and the `betaflight` timeout budgets with it.
 */
export const BETAFLIGHT_QUIRKS: FcQuirks = {
    variant: 'betaflight',
    mspAvailableImmediately: true,
    mavlinkIdleMs: 0,
    mspInPassthrough: 'ignored',
    entersFourWayOnBareEscape: false,
    mspErrorFrames: true,
    readSetAddressFailureAcksOk: false,
    fcVariantIds: ['BTFL', 'INAV', 'CLFL', 'EMUF']
};

/**
 * Before an FC has identified itself. Takes the *worse* case of every field, so
 * an unidentified FC is never given a shortcut it has not earned -- the same
 * rule `TimeoutPolicy`'s `generic` variant follows.
 */
export const GENERIC_QUIRKS: FcQuirks = {
    variant: 'generic',
    mspAvailableImmediately: false,
    mavlinkIdleMs: 4000,
    mspInPassthrough: 'ignored',
    entersFourWayOnBareEscape: false,
    mspErrorFrames: false,
    readSetAddressFailureAcksOk: true,
    fcVariantIds: []
};

const ALL_QUIRKS: readonly FcQuirks[] = [ARDUPILOT_QUIRKS, BETAFLIGHT_QUIRKS];

/** The quirks for a variant the caller already knows. */
export function quirksForVariant (variant: FcVariant): FcQuirks {
    return ALL_QUIRKS.find(q => q.variant === variant) ?? GENERIC_QUIRKS;
}

/**
 * Resolve an `MSP_FC_VARIANT` payload string. Unknown identifiers fall back to
 * {@link GENERIC_QUIRKS} rather than guessing: a wrong guess here silently
 * mis-derives every timeout in the session.
 */
export function quirksForFcVariantId (id: string): FcQuirks {
    const normalised = id.trim().toUpperCase();
    return ALL_QUIRKS.find(q => q.fcVariantIds.includes(normalised)) ?? GENERIC_QUIRKS;
}
