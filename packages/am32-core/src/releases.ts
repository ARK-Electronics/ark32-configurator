/**
 * The firmware release-asset naming convention, as one shared module.
 *
 * The CI in the firmware repo emits `AM32_<FILE_NAME>_<MAJOR.MINOR[-tag]>.hex`
 * (ARK32 `Makefile:10,162`, asserted by its "Assert hex naming convention" CI
 * step), and an ESC names itself with the same `FILE_NAME` in the 32 bytes
 * below its EEPROM. Matching the two is how both clients decide which asset
 * fits the board in front of them, so the rule lives here and nowhere else:
 * the web flash dialog and `ark32 flash --release` must never drift apart on
 * it (issue #3 section 4 predicted exactly that drift, as "every user sees
 * NOT FOUND with no other symptom").
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
 * The version segment a release *tag* implies: `v3.0-ark` -> `3.0-ark`,
 * `v2.18-rc3` -> `2.18`. A tag that does not carry a version -- the rolling
 * `nightly` prerelease -- comes back unchanged, which is why exact-name
 * matching built from a tag cannot work there and {@link findFirmwareAsset}
 * matches on the name prefix instead.
 */
export function firmwareVersionFromTag (tag: string): string {
    const version = /^v\d/i.test(tag) ? tag.slice(1) : tag;
    return version.replace(/-rc\d*$/i, '');
}

/** The exact asset name a version tag resolves to for one ESC's `FILE_NAME`. */
export function firmwareAssetName (fileName: string, tag: string): string {
    return `AM32_${fileName}_${firmwareVersionFromTag(tag)}.hex`;
}

export interface NamedAsset {
    name: string
}

/**
 * The version segment as it appears in an asset name. Anchored on the leading
 * `MAJOR.MINOR` digits so that a `FILE_NAME` which extends another
 * (`ARK_4IN1_F051` / hypothetical `ARK_4IN1_F051_HV`) can never match the
 * longer board's asset through the shorter board's prefix.
 */
const ASSET_VERSION = /^\d+\.\d+(-[A-Za-z0-9._-]+)?\.hex$/;

/**
 * The one asset in `assets` built for `fileName`, or null.
 *
 * Null covers both nothing-matched and more-than-one-matched: two versions of
 * one target inside a single release means the release itself is malformed,
 * and guessing between them is how the wrong image gets flashed.
 */
export function findFirmwareAsset<T extends NamedAsset> (
    assets: readonly T[],
    fileName: string
): T | null {
    const prefix = `AM32_${fileName}_`;
    const matches = assets.filter(asset => asset.name.startsWith(prefix) &&
        ASSET_VERSION.test(asset.name.slice(prefix.length)));
    return matches.length === 1 ? (matches[0] as T) : null;
}
