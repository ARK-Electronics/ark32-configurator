/**
 * The two string conversions the protocol needs.
 *
 * `TextDecoder` is not available here: the core tsconfig omits the `dom` lib and
 * sets `types: []`, so the name does not exist. That is deliberate (issue #3
 * section 7.1) and it is fine, because nothing on the wire is UTF-8 --
 * `MSP_FC_VARIANT` is four raw ASCII bytes and the AM32 firmware name is a
 * NUL-terminated byte string. Decoding either as UTF-8 is how audit item **A**
 * started.
 */

/**
 * Bytes to a string, one byte to one code point (latin-1). No validation and no
 * replacement characters: a byte that is not printable ASCII stays exactly the
 * number it was, so a caller can still tell garbage from a name.
 */
export function decodeBytes (bytes: ArrayLike<number>, start = 0, end = bytes.length): string {
    let out = '';
    for (let i = start; i < end; i += 1) {
        out += String.fromCharCode((bytes[i] as number) & 0xFF);
    }
    return out;
}

/**
 * Decode up to the first NUL, or the whole buffer when there is none.
 *
 * The app's version was `slice(0, params.indexOf(0))`, which silently dropped
 * the last byte when the buffer had no NUL at all (`indexOf` returns -1 and
 * `slice(0, -1)` trims). Fixed here.
 */
export function decodeBytesZ (bytes: Uint8Array): string {
    const nul = bytes.indexOf(0);
    return decodeBytes(bytes, 0, nul < 0 ? bytes.length : nul);
}
