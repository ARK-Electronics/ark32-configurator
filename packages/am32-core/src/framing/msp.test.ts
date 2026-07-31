import { describe, expect, it } from 'vitest';
import {
    MSP_COMMANDS,
    MspFrameError,
    MspParser,
    crc8DvbS2Data,
    encodeMspCommand,
    encodeMspV1,
    encodeMspV2,
    isCompleteMspFrame,
    isMspRequest,
    mspFrameLength,
    parseMspResponse
} from './msp';

/**
 * Golden vectors are byte sequences produced by an independent implementation
 * of the spec in Betaflight `src/main/msp/msp_serial.c` and ArduPilot
 * `libraries/AP_MSP/msp.cpp`, not by the code under test.
 *
 * The four cases in `audit D` are the four ways `@am32/serial-msp`'s parser was
 * wrong. Each is annotated with what the old parser did.
 */

const bytes = (...values: number[]) => Uint8Array.from(values);

/** The `reason` of the MspFrameError `fn` throws, or undefined if it does not. */
const reasonOf = (fn: () => unknown) => {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error instanceof MspFrameError ? error.reason : undefined;
    }
};

describe('crc8 DVB-S2', () => {
    it('matches the published check value', () => {
        // Poly 0xD5, init 0. CRC of the ASCII string "123456789".
        expect(crc8DvbS2Data(new TextEncoder().encode('123456789'))).toBe(0xBC);
    });

    it('is zero over an empty range', () => {
        expect(crc8DvbS2Data(bytes(1, 2, 3), 1, 1)).toBe(0);
    });
});

describe('MSP v1 encode', () => {
    it('encodes a zero-payload request', () => {
        expect(Array.from(encodeMspV1(MSP_COMMANDS.MSP_API_VERSION)))
            .toEqual([0x24, 0x4D, 0x3C, 0x00, 0x01, 0x01]);
    });

    it('encodes MSP_SET_PASSTHROUGH', () => {
        expect(Array.from(encodeMspCommand(MSP_COMMANDS.MSP_SET_PASSTHROUGH)))
            .toEqual([0x24, 0x4D, 0x3C, 0x00, 0xF5, 0xF5]);
    });

    it('checksums the size, command and payload but not the header', () => {
        const frame = encodeMspV1(MSP_COMMANDS.MSP_SET_MOTOR, bytes(0x10, 0x20));
        expect(Array.from(frame)).toEqual([0x24, 0x4D, 0x3C, 0x02, 0xD6, 0x10, 0x20, 0xE4]);
    });

    it('refuses a command that does not fit one byte', () => {
        expect(() => encodeMspV1(MSP_COMMANDS.MSP2_SEND_DSHOT_COMMAND)).toThrow(MspFrameError);
    });

    it('picks v2 for commands above 254', () => {
        const frame = encodeMspCommand(MSP_COMMANDS.MSP2_SEND_DSHOT_COMMAND, bytes(1, 2));
        expect(Array.from(frame))
            .toEqual([0x24, 0x58, 0x3C, 0x00, 0x03, 0x30, 0x02, 0x00, 0x01, 0x02, 0x73]);
    });
});

describe('MSP v1 parse', () => {
    it('parses a response and returns its payload', () => {
        const frame = bytes(0x24, 0x4D, 0x3E, 0x03, 0x01, 0x00, 0x01, 0x2E, 0x2D);
        const parsed = parseMspResponse(frame, { expectCommand: MSP_COMMANDS.MSP_API_VERSION });
        expect(parsed.version).toBe(1);
        expect(parsed.direction).toBe('response');
        expect(parsed.command).toBe(MSP_COMMANDS.MSP_API_VERSION);
        expect(Array.from(parsed.payload)).toEqual([0x00, 0x01, 0x2E]);
    });

    it('parses the passthrough reply that carries the ESC count', () => {
        const frame = bytes(0x24, 0x4D, 0x3E, 0x01, 0xF5, 0x04, 0xF0);
        const parsed = parseMspResponse(frame, { expectCommand: MSP_COMMANDS.MSP_SET_PASSTHROUGH });
        expect(Array.from(parsed.payload)).toEqual([4]);
    });

    it('rejects a bad checksum', () => {
        const frame = bytes(0x24, 0x4D, 0x3E, 0x01, 0xF5, 0x04, 0xF1);
        expect(() => parseMspResponse(frame)).toThrow(MspFrameError);
        expect(reasonOf(() => parseMspResponse(frame))).toBe('checksum');
    });

    it('rejects a truncated frame rather than returning a short payload', () => {
        const frame = bytes(0x24, 0x4D, 0x3E, 0x03, 0x01, 0x00);
        expect(() => parseMspResponse(frame)).toThrow(MspFrameError);
    });

    it('round-trips every encodable v1 payload length below jumbo', () => {
        for (const length of [0, 1, 2, 63, 192, 253, 254]) {
            const payload = Uint8Array.from({ length }, (_, i) => (i * 7) & 0xFF);
            const frame = encodeMspV1(MSP_COMMANDS.MSP_MOTOR, payload, 'response');
            const parsed = parseMspResponse(frame, { expectCommand: MSP_COMMANDS.MSP_MOTOR });
            expect(Array.from(parsed.payload)).toEqual(Array.from(payload));
        }
    });
});

describe('MSP v2 parse', () => {
    it('parses a v2 response with a 16-bit little-endian command', () => {
        const frame = bytes(0x24, 0x58, 0x3E, 0x00, 0x03, 0x30, 0x01, 0x00, 0xAA, 0xB6);
        const parsed = parseMspResponse(frame, { expectCommand: 0x3003 });
        expect(parsed.version).toBe(2);
        expect(parsed.command).toBe(0x3003);
        expect(Array.from(parsed.payload)).toEqual([0xAA]);
    });

    it('rejects a bad v2 crc', () => {
        const frame = bytes(0x24, 0x58, 0x3E, 0x00, 0x03, 0x30, 0x01, 0x00, 0xAA, 0xB7);
        expect(() => parseMspResponse(frame)).toThrow(MspFrameError);
        expect(reasonOf(() => parseMspResponse(frame))).toBe('checksum');
    });

    it('carries the flags byte through', () => {
        const frame = encodeMspV2(0x3003, bytes(1), 'response', 0x01);
        expect(parseMspResponse(frame).flags).toBe(0x01);
    });

    it('round-trips a payload longer than a v1 frame can express', () => {
        const payload = Uint8Array.from({ length: 700 }, (_, i) => i & 0xFF);
        const frame = encodeMspV2(0x3003, payload, 'response');
        expect(frame.length).toBe(709);
        expect(Array.from(parseMspResponse(frame).payload)).toEqual(Array.from(payload));
    });
});

describe('audit D: what the old parser got wrong', () => {
    it('parses $X v2 frames instead of dropping them silently', () => {
        // The old parser's state machine only accepted 'M' at state 1, so every
        // v2 frame fell through and parseMspResponse returned undefined -- yet
        // the packet-boundary probe accepted it as complete, so the caller saw
        // a satisfied probe and an undefined answer.
        const frame = bytes(0x24, 0x58, 0x3E, 0x00, 0x03, 0x30, 0x01, 0x00, 0xAA, 0xB6);
        expect(isCompleteMspFrame(frame)).toBe(true);
        expect(parseMspResponse(frame).command).toBe(0x3003);
    });

    it('rejects a v1 error frame rather than parsing it as data', () => {
        // The old state 2 accepted '<', '>' and '!' identically, so $M! parsed
        // as a successful reply with an empty payload.
        const frame = bytes(0x24, 0x4D, 0x21, 0x00, 0x01, 0x01);
        expect(() => parseMspResponse(frame, { expectCommand: MSP_COMMANDS.MSP_API_VERSION }))
            .toThrow(/error frame/);
        try {
            parseMspResponse(frame);
        } catch (error) {
            expect((error as MspFrameError).reason).toBe('error-frame');
        }
    });

    it('rejects a v2 error frame too', () => {
        const frame = bytes(0x24, 0x58, 0x21, 0x00, 0x03, 0x30, 0x00, 0x00, 0xE4);
        expect(() => parseMspResponse(frame)).toThrow(/error frame/);
    });

    it('can be told to accept an error frame explicitly', () => {
        const frame = bytes(0x24, 0x4D, 0x21, 0x00, 0x01, 0x01);
        const parsed = parseMspResponse(frame, { allowErrorFrames: true });
        expect(parsed.direction).toBe('error');
        expect(parsed.command).toBe(MSP_COMMANDS.MSP_API_VERSION);
    });

    it('rejects a reply whose command is not the one we sent', () => {
        // ArduPilot answers a failed MSP_SET_PASSTHROUGH with the command field
        // set to 0x0F (ACK_D_GENERAL_ERROR leaking out of the 4-way enum) --
        // AP_BLHeli.cpp:593-595. The old parser returned it as the answer.
        const frame = bytes(0x24, 0x4D, 0x3E, 0x00, 0x0F, 0x0F);
        expect(() => parseMspResponse(frame, { expectCommand: MSP_COMMANDS.MSP_SET_PASSTHROUGH }))
            .toThrow(/echo mismatch/);
    });

    it('picks the matching reply out of a stream that also carries a pushed frame', () => {
        // The FC pushes unsolicited '>' frames of its own accord
        // (msp_serial.c:646-672), so first-frame-wins is not good enough.
        const pushed = encodeMspV1(MSP_COMMANDS.MSP_STATUS, bytes(9), 'response');
        const answer = encodeMspV1(MSP_COMMANDS.MSP_FC_VARIANT, bytes(0x41, 0x52), 'response');
        const stream = new Uint8Array([...pushed, ...answer]);
        const parsed = parseMspResponse(stream, { expectCommand: MSP_COMMANDS.MSP_FC_VARIANT });
        expect(Array.from(parsed.payload)).toEqual([0x41, 0x52]);
    });

    it('handles a v1 jumbo frame instead of mis-reading its length', () => {
        // Size 255 means "a 16-bit little-endian length follows the command",
        // and the checksum covers the 0xFF marker and both length bytes
        // (msp_serial.c:336-355). The old parser read 0xFF as the payload
        // length and then consumed the length bytes as payload.
        const payload = Uint8Array.from({ length: 255 }, (_, i) => i & 0xFF);
        const frame = encodeMspV1(MSP_COMMANDS.MSP_FC_VARIANT, payload, 'response');

        expect(Array.from(frame.subarray(0, 8)))
            .toEqual([0x24, 0x4D, 0x3E, 0xFF, 0x02, 0xFF, 0x00, 0x00]);
        expect(frame.length).toBe(263);
        expect(frame[frame.length - 1]).toBe(0xFD);

        const parsed = parseMspResponse(frame, { expectCommand: MSP_COMMANDS.MSP_FC_VARIANT });
        expect(Array.from(parsed.payload)).toEqual(Array.from(payload));
    });

    it('does not treat a 254-byte payload as jumbo', () => {
        const frame = encodeMspV1(MSP_COMMANDS.MSP_FC_VARIANT, new Uint8Array(254), 'response');
        expect(frame[3]).toBe(254);
        expect(frame.length).toBe(260);
    });
});

describe('frame completeness probe', () => {
    it('waits for the whole v1 frame', () => {
        const frame = bytes(0x24, 0x4D, 0x3E, 0x03, 0x01, 0x00, 0x01, 0x2E, 0x2D);
        for (let i = 0; i < frame.length; i += 1) {
            expect(isCompleteMspFrame(frame.subarray(0, i))).toBe(false);
        }
        expect(isCompleteMspFrame(frame)).toBe(true);
    });

    it('waits for the whole v2 frame', () => {
        const frame = bytes(0x24, 0x58, 0x3E, 0x00, 0x03, 0x30, 0x01, 0x00, 0xAA, 0xB6);
        for (let i = 0; i < frame.length; i += 1) {
            expect(isCompleteMspFrame(frame.subarray(0, i))).toBe(false);
        }
        expect(isCompleteMspFrame(frame)).toBe(true);
    });

    it('waits for the whole jumbo frame', () => {
        const frame = encodeMspV1(MSP_COMMANDS.MSP_FC_VARIANT, new Uint8Array(255), 'response');
        expect(isCompleteMspFrame(frame.subarray(0, 6))).toBe(false);
        expect(isCompleteMspFrame(frame.subarray(0, frame.length - 1))).toBe(false);
        expect(isCompleteMspFrame(frame)).toBe(true);
    });

    it('is satisfied by the first of two back-to-back frames', () => {
        // The old probe tested for length equality, so a second frame arriving
        // in the same chunk left the exchange waiting for a timeout. That is
        // why this one uses >=.
        const first = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(1), 'response');
        const second = encodeMspV1(MSP_COMMANDS.MSP_STATUS, bytes(2, 3), 'response');
        const both = new Uint8Array([...first, ...second]);
        expect(isCompleteMspFrame(both)).toBe(true);
        expect(parseMspResponse(both, { expectCommand: MSP_COMMANDS.MSP_STATUS }).command)
            .toBe(MSP_COMMANDS.MSP_STATUS);
    });

    it('rejects non-MSP bytes', () => {
        expect(isCompleteMspFrame(bytes(0x2E, 0x37, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00))).toBe(false);
        expect(isCompleteMspFrame(bytes(0x24, 0x4E, 0x3E, 0x00, 0x00, 0x00))).toBe(false);
    });

    it('tells a request header from a response header', () => {
        expect(isMspRequest(encodeMspCommand(MSP_COMMANDS.MSP_API_VERSION))).toBe(true);
        expect(isMspRequest(encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, new Uint8Array(), 'response'))).toBe(false);
    });
});

describe('streaming parser', () => {
    it('assembles a frame split across chunks', () => {
        const frame = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(0, 1, 46), 'response');
        const parser = new MspParser();
        expect(parser.push(frame.subarray(0, 4))).toEqual([]);
        expect(parser.push(frame.subarray(4, 6))).toEqual([]);
        const frames = parser.push(frame.subarray(6));
        expect(frames.length).toBe(1);
        expect(Array.from(frames[0]!.payload)).toEqual([0, 1, 46]);
    });

    it('yields several frames from one chunk', () => {
        const a = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(1), 'response');
        const b = encodeMspV2(0x3003, bytes(2), 'response');
        const frames = new MspParser().push(new Uint8Array([...a, ...b]));
        expect(frames.map(f => f.command)).toEqual([MSP_COMMANDS.MSP_API_VERSION, 0x3003]);
    });

    it('resynchronises after leading garbage', () => {
        const frame = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(7), 'response');
        const noisy = new Uint8Array([0x00, 0xFF, 0x24, 0x24, 0x4D, 0x99, ...frame]);
        const frames = new MspParser().push(noisy);
        expect(frames.length).toBe(1);
        expect(Array.from(frames[0]!.payload)).toEqual([7]);
    });

    it('drops a corrupt frame and still finds the next good one', () => {
        const bad = encodeMspV1(MSP_COMMANDS.MSP_STATUS, bytes(1, 2, 3), 'response');
        bad[bad.length - 1] ^= 0xFF;
        const good = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(4), 'response');
        const parser = new MspParser();
        const frames = parser.push(new Uint8Array([...bad, ...good]));
        expect(parser.checksumErrors).toBe(1);
        expect(frames.map(f => f.command)).toEqual([MSP_COMMANDS.MSP_API_VERSION]);
    });

    it('discards garbage that cannot start a frame instead of accumulating it', () => {
        const parser = new MspParser();
        for (let i = 0; i < 100; i += 1) {
            expect(parser.push(bytes(0x01, 0x02, 0x03, 0x04))).toEqual([]);
        }
        // A frame arriving after 400 bytes of noise still parses, and nothing
        // ahead of it is prepended to its payload.
        const frame = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(3), 'response');
        const frames = parser.push(frame);
        expect(frames.length).toBe(1);
        expect(Array.from(frames[0]!.payload)).toEqual([3]);
    });

    it('keeps a trailing $ that might begin the next frame', () => {
        const parser = new MspParser();
        const frame = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(5), 'response');
        expect(parser.push(new Uint8Array([0xAA, ...frame.subarray(0, 1)]))).toEqual([]);
        const frames = parser.push(frame.subarray(1));
        expect(frames.length).toBe(1);
        expect(Array.from(frames[0]!.payload)).toEqual([5]);
    });

    it('does not leak state between resets', () => {
        const parser = new MspParser();
        parser.push(bytes(0x24, 0x4D, 0x3E, 0x05));
        parser.reset();
        const frame = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, bytes(1), 'response');
        expect(parser.push(frame).length).toBe(1);
    });
});

/**
 * `mspFrameLength` became public in block 3: `am32-sim`'s `SimFc` has to act as
 * the flight controller, and knowing how many bytes one frame occupies is the
 * one piece of the parser it cannot do without. Exported rather than duplicated.
 */
describe('mspFrameLength', () => {
    it('returns null until the header is complete', () => {
        const frame = encodeMspV1(MSP_COMMANDS.MSP_API_VERSION, new Uint8Array([1, 2, 3]));

        expect(mspFrameLength(frame.slice(0, 2))).toBeNull();
        expect(mspFrameLength(frame.slice(0, 3))).toBeNull();
        expect(mspFrameLength(frame.slice(0, 4))).toBe(frame.length);
    });

    it('agrees with the encoders for v1, jumbo v1 and v2', () => {
        const v1 = encodeMspV1(MSP_COMMANDS.MSP_MOTOR, new Uint8Array(16));
        expect(mspFrameLength(v1)).toBe(v1.length);

        const jumbo = encodeMspV1(MSP_COMMANDS.MSP_MOTOR, new Uint8Array(300));
        expect(mspFrameLength(jumbo.slice(0, 6))).toBeNull();
        expect(mspFrameLength(jumbo)).toBe(jumbo.length);

        const v2 = encodeMspV2(MSP_COMMANDS.MSP2_SEND_DSHOT_COMMAND, new Uint8Array(5));
        expect(mspFrameLength(v2.slice(0, 7))).toBeNull();
        expect(mspFrameLength(v2)).toBe(v2.length);
    });

    it('returns null for a magic byte that is neither M nor X', () => {
        expect(mspFrameLength(Uint8Array.from([0x24, 0x59, 0x3C, 0x00]))).toBeNull();
    });
});
