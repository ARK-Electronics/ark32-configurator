import { describe, expect, it } from 'vitest';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    FOUR_WAY_LOCAL_ESCAPE,
    FOUR_WAY_MAX_PARAMS,
    FOUR_WAY_REMOTE_ESCAPE,
    FourWayFrameError,
    crc16Xmodem,
    crc16XmodemUpdate,
    encodeFourWayRequest,
    encodeFourWayResponse,
    isCompleteFourWayFrame,
    isCompleteFourWayRequest,
    parseFourWayRequest,
    parseFourWayResponse
} from './fourway';

/**
 * Golden vectors from an independent implementation of the spec in Betaflight
 * `src/main/io/serial_4way.c:457-495` / `:896-919` and ArduPilot
 * `libraries/AP_BLHeli/AP_BLHeli.cpp:258-303` / `:610-623`.
 */

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('CRC-16/XMODEM', () => {
    it('matches the published check value', () => {
        // The standard check value for CRC-16/XMODEM over "123456789".
        expect(crc16Xmodem(new TextEncoder().encode('123456789'))).toBe(0x31C3);
    });

    it('starts from zero and folds byte by byte', () => {
        expect(crc16XmodemUpdate(0, 0x00)).toBe(0x0000);
        expect(crc16Xmodem(bytes(0x2F, 0x37, 0x00, 0x00, 0x01, 0x00))).toBe(0xA800);
    });
});

describe('request encoding', () => {
    it('encodes cmd_DeviceInitFlash for target 0', () => {
        expect(Array.from(encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [0], 0)))
            .toEqual([0x2F, 0x37, 0x00, 0x00, 0x01, 0x00, 0xA8, 0x00]);
    });

    it('encodes a read of 8 bytes at the F051 eeprom offset', () => {
        expect(Array.from(encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [8], 0x7C00)))
            .toEqual([0x2F, 0x3A, 0x7C, 0x00, 0x01, 0x08, 0x05, 0x35]);
    });

    it('encodes cmd_InterfaceExit', () => {
        expect(Array.from(encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceExit)))
            .toEqual([0x2F, 0x34, 0x00, 0x00, 0x01, 0x00, 0x46, 0xD2]);
    });

    it('sends the address big-endian', () => {
        const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [1], 0x1234);
        expect(frame[2]).toBe(0x12);
        expect(frame[3]).toBe(0x34);
    });

    it('substitutes a single zero param for an empty list', () => {
        // Both firmwares require at least one param, and a count of 0 means 256.
        const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, []);
        expect(frame[4]).toBe(1);
        expect(frame[5]).toBe(0);
    });

    it('does not mutate the caller\'s param array', () => {
        const params: number[] = [];
        encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, params);
        expect(params).toEqual([]);
    });

    it('encodes 256 params as a count byte of 0', () => {
        const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceWrite, new Uint8Array(256), 0x1000);
        expect(frame[4]).toBe(0);
        expect(frame.length).toBe(263);
        expect(frame[261]).toBe(0x7E);
        expect(frame[262]).toBe(0x91);
    });

    it('refuses more than 256 params', () => {
        expect(() => encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceWrite, new Uint8Array(257)))
            .toThrow(FourWayFrameError);
    });

    it('uses the documented escape bytes', () => {
        expect(FOUR_WAY_LOCAL_ESCAPE).toBe(0x2F);
        expect(FOUR_WAY_REMOTE_ESCAPE).toBe(0x2E);
        expect(FOUR_WAY_MAX_PARAMS).toBe(256);
    });
});

describe('response parsing', () => {
    it('parses an init-flash reply carrying the device signature', () => {
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x04, 0x06, 0x1F, 0x33, 0x04, 0x00, 0x11, 0x0C);
        const response = parseFourWayResponse(frame);
        expect(response.command).toBe(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash);
        expect(response.ack).toBe(FOUR_WAY_ACK.ACK_OK);
        expect(Array.from(response.params)).toEqual([0x06, 0x1F, 0x33, 0x04]);
        expect(response.checksum).toBe(0x110C);
    });

    it('parses an 8-byte read reply and its big-endian address', () => {
        const frame = bytes(
            0x2E, 0x3A, 0x7C, 0x00, 0x08,
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x00, 0xAD, 0x55
        );
        const response = parseFourWayResponse(frame);
        expect(response.address).toBe(0x7C00);
        expect(Array.from(response.params)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('reports a non-OK ACK as data, not as a framing error', () => {
        // ArduPilot rejects a channel above num_motors with
        // ACK_I_INVALID_CHANNEL and one param byte (AP_BLHeli.cpp:1057-1062).
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x01, 0x00, 0x08, 0x0D, 0x8B);
        const response = parseFourWayResponse(frame);
        expect(response.ack).toBe(FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
    });

    it('includes the ACK byte in the checksum', () => {
        // Flipping only the ACK must invalidate the frame: the CRC covers
        // everything except its own two bytes (AP_BLHeli.cpp:620, `len + 6`).
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x01, 0x00, 0x08, 0x0D, 0x8B);
        frame[6] = FOUR_WAY_ACK.ACK_OK;
        expect(() => parseFourWayResponse(frame)).toThrow(/checksum mismatch/);
    });

    it('round-trips 256 params, where the count byte is 0', () => {
        const params = Uint8Array.from({ length: 256 }, (_, i) => i & 0xFF);
        const head = [0x2E, FOUR_WAY_COMMANDS.cmd_DeviceRead, 0x10, 0x00, 0x00, ...params, FOUR_WAY_ACK.ACK_OK];
        const crc = crc16Xmodem(head);
        const frame = Uint8Array.from([...head, (crc >> 8) & 0xFF, crc & 0xFF]);

        expect(frame.length).toBe(264);
        const response = parseFourWayResponse(frame);
        expect(response.params.length).toBe(256);
        expect(Array.from(response.params)).toEqual(Array.from(params));
    });

    it('round-trips the 192-byte settings exchange this block introduced', () => {
        // The settings read went from 184 to 192 bytes (the whole EEprom_t), so
        // these are the two frames every enumerate and every save now puts on
        // the wire. Both fit the FCs' 256-param buffers.
        const params = Array.from({ length: 192 }, (_, i) => (i * 3) & 0xFF);

        const read = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [192], 0x7C00);
        expect(Array.from(read)).toEqual([0x2F, 0x3A, 0x7C, 0x00, 0x01, 192, 0x5D, 0x71]);

        const write = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceWrite, params, 0x7C00);
        expect(write.length).toBe(199);
        expect(write[4]).toBe(192);
        expect([write[197], write[198]]).toEqual([0x3E, 0xDF]);

        const response = Uint8Array.from([
            0x2E, 0x3A, 0x7C, 0x00, 192, ...params, FOUR_WAY_ACK.ACK_OK, 0x4B, 0x05
        ]);
        expect(response.length).toBe(200);
        expect(isCompleteFourWayFrame(response)).toBe(true);
        expect(Array.from(parseFourWayResponse(response).params)).toEqual(params);
    });

    it('needs 264 bytes before it will parse a frame claiming 256 params', () => {
        // The count byte is 0, so a naive length check reads it as "no params"
        // and parses eight bytes of garbage as a complete frame.
        const short = new Uint8Array(100);
        short[0] = 0x2E;
        short[4] = 0x00;
        expect(() => parseFourWayResponse(short)).toThrow(/NotEnoughDataError/);
    });

    it('copies the params out of the frame buffer', () => {
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x04, 0x06, 0x1F, 0x33, 0x04, 0x00, 0x11, 0x0C);
        const response = parseFourWayResponse(frame);
        response.params[0] = 0xFF;
        expect(frame[5]).toBe(0x06);
    });
});

describe('malformed frames', () => {
    it('rejects a request start byte in the response position', () => {
        const frame = bytes(0x2F, 0x37, 0x00, 0x00, 0x01, 0x00, 0xA8, 0x00, 0x00);
        expect(() => parseFourWayResponse(frame)).toThrow(/invalid message start/);
    });

    it('rejects an empty buffer', () => {
        expect(() => parseFourWayResponse(new Uint8Array())).toThrow(FourWayFrameError);
    });

    it('rejects a frame shorter than the minimum', () => {
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00);
        expect(() => parseFourWayResponse(frame)).toThrow(/NotEnoughDataError/);
    });

    it('rejects a frame that stops short of its declared param count', () => {
        const frame = bytes(0x2E, 0x3A, 0x00, 0x00, 0x08, 1, 2, 3, 4, 0x00, 0x00, 0x00);
        expect(() => parseFourWayResponse(frame)).toThrow(/NotEnoughDataError/);
    });

    it('rejects a corrupt checksum', () => {
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x04, 0x06, 0x1F, 0x33, 0x04, 0x00, 0x11, 0x0D);
        expect(() => parseFourWayResponse(frame)).toThrow(/checksum mismatch/);
    });

    it('reports why it failed', () => {
        try {
            parseFourWayResponse(bytes(0x2E, 0x37, 0x00, 0x00, 0x04, 0x06, 0x1F, 0x33, 0x04, 0x00, 0x11, 0x0D));
        } catch (error) {
            expect((error as FourWayFrameError).reason).toBe('checksum');
        }
    });
});

describe('completeness probe', () => {
    it('waits for the whole frame', () => {
        const frame = bytes(0x2E, 0x37, 0x00, 0x00, 0x04, 0x06, 0x1F, 0x33, 0x04, 0x00, 0x11, 0x0C);
        for (let i = 0; i < frame.length; i += 1) {
            expect(isCompleteFourWayFrame(frame.subarray(0, i))).toBe(false);
        }
        expect(isCompleteFourWayFrame(frame)).toBe(true);
    });

    it('expands a param count of 0 to 256 before deciding', () => {
        const partial = new Uint8Array(200);
        partial[0] = 0x2E;
        partial[4] = 0x00;
        expect(isCompleteFourWayFrame(partial)).toBe(false);
        expect(isCompleteFourWayFrame(new Uint8Array(264).fill(0).map((_, i) => (i === 0 ? 0x2E : 0)))).toBe(true);
    });

    it('rejects an MSP frame', () => {
        expect(isCompleteFourWayFrame(bytes(0x24, 0x4D, 0x3E, 0x01, 0xF5, 0x04, 0xF0, 0x00))).toBe(false);
    });
});

describe('the ACK enum', () => {
    it('matches the firmware values', () => {
        // Betaflight serial_4way.c:268-279; ArduPilot blheli_4way_protocol.h:158-164.
        expect(FOUR_WAY_ACK.ACK_OK).toBe(0x00);
        expect(FOUR_WAY_ACK.ACK_I_UNKNOWN_ERROR).toBe(0x01);
        expect(FOUR_WAY_ACK.ACK_I_INVALID_CMD).toBe(0x02);
        expect(FOUR_WAY_ACK.ACK_I_INVALID_CRC).toBe(0x03);
        expect(FOUR_WAY_ACK.ACK_I_VERIFY_ERROR).toBe(0x04);
        expect(FOUR_WAY_ACK.ACK_D_INVALID_COMMAND).toBe(0x05);
        expect(FOUR_WAY_ACK.ACK_D_COMMAND_FAILED).toBe(0x06);
        expect(FOUR_WAY_ACK.ACK_D_UNKNOWN_ERROR).toBe(0x07);
        expect(FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL).toBe(0x08);
        expect(FOUR_WAY_ACK.ACK_I_INVALID_PARAM).toBe(0x09);
        expect(FOUR_WAY_ACK.ACK_D_GENERAL_ERROR).toBe(0x0F);
    });

    it('matches the firmware command values', () => {
        expect(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive).toBe(0x30);
        expect(FOUR_WAY_COMMANDS.cmd_InterfaceExit).toBe(0x34);
        expect(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash).toBe(0x37);
        expect(FOUR_WAY_COMMANDS.cmd_DeviceRead).toBe(0x3A);
        expect(FOUR_WAY_COMMANDS.cmd_DeviceWrite).toBe(0x3B);
        expect(FOUR_WAY_COMMANDS.cmd_DeviceVerify).toBe(0x40);
    });
});

/**
 * The FC's half of the framing, added in block 3 so `am32-sim` acts as a flight
 * controller through the same code the host parses with, rather than through a
 * second implementation that could agree only with itself.
 */
describe('the FC side: encodeFourWayResponse', () => {
    it('round-trips through parseFourWayResponse with the ACK and address intact', () => {
        const frame = encodeFourWayResponse(
            FOUR_WAY_COMMANDS.cmd_DeviceInitFlash,
            [0x06, 0x1F, 0x32, 0x04],
            FOUR_WAY_ACK.ACK_OK,
            0x7C00
        );

        expect(frame[0]).toBe(FOUR_WAY_REMOTE_ESCAPE);
        expect(frame).toHaveLength(4 + 8);
        expect(isCompleteFourWayFrame(frame)).toBe(true);

        const parsed = parseFourWayResponse(frame);
        expect(parsed.command).toBe(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash);
        expect(parsed.address).toBe(0x7C00);
        expect(parsed.ack).toBe(FOUR_WAY_ACK.ACK_OK);
        expect(Array.from(parsed.params)).toEqual([0x06, 0x1F, 0x32, 0x04]);
    });

    it('covers the ACK byte with the checksum but not the checksum itself', () => {
        const frame = encodeFourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [1, 2], FOUR_WAY_ACK.ACK_OK);
        const expected = crc16Xmodem(frame, 0, frame.length - 2);
        expect((frame[frame.length - 2] as number) << 8 | (frame[frame.length - 1] as number)).toBe(expected);

        // Flipping the ACK must invalidate the frame, or a non-OK reply could be
        // forged by a single-bit error on the wire.
        const tampered = frame.slice();
        tampered[tampered.length - 3] = FOUR_WAY_ACK.ACK_D_GENERAL_ERROR;
        expect(() => parseFourWayResponse(tampered)).toThrow(FourWayFrameError);
    });

    it('encodes 256 params as a length byte of zero, matching the request encoder', () => {
        const params = new Array(FOUR_WAY_MAX_PARAMS).fill(0xAB);
        const frame = encodeFourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, params);

        expect(frame[4]).toBe(0);
        expect(frame).toHaveLength(FOUR_WAY_MAX_PARAMS + 8);
        expect(parseFourWayResponse(frame).params).toHaveLength(FOUR_WAY_MAX_PARAMS);
    });

    it('rejects more params than a frame can carry', () => {
        expect(() => encodeFourWayResponse(
            FOUR_WAY_COMMANDS.cmd_DeviceRead,
            new Array(FOUR_WAY_MAX_PARAMS + 1).fill(0)
        )).toThrow(FourWayFrameError);
    });
});

describe('the FC side: parseFourWayRequest', () => {
    it('parses what encodeFourWayRequest produced', () => {
        const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceWrite, [9, 8, 7], 0x1234);

        expect(isCompleteFourWayRequest(frame)).toBe(true);
        const parsed = parseFourWayRequest(frame);
        expect(parsed.command).toBe(FOUR_WAY_COMMANDS.cmd_DeviceWrite);
        expect(parsed.address).toBe(0x1234);
        expect(Array.from(parsed.params)).toEqual([9, 8, 7]);
    });

    it('needs one byte fewer than a response, because there is no ACK', () => {
        const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, [0], 0);
        expect(frame).toHaveLength(8);
        expect(frame[0]).toBe(FOUR_WAY_LOCAL_ESCAPE);

        expect(isCompleteFourWayRequest(frame.slice(0, 7))).toBe(false);
        expect(isCompleteFourWayRequest(frame)).toBe(true);
    });

    it('reads a length byte of zero as 256 params', () => {
        const frame = encodeFourWayRequest(
            FOUR_WAY_COMMANDS.cmd_DeviceWrite,
            new Array(FOUR_WAY_MAX_PARAMS).fill(0x5A),
            0x2000
        );

        expect(frame[4]).toBe(0);
        expect(isCompleteFourWayRequest(frame.slice(0, frame.length - 1))).toBe(false);
        expect(parseFourWayRequest(frame).params).toHaveLength(FOUR_WAY_MAX_PARAMS);
    });

    it('rejects a bad start byte, a truncated frame and a bad checksum', () => {
        const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [192], 0x7C00);

        const wrongStart = frame.slice();
        wrongStart[0] = FOUR_WAY_REMOTE_ESCAPE;
        expect(() => parseFourWayRequest(wrongStart)).toThrow(/invalid message start/);

        expect(() => parseFourWayRequest(frame.slice(0, 5))).toThrow(/NotEnoughDataError/);

        const badCrc = frame.slice();
        badCrc[badCrc.length - 1] = (badCrc[badCrc.length - 1] as number) ^ 0xFF;
        expect(() => parseFourWayRequest(badCrc)).toThrow(/checksum mismatch/);
    });

    it('refuses to see a request in a response, and vice versa', () => {
        const request = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [192], 0x7C00);
        const response = encodeFourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [1], FOUR_WAY_ACK.ACK_OK);

        expect(isCompleteFourWayRequest(response)).toBe(false);
        expect(isCompleteFourWayFrame(request)).toBe(false);
    });
});
