/**
 * The two write paths the Nuxt app needs from the session, end to end against a
 * simulated FC and its ESCs: `writeSettings` and `flash`.
 *
 * **Why these live in block 5 at all.** Block 4 deliberately left `writeSettings`
 * and `flash` out of `Am32Session` ("absent, not stubbed") and block 6 owns them.
 * But block 5 deletes `src/communication/*`, and it has to: a `SerialPort` can be
 * opened once, and two `Link`s over one transport would each have their own mutex,
 * so the legacy stack and the session cannot coexist on one port. The app's Save
 * and Flash buttons therefore have nowhere else to call. What lands here is a
 * behaviour-preserving *move* of the code the app already ran; what block 6 still
 * owns is read-back verification, `applyDefaults`, and reviewing the page range.
 *
 * The flash failure case is audit item **G**'s other half. The app's `startFlash`
 * had no try/catch, so a rejection left `escStore.activeTarget > -1`, which drives
 * `:prevent-close` on the modal -- the flash dialog wedged open with no error
 * shown. The UI fix is a `finally`; what makes it possible is the contract
 * asserted here: a failed flash **rejects**, promptly, with the channel named, and
 * leaves the session usable.
 */

import { describe, expect, it } from 'vitest';
import type { VirtualClock } from 'am32-core/clock';
import { EEPROM_SIZE, EepromLayout } from 'am32-core/eeprom/layout';
import { Mcu } from 'am32-core/mcu';
import { Am32Session } from 'am32-core/session';
import { SimEsc } from '../esc';
import { createSimHarness, type SimHarness, type SimHarnessOptions } from '../harness';

/** Copied from `session.test.ts`: advance the clock until `work` settles. */
async function drive<T> (clock: VirtualClock, work: Promise<T>): Promise<T> {
    const status = { settled: false };
    const tracked = work.then(
        (value) => {
            status.settled = true;
            return value;
        },
        (error: unknown) => {
            status.settled = true;
            throw error;
        }
    );
    tracked.catch(() => {});

    while (!status.settled) {
        const progressed = await clock.advanceToNextTimer();
        if (status.settled) {
            break;
        }
        if (!progressed) {
            throw new Error('drive: the virtual clock ran dry before the promise settled');
        }
    }
    return tracked;
}

interface Rig extends SimHarness {
    session: Am32Session;
    logs: string[];
}

function rig (options: SimHarnessOptions = {}): Rig {
    const harness = createSimHarness({ profile: 'betaflight', escCount: 1, ...options });
    const session = new Am32Session({ transport: harness.transport, clock: harness.clock });
    const logs: string[] = [];
    session.on('log', event => logs.push(`${event.level}: ${event.message}`));
    return { ...harness, session, logs };
}

/** Connect and get into passthrough, which is where both write paths start. */
async function inPassthrough (options: SimHarnessOptions = {}): Promise<Rig> {
    const h = rig(options);
    h.fc.mavlinkIdleGate = 0;
    await drive(h.clock, h.session.connect());
    await drive(h.clock, h.session.enterPassthrough());
    return h;
}

// ---- Intel HEX generation ----------------------------------------------------

const FLASH_OFFSET = 0x08000000;

function hexRecord (type: number, address: number, data: number[]): string {
    const bytes = [data.length, (address >> 8) & 0xFF, address & 0xFF, type, ...data];
    const sum = bytes.reduce((acc, b) => (acc + b) & 0xFF, 0);
    const checksum = (~sum + 1) & 0xFF;
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
    return `:${[...bytes, checksum].map(hex).join('')}`;
}

/**
 * Build a hex file out of `{ address, data }` blocks, flash-absolute.
 *
 * Deliberately produces the same shape a real AM32 build does -- one extended
 * linear address record for the 0x0800 high half-word, then 16-byte data records
 * in ascending order, then an end-of-file record -- because `parseHex` groups
 * records by contiguity and `fillImage` sizes the image from the last one.
 */
function intelHex (blocks: { address: number, data: number[] }[]): string {
    const lines = [hexRecord(0x04, 0, [(FLASH_OFFSET >> 24) & 0xFF, (FLASH_OFFSET >> 16) & 0xFF])];
    for (const block of blocks) {
        for (let at = 0; at < block.data.length; at += 16) {
            lines.push(hexRecord(
                0x00,
                (block.address - FLASH_OFFSET + at) & 0xFFFF,
                block.data.slice(at, at + 16)
            ));
        }
    }
    lines.push(hexRecord(0x01, 0, []));
    return lines.join('\n') + '\n';
}

/** The 32-byte firmware-name block the build puts just below the EEPROM page. */
function nameBlock (name: string): number[] {
    const bytes = new Array<number>(32).fill(0x00);
    for (let i = 0; i < name.length && i < 31; i += 1) {
        bytes[i] = name.charCodeAt(i) & 0xFF;
    }
    return bytes;
}

/**
 * A firmware image for the simulated F051: a recognisable body from the firmware
 * start, and the name block at `eepromOffset - 32`, which is where both the
 * bootloader and the hex put it.
 */
function firmwareHex (options: { name?: string, bodyBytes?: number } = {}): string {
    const mcu = new Mcu(0x1F06);
    const start = mcu.getFirmwareStart();
    const eeprom = mcu.getEepromOffset();
    const bodyBytes = options.bodyBytes ?? 512;
    const body = Array.from({ length: bodyBytes }, (_, i) => (i * 7) & 0xFE);
    return intelHex([
        { address: FLASH_OFFSET + start, data: body },
        { address: FLASH_OFFSET + eeprom - 32, data: nameBlock(options.name ?? 'ARK_4IN1_F051') }
    ]);
}

const firstEsc = (h: Rig): SimEsc => h.escs[0] as SimEsc;

// ---- writeSettings ----------------------------------------------------------

describe('Am32Session.writeSettings', () => {
    it('writes the edited field and leaves every byte it does not name alone', async () => {
        const h = await inPassthrough();
        const esc = firstEsc(h);
        const before = esc.eeprom;

        const [result] = [await drive(h.clock, h.session.writeSettings(0, { TIMING_ADVANCE: 16 }))];

        expect(result.changed).toBe(true);
        expect(result.settings.TIMING_ADVANCE).toBe(16);

        const after = esc.eeprom;
        expect(after[EepromLayout.TIMING_ADVANCE.offset]).toBe(16);
        // The two byte ranges audit A destroyed: the firmware's
        // `reserved_eeprom_3[4]` and the live CAN fields.
        expect(Array.from(after.slice(13, 17))).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
        expect(Array.from(after.slice(176, 184))).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
        expect(Array.from(esc.canBlock)).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);

        // Nothing else moved at all, byte for byte.
        const expected = Uint8Array.from(before);
        expected[EepromLayout.TIMING_ADVANCE.offset] = 16;
        expect(Array.from(after)).toEqual(Array.from(expected));
    });

    it('preserves a CAN block the audit\'s own reproduction would have shifted', async () => {
        // `can_node = 0x20` is a space, which `.trim()` deleted, shifting the
        // whole block left one byte; `filter_hz = 0xC8` is invalid UTF-8, which
        // came back as 253. This is the fault knob `esc[n].canBlock`.
        const esc = new SimEsc();
        esc.canBlock = [0x20, 2, 1, 20, 1, 0xC8, 0, 1];
        const h = await inPassthrough({ escs: [esc] });

        await drive(h.clock, h.session.writeSettings(0, { MOTOR_KV: 40 }));

        expect(Array.from(esc.canBlock)).toEqual([0x20, 2, 1, 20, 1, 0xC8, 0, 1]);
        expect(esc.eeprom[EepromLayout.MOTOR_KV.offset]).toBe(40);
    });

    it('builds the outgoing image from a fresh read, not from what the caller believes', async () => {
        // The base has to be the ESC's own current image: another client (or a
        // firmware upgrade path) may have moved bytes the caller has never seen,
        // and a patch must not resurrect a stale copy of them.
        const h = await inPassthrough();
        const esc = firstEsc(h);
        esc.poke(esc.eepromOffset + EepromLayout.BEEP_VOLUME.offset, [7]);

        const result = await drive(h.clock, h.session.writeSettings(0, { MOTOR_POLES: 12 }));

        expect(result.settings.BEEP_VOLUME).toBe(7);
        expect(esc.eeprom[EepromLayout.BEEP_VOLUME.offset]).toBe(7);
        expect(esc.eeprom[EepromLayout.MOTOR_POLES.offset]).toBe(12);
    });

    it('writes nothing when the patch changes nothing', async () => {
        const h = await inPassthrough();
        const esc = firstEsc(h);
        const writesBefore = esc.counts.write;

        const result = await drive(h.clock, h.session.writeSettings(0, {
            TIMING_ADVANCE: esc.eeprom[EepromLayout.TIMING_ADVANCE.offset] as number
        }));

        expect(result.changed).toBe(false);
        expect(esc.counts.write).toBe(writesBefore);
        expect(h.logs.some(line => line.includes('no changed settings'))).toBe(true);
    });

    it('names the channel when the write fails', async () => {
        const h = await inPassthrough({ escCount: 2 });
        // Channel 1 stops answering between the enumerate and the save, which is
        // exactly what a pulled signal wire looks like.
        (h.escs[1] as SimEsc).unresponsive = true;

        await expect(drive(h.clock, h.session.writeSettings(1, { TIMING_ADVANCE: 16 })))
            .rejects.toMatchObject({ name: 'SessionError', target: 1 });

        // And the session is still usable afterwards -- one dead channel does not
        // end the passthrough session.
        expect(h.session.state).toBe('passthrough');
        const ok = await drive(h.clock, h.session.writeSettings(0, { TIMING_ADVANCE: 16 }));
        expect(ok.changed).toBe(true);
    });

    it('refuses to write outside passthrough rather than timing out on the wire', async () => {
        const h = rig();
        h.fc.mavlinkIdleGate = 0;
        await drive(h.clock, h.session.connect());

        await expect(drive(h.clock, h.session.writeSettings(0, { TIMING_ADVANCE: 16 })))
            .rejects.toMatchObject({ name: 'SessionError', reason: 'passthrough' });
    });
});

// ---- flash ------------------------------------------------------------------

describe('Am32Session.flash', () => {
    it('streams the firmware, brackets it with the boot byte, and re-reads the ESC', async () => {
        const h = await inPassthrough();
        const esc = firstEsc(h);
        const mcu = new Mcu(0x1F06);
        const hex = firmwareHex();

        const info = await drive(h.clock, h.session.flash(0, hex));

        // The firmware body is really in flash.
        const body = esc.peek(mcu.getFirmwareStart(), 512);
        expect(Array.from(body)).toEqual(Array.from({ length: 512 }, (_, i) => (i * 7) & 0xFE));

        // The boot byte ends up set, which is what tells the bootloader the
        // application is complete. `EscView` renders 0x00 as "Flash was
        // unsuccessful".
        expect(esc.eeprom[EepromLayout.BOOT_BYTE.offset]).toBe(0x01);
        // And the settings survived the two EEPROM-page writes around the flash.
        expect(Array.from(esc.canBlock)).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
        expect(esc.eeprom[EepromLayout.LAYOUT_REVISION.offset]).toBe(3);

        // The ESC was reset and re-read, so the caller gets fresh info rather
        // than the image it started from.
        expect(esc.counts.reset).toBe(1);
        expect(info.settingsBuffer).toHaveLength(EEPROM_SIZE);
        expect(info.settings.BOOT_BYTE).toBe(0x01);
        expect(info.meta.am32.fileName).toBe('ARK_4IN1_F051');
    });

    it('clears the boot byte before it writes a single firmware page', async () => {
        // The order is the whole point: if the flash dies half way, the ESC must
        // come up in its bootloader rather than run a half-written application.
        const h = await inPassthrough();
        const esc = firstEsc(h);
        const seen: number[] = [];
        const realProgram = esc.programFlash.bind(esc);
        (esc as unknown as { programFlash: () => unknown }).programFlash = () => {
            seen.push(esc.eeprom[EepromLayout.BOOT_BYTE.offset] as number);
            return realProgram();
        };

        await drive(h.clock, h.session.flash(0, firmwareHex()));

        // The first program is the boot-byte-down EEPROM write itself, so the
        // value it observes is still 1; every firmware page after it sees 0.
        expect(seen.length).toBeGreaterThan(3);
        expect(seen[1]).toBe(0x00);
        expect(seen[seen.length - 2]).toBe(0x00);
    });

    it('reports progress in bytes so a modal can show a real bar', async () => {
        const h = await inPassthrough();
        const ticks: { current: number, total: number }[] = [];
        h.session.on('progress', (event) => {
            if (event.phase === 'flash') {
                ticks.push({ current: event.current, total: event.total });
            }
        });

        await drive(h.clock, h.session.flash(0, firmwareHex()));

        expect(ticks.length).toBeGreaterThan(2);
        expect(ticks[0]?.current).toBe(0);
        expect(ticks[ticks.length - 1]?.current).toBe(ticks[0]?.total);
        // Monotonic, and never past the total -- a bar that goes backwards or
        // over 100% is the usual symptom of a miscounted page loop.
        for (let i = 1; i < ticks.length; i += 1) {
            expect(ticks[i]!.current).toBeGreaterThanOrEqual(ticks[i - 1]!.current);
            expect(ticks[i]!.current).toBeLessThanOrEqual(ticks[i]!.total);
        }
    });

    it('rejects a hex built for another layout, and flashes it when told to', async () => {
        const h = await inPassthrough();

        await expect(drive(h.clock, h.session.flash(0, firmwareHex({ name: 'AM32_OTHER_4IN1_F051' }))))
            .rejects.toMatchObject({ name: 'SessionError', reason: 'image', target: 0 });
        // Nothing was written: the check runs before the boot byte is touched.
        expect(firstEsc(h).eeprom[EepromLayout.BOOT_BYTE.offset]).toBe(0x01);
        expect(firstEsc(h).counts.write).toBe(0);

        await drive(h.clock, h.session.flash(0, firmwareHex({ name: 'AM32_OTHER_4IN1_F051' }), {
            allowMcuMismatch: true
        }));
        expect(firstEsc(h).eeprom[EepromLayout.BOOT_BYTE.offset]).toBe(0x01);
    });

    it('still flashes an ESC whose own name does not read back', async () => {
        // A fresh or half-flashed board has no name to compare against -- and it is
        // exactly the board that needs flashing, so the check has to step aside
        // rather than lock it out. The app did this by accident, via a truthiness
        // guard; here it is deliberate, and it says which channel it did it for.
        const h = await inPassthrough({ escs: [new SimEsc({ firmwareName: '' })] });

        const info = await drive(h.clock, h.session.flash(0, firmwareHex({ name: 'AM32_ANY_BOARD_F051' })));

        expect(info.settings.BOOT_BYTE).toBe(0x01);
        expect(h.logs.some(line =>
            line.startsWith('warn:') && line.includes('ESC #1') && line.includes('no firmware name')
        )).toBe(true);
    });

    it('rejects a hex for a different MCU family', async () => {
        const h = await inPassthrough();

        await expect(drive(h.clock, h.session.flash(0, firmwareHex({ name: 'ARK_4IN1_G071' }))))
            .rejects.toMatchObject({ name: 'SessionError', reason: 'image' });
    });

    it('checks the hex against the target ESC, not against channel 0', async () => {
        // The app compared every flash against `firstValidEscData` -- ESC #1's
        // firmware name -- so flashing channel 3 on a mixed board checked the
        // wrong ESC. The session reads the name off the channel it is about to
        // write.
        const h = await inPassthrough({
            escs: [new SimEsc(), new SimEsc({ firmwareName: 'ARK_OTHER_F051' })]
        });

        await expect(drive(h.clock, h.session.flash(1, firmwareHex({ name: 'ARK_4IN1_F051' }))))
            .rejects.toMatchObject({ name: 'SessionError', reason: 'image', target: 1 });
        await drive(h.clock, h.session.flash(1, firmwareHex({ name: 'ARK_OTHER_F051' })));
    });

    it('never addresses the EEPROM page, even when the hex reaches past it', async () => {
        // The app streamed pages 0x04..0x40 -- the end of *flash* -- bounded only
        // by the image length, so a hex with records above the application region
        // took the settings page with it. The application genuinely ends where the
        // EEPROM page begins (AM32 `STM32F051K6TX_FLASH.ld:43-46`), so that is the
        // ceiling.
        const mcu = new Mcu(0x1F06);
        const eeprom = mcu.getEepromOffset();
        const h = await inPassthrough();
        const esc = firstEsc(h);

        const addresses: number[] = [];
        const realSetAddress = esc.setAddress.bind(esc);
        (esc as unknown as { setAddress: (a: number) => unknown }).setAddress = (address: number) => {
            addresses.push(address);
            return realSetAddress(address);
        };

        const hex = intelHex([
            { address: FLASH_OFFSET + mcu.getFirmwareStart(), data: Array.from({ length: 256 }, () => 0x5A) },
            { address: FLASH_OFFSET + eeprom - 32, data: nameBlock('ARK_4IN1_F051') },
            // Records inside the settings page and beyond it. A real AM32 build
            // does not produce these; a hand-built or mis-linked one can.
            { address: FLASH_OFFSET + eeprom, data: Array.from({ length: 512 }, () => 0xA5) }
        ]);

        await drive(h.clock, h.session.flash(0, hex));

        // The two settings writes are *at* the EEPROM base; nothing goes above it.
        expect(addresses.filter(address => address > eeprom)).toEqual([]);
        expect(addresses.filter(address => address === eeprom).length).toBeGreaterThanOrEqual(2);
        expect(Array.from(esc.canBlock)).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
        // Nothing from the stray records reached flash.
        expect(Array.from(esc.peek(eeprom + EEPROM_SIZE, 16)).every(b => b === 0xFF)).toBe(true);
    });

    it('rejects a file that is not Intel HEX at all', async () => {
        const h = await inPassthrough();

        await expect(drive(h.clock, h.session.flash(0, 'this is not a hex file')))
            .rejects.toMatchObject({ name: 'SessionError', reason: 'image' });
    });
});

describe('audit G: a failed flash rejects so the modal can be released', () => {
    it('rejects with the channel named when the ESC stops answering mid-flash', async () => {
        const h = await inPassthrough({ escCount: 2 });
        const esc = firstEsc(h);
        // Die after a few pages, the way a brown-out or a pulled wire does.
        const realProgram = esc.programFlash.bind(esc);
        const state = { writes: 0 };
        (esc as unknown as { programFlash: () => unknown }).programFlash = () => {
            state.writes += 1;
            if (state.writes > 3) {
                esc.unresponsive = true;
            }
            return realProgram();
        };

        await expect(drive(h.clock, h.session.flash(0, firmwareHex())))
            .rejects.toMatchObject({ name: 'SessionError', target: 0 });

        // The state machine did not get stuck in `enumerating`/mid-flash: the
        // session is back in passthrough and another channel still works. That is
        // what lets the UI toast the failure and release the modal instead of
        // wedging it open.
        expect(h.session.state).toBe('passthrough');
        expect(h.session.inPassthrough).toBe(true);
        const results = await drive(h.clock, h.session.enumerate());
        expect(results[1]).toMatchObject({ target: 1, ok: true });
    });

    it('rejects rather than hanging when the channel never comes up', async () => {
        const h = await inPassthrough({ escCount: 2 });
        (h.escs[1] as SimEsc).unresponsive = true;

        await expect(drive(h.clock, h.session.flash(1, firmwareHex())))
            .rejects.toMatchObject({ name: 'SessionError', reason: 'esc-init', target: 1 });
    });
});

describe('fault knob: esc[n].slowBy(ms) -- a slow ESC must not fail a flash', () => {
    it('flashes an ESC that answers 300 ms late on every command', async () => {
        // Block 6's done-when raises this to 600 ms with page verification in the
        // path. What it pins here is that the page-write budget comes from the
        // policy rather than from the 200 ms literal audit item C described.
        const h = await inPassthrough();
        const esc = firstEsc(h);
        esc.slowBy(300);

        const info = await drive(h.clock, h.session.flash(0, firmwareHex({ bodyBytes: 256 })));

        expect(info.settings.BOOT_BYTE).toBe(0x01);
        expect(esc.eeprom[EepromLayout.BOOT_BYTE.offset]).toBe(0x01);
    });
});
