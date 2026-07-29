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
import { FOUR_WAY_COMMANDS, encodeFourWayRequest, isCompleteFourWayFrame } from 'am32-core/framing/fourway';
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
        // connect: the bytes are read and dropped, and crucially they do NOT
        // reset ArduPilot's idle timer (GCS:1943,1970-1977).
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
