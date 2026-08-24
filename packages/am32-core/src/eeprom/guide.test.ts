import { describe, expect, it } from 'vitest';
import { EepromLayout } from './layout';
import {
    SETTING_GUIDE,
    missingGuideFields,
    settingGuide,
    settingHelp
} from './guide';

describe('eeprom settings guide', () => {
    it('covers every layout field, in EEPROM order', () => {
        expect(missingGuideFields()).toEqual([]);
        expect(SETTING_GUIDE.map(entry => entry.field)).toEqual(Object.keys(EepromLayout));
    });

    it('uses each field name only once', () => {
        const fields = SETTING_GUIDE.map(entry => entry.field);
        expect(new Set(fields).size).toBe(fields.length);
    });

    it('keeps each description to a few sentences', () => {
        for (const entry of SETTING_GUIDE) {
            const sentences = entry.help.split(/(?<=\.)\s+/).filter(Boolean);
            expect(sentences.length, entry.field).toBeGreaterThanOrEqual(1);
            expect(sentences.length, entry.field).toBeLessThanOrEqual(3);
            expect(entry.help.length, entry.field).toBeLessThan(500);
        }
    });

    it('looks up a field by name', () => {
        expect(settingGuide('MAX_RAMP')?.name).toBe('Ramp rate');
        expect(settingHelp('MAX_RAMP')).toContain('percent of full throttle per millisecond');
        expect(settingGuide('NO_SUCH_FIELD')).toBeUndefined();
    });

    it('tracks the firmware MOTOR_POLES_MAX of 128', () => {
        expect(settingGuide('MOTOR_POLES')?.range).toBe('2–128');
    });

    it('names the firmware rpm-band ramp ceilings', () => {
        expect(settingHelp('MAX_RAMP')).toContain('low-rpm 6, high-rpm 16');
    });
});
