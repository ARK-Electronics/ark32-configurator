import { EEPROM_SIZE } from 'am32-core/eeprom/layout';
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
import CommandQueue from '~/src/communication/commands.queue';
import Serial from '~/src/communication/serial';

// Re-exported so the app keeps importing 4-way symbols from its own facade
// rather than reaching into am32-core/framing directly -- block 5 adds the
// no-restricted-imports rule that makes this mandatory for components.
export { FOUR_WAY_ACK, FOUR_WAY_COMMANDS };
export type { FourWayResponse };

/**
 * Soft-serial (ESC line) is 19200 8N1. A 192-byte EEPROM settings read alone is
 * ~100ms on the wire, and the FC budgets ~187ms for the soft-serial RX. End-to-
 * end USB 4-way exchanges therefore need a generous host timeout or the last
 * ESCs in an enumerate loop fail with short reads / checksum errors.
 *
 * Block 2 replaces these literals with the core's TimeoutPolicy.
 */
export const FOUR_WAY_DEFAULT_TIMEOUT_MS = 1000;
export const FOUR_WAY_READ_TIMEOUT_MS = 1500;
export const FOUR_WAY_RETRY_DELAY_MS = 300;
export const FOUR_WAY_DEFAULT_RETRIES = 10;
export const FOUR_WAY_INIT_RETRIES = 10;

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
            return encodeFourWayRequest(cmd, params, address).buffer as ArrayBuffer;
        } catch (e: any) {
            this.logError(e.message);
            return undefined;
        }
    }

    initFlash (target: number, retries = FOUR_WAY_INIT_RETRIES) {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [target], 0, retries, FOUR_WAY_DEFAULT_TIMEOUT_MS);
    }

    reset (target: number) {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceReset, [target], 0, FOUR_WAY_DEFAULT_RETRIES, FOUR_WAY_DEFAULT_TIMEOUT_MS);
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
            mcu.getInfo().settings = decodeSettings(settingsArray, settingsArray[1]);
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

    readAddress (address: number, bytes: number, retries = FOUR_WAY_DEFAULT_RETRIES, timeout = FOUR_WAY_READ_TIMEOUT_MS) {
        // Scale timeout with payload size: wire time at 19200 plus FC/USB overhead.
        const minForPayload = Math.max(timeout, 500 + bytes * 5);
        return this.sendWithPromise(
            FOUR_WAY_COMMANDS.cmd_DeviceRead,
            [bytes === 256 ? 0 : bytes],
            address,
            retries,
            minForPayload
        );
    }

    async read (): Promise<void> {
        try {
            const readerData: ReadableStreamReadResult<Uint8Array> = await Serial.read<Uint8Array>();
            if (readerData.value) {
                this.parseMessage(readerData.value.buffer);
            }
        } catch (err) {
            console.error(`error reading data: ${err}`);
        }
    }

    async send (command: FOUR_WAY_COMMANDS, params: number[] = [0], address: number = 0, timeout = FOUR_WAY_DEFAULT_TIMEOUT_MS) {
        this.log(`Sending ${enumToString(command, FOUR_WAY_COMMANDS)}...`);

        const message = this.makePackage(command, params, address);

        if (!message) {
            this.logError('message empty');
            throw new Error('message empty!');
        }

        try {
            return await Serial.write(message, timeout, isCompleteFourWayFrame);
        } catch (e: any) {
            this.logError(`4-way command failed: ${e.message}`);
            return null;
        }
    }

    sendWithCallback (command: FOUR_WAY_COMMANDS, callback: PromiseFn<any>, params: number[] = [0], address = 0, retries = 0) {
        CommandQueue.addCallback(command, callback, retries);
        return this.send(command, params, address);
    }

    sendWithPromise (command: FOUR_WAY_COMMANDS, params: number[] = [0], address = 0, retries = FOUR_WAY_DEFAULT_RETRIES, timeout = FOUR_WAY_DEFAULT_TIMEOUT_MS): Promise<FourWayResponse | null> {
        let currentTry = 0;

        const callback: (resolve: PromiseFn<any>, reject: PromiseFn<any>) => void = async (resolve, reject) => {
            while (currentTry++ < retries) {
                // Drop any leftover RX from a previous timed-out or partial exchange.
                await Serial.drain();

                const started = Date.now();
                const result = await this.send(command, params, address, timeout).catch((err) => {
                    console.log(err);
                    return null;
                });
                const elapsed = Date.now() - started;
                console.log(currentTry, params, enumToString(command, FOUR_WAY_COMMANDS), `elapsed=${elapsed}ms`, `bytes=${result?.length ?? 0}`, result);
                if (command === FOUR_WAY_COMMANDS.cmd_InterfaceExit) {
                    resolve(null);
                    break;
                }

                if (result) {
                    try {
                        const response = this.parseMessage(result.buffer);
                        if (response.data.ack === FOUR_WAY_ACK.ACK_OK) {
                            resolve(response.data);
                            break;
                        }
                        this.logError(`  error: ${enumToString(response.data.ack, FOUR_WAY_ACK)} (try ${currentTry}/${retries}, ${elapsed}ms, ${result.length}B)`);
                    } catch (e: any) {
                        console.error(e);
                        this.logError(`  parse failed: ${e.message} (try ${currentTry}/${retries}, ${elapsed}ms, ${result.length}B)`);
                    }
                } else {
                    this.logError(`  empty/timeout response (try ${currentTry}/${retries}, ${elapsed}ms, timeout=${timeout}ms)`);
                }
                await Serial.drain();
                await delay(FOUR_WAY_RETRY_DELAY_MS);
            }

            if (currentTry > retries) {
                reject(new Error('max retries reached'));
                this.logError(`max retries reached for ${enumToString(command, FOUR_WAY_COMMANDS)}`);
            }
        };
        return new Promise(callback) as Promise<FourWayResponse | null>;
    }

    parseMessage (buffer: ArrayBufferLike) {
        try {
            const message = parseFourWayResponse(new Uint8Array(buffer));
            return {
                commandName: message.command,
                data: message
            };
        } catch (e: any) {
            if (e.reason === 'checksum') {
                this.logError(e.message);
            }
            throw e;
        }
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
    write (address: number, data: number[] | Uint8Array, timeout = FOUR_WAY_DEFAULT_TIMEOUT_MS) {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceWrite, Array.from(data), address, FOUR_WAY_DEFAULT_RETRIES, timeout);
    }

    /**
   * Write data to EEprom address
   *
   * @param {number} address
   * @param {Array<number>} data
   * @returns {Promise<Response>}
   */
    writeEEprom (address: number, data: number[]) {
        return this.sendWithPromise(FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom, data, address);
    }

    /**
   * Write data to multiple pages up to (but not including) end page
   *
   * @param {number} begin
   * @param {number} end
   * @param {number} pageSize
   * @param {Uint8Array} data
   */
    async writePages (begin: number, end: number, pageSize: number, data: Uint8Array, timeout: number) {
        const beginAddress = begin * pageSize;
        const endAddress = end * pageSize;
        const step = 0x100;
        const escStore = useEscStore();

        for (let address = beginAddress; address < endAddress && address < data.length; address += step) {
            await this.write(
                address,
                data.subarray(address, Math.min(address + step, data.length)),
                timeout
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

    async writeHex (target: number, hex: string, timeout: number) { // }, force: boolean, migrate: boolean) {
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
                    await this.write(eepromOffset, originalSettings, timeout);

                    await this.writePages(0x04, 0x40, pageSize, flash, timeout);
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
            const message = await this.readAddress(address, Math.min(step, data.length - address), FOUR_WAY_DEFAULT_RETRIES, FOUR_WAY_READ_TIMEOUT_MS);
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
