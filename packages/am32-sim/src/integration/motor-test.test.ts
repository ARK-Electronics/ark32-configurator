/**
 * `Am32Session`'s motor test end to end against the simulated FC and ESCs.
 *
 * The keepalive never stops on its own, so nothing here uses `runAll`: time
 * moves with `advance`, or with `drive`, which stops once its promise settles.
 */

import { describe, expect, it } from 'vitest';
import type { VirtualClock } from 'am32-core/clock';
import { EepromLayout } from 'am32-core/eeprom/layout';
import { MSP_COMMANDS } from 'am32-core/framing/msp';
import { Am32Session, SessionError, type MotorTestStatus } from 'am32-core/session';
import { createSimHarness, type SimHarness, type SimHarnessOptions } from '../harness';

async function drive<T> (clock: VirtualClock, work: Promise<T>): Promise<T> {
    const status = { settled: false };
    const tracked = work.finally(() => {
        status.settled = true;
    });
    tracked.catch(() => {});
    while (!status.settled) {
        if (!await clock.advanceToNextTimer() && !status.settled) {
            throw new Error('drive: the virtual clock ran dry before the promise settled');
        }
    }
    return tracked;
}

interface Rig extends SimHarness {
    session: Am32Session
    statuses: MotorTestStatus[]
}

function rig (options: SimHarnessOptions = {}): Rig {
    const harness = createSimHarness({ profile: 'betaflight', escCount: 4, ...options });
    const session = new Am32Session({ transport: harness.transport, clock: harness.clock });
    const statuses: MotorTestStatus[] = [];
    session.on('motors', status => statuses.push(status));
    return { ...harness, session, statuses };
}

/** Connected and enumerated, so every ESC is in its bootloader. */
async function afterSettings (options: SimHarnessOptions = {}): Promise<Rig> {
    const h = rig(options);
    await drive(h.clock, h.session.connect());
    await drive(h.clock, h.session.enumerate());
    expect(h.escs.every(esc => esc.inBootloader)).toBe(true);
    return h;
}

async function running (options: SimHarnessOptions = {}): Promise<Rig> {
    const h = await afterSettings(options);
    await drive(h.clock, h.session.startMotorTest());
    return h;
}

const spins = (h: Rig): number[] => h.escs.map((_, i) => h.fc.escSpin(i));

function expectMotorTestError (call: () => void): void {
    expect(call).toThrow(SessionError);
    try {
        call();
    } catch (error) {
        expect((error as SessionError).reason).toBe('motor-test');
    }
}

describe('motor test: start', () => {
    it('leaves passthrough, resets every ESC, and is ready only once they have armed', async () => {
        const h = await afterSettings();

        await drive(h.clock, h.session.startMotorTest());

        expect(h.session.state).toBe('motor-test');
        expect(h.session.inPassthrough).toBe(false);
        expect(h.escs.every(esc => !esc.inBootloader && esc.isArmed(h.clock.now()))).toBe(true);
        expect(h.statuses.map(s => s.phase)).toEqual(['starting', 'ready']);
        expect(h.session.motors).toMatchObject({ phase: 'ready', unlocked: false, responding: true, throttle: [0, 0, 0, 0] });
        expect(h.fc.armingDisabledByMsp).toBe(true);
    });

    it('refuses throttle until unlocked, then spins exactly the channel asked for', async () => {
        const h = await running();

        expectMotorTestError(() => h.session.setMotorThrottle(1, 250));

        h.session.unlockMotors();
        h.session.setMotorThrottle(1, 250);
        await h.clock.advance(50);
        expect(spins(h)).toEqual([0, 250, 0, 0]);

        h.session.setAllMotorThrottle(100);
        await h.clock.advance(50);
        expect(spins(h)).toEqual([100, 100, 100, 100]);
    });

    it('refuses on ArduPilot without sending MSP_SET_MOTOR', async () => {
        const h = rig({ profile: 'ardupilot' });
        await drive(h.clock, h.session.connect());

        const failure = await drive(h.clock, h.session.startMotorTest()).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(SessionError);
        expect((failure as SessionError).reason).toBe('motor-test');
        expect((failure as Error).message).toMatch(/DShot zero/);
        expect(h.fc.counts.setMotor).toBe(0);
        expect(h.session.state).toBe('connected');
    });
});

describe('motor test: keepalive', () => {
    it('resends the throttle while it runs', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setMotorThrottle(0, 200);

        const before = h.fc.counts.setMotor;
        await h.clock.advance(2000);

        expect(h.fc.counts.setMotor - before).toBeGreaterThanOrEqual(15);
        expect(h.fc.escSpin(0)).toBe(200);
    });

    it('stops every motor and relocks on a lost exchange, and the next stop lands', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setAllMotorThrottle(300);
        await h.clock.advance(150);
        expect(spins(h)).toEqual([300, 300, 300, 300]);

        // Everything the host sends vanishes on its way to the FC.
        h.transport.faults.dropBytes(1_000_000, { direction: 'tx' });
        await h.clock.advance(3000);

        expect(h.session.motors).toMatchObject({ unlocked: false, responding: false, throttle: [0, 0, 0, 0] });
        expect(h.session.motors.error).toMatch(/MSP_SET_MOTOR failed/);
        expectMotorTestError(() => h.session.unlockMotors());
        // Betaflight keeps the last value it accepted (msp.c:3308-3315).
        expect(spins(h)).toEqual([300, 300, 300, 300]);

        h.transport.faults.clear();
        await h.clock.advance(1500);

        expect(spins(h)).toEqual([0, 0, 0, 0]);
        expect(h.session.motors.responding).toBe(true);
        h.session.unlockMotors();
        expect(h.session.motors.error).toBeUndefined();
    });

    it('stops every motor and relocks when the FC refuses a frame', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setMotorThrottle(2, 400);
        await h.clock.advance(150);

        h.fc.mspError(MSP_COMMANDS.MSP_SET_MOTOR);
        await h.clock.advance(1000);

        expect(h.session.motors).toMatchObject({ unlocked: false, responding: false, throttle: [0, 0, 0, 0] });
        expectMotorTestError(() => h.session.setMotorThrottle(2, 400));

        // Betaflight refused the frames, so the motor runs on until one lands.
        expect(h.fc.escSpin(2)).toBe(400);
        h.fc.clearMspError();
        await h.clock.advance(1000);
        expect(h.fc.escSpin(2)).toBe(0);
    });
});

describe('motor test: stopping', () => {
    it('Stop zeroes and relocks at once, and the frame goes out straight away', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setAllMotorThrottle(300);
        await h.clock.advance(150);

        h.session.stopMotors();
        expect(h.session.motors).toMatchObject({ unlocked: false, throttle: [0, 0, 0, 0] });
        // Well inside one keepalive period.
        await h.clock.advance(20);
        expect(spins(h)).toEqual([0, 0, 0, 0]);
        expectMotorTestError(() => h.session.setMotorThrottle(0, 100));
    });

    it('ending sends a stop, goes quiet and re-enables arming', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setAllMotorThrottle(300);
        await h.clock.advance(150);

        await drive(h.clock, h.session.endMotorTest());

        expect(spins(h)).toEqual([0, 0, 0, 0]);
        expect(h.session.state).toBe('connected');
        expect(h.session.motors.phase).toBe('off');
        expect(h.fc.armingDisabledByMsp).toBe(false);
        const sent = h.fc.counts.setMotor;
        await h.clock.advance(2000);
        expect(h.fc.counts.setMotor).toBe(sent);
    });

    it('ending during the arming wait cuts it short and never becomes ready', async () => {
        const h = await afterSettings();
        const start = h.session.startMotorTest();
        while (h.session.motors.phase === 'off') {
            await h.clock.advanceToNextTimer();
        }
        expect(h.session.motors.phase).toBe('starting');

        await drive(h.clock, h.session.endMotorTest());
        await drive(h.clock, start);

        expect(h.statuses.map(s => s.phase)).not.toContain('ready');
        expect(h.session.motors.phase).toBe('off');
    });

    it('disconnecting sends a stop before the port closes', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setAllMotorThrottle(300);
        await h.clock.advance(150);

        await drive(h.clock, h.session.disconnect());

        expect(spins(h)).toEqual([0, 0, 0, 0]);
        expect(h.session.state).toBe('disconnected');
    });

    it('entering passthrough ends the motor test first', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setAllMotorThrottle(300);
        await h.clock.advance(150);

        await drive(h.clock, h.session.enterPassthrough());

        expect(h.session.motors.phase).toBe('off');
        expect(h.session.state).toBe('passthrough');
        expect(h.fc.motorValue(0)).toBe(1000);
    });
});

describe('motor test: reverse direction', () => {
    it('flips one ESC\'s MOTOR_DIRECTION and comes back ready and locked', async () => {
        const h = await running();
        h.session.unlockMotors();
        h.session.setMotorThrottle(1, 300);
        await h.clock.advance(150);
        const offset = h.escs[0]!.eepromOffset + EepromLayout.MOTOR_DIRECTION.offset;
        const before = h.escs.map(esc => esc.peek(offset, 1)[0]);

        const result = await drive(h.clock, h.session.reverseMotorDirection(1));

        expect(result.settings.MOTOR_DIRECTION).toBe(before[1] === 1 ? 0 : 1);
        expect(h.escs.map(esc => esc.peek(offset, 1)[0]))
            .toEqual(before.map((value, i) => (i === 1 ? (value === 1 ? 0 : 1) : value)));
        expect(h.statuses.map(s => s.phase)).toContain('reversing');
        expect(h.session.motors).toMatchObject({ phase: 'ready', unlocked: false, throttle: [0, 0, 0, 0] });
        expect(h.session.state).toBe('motor-test');
        expect(h.escs.every(esc => !esc.inBootloader && esc.isArmed(h.clock.now()))).toBe(true);
        expect(spins(h)).toEqual([0, 0, 0, 0]);
    });

    it('still comes back to the motor test when the write fails', async () => {
        const h = await running();
        h.escs[2]!.unresponsive = true;

        const failure = await drive(h.clock, h.session.reverseMotorDirection(2)).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(SessionError);
        expect(h.session.motors.phase).toBe('ready');
        expect(h.session.state).toBe('motor-test');
    });
});
