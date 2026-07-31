/**
 * Intel HEX parsing and flash-image filling.
 *
 * Moved out of the Nuxt app's `src/flash.ts` in block 1b, unchanged apart from
 * dropping the debug `console.log` calls -- the core has no logger and must not
 * write to one.
 */

export interface HexData {
    address: number;
    bytes: number;
    data: number[];
}

export interface Hex {
    data: HexData[];
    endOfFile: boolean;
    bytes: number;
    startLinearAddress: number;
}

/**
 * Lay the parsed records into a contiguous image.
 *
 * Returns null when a record addresses past the end of the image, which is how
 * a hex built for a different MCU is caught.
 */
export function fillImage (data: Hex, size: number, flashOffset: number, char?: number): Uint8Array | null {
    const image = new Uint8Array(size).fill(char ?? 0xFF);

    for (let i = 0; i < data.data.length; i += 1) {
        const block = data.data[i] as HexData;
        const address = block.address - flashOffset;

        if (address >= image.byteLength) {
            return null;
        }

        // block.data may be too large, select maximum allowed size
        const clampedLength = Math.min(block.bytes, image.byteLength - address);
        image.set(block.data.slice(0, clampedLength), address);
    }

    return image;
}

/**
 * Parse an Intel HEX file. Returns null on a checksum mismatch or a file with
 * no end-of-file record.
 */
export function parseHex (hexString: string): Hex | null {
    let string = hexString.split('\n');
    string = string.map(e => e.endsWith('\r') ? e.substring(0, e.length - 1) : e);

    // check if there is an empty line in the end of hex file, if there is, remove it
    if (string[string.length - 1] === '') {
        string.pop();
    }

    const result: Hex = {
        data: [],
        endOfFile: false,
        bytes: 0,
        startLinearAddress: 0
    };

    let extendedLinearAddress = 0;
    let nextAddress = 0;

    for (let i = 0; i < string.length; i += 1) {
        const line = string[i] as string;

        // each byte is represented by two chars
        const byteCount = parseInt(line.substr(1, 2), 16);
        const address = parseInt(line.substr(3, 4), 16);
        const recordType = parseInt(line.substr(7, 2), 16);
        const content = line.substr(9, byteCount * 2); // still in string format
        const checksum = parseInt(line.substr(9 + byteCount * 2, 2), 16); // (this is a 2's complement value)

        switch (recordType) {
        // data record
        case 0x00: {
            if (address !== nextAddress || nextAddress === 0) {
                result.data.push({
                    address: extendedLinearAddress + address,
                    bytes: 0,
                    data: []
                });
            }

            // store address for next comparison
            nextAddress = address + byteCount;

            // process data
            let crc = byteCount + parseInt(line.substr(3, 2), 16) + parseInt(line.substr(5, 2), 16) + recordType;
            for (let needle = 0; needle < byteCount * 2; needle += 2) { // * 2 because of 2 hex chars per 1 byte
                const num = parseInt(content.substr(needle, 2), 16); // get one byte in hex and convert it to decimal
                const stringBlock = result.data[result.data.length - 1] as HexData;

                stringBlock.data.push(num);
                stringBlock.bytes += 1;

                crc += num;
                result.bytes += 1;
            }

            // change crc to 2's complement
            crc = (~crc + 1) & 0xFF;

            // Return in case of fail
            if (crc !== checksum) {
                return null;
            }
        } break;

            // end of file record
        case 0x01:
            result.endOfFile = true;
            break;

            // extended segment address record
        case 0x02:
            if (parseInt(content, 16) !== 0) { // ignore if segment is 0
                throw new Error('extended segment address record found - NOT IMPLEMENTED!');
            }
            break;

            // start segment address record
        case 0x03:
            if (parseInt(content, 16) !== 0) { // ignore if segment is 0
                throw new Error('start segment address record found - NOT IMPLEMENTED!');
            }
            break;

            // extended linear address record
        case 0x04:
            extendedLinearAddress = (parseInt(content.substr(0, 2), 16) << 24) | (parseInt(content.substr(2, 2), 16) << 16);
            break;

            // start linear address record
        case 0x05:
            result.startLinearAddress = parseInt(content, 16);
            break;

        default:
            // Unknown record type: ignored, as before.
            break;
        }
    }

    if (result.endOfFile) {
        return result;
    }

    return null;
}
