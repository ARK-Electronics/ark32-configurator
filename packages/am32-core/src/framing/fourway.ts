/**
 * BLHeli 4-way interface framing (host <-> flight controller).
 *
 * Verified against the firmware rather than inferred:
 *   - Betaflight `src/main/io/serial_4way.c:457-495` (request parse),
 *     `:896-919` (reply emit), `:313-325` (`_crc_xmodem_update`).
 *   - ArduPilot `libraries/AP_BLHeli/AP_BLHeli.cpp:258-303` (request parse),
 *     `:610-623` (reply emit), `libraries/AP_Math/crc.cpp:288-310`.
 *
 * Note this is *not* the CRC the FC speaks to the ESC over soft-serial -- that
 * one is reflected poly 0xA001, little-endian, and never appears on the host
 * link (Betaflight `serial_4way_avrootloader.c:135-148`).
 */

/** Start byte of a host -> FC request (`cmd_Local_Escape`, '/'). */
export const FOUR_WAY_LOCAL_ESCAPE = 0x2F;

/** Start byte of an FC -> host response (`cmd_Remote_Escape`, '.'). */
export const FOUR_WAY_REMOTE_ESCAPE = 0x2E;

/**
 * Bytes of a response frame that are not params: start, command, address (2),
 * param count, ACK and the 2 CRC bytes.
 */
export const FOUR_WAY_RESPONSE_OVERHEAD = 8;

/**
 * Both firmwares bound a frame at 256 params, and both encode 256 as a param
 * count of 0 (ArduPilot `AP_BLHeli.cpp:282`, Betaflight's underflowing
 * do-while at `serial_4way.c:475-480`).
 */
export const FOUR_WAY_MAX_PARAMS = 256;

export enum FOUR_WAY_COMMANDS {
    cmd_InterfaceTestAlive = 0x30,
    cmd_ProtocolGetVersion = 0x31,
    cmd_InterfaceGetName = 0x32,
    cmd_InterfaceGetVersion = 0x33,
    cmd_InterfaceExit = 0x34,
    cmd_DeviceReset = 0x35,
    cmd_DeviceInitFlash = 0x37,
    cmd_DeviceEraseAll = 0x38,
    cmd_DevicePageErase = 0x39,
    cmd_DeviceRead = 0x3A,
    cmd_DeviceWrite = 0x3B,
    cmd_DeviceC2CK_LOW = 0x3C,
    cmd_DeviceReadEEprom = 0x3D,
    cmd_DeviceWriteEEprom = 0x3E,
    cmd_InterfaceSetMode = 0x3F,
    /** Implemented by both firmwares (BF `serial_4way.c:263`, AP `blheli_4way_protocol.h:112`). */
    cmd_DeviceVerify = 0x40,
}

export enum FOUR_WAY_ACK {
    ACK_OK = 0x00,
    ACK_I_UNKNOWN_ERROR = 0x01,
    ACK_I_INVALID_CMD = 0x02,
    ACK_I_INVALID_CRC = 0x03,
    ACK_I_VERIFY_ERROR = 0x04,
    ACK_D_INVALID_COMMAND = 0x05,
    ACK_D_COMMAND_FAILED = 0x06,
    ACK_D_UNKNOWN_ERROR = 0x07,
    ACK_I_INVALID_CHANNEL = 0x08,
    ACK_I_INVALID_PARAM = 0x09,
    ACK_D_GENERAL_ERROR = 0x0F,
}

export interface FourWayResponse {
    command: number;
    address: number;
    ack: number;
    checksum: number;
    params: Uint8Array;
}

/**
 * A host -> FC request, as the flight controller parses it. The host never
 * needs this; `am32-sim`'s `SimFc` does, and it lives here so there is exactly
 * one implementation of 4-way framing in the tree rather than one per side.
 */
export interface FourWayRequest {
    command: number;
    address: number;
    checksum: number;
    params: Uint8Array;
}

export type FourWayFrameErrorReason =
    | 'start'
    | 'truncated'
    | 'checksum'
    | 'params';

export class FourWayFrameError extends Error {
    readonly reason: FourWayFrameErrorReason;

    constructor (reason: FourWayFrameErrorReason, message: string) {
        super(message);
        this.name = 'FourWayFrameError';
        this.reason = reason;
    }
}

/**
 * CRC-16/XMODEM, one byte at a time. Poly 0x1021, init 0, not reflected, no
 * final xor. Transmitted big-endian.
 */
export function crc16XmodemUpdate (crc: number, byte: number): number {
    let next = crc ^ ((byte & 0xFF) << 8);
    for (let i = 0; i < 8; i += 1) {
        next = (next & 0x8000) ? ((next << 1) ^ 0x1021) : (next << 1);
    }
    return next & 0xFFFF;
}

/** CRC-16/XMODEM over a whole buffer. The check value for "123456789" is 0x31C3. */
export function crc16Xmodem (data: ArrayLike<number>, start = 0, end = data.length): number {
    let crc = 0;
    for (let i = start; i < end; i += 1) {
        crc = crc16XmodemUpdate(crc, data[i] as number);
    }
    return crc;
}

/**
 * Build a host -> FC request frame.
 *
 * An empty param list becomes a single zero byte: both firmwares require at
 * least one param and a count byte of 0 means 256, not none.
 */
export function encodeFourWayRequest (
    command: FOUR_WAY_COMMANDS,
    params: ArrayLike<number> = [0],
    address = 0
): Uint8Array {
    const payload = params.length === 0 ? [0] : params;

    if (payload.length > FOUR_WAY_MAX_PARAMS) {
        throw new FourWayFrameError('params', `too many parameters: ${payload.length} (max ${FOUR_WAY_MAX_PARAMS})`);
    }

    const frame = new Uint8Array(7 + payload.length);
    frame[0] = FOUR_WAY_LOCAL_ESCAPE;
    frame[1] = command;
    frame[2] = (address >> 8) & 0xFF;
    frame[3] = address & 0xFF;
    frame[4] = payload.length === FOUR_WAY_MAX_PARAMS ? 0 : payload.length;

    for (let i = 0; i < payload.length; i += 1) {
        frame[5 + i] = (payload[i] as number) & 0xFF;
    }

    const checksum = crc16Xmodem(frame, 0, frame.length - 2);
    frame[5 + payload.length] = (checksum >> 8) & 0xFF;
    frame[6 + payload.length] = checksum & 0xFF;

    return frame;
}

/**
 * Build an FC -> host response frame.
 *
 * The mirror of {@link encodeFourWayRequest}, with the ACK byte inserted before
 * the checksum. The checksum covers everything up to and including the ACK
 * (ArduPilot `AP_BLHeli.cpp:620`, Betaflight `serial_4way.c:901-918`).
 *
 * Note the length byte is always the *reply's* param count, never the request's,
 * and 256 is encoded as 0 in both directions.
 */
export function encodeFourWayResponse (
    command: FOUR_WAY_COMMANDS | number,
    params: ArrayLike<number> = [0],
    ack: FOUR_WAY_ACK | number = FOUR_WAY_ACK.ACK_OK,
    address = 0
): Uint8Array {
    const payload = params.length === 0 ? [0] : params;

    if (payload.length > FOUR_WAY_MAX_PARAMS) {
        throw new FourWayFrameError('params', `too many parameters: ${payload.length} (max ${FOUR_WAY_MAX_PARAMS})`);
    }

    const frame = new Uint8Array(FOUR_WAY_RESPONSE_OVERHEAD + payload.length);
    frame[0] = FOUR_WAY_REMOTE_ESCAPE;
    frame[1] = command;
    frame[2] = (address >> 8) & 0xFF;
    frame[3] = address & 0xFF;
    frame[4] = payload.length === FOUR_WAY_MAX_PARAMS ? 0 : payload.length;

    for (let i = 0; i < payload.length; i += 1) {
        frame[5 + i] = (payload[i] as number) & 0xFF;
    }
    frame[5 + payload.length] = ack & 0xFF;

    const checksum = crc16Xmodem(frame, 0, 6 + payload.length);
    frame[6 + payload.length] = (checksum >> 8) & 0xFF;
    frame[7 + payload.length] = checksum & 0xFF;

    return frame;
}

/**
 * How many params a response frame claims, or null if the buffer is too short
 * to tell. A count byte of 0 means 256.
 */
function claimedParamCount (buffer: Uint8Array): number | null {
    if (buffer.length < 5) {
        return null;
    }
    const raw = buffer[4] as number;
    return raw === 0 ? FOUR_WAY_MAX_PARAMS : raw;
}

/**
 * Structural completeness probe for a response frame: true once the buffer
 * holds a whole frame. Used by the link layer to decide when to stop reading;
 * it deliberately says nothing about the checksum or the ACK.
 */
export function isCompleteFourWayFrame (buffer: Uint8Array): boolean {
    if (buffer.length < FOUR_WAY_RESPONSE_OVERHEAD || buffer[0] !== FOUR_WAY_REMOTE_ESCAPE) {
        return false;
    }
    const params = claimedParamCount(buffer);
    return params !== null && buffer.length >= params + FOUR_WAY_RESPONSE_OVERHEAD;
}

/**
 * Parse an FC -> host response frame. Throws {@link FourWayFrameError} on a bad
 * start byte, a truncated frame or a checksum mismatch; a non-OK ACK is a
 * successfully parsed frame, not a framing error, and is the caller's business.
 *
 * The checksum covers everything up to and including the ACK byte
 * (ArduPilot `AP_BLHeli.cpp:620` computes it over `len + 6`), so only the two
 * CRC bytes themselves are outside it.
 */
export function parseFourWayResponse (buffer: Uint8Array): FourWayResponse {
    if (buffer.length === 0 || buffer[0] !== FOUR_WAY_REMOTE_ESCAPE) {
        throw new FourWayFrameError('start', `invalid message start: ${buffer[0]}`);
    }

    if (buffer.length < FOUR_WAY_RESPONSE_OVERHEAD + 1) {
        throw new FourWayFrameError('truncated', 'NotEnoughDataError');
    }

    const paramCount = claimedParamCount(buffer) as number;

    if (buffer.length < paramCount + FOUR_WAY_RESPONSE_OVERHEAD) {
        throw new FourWayFrameError('truncated', 'NotEnoughDataError');
    }

    const response: FourWayResponse = {
        command: buffer[1] as number,
        address: ((buffer[2] as number) << 8) | (buffer[3] as number),
        ack: buffer[5 + paramCount] as number,
        checksum: ((buffer[6 + paramCount] as number) << 8) | (buffer[7 + paramCount] as number),
        params: buffer.slice(5, 5 + paramCount)
    };

    const checksum = crc16Xmodem(buffer, 0, 6 + paramCount);
    if (checksum !== response.checksum) {
        throw new FourWayFrameError(
            'checksum',
            `checksum mismatch, received: ${response.checksum}, calculated: ${checksum}`
        );
    }

    return response;
}

/**
 * Bytes of a request frame that are not params: start, command, address (2),
 * param count and the 2 CRC bytes. One fewer than a response, which also
 * carries an ACK.
 */
export const FOUR_WAY_REQUEST_OVERHEAD = 7;

/**
 * Structural completeness probe for a host -> FC request. The FC's half of
 * {@link isCompleteFourWayFrame}; says nothing about the checksum.
 */
export function isCompleteFourWayRequest (buffer: Uint8Array): boolean {
    if (buffer.length < FOUR_WAY_REQUEST_OVERHEAD || buffer[0] !== FOUR_WAY_LOCAL_ESCAPE) {
        return false;
    }
    const params = claimedParamCount(buffer);
    return params !== null && buffer.length >= params + FOUR_WAY_REQUEST_OVERHEAD;
}

/**
 * Parse a host -> FC request frame. Throws {@link FourWayFrameError} on a bad
 * start byte, a truncated frame or a checksum mismatch.
 *
 * The two firmwares diverge on what they do with a `checksum` failure --
 * Betaflight answers `ACK_I_INVALID_CRC` while ArduPilot drops the frame in
 * silence -- so that decision belongs to the caller, not here.
 */
export function parseFourWayRequest (buffer: Uint8Array): FourWayRequest {
    if (buffer.length === 0 || buffer[0] !== FOUR_WAY_LOCAL_ESCAPE) {
        throw new FourWayFrameError('start', `invalid message start: ${buffer[0]}`);
    }

    if (buffer.length < FOUR_WAY_REQUEST_OVERHEAD) {
        throw new FourWayFrameError('truncated', 'NotEnoughDataError');
    }

    const paramCount = claimedParamCount(buffer) as number;

    if (buffer.length < paramCount + FOUR_WAY_REQUEST_OVERHEAD) {
        throw new FourWayFrameError('truncated', 'NotEnoughDataError');
    }

    const request: FourWayRequest = {
        command: buffer[1] as number,
        address: ((buffer[2] as number) << 8) | (buffer[3] as number),
        checksum: ((buffer[5 + paramCount] as number) << 8) | (buffer[6 + paramCount] as number),
        params: buffer.slice(5, 5 + paramCount)
    };

    const checksum = crc16Xmodem(buffer, 0, 5 + paramCount);
    if (checksum !== request.checksum) {
        throw new FourWayFrameError(
            'checksum',
            `checksum mismatch, received: ${request.checksum}, calculated: ${checksum}`
        );
    }

    return request;
}
