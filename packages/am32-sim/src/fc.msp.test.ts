/**
 * `SimFc`'s MSP half, and the two FC-level fault knobs that live there.
 *
 * Two of the plan's three named requirements for block 3 are here:
 *  - ArduPilot refuses MSP until its MAVLink-idle gate opens (`fc.mavlinkIdleGate`)
 *  - Betaflight ignores MSP once in passthrough (`fc.blockingFourWay`)
 * plus `fc.mspError`, which pins audit item **D**.
 */

import { describe, expect, it } from 'vitest';
import { Link, LinkError } from 'am32-core/link/link';
import { DEFAULT_TIMEOUT_POLICY } from 'am32-core/link/timeout-policy';
import {
    MSP_COMMANDS,
    MspFrameError,
    encodeMspCommand,
    encodeMspV2,
    isCompleteMspFrame,
    parseMspResponse
} from 'am32-core/framing/msp';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse
} from 'am32-core/framing/fourway';
import { createSimHarness, type SimHarnessOptions } from './harness';

const policy = DEFAULT_TIMEOUT_POLICY;

function rig (options: SimHarnessOptions = {}) {
    const harness = createSimHarness(options);
    const link = new Link(harness.transport, { clock: harness.clock });
    return { ...harness, link };
}

type Rig = ReturnType<typeof rig>;

/** Run one MSP exchange to completion on the virtual clock. */
async function msp (
    h: Rig,
    command: number,
    payload = new Uint8Array(),
    retries = 1
): Promise<{ ok: true, payload: Uint8Array } | { ok: false, error: unknown }> {
    // Two `then`s, not one: a parse failure in the success handler has to land
    // in the rejection handler too, or it escapes as an unhandled rejection.
    const settled = h.link.request(encodeMspCommand(command, payload), {
        probe: isCompleteMspFrame,
        timeout: policy.forMsp(command),
        retries,
        label: `msp ${command}`
    })
        .then(response => parseMspResponse(response, { expectCommand: command }))
        .then(
            frame => ({ ok: true as const, payload: frame.payload }),
            error => ({ ok: false as const, error })
        );
    await h.clock.runAll();
    return settled;
}

/** One 4-way exchange, reduced to the ACK the FC answered with. */
async function fourWayAck (h: Rig, command: FOUR_WAY_COMMANDS, params: number[]): Promise<number | null> {
    const settled = h.link.request(encodeFourWayRequest(command, params, 0), {
        probe: isCompleteFourWayFrame,
        timeout: DEFAULT_TIMEOUT_POLICY.forFourWay(command, params.length),
        retries: 1,
        label: FOUR_WAY_COMMANDS[command] ?? String(command)
    })
        .then(response => parseFourWayResponse(response))
        .then(frame => frame.ack, () => null);
    await h.clock.runAll();
    return settled;
}

describe('SimFc: MSP payloads', () => {
    it('answers MSP_API_VERSION with the profile\'s three bytes', async () => {
        const h = rig({ profile: 'betaflight' });
        await h.open();

        const result = await msp(h, MSP_COMMANDS.MSP_API_VERSION);

        expect(result.ok).toBe(true);
        expect(Array.from((result as { payload: Uint8Array }).payload)).toEqual([0, 1, 46]);
    });

    it('answers MSP_FC_VARIANT with four raw ASCII bytes, no NUL and no length prefix', async () => {
        for (const [profile, variant] of [['ardupilot', 'ARDU'], ['betaflight', 'BTFL']] as const) {
            const h = rig({ profile, escCount: 4 });
            h.fc.mavlinkIdleGate = 0;
            await h.open();

            const result = await msp(h, MSP_COMMANDS.MSP_FC_VARIANT);

            expect(result.ok).toBe(true);
            const payload = (result as { payload: Uint8Array }).payload;
            expect(payload).toHaveLength(4);
            expect(String.fromCharCode(...payload)).toBe(variant);
        }
    });

    it('puts the authoritative motor count in MSP_MOTOR_CONFIG byte 6', async () => {
        const h = rig({ profile: 'betaflight', escCount: 6 });
        await h.open();

        const result = await msp(h, MSP_COMMANDS.MSP_MOTOR_CONFIG);

        expect(result.ok).toBe(true);
        const payload = (result as { payload: Uint8Array }).payload;
        expect(payload).toHaveLength(10);
        expect(payload[6]).toBe(6);
    });

    it('makes MSP_MOTOR untrustworthy in exactly the way each firmware is', async () => {
        // ArduPilot reports zeros with mixed_type outputs; Betaflight idles at
        // 1000 and pads to eight slots either way. Neither is a motor count.
        const ardu = rig({ profile: 'ardupilot', escCount: 4 });
        ardu.fc.mavlinkIdleGate = 0;
        await ardu.open();
        const arduMotors = await msp(ardu, MSP_COMMANDS.MSP_MOTOR);
        expect(Array.from((arduMotors as { payload: Uint8Array }).payload)).toEqual(new Array(16).fill(0));

        const bf = rig({ profile: 'betaflight', escCount: 4 });
        await bf.open();
        const bfMotors = await msp(bf, MSP_COMMANDS.MSP_MOTOR);
        const payload = (bfMotors as { payload: Uint8Array }).payload;
        expect(payload).toHaveLength(16);
        // Four enabled motors idling at 1000, four padded zeros.
        expect(Array.from(payload.slice(0, 8))).toEqual([0xE8, 0x03, 0xE8, 0x03, 0xE8, 0x03, 0xE8, 0x03]);
        expect(Array.from(payload.slice(8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('answers MSP_SET_PASSTHROUGH with the motor count and enters passthrough', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        await h.open();

        const result = await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH);

        expect(Array.from((result as { payload: Uint8Array }).payload)).toEqual([4]);
        expect(h.fc.inPassthrough).toBe(true);
    });

    it('accepts MSP v2 on Betaflight and mirrors the version, but not on ArduPilot', async () => {
        const bf = rig({ profile: 'betaflight' });
        await bf.open();
        const v2 = bf.link.request(encodeMspV2(MSP_COMMANDS.MSP_FC_VARIANT), {
            probe: isCompleteMspFrame,
            timeout: policy.forMsp(MSP_COMMANDS.MSP_FC_VARIANT),
            retries: 1,
            label: 'v2'
        });
        const settled = v2.then(r => parseMspResponse(r), e => e);
        await bf.clock.runAll();
        const frame = await settled;
        expect((frame as { version: number }).version).toBe(2);

        // ArduPilot's parser has no '$X' branch at all (AP:197-205), so the
        // frame is discarded byte by byte and nothing comes back.
        const ardu = rig({ profile: 'ardupilot' });
        ardu.fc.mavlinkIdleGate = 0;
        await ardu.open();
        const dropped = ardu.link.request(encodeMspV2(MSP_COMMANDS.MSP_FC_VARIANT), {
            probe: isCompleteMspFrame,
            timeout: policy.forMsp(MSP_COMMANDS.MSP_FC_VARIANT),
            retries: 1,
            label: 'v2'
        }).then(() => null, (e: LinkError) => e);
        await ardu.clock.runAll();
        expect(((await dropped) as LinkError).reason).toBe('timeout');
    });
});

describe('fault knob: fc.mavlinkIdleGate', () => {
    it('refuses MSP until the gate opens, and an early request does not push it back', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        await h.open();

        expect(h.fc.mavlinkIdleGate).toBe(4000);
        expect(h.fc.mspAvailable).toBe(false);

        // Polling during the window is the whole point of a probe-then-wait
        // connect. The bytes are read (GCS:1943) and offered to the MAVLink
        // parser (GCS:1970), which rejects them -- only MAVLINK_FRAMING_OK
        // re-arms the timer (GCS:1974-1977) -- so they cost nothing but the
        // requests themselves.
        const early = await msp(h, MSP_COMMANDS.MSP_API_VERSION);
        expect(early.ok).toBe(false);
        expect(((early as { error: LinkError }).error).reason).toBe('timeout');
        expect(h.fc.counts.gatedBytes).toBeGreaterThan(0);
        expect(h.fc.counts.msp).toBe(0);

        // The gate opens on schedule despite that traffic.
        await h.clock.advance(4000 - h.clock.now());
        expect(h.fc.mspAvailable).toBe(true);

        const late = await msp(h, MSP_COMMANDS.MSP_API_VERSION);
        expect(late.ok).toBe(true);
        expect(Array.from((late as { payload: Uint8Array }).payload)).toEqual([0, 1, 42]);
    });

    it('is zero on Betaflight, which answers MSP immediately', async () => {
        const h = rig({ profile: 'betaflight' });
        await h.open();

        expect(h.fc.mavlinkIdleGate).toBe(0);
        expect(h.fc.mspAvailable).toBe(true);

        const result = await msp(h, MSP_COMMANDS.MSP_API_VERSION);

        expect(result.ok).toBe(true);
        // The whole exchange costs wire time only -- nowhere near ArduPilot's
        // 4 s, which is what makes the unconditional 4.5 s wait a pure tax on
        // every Betaflight connect (audit H).
        expect(h.clock.now()).toBeLessThan(100);
    });

    it('re-arms from now when assigned, modelling a GCS frame taking the port back', async () => {
        const h = rig({ profile: 'ardupilot' });
        h.fc.mavlinkIdleGate = 0;
        await h.open();
        expect((await msp(h, MSP_COMMANDS.MSP_API_VERSION)).ok).toBe(true);

        h.fc.mavlinkIdleGate = 4000;
        expect(h.fc.mspAvailable).toBe(false);
        expect((await msp(h, MSP_COMMANDS.MSP_API_VERSION)).ok).toBe(false);
    });
});

describe('fault knob: fc.blockingFourWay', () => {
    it('makes Betaflight ignore MSP once in passthrough, until cmd_InterfaceExit', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        await h.open();

        expect(h.fc.blockingFourWay).toBe(true);
        expect((await msp(h, MSP_COMMANDS.MSP_API_VERSION)).ok).toBe(true);

        expect((await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH)).ok).toBe(true);
        expect(h.fc.inPassthrough).toBe(true);

        // esc4wayProcess never returns to the MSP parser (BF:453): the frame is
        // eaten byte by byte by the resync loop and nothing comes back.
        const answered = h.fc.counts.msp;
        const blocked = await msp(h, MSP_COMMANDS.MSP_API_VERSION);
        expect(blocked.ok).toBe(false);
        expect(((blocked as { error: LinkError }).error).reason).toBe('timeout');
        expect(h.fc.counts.msp).toBe(answered);

        // 4-way still works while MSP does not.
        const exited = h.link.request(
            encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceExit, [0], 0),
            {
                probe: isCompleteFourWayFrame,
                timeout: policy.forFourWay(FOUR_WAY_COMMANDS.cmd_InterfaceExit),
                retries: 1,
                label: 'exit'
            }
        ).then(() => true, () => false);
        await h.clock.runAll();
        expect(await exited).toBe(true);
        expect(h.fc.inPassthrough).toBe(false);

        expect((await msp(h, MSP_COMMANDS.MSP_API_VERSION)).ok).toBe(true);
    });

    it('is off on ArduPilot, which multiplexes MSP and 4-way on the same port', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        h.fc.mavlinkIdleGate = 0;
        await h.open();

        expect(h.fc.blockingFourWay).toBe(false);
        expect((await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH)).ok).toBe(true);
        expect(h.fc.inPassthrough).toBe(true);

        // A '$' between 4-way frames escapes back to MSP (AP:1242-1246).
        const during = await msp(h, MSP_COMMANDS.MSP_API_VERSION);
        expect(during.ok).toBe(true);
    });
});

describe('fault knob: fc.mspError', () => {
    it('makes Betaflight answer with a $M! frame, which must not parse as success', async () => {
        const h = rig({ profile: 'betaflight' });
        await h.open();
        h.fc.mspError(MSP_COMMANDS.MSP_API_VERSION);

        const result = await msp(h, MSP_COMMANDS.MSP_API_VERSION);

        expect(result.ok).toBe(false);
        const error = (result as { error: unknown }).error;
        // The frame is structurally complete, so the probe fires and the link
        // hands it up -- rejecting it is the parser's job, and the old one
        // treated '<', '>' and '!' identically (audit D).
        expect(error).toBeInstanceOf(MspFrameError);
        expect((error as MspFrameError).reason).toBe('error-frame');

        h.fc.clearMspError();
        expect((await msp(h, MSP_COMMANDS.MSP_API_VERSION)).ok).toBe(true);
    });

    it('makes ArduPilot answer MSP_SET_PASSTHROUGH with command 0x0F, caught by the echo check', async () => {
        // ArduPilot has no error frame. Its one failure reply is
        // msp_send_ack(ACK_D_GENERAL_ERROR) (AP:593-595) -- a normal '$M>' frame
        // whose command field is 0x0F rather than 245. Only a command-echo check
        // catches that, which is the other half of audit D.
        const h = rig({ profile: 'ardupilot' });
        h.fc.mavlinkIdleGate = 0;
        await h.open();
        h.fc.mspError(MSP_COMMANDS.MSP_SET_PASSTHROUGH);

        const result = await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH);

        expect(result.ok).toBe(false);
        const error = (result as { error: unknown }).error;
        expect(error).toBeInstanceOf(MspFrameError);
        expect((error as MspFrameError).reason).toBe('echo');
        expect(h.fc.inPassthrough).toBe(false);
    });

    it('makes ArduPilot silent for any other command, since it has no error frame', async () => {
        const h = rig({ profile: 'ardupilot' });
        h.fc.mavlinkIdleGate = 0;
        await h.open();
        h.fc.mspError(MSP_COMMANDS.MSP_API_VERSION);

        const result = await msp(h, MSP_COMMANDS.MSP_API_VERSION);

        expect(result.ok).toBe(false);
        expect(((result as { error: LinkError }).error).reason).toBe('timeout');
    });
});

describe('SimFc: the motor count is not the ESC count', () => {
    it('gates 4-way channels on num_motors, not on how many ESCs are wired up', async () => {
        // `initFlash`/`deviceReset` check against MSP_MOTOR_CONFIG byte 6, which
        // is the FC's own num_motors -- not the number of ESCs the simulator
        // happens to hold. Betaflight `escCount` and ArduPilot `num_motors` are
        // both derived from the output configuration, so they can be lower.
        const h = rig({ profile: 'betaflight', escCount: 4, motorCount: 2 });
        await h.open();

        const config = await msp(h, MSP_COMMANDS.MSP_MOTOR_CONFIG);
        expect((config as { payload: Uint8Array }).payload[6]).toBe(2);

        expect((await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH)).ok).toBe(true);

        const ok = await fourWayAck(h, FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [1]);
        expect(ok).toBe(FOUR_WAY_ACK.ACK_OK);

        // Channel 2 exists as a SimEsc but is above num_motors, so it must be
        // refused rather than enumerated.
        const refused = await fourWayAck(h, FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [2]);
        expect(refused).toBe(FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
        expect(h.escs[2]!.isConnected).toBe(false);

        expect(await fourWayAck(h, FOUR_WAY_COMMANDS.cmd_DeviceReset, [2]))
            .toBe(FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
    });

    it('reports zero motors and still enters passthrough, which is the Betaflight trap', async () => {
        // `esc4wayInit` returning 0 does not stop msp.c:330-332 from installing
        // esc4wayProcess, so the FC tells you there are no ESCs and then traps
        // itself in 4-way anyway. Block 4 should exit rather than give up.
        const h = rig({ profile: 'betaflight', escCount: 4, motorCount: 0 });
        await h.open();

        const reply = await msp(h, MSP_COMMANDS.MSP_SET_PASSTHROUGH);
        expect(Array.from((reply as { payload: Uint8Array }).payload)).toEqual([0]);
        expect(h.fc.inPassthrough).toBe(true);

        expect(await fourWayAck(h, FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [0]))
            .toBe(FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
        // And MSP is gone until cmd_InterfaceExit, so the host cannot re-probe.
        expect((await msp(h, MSP_COMMANDS.MSP_API_VERSION)).ok).toBe(false);
    });

    it('reports an ArduPilot analog-PWM board as zero motors while MSP_MOTOR still returns 16 bytes', async () => {
        // num_motors is built only from digital_mask (AP:1500-1505), so byte 6
        // can legitimately be 0 on a flying aircraft. MSP_MOTOR still answers
        // with eight padded slots, which is why it is not a motor count.
        const h = rig({ profile: 'ardupilot', escCount: 4, motorCount: 0 });
        h.fc.mavlinkIdleGate = 0;
        await h.open();

        const config = await msp(h, MSP_COMMANDS.MSP_MOTOR_CONFIG);
        expect((config as { payload: Uint8Array }).payload[6]).toBe(0);

        const motors = await msp(h, MSP_COMMANDS.MSP_MOTOR);
        expect((motors as { payload: Uint8Array }).payload).toHaveLength(16);
    });
});

describe('SimFc: MSP_BATTERY_STATE', () => {
    it('lays out the eleven bytes the way both firmwares do', async () => {
        const h = rig({
            profile: 'betaflight',
            battery: { cells: 6, capacityMah: 2200, voltage: 24.6, mahDrawn: 780, current: 12.5 }
        });
        await h.open();

        const payload = (await msp(h, MSP_COMMANDS.MSP_BATTERY_STATE) as { payload: Uint8Array }).payload;

        expect(payload).toHaveLength(11);
        expect(payload[0]).toBe(6);
        expect(payload[1]! | (payload[2]! << 8)).toBe(2200);
        expect(payload[3]).toBe(246); // legacy 0.1 V
        expect(payload[4]! | (payload[5]! << 8)).toBe(780);
        expect(payload[6]! | (payload[7]! << 8)).toBe(1250); // 0.01 A
        expect(payload[8]).toBe(0); // OK / healthy
        expect(payload[9]! | (payload[10]! << 8)).toBe(2460); // 0.01 V
    });

    it('reports no battery as cell count zero and the not-present state', async () => {
        const h = rig({ profile: 'betaflight', battery: { cells: 0, voltage: 0 } });
        await h.open();

        const payload = (await msp(h, MSP_COMMANDS.MSP_BATTERY_STATE) as { payload: Uint8Array }).payload;

        expect(payload[0]).toBe(0);
        expect(payload[8]).toBe(3); // BATTERY_NOT_PRESENT
    });
});
