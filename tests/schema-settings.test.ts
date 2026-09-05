import { describe, expect, it } from 'vitest';
import { escSchemaCohorts, panelGroups, portableSettingsPatch, sliderBounds, widgetForField } from '../utils/schema-settings';
import { BUNDLED_SCHEMA, evaluatePredicate, fieldDefaultRaw, fromRaw, isDisabledRaw, resolveSchema, toRaw, validateSchema } from 'am32-core/eeprom/schema';
import type { EepromSchema, ResolvedSchema } from 'am32-core/eeprom/schema';
import { createMcuInfo } from 'am32-core/mcu';

const resolve = (firmware = '32.0', schema: EepromSchema = BUNDLED_SCHEMA) => resolveSchema(schema, { layout: 3, firmware });
const initialSettings = (schema: ResolvedSchema) => Object.fromEntries(Object.entries(schema.aliases).map(([alias, field]) => [alias,
    field.type === 'bluejay' ? Array(field.size).fill(0) : field.default?.raw ?? field.raw?.min ?? 0
]));
const visibleFields = (schema: ResolvedSchema, values: Record<string, number | number[]>) => panelGroups(schema, values, 'settings').flatMap(group => group.fields.map(field => field.key));

describe('schema settings render model', () => {
    it('maps every settings field once, including conditional fields and DroneCAN', () => {
        const schema = resolve();
        const seen = new Set<string>();
        for (const mode of [0, 1, 2]) {
            const settings = { ...initialSettings(schema), LOW_VOLTAGE_CUTOFF: mode };
            const fields = visibleFields(schema, settings);
            expect(new Set(fields).size).toBe(fields.length);
            fields.forEach(key => seen.add(key));
        }
        const expected = schema.groups.filter(group => group.panel === 'settings').flatMap(group => group.fields);
        expect([...seen].sort()).toEqual([...expected].sort());
        expect(expected.every(key => widgetForField(schema.fields[key]))).toBe(true);
        expect(widgetForField(schema.fields.inputType)).toBe('select');
        expect(schema.fields.inputType.values).toContainEqual(expect.objectContaining({ raw: 5, name: 'DroneCAN' }));
    });

    it('shows cell threshold only in cell mode and displays volts', () => {
        const schema = resolve();
        for (const mode of [0, 1, 2]) {
            const fields = visibleFields(schema, { ...initialSettings(schema), LOW_VOLTAGE_CUTOFF: mode });
            expect(fields.includes('lowVoltageThreshold')).toBe(mode === 1);
            expect(fields.includes('absoluteVoltageCutoff')).toBe(mode === 2);
        }
        expect(sliderBounds(schema.fields.lowVoltageThreshold)).toMatchObject({ min: 2.5, max: 3.5, step: 0.01 });
        expect(fromRaw(schema.fields.lowVoltageThreshold, 50)).toBe(3);
    });

    it('disables current PID for canonical off and historical factory sentinel', () => {
        const schema = resolve();
        for (const raw of [0, 1, 100, 101, 102, 255]) {
            const group = panelGroups(schema, { ...initialSettings(schema), CURRENT_LIMIT: raw }, 'settings').find(group => group.key === 'currentControl');
            expect(group?.disabled).toBe(raw === 0 || raw > 100);
            expect(isDisabledRaw(schema.fields.currentLimit, raw)).toBe(raw === 0 || raw > 100);
        }
        expect(fromRaw(schema.fields.currentPidP, 42)).toBe(42);
        expect(fromRaw(schema.fields.currentPidD, 42)).toBe(42);
    });

    it('writes canonical off defaults and rounds display edits', () => {
        const schema = resolve();
        expect(fieldDefaultRaw(schema.fields.temperatureLimit)).toBe(255);
        expect(fieldDefaultRaw(schema.fields.currentLimit)).toBe(0);
        for (const raw of [0, 69, 141, 255]) {
            expect(isDisabledRaw(schema.fields.temperatureLimit, raw)).toBe(true);
        }
        expect(isDisabledRaw(schema.fields.temperatureLimit, 140)).toBe(false);
        expect(toRaw(schema.fields.motorKv, 1020)).toBe(25);
        expect(toRaw(schema.fields.motorKv, 1041)).toBe(26);
        expect(sliderBounds(schema.fields.servoNeutral).max).toBe(1629);
    });

    it('preserves checkbox overrides and car reverse predicate', () => {
        const schema = resolve();
        expect(widgetForField(schema.fields.stallProtection)).toBe('checkbox');
        expect(widgetForField(schema.fields.telemetry30ms)).toBe('checkbox');
        for (const reverse of [0, 1]) {
            for (const brake of [0, 1, 2]) {
                expect(evaluatePredicate(schema.fields.runningBrakeLevel.ui?.disabledWhen,
                    { RC_CAR_REVERSING: reverse, BRAKE_ON_STOP: brake }, schema)).toBe(reverse !== 0);
            }
        }
    });

    it('uses fetched aliases and panel membership without known-key binds', () => {
        const document = structuredClone(BUNDLED_SCHEMA);
        document.fields.futureSetting = {
            offset: 184,
            size: 1,
            type: 'uint8',
            name: 'Future setting',
            alias: ['FUTURE_SETTING'],
            minFirmwareVersion: '32.1',
            raw: { min: 0, max: 10 }
        };
        document.fields.canReserved.offset = 185;
        document.fields.canReserved.size = 7;
        document.groups.essentials.fields.push('futureSetting');
        validateSchema(document);
        const current = resolve('32.1', document);
        const settings: Record<string, number | number[]> = { ...initialSettings(current), FUTURE_SETTING: 5 };
        expect(visibleFields(current, settings)).toContain('futureSetting');
        expect(visibleFields(resolve('32.0', document), settings)).not.toContain('futureSetting');
        expect(panelGroups(current, settings, 'tune').flatMap(group => group.fields.map(field => field.key))).toEqual(['startupMelody']);
        expect(panelGroups(current, settings, 'esc').flatMap(group => group.fields.map(field => field.key))).toEqual(['directionReversed', 'bidirectionalMode']);
        delete settings.STARTUP_MELODY;
        expect(panelGroups(current, settings, 'tune')).toEqual([]);
        document.fields.startupMelody.maxFirmwareVersion = '32.0';
        expect(panelGroups(resolve('32.1', document), initialSettings(current), 'tune')).toEqual([]);
    });

    it('honors nested group predicates and skips empty groups', () => {
        const schema = resolve();
        schema.groups[0].ui = {
            visibleWhen: {
                all: [
                    { field: 'inputType', op: 'eq', raw: 5 },
                    { any: [{ field: 'lowVoltageCutoff', op: 'eq', raw: 1 }, { field: 'lowVoltageCutoff', op: 'eq', raw: 2 }] }
                ]
            }
        };
        const settings = { ...initialSettings(schema), ESC_PROTOCOL: 5, LOW_VOLTAGE_CUTOFF: 1 };
        expect(panelGroups(schema, settings, 'settings')[0].key).toBe(schema.groups[0].key);
        settings.ESC_PROTOCOL = 0;
        expect(panelGroups(schema, settings, 'settings').some(group => group.key === schema.groups[0].key)).toBe(false);
    });

    it('imports only writable aliases present for the target and preserves identity', () => {
        const schema = resolve();
        const patch = {
            BOOT_BYTE: 0,
            LAYOUT_REVISION: 2,
            BOOT_LOADER_REVISION: 255,
            MAIN_REVISION: 2,
            SUB_REVISION: 16,
            CAN_SETTINGS: new Uint8Array(16),
            MOTOR_KV: 25,
            CURRENT_P: 42,
            UNKNOWN_FUTURE_ALIAS: 77
        };
        expect(portableSettingsPatch(patch, schema)).toEqual({ MOTOR_KV: 25, CURRENT_P: 42 });
        const older = resolveSchema(BUNDLED_SCHEMA, { layout: 2, firmware: '2.16' });
        expect(portableSettingsPatch(patch, older)).toEqual({ MOTOR_KV: 25 });
    });

    it('separates mixed firmware so overlays use each ESC version', () => {
        const old = createMcuInfo(new Uint8Array(4));
        const current = createMcuInfo(new Uint8Array(4));
        old.resolvedSchema = resolve('2.16');
        current.resolvedSchema = resolve('32.0');
        const cohorts = escSchemaCohorts([old, current]);
        expect(cohorts).toHaveLength(2);
        expect(cohorts[0].escInfo[0].resolvedSchema?.fields.motorPoles.raw?.max).toBe(64);
        expect(cohorts[1].escInfo[0].resolvedSchema?.fields.motorPoles.raw?.max).toBe(128);
    });
});
