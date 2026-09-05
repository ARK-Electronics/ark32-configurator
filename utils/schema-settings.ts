import { BUNDLED_SCHEMA, contextFromImage, resolveSchema, evaluatePredicate, fromRaw } from 'am32-core/eeprom/schema';
import type { ResolvedField, ResolvedSchema } from 'am32-core/eeprom/schema';
import type { McuInfo } from 'am32-core/mcu';

export type SettingWidget = 'checkbox' | 'select' | 'radio' | 'slider' | 'rtttl';
export interface SettingChange { field: string; value: number | number[]; individual?: number }

export function schemaForEsc (info: McuInfo): ResolvedSchema {
    return info.resolvedSchema ?? resolveSchema(BUNDLED_SCHEMA, contextFromImage(info.settingsBuffer));
}

export function widgetForField (field: ResolvedField): SettingWidget | undefined {
    const widget = field.ui?.widget;
    if (widget && ['checkbox', 'select', 'radio', 'slider', 'rtttl'].includes(widget)) {
        return widget as SettingWidget;
    }
    switch (field.type) {
    case 'bool': return 'checkbox';
    case 'enum': return field.key === 'inputType' ? 'select' : 'radio';
    case 'number':
    case 'uint8':
    case 'int8':
    case 'uint16':
    case 'int16':
    case 'uint32':
    case 'int32': return 'slider';
    case 'bluejay': return 'rtttl';
    default: return undefined;
    }
}

/** The same render model drives every panel; future aliases need no Vue binds. */
export function panelGroups (schema: ResolvedSchema, settings: McuInfo['settings'], panel: string) {
    return schema.groups.filter(group => group.panel === panel &&
        evaluatePredicate(group.ui?.visibleWhen, settings, schema)).map(group => ({
        ...group,
        disabled: group.ui?.disabledWhen ? evaluatePredicate(group.ui.disabledWhen, settings, schema) : false,
        fields: group.fields.map(key => schema.fields[key]).filter((field): field is ResolvedField =>
            !!field && !field.hidden && !field.readOnly && !!field.alias?.[0] &&
            settings[field.alias[0]] !== undefined && !!widgetForField(field) &&
            evaluatePredicate(field.ui?.visibleWhen, settings, schema))
    })).filter(group => group.fields.length > 0);
}

export function sliderBounds (field: ResolvedField) {
    const factor = field.display?.factor ?? 1;
    return {
        min: field.display?.min ?? fromRaw(field, field.raw?.min ?? 0),
        max: field.display?.max ?? fromRaw(field, field.raw?.max ?? 255),
        step: Math.abs(factor),
        decimals: field.display?.decimals ?? Math.min(8, (String(factor).split('.')[1] ?? '').length)
    };
}

/** Keep independently resolved ranges separate on mixed-firmware boards. */
export function escSchemaCohorts (infos: McuInfo[]) {
    const cohorts = new Map<string, { key: string; label: string; escInfo: McuInfo[] }>();
    for (const info of infos) {
        const { context } = schemaForEsc(info);
        const key = `${context.layout}:${context.firmware}`;
        if (!cohorts.has(key)) {
            cohorts.set(key, { key, label: `Firmware ${context.firmware} · EEPROM ${context.layout}`, escInfo: [] });
        }
        cohorts.get(key)!.escInfo.push(info);
    }
    return Array.from(cohorts.values());
}

/** Settings imports never replace board identity or fields absent on this target. */
export function portableSettingsPatch (settings: McuInfo['settings'], schema: ResolvedSchema): McuInfo['settings'] {
    return Object.fromEntries(Object.entries(settings).filter(([alias]) => {
        const field = schema.aliases[alias];
        return field && !field.preserveOnDefaults && !field.readOnly && !field.hidden;
    }));
}
