/** The published EEPROM language. All settings metadata is resolved per ESC. */
export type SchemaPredicate = { field: string; op: 'eq' | 'ne' | 'gt' | 'lt'; raw: number }
    | { all: SchemaPredicate[] } | { any: SchemaPredicate[] };
export interface SchemaUi {
    widget?: 'checkbox' | 'slider' | 'select' | 'radio' | 'rtttl';
    visibleWhen?: SchemaPredicate;
    disabledWhen?: SchemaPredicate;
}
export interface SchemaRange { min?: number; max?: number }
export interface SchemaDisplay extends SchemaRange { factor?: number; offset?: number; decimals?: number }
export interface SchemaField {
    offset: number;
    size: number;
    type: 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'bool' | 'enum' | 'number' | 'reserved' | 'bluejay';
    name?: string;
    description?: string;
    unit?: string;
    alias?: string[];
    hidden?: boolean;
    readOnly?: boolean;
    minEepromVersion?: number;
    maxEepromVersion?: number;
    minFirmwareVersion?: string;
    maxFirmwareVersion?: string;
    raw?: SchemaRange;
    display?: SchemaDisplay;
    values?: { raw: number; name: string; description?: string }[];
    disabledValue?: { raw: number; display?: number | string };
    default?: { raw: number | number[] };
    preserveOnDefaults?: boolean;
    onLoad?: 'keep' | 'clamp' | 'disable';
    onLoadFallbackRaw?: number;
    ui?: SchemaUi;
    versions?: Record<string, Partial<Pick<SchemaField, 'raw' | 'display' | 'values' | 'disabledValue' | 'ui'>>>;
}
export interface SchemaGroup {
    name: string;
    description?: string;
    fields: string[];
    panel?: 'settings' | 'tune' | 'esc' | 'none';
    minEepromVersion?: number;
    maxEepromVersion?: number;
    minFirmwareVersion?: string;
    maxFirmwareVersion?: string;
    ui?: SchemaUi;
}
export interface EepromSchema {
    version: string;
    bufferSize: number;
    eepromVersions: Record<string, unknown>;
    fields: Record<string, SchemaField>;
    groups: Record<string, SchemaGroup>;
    groupOrder?: string[];
    meta?: unknown;
}
export interface SchemaContext { layout: number; firmware: string }
export interface ResolvedField extends SchemaField { key: string }
export interface ResolvedGroup extends SchemaGroup { key: string }
export interface ResolvedSchema {
    version: string;
    bufferSize: number;
    context: SchemaContext;
    fields: Record<string, ResolvedField>;
    aliases: Record<string, ResolvedField>;
    groups: ResolvedGroup[];
}

export { BUNDLED_SCHEMA, BUNDLED_SCHEMA_SHA256 } from './schema.generated';
export const SUPPORTED_SCHEMA_MAJOR = 1;
export const BAKED_SCHEMA_CONTEXT: SchemaContext = { layout: 3, firmware: '32.0' };

/** Firmware is a pair of integers, including versions such as 2.9 and 2.18. */
export function compareFirmware (left: string, right: string): number {
    const parse = (value: string): number[] => {
        if (!/^\d+\.\d+$/.test(value)) {
            throw new Error(`Invalid firmware version '${value}'`);
        }
        const tuple = value.split('.').map(Number);
        if (!tuple.every(Number.isSafeInteger)) { throw new Error(`Invalid firmware version '${value}'`); }
        return tuple;
    };
    const a = parse(left); const b = parse(right);
    return (a[0]! - b[0]!) || (a[1]! - b[1]!);
}

export function contextFromImage (bytes: Uint8Array): SchemaContext {
    return { layout: bytes[1] ?? 0, firmware: `${bytes[3] ?? 0}.${bytes[4] ?? 0}` };
}

function applies (field: Pick<SchemaField, 'minEepromVersion' | 'maxEepromVersion' | 'minFirmwareVersion' | 'maxFirmwareVersion'>, context: SchemaContext): boolean {
    return (field.minEepromVersion === undefined || context.layout >= field.minEepromVersion) &&
        (field.maxEepromVersion === undefined || context.layout <= field.maxEepromVersion) &&
        (field.minFirmwareVersion === undefined || compareFirmware(context.firmware, field.minFirmwareVersion) >= 0) &&
        (field.maxFirmwareVersion === undefined || compareFirmware(context.firmware, field.maxFirmwareVersion) <= 0);
}

function mergeField (field: SchemaField, overlay: Partial<SchemaField>): SchemaField {
    return {
        ...field,
        ...(overlay.values ? { values: overlay.values } : {}),
        ...(overlay.raw ? { raw: { ...field.raw, ...overlay.raw } } : {}),
        ...(overlay.display ? { display: { ...field.display, ...overlay.display } } : {}),
        ...(overlay.disabledValue ? { disabledValue: { ...field.disabledValue, ...overlay.disabledValue } } : {}),
        ...(overlay.ui ? { ui: { ...field.ui, ...overlay.ui } } : {})
    };
}

export function resolveSchema (schema: EepromSchema, context: SchemaContext): ResolvedSchema {
    assertLanguageVersion(schema.version);
    compareFirmware(context.firmware, context.firmware);
    const fields: ResolvedSchema['fields'] = Object.create(null);
    const aliases: ResolvedSchema['aliases'] = Object.create(null);
    for (const [key, source] of Object.entries(schema.fields)) {
        if (!applies(source, context)) { continue; }
        let field = mergeField(source, source.versions?.default ?? {});
        const overlays = Object.entries(source.versions ?? {});
        const layoutOverlays = overlays.filter(([key]) => /^eeprom:\d+\+$/.test(key))
            .sort(([a], [b]) => Number(a.slice(7, -1)) - Number(b.slice(7, -1)));
        const firmwareOverlays = overlays.filter(([key]) => /^firmware:\d+\.\d+\+$/.test(key))
            .sort(([a], [b]) => compareFirmware(a.slice(9, -1), b.slice(9, -1)));
        for (const [key, overlay] of layoutOverlays) {
            if (Number(key.slice(7, -1)) <= context.layout) { field = mergeField(field, overlay); }
        }
        for (const [key, overlay] of firmwareOverlays) {
            if (compareFirmware(key.slice(9, -1), context.firmware) <= 0) { field = mergeField(field, overlay); }
        }
        const resolved = { ...field, key };
        fields[key] = resolved;
        if (field.alias?.[0]) { aliases[field.alias[0]] = resolved; }
    }
    // CAN remains opaque to host writes, including its eight reserved bytes.
    aliases.CAN_SETTINGS = { key: 'CAN_SETTINGS', offset: 176, size: 16, type: 'reserved', alias: ['CAN_SETTINGS'], preserveOnDefaults: true, hidden: true };
    const order = [...new Set([...(schema.groupOrder ?? []), ...Object.keys(schema.groups)])];
    const groups = order.flatMap((key) => {
        const group = schema.groups[key];
        if (!group || !applies(group, context)) { return []; }
        return [{ ...group, key, fields: group.fields.filter(field => fields[field] !== undefined) }];
    });
    return { version: schema.version, bufferSize: schema.bufferSize, context: { ...context }, fields, aliases, groups };
}

export function fromRaw (field: SchemaField, raw: number): number {
    return raw * (field.display?.factor ?? 1) + (field.display?.offset ?? 0);
}

/** UI conversion rounds; production factory encoders separately require exact round-trip. */
export function toRaw (field: SchemaField, display: number): number {
    if (!Number.isFinite(display)) { throw new RangeError('Display value must be finite'); }
    return Math.round((display - (field.display?.offset ?? 0)) / (field.display?.factor ?? 1));
}

export function isDisabledRaw (field: SchemaField, raw: number): boolean {
    return field.disabledValue !== undefined && (raw === field.disabledValue.raw ||
        (field.raw?.min !== undefined && raw < field.raw.min) ||
        (field.raw?.max !== undefined && raw > field.raw.max));
}

/** Firmware identity remains protected even if a future document omits its flag. */
export function isPreservedOnDefaults (field: SchemaField): boolean {
    return field.preserveOnDefaults === true || field.offset < 5 || (field.offset >= 176 && field.offset < 184);
}

export function fieldDefaultRaw (field: SchemaField): number | number[] | undefined {
    const raw = field.default?.raw;
    return typeof raw === 'number' && isDisabledRaw(field, raw) ? field.disabledValue!.raw : raw;
}

export function evaluatePredicate (
    predicate: SchemaPredicate | undefined,
    settings: Record<string, number | number[] | Uint8Array | undefined>,
    resolved: ResolvedSchema
): boolean {
    if (!predicate) { return true; }
    if ('all' in predicate) { return predicate.all.every(item => evaluatePredicate(item, settings, resolved)); }
    if ('any' in predicate) { return predicate.any.some(item => evaluatePredicate(item, settings, resolved)); }
    const alias = resolved.fields[predicate.field]?.alias?.[0];
    const value = alias ? settings[alias] : undefined;
    if (typeof value !== 'number') { return false; }
    switch (predicate.op) {
    case 'eq': return value === predicate.raw;
    case 'ne': return value !== predicate.raw;
    case 'gt': return value > predicate.raw;
    case 'lt': return value < predicate.raw;
    }
}

function assertLanguageVersion (version: string): void {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || Number(version.split('.')[0]) !== SUPPORTED_SCHEMA_MAJOR) {
        throw new Error(`Unsupported EEPROM schema language '${String(version)}'`);
    }
}

function object (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate untrusted release metadata before it can choose writable offsets. */
export function validateSchema (value: unknown): asserts value is EepromSchema {
    if (!object(value)) { throw new Error('EEPROM schema must be an object'); }
    assertLanguageVersion(value.version as string);
    if (value.bufferSize !== 192 || !object(value.fields) || !object(value.groups) || !object(value.eepromVersions)) {
        throw new Error('EEPROM schema needs fields, groups, eepromVersions and bufferSize 192');
    }
    const schema = value as unknown as EepromSchema;
    const aliases = new Set<string>();
    const counts = new Map<string, number>();
    const fields = Object.entries(schema.fields);
    if (fields.length === 0) { throw new Error('EEPROM schema has no fields'); }
    const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
    const bounds = (item: SchemaField | SchemaGroup, name: string) => {
        for (const bound of [item.minEepromVersion, item.maxEepromVersion]) {
            if (bound !== undefined && (!integer(bound) || bound < 0 || bound > 255)) { throw new Error(`${name}: invalid layout bound`); }
        }
        for (const bound of [item.minFirmwareVersion, item.maxFirmwareVersion]) {
            if (bound !== undefined) { compareFirmware(bound, bound); }
        }
        if ((item.minEepromVersion ?? 0) > (item.maxEepromVersion ?? 255) ||
            compareFirmware(item.minFirmwareVersion ?? '0.0', item.maxFirmwareVersion ?? '65535.65535') > 0) {
            throw new Error(`${name}: reversed version bounds`);
        }
    };
    const predicate = (p: unknown, depth = 0): void => {
        if (!object(p) || depth > 32) { throw new Error('Invalid schema predicate'); }
        if ('all' in p || 'any' in p) {
            if (('all' in p && 'any' in p) || 'field' in p) { throw new Error('Ambiguous schema predicate'); }
            const items = p.all ?? p.any;
            if (!Array.isArray(items) || items.length === 0) { throw new Error('Empty schema predicate'); }
            for (const item of items) { predicate(item, depth + 1); }
        } else if (typeof p.field !== 'string' || !Object.hasOwn(schema.fields, p.field) || !['eq', 'ne', 'gt', 'lt'].includes(p.op as string) || !integer(p.raw)) {
            throw new Error('Invalid schema predicate leaf');
        }
    };
    const metadata = (item: Partial<SchemaField>, storage?: SchemaField): void => {
        const signed = storage?.type.startsWith('int') ?? false;
        const bits = (storage?.size ?? 1) * 8;
        const minimum = signed ? -(2 ** (bits - 1)) : 0;
        const maximum = 2 ** (bits - (signed ? 1 : 0)) - 1;
        const representable = (raw: unknown): boolean => integer(raw) && raw >= minimum && raw <= maximum;
        if (storage) {
            const values = [item.raw?.min, item.raw?.max, item.disabledValue?.raw, ...(Array.isArray(item.values) ? item.values.map(v => v?.raw) : [])];
            if (values.some(raw => raw !== undefined && !representable(raw))) { throw new Error('Raw metadata exceeds storage width'); }
        }
        for (const range of [item.raw, item.display]) {
            if (range !== undefined && (!object(range) || Object.values(range).some(n => typeof n !== 'number' || !Number.isFinite(n)))) {
                throw new Error('Invalid schema range/display');
            }
            if (typeof range?.min === 'number' && typeof range.max === 'number' && range.min > range.max) { throw new Error('Reversed schema range'); }
        }
        if (item.display?.factor === 0) { throw new Error('Display factor must be nonzero'); }
        if (item.values !== undefined && (!Array.isArray(item.values) || item.values.some(v => !object(v) || !integer(v.raw) || typeof v.name !== 'string'))) {
            throw new Error('Invalid enum values');
        }
        if (item.disabledValue !== undefined && (!object(item.disabledValue) || !integer(item.disabledValue.raw))) { throw new Error('Invalid disabled value'); }
        if (item.ui !== undefined) {
            if (!object(item.ui)) { throw new Error('Invalid UI metadata'); }
            if (item.ui.widget !== undefined && (typeof item.ui.widget !== 'string' || !['checkbox', 'slider', 'select', 'radio', 'rtttl'].includes(item.ui.widget))) { throw new Error('Invalid UI widget'); }
            if (item.ui.visibleWhen !== undefined) { predicate(item.ui.visibleWhen); }
            if (item.ui.disabledWhen !== undefined) { predicate(item.ui.disabledWhen); }
        }
    };
    const widths: Record<string, number> = { uint8: 1, int8: 1, bool: 1, enum: 1, number: 1, uint16: 2, int16: 2, uint32: 4, int32: 4 };
    for (const [key, field] of fields) {
        if (!object(field) || !integer(field.offset) || !integer(field.size) || field.offset < 0 || field.size < 1 || field.offset + field.size > schema.bufferSize) {
            throw new Error(`${key}: field outside EEPROM image`);
        }
        if (!(field.type in widths) && !['number', 'reserved', 'bluejay'].includes(field.type)) { throw new Error(`${key}: invalid storage type`); }
        if ((widths[field.type] && field.size !== widths[field.type]) || (field.type === 'number' && field.size !== 1)) { throw new Error(`${key}: invalid storage width`); }
        bounds(field, key); metadata(field, field);
        for (const flag of ['hidden', 'readOnly', 'preserveOnDefaults'] as const) {
            if (field[flag] !== undefined && typeof field[flag] !== 'boolean') { throw new Error(`${key}: invalid ${flag}`); }
        }
        for (const textKey of ['name', 'description', 'unit'] as const) {
            if (field[textKey] !== undefined && typeof field[textKey] !== 'string') { throw new Error(`${key}: invalid ${textKey}`); }
        }
        if (field.onLoad !== undefined && !['keep', 'clamp', 'disable'].includes(field.onLoad)) { throw new Error(`${key}: invalid onLoad`); }
        if (field.onLoadFallbackRaw !== undefined && !integer(field.onLoadFallbackRaw)) { throw new Error(`${key}: invalid onLoadFallbackRaw`); }
        if (field.default !== undefined) {
            if (!object(field.default)) { throw new Error(`${key}: invalid default`); }
            const raw = field.default.raw;
            if (field.type === 'reserved' || field.type === 'bluejay') {
                if (!Array.isArray(raw) || raw.length !== field.size || raw.some(n => !integer(n) || n < 0 || n > 255)) { throw new Error(`${key}: invalid byte-array default`); }
            } else {
                const signed = field.type.startsWith('int');
                const min = signed ? -(2 ** (field.size * 8 - 1)) : 0;
                const max = 2 ** (field.size * 8 - (signed ? 1 : 0)) - 1;
                if (!integer(raw) || raw < min || raw > max) { throw new Error(`${key}: invalid scalar default`); }
            }
        }
        if (field.alias !== undefined && (!Array.isArray(field.alias) || field.alias.length === 0)) { throw new Error(`${key}: invalid aliases`); }
        for (const alias of field.alias ?? []) {
            if (typeof alias !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(alias) || alias === 'CAN_SETTINGS' || aliases.has(alias)) { throw new Error(`${key}: duplicate or invalid alias ${alias}`); }
            aliases.add(alias);
        }
        if (!field.alias?.length && !field.hidden && field.type !== 'reserved' && !key.startsWith('can')) { throw new Error(`${key}: missing CLI/UI alias`); }
        if (field.versions !== undefined && !object(field.versions)) { throw new Error(`${key}: invalid overlays`); }
        for (const [version, overlay] of Object.entries(field.versions ?? {})) {
            if (!/^(default|eeprom:\d+\+|firmware:\d+\.\d+\+)$/.test(version) || !object(overlay)) { throw new Error(`${key}: invalid overlay ${version}`); }
            if (['offset', 'size', 'type'].some(name => Object.hasOwn(overlay, name))) { throw new Error(`${key}: overlays cannot change storage`); }
            metadata(overlay, field);
        }
    }
    for (let i = 0; i < fields.length; i++) {
        const [name, a] = fields[i]!;
        for (const [other, b] of fields.slice(i + 1)) {
            const bytesOverlap = a.offset < b.offset + b.size && b.offset < a.offset + a.size;
            const layoutsOverlap = (a.minEepromVersion ?? 0) <= (b.maxEepromVersion ?? 255) && (b.minEepromVersion ?? 0) <= (a.maxEepromVersion ?? 255);
            const firmwareOverlap = compareFirmware(a.minFirmwareVersion ?? '0.0', b.maxFirmwareVersion ?? '65535.65535') <= 0 && compareFirmware(b.minFirmwareVersion ?? '0.0', a.maxFirmwareVersion ?? '65535.65535') <= 0;
            if (bytesOverlap && layoutsOverlap && firmwareOverlap) { throw new Error(`${name} overlaps ${other}`); }
        }
    }
    if (schema.groupOrder !== undefined && (!Array.isArray(schema.groupOrder) || new Set(schema.groupOrder).size !== schema.groupOrder.length || schema.groupOrder.some(key => !Object.hasOwn(schema.groups, key)))) { throw new Error('Invalid groupOrder'); }
    for (const [key, group] of Object.entries(schema.groups)) {
        if (!object(group) || typeof group.name !== 'string' || !Array.isArray(group.fields)) { throw new Error(`${key}: invalid group`); }
        bounds(group, key); metadata({ ui: group.ui });
        if (group.panel !== undefined && !['settings', 'tune', 'esc', 'none'].includes(group.panel)) { throw new Error(`${key}: invalid panel`); }
        for (const fieldKey of group.fields) {
            const field = schema.fields[fieldKey];
            if (!Object.hasOwn(schema.fields, fieldKey) || !field) { throw new Error(`${key}: unknown field ${fieldKey}`); }
            if ((group.minEepromVersion ?? 0) > (field.minEepromVersion ?? 0)) { throw new Error(`${key}: group hides older field ${fieldKey}`); }
            counts.set(fieldKey, (counts.get(fieldKey) ?? 0) + 1);
        }
    }
    for (const [key, field] of fields) {
        if (!field.hidden && field.type !== 'reserved' && counts.get(key) !== 1) { throw new Error(`${key}: must belong to exactly one group`); }
    }
    // Current layout must cover every byte. Historic layout holes are deliberately preserved.
    const versions = Object.keys(schema.eepromVersions);
    if (versions.some(key => !/^\d+$/.test(key) || Number(key) > 255)) { throw new Error('Invalid EEPROM versions'); }
    const layout = Math.max(...versions.map(Number));
    if (!Number.isInteger(layout) || layout < 0 || layout > 255) { throw new Error('Invalid EEPROM versions'); }
    let firmware = '32.0';
    for (const [, field] of fields) {
        for (const version of [field.minFirmwareVersion, ...Object.keys(field.versions ?? {}).filter(v => v.startsWith('firmware:')).map(v => v.slice(9, -1))]) {
            if (version && compareFirmware(version, firmware) > 0) { firmware = version; }
        }
    }
    const coverage = new Set<number>();
    for (const field of Object.values(resolveSchema(schema, { layout, firmware }).fields)) {
        for (let offset = field.offset; offset < field.offset + field.size; offset++) { coverage.add(offset); }
    }
    if (coverage.size !== schema.bufferSize) { throw new Error(`EEPROM current layout covers ${coverage.size} of ${schema.bufferSize} bytes`); }
}
