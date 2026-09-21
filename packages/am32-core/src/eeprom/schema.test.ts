import { describe, expect, it } from 'vitest';
import { decode, encode } from './codec';
import { createDefaultImage, defaultSettings } from './defaults';
import { BUNDLED_SCHEMA, compareFirmware, contextFromImage, fromRaw, resolveSchema, toRaw, validateSchema, type EepromSchema } from './schema';

function schemaCopy (): EepromSchema { return structuredClone(BUNDLED_SCHEMA); }

function futureSchema (): EepromSchema {
    const schema = schemaCopy();
    schema.fields.canReserved = { ...schema.fields.canReserved!, offset: 185, size: 7 };
    schema.fields.oldReserved = { type: 'reserved', offset: 184, size: 1, hidden: true, maxFirmwareVersion: '32.0' };
    schema.fields.futureGain = { type: 'uint8', offset: 184, size: 1, name: 'Future gain', alias: ['FUTURE_GAIN'], minFirmwareVersion: '32.1', raw: { min: 0, max: 100 }, default: { raw: 25 } };
    schema.groups.motor!.fields.push('futureGain');
    return schema;
}

const context = { layout: 3, firmware: '32.0' };

describe('living EEPROM schema', () => {
    it('validates the offline bundle and compares firmware as integer tuples', () => {
        expect(() => validateSchema(BUNDLED_SCHEMA)).not.toThrow();
        expect(compareFirmware('2.9', '2.18')).toBeLessThan(0);
        expect(compareFirmware('32.0', '2.18')).toBeGreaterThan(0);
        expect(resolveSchema(BUNDLED_SCHEMA, { layout: 3, firmware: '2.16' }).fields.motorPoles!.raw!.max).toBe(64);
        expect(resolveSchema(BUNDLED_SCHEMA, context).fields.motorPoles!.raw!.max).toBe(128);
    });

    it('merges one level in default/layout/firmware order and replaces enum arrays', () => {
        const schema = schemaCopy();
        schema.fields.motorPoles!.versions = {
            'firmware:32.0+': { raw: { max: 128 }, display: { decimals: 1 } },
            'eeprom:3+': { raw: { max: 80 }, display: { offset: 5 } },
            default: { raw: { min: 2, max: 64 }, display: { factor: 2 } },
            'eeprom:2+': { raw: { max: 70 } }
        };
        const field = resolveSchema(schema, context).fields.motorPoles!;
        expect(field.raw).toEqual({ min: 2, max: 128 });
        expect(field.display).toEqual({ factor: 2, offset: 5, decimals: 1 });
        expect(resolveSchema(schema, { layout: 3, firmware: '2.16' }).fields.variablePwmFreq!.values!.map(v => v.raw)).toEqual([0, 1]);
        expect(resolveSchema(schema, context).fields.variablePwmFreq!.values!.map(v => v.raw)).toEqual([0, 1, 2]);
    });

    it('ignores unknown same-major overlay keys and refuses overlays that move storage', () => {
        const schema = schemaCopy();
        schema.fields.motorPoles!.versions = { default: { raw: { max: 64 }, alias: ['HIJACKED'], preserveOnDefaults: true } } as never;
        validateSchema(schema);
        const field = resolveSchema(schema, context).fields.motorPoles!;
        expect(field.alias).toEqual(['MOTOR_POLES']);
        expect(field.preserveOnDefaults).not.toBe(true);
        schema.fields.motorPoles!.versions = { default: { offset: 0 } } as never;
        expect(() => validateSchema(schema)).toThrow(/storage/);
    });

    it('supports fetched aliases per ESC and gives new fields priority over the opaque CAN tail', () => {
        const schema = futureSchema();
        validateSchema(schema);
        const image = Uint8Array.from({ length: 192 }, (_, i) => i);
        image[1] = 3; image[3] = 32; image[4] = 1;
        const newer = contextFromImage(image);
        const settings = decode(image, schema, newer);
        settings.FUTURE_GAIN = 37;
        const written = encode(settings, schema, image, newer);
        expect(written[184]).toBe(37);
        expect(written.slice(176, 184)).toEqual(image.slice(176, 184));
        expect(written.slice(185)).toEqual(image.slice(185));
        expect(decode(image, schema, context).FUTURE_GAIN).toBeUndefined();
        expect(encode({ FUTURE_GAIN: 37 }, schema, image, context)).toEqual(image);
        expect(defaultSettings(schema, newer).FUTURE_GAIN).toBe(25);
    });

    it('permits byte reuse only in disjoint firmware/layout rectangles', () => {
        const schema = futureSchema();
        schema.fields.oldReserved!.maxFirmwareVersion = '32.1';
        expect(() => validateSchema(schema)).toThrow(/overlaps/);
        schema.fields.oldReserved!.maxFirmwareVersion = '32.0';
        validateSchema(schema);
        schema.fields.futureGain!.minEepromVersion = 4;
        schema.fields.oldReserved!.maxFirmwareVersion = undefined;
        schema.fields.oldReserved!.maxEepromVersion = 3;
        validateSchema(schema);
    });

    it('encodes future multibyte scalar fields little endian, including signed values', () => {
        const schema = schemaCopy();
        schema.fields.canReserved = { ...schema.fields.canReserved!, offset: 188, size: 4 };
        schema.fields.signedGain = { type: 'int16', offset: 184, size: 2, alias: ['SIGNED_GAIN'], name: 'Signed gain' };
        schema.fields.unsignedGain = { type: 'uint16', offset: 186, size: 2, alias: ['UNSIGNED_GAIN'], name: 'Unsigned gain' };
        schema.groups.motor!.fields.push('signedGain', 'unsignedGain');
        validateSchema(schema);
        const image = encode({ SIGNED_GAIN: -258, UNSIGNED_GAIN: 0xABCD }, schema, new Uint8Array(192), context);
        expect(Array.from(image.slice(184, 188))).toEqual([254, 254, 205, 171]);
        expect(decode(image, schema, context).SIGNED_GAIN).toBe(-258);
        expect(decode(image, schema, context).UNSIGNED_GAIN).toBe(0xABCD);
    });

    it('converts display KV to raw 25 and rounds UI values', () => {
        const field = resolveSchema(BUNDLED_SCHEMA, context).fields.motorKv!;
        expect(toRaw(field, 1020)).toBe(25);
        expect(fromRaw(field, 25)).toBe(1020);
        expect(toRaw(field, 1041)).toBe(26);
        expect(encode({ MOTOR_KV: toRaw(field, 1020) }, BUNDLED_SCHEMA, new Uint8Array(192), context)[26]).toBe(25);
    });

    it.each([
        ['major', (s: EepromSchema) => { s.version = '2.0.0'; }],
        ['width', (s: EepromSchema) => { s.fields.motorPoles!.size = 2; }],
        ['default', (s: EepromSchema) => { s.fields.motorPoles!.default = { raw: 256 }; }],
        ['array default', (s: EepromSchema) => { s.fields.reserved0!.default = { raw: [0] }; }],
        ['range', (s: EepromSchema) => { s.fields.motorPoles!.raw = { min: 0, max: 256 }; }],
        ['flags', (s: EepromSchema) => { s.fields.motorPoles!.readOnly = 'false' as never; }],
        ['widget', (s: EepromSchema) => { s.fields.motorPoles!.ui = { widget: 'magic' as never }; }],
        ['panel', (s: EepromSchema) => { s.groups.motor!.panel = 'magic' as never; }],
        ['group gate', (s: EepromSchema) => { s.groups.can!.minEepromVersion = 4; }],
        ['alias', (s: EepromSchema) => { s.fields.motorPoles!.alias = ['MOTOR_KV']; }],
        ['gap', (s: EepromSchema) => { s.fields.canReserved!.size = 7; }],
        ['membership', (s: EepromSchema) => { s.groups.motor!.fields.push('motorKv'); }]
    ])('rejects malformed %s metadata', (_name, mutate) => {
        const schema = schemaCopy(); mutate(schema);
        expect(() => validateSchema(schema)).toThrow();
    });

    it('keeps the golden erase image and produces canonical portable reset values', () => {
        const golden = [1, 3, 1, 1, 35, 160, 4, 0, 10, 100, 0, 50, 2, 48, 53, 49, 32, 0, 0, 0, 1, 1, 1, 26, 24, 100, 55, 14, 0, 0, 5, 0, 128, 128, 128, 50, 0, 50, 0, 0, 15, 10, 10, 141, 102, 6, 1, 0];
        expect(Array.from(createDefaultImage(BUNDLED_SCHEMA, context))).toEqual(golden);
        const patch = defaultSettings(BUNDLED_SCHEMA, context);
        expect(patch.TEMPERATURE_LIMIT).toBe(255);
        expect(patch.CURRENT_LIMIT).toBe(0);
        expect(patch.BOOT_BYTE).toBeUndefined();
        expect(patch.CAN_SETTINGS).toBeUndefined();
        const future = schemaCopy();
        future.fields.bootByte!.preserveOnDefaults = false;
        future.fields.bootByte!.readOnly = false;
        expect(defaultSettings(future, context).BOOT_BYTE).toBeUndefined();
    });
});
