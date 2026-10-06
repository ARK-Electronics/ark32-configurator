/**
 * `SimFc`'s motor outputs and `SimEsc`'s application: what each firmware does
 * with `MSP_SET_MOTOR`, and when an ESC actually turns.
 */

import { describe, expect, it } from 'vitest';
import type { VirtualClock } from 'am32-core/clock';
import { Link } from 'am32-core/link/link';
import { DEFAULT_TIMEOUT_POLICY } from 'am32-core/link/timeout-policy';
import {
    MSP_COMMANDS,
    encodeMspCommand,
    isCompleteMspFrame,
    parseMspResponse
} from 'am32-core/framing/msp';
import {
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    isCompleteFourWayFrame
} from 'am32-core/framing/fourway';
import { createSimHarness, type SimHarnessOptions } from './harness';

function rig (options: SimHarnessOptions = {}) {
    const harness = createSimHarness(options);
    harness.fc.mavlinkIdleGate = 0;
    const link = new Link(harness.transport, { clock: harness.clock });
    return { ...harness, link };
}

type Rig = ReturnType<typeof rig>;

/** Advance the clock only until `work` settles, so later timers stay pending. */
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

/** One MSP exchange: the reply payload, or null for an error frame or silence. */
function msp (h: Rig, command: number, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array | null> {
    const request = h.link.request(encodeMspCommand(command, payload), {
        probe: isCompleteMspFrame,
        timeout: DEFAULT_TIMEOUT_POLICY.forMsp(command),
        retries: 1,
        label: `msp ${command}`
    })
        .then(response => parseMspResponse(response, { expectCommand: command }).payload)
        .then(payload => payload, () => null);
    return drive(h.clock, request);
}

async function fourWay (h: Rig, command: FOUR_WAY_COMMANDS, params: number[] = [0]): Promise<void> {
    const request = h.link.request(encodeFourWayRequest(command, params, 0), {
        probe: isCompleteFourWayFrame,
        timeout: DEFAULT_TIMEOUT_POLICY.forFourWay(command, params.length),
        retries: 1,
        label: FOUR_WAY_COMMANDS[command] ?? String(command)
    }).then(() => undefined, () => undefined);
    await drive(h.clock, request);
}

/** `MSP_SET_MOTOR` payload: one little-endian u16 per value. */
function motors (...values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 2);
    values.forEach((value, i) => {
        bytes[i * 2] = value & 0xFF;
        bytes[i * 2 + 1] = value >> 8;
    });
    return bytes;
}

const u16s = (payload: Uint8Array | null): number[] =>
    Array.from({ length: (payload?.length ?? 0) / 2 }, (_, i) => (payload?.[i * 2] ?? 0) | ((payload?.[i * 2 + 1] ?? 0) << 8));

describe('SimEsc: the motor only turns under its own firmware', () => {
    it('an ESC left in its bootloader never spins; a reset one spins once booted and armed', async () => {
        const h = rig({ profile: 'betaflight', escCount: 2 });
        await h.open();

        expect(await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH)).not.toBeNull();
        expect(h.escs.map(esc => esc.inBootloader)).toEqual([true, true]);

        // Reset ESC 1 only, then leave passthrough.
        await fourWay(h, FOUR_WAY_COMMANDS.cmd_DeviceReset, [0]);
        const resetAt = h.clock.now();
        await fourWay(h, FOUR_WAY_COMMANDS.cmd_InterfaceExit);
        expect(h.escs.map(esc => esc.inBootloader)).toEqual([false, true]);

        // The 1.4 s startup tune, then a second of zero throttle.
        await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1000, 1000));
        await h.clock.advance(resetAt + 2390 - h.clock.now());
        expect(h.escs[0]?.isArmed(h.clock.now())).toBe(false);

        await h.clock.advance(20);
        expect(h.escs[0]?.isArmed(h.clock.now())).toBe(true);
        await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1200, 1200));
        expect(h.fc.escSpin(0)).toBe(200);
        expect(h.fc.escSpin(1)).toBe(0);
    });
});

describe('SimFc: Betaflight motor outputs', () => {
    it('spins on MSP_SET_MOTOR, reads it back on MSP_MOTOR, and holds it with no keepalive', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        await h.open();

        expect(await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1100, 1000, 1500, 2000, 1000, 1000, 1000, 1000)))
            .toEqual(new Uint8Array(0));
        expect(u16s(await msp(h, MSP_COMMANDS.MSP_MOTOR))).toEqual([1100, 1000, 1500, 2000, 0, 0, 0, 0]);
        expect([0, 1, 2, 3].map(i => h.fc.escSpin(i))).toEqual([100, 0, 500, 1000]);

        // No timeout: motor_disarmed[] keeps the last value (mixer_init.c:505-510).
        await h.clock.advance(60_000);
        expect(h.fc.escSpin(0)).toBe(100);
    });

    it('answers an error frame, and applies nothing, when the payload is short of one value per motor', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        await h.open();

        expect(await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1300, 1300, 1300))).toBeNull();
        expect(h.fc.motorValue(0)).toBe(1000);
        expect(h.fc.escSpin(0)).toBe(0);
    });

    it('stops driving the ESCs in passthrough and puts them in their bootloaders', async () => {
        const h = rig({ profile: 'betaflight', escCount: 2 });
        await h.open();
        await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1300, 1300));
        expect(h.fc.escSpin(0)).toBe(300);

        await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH);
        expect(h.fc.signalThrottle(0)).toBeNull();
        expect(h.fc.escSpin(0)).toBe(0);
        expect(h.escs[0]?.inBootloader).toBe(true);
    });

    it('MSP_SET_ARMING_DISABLED sets ARMING_DISABLED_MSP and disarms', async () => {
        const h = rig({ profile: 'betaflight', escCount: 2 });
        await h.open();
        h.fc.armed = true;

        await msp(h, MSP_COMMANDS.MSP_SET_ARMING_DISABLED, Uint8Array.of(1));
        expect(h.fc.armingDisabledByMsp).toBe(true);
        expect(h.fc.armed).toBe(false);

        await msp(h, MSP_COMMANDS.MSP_SET_ARMING_DISABLED, Uint8Array.of(0));
        expect(h.fc.armingDisabledByMsp).toBe(false);
    });
});

describe('SimFc: ArduPilot motor outputs', () => {
    it('acks MSP_SET_MOTOR and reads it back, but sends DShot zero while disarmed', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        await h.open();

        expect(await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1200, 1200, 1200, 1200))).toEqual(new Uint8Array(0));
        expect(u16s(await msp(h, MSP_COMMANDS.MSP_MOTOR))).toEqual([1200, 1200, 1200, 1200, 0, 0, 0, 0]);
        expect(h.fc.signalThrottle(0)).toBe(0);
        expect(h.fc.escSpin(0)).toBe(0);
    });

    it('idles every motor 1000 ms after the last valid MSP frame, and any valid frame extends it', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 2 });
        await h.open();

        await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1200, 1300));
        await h.clock.advance(900);
        // Not MSP_SET_MOTOR: any valid frame refreshes `last_valid_ms`.
        await msp(h, MSP_COMMANDS.MSP_API_VERSION);
        const lastFrameAt = h.clock.now();

        // Well past 1000 ms from MSP_SET_MOTOR, inside 1000 ms of the later frame.
        await h.clock.advance(lastFrameAt + 900 - h.clock.now());
        expect([h.fc.motorValue(0), h.fc.motorValue(1)]).toEqual([1200, 1300]);

        await h.clock.advance(200);
        expect([h.fc.motorValue(0), h.fc.motorValue(1)]).toEqual([1000, 1000]);
    });

    it('ignores every MSP byte while armed', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 2 });
        await h.open();
        h.fc.armed = true;

        expect(await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1200, 1200))).toBeNull();
        expect(h.fc.counts.setMotor).toBe(0);
        expect(h.fc.motorValue(0)).toBe(1000);
    });

    it('acks and ignores MSP_SET_MOTOR with mixed_type outputs', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 2 });
        await h.open();
        h.fc.mixedType = true;

        expect(await msp(h, MSP_COMMANDS.MSP_SET_MOTOR, motors(1200, 1200))).toEqual(new Uint8Array(0));
        expect(h.fc.motorValue(0)).toBe(1000);
    });

    it('does not answer MSP_SET_ARMING_DISABLED', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 2 });
        await h.open();
        expect(await msp(h, MSP_COMMANDS.MSP_SET_ARMING_DISABLED, Uint8Array.of(1))).toBeNull();
    });
});
