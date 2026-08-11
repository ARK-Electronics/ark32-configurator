import { describe, expect, it } from 'vitest';
import {
    formatEscFirmwareVersion,
    parseFirmwareNameRegion
} from './firmware-version';

function region (parts: string[]): Uint8Array {
    const out = new Uint8Array(32).fill(0xFF);
    let at = 0;
    for (const part of parts) {
        for (let i = 0; i < part.length && at < 31; i += 1, at += 1) {
            out[at] = part.charCodeAt(i);
        }
        if (at < 32) {
            out[at] = 0;
            at += 1;
        }
    }
    return out;
}

describe('parseFirmwareNameRegion', () => {
    it('reads a legacy name-only region', () => {
        expect(parseFirmwareNameRegion(region(['ARK_4IN1_F051']))).toEqual({
            fileName: 'ARK_4IN1_F051',
            firmwareVersion: null
        });
    });

    it('reads FILE_NAME plus an embedded ship version after the first NUL', () => {
        expect(parseFirmwareNameRegion(region(['ARK_4IN1_F051', '3.0.2-ark']))).toEqual({
            fileName: 'ARK_4IN1_F051',
            firmwareVersion: '3.0.2-ark'
        });
    });

    it('accepts major.minor without a patch', () => {
        expect(parseFirmwareNameRegion(region(['ARK_4IN1_F051', '3.0-ark']))).toEqual({
            fileName: 'ARK_4IN1_F051',
            firmwareVersion: '3.0-ark'
        });
    });

    it('rejects an erased or empty region', () => {
        expect(parseFirmwareNameRegion(new Uint8Array(32).fill(0xFF))).toEqual({
            fileName: null,
            firmwareVersion: null
        });
        expect(parseFirmwareNameRegion(new Uint8Array(32).fill(0))).toEqual({
            fileName: null,
            firmwareVersion: null
        });
    });

    it('ignores a second string that is not a version', () => {
        expect(parseFirmwareNameRegion(region(['ARK_4IN1_F051', 'not-a-version']))).toEqual({
            fileName: 'ARK_4IN1_F051',
            firmwareVersion: null
        });
    });
});

describe('formatEscFirmwareVersion', () => {
    it('prefers the embedded ship version', () => {
        expect(formatEscFirmwareVersion(
            { MAIN_REVISION: 3, SUB_REVISION: 0 },
            '3.0.2-ark'
        )).toBe('3.0.2-ark');
    });

    it('falls back to major.minor without zero-padding', () => {
        expect(formatEscFirmwareVersion({ MAIN_REVISION: 3, SUB_REVISION: 0 })).toBe('3.0');
        expect(formatEscFirmwareVersion({ MAIN_REVISION: 2, SUB_REVISION: 20 })).toBe('2.20');
    });

    it('returns ? when neither source is usable', () => {
        expect(formatEscFirmwareVersion({})).toBe('?');
        expect(formatEscFirmwareVersion({ MAIN_REVISION: 3, SUB_REVISION: 0 }, 'bogus')).toBe('3.0');
    });
});
