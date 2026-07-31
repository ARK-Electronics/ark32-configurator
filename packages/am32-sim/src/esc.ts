/**
 * `SimEsc` -- an AM32 ESC as the flight controller sees it over 19200 baud
 * soft-serial.
 *
 * Note the asymmetry, and do not "clean it up" (issue #3 section 3): with the
 * USB-direct mode gone in block 1a, the **host never speaks the AM32 bootloader
 * protocol at all**. It speaks 4-way to the FC, and the FC translates that into
 * bootloader operations. So this state machine models the *FC's* peer, and it
 * exists only in the simulator. That is where the realistic failure modes live
 * -- short reads, ACK timing, page-erase-on-write -- and modelling them is what
 * makes the timeout policy testable rather than assumed.
 *
 * Modelled at operation granularity rather than byte-by-byte over the
 * soft-serial line, because nothing above the FC can ever observe those bytes.
 * What *is* modelled byte-for-byte is the **duration** of each operation:
 * `wire(n)` at 19200 plus the bootloader's own programming time. That is the
 * quantity the timeout policy is derived from, so it is the quantity that has to
 * be real.
 *
 * Verified against `~/code/ark/AM32-bootloader/bootloader/main.c` (`BL:` below)
 * and `~/code/ark/AM32-bootloader/Mcu/f051/Src/eeprom.c` (`EE:`), read with a
 * subagent. The surprising ones, all of which a naive simulator gets wrong:
 *
 *  - **`CMD_ERASE_FLASH` (0x02) is a stub.** It validates the CRC and the
 *    address, then ACKs without erasing anything (`BL:613-629`). The erase is
 *    implicit in the write instead.
 *  - **A write erases the page only when the address is page-aligned**
 *    (`EE:35-44`), then programs and verifies with `memcmp` (`EE:62`). So the
 *    host must stream pages in ascending order and hit each boundary exactly.
 *  - **A write to the EEPROM base overwrites payload byte 2 with the
 *    bootloader's own version** (`BL:517-525`). `BOOT_LOADER_REVISION` therefore
 *    never round-trips, which any byte-for-byte write verification has to know.
 *  - **A read resets the address pointer to 0** (`BL:667-669`), so every
 *    operation needs a fresh `CMD_SET_ADDRESS` and the 4-way `0xFFFF`
 *    "keep the address" idiom does not work on AM32.
 *  - **`CMD_VERIFY_FLASH_ARM` (0x04) is not implemented** -- it answers
 *    `brERRORCOMMAND` (`BL:674-675`), so the FC's `cmd_DeviceVerify` can never
 *    succeed against an AM32 ESC.
 */

import { EEPROM_SIZE, EepromLayout } from 'am32-core/eeprom/layout';
import { Mcu } from 'am32-core/mcu';
import { SOFT_SERIAL_BAUD, wireMs } from 'am32-core/link/timeout-policy';

/**
 * How the bootloader answered one operation.
 *
 * The raw ACK bytes are `brSUCCESS 0x30` (BL:419-423), `brERRORCOMMAND 0xC1`
 * (BL:425-429) and `brERRORCRC 0xC2` (BL:431-435); `brERRORVERIFY 0xC0` is
 * defined but never emitted, because there is no verify support. They are
 * documented rather than declared: nothing above the FC can observe them, and a
 * constant nobody reads is worse than a comment.
 */
export type EscAck =
    | 'ok'
    /** `brERRORCOMMAND` or `brERRORCRC` -- the ESC said no. */
    | 'error'
    /** No reply, or fewer bytes than asked for, inside the FC's budget. */
    | 'timeout';

export interface EscResult {
    ack: EscAck
    /** Payload of a read. Empty for everything else. */
    data: Uint8Array
    /**
     * How long the ESC took, in milliseconds. The FC charges this to the clock,
     * so the host's timeout is measured against a duration that came from the
     * firmware's own numbers rather than from a guess.
     */
    durationMs: number
    /** Bytes actually returned, which {@link SimEsc.shortRead} makes fewer. */
    returnedBytes: number
}

/**
 * Lowest address the bootloader will program, flash-relative:
 * `FIRMWARE_RELATIVE_START` (BL:75-81). `checkAddressWritable` compares against
 * `APPLICATION_ADDRESS = MCU_FLASH_START + FIRMWARE_RELATIVE_START` (BL:213).
 *
 * **This is 0x4000, not 0x1000, on a `DRONECAN_SUPPORT` build** (BL:77). The
 * simulator's default ESC is an `ARK_4IN1_F051` with a populated CAN block, so
 * if ARK ships a DroneCAN build the writable floor here is 12 KiB too low.
 * Confirm against the ARK firmware before block 6 relies on it; it is a
 * constructor option for exactly that reason.
 */
export const FIRMWARE_START = 0x1000;

/** `ADDRESS_MAGIC_EEPROM` -- resolves to `EEPROM_START_ADD` (BL:220-226, :553-562). */
export const ADDRESS_MAGIC_EEPROM = 0x0020;
/** `ADDRESS_MAGIC_FILE_NAME` -- `EEPROM_START_ADD - 32`. */
export const ADDRESS_MAGIC_FILE_NAME = 0x0021;
/** `ADDRESS_MAGIC_CONTINUE` -- the end of the previous read, AM32's own answer to 0xFFFF. */
export const ADDRESS_MAGIC_CONTINUE = 0x0022;

/** AM32's own reply to `CMD_PROG_FLASH` is a `memcmp` verify, so ~1 ms/half-word. */
const PROG_FLASH_MS = 3;
const PAGE_ERASE_MS = 30;
/** `BL_ConnectEx`: 21-byte greeting out, 9-byte device info back (BL:471-494). */
const CONNECT_BYTES_OUT = 21;
const CONNECT_BYTES_IN = 9;
/** `CMD_SET_ADDRESS`: `FF 00 hi lo crc crc` then a one-byte ACK (BL:536-548). */
const SET_ADDRESS_BYTES = 6 + 1;
/** `CMD_SET_BUFFER` header, then `n` payload + CRC16, then one ACK (BL:577-598). */
const SET_BUFFER_HEADER_BYTES = 6;
/** A command frame is `cmd arg crc crc`; a bare ACK is one byte back. */
const COMMAND_BYTES = 4 + 1;
/** A read reply is `n` bytes + CRC16 + `brSUCCESS` (BL:654-663). */
const READ_OVERHEAD_BYTES = 3;

export interface SimEscOptions {
    /**
     * The signature the host decodes from `cmd_DeviceInitFlash`, i.e.
     * `FLASH_SIZE_CODE << 8 | 0x06`. Default 0x1F06 -- a 32 KiB STM32F051, which
     * is what `Mcu.variants` calls `STM32F051`.
     */
    signature?: number
    /**
     * The signature the bootloader *reports*, when that differs from the one
     * modelled above.
     *
     * Exists so the simulator can produce an ESC whose MCU the host's variant
     * table does not know -- a new part, or a build the configurator has not
     * been taught about. The flash geometry still comes from {@link signature},
     * because the ESC has to be *something*; only the four device-info bytes the
     * host decodes change. Without this the case is unreachable, since `SimEsc`
     * itself needs a known signature to size its flash.
     */
    reportedSignature?: number
    /** `PIN_CODE`: port letter in the high nibble, pin in the low (BL:139). */
    bootloaderPin?: number
    /** Firmware name stored in the 32 bytes below the EEPROM (BL:224-226). */
    firmwareName?: string
    /** `EEprom_t.eeprom_version`, i.e. the layout revision. */
    layoutRevision?: number
    /**
     * `BOOTLOADER_VERSION` from `Inc/version.h`. Also what a write to the EEPROM
     * base stamps over payload byte 2, so it is what `BOOT_LOADER_REVISION`
     * always reads back as.
     */
    bootloaderVersion?: number
    /** Firmware version at `MAIN_REVISION` / `SUB_REVISION`. */
    firmwareVersion?: [number, number]
}

const DEFAULTS = {
    signature: 0x1F06,
    bootloaderPin: 0x32,
    firmwareName: 'ARK_4IN1_F051',
    layoutRevision: 3,
    bootloaderVersion: 18,
    firmwareVersion: [2, 20] as [number, number]
};

export class SimEsc {
    // ---- fault knobs -------------------------------------------------------

    /**
     * The ESC does not answer the FC at all -- an unpowered channel, a broken
     * signal wire, firmware that will not enter the bootloader.
     *
     * Guards audit **B**: a partial enumerate must degrade into a per-target
     * error, not throw out of the handler and take the other three ESCs with it.
     */
    unresponsive = false;

    /**
     * Extra milliseconds this ESC takes to answer each 4-way command.
     *
     * Charged once per command by {@link import('./fc').SimFc}, before it starts
     * talking to the ESC, rather than once per bootloader operation. That is
     * deliberate: charging it inside an operation would blow the FC's *own* ACK
     * budget (500 ms for a flash program) and turn every `slowBy` test into an
     * FC-side abort, hiding the thing actually under test -- the **host's**
     * timeout. `slowBy` models an ESC that is slow, not one that is broken;
     * {@link unresponsive} models broken.
     *
     * Guards audit **C**: the flash path used to pass a 200 ms literal for an
     * operation the FC budgets ~700 ms for.
     */
    slowMs = 0;

    /**
     * Corrupt the checksum of this ESC's replies on the way back to the host.
     *
     * Injected at the *host link* rather than at the bootloader link on purpose.
     * A bootloader-side CRC failure is indistinguishable from
     * {@link shortRead} by the time it reaches the host -- both firmwares
     * collapse it to a one-param `ACK_D_GENERAL_ERROR` reply -- so injecting it
     * there would leave the host's own CRC-rejection path untested. Injecting it
     * on the 4-way frame exercises `parseFourWayResponse`'s checksum branch and
     * the link's retry-with-drain, which is the regression this knob is for: a
     * corrupt reply must not poison the next ESC.
     *
     * `true` corrupts every reply; a number corrupts the next N and then stops,
     * which is what makes "the retry recovered" an exact assertion rather than a
     * timing race.
     */
    corruptCrc: boolean | number = false;

    /**
     * Return fewer bytes than the FC asked for. `true` means one byte short; a
     * number means "return exactly this many".
     *
     * The FC's read has a total budget (`req_bytes * 1000` us on ArduPilot, 2 ms
     * per byte on Betaflight), so a short read is a read *timeout* on the FC
     * side, not an error reply from the ESC. It surfaces to the host as a
     * one-param `ACK_D_GENERAL_ERROR`, which the link must retry and drain
     * rather than hand up as data.
     */
    shortRead: boolean | number = false;

    /**
     * The next write is accepted with `ACK_OK` and changes nothing in flash.
     *
     * `true` for every write, a number for the next N. The counted form is what
     * makes "the retry recovered" an exact assertion rather than a timing race,
     * the same shape {@link corruptCrc} uses.
     *
     * **This is the one host-visible shape the bootloader's own verify cannot
     * produce, which is why it needs a knob.** `save_flash_nolib` ends in a
     * `memcmp` and returns false on a mismatch (`EE:61-62`), which the bootloader
     * reports as a bad ACK (`BL:527-528`) -- so a *programming* failure is loud.
     * What is silent is the flight controller: `BL_WriteA` leaks `ACK_OK` when its
     * final `BL_GetACK` times out (`AP_BLHeli.cpp:928-932`), so a write the ESC
     * never confirmed -- or never received -- is reported to the host as a
     * success. That is the gap read-back verification exists to close, and this
     * knob is the only way to reach it from a test.
     */
    silentWriteFailure: boolean | number = false;

    /**
     * The next write programs one byte wrong, so the bootloader's own verify
     * rejects it. `true` for every write, a number for the next N.
     *
     * A flash cell that will not hold its charge, modelled exactly the way the
     * firmware experiences one: {@link programFlash} clears one extra bit, and the
     * `memcmp` that ends `save_flash_nolib` (`EE:61-62`) then fails on its own and
     * answers a bad ACK (`BL:527-528`). Nothing about the ACK path is faked.
     *
     * This is the fault that makes the **page** the right retry granularity. The
     * page is now partially programmed with bits that cannot be set back, so
     * re-sending the same chunk fails for as long as anyone cares to try it -- only
     * a write to the page base, which erases first (`EE:35-44`), can recover. It is
     * the complement of {@link silentWriteFailure}, where nothing was programmed and
     * either strategy would have worked.
     */
    failingFlashCell: boolean | number = false;

    /**
     * The bootloader drops off the wire after this many more operations.
     *
     * Models the mid-write dropout seen on hardware (issue #10): mid-flash the
     * ESC left its bootloader for one deaf cycle and every remaining write and
     * verify read came back `ACK_D_GENERAL_ERROR` -- answered by the flight
     * controller on the silent ESC's behalf -- until the host ran
     * `cmd_DeviceInitFlash` again. `true` drops on the very next operation; a
     * number, after that many more. One-shot: the re-init that recovers the
     * channel also clears it, so a test can assert the retry succeeded.
     */
    bootloaderDropout: boolean | number = false;

    /** Set {@link slowMs}. Spelled as a method because the plan's knob is `slowBy(ms)`. */
    slowBy (ms: number): this {
        this.slowMs = Math.max(0, ms);
        return this;
    }

    /**
     * True if this write should be swallowed, consuming one of a counted budget.
     * Called by {@link programFlash}; not part of the knob API.
     */
    private takeSilentWriteFailure (): boolean {
        if (this.silentWriteFailure === true) {
            return true;
        }
        if (typeof this.silentWriteFailure === 'number' && this.silentWriteFailure > 0) {
            this.silentWriteFailure -= 1;
            return true;
        }
        return false;
    }

    /** Same shape, for {@link failingFlashCell}. */
    private takeFailingFlashCell (): boolean {
        if (this.failingFlashCell === true) {
            return true;
        }
        if (typeof this.failingFlashCell === 'number' && this.failingFlashCell > 0) {
            this.failingFlashCell -= 1;
            return true;
        }
        return false;
    }

    /**
     * True if this reply should be corrupted, consuming one of a counted budget.
     * Called by the FC; not part of the knob API.
     */
    takeCorruptCrc (): boolean {
        if (this.corruptCrc === true) {
            return true;
        }
        if (typeof this.corruptCrc === 'number' && this.corruptCrc > 0) {
            this.corruptCrc -= 1;
            return true;
        }
        return false;
    }

    // ---- identity ----------------------------------------------------------

    readonly signature: number;
    /** What `cmd_DeviceInitFlash` hands the host. Usually {@link signature}. */
    readonly reportedSignature: number;
    readonly bootloaderPin: number;
    readonly bootloaderVersion: number;

    private readonly mcu: Mcu;
    /** The whole flash, EEPROM page included. 0xFF is erased. */
    private readonly flash: Uint8Array;
    private connected = false;
    private address = 0;
    private continueAddress = 0;
    private buffer = new Uint8Array(0);

    /** What the FC has asked for. Diagnostics and assertions. */
    readonly counts = { connect: 0, read: 0, write: 0, erase: 0, reset: 0 };

    constructor (options: SimEscOptions = {}) {
        const opts = { ...DEFAULTS, ...options };
        this.signature = opts.signature;
        this.reportedSignature = options.reportedSignature ?? opts.signature;
        this.bootloaderPin = opts.bootloaderPin;
        this.bootloaderVersion = opts.bootloaderVersion;

        this.mcu = new Mcu(this.signature);
        this.flash = new Uint8Array(this.mcu.getFlashSize()).fill(0xFF);

        this.writeFirmwareName(opts.firmwareName);
        this.initEeprom(opts);
    }

    // ---- memory ------------------------------------------------------------

    get eepromOffset (): number {
        return this.mcu.getEepromOffset();
    }

    get pageSize (): number {
        return this.mcu.getPageSize();
    }

    /** The live 192-byte `EEprom_t` image. A copy; write it back with `poke`. */
    get eeprom (): Uint8Array {
        return this.flash.slice(this.eepromOffset, this.eepromOffset + EEPROM_SIZE);
    }

    /** Read out of the flash image directly, bypassing the bootloader. */
    peek (address: number, length: number): Uint8Array {
        return this.flash.slice(address, address + length);
    }

    /** Write into the flash image directly, bypassing the bootloader. */
    poke (address: number, data: ArrayLike<number>): void {
        this.flash.set(Uint8Array.from(Array.from(data)), address);
    }

    /**
     * The eight live CAN fields at EEPROM bytes 176-183 (`can_node`,
     * `esc_index`, `require_arming`, `telem_rate`, `require_zero_throttle`,
     * `filter_hz`, `debug_rate`, `term_enable`).
     *
     * Guards audit **A**: a settings write must leave these bytes exactly as it
     * found them. The audit's reproduction used `[32, 1, 1, 10, 1, 200, 0, 1]`,
     * where `can_node = 0x20` is a space that `.trim()` deleted and
     * `filter_hz = 0xC8` is invalid UTF-8 that decoded to U+FFFD -- so this is
     * the knob that pins both failures, and it is the default image.
     */
    get canBlock (): Uint8Array {
        const at = this.eepromOffset + EepromLayout.CAN_SETTINGS.offset;
        return this.flash.slice(at, at + 8);
    }

    set canBlock (bytes: ArrayLike<number>) {
        const value = Uint8Array.from(Array.from(bytes));
        if (value.length !== 8) {
            throw new Error(`canBlock is the eight live CAN bytes, got ${value.length}`);
        }
        this.flash.set(value, this.eepromOffset + EepromLayout.CAN_SETTINGS.offset);
    }

    // ---- bootloader operations, as the FC drives them ----------------------

    /**
     * `BL_ConnectEx`. Returns the raw 8-byte `BootInfo` the FC reads back, not
     * the 4-byte device info -- reversing it into `deviceInfo` is the FC's job
     * (`BFavr:225-227`, `AP:813-815`), and getting the order wrong there is a
     * real bug the simulator should be able to catch.
     *
     * `4 7 1 <PIN_CODE> <FLASH_SIZE_CODE> 0x06 0x06 <protocol version>` (BL:201-209).
     */
    connect (): EscResult {
        this.counts.connect += 1;
        const duration = this.wire(CONNECT_BYTES_OUT + CONNECT_BYTES_IN);

        if (this.unresponsive) {
            return this.dead(duration);
        }

        this.connected = true;
        return {
            ack: 'ok',
            data: Uint8Array.from([
                0x34, 0x37, 0x31,
                this.bootloaderPin,
                (this.reportedSignature >> 8) & 0xFF,
                this.reportedSignature & 0xFF,
                0x06,
                0x02
            ]),
            durationMs: duration,
            returnedBytes: 8
        };
    }

    /**
     * `CMD_SET_ADDRESS`. Addresses below 1024 that are not one of the three
     * magic values are reserved and rejected (BL:563-566), which is why the
     * 4-way `0xFFFF` "keep the current address" idiom cannot work here: AM32
     * zeroes the pointer after every read, and `0xFFFF` makes the FC skip this
     * command entirely. `ADDRESS_MAGIC_CONTINUE` is AM32's own replacement.
     */
    setAddress (address: number): EscResult {
        this.dropoutTick();
        const duration = this.wire(SET_ADDRESS_BYTES);
        if (this.unresponsive || !this.connected) {
            return this.dead(duration);
        }

        const resolved = this.resolveAddress(address);
        if (resolved === null) {
            return this.refused(duration);
        }
        this.address = resolved;
        return this.ok(duration);
    }

    /** BL:220-226 and :553-562. Null means "reserved", which is an error reply. */
    private resolveAddress (address: number): number | null {
        switch (address) {
        case ADDRESS_MAGIC_EEPROM: return this.eepromOffset;
        case ADDRESS_MAGIC_FILE_NAME: return this.eepromOffset - 32;
        case ADDRESS_MAGIC_CONTINUE: return this.continueAddress;
        default: return address < 1024 ? null : address;
        }
    }

    /** `CMD_SET_BUFFER`: stage `data` for the next program command. */
    setBuffer (data: Uint8Array): EscResult {
        this.dropoutTick();
        const duration = this.wire(SET_BUFFER_HEADER_BYTES + data.length + 2 + 1);
        if (this.unresponsive || !this.connected) {
            return this.dead(duration);
        }
        this.buffer = data.slice();
        return this.ok(duration);
    }

    /**
     * `CMD_READ_FLASH_SIL` (0x03). AM32 implements only this one read command;
     * `CMD_READ_EEPROM` (0x04) and `CMD_READ_FLASH_ATM` (0x07) answer
     * `brERRORCOMMAND`. Resets the address pointer afterwards (BL:667-669).
     */
    read (length: number): EscResult {
        this.dropoutTick();
        this.counts.read += 1;
        const duration = this.wire(COMMAND_BYTES - 1) + this.wire(length + READ_OVERHEAD_BYTES);

        if (this.unresponsive || !this.connected) {
            return this.dead(duration);
        }
        if (this.address === 0) {
            return this.refused(duration);
        }

        const returned = this.shortReadLength(length);
        const data = this.flash.slice(this.address, this.address + returned);

        this.continueAddress = this.address + length;
        this.address = 0;

        return {
            // A short read never completes the FC's `serial_read_bytes`, so the
            // FC sees a timeout rather than an error reply from the ESC.
            ack: returned < length ? 'timeout' : 'ok',
            data,
            durationMs: duration,
            returnedBytes: returned
        };
    }

    /**
     * `CMD_PROG_FLASH`: program the staged buffer at the current address.
     *
     * Page-erase-on-write (EE:35-44): the page is erased only when the address
     * is page-aligned, which is what lets the host stream four 256-byte chunks
     * into a 1024-byte page. A non-aligned write into an already-programmed page
     * can only clear bits, so the bootloader's `memcmp` verify fails and it
     * answers `brERRORCOMMAND` -- exactly like real flash.
     */
    programFlash (): EscResult {
        this.dropoutTick();
        this.counts.write += 1;
        const duration = this.wire(COMMAND_BYTES) + PROG_FLASH_MS + this.buffer.length / 16;

        if (this.unresponsive || !this.connected) {
            return this.dead(duration);
        }
        // `checkAddressWritable` (BL:443-446, called at :511-515) and the
        // even-address/even-length requirement in `save_flash_nolib` (EE:20-22).
        if (this.address < FIRMWARE_START || this.address % 2 !== 0 || this.buffer.length % 2 !== 0) {
            return this.refused(duration);
        }

        // The flight controller's leaked `ACK_OK` (see `silentWriteFailure`):
        // accepted, and nothing reached flash. Counted as a write, because the
        // command did happen -- what did not happen is the programming.
        if (this.takeSilentWriteFailure()) {
            return this.ok(duration);
        }

        const payload = this.stampBootloaderVersion(this.buffer);

        if (this.address % this.pageSize === 0) {
            this.erasePageAt(this.address);
        }
        this.program(this.address, payload);
        if (this.takeFailingFlashCell()) {
            this.loseOneBit(this.address, payload);
        }

        // The bootloader verifies with memcmp and reports a mismatch (EE:62).
        const written = this.flash.slice(this.address, this.address + payload.length);
        for (let i = 0; i < payload.length; i += 1) {
            if (written[i] !== payload[i]) {
                return this.refused(duration);
            }
        }
        return this.ok(duration);
    }

    /**
     * `CMD_ERASE_FLASH` (0x02) -- a **stub** in the AM32 bootloader
     * (BL:613-629). It checks the CRC and the address and then ACKs without
     * touching flash. So the FC's `cmd_DevicePageErase` reports success while
     * erasing nothing, and anything that relies on an explicit page erase is
     * relying on a no-op. The erase that matters is the implicit one in
     * {@link programFlash}.
     */
    erasePage (): EscResult {
        this.dropoutTick();
        this.counts.erase += 1;
        const duration = this.wire(COMMAND_BYTES) + PAGE_ERASE_MS;
        if (this.unresponsive || !this.connected) {
            return this.dead(duration);
        }
        if (this.address < FIRMWARE_START) {
            return this.refused(duration);
        }
        return this.ok(duration);
    }

    /**
     * `CMD_PROG_EEPROM` (0x05) and `CMD_VERIFY_FLASH_ARM` (0x04) are **not
     * implemented** by the AM32 bootloader -- both answer `brERRORCOMMAND`
     * (BL:674-675). Settings are written with a plain {@link programFlash} at
     * the EEPROM address instead, and verification has to be a read-back
     * compare.
     */
    unsupportedCommand (): EscResult {
        const duration = this.wire(COMMAND_BYTES);
        if (this.unresponsive || !this.connected) {
            return this.dead(duration);
        }
        return this.refused(duration);
    }

    /**
     * `CMD_RUN` (0x00), which `BL_SendCMDRunRestartBootloader` sends. Despite
     * the name it *runs the application* -- and AM32 sends no reply at all
     * (BL:496-501), which is why the FC does not wait for one.
     */
    reset (): EscResult {
        this.counts.reset += 1;
        const duration = this.wire(COMMAND_BYTES - 1);
        if (this.unresponsive) {
            return this.dead(duration);
        }
        this.connected = false;
        this.address = 0;
        this.buffer = new Uint8Array(0);
        return this.ok(duration);
    }

    /** True once the FC has run a successful {@link connect}. */
    get isConnected (): boolean {
        return this.connected;
    }

    /** The FC dropped the link -- `setDisconnected`. */
    disconnect (): void {
        this.connected = false;
    }

    /**
     * Advance {@link bootloaderDropout} by one operation; when it fires, the
     * bootloader is gone and the operation that triggered it already answers
     * dead. Deliberately not called by {@link connect}: `cmd_DeviceInitFlash`
     * is the recovery, and a knob that also sabotaged it would model an ESC
     * that can never come back -- that one is {@link unresponsive}.
     */
    private dropoutTick (): void {
        if (this.bootloaderDropout === false) {
            return;
        }
        const remaining = this.bootloaderDropout === true ? 0 : this.bootloaderDropout - 1;
        if (remaining <= 0) {
            this.bootloaderDropout = false;
            this.connected = false;
        } else {
            this.bootloaderDropout = remaining;
        }
    }

    // ---- internals ---------------------------------------------------------

    private shortReadLength (asked: number): number {
        if (this.shortRead === false) {
            return asked;
        }
        if (this.shortRead === true) {
            return Math.max(0, asked - 1);
        }
        return Math.max(0, Math.min(asked, Math.floor(this.shortRead)));
    }

    /**
     * A write to the EEPROM base with more than two payload bytes has byte 2
     * replaced by the bootloader's own version (BL:517-525). So
     * `BOOT_LOADER_REVISION` never round-trips, and a settings write cannot be
     * verified by a byte-for-byte compare of the whole image.
     */
    private stampBootloaderVersion (data: Uint8Array): Uint8Array {
        if (this.address !== this.eepromOffset || data.length <= 2) {
            return data;
        }
        const stamped = data.slice();
        stamped[2] = this.bootloaderVersion;
        return stamped;
    }

    private erasePageAt (address: number): void {
        const page = Math.floor(address / this.pageSize) * this.pageSize;
        this.flash.fill(0xFF, page, page + this.pageSize);
    }

    /**
     * Clear one bit that was supposed to stay set -- {@link failingFlashCell}.
     *
     * The lowest set bit of the first byte that has one, so the sabotage is always
     * something flash could actually do (a cell that failed to hold its charge) and
     * never something it could not (a bit appearing out of nowhere). The caller's
     * `memcmp` finds it; nothing here reports it.
     */
    private loseOneBit (address: number, payload: Uint8Array): void {
        for (let i = 0; i < payload.length; i += 1) {
            const value = this.flash[address + i] as number;
            if (value !== 0) {
                this.flash[address + i] = value & (value - 1);
                return;
            }
        }
    }

    /** Flash programming can only clear bits, never set them. */
    private program (address: number, data: Uint8Array): void {
        for (let i = 0; i < data.length; i += 1) {
            const at = address + i;
            if (at >= this.flash.length) {
                return;
            }
            this.flash[at] = (this.flash[at] as number) & (data[i] as number);
        }
    }

    private wire (bytes: number): number {
        return wireMs(bytes, SOFT_SERIAL_BAUD);
    }

    private ok (durationMs: number): EscResult {
        return { ack: 'ok', data: new Uint8Array(0), durationMs: Math.ceil(durationMs), returnedBytes: 0 };
    }

    /** `brERRORCOMMAND` / `brERRORCRC`: the ESC answered, and said no. */
    private refused (durationMs: number): EscResult {
        return { ack: 'error', data: new Uint8Array(0), durationMs: Math.ceil(durationMs), returnedBytes: 0 };
    }

    /** No answer at all inside the FC's budget. */
    private dead (durationMs: number): EscResult {
        return { ack: 'timeout', data: new Uint8Array(0), durationMs: Math.ceil(durationMs), returnedBytes: 0 };
    }

    private writeFirmwareName (name: string): void {
        // The 32 bytes below the EEPROM, which the bootloader addresses as
        // ADDRESS_MAGIC_FILE_NAME (BL:556-559). The NUL truncation is
        // configurator-side, in `FourWay.getInfo`.
        const bytes = new Uint8Array(32);
        for (let i = 0; i < name.length && i < 31; i += 1) {
            bytes[i] = name.charCodeAt(i) & 0xFF;
        }
        this.flash.set(bytes, this.eepromOffset - 32);
    }

    private initEeprom (opts: {
        layoutRevision: number
        bootloaderVersion: number
        firmwareVersion: [number, number]
    }): void {
        const eeprom = new Uint8Array(EEPROM_SIZE).fill(0x00);

        eeprom[EepromLayout.BOOT_BYTE.offset] = 0x01;
        eeprom[EepromLayout.LAYOUT_REVISION.offset] = opts.layoutRevision;
        eeprom[EepromLayout.BOOT_LOADER_REVISION.offset] = opts.bootloaderVersion;
        eeprom[EepromLayout.MAIN_REVISION.offset] = opts.firmwareVersion[0];
        eeprom[EepromLayout.SUB_REVISION.offset] = opts.firmwareVersion[1];

        // A plausible v3 image rather than zeros, so a round-trip assertion that
        // only holds for an all-zero buffer fails here.
        eeprom[EepromLayout.MOTOR_DIRECTION.offset] = 0x01;
        eeprom[EepromLayout.MOTOR_KV.offset] = 0x37;
        eeprom[EepromLayout.MOTOR_POLES.offset] = 14;
        eeprom[EepromLayout.STARTUP_POWER.offset] = 100;
        eeprom[EepromLayout.TIMING_ADVANCE.offset] = 8;
        eeprom[EepromLayout.PWM_FREQUENCY.offset] = 24;

        // `char reserved_eeprom_3[4]` at 13-16, neither 0x00 nor 0xFF, so an
        // encode that started from a 0xFF fill shows up as a diff (audit A).
        eeprom.set([0xDE, 0xAD, 0xBE, 0xEF], 13);

        this.flash.set(eeprom, this.eepromOffset);
        this.canBlock = [32, 1, 1, 10, 1, 200, 0, 1];
    }
}
