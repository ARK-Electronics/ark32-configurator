/**
 * `SimFc`'s 4-way half, driven through the real `Link` and the real framing, and
 * the four ESC-level fault knobs that surface there.
 *
 * The exchanges here mirror what `src/communication/four_way.ts` actually sends,
 * so a change that breaks the app breaks these too.
 */

import { describe, expect, it } from 'vitest';
import { Link, LinkError } from 'am32-core/link/link';
import { DEFAULT_TIMEOUT_POLICY, type FcVariant } from 'am32-core/link/timeout-policy';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    FourWayFrameError,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse,
    type FourWayResponse
} from 'am32-core/framing/fourway';
import {
    MSP_COMMANDS,
    encodeMspCommand,
    isCompleteMspFrame,
    parseMspResponse
} from 'am32-core/framing/msp';
import { EEPROM_SIZE } from 'am32-core/eeprom/layout';
import { createMcuInfo } from 'am32-core/mcu';
import { createSimHarness, type SimHarnessOptions } from './harness';

function rig (options: SimHarnessOptions = {}) {
    const harness = createSimHarness({ profile: 'betaflight', ...options });
    const link = new Link(harness.transport, { clock: harness.clock });
    const variant: FcVariant = harness.fc.profile.name;
    const policy = DEFAULT_TIMEOUT_POLICY.withVariant(variant);
    return { ...harness, link, policy };
}

type Rig = ReturnType<typeof rig>;

/**
 * Open the port and get into passthrough the way the app does. Betaflight will
 * not look at a 4-way frame before `MSP_SET_PASSTHROUGH` -- its MSP parser eats
 * the bytes -- so skipping this step is not a shortcut, it is a different test.
 */
async function connect (h: Rig): Promise<number> {
    h.fc.mavlinkIdleGate = 0;
    await h.open();

    const settled = h.link.request(encodeMspCommand(MSP_COMMANDS.MSP_SET_PASSTHROUGH), {
        probe: isCompleteMspFrame,
        timeout: h.policy.forMsp(MSP_COMMANDS.MSP_SET_PASSTHROUGH),
        retries: 1,
        label: 'passthrough'
    }).then(response => parseMspResponse(response, {
        expectCommand: MSP_COMMANDS.MSP_SET_PASSTHROUGH
    }).payload[0] ?? 0);
    await h.clock.runAll();
    return settled;
}

type Outcome =
    | { ok: true, response: FourWayResponse }
    | { ok: false, error: unknown };

/**
 * One 4-way exchange, shaped exactly like `FourWay.sendWithPromise`: the ACK is
 * checked inside `validate`, so a non-OK ACK is retried like a timeout with a
 * drain in between.
 */
async function fourWay (
    h: Rig,
    command: FOUR_WAY_COMMANDS,
    params: number[] | Uint8Array = [0],
    address = 0,
    options: { retries?: number, payloadBytes?: number } = {}
): Promise<Outcome> {
    let parsed: FourWayResponse | null = null;
    const settled = h.link.request(
        encodeFourWayRequest(command, Array.from(params), address),
        {
            probe: isCompleteFourWayFrame,
            timeout: h.policy.forFourWay(command, options.payloadBytes ?? params.length),
            retries: options.retries ?? 1,
            label: FOUR_WAY_COMMANDS[command] ?? String(command),
            validate: (response) => {
                const decoded = parseFourWayResponse(response);
                if (decoded.ack !== FOUR_WAY_ACK.ACK_OK) {
                    throw new FourWayFrameError('params', `ack ${decoded.ack}`);
                }
                parsed = decoded;
            }
        }
    ).then(
        () => ({ ok: true as const, response: parsed as unknown as FourWayResponse }),
        error => ({ ok: false as const, error })
    );
    await h.clock.runAll();
    return settled;
}

/** The unvalidated frame, for the cases where the ACK itself is the assertion. */
async function raw (
    h: Rig,
    command: FOUR_WAY_COMMANDS,
    params: number[] = [0],
    address = 0
): Promise<FourWayResponse | LinkError> {
    const settled = h.link.request(
        encodeFourWayRequest(command, params, address),
        {
            probe: isCompleteFourWayFrame,
            timeout: h.policy.forFourWay(command, params.length),
            retries: 1,
            label: 'raw'
        }
    ).then(response => parseFourWayResponse(response)).then(r => r, (e: LinkError) => e);
    await h.clock.runAll();
    return settled;
}

const initFlash = (h: Rig, target: number, retries = 1) =>
    fourWay(h, FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [target], 0, { retries });

const readAddress = (h: Rig, address: number, bytes: number, retries = 1) =>
    fourWay(h, FOUR_WAY_COMMANDS.cmd_DeviceRead, [bytes === 256 ? 0 : bytes], address, {
        retries,
        payloadBytes: bytes
    });

describe('SimFc: 4-way device info', () => {
    it('answers cmd_DeviceInitFlash with the four-byte device info the host decodes', async () => {
        const h = rig({ escCount: 4 });
        await connect(h);

        const result = await initFlash(h, 0);

        expect(result.ok).toBe(true);
        const params = (result as { response: FourWayResponse }).response.params;
        expect(params).toHaveLength(4);

        // The FC reverses BootInfo into deviceInfo, so the host reads the
        // signature little-endian out of bytes 0-1 (BFavr:225-227).
        const info = createMcuInfo(params);
        expect(info.meta.signature).toBe(0x1F06);
        expect(info.meta.input).toBe(0x32);
        expect(info.meta.interfaceMode).toBe(4); // imARM_BLB
        expect(h.escs[0]?.isConnected).toBe(true);
    });

    it('rejects a channel above the motor count with ACK_I_INVALID_CHANNEL', async () => {
        for (const profile of ['ardupilot', 'betaflight'] as const) {
            const h = rig({ profile, escCount: 4 });
            await connect(h);

            const response = await raw(h, FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [7]);

            expect(response).not.toBeInstanceOf(LinkError);
            const frame = response as FourWayResponse;
            expect(frame.ack).toBe(FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL);
            expect(frame.params).toHaveLength(1);
            // ArduPilot echoes the requested channel (AP:1060); Betaflight's
            // untouched `Dummy.word = 0` default sends a zero (BF:465-467).
            expect(frame.params[0]).toBe(profile === 'ardupilot' ? 7 : 0);
        }
    });

    it('reads the whole 192-byte EEprom_t back, CAN block included', async () => {
        const h = rig({ escCount: 1 });
        await connect(h);
        await initFlash(h, 0);

        const result = await readAddress(h, h.escs[0]!.eepromOffset, EEPROM_SIZE);

        expect(result.ok).toBe(true);
        const params = (result as { response: FourWayResponse }).response.params;
        expect(params).toHaveLength(EEPROM_SIZE);
        expect(Array.from(params)).toEqual(Array.from(h.escs[0]!.eeprom));
        expect(Array.from(params.slice(176, 184))).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
    });

    it('answers a bad request CRC the way each firmware does', async () => {
        // Betaflight replies ACK_I_INVALID_CRC (BF:487-491); ArduPilot drops the
        // frame in silence (AP:298-300), which is why the host needs a timeout
        // on every request rather than trusting the FC to answer.
        for (const profile of ['betaflight', 'ardupilot'] as const) {
            const h = rig({ profile, escCount: 1 });
            await connect(h);

            const frame = encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, [0], 0);
            frame[frame.length - 1] ^= 0xFF;

            const settled = h.link.request(frame, {
                probe: isCompleteFourWayFrame,
                timeout: h.policy.forFourWay(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive),
                retries: 1,
                label: 'bad crc'
            }).then(r => parseFourWayResponse(r)).then(r => r, (e: LinkError) => e);
            await h.clock.runAll();
            const result = await settled;

            expect(h.fc.counts.badCrc).toBe(1);
            if (profile === 'betaflight') {
                expect((result as FourWayResponse).ack).toBe(FOUR_WAY_ACK.ACK_I_INVALID_CRC);
            } else {
                expect((result as LinkError).reason).toBe('timeout');
            }
        }
    });
});

describe('fault knob: esc[n].unresponsive', () => {
    it('fails only its own target, so a partial enumerate can degrade instead of throwing', async () => {
        const h = rig({ escCount: 4 });
        await connect(h);
        h.escs[3]!.unresponsive = true;

        const results = [];
        for (let target = 0; target < 4; target += 1) {
            results.push(await initFlash(h, target, 2));
        }

        expect(results.map(r => r.ok)).toEqual([true, true, true, false]);
        // Audit B: the failure is a per-target error, and the three good ESCs
        // are still enumerated. Nothing about ESC 3 disturbs 0-2.
        expect(h.escs.slice(0, 3).map(e => e.isConnected)).toEqual([true, true, true]);
        expect(h.escs[3]!.isConnected).toBe(false);
        // Both firmwares retry the bootloader handshake three times per attempt.
        expect(h.escs[3]!.counts.connect).toBe(6);
    });

    it('reports the failure differently on each firmware, and never as ACK_OK', async () => {
        for (const profile of ['ardupilot', 'betaflight'] as const) {
            const h = rig({ profile, escCount: 2 });
            await connect(h);
            // Betaflight leaves bytes 2-3 of the previous connect in place, so
            // give it a previous connect to leave (BF:636-643).
            await initFlash(h, 0);
            h.escs[1]!.unresponsive = true;

            const frame = await raw(h, FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [1]);

            const response = frame as FourWayResponse;
            expect(response.ack).toBe(FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
            expect(response.params).toHaveLength(profile === 'betaflight' ? 4 : 1);
            if (profile === 'betaflight') {
                expect(Array.from(response.params)).toEqual([0, 0, 0x32, 4]);
            } else {
                expect(Array.from(response.params)).toEqual([1]);
            }
        }
    });
});

describe('fault knob: esc[n].slowBy(ms)', () => {
    it('stays inside the derived flash-write timeout but blows the old 200 ms literal', async () => {
        const h = rig({ escCount: 1 });
        await connect(h);
        await initFlash(h, 0);
        h.escs[0]!.slowBy(600);

        const page = new Uint8Array(256).fill(0x5A);
        const derived = h.policy.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWrite, page.length);
        const before = h.clock.now();

        const result = await fourWay(h, FOUR_WAY_COMMANDS.cmd_DeviceWrite, page, 0x2000, {
            payloadBytes: page.length
        });

        const elapsed = h.clock.now() - before;
        expect(result.ok).toBe(true);
        // Audit C: `writeHex(i, hexString, 200)` abandoned an operation the FC
        // itself budgets ~700 ms for. This write takes longer than that literal
        // and still finishes well inside the policy's derivation.
        expect(elapsed).toBeGreaterThan(200);
        expect(elapsed).toBeLessThan(derived);
        expect(derived).toBeGreaterThan(900);
        expect(Array.from(h.escs[0]!.peek(0x2000, 4))).toEqual([0x5A, 0x5A, 0x5A, 0x5A]);
    });

    it('does exceed the read budget when it is slower than the whole derivation', async () => {
        const h = rig({ escCount: 1 });
        await connect(h);
        await initFlash(h, 0);
        h.escs[0]!.slowBy(2000);

        const result = await readAddress(h, h.escs[0]!.eepromOffset, EEPROM_SIZE);

        expect(result.ok).toBe(false);
        expect(((result as { error: LinkError }).error).reason).toBe('timeout');
    });
});

describe('fault knob: esc[n].corruptCrc', () => {
    it('is retried and recovered from, and does not poison the next ESC', async () => {
        const h = rig({ escCount: 2 });
        await connect(h);
        await initFlash(h, 0);
        // Corrupt exactly one reply, so "the retry recovered" is exact rather
        // than a race against the clock.
        h.escs[0]!.corruptCrc = 1;

        const result = await readAddress(h, h.escs[0]!.eepromOffset, EEPROM_SIZE, 3);

        expect(result.ok).toBe(true);
        expect(h.link.stats.attempts).toBeGreaterThanOrEqual(2);
        // A failed attempt marks the line dirty, so the retry drains first --
        // that is what stops a corrupt reply from being read as the next
        // exchange's answer.
        expect(h.link.stats.drains).toBeGreaterThan(0);
        expect(Array.from((result as { response: FourWayResponse }).response.params))
            .toEqual(Array.from(h.escs[0]!.eeprom));

        // The next ESC enumerates cleanly: the corruption did not survive the
        // exchange it belonged to.
        expect((await initFlash(h, 1)).ok).toBe(true);
        expect((await readAddress(h, h.escs[1]!.eepromOffset, EEPROM_SIZE)).ok).toBe(true);
    });

    it('fails the exchange rather than handing up a frame that failed its checksum', async () => {
        const h = rig({ escCount: 1 });
        await connect(h);
        await initFlash(h, 0);
        h.escs[0]!.corruptCrc = true;

        const result = await readAddress(h, h.escs[0]!.eepromOffset, EEPROM_SIZE, 2);

        expect(result.ok).toBe(false);
        const error = (result as { error: LinkError }).error;
        expect(error).toBeInstanceOf(LinkError);
        expect(error.reason).toBe('validate');
        expect(error.attempts).toBe(2);
    });
});

describe('fault knob: esc[n].shortRead', () => {
    it('surfaces as ACK_D_GENERAL_ERROR with one param, never as a short payload', async () => {
        const h = rig({ escCount: 2 });
        await connect(h);
        await initFlash(h, 0);
        h.escs[0]!.shortRead = true;

        const response = await raw(h, FOUR_WAY_COMMANDS.cmd_DeviceRead, [EEPROM_SIZE], h.escs[0]!.eepromOffset);

        const frame = response as FourWayResponse;
        expect(frame.ack).toBe(FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
        // One param byte on both firmwares -- a deterministic zero on
        // Betaflight, uninitialised stack on ArduPilot. Either way it must never
        // be mistaken for a 192-byte settings image.
        expect(frame.params).toHaveLength(1);
        expect(frame.params[0]).toBe(h.fc.profile.failedReadByte);
    });

    it('is retried and does not poison the next ESC', async () => {
        const h = rig({ escCount: 2 });
        await connect(h);
        await initFlash(h, 0);
        h.escs[0]!.shortRead = 8;

        const failed = await readAddress(h, h.escs[0]!.eepromOffset, EEPROM_SIZE, 2);
        expect(failed.ok).toBe(false);
        expect(h.link.stats.drains).toBeGreaterThan(0);

        h.escs[0]!.shortRead = false;
        expect((await readAddress(h, h.escs[0]!.eepromOffset, EEPROM_SIZE)).ok).toBe(true);

        expect((await initFlash(h, 1)).ok).toBe(true);
        const next = await readAddress(h, h.escs[1]!.eepromOffset, EEPROM_SIZE);
        expect(next.ok).toBe(true);
        expect((next as { response: FourWayResponse }).response.params).toHaveLength(EEPROM_SIZE);
    });
});

describe('SimFc: commands the AM32 bootloader does not implement', () => {
    it('never lets cmd_DeviceVerify succeed, because CMD_VERIFY_FLASH_ARM is unimplemented', async () => {
        const h = rig({ escCount: 1 });
        await connect(h);
        await initFlash(h, 0);

        const response = await raw(h, FOUR_WAY_COMMANDS.cmd_DeviceVerify, [0], 0x1000);

        expect((response as FourWayResponse).ack).toBe(FOUR_WAY_ACK.ACK_D_GENERAL_ERROR);
    });

    it('rejects cmd_DeviceReadEEprom and cmd_DeviceEraseAll for an ARM target', async () => {
        const h = rig({ escCount: 1 });
        await connect(h);
        await initFlash(h, 0);

        for (const command of [
            FOUR_WAY_COMMANDS.cmd_DeviceReadEEprom,
            FOUR_WAY_COMMANDS.cmd_DeviceEraseAll
        ]) {
            expect((await raw(h, command, [1]) as FourWayResponse).ack)
                .toBe(FOUR_WAY_ACK.ACK_I_INVALID_CMD);
        }
    });

    it('has cmd_DeviceWriteEEprom silently succeed on ArduPilot and fail on Betaflight', async () => {
        // Neither actually writes anything -- AM32 has no CMD_PROG_EEPROM. Only
        // Betaflight admits it. Settings must go through cmd_DeviceWrite.
        for (const [profile, ack] of [
            ['ardupilot', FOUR_WAY_ACK.ACK_OK],
            ['betaflight', FOUR_WAY_ACK.ACK_D_GENERAL_ERROR]
        ] as const) {
            const h = rig({ profile, escCount: 1 });
            await connect(h);
            await initFlash(h, 0);
            const before = h.escs[0]!.eeprom;

            const response = await raw(
                h,
                FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom,
                [1, 2, 3, 4],
                h.escs[0]!.eepromOffset
            );

            expect((response as FourWayResponse).ack).toBe(ack);
            expect(Array.from(h.escs[0]!.eeprom)).toEqual(Array.from(before));
        }
    });
});
