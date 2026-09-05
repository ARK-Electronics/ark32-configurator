/** Compile-time aliases for the bundled firmware line. Runtime code uses resolved schemas. */
import { EepromLayout } from './layout.generated';
export { EepromLayout } from './layout.generated';
export const EEPROM_SIZE = 192;
export interface EepromField {
    offset: number;
    size: number;
    minEepromVersion?: number;
    maxEepromVersion?: number;
}
export type EepromLayoutField = Record<string, EepromField>;
export type EepromLayoutKeys = keyof typeof EepromLayout;
export type EepromLayoutValues = typeof EepromLayout[EepromLayoutKeys];
/** A fetched document can add aliases without a configurator release. Values stay raw. */
export type McuSettings = Record<string, number | number[] | Uint8Array>;
export type EscSettings = McuSettings;
export const NUMBER_ARRAY_FIELDS: ReadonlySet<string> = new Set(['STARTUP_MELODY']);
