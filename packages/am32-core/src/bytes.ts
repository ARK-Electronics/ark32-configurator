/**
 * Byte-array comparison, in one place.
 *
 * `compare()` from the app's `utils/` (deleted in block 5) plus what read-back
 * verification needs: not just *whether* two images differ but *where*, so a
 * failure names a byte instead of shrugging. An exemption set is part of the
 * comparison rather than something a caller filters afterwards, because there is
 * exactly one exempt byte on the write path and forgetting it turns every
 * verified settings write into a failure on real hardware.
 */

/** Byte-for-byte equality, length included. */
export function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Index of the first byte that differs, ignoring `exempt`, or null when they
 * match. A length mismatch reports the first index past the shorter array.
 */
export function firstDifference (
    expected: Uint8Array,
    actual: Uint8Array,
    exempt?: ReadonlySet<number>
): number | null {
    const common = Math.min(expected.length, actual.length);
    for (let i = 0; i < common; i += 1) {
        if (expected[i] !== actual[i] && !exempt?.has(i)) {
            return i;
        }
    }
    return expected.length === actual.length ? null : common;
}

/** How many bytes differ, ignoring `exempt`. For the "3 of 192" in a message. */
export function countDifferences (
    expected: Uint8Array,
    actual: Uint8Array,
    exempt?: ReadonlySet<number>
): number {
    let count = Math.abs(expected.length - actual.length);
    const common = Math.min(expected.length, actual.length);
    for (let i = 0; i < common; i += 1) {
        if (expected[i] !== actual[i] && !exempt?.has(i)) {
            count += 1;
        }
    }
    return count;
}
