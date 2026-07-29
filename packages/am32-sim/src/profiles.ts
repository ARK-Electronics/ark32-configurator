/**
 * The two flight-controller profiles, as differences rather than as prose.
 *
 * Issue #3 section 2 puts the FC quirks table in the plan; this is that table
 * turned into data the simulator can be driven by, so a regression that assumes
 * ArduPilot's behaviour on a Betaflight board fails a test instead of failing on
 * someone's bench.
 *
 * Every field carries its firmware citation. Read with subagents against:
 *   AP  = `~/code/jake/ardupilot/libraries/AP_BLHeli/AP_BLHeli.cpp`
 *   GCS = `~/code/jake/ardupilot/libraries/GCS_MAVLink/GCS_Common.cpp`
 *   BF  = `~/code/ark/betaflight/src/main/io/serial_4way.c`
 *   BFm = `~/code/ark/betaflight/src/main/msp/msp.c`
 *   BFs = `~/code/ark/betaflight/src/main/msp/msp_serial.c`
 */

export type FcProfileName = 'ardupilot' | 'betaflight';

export interface FcProfile {
    readonly name: FcProfileName

    // ---- MSP identity ------------------------------------------------------

    /** `MSP_FC_VARIANT`: four raw ASCII bytes, no NUL and no length prefix. */
    readonly fcVariant: string
    /** `MSP_API_VERSION`: MSP protocol version, API major, API minor. */
    readonly apiVersion: readonly [number, number, number]
    /** `MSP_FC_VERSION`. AP hard-codes `{3,3,1}` for BLHeliSuite compatibility. */
    readonly fcVersion: readonly number[]

    // ---- MSP behaviour -----------------------------------------------------

    /**
     * How long the port must be free of valid MAVLink before ArduPilot hands it
     * to the alternative-protocol handler. `protocol_timeout = 4000`
     * (GCS:1944). Bytes that arrive inside the window are read and discarded --
     * they do **not** extend it (GCS:1943,1970-1977), which is what makes a
     * probe-then-wait connect strategy work at all.
     *
     * Zero for Betaflight: MSP answers immediately.
     */
    readonly mavlinkIdleMs: number

    /**
     * Passthrough is a blocking loop that never returns to the MSP parser
     * (BF:453 `while (1)`, exit only via `cmd_InterfaceExit` at BF:923-926).
     * ArduPilot instead multiplexes the two protocols byte by byte and will even
     * enter 4-way on a bare `/` with no `MSP_SET_PASSTHROUGH` (AP:1242-1256).
     */
    readonly blockingFourWay: boolean

    /** ArduPilot's MSP parser accepts `$M` only -- there is no `$X` branch (AP:197-205). */
    readonly acceptsMspV2: boolean

    /**
     * An unhandled MSP command draws a `$M!` frame (BFm:4406-4408) rather than
     * silence (AP:601-604). Neither answers a bad checksum at all.
     */
    readonly mspErrorFrames: boolean

    /** `MSP_MOTOR` value for an enabled motor: 0 when AP has `mixed_type` outputs (AP:535), 1000 when BF idles (dshot.c:117). */
    readonly idleMotorValue: number

    // ---- 4-way behaviour ---------------------------------------------------

    /** `cmd_ProtocolGetVersion`: 108 on BF (BF:77), 107 on AP (blheli_4way_protocol.h:123). */
    readonly protocolVersion: number

    /** `cmd_InterfaceGetName`: 9 raw chars on BF (BF:546), a Pascal string on AP (AP:1002). */
    readonly interfaceName: readonly number[]

    /** `cmd_InterfaceGetVersion`: `{200,6}` on BF, `{200,5}` on AP. */
    readonly interfaceVersion: readonly [number, number]

    /**
     * A 4-way frame whose CRC does not verify draws `ACK_I_INVALID_CRC` from
     * Betaflight (BF:487-491) and **nothing at all** from ArduPilot
     * (AP:298-300), which is why the host must have a timeout on every request.
     */
    readonly repliesToBadFourWayCrc: boolean

    /**
     * The single param byte of a failed `cmd_DeviceRead`. Betaflight's is a
     * deterministic zero (BF:465-467); ArduPilot's is an **uninitialised stack
     * byte** (AP:1098-1103, a VLA that is never written). The simulator picks a
     * fixed non-zero value for it, because "uninitialised" must not be allowed
     * to look like a plausible payload.
     */
    readonly failedReadByte: number

    /**
     * Error replies echo the requested channel number (AP:1060,1035,1048)
     * rather than a zero byte (BF's `Dummy.word = 0` default, BF:465-467).
     */
    readonly echoesChannelOnError: boolean

    /**
     * `cmd_DeviceInitFlash` on a connect failure replies with **four** param
     * bytes on Betaflight -- `O_PARAM_LEN` was already 4 and `SET_DISCONNECTED`
     * only zeroes the first two, so bytes 2-3 are stale from the previous
     * successful connect (BF:636-643). ArduPilot replies with one (AP:1081-1083).
     */
    readonly staleDeviceInfoOnConnectFailure: boolean

    /**
     * `cmd_DevicePageErase` echoes the *computed* erase address on Betaflight
     * (BF:675-680) but a forced `0x0000` on ArduPilot (AP:1122).
     */
    readonly pageEraseEchoesAddress: boolean

    /**
     * When the `CMD_SET_ADDRESS` handshake fails inside `cmd_DeviceRead`,
     * ArduPilot's `BL_ReadA` returns false **without setting `blheli.ack`**
     * (AP:749-761, AP:786), so the reply is `ACK_OK` carrying one uninitialised
     * byte. Betaflight reports `ACK_D_GENERAL_ERROR`. This is the sharpest form
     * of block 1b's still-open "a short read looks like success" hazard: the ACK
     * says fine, the payload is one byte of nothing.
     */
    readonly readSetAddressFailureAcksOk: boolean

    /**
     * `cmd_DeviceWriteEEprom` against an ARM (AM32) target: Betaflight has no
     * case for `imARM_BLB` so its pre-set `ACK_D_GENERAL_ERROR` stands
     * (BF:815), while ArduPilot discards `BL_WriteA`'s return value and answers
     * `ACK_OK` having written nothing (AP:1210-1212). Both are wrong; only one
     * of them tells you so.
     */
    readonly writeEepromSilentlySucceeds: boolean

    /** Soft-serial read budget per byte: `req_bytes * 1000` us on AP, `START_BIT_TIMEOUT_MS` on BF. */
    readonly readBudgetPerByteMs: number
}

/** `imARM_BLB` -- what every AM32 ESC classifies as (AP:841-849, BF:328-334). */
export const INTERFACE_MODE_ARM_BLB = 4;

export const ARDUPILOT_PROFILE: FcProfile = {
    name: 'ardupilot',
    fcVariant: 'ARDU',
    apiVersion: [0, 1, 42],
    fcVersion: [3, 3, 1],
    mavlinkIdleMs: 4000,
    blockingFourWay: false,
    acceptsMspV2: false,
    mspErrorFrames: false,
    idleMotorValue: 0,
    protocolVersion: 107,
    interfaceName: [0x04, 0x41, 0x52, 0x44, 0x55],
    interfaceVersion: [200, 5],
    repliesToBadFourWayCrc: false,
    failedReadByte: 0xA5,
    echoesChannelOnError: true,
    staleDeviceInfoOnConnectFailure: false,
    pageEraseEchoesAddress: false,
    readSetAddressFailureAcksOk: true,
    writeEepromSilentlySucceeds: true,
    readBudgetPerByteMs: 1
};

export const BETAFLIGHT_PROFILE: FcProfile = {
    name: 'betaflight',
    fcVariant: 'BTFL',
    // Betaflight 4.5, which is what is on hardware in the field. `master` is at
    // API 1.48 and has moved `MSP_FC_VERSION` to a calendar-versioned layout
    // with a trailing Pascal string; the 3-byte `{major, minor, patch}` form
    // below is what a shipped release sends. Nothing the configurator does
    // reads either field, so the simulator models the one on real boards.
    apiVersion: [0, 1, 46],
    fcVersion: [4, 5, 0],
    mavlinkIdleMs: 0,
    blockingFourWay: true,
    acceptsMspV2: true,
    mspErrorFrames: true,
    idleMotorValue: 1000,
    protocolVersion: 108,
    interfaceName: [0x6D, 0x34, 0x77, 0x46, 0x43, 0x49, 0x6E, 0x74, 0x66],
    interfaceVersion: [200, 6],
    repliesToBadFourWayCrc: true,
    failedReadByte: 0x00,
    echoesChannelOnError: false,
    staleDeviceInfoOnConnectFailure: true,
    pageEraseEchoesAddress: true,
    readSetAddressFailureAcksOk: false,
    writeEepromSilentlySucceeds: false,
    readBudgetPerByteMs: 2
};

export const PROFILES: Record<FcProfileName, FcProfile> = {
    ardupilot: ARDUPILOT_PROFILE,
    betaflight: BETAFLIGHT_PROFILE
};
