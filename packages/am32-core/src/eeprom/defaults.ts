/** Factory bytes and UI defaults both come from the schema. */
import type { EscSettings } from './layout';
import { BAKED_SCHEMA_CONTEXT, BUNDLED_SCHEMA, fieldDefaultRaw, isPreservedOnDefaults, resolveSchema, type EepromSchema, type SchemaContext } from './schema';

/** The historical 48-byte factory image is transcribed verbatim, including 141/102. */
export function createDefaultImage (schema: EepromSchema, context: SchemaContext): Uint8Array {
    const image = new Uint8Array(48).fill(0xFF);
    for (const field of Object.values(resolveSchema(schema, context).fields)) {
        const value = field.default?.raw;
        if (value === undefined || field.offset + field.size > image.length) { continue; }
        for (let i = 0; i < field.size; i++) {
            image[field.offset + i] = typeof value === 'number' ? Math.floor(value / (256 ** i)) & 0xFF : (value[i] ?? 0xFF);
        }
    }
    return image;
}

/** Canonical reset values, excluding firmware bookkeeping and per-ESC identity. */
export function defaultSettings (schema: EepromSchema, context: SchemaContext): Partial<EscSettings> {
    const patch: Partial<EscSettings> = {};
    for (const [alias, field] of Object.entries(resolveSchema(schema, context).aliases)) {
        if (isPreservedOnDefaults(field) || field.readOnly || field.hidden) { continue; }
        const value = fieldDefaultRaw(field);
        if (value !== undefined) { patch[alias] = Array.isArray(value) ? [...value] : value; }
        if (field.type === 'bluejay') { patch[alias] = new Array<number>(field.size).fill(0xFF); }
    }
    return patch;
}

export const DEFAULT_SETTINGS_IMAGE = createDefaultImage(BUNDLED_SCHEMA, BAKED_SCHEMA_CONTEXT);
export const DEFAULT_STARTUP_MELODY: readonly number[] = new Array<number>(128).fill(0xFF);
export const DEFAULTS_PRESERVED_FIELDS: readonly string[] = Object.entries(resolveSchema(BUNDLED_SCHEMA, BAKED_SCHEMA_CONTEXT).aliases)
    .filter(([, field]) => isPreservedOnDefaults(field)).map(([alias]) => alias);
