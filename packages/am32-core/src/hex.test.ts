import { describe, expect, it } from 'vitest';
import { fillImage, parseHex } from './hex';

/** Build one Intel HEX record with a correct checksum. */
const record = (type: number, address: number, data: number[]) => {
    const head = [data.length, (address >> 8) & 0xFF, address & 0xFF, type, ...data];
    const sum = (~head.reduce((a, b) => a + b, 0) + 1) & 0xFF;
    return ':' + [...head, sum].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
};

const EOF_RECORD = ':00000001FF';

describe('parseHex', () => {
    it('parses a data record and its end-of-file marker', () => {
        const hex = [record(0x00, 0x1000, [1, 2, 3, 4]), EOF_RECORD, ''].join('\n');
        const parsed = parseHex(hex);
        expect(parsed).not.toBeNull();
        expect(parsed!.endOfFile).toBe(true);
        expect(parsed!.bytes).toBe(4);
        expect(parsed!.data[0]!.address).toBe(0x1000);
        expect(parsed!.data[0]!.data).toEqual([1, 2, 3, 4]);
    });

    it('tolerates CRLF line endings', () => {
        const hex = [record(0x00, 0x1000, [0xAB]), EOF_RECORD, ''].join('\r\n');
        expect(parseHex(hex)!.data[0]!.data).toEqual([0xAB]);
    });

    it('applies an extended linear address record', () => {
        const hex = [record(0x04, 0, [0x08, 0x00]), record(0x00, 0x1000, [9]), EOF_RECORD, ''].join('\n');
        expect(parseHex(hex)!.data[0]!.address).toBe(0x08001000);
    });

    it('returns null on a checksum mismatch', () => {
        const good = record(0x00, 0x1000, [1, 2, 3, 4]);
        const bad = good.slice(0, -2) + '00';
        expect(parseHex([bad, EOF_RECORD, ''].join('\n'))).toBeNull();
    });

    it('returns null when the end-of-file record is missing', () => {
        expect(parseHex([record(0x00, 0x1000, [1]), ''].join('\n'))).toBeNull();
    });
});

describe('fillImage', () => {
    it('lays records into an image at flash-relative addresses', () => {
        const parsed = parseHex([record(0x04, 0, [0x08, 0x00]), record(0x00, 0x0004, [1, 2, 3, 4]), EOF_RECORD, ''].join('\n'))!;
        const image = fillImage(parsed, 16, 0x08000000)!;
        expect(image.length).toBe(16);
        expect(Array.from(image.subarray(0, 8))).toEqual([0xFF, 0xFF, 0xFF, 0xFF, 1, 2, 3, 4]);
    });

    it('returns null when a record addresses past the end of the image', () => {
        const parsed = parseHex([record(0x00, 0x0100, [1]), EOF_RECORD, ''].join('\n'))!;
        expect(fillImage(parsed, 16, 0)).toBeNull();
    });
});
