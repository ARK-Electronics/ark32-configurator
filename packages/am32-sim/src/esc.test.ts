/**
 * `SimEsc`'s memory model -- the half of the simulator that has to be right for
 * blocks 4 and 6 to mean anything.
 *
 * Everything asserted here is a firmware behaviour a naive simulator gets wrong,
 * and getting it wrong would make the settings-write and flash tests pass
 * against a model that real silicon does not match.
 */

import { describe, expect, it } from 'vitest';
import { EEPROM_SIZE, EepromLayout } from 'am32-core/eeprom/layout';
import { decodeSettings, encodeSettings } from 'am32-core/eeprom/codec';
import { Link } from 'am32-core/link/link';
import { DEFAULT_TIMEOUT_POLICY } from 'am32-core/link/timeout-policy';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse
} from 'am32-core/framing/fourway';
import {
    ADDRESS_MAGIC_CONTINUE,
    ADDRESS_MAGIC_EEPROM,
    ADDRESS_MAGIC_FILE_NAME,
    SimEsc
} from './esc';
import { createSimHarness } from './harness';

describe('SimEsc: the flash and EEPROM model', () => {
    it('holds a plausible v3 image with the firmware name below the EEPROM', () => {
        const esc = new SimEsc();

        expect(esc.eepromOffset).toBe(0x7C00);
        expect(esc.pageSize).toBe(1024);
        expect(esc.eeprom).toHaveLength(EEPROM_SIZE);
        expect(esc.eeprom[EepromLayout.LAYOUT_REVISION.offset]).toBe(3);

        const name = esc.peek(esc.eepromOffset - 32, 32);
        expect(String.fromCharCode(...name.slice(0, name.indexOf(0)))).toBe('ARK_4IN1_F051');
    });

    it('erases the page only when the write is page-aligned', () => {
        // `save_flash_nolib` erases at a page boundary and nowhere else
        // (Mcu/f051/Src/eeprom.c:35-44). That is what lets the host stream four
        // 256-byte chunks into one 1024-byte page, and it means an out-of-order
        // write lands in an unerased page.
        const esc = new SimEsc();
        esc.connect();
        const page = 0x2000;

        esc.setAddress(page);
        esc.setBuffer(new Uint8Array(256).fill(0xAA));
        expect(esc.programFlash().ack).toBe('ok');

        esc.setAddress(page + 256);
        esc.setBuffer(new Uint8Array(256).fill(0xBB));
        expect(esc.programFlash().ack).toBe('ok');

        expect(esc.peek(page, 1)[0]).toBe(0xAA);
        expect(esc.peek(page + 256, 1)[0]).toBe(0xBB);

        // Re-writing the aligned start erases the whole page, taking the second
        // chunk with it.
        esc.setAddress(page);
        esc.setBuffer(new Uint8Array(256).fill(0xCC));
        expect(esc.programFlash().ack).toBe('ok');
        expect(esc.peek(page + 256, 1)[0]).toBe(0xFF);
    });

    it('fails a non-aligned write into an already-programmed page, like real flash', () => {
        // Programming can only clear bits, so the bootloader's memcmp verify
        // fails and it answers brERRORCOMMAND (Mcu/f051/Src/eeprom.c:62).
        const esc = new SimEsc();
        esc.connect();

        esc.setAddress(0x2000);
        esc.setBuffer(new Uint8Array(256).fill(0x00));
        expect(esc.programFlash().ack).toBe('ok');

        // 0x2010 is inside the 256 bytes just programmed and is not a page
        // boundary, so nothing is erased first and the 0x00 -> 0xFF transition
        // is impossible.
        esc.setAddress(0x2010);
        esc.setBuffer(new Uint8Array(16).fill(0xFF));
        expect(esc.programFlash().ack).toBe('error');
    });

    it('has cmd_ERASE_FLASH ACK without erasing anything', () => {
        // AM32's CMD_ERASE_FLASH is a stub (bootloader/main.c:613-629). A page
        // erase that reports success while doing nothing is the single most
        // misleading thing in this protocol.
        const esc = new SimEsc();
        esc.connect();
        esc.setAddress(0x2000);
        esc.setBuffer(new Uint8Array(4).fill(0x11));
        esc.programFlash();

        esc.setAddress(0x2000);
        expect(esc.erasePage().ack).toBe('ok');

        expect(Array.from(esc.peek(0x2000, 4))).toEqual([0x11, 0x11, 0x11, 0x11]);
    });

    it('stamps its own version over payload byte 2 of an EEPROM write', () => {
        // bootloader/main.c:517-525. BOOT_LOADER_REVISION therefore never
        // round-trips, so a settings write cannot be verified by comparing the
        // whole image byte for byte -- block 6 has to skip byte 2.
        const esc = new SimEsc({ bootloaderVersion: 18 });
        esc.connect();
        const image = new Uint8Array(EEPROM_SIZE).fill(0x00);
        image[2] = 0x99;

        esc.setAddress(esc.eepromOffset);
        esc.setBuffer(image);
        expect(esc.programFlash().ack).toBe('ok');

        expect(esc.eeprom[2]).toBe(18);
    });

    it('zeroes the address pointer after a read, so 0xFFFF cannot work', () => {
        // bootloader/main.c:667-669, "ensure client sends a SET_ADDRESS each
        // time". The 4-way `0xFFFF` keep-the-address idiom is a BLHeli-ism that
        // AM32 does not honour.
        const esc = new SimEsc();
        esc.connect();

        esc.setAddress(esc.eepromOffset);
        expect(esc.read(4).ack).toBe('ok');
        expect(esc.read(4).ack).toBe('error');

        esc.setAddress(esc.eepromOffset);
        expect(esc.read(4).ack).toBe('ok');
    });

    it('refuses a reserved address below 1024 and a write below the application start', () => {
        const esc = new SimEsc();
        esc.connect();

        // Reserved: below 1024 and not one of the three magic values (BL:563-566).
        expect(esc.setAddress(0x0100).ack).toBe('error');

        esc.setAddress(0x0800);
        expect(esc.programFlash().ack).toBe('error');
    });

    it('resolves the three magic addresses, which are AM32\'s answer to 0xFFFF', () => {
        // BL:220-226 and :553-562. `ADDRESS_MAGIC_CONTINUE` restores the end of
        // the previous read, which is how a large EEPROM read is split into
        // chunks without a fresh SET_ADDRESS each time.
        const esc = new SimEsc();
        esc.connect();

        esc.setAddress(ADDRESS_MAGIC_FILE_NAME);
        const name = esc.read(32);
        expect(name.ack).toBe('ok');
        expect(String.fromCharCode(...name.data.slice(0, name.data.indexOf(0)))).toBe('ARK_4IN1_F051');

        esc.setAddress(ADDRESS_MAGIC_EEPROM);
        const head = esc.read(4);
        expect(head.ack).toBe('ok');
        expect(Array.from(head.data)).toEqual(Array.from(esc.eeprom.slice(0, 4)));

        // The read zeroed the pointer, so only CONTINUE can pick up where it
        // left off.
        esc.setAddress(ADDRESS_MAGIC_CONTINUE);
        const rest = esc.read(4);
        expect(rest.ack).toBe('ok');
        expect(Array.from(rest.data)).toEqual(Array.from(esc.eeprom.slice(4, 8)));
    });
});

describe('fault knob: esc[n].canBlock', () => {
    it('defaults to the audit\'s reproduction, the two bytes that broke the string round-trip', () => {
        const esc = new SimEsc();

        // can_node = 32 is a space, which `.trim()` deleted and shifted the
        // whole block left; filter_hz = 200 is invalid UTF-8, which decoded to
        // U+FFFD and re-encoded as 253. Both are audit item A.
        expect(Array.from(esc.canBlock)).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
        expect(Array.from(esc.eeprom.slice(176, 184))).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
    });

    it('survives a decode/encode round-trip through the core codec, byte for byte', () => {
        const esc = new SimEsc();
        esc.canBlock = [0x20, 0x07, 0x01, 0x0A, 0x01, 0xC8, 0x00, 0x01];
        const original = esc.eeprom;

        const layoutRevision = original[EepromLayout.LAYOUT_REVISION.offset] as number;
        const settings = decodeSettings(original, layoutRevision);
        const encoded = encodeSettings(original, settings, layoutRevision);

        expect(Array.from(encoded)).toEqual(Array.from(original));
        expect(Array.from(encoded.slice(176, 184))).toEqual([0x20, 0x07, 0x01, 0x0A, 0x01, 0xC8, 0x00, 0x01]);
        // Bytes 13-16 are `reserved_eeprom_3`, zeroed to 0xFF by the old
        // 0xFF-fill encoder. They are non-trivial in the simulator's image on
        // purpose, so that failure cannot hide behind a zero.
        expect(Array.from(encoded.slice(13, 17))).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
    });

    it('is what the host reads back over 4-way, unchanged', async () => {
        const h = createSimHarness({ profile: 'ardupilot', escCount: 1 });
        h.fc.mavlinkIdleGate = 0;
        await h.open();
        const link = new Link(h.transport, { clock: h.clock });
        const policy = DEFAULT_TIMEOUT_POLICY.withVariant('ardupilot');

        h.escs[0]!.canBlock = [12, 3, 0, 20, 0, 0xC8, 2, 1];

        const exchange = async (command: FOUR_WAY_COMMANDS, params: number[], address: number, bytes = 0) => {
            const settled = link.request(encodeFourWayRequest(command, params, address), {
                probe: isCompleteFourWayFrame,
                timeout: policy.forFourWay(command, bytes || params.length),
                retries: 2,
                label: FOUR_WAY_COMMANDS[command] ?? String(command)
            }).then(response => parseFourWayResponse(response));
            await h.clock.runAll();
            return settled;
        };

        await exchange(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [0], 0);
        const read = await exchange(
            FOUR_WAY_COMMANDS.cmd_DeviceRead,
            [EEPROM_SIZE],
            h.escs[0]!.eepromOffset,
            EEPROM_SIZE
        );

        expect(read.ack).toBe(FOUR_WAY_ACK.ACK_OK);
        expect(Array.from(read.params.slice(176, 184))).toEqual([12, 3, 0, 20, 0, 0xC8, 2, 1]);
    });

    it('rejects anything that is not the eight live CAN bytes', () => {
        const esc = new SimEsc();
        expect(() => {
            esc.canBlock = [1, 2, 3];
        }).toThrow(/eight live CAN bytes/);
    });
});
