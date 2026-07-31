/**
 * MSP framing: v1 (including jumbo), v2 native, encode and streaming parse.
 *
 * Reimplemented from the firmware rather than ported from `@am32/serial-msp`,
 * whose parser was broken four ways (audit item D in issue #3): it dropped v2
 * frames silently, accepted `!` error frames as data, never checked the command
 * echo, and could not handle jumbo lengths.
 *
 * Verified against:
 *   - Betaflight `src/main/msp/msp_serial.c:325-355` (v1 + jumbo encode),
 *     `:393-403` (v2 encode), `:124-291` (RX state machine),
 *     `src/main/common/crc.c:63-74` (crc8 DVB-S2).
 *   - ArduPilot `libraries/AP_MSP/msp.cpp:51-139`,
 *     `libraries/AP_BLHeli/AP_BLHeli.cpp:195-245` (the v1-only handler that
 *     actually answers us on the passthrough port),
 *     `libraries/AP_Math/crc.cpp:106-135`.
 */

export enum MSP_COMMANDS {
    MSP_API_VERSION = 1,
    MSP_FC_VARIANT = 2,
    MSP_FC_VERSION = 3,
    MSP_BOARD_INFO = 4,
    MSP_BUILD_INFO = 5,
    MSP_FEATURE_CONFIG = 36,
    MSP_MOTOR_3D_CONFIG = 124,
    MSP_BATTERY_STATE = 130,
    MSP_SET_MOTOR = 214,
    MSP_SET_PASSTHROUGH = 245,
    MSP_IDENT = 100,
    MSP_STATUS = 101,
    MSP_MOTOR = 104,
    MSP_MOTOR_CONFIG = 131,
    MSP_SET_3D = 217,
    MSP_UID = 160,
    MSP2_SEND_DSHOT_COMMAND = 12291,
}

const DOLLAR = 0x24; // '$'
const MAGIC_V1 = 0x4D; // 'M'
const MAGIC_V2 = 0x58; // 'X'
const DIR_REQUEST = 0x3C; // '<'
const DIR_RESPONSE = 0x3E; // '>'
const DIR_ERROR = 0x21; // '!'

/**
 * A v1 size byte of 255 means "16-bit length follows the command byte".
 * Betaflight switches to jumbo at `dataLen >= 255`, not `> 255`
 * (`msp_serial.c:342`), so a payload of exactly 255 is already jumbo.
 */
export const MSP_JUMBO_FRAME_SIZE_LIMIT = 255;

/** Highest command id that fits v1's single command byte. */
export const MSP_V1_MAX_COMMAND = 254;

export type MspVersion = 1 | 2;
export type MspDirection = 'request' | 'response' | 'error';

export interface MspFrame {
    version: MspVersion;
    direction: MspDirection;
    command: number;
    /** v2 flags byte; always 0 for v1 frames, which have no such field. */
    flags: number;
    payload: Uint8Array;
}

export type MspFrameErrorReason =
    | 'malformed'
    | 'checksum'
    /** The FC answered `$M!` / `$X!` -- a valid frame reporting a failure. */
    | 'error-frame'
    /** The reply's command field is not the command we sent. */
    | 'echo'
    | 'incomplete';

export class MspFrameError extends Error {
    readonly reason: MspFrameErrorReason;
    readonly frame?: MspFrame;

    constructor (reason: MspFrameErrorReason, message: string, frame?: MspFrame) {
        super(message);
        this.name = 'MspFrameError';
        this.reason = reason;
        this.frame = frame;
    }
}

/**
 * crc8 DVB-S2: poly 0xD5, init 0, no reflection, no final xor.
 * Betaflight `common/crc.c:63-74`, ArduPilot `AP_Math/crc.cpp:112-123`.
 */
export function crc8DvbS2Data (data: ArrayLike<number>, start = 0, end = data.length): number {
    let crc = 0;
    for (let i = start; i < end; i += 1) {
        crc ^= (data[i] as number) & 0xFF;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x80) ? (((crc << 1) & 0xFF) ^ 0xD5) : ((crc << 1) & 0xFF);
        }
    }
    return crc;
}

/** MSP v1 checksum: XOR of the size byte, the command byte and the payload. */
function xorChecksum (data: ArrayLike<number>, start: number, end: number): number {
    let checksum = 0;
    for (let i = start; i < end; i += 1) {
        checksum ^= (data[i] as number) & 0xFF;
    }
    return checksum & 0xFF;
}

function directionChar (direction: MspDirection): number {
    switch (direction) {
    case 'request': return DIR_REQUEST;
    case 'response': return DIR_RESPONSE;
    case 'error': return DIR_ERROR;
    }
}

function directionFromChar (char: number): MspDirection | null {
    switch (char) {
    case DIR_REQUEST: return 'request';
    case DIR_RESPONSE: return 'response';
    case DIR_ERROR: return 'error';
    default: return null;
    }
}

/**
 * Encode an MSP v1 frame. Payloads of 255 bytes or more are emitted as jumbo
 * frames: size 0xFF, then the command, then a little-endian 16-bit length. The
 * checksum covers the 0xFF marker and both length bytes
 * (`msp_serial.c:336-355`).
 *
 * Note that neither Betaflight nor ArduPilot can *decode* a jumbo frame on a
 * serial port -- both reject any size above the 192-byte input buffer before
 * they look at the 0xFF marker (`msp_serial.c:184-186`, `AP_BLHeli.cpp:221`).
 * Jumbo therefore only ever arrives in the RX direction, and only from
 * telemetry-shared transports. We encode it for completeness and symmetry.
 */
export function encodeMspV1 (
    command: number,
    data: Uint8Array = new Uint8Array(),
    direction: MspDirection = 'request'
): Uint8Array {
    if (command < 0 || command > MSP_V1_MAX_COMMAND) {
        throw new MspFrameError('malformed', `command ${command} does not fit an MSP v1 frame`);
    }

    const jumbo = data.length >= MSP_JUMBO_FRAME_SIZE_LIMIT;
    const headerLength = jumbo ? 7 : 5;
    const frame = new Uint8Array(headerLength + data.length + 1);

    frame[0] = DOLLAR;
    frame[1] = MAGIC_V1;
    frame[2] = directionChar(direction);

    if (jumbo) {
        frame[3] = MSP_JUMBO_FRAME_SIZE_LIMIT;
        frame[4] = command;
        frame[5] = data.length & 0xFF;
        frame[6] = (data.length >> 8) & 0xFF;
    } else {
        frame[3] = data.length;
        frame[4] = command;
    }

    frame.set(data, headerLength);
    frame[frame.length - 1] = xorChecksum(frame, 3, frame.length - 1);

    return frame;
}

/**
 * Encode an MSP v2 native frame. Command and payload length are both 16-bit
 * little-endian; the crc8 DVB-S2 covers the five header bytes plus the payload
 * (`msp_serial.c:393-403`).
 */
export function encodeMspV2 (
    command: number,
    data: Uint8Array = new Uint8Array(),
    direction: MspDirection = 'request',
    flags = 0
): Uint8Array {
    const frame = new Uint8Array(9 + data.length);

    frame[0] = DOLLAR;
    frame[1] = MAGIC_V2;
    frame[2] = directionChar(direction);
    frame[3] = flags & 0xFF;
    frame[4] = command & 0xFF;
    frame[5] = (command >> 8) & 0xFF;
    frame[6] = data.length & 0xFF;
    frame[7] = (data.length >> 8) & 0xFF;
    frame.set(data, 8);
    frame[frame.length - 1] = crc8DvbS2Data(frame, 3, frame.length - 1);

    return frame;
}

/**
 * Encode a request, choosing the version the command id requires.
 *
 * ArduPilot's BLHeli passthrough handler is v1-only (`AP_BLHeli.cpp:195-245`),
 * so everything the configurator sends today goes out as v1.
 */
export function encodeMspCommand (command: number, data: Uint8Array = new Uint8Array()): Uint8Array {
    return command <= MSP_V1_MAX_COMMAND ? encodeMspV1(command, data) : encodeMspV2(command, data);
}

/**
 * Total frame length implied by a buffer's header, or null while the header is
 * still incomplete.
 *
 * Exported because a frame *parser* -- `am32-sim`'s `SimFc`, which has to act as
 * the flight controller -- needs to know how many bytes to consume, and the
 * alternative is a second implementation of MSP length arithmetic.
 */
export function mspFrameLength (buffer: Uint8Array): number | null {
    if (buffer.length < 3) {
        return null;
    }

    if (buffer[1] === MAGIC_V1) {
        if (buffer.length < 4) {
            return null;
        }
        if (buffer[3] !== MSP_JUMBO_FRAME_SIZE_LIMIT) {
            return (buffer[3] as number) + 6;
        }
        if (buffer.length < 7) {
            return null;
        }
        return ((buffer[5] as number) | ((buffer[6] as number) << 8)) + 8;
    }

    if (buffer[1] === MAGIC_V2) {
        if (buffer.length < 8) {
            return null;
        }
        return ((buffer[6] as number) | ((buffer[7] as number) << 8)) + 9;
    }

    return null;
}

/**
 * Structural completeness probe: true once `buffer` holds at least one whole
 * frame. Says nothing about the checksum or the direction -- the link layer
 * uses it only to decide when to stop waiting for more bytes.
 */
export function isCompleteMspFrame (buffer: Uint8Array): boolean {
    if (buffer.length < 3 || buffer[0] !== DOLLAR || directionFromChar(buffer[2] as number) === null) {
        return false;
    }
    const length = mspFrameLength(buffer);
    return length !== null && buffer.length >= length;
}

/** True if `buffer` starts with a well-formed MSP request header. */
export function isMspRequest (buffer: Uint8Array): boolean {
    return buffer.length >= 3 &&
        buffer[0] === DOLLAR &&
        (buffer[1] === MAGIC_V1 || buffer[1] === MAGIC_V2) &&
        buffer[2] === DIR_REQUEST;
}

/**
 * Decode one frame that is known to start at index 0 and to be complete.
 * Throws {@link MspFrameError} with reason `checksum` on a bad checksum.
 */
function decodeFrame (buffer: Uint8Array, length: number): MspFrame {
    const direction = directionFromChar(buffer[2] as number) as MspDirection;

    if (buffer[1] === MAGIC_V1) {
        const jumbo = buffer[3] === MSP_JUMBO_FRAME_SIZE_LIMIT;
        const headerLength = jumbo ? 7 : 5;
        const expected = xorChecksum(buffer, 3, length - 1);
        if (expected !== buffer[length - 1]) {
            throw new MspFrameError(
                'checksum',
                `MSP v1 checksum mismatch: received ${buffer[length - 1]}, calculated ${expected}`
            );
        }
        return {
            version: 1,
            direction,
            command: buffer[4] as number,
            flags: 0,
            payload: buffer.slice(headerLength, length - 1)
        };
    }

    const expected = crc8DvbS2Data(buffer, 3, length - 1);
    if (expected !== buffer[length - 1]) {
        throw new MspFrameError(
            'checksum',
            `MSP v2 crc mismatch: received ${buffer[length - 1]}, calculated ${expected}`
        );
    }
    return {
        version: 2,
        direction,
        command: (buffer[4] as number) | ((buffer[5] as number) << 8),
        flags: buffer[3] as number,
        payload: buffer.slice(8, length - 1)
    };
}

/**
 * Streaming MSP parser.
 *
 * Holds a byte buffer across chunks, resynchronises on garbage by dropping
 * bytes until a plausible `$` header appears, and yields every complete frame
 * it finds. A frame with a bad checksum is dropped and counted rather than
 * thrown, so one corrupt frame cannot stall the stream -- the caller sees a
 * timeout instead, which is what the retry policy already handles.
 */
export class MspParser {
    private buffer = new Uint8Array();

    /** Frames dropped because their checksum did not verify. */
    checksumErrors = 0;

    reset (): void {
        this.buffer = new Uint8Array();
        this.checksumErrors = 0;
    }

    push (chunk: Uint8Array): MspFrame[] {
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer, 0);
        merged.set(chunk, this.buffer.length);
        this.buffer = merged;

        const frames: MspFrame[] = [];

        for (;;) {
            const start = this.findHeader();
            if (start < 0) {
                // Nothing left that could begin a frame: drop it rather than
                // carrying garbage forward into the next chunk forever.
                this.buffer = new Uint8Array();
                return frames;
            }
            if (start > 0) {
                this.buffer = this.buffer.slice(start);
            }

            const length = mspFrameLength(this.buffer);
            if (length === null || this.buffer.length < length) {
                return frames;
            }

            try {
                frames.push(decodeFrame(this.buffer, length));
                this.buffer = this.buffer.slice(length);
            } catch (error) {
                if (error instanceof MspFrameError && error.reason === 'checksum') {
                    this.checksumErrors += 1;
                    // Drop the '$' so findHeader resynchronises past this frame.
                    this.buffer = this.buffer.slice(1);
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * Index of the first byte that could begin a frame, or -1. A `$` followed
     * by an unknown magic or direction byte is not a header.
     */
    private findHeader (): number {
        for (let i = 0; i < this.buffer.length; i += 1) {
            if (this.buffer[i] !== DOLLAR) {
                continue;
            }
            if (i + 1 >= this.buffer.length) {
                return i; // need more bytes to tell
            }
            if (this.buffer[i + 1] !== MAGIC_V1 && this.buffer[i + 1] !== MAGIC_V2) {
                continue;
            }
            if (i + 2 >= this.buffer.length) {
                return i;
            }
            if (directionFromChar(this.buffer[i + 2] as number) === null) {
                continue;
            }
            return i;
        }
        return -1;
    }
}

export interface ParseMspResponseOptions {
    /**
     * The command that was sent. When given, a reply carrying any other command
     * is rejected instead of being handed back as the answer.
     *
     * This matters: the FC pushes unsolicited `>` frames of its own accord
     * (`msp_serial.c:646-672`), and ArduPilot answers a failed
     * `MSP_SET_PASSTHROUGH` with the command field set to `0x0F`
     * (`AP_BLHeli.cpp:593-595`) rather than to 245.
     */
    expectCommand?: number;
    /**
     * Accept `$M!` / `$X!` frames as data instead of rejecting them.
     * Defaults to false; an error frame is a failure, not a reply.
     */
    allowErrorFrames?: boolean;
}

/**
 * Parse a single response out of `data`, applying the checks the old parser
 * lacked. Throws {@link MspFrameError} rather than returning undefined, so a
 * caller cannot mistake "no frame" for "empty payload".
 */
export function parseMspResponse (data: Uint8Array, options: ParseMspResponseOptions = {}): MspFrame {
    const parser = new MspParser();
    const frames = parser.push(data);

    if (frames.length === 0) {
        throw new MspFrameError(
            parser.checksumErrors > 0 ? 'checksum' : 'incomplete',
            parser.checksumErrors > 0 ? 'no MSP frame with a valid checksum' : 'no complete MSP frame'
        );
    }

    // Prefer a frame that answers the command we asked about; the FC may have
    // pushed telemetry frames ahead of the reply.
    const match = options.expectCommand === undefined
        ? frames[0] as MspFrame
        : frames.find(f => f.command === options.expectCommand) ?? frames[frames.length - 1] as MspFrame;

    if (match.direction === 'error' && !options.allowErrorFrames) {
        throw new MspFrameError('error-frame', `MSP command ${match.command} returned an error frame`, match);
    }

    if (options.expectCommand !== undefined && match.command !== options.expectCommand) {
        throw new MspFrameError(
            'echo',
            `MSP command echo mismatch: sent ${options.expectCommand}, received ${match.command}`,
            match
        );
    }

    return match;
}
