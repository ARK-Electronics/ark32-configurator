import { describe, expect, it } from 'vitest';
import { SimEsc } from 'am32-sim/esc';
import { createSimHarness } from 'am32-sim/harness';
import { driveVirtualClock } from '../../../am32-cli/src/sim';
import { parseAssignment, settingFields } from '../../../am32-cli/src/commands/settings';
import { Am32Session } from '../session';
import { BUNDLED_SCHEMA, validateSchema } from './schema';

/** Production session and real 4-way simulator transport, using a fetched alias absent from the bundle. */
describe('runtime schema in mixed ESC sessions', () => {
    it('resolves each ESC and writes new scalar aliases while preserving identity/defaults', async () => {
        const schema = structuredClone(BUNDLED_SCHEMA);
        schema.fields.canReserved = { ...schema.fields.canReserved!, offset: 186, size: 6 };
        schema.fields.oldReserved = { type: 'reserved', offset: 184, size: 2, hidden: true, maxFirmwareVersion: '32.0' };
        schema.fields.futureGain = { type: 'uint16', offset: 184, size: 2, alias: ['FUTURE_GAIN'], name: 'Future gain', minFirmwareVersion: '32.1', default: { raw: 513 } };
        schema.groups.motor!.fields.push('futureGain');
        validateSchema(schema);
        const escs = [new SimEsc({ firmwareVersion: [2, 16] }), new SimEsc({ firmwareVersion: [32, 1] })];
        const h = createSimHarness({ profile: 'betaflight', escs });
        const session = new Am32Session({ transport: h.transport, clock: h.clock, schemaInfo: { schema, source: 'fetched', sha256: 'fixture-sha' } });
        const drive = <T>(work: Promise<T>) => driveVirtualClock(h.clock, work);
        const logs: string[] = [];
        session.on('log', event => logs.push(event.message));
        await h.open();
        await drive(session.connect());
        await drive(session.enterPassthrough());
        try {
            const old = await drive(session.readEsc(0));
            const current = await drive(session.readEsc(1));
            expect(old.resolvedSchema!.fields.motorPoles!.raw!.max).toBe(64);
            expect(current.resolvedSchema!.fields.motorPoles!.raw!.max).toBe(128);
            expect(old.settings.FUTURE_GAIN).toBeUndefined();
            expect(current.settings.FUTURE_GAIN).toBe(0);
            const assignment = parseAssignment('FUTURE_GAIN=52,18', settingFields(schema));
            expect(assignment).toEqual({ key: 'FUTURE_GAIN', value: 0x1234 });
            const before = escs[1]!.eeprom;
            const result = await drive(session.writeSettings(1, { ...current.settings, FUTURE_GAIN: 0x1234, MOTOR_KV: 25 }));
            expect(result.verified).toBe(true);
            expect(result.image[26]).toBe(25);
            expect(Array.from(result.image.slice(184, 186))).toEqual([0x34, 0x12]);
            expect(result.image.slice(176, 184)).toEqual(before.slice(176, 184));
            await drive(session.applyDefaults(1));
            const reset = escs[1]!.eeprom;
            expect(Array.from(reset.slice(184, 186))).toEqual([1, 2]);
            expect(reset.slice(176, 184)).toEqual(before.slice(176, 184));
            expect(reset.slice(0, 5)).toEqual(before.slice(0, 5));
            expect(reset[43]).toBe(255);
            expect(reset[44]).toBe(0);
            expect(logs.filter(log => log.startsWith('schema '))).toHaveLength(2);
            expect(logs.some(log => log.includes('fixture-sha (fetched)'))).toBe(true);
        } finally { await drive(session.disconnect()); }
    });
});
