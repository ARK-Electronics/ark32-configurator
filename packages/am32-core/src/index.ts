/**
 * am32-core — the transport-agnostic protocol core.
 *
 * Block 1b filled in the framing, eeprom, mcu and hex layers. Block 2 added the
 * transport interface, the injectable clock and the link layer; block 4 adds
 * Am32Session. See docs/plans/overhaul/STATUS.json and issue #3.
 *
 * Everything here is importable both as a whole (`am32-core`) and by module
 * (`am32-core/framing/msp`). Vue components must use the session layer only --
 * block 5 adds the ESLint rule that enforces it.
 */

export {
    EEPROM_SIZE,
    EepromLayout,
    NUMBER_ARRAY_FIELDS
} from './eeprom/layout';
export type {
    EepromField,
    EepromLayoutField,
    EepromLayoutKeys,
    EepromLayoutValues,
    EscSettings,
    McuSettings
} from './eeprom/layout';

export { decodeSettings, encodeSettings, patchSettings } from './eeprom/codec';

export {
    MSP_COMMANDS,
    MSP_JUMBO_FRAME_SIZE_LIMIT,
    MSP_V1_MAX_COMMAND,
    MspFrameError,
    MspParser,
    crc8DvbS2Data,
    encodeMspCommand,
    encodeMspV1,
    encodeMspV2,
    isCompleteMspFrame,
    isMspRequest,
    parseMspResponse
} from './framing/msp';
export type {
    MspDirection,
    MspFrame,
    MspFrameErrorReason,
    MspVersion,
    ParseMspResponseOptions
} from './framing/msp';

export {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    FOUR_WAY_LOCAL_ESCAPE,
    FOUR_WAY_MAX_PARAMS,
    FOUR_WAY_REMOTE_ESCAPE,
    FOUR_WAY_RESPONSE_OVERHEAD,
    FourWayFrameError,
    crc16Xmodem,
    crc16XmodemUpdate,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse
} from './framing/fourway';
export type { FourWayFrameErrorReason, FourWayResponse } from './framing/fourway';

export { Mcu, createMcuInfo } from './mcu';
export type { EscData, McuInfo, McuVariant } from './mcu';

export { fillImage, parseHex } from './hex';
export type { Hex, HexData } from './hex';

export type { Transport } from './transport';

export { VirtualClock, createSystemClock } from './clock';
export type { Clock, ClockTimer, TimerHost } from './clock';

export { Link, LinkError } from './link/link';
export type {
    LinkErrorReason,
    LinkOptions,
    LinkProbe,
    LinkRequestOptions,
    LinkStats,
    LinkValidator
} from './link/link';

export {
    DEFAULT_TIMEOUT_POLICY,
    HOST_LINK_BAUD,
    HOST_MARGIN_MS,
    MSP_PASSTHROUGH_MS,
    SOFT_SERIAL_BAUD,
    TIMEOUT_FLOORS,
    TimeoutPolicy,
    wireMs
} from './link/timeout-policy';
export type { FcVariant, TimeoutPolicyOptions } from './link/timeout-policy';
