/**
 * am32-core — the transport-agnostic protocol core.
 *
 * Block 1b filled in the framing, eeprom, mcu and hex layers. Block 2 adds the
 * link layer and Clock, block 4 adds Am32Session.
 * See docs/plans/overhaul/STATUS.json and issue #3.
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

/**
 * The one extension point of the whole stack.
 *
 * Transports move bytes and nothing else: no framing, no timeouts, no retries,
 * no drain. Everything that could differ between the browser, Node, the
 * simulator and (later) Tauri is therefore forced up into the link layer, which
 * is what makes the UI and CLI paths identical by construction rather than by
 * discipline.
 */
export interface Transport {
    open(opts: { baudRate: number }): Promise<void>
    close(): Promise<void>
    write(data: Uint8Array): Promise<void>
    onData(cb: (chunk: Uint8Array) => void): () => void
    readonly isOpen: boolean
}
