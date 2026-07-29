import { EEPROM_SIZE, EepromLayout } from 'am32-core/eeprom/layout';
import { decodeSettings, encodeSettings } from 'am32-core/eeprom/codec';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse,
    type FourWayResponse
} from 'am32-core/framing/fourway';
import { fillImage, parseHex } from 'am32-core/hex';
import { Mcu, createMcuInfo, type McuInfo } from 'am32-core/mcu';
import type { FcVariant } from 'am32-core/link/timeout-policy';
import CommandQueue from '~/src/communication/commands.queue';
import Serial from '~/src/communication/serial';

// Re-exported so the app keeps importing 4-way symbols from its own facade
// rather than reaching into am32-core/framing directly -- block 5 adds the
// no-restricted-imports rule that makes this mandatory for components.
export { FOUR_WAY_ACK, FOUR_WAY_COMMANDS };
export type { FourWayResponse };

/**
 * How many times an exchange is attempted. Timeouts are *not* here any more:
 * they come from the core's `TimeoutPolicy`, derived from the FC's own published
 * budgets, so no call site can pass 200 ms for a page write again (audit C).
 */
export const FOUR_WAY_DEFAULT_RETRIES = 10;
export const FOUR_WAY_INIT_RETRIES = 10;

/** Which FC is in the path, as far as the timeout policy is concerned. */
const fcVariantFromMspType = (type: MspData['type']): FcVariant => {
    switch (type) {
    case 'ardu':
        return 'ardupilot';
    // INAV runs Betaflight's serial_4way, including its per-byte start-bit
    // timeout, so it gets the same budgets.
    case 'bf':
    case 'inav':
        return 'betaflight';
    default:
        return 'generic';
    }
};

interface FourWaySendOptions {
    /** Total attempts, matching the meaning the old retry counter had. */
    retries?: number
    /**
     * Bytes the *ESC* moves, which is what the timeout scales with: the
     * requested count for a read, the written length for a write. Not the number
     * of 4-way params -- for a read that is 1.
     */
    payloadBytes?: number
}

export class FourWay {
    static instance: FourWay;

    static init (
        log: (s: string) => void,
        logWarning: (s: string) => void,
        logError: (s: string) => void
    ) {
        FourWay.instance = new FourWay(log, logWarning, logError);
    }

    static getInstance () {
        if (!FourWay.instance) {
            useLogStore().logError('FourWay instance missing!');
            throw new Error('FourWay instance missing!');
        }
        return FourWay.instance;
    }

    constructor (
      private readonly log: ((s: string) => void),
      private readonly logError: ((s: string) => void),
      private readonly logWarning: ((s: string) => void)
    ) {
    }

    makePackage (cmd: FOUR_WAY_COMMANDS, params: number[], address: number) {
        try {
            return encodeFourWayRequest(cmd, params, address);
        } catch (e: any) {
            this.logError(e.message);
            return undefined;
        }
    }

    initFlash (target: number, retries = FOUR_WAY_INIT_RETRIES) {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [target], 0, { retries });
    }

    reset (target: number) {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceReset, [target], 0);
    }

    /* buildDisplayName(flash: McuInfo, make: string) {
        const settings = flash.settings;
        let revision = 'Unsupported/Unrecognized';
        if(settings.MAIN_REVISION !== undefined && settings.SUB_REVISION !== undefined) {
          revision = `${settings.MAIN_REVISION}.${settings.SUB_REVISION}`;
        }

        if(make === 'NOT READY') {
          revision = 'FLASH FIRMWARE';
        }

        //if we can extract the AM32 mcutype, display it here
        const mcuType = flash.meta?.am32?.mcuType ? `, MCU: ${flash.meta.am32.mcuType}` : '';

        const bootloader = flash.bootloader.valid ? `, Bootloader v${flash.bootloader.version} (${flash.bootloader.pin})${mcuType}` : ', Bootloader unknown';

        return `${make} - ${this.name}, ${revision}${bootloader}`;
    } */

    async getInfo (target: number, initRetries = FOUR_WAY_INIT_RETRIES) {
        const logStore = useLogStore();

        this.log(`Reading ESC #${target + 1} (init retries=${initRetries})`);
        const flash = await this.initFlash(target, initRetries);
        const info = createMcuInfo(flash!.params);
        const mcu = new Mcu(info.meta.signature);
        mcu.setInfo(info);

        const eepromOffset = mcu.getEepromOffset();

        try {
            const fileNameRead = await this.readAddress(eepromOffset - 32, 32);
            const fileName = new TextDecoder().decode(fileNameRead!.params.slice(0, fileNameRead?.params.indexOf(0x0)));

            if (/[A-Z0-9_]+/.test(fileName)) {
                mcu.getInfo().meta.am32.fileName = fileName;
                mcu.getInfo().meta.am32.mcuType = fileName.slice(fileName.lastIndexOf('_') + 1);
            }

            if (mcu.getInfo().meta.input) {
                mcu.getInfo().bootloader.input = info.meta.input;
                mcu.getInfo().bootloader.valid = false;
            }

            // EEPROM_SIZE is 192: the whole EEprom_t, not the 184 bytes the old
            // Mcu.LAYOUT_SIZE read, which stopped inside the CAN block.
            const settingsArray = (await this.readAddress(eepromOffset, EEPROM_SIZE))!.params;
            // The ESC's own layout revision, not the empty settings object the
            // old code read it from -- that always came out undefined, which
            // silently disabled version gating.
            const layoutRevision = settingsArray[EepromLayout.LAYOUT_REVISION.offset];
            mcu.getInfo().settings = decodeSettings(settingsArray, layoutRevision);
            mcu.getInfo().settingsBuffer = settingsArray;

            const [valid, pin] = Mcu.parseBootLoaderPin(mcu.getInfo().bootloader.input);
            if (!valid) {
                this.logError(`Invalid bootloader pin ${mcu.getInfo().bootloader.input}`);
            } else {
                mcu.getInfo().bootloader.valid = true;
                mcu.getInfo().bootloader.pin = pin;
                mcu.getInfo().bootloader.version = mcu.getInfo().settings.BOOT_LOADER_REVISION as number ?? 0;
            }

            if (mcu.getInfo().bootloader.version === 0xFF) {
                logStore.logWarning('Bootloader version unset, setting to 1');
                mcu.getInfo().settings.BOOT_LOADER_REVISION = 1;
                await this.writeSettings(target, mcu.getInfo());
                mcu.getInfo().bootloader.version = 1;
            }
        } catch (e: any) {
            console.error(e);
            this.logError(`Failed reading ESC #${target + 1}: ${e.message}`);
            throw new Error(e.message);
        }

        this.log(`ESC #${target + 1} OK`);
        return info;
    }

    readAddress (address: number, bytes: number, retries = FOUR_WAY_DEFAULT_RETRIES) {
        return this.sendWithPromise(
            FOUR_WAY_COMMANDS.cmd_DeviceRead,
            [bytes === 256 ? 0 : bytes],
            address,
            { retries, payloadBytes: bytes }
        );
    }

    /**
     * One attempt, no retries, result unparsed. The only caller left is the
     * `cmd_InterfaceExit` on disconnect, where a failure is not interesting.
     */
    async send (command: FOUR_WAY_COMMANDS, params: number[] = [0], address: number = 0) {
        this.log(`Sending ${enumToString(command, FOUR_WAY_COMMANDS)}...`);

        const message = this.makePackage(command, params, address);

        if (!message) {
            this.logError('message empty');
            throw new Error('message empty!');
        }

        try {
            return await Serial.request(message, {
                probe: isCompleteFourWayFrame,
                timeout: this.policy().forFourWay(command, params.length),
                retries: 1,
                label: enumToString(command, FOUR_WAY_COMMANDS)
            });
        } catch (e: any) {
            this.logError(`4-way command failed: ${e.message}`);
            return null;
        }
    }

    sendWithCallback (command: FOUR_WAY_COMMANDS, callback: PromiseFn<any>, params: number[] = [0], address = 0, retries = 0) {
        CommandQueue.addCallback(command, callback, retries);
        return this.send(command, params, address);
    }

    /**
     * Send a 4-way command and return the parsed, ACK_OK response.
     *
     * The retry loop, the drain and the timeout all belong to the core's `Link`
     * now. What was here before was a `new Promise(async (resolve, reject) => ...)`
     * whose executor swallowed anything thrown outside its inner try -- a drain
     * or write failure meant the promise never settled and the caller hung
     * forever. That was audit item G; it is structurally impossible now, because
     * this is a plain async function.
     */
    async sendWithPromise (
        command: FOUR_WAY_COMMANDS,
        params: number[] = [0],
        address = 0,
        options: FourWaySendOptions = {}
    ): Promise<FourWayResponse | null> {
        const label = enumToString(command, FOUR_WAY_COMMANDS);
        const message = this.makePackage(command, params, address);

        if (!message) {
            throw new Error('message empty!');
        }

        const timeout = this.policy().forFourWay(command, options.payloadBytes ?? params.length);

        // The FC stops answering the moment it leaves passthrough, so exit is
        // fire-and-forget: one attempt, reply ignored.
        if (command === FOUR_WAY_COMMANDS.cmd_InterfaceExit) {
            await Serial.request(message, {
                probe: isCompleteFourWayFrame,
                timeout,
                retries: 1,
                label
            }).catch(() => null);
            return null;
        }

        let parsed: FourWayResponse | null = null;

        try {
            await Serial.request(message, {
                probe: isCompleteFourWayFrame,
                timeout,
                retries: options.retries ?? FOUR_WAY_DEFAULT_RETRIES,
                label,
                validate: (response) => {
                    const decoded = this.parseMessage(response);
                    if (decoded.ack !== FOUR_WAY_ACK.ACK_OK) {
                        throw new Error(`${label}: ${enumToString(decoded.ack, FOUR_WAY_ACK)}`);
                    }
                    parsed = decoded;
                }
            });
        } catch (e: any) {
            this.logError(`${label} failed: ${e.message}`);
            throw e;
        }

        return parsed;
    }

    parseMessage (buffer: Uint8Array | ArrayBufferLike) {
        try {
            return parseFourWayResponse(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
        } catch (e: any) {
            if (e.reason === 'checksum') {
                this.logError(e.message);
            }
            throw e;
        }
    }

    /** Timeouts derived from the FC in the path, not from a literal. */
    private policy () {
        return Serial.policy.withVariant(fcVariantFromMspType(useSerialStore().mspData.type));
    }

    writeAddress (address: number, data: Uint8Array) {
        console.log(address, data);
    // const message = this.makePackage(FOUR_WAY_COMMANDS.cmd_DeviceWrite, data, address);
    // return Serial.write(data, address);
    }

    /**
 * Write data to address
 *
 * @param {number} address
 * @param {Array<number>} data
 * @returns {Promise<Response>}
 */
    write (address: number, data: number[] | Uint8Array) {
        return this.sendWithPromise(
            FOUR_WAY_COMMANDS.cmd_DeviceWrite,
            Array.from(data),
            address,
            { payloadBytes: data.length }
        );
    }

    /**
   * Write data to EEprom address
   *
   * @param {number} address
   * @param {Array<number>} data
   * @returns {Promise<Response>}
   */
    writeEEprom (address: number, data: number[]) {
        return this.sendWithPromise(
            FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom,
            data,
            address,
            { payloadBytes: data.length }
        );
    }

    /**
   * Write data to multiple pages up to (but not including) end page
   *
   * @param {number} begin
   * @param {number} end
   * @param {number} pageSize
   * @param {Uint8Array} data
   */
    async writePages (begin: number, end: number, pageSize: number, data: Uint8Array) {
        const beginAddress = begin * pageSize;
        const endAddress = end * pageSize;
        const step = 0x100;
        const escStore = useEscStore();

        for (let address = beginAddress; address < endAddress && address < data.length; address += step) {
            await this.write(
                address,
                data.subarray(address, Math.min(address + step, data.length))
            );

            escStore.bytesWritten += step;
        }
    }

    async writeSettings (target: number, esc: McuInfo) {
        const flash = await this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [target]);

        if (flash) {
            // Byte-preserving: start from what the ESC handed us and overwrite
            // only the fields the layout names, so reserved bytes 13-16, the CAN
            // block at 176-183 and can.reserved at 184-191 survive. Audit item A.
            const newSettingsArray = encodeSettings(
                esc.settingsBuffer,
                esc.settings,
                esc.settings.LAYOUT_REVISION as number
            );

            if (compare(newSettingsArray, esc.settingsBuffer)) {
                this.logWarning('No changed settings found for ESC #' + (target + 1));
            } else {
                const info = createMcuInfo(flash!.params);
                const mcu = new Mcu(info.meta.signature);

                let readbackSettings = null;

                await this.write(mcu.getEepromOffset(), newSettingsArray);
                readbackSettings = (await this.readAddress(mcu.getEepromOffset(), EEPROM_SIZE));

                if (readbackSettings) {
                    /*
                    if (!compare(newSettingsArray, readbackSettings.params)) {
                        throw new Error('SettingsVerificationError(newSettingsArray, readbackSettings)');
                    }
                    */

                    this.log('Successfully wrote settings to ESC #' + (target + 1));
                }
            }

            return newSettingsArray;
        }

        throw new Error('EscInitError');
    }

    /**
     * No timeout parameter, deliberately: audit item C was `writeHex(i, hex, 200)`
     * reaching a page write the FC budgets ~700 ms for. The policy derives it.
     */
    async writeHex (target: number, hex: string) { // }, force: boolean, migrate: boolean) {
        const escStore = useEscStore();
        const parsed = parseHex(hex);
        if (parsed) {
            const initFlash = await this.initFlash(target, 3);
            const info = createMcuInfo(initFlash!.params);
            const mcu = new Mcu(info.meta.signature);
            const endAddress = parsed.data[parsed.data.length - 1].address + parsed.data[parsed.data.length - 1].bytes;
            const flash = fillImage(parsed, endAddress - mcu.getFlashOffset(), mcu.getFlashOffset());
            if (flash) {
                const eepromOffset = mcu.getEepromOffset();
                const pageSize = mcu.getPageSize();
                const firmwareStart = mcu.getFirmwareStart();

                escStore.totalBytes = flash.byteLength - firmwareStart;
                escStore.bytesWritten = 0;
                escStore.step = 'Writing';

                const message = await this.readAddress(mcu.getEepromOffset(), EEPROM_SIZE);
                if (message) {
                    const originalSettings = message.params;

                    // boot bit
                    originalSettings[0] = 0x00;
                    /*
                    originalSettings[0] = 0x00;
                    originalSettings.fill(0x00, 3, 5);
                    originalSettings.set(asciiToBuffer('FLASH FAIL  '), 5);
                    */
                    await this.write(eepromOffset, originalSettings);

                    await this.writePages(0x04, 0x40, pageSize, flash);
                    /* try {
                        escStore.step = 'Verifying';
                        await delay(200);
                        // await this.verifyPages(0x04, 0x40, pageSize, flash);
                    } catch (error) {
                        try {
                            escStore.step = 'Verifying';
                            await delay(200);
                            await this.verifyPages(0x04, 0x40, pageSize, flash);
                        } catch (error) {
                            this.logError('flashingVerificationFailed');
                        }
                    }
                    originalSettings[0] = 0x01;
                    originalSettings.fill(0x00, 3, 5);
                    originalSettings.set(asciiToBuffer('NOT READY   '), 5);
                    */

                    // boot bit
                    originalSettings[0] = 0x01;
                    await this.write(eepromOffset, originalSettings);
                }
            }
        }
    }

    /**
   * Verify multiple pages up to (but not including) end page
   *
   * @param {number} begin
   * @param {number} end
   * @param {number} pageSize
   * @param {Uint8Array} data
   */
    async verifyPages (begin: number, end: number, pageSize: number, data: Uint8Array) {
        const beginAddress = begin * pageSize;
        const endAddress = end * pageSize;
        const step = 0x80;

        const escStore = useEscStore();

        for (let address = beginAddress; address < endAddress && address < data.length; address += step) {
            const message = await this.readAddress(address, Math.min(step, data.length - address));
            if (message) {
                const reference = data.subarray(message.address, message.address + message.params.byteLength);

                if (!compare(message.params, reference)) {
                    console.debug('Verification failed - retry');
                    this.logError(`failed to verify write at address 0x${message.address.toString(0x10)}`);
                    throw new Error(`failed to verify write at address 0x${message.address.toString(0x10)}`);
                } else {
                    escStore.bytesWritten += step;
                }
            }
        }
    }

    testAlive () {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive);
    }
}
