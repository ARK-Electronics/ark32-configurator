import { describe, expect, it } from 'vitest';
import { EEPROM_SIZE, type Transport } from './index';

describe('am32-core skeleton', () => {
    it('pins EEPROM_SIZE to the 192-byte EEprom_t', () => {
        // Changing this means AM32's Inc/eeprom.h changed. Verify against the
        // firmware before touching it.
        expect(EEPROM_SIZE).toBe(192);
    });

    it('leaves room for the CAN block and its reserved tail', () => {
        const canBlockStart = 176;
        const canBlockLength = 16; // 8 fields + uint8_t reserved[8]
        expect(canBlockStart + canBlockLength).toBe(EEPROM_SIZE);
    });

    it('accepts a minimal Transport implementation', () => {
        // Compile-time proof that the interface is implementable without a DOM.
        const noop: Transport = {
            isOpen: false,
            open: async () => {},
            close: async () => {},
            write: async () => {},
            onData: () => () => {}
        };
        expect(noop.isOpen).toBe(false);
    });
});
