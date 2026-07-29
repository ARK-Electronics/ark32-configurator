/**
 * MCU variants and the per-ESC info record.
 *
 * Moved out of the Nuxt app's `src/mcu.ts` in block 1b. The one behavioural
 * change is that `LAYOUT_SIZE = 0xB8` is gone: the settings image is
 * `EEPROM_SIZE` (192) bytes, matching `EEprom_t`. See `eeprom/layout.ts`.
 */

import type { McuSettings } from './eeprom/layout';

export interface McuVariant {
    name: string;
    signature: string;
    page_size: number;
    flash_size: number;
    flash_offset: string;
    firmware_start: string;
    eeprom_offset: string;
}

export interface McuInfo {
    meta: {
        signature: number;
        input: number;
        interfaceMode: number;
        available: boolean;
        am32: {
            fileName: string | null;
            mcuType: string | null;
        };
    };
    displayName: string;
    firmwareName: string;
    supported: boolean;
    bootloader: {
        input: number;
        valid: boolean;
        pin: string;
        version: number;
    },
    settingsDirty: boolean;
    settings: McuSettings;
    settingsBuffer: Uint8Array;
    isSelected: boolean;
}

export interface EscData {
    isLoading: boolean;
    isError: boolean;
    data: McuInfo;
}

/**
 * Build the info record from a `cmd_DeviceInitFlash` reply.
 *
 * The four params are the device signature (little-endian), the bootloader
 * input pin, the interface mode and a pad byte.
 */
export function createMcuInfo (params: Uint8Array): McuInfo {
    return {
        meta: {
            signature: ((params[1] ?? 0) << 8) | (params[0] ?? 0),
            input: params[2] ?? 0,
            interfaceMode: params[3] ?? 0,
            available: true,
            am32: {
                fileName: null,
                mcuType: null
            }
        },
        displayName: 'UNKNOWN',
        firmwareName: 'UNKNOWN',
        supported: true,
        bootloader: {
            input: 0,
            valid: false,
            pin: '',
            version: 0
        },
        settingsDirty: false,
        settings: {},
        settingsBuffer: new Uint8Array(),
        isSelected: true
    };
}

export class Mcu {
    static variants: {
        [key: string]: McuVariant;
    } = {
            '1F06': {
                name: 'STM32F051',
                signature: '0x1f06',
                page_size: 1024,
                flash_size: 65536,
                flash_offset: '0x08000000',
                firmware_start: '0x1000',
                eeprom_offset: '0x7c00'
            },
            3506: {
                name: 'ARM64K',
                signature: '0x3506',
                page_size: 1024,
                flash_size: 65536,
                flash_offset: '0x08000000',
                firmware_start: '0x1000',
                eeprom_offset: '0xF800'
            },
            1506: {
                name: 'NXP ESC_8KB_PAGE',
                signature: '0x1506',
                page_size: 1024,
                flash_size: 65536,
                flash_offset: '0x08000000',
                firmware_start: '0x4000',
                eeprom_offset: '0xE000'
            }
        };

    static RESET_DELAY_MS = 5000;

    static BOOT_LOADER_VERSION_OFFSET = 0x00C0;
    static BOOT_LOADER_VERSION_SIZE = 1;

    static PORT_CHARACTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
    static PIN_CHARACTERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'];

    static parseBootLoaderPin (pin: number): [boolean, string] {
        const port = pin >> 4;
        const pinNumber = pin & 0xF;
        if (Mcu.PORT_CHARACTERS[port] && Mcu.PIN_CHARACTERS[pinNumber]) {
            return [true, `P${Mcu.PORT_CHARACTERS[port]}${Mcu.PIN_CHARACTERS[pinNumber]}`];
        }
        return [false, ''];
    }

    static getVariant (signature: number): McuVariant {
        const mcu = Mcu.variants[signature.toString(16).toUpperCase()];
        if (!mcu) {
            throw new Error(`mcu signature ${signature.toString(16).toUpperCase()} unknown!`);
        }
        return mcu;
    }

    private mcu: McuVariant;
    private info: McuInfo | null = null;

    constructor (signature: number) {
        this.mcu = Mcu.getVariant(signature);
    }

    setInfo (info: McuInfo) {
        this.info = info;
    }

    getInfo (): McuInfo {
        return this.info as McuInfo;
    }

    /** MCU name, e.g. `STM32F051`. */
    getName () {
        return this.mcu.name;
    }

    /** Flash size in bytes. */
    getFlashSize () {
        return this.mcu.flash_size;
    }

    /** Absolute address flash is mapped at. */
    getFlashOffset () {
        return parseInt(this.mcu.flash_offset, 16);
    }

    /** Offset of the EEPROM page within flash. */
    getEepromOffset () {
        return parseInt(this.mcu.eeprom_offset, 16);
    }

    /** Flash page size in bytes. */
    getPageSize () {
        return this.mcu.page_size;
    }

    /** Offset of the application image within flash. */
    getFirmwareStart () {
        if (this.mcu.firmware_start) {
            return parseInt(this.mcu.firmware_start, 16);
        }

        throw new Error('MCU does not have firmware start address');
    }
}

export default Mcu;
