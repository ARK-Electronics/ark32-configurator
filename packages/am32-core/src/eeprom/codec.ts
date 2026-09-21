/** Runtime schema codec: raw settings patches always encode onto ESC read-back. */
import type { McuSettings } from './layout';
import {
    BUNDLED_SCHEMA, contextFromImage, resolveSchema,
    type EepromSchema, type SchemaContext, type SchemaField
} from './schema';

function scalar (field: SchemaField): boolean {
    return field.type !== 'reserved' && field.type !== 'bluejay';
}

export function decode (bytes: Uint8Array, schema: EepromSchema, context: SchemaContext): McuSettings {
    const settings: McuSettings = {};
    for (const [alias, field] of Object.entries(resolveSchema(schema, context).aliases)) {
        if (field.offset + field.size > bytes.length) { continue; }
        if (scalar(field)) {
            let value = 0;
            for (let i = 0; i < field.size; i++) { value += bytes[field.offset + i]! * (256 ** i); }
            if (field.type.startsWith('int') && value >= 2 ** (field.size * 8 - 1)) { value -= 2 ** (field.size * 8); }
            settings[alias] = value;
        } else if (field.type === 'bluejay') {
            settings[alias] = Array.from(bytes.subarray(field.offset, field.offset + field.size));
        } else {
            settings[alias] = bytes.slice(field.offset, field.offset + field.size);
        }
    }
    return settings;
}

export function encode (settings: Partial<McuSettings>, schema: EepromSchema, baseImage: Uint8Array, context: SchemaContext): Uint8Array {
    if (baseImage.length !== schema.bufferSize) {
        throw new RangeError(`settings base buffer must be ${schema.bufferSize} bytes, got ${baseImage.length}`);
    }
    const output = new Uint8Array(baseImage);
    // A future field may use CAN's reserved tail. Its explicit value wins over
    // the opaque block carried back by decode; unnamed CAN bytes still pass through.
    const entries = Object.entries(resolveSchema(schema, context).aliases);
    entries.sort(([left], [right]) => left === 'CAN_SETTINGS' ? -1 : right === 'CAN_SETTINGS' ? 1 : 0);
    for (const [alias, field] of entries) {
        const value = settings[alias];
        if (value === undefined) { continue; }
        if (scalar(field)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new TypeError(`eeprom field ${alias} must be a number, got ${typeof value}`);
            }
            // CLI deliberately accepts raw bytes, including historical disable sentinels.
            for (let i = 0; i < field.size; i++) { output[field.offset + i] = Math.floor(value / (256 ** i)) & 0xFF; }
        } else {
            if (typeof value === 'number') { throw new TypeError(`eeprom field ${alias} is ${field.size} bytes and must not be a number`); }
            const count = field.type === 'bluejay' ? field.size : Math.min(field.size, value.length);
            for (let i = 0; i < count; i++) { output[field.offset + i] = (value[i] ?? 0) & 0xFF; }
        }
    }
    return output;
}

/** Legacy conveniences retain raw byte semantics, with optional runtime schema/context. */
export function decodeSettings (buffer: Uint8Array, layoutRevision: number, schema = BUNDLED_SCHEMA, context = { ...contextFromImage(buffer), layout: layoutRevision }): McuSettings {
    return decode(buffer, schema, context);
}
export function encodeSettings (base: Uint8Array, settings: Partial<McuSettings>, layoutRevision: number, schema = BUNDLED_SCHEMA, context = { ...contextFromImage(base), layout: layoutRevision }): Uint8Array {
    return encode(settings, schema, base, context);
}
export function patchSettings (base: Uint8Array, patch: Partial<McuSettings>, layoutRevision: number, schema = BUNDLED_SCHEMA, context = { ...contextFromImage(base), layout: layoutRevision }): Uint8Array {
    return encode(patch, schema, base, context);
}
