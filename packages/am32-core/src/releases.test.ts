import { describe, expect, it } from 'vitest';
import { findFirmwareAsset, firmwareAssetName, firmwareVersionFromTag } from './releases';

/** Current ship-release asset list shape (unsuffixed patch-bearing ARK32 names). */
const NIGHTLY_ASSETS = [
    { name: 'ARK32_AM32REF_F051_3.0.3.hex' },
    { name: 'ARK32_ARK_4IN1_F051_3.0.3.hex' },
    { name: 'ARK32_REF_G431_3.0.3.hex' }
];

describe('firmwareVersionFromTag', () => {
    it('strips the leading v of a version tag', () => {
        expect(firmwareVersionFromTag('v3.0-ark')).toBe('3.0-ark');
        expect(firmwareVersionFromTag('v3.0.2-ark')).toBe('3.0.2-ark');
        expect(firmwareVersionFromTag('v3.0.3')).toBe('3.0.3');
        expect(firmwareVersionFromTag('V1.2')).toBe('1.2');
    });

    it('strips an -rc suffix, which never appears in the asset name', () => {
        expect(firmwareVersionFromTag('v2.18-rc3')).toBe('2.18');
        expect(firmwareVersionFromTag('v2.18-rc')).toBe('2.18');
    });

    it('leaves a versionless tag alone, rather than eating its first letter', () => {
        // `tag.substring(1)` on 'nightly' is how the flash dialog once got
        // 'ightly' and showed NOT FOUND for every board.
        expect(firmwareVersionFromTag('nightly')).toBe('nightly');
    });

    it('does not mistake a version suffix for an rc marker', () => {
        expect(firmwareVersionFromTag('v3.0-ark')).toBe('3.0-ark');
        expect(firmwareVersionFromTag('v3.0.2-ark')).toBe('3.0.2-ark');
        expect(firmwareVersionFromTag('v3.0.3')).toBe('3.0.3');
    });
});

describe('firmwareAssetName', () => {
    it('builds the exact CI artifact name for a version tag', () => {
        expect(firmwareAssetName('ARK_4IN1_F051', 'v3.0.3')).toBe('ARK32_ARK_4IN1_F051_3.0.3.hex');
        expect(firmwareAssetName('ARK_4IN1_F051', 'v3.0.2-ark')).toBe('ARK32_ARK_4IN1_F051_3.0.2-ark.hex');
        expect(firmwareAssetName('ARK_4IN1_F051', 'v3.0-ark')).toBe('ARK32_ARK_4IN1_F051_3.0-ark.hex');
    });
});

describe('findFirmwareAsset', () => {
    it('picks the one asset built for the board, whatever the tag says', () => {
        expect(findFirmwareAsset(NIGHTLY_ASSETS, 'ARK_4IN1_F051')?.name)
            .toBe('ARK32_ARK_4IN1_F051_3.0.3.hex');
        expect(findFirmwareAsset(NIGHTLY_ASSETS, 'REF_G431')?.name)
            .toBe('ARK32_REF_G431_3.0.3.hex');
    });

    it('matches a ship version with no -ark tag', () => {
        const assets = [
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.hex' }
        ];
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')?.name)
            .toBe('ARK32_ARK_4IN1_F051_3.0.3.hex');
    });

    it('matches major.minor without a patch (older ARK tags)', () => {
        const assets = [
            { name: 'ARK32_ARK_4IN1_F051_3.0-ark.hex' }
        ];
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')?.name)
            .toBe('ARK32_ARK_4IN1_F051_3.0-ark.hex');
    });

    it('matches legacy AM32_ assets from releases through v3.0.2-ark', () => {
        const assets = [
            { name: 'AM32_ARK_4IN1_F051_3.0.2-ark.hex' },
            { name: 'AM32_ARK_4IN1_F051_3.0.2-ark.factory.hex' }
        ];
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')?.name)
            .toBe('AM32_ARK_4IN1_F051_3.0.2-ark.hex');
    });

    it('prefers the current ARK32_ prefix when a release somehow has both', () => {
        const assets = [
            { name: 'AM32_ARK_4IN1_F051_3.0.2-ark.hex' },
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.hex' }
        ];
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')?.name)
            .toBe('ARK32_ARK_4IN1_F051_3.0.3.hex');
    });

    it('returns null when the release carries nothing for the board', () => {
        expect(findFirmwareAsset(NIGHTLY_ASSETS, 'NEOPIXEL_F421')).toBeNull();
    });

    it('cannot reach a longer board name through a shorter one\'s prefix', () => {
        const assets = [
            { name: 'ARK32_ARK_4IN1_F051_HV_3.0.3.hex' }
        ];
        // The remainder after `ARK32_ARK_4IN1_F051_` is `HV_3.0.3.hex`, which
        // is not a version -- so the short board must not claim it.
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')).toBeNull();
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051_HV')?.name)
            .toBe('ARK32_ARK_4IN1_F051_HV_3.0.3.hex');
    });

    it('refuses to guess between two versions of the same board', () => {
        const assets = [
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.hex' },
            { name: 'ARK32_ARK_4IN1_F051_2.20.hex' }
        ];
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')).toBeNull();
    });

    it('ignores sidecars, non-hex, and unrelated assets', () => {
        const assets = [
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.bin' },
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.factory.hex' },
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.eeprom.bin' },
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.zip' },
            { name: 'checksums.txt' },
            { name: 'ARK32_ARK_4IN1_F051_3.0.3.hex' }
        ];
        expect(findFirmwareAsset(assets, 'ARK_4IN1_F051')?.name)
            .toBe('ARK32_ARK_4IN1_F051_3.0.3.hex');
    });
});
