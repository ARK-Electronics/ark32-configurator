/**
 * The firmware release-asset naming convention, as one shared module.
 *
 * The CI in the firmware repo emits
 * `ARK32_<FILE_NAME>_<MAJOR.MINOR[.PATCH][-tag]>.hex` (ARK32 Makefile
 * `IDENTIFIER` + the "Assert hex naming convention" CI step). Examples:
 * `ARK32_ARK_4IN1_F051_3.0.3.hex` (current ship),
 * `ARK32_ARK_4IN1_F051_3.0.2-ark.hex` (older ARK32_ builds). Releases
 * through `v3.0.2-ark` used the upstream `AM32_` prefix instead
 * (`AM32_ARK_4IN1_F051_3.0.2-ark.hex`). An ESC names itself with the same
 * `FILE_NAME` in the 32 bytes below its EEPROM. Matching the two is how
 * both clients decide which asset fits the board in front of them, so the
 * rule lives here and nowhere else: the web flash dialog and
 * `ark32 flash --release` must never drift apart on it (issue #3 section 4
 * predicted exactly that drift, as "every user sees NOT FOUND with no
 * other symptom").
 *
 * Nothing here fetches. The web app lists releases through its server proxy
 * (`server/utils/github-files.ts`, CORS constrains the browser); the CLI asks
 * the GitHub API directly (CORS constrains nothing else). Both hand their
 * asset lists to these functions.
 */

/** Where the firmware releases live, absent an override. */
export const DEFAULT_FIRMWARE_OWNER = 'ARK-Electronics';
export const DEFAULT_FIRMWARE_REPO = 'ARK32';

/**
 * Prefix of every published app hex/bin/elf (`IDENTIFIER` in the ARK32 Makefile).
 * Not the bootloader product names under `Bootloaders/AM32_*`.
 */
export const FIRMWARE_ASSET_PREFIX = 'ARK32';

/**
 * Prefix used by ARK32 GitHub releases through `v3.0.2-ark`, before
 * `IDENTIFIER` became `ARK32`. {@link findFirmwareAsset} still accepts it
 * so older catalog entries keep resolving.
 */
export const LEGACY_FIRMWARE_ASSET_PREFIX = 'AM32';

const ASSET_PREFIXES = [FIRMWARE_ASSET_PREFIX, LEGACY_FIRMWARE_ASSET_PREFIX] as const;

/**
 * The version segment a release *tag* implies: `v3.0.3` -> `3.0.3`,
 * `v3.0.2-ark` -> `3.0.2-ark`, `v2.18-rc3` -> `2.18`. A tag that does not
 * carry a version -- the rolling `nightly` prerelease -- comes back
 * unchanged, which is why exact-name matching built from a tag cannot work
 * there and {@link findFirmwareAsset} matches on the name prefix instead.
 */
export function firmwareVersionFromTag (tag: string): string {
    const version = /^v\d/i.test(tag) ? tag.slice(1) : tag;
    return version.replace(/-rc\d*$/i, '');
}

/** The exact asset name a version tag resolves to for one ESC's `FILE_NAME`. */
export function firmwareAssetName (fileName: string, tag: string): string {
    return `${FIRMWARE_ASSET_PREFIX}_${fileName}_${firmwareVersionFromTag(tag)}.hex`;
}

export interface NamedAsset {
    name: string
}

/**
 * The version segment as it appears in an asset name.
 *
 * Accepts `MAJOR.MINOR`, optional `.PATCH`, and an optional `-<tag>` suffix
 * (current ship is `3.0.3`; older ARK tags were `3.0.2-ark`). The tag may
 * not contain dots, so `3.0.2-ark.factory.hex` cannot pass as an app hex.
 * Anchored so a `FILE_NAME` which extends another (`ARK_4IN1_F051` /
 * hypothetical `ARK_4IN1_F051_HV`) can never match the longer board's
 * asset through the shorter board's prefix. Sidecars (`.factory.hex`,
 * `.eeprom.bin`, `.bin`) fail this test on purpose -- field flash is the
 * app hex only.
 */
const ASSET_VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9][A-Za-z0-9_-]*)?\.hex$/;

function assetsForPrefix<T extends NamedAsset> (
    assets: readonly T[],
    prefix: string,
    fileName: string
): T[] {
    const head = `${prefix}_${fileName}_`;
    return assets.filter(asset => asset.name.startsWith(head) &&
        ASSET_VERSION.test(asset.name.slice(head.length)));
}

/**
 * The one asset in `assets` built for `fileName`, or null.
 *
 * Tries {@link FIRMWARE_ASSET_PREFIX} first, then
 * {@link LEGACY_FIRMWARE_ASSET_PREFIX}. Null covers both nothing-matched
 * and more-than-one-matched: two versions of one target inside a single
 * release means the release itself is malformed, and guessing between them
 * is how the wrong image gets flashed.
 */
export function findFirmwareAsset<T extends NamedAsset> (
    assets: readonly T[],
    fileName: string
): T | null {
    for (const prefix of ASSET_PREFIXES) {
        const matches = assetsForPrefix(assets, prefix, fileName);
        if (matches.length === 1) {
            return matches[0] as T;
        }
        if (matches.length > 1) {
            return null;
        }
    }
    return null;
}
