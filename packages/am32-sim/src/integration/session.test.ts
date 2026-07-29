/**
 * `Am32Session` end to end against a simulated flight controller and its ESCs.
 *
 * This file is block 4's done-when (issue #3 section 5):
 *
 *  - a simulated 4-ESC ArduPilot connect enumerates all four;
 *  - the same run with `esc[3].unresponsive` returns three good results and one
 *    error **without throwing**;
 *  - a simulated Betaflight connect completes without paying the 4 s idle wait,
 *    asserted on the virtual clock rather than on wall time.
 *
 * Every assertion about time is against `clock.now()`. Wall time here is
 * milliseconds for tens of seconds of protocol time, which is the whole payoff
 * from block 2's injectable clock -- a slow test means a hang, not a slow
 * machine.
 *
 * Nothing in this file constructs a `Link` for the session: the session owns its
 * own. What the harness provides is a `Transport` and a clock, and that boundary
 * is what keeps the simulator from growing a second copy of the host's logic.
 */

import { describe, expect, it } from 'vitest';
import type { VirtualClock } from 'am32-core/clock';
import { Link } from 'am32-core/link/link';
import { DEFAULT_TIMEOUT_POLICY } from 'am32-core/link/timeout-policy';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    encodeFourWayResponse,
    isCompleteFourWayFrame,
    parseFourWayResponse
} from 'am32-core/framing/fourway';
import { EepromLayout } from 'am32-core/eeprom/layout';
import { FourWaySession } from 'am32-core/esc/fourway-session';
import { MspSession } from 'am32-core/fc/msp-session';
import { Am32Session, type EscResult } from 'am32-core/session';
import { createSimHarness, type SimHarness, type SimHarnessOptions } from '../harness';

/**
 * Advance the virtual clock until `work` settles.
 *
 * Turns "the clock ran dry with the promise still pending" into a named failure
 * rather than a ten-second vitest timeout -- the difference between debugging a
 * deadlock and staring at one.
 */
async function drive<T> (clock: VirtualClock, work: Promise<T>): Promise<T> {
    // A holder rather than a bare `let`: the flag is set from a promise callback
    // the loop cannot see, which is exactly the shape `no-unmodified-loop-condition`
    // exists to catch, and here it is a false positive.
    const status = { settled: false };
    const tracked = work.then(
        (value) => {
            status.settled = true;
            return value;
        },
        (error: unknown) => {
            status.settled = true;
            throw error;
        }
    );
    tracked.catch(() => {});

    while (!status.settled) {
        const progressed = await clock.advanceToNextTimer();
        if (status.settled) {
            break;
        }
        if (!progressed) {
            throw new Error('drive: the virtual clock ran dry before the promise settled');
        }
    }
    return tracked;
}

interface Rig extends SimHarness {
    session: Am32Session;
    /** Every log line the session emitted, for assertions about what it told the user. */
    logs: string[];
}

function rig (options: SimHarnessOptions & { session?: Partial<ConstructorParameters<typeof Am32Session>[0]> } = {}): Rig {
    const { session: sessionOptions, ...harnessOptions } = options;
    const harness = createSimHarness(harnessOptions);
    const session = new Am32Session({
        transport: harness.transport,
        clock: harness.clock,
        ...sessionOptions
    });
    const logs: string[] = [];
    session.on('log', event => logs.push(`${event.level}: ${event.message}`));
    return { ...harness, session, logs };
}

/** The ESC channels a result set says came back healthy. */
const okTargets = (results: EscResult[]): number[] => results.filter(r => r.ok).map(r => r.target);

describe('block 4 done-when: a simulated 4-ESC ArduPilot enumerates all four', () => {
    it('connects, enters passthrough and reads every channel', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });

        const fc = await drive(h.clock, h.session.connect());

        expect(fc.variant).toBe('ardupilot');
        expect(fc.variantId).toBe('ARDU');
        // MSP_MOTOR_CONFIG byte 6 -- the authoritative count on both firmwares.
        expect(fc.motorCount).toBe(4);
        // The default profile arms the 4 s MAVLink window from t=0, so this
        // connect genuinely sat it out. The Betaflight test below is the
        // contrast that makes the point.
        expect(fc.waitedForMavlinkWindow).toBe(true);
        expect(h.clock.now()).toBeGreaterThanOrEqual(4000);

        const results = await drive(h.clock, h.session.enumerate());

        expect(results).toHaveLength(4);
        expect(okTargets(results)).toEqual([0, 1, 2, 3]);
        expect(h.session.escCount).toBe(4);

        for (const result of results) {
            // Every ESC really was read, not merely marked ok: 192 bytes of
            // EEprom_t, the firmware name out of the 32 bytes below it, and a
            // decoded settings object.
            expect(result.info?.settingsBuffer).toHaveLength(192);
            expect(result.info?.meta.am32.fileName).toBe('ARK_4IN1_F051');
            expect(result.info?.meta.am32.mcuType).toBe('F051');
            expect(result.info?.settings.LAYOUT_REVISION).toBe(3);
            expect(result.info?.bootloader.valid).toBe(true);
        }

        // Each channel was selected exactly once, in order, and its bootloader
        // came up on the first try.
        expect(h.escs.map(esc => esc.counts.connect)).toEqual([1, 1, 1, 1]);
    });

    it('reads the CAN block back byte for byte (audit A, the read half)', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 1 });
        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        const buffer = results[0]?.info?.settingsBuffer as Uint8Array;
        // The audit's own reproduction: can_node 0x20 is a space that `.trim()`
        // deleted and filter_hz 0xC8 is invalid UTF-8 that decoded to U+FFFD.
        expect(Array.from(buffer.slice(176, 184))).toEqual([32, 1, 1, 10, 1, 200, 0, 1]);
        expect(Array.from(buffer.slice(13, 17))).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
        // Never a string, on the way in or the way out.
        expect(results[0]?.info?.settings.CAN_SETTINGS).toBeInstanceOf(Uint8Array);
    });
});

describe('fault knob: esc[n].unresponsive -- a partial enumerate degrades (audit B)', () => {
    it('returns three good results and one error without throwing', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        // A channel with no ESC on it: unpowered, broken signal wire, or
        // firmware that will not enter its bootloader.
        (h.escs[3] as { unresponsive: boolean }).unresponsive = true;

        await drive(h.clock, h.session.connect());

        // The assertion is the `await` itself: before block 4 this threw a
        // TypeError out of the click handler, because the handler pushed an
        // entry with no `data` and then dereferenced `.data.settingsBuffer`
        // across all of them. One dead ESC took the other three with it.
        const results = await drive(h.clock, h.session.enumerate());

        expect(results).toHaveLength(4);
        expect(okTargets(results)).toEqual([0, 1, 2]);
        expect(results[3]).toMatchObject({ target: 3, ok: false });
        expect(results[3]?.info).toBeUndefined();
        expect(results[3]?.error).toMatch(/ESC #4/);

        // The three healthy channels are complete, not truncated by the failure.
        for (const result of results.slice(0, 3)) {
            expect(result.info?.settingsBuffer).toHaveLength(192);
        }
        // And the failure was reported, not swallowed.
        expect(h.logs.some(line => line.startsWith('error:') && line.includes('ESC #4'))).toBe(true);
    });

    it('names the channel on a read failure too, not just an init-flash failure', async () => {
        // `EscResult.error` is the only thing block 5 has to show for a failed
        // channel. A read failure used to surface as a bare
        // "cmd_DeviceRead failed: no complete response within 500ms", with
        // nothing saying which ESC it belonged to.
        const h = rig({ profile: 'betaflight', escCount: 3 });
        (h.escs[1] as { shortRead: boolean }).shortRead = true;

        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        expect(okTargets(results)).toEqual([0, 2]);
        expect(results[1]?.error).toMatch(/^ESC #2: /);
        expect(results[1]?.error).toMatch(/cmd_DeviceRead/);
    });

    it('survives the first channel failing, not just the last', async () => {
        // The old handler happened to survive a *late* failure for longer than
        // an early one, so a test that only kills esc[3] proves less than it
        // looks.
        const h = rig({ profile: 'betaflight', escCount: 4 });
        (h.escs[0] as { unresponsive: boolean }).unresponsive = true;

        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        expect(okTargets(results)).toEqual([1, 2, 3]);
    });

    it('emits a per-channel esc event for every target, good or bad', async () => {
        const h = rig({ profile: 'betaflight', escCount: 3 });
        (h.escs[1] as { unresponsive: boolean }).unresponsive = true;

        const seen: string[] = [];
        h.session.on('esc', event => seen.push(`${event.target}:${event.status}`));

        await drive(h.clock, h.session.connect());
        await drive(h.clock, h.session.enumerate());

        expect(seen).toEqual([
            '0:reading', '0:ok',
            '1:reading', '1:error',
            '2:reading', '2:ok'
        ]);
    });
});

describe('block 4 done-when: a Betaflight connect skips the ArduPilot idle wait (audit H)', () => {
    it('completes in a fraction of the 4 s window, measured on the virtual clock', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        const startedAt = h.clock.now();

        const fc = await drive(h.clock, h.session.connect());

        expect(fc.variant).toBe('betaflight');
        expect(fc.variantId).toBe('BTFL');
        expect(fc.waitedForMavlinkWindow).toBe(false);

        // The plan's requirement, literally: no 4 s tax on a firmware that never
        // asked for one.
        expect(h.clock.now() - startedAt).toBeLessThan(4000);
        expect(fc.connectMs).toBeLessThan(4000);
        // And far tighter than that in practice -- four MSP round trips at
        // 115200. The loose bound above is the plan's; this one is what fails if
        // a fixed wait ever creeps back in at any size worth having.
        expect(fc.connectMs).toBeLessThan(500);
        expect(h.fc.counts.gatedBytes).toBe(0);
    });

    it('enumerates a Betaflight board end to end', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });

        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        expect(okTargets(results)).toEqual([0, 1, 2, 3]);
        expect(h.session.state).toBe('passthrough');

        await drive(h.clock, h.session.exitPassthrough());
        expect(h.session.state).toBe('connected');
        // Betaflight's `esc4wayRelease` re-enables the motors and returns
        // straight to the MSP parser -- no reboot and no settle -- so MSP works
        // again immediately. Re-entering passthrough is the proof.
        expect(await drive(h.clock, h.session.enterPassthrough())).toBe(4);
    });
});

describe('fault knob: fc.mavlinkIdleGate -- probe-then-wait, not wait-then-probe', () => {
    it('finishes one poll after the window opens, because probing does not re-arm it', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        // Re-arm from now, modelling a GCS frame that has just let the port go.
        h.fc.mavlinkIdleGate = 4000;

        const fc = await drive(h.clock, h.session.connect());

        expect(fc.waitedForMavlinkWindow).toBe(true);
        expect(h.clock.now()).toBeGreaterThanOrEqual(4000);
        // The probes sent during the window were read and thrown away by the
        // FC's MAVLink parser (GCS_Common.cpp:1943,1970) -- they cost their own
        // timeouts and nothing else. If one of them re-armed the gate, connect
        // would run out its 8000 ms budget and fail with `fc-detect`.
        expect(h.fc.counts.gatedBytes).toBeGreaterThan(0);
        expect(h.clock.now()).toBeLessThan(4000 + 2000);
    });

    it('pays nothing at all when the window is already open', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        h.fc.mavlinkIdleGate = 0;

        const fc = await drive(h.clock, h.session.connect());

        expect(fc.variant).toBe('ardupilot');
        expect(fc.waitedForMavlinkWindow).toBe(false);
        expect(fc.connectMs).toBeLessThan(500);
        expect(h.fc.counts.gatedBytes).toBe(0);
    });

    it('recovers a port a previous session left in 4-way passthrough', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        h.fc.mavlinkIdleGate = 0;

        // Strand the FC in `esc4wayProcess` the way a session that died
        // mid-flash does. From here MSP is discarded unanswered until
        // `cmd_InterfaceExit` (serial_4way.c:453-461).
        const stranding = new Am32Session({ transport: h.transport, clock: h.clock });
        await drive(h.clock, stranding.connect());
        await drive(h.clock, stranding.enterPassthrough());
        expect(h.fc.inPassthrough).toBe(true);

        // A fresh session on the same port -- the second connect of the day.
        const fc = await drive(h.clock, h.session.connect());

        expect(fc.variantId).toBe('BTFL');
        expect(fc.waitedForMavlinkWindow).toBe(false);
        expect(h.fc.inPassthrough).toBe(false);
    });
});

describe('fault knob: link.dropBytes -- a lost passthrough reply must not strand the FC', () => {
    it('sends an exit when MSP_SET_PASSTHROUGH fails, because the FC may have entered anyway', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        await drive(h.clock, h.session.connect());

        // Eat the start byte of the reply. The FC entered `esc4wayProcess` the
        // moment it sent that frame; we never see it, so we believe it did not
        // -- and from here every MSP frame is swallowed unanswered
        // (serial_4way.c:453-461). Historically this is the state a user
        // escapes by replugging USB.
        h.transport.faults.dropBytes(1, { direction: 'rx' });

        await expect(drive(h.clock, h.session.enterPassthrough())).rejects.toMatchObject({
            name: 'SessionError',
            reason: 'passthrough'
        });

        // The failure path unstranded it, so the next attempt is not doomed.
        expect(h.fc.inPassthrough).toBe(false);
        expect(h.session.state).toBe('connected');
        expect(await drive(h.clock, h.session.enterPassthrough())).toBe(4);
    });
});

describe('fault knob: fc.blockingFourWay -- MSP is refused in passthrough, on both firmwares', () => {
    it('will not put an MSP frame on the wire while the FC is in 4-way', async () => {
        for (const profile of ['ardupilot', 'betaflight'] as const) {
            const h = rig({ profile, escCount: 4 });
            h.fc.mavlinkIdleGate = 0;

            await drive(h.clock, h.session.connect());
            await drive(h.clock, h.session.enterPassthrough());

            const mspBefore = h.fc.counts.msp;
            await expect(drive(h.clock, h.session.connect())).rejects.toMatchObject({
                name: 'SessionError',
                reason: 'passthrough'
            });
            // Refused before it reached the wire, not merely after it failed.
            expect(h.fc.counts.msp).toBe(mspBefore);
            expect(h.fc.inPassthrough).toBe(true);
        }
    });

    it('is worth refusing: on ArduPilot an MSP frame in passthrough disconnects every ESC', async () => {
        // The guard exists because of this, so the simulator has to be able to
        // reproduce it. AP:1242-1246 leaves 4-way on a `$` and calls
        // `serial_end()`; the MSP reply arrives, and the *next* 4-way command is
        // the one that fails -- a long way from the cause.
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        h.fc.mavlinkIdleGate = 0;

        const link = new Link(h.transport, { clock: h.clock });
        const policy = DEFAULT_TIMEOUT_POLICY.withVariant('ardupilot');
        const msp = new MspSession({ link, clock: h.clock, policy });
        const fourWay = new FourWaySession({ link, policy, retries: 1, initRetries: 1 });

        await h.open();
        await drive(h.clock, msp.enterPassthrough());
        await drive(h.clock, fourWay.initFlash(0));
        expect(h.escs[0]?.isConnected).toBe(true);

        // One informational MSP read, which is exactly the thing the plan's
        // quirks table calls "multiplexed" and says is fine.
        await drive(h.clock, msp.tryRequest(2 /* MSP_FC_VARIANT */));

        expect(h.fc.inPassthrough).toBe(false);
        expect(h.escs.every(esc => !esc.isConnected)).toBe(true);
        await expect(drive(h.clock, fourWay.readAddress(0x7C00, 192))).rejects.toBeTruthy();
    });
});

describe('a short reply is a failed operation, whatever the ACK says', () => {
    /** In passthrough with channel 0 selected, using the core sessions directly. */
    async function passthroughRig (options: SimHarnessOptions) {
        const h = createSimHarness(options);
        const link = new Link(h.transport, { clock: h.clock });
        const policy = DEFAULT_TIMEOUT_POLICY.withVariant(h.fc.profile.name);
        const msp = new MspSession({ link, clock: h.clock, policy });
        const fourWay = new FourWaySession({ link, policy, retries: 2, initRetries: 2 });
        h.fc.mavlinkIdleGate = 0;
        await h.open();
        await drive(h.clock, msp.enterPassthrough());
        await drive(h.clock, fourWay.initFlash(0));
        return { ...h, link, policy, fourWay };
    }

    it('rejects ArduPilot\'s ACK_OK carrying one byte of uninitialised stack', async () => {
        const h = await passthroughRig({ profile: 'ardupilot', escCount: 1 });

        // Address 0x100 is below the bootloader's reserved floor and is not one
        // of its three magic values, so `CMD_SET_ADDRESS` is refused
        // (AM32-bootloader main.c:563-566). ArduPilot's `BL_ReadA` then returns
        // false at AP:786 *without touching* `blheli.ack`, so the reply is
        // ACK_OK with a single byte the firmware never wrote (AP:1098-1103).
        const raw = await drive(h.clock, h.link.request(
            encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [32], 0x100),
            {
                probe: isCompleteFourWayFrame,
                timeout: h.policy.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, 32),
                retries: 1,
                label: 'raw read'
            }
        ));
        const decoded = parseFourWayResponse(raw);
        expect(decoded.ack).toBe(FOUR_WAY_ACK.ACK_OK);
        expect(decoded.params).toHaveLength(1);

        // So an ACK check alone would have handed one byte of nothing up as if
        // it were 32 bytes of firmware name. The length check is what stops it.
        await expect(drive(h.clock, h.fourWay.readAddress(0x100, 32))).rejects.toMatchObject({
            name: 'SessionError',
            reason: 'esc-read'
        });
    });

    it('rejects a read the ESC truncated, which does come back as an error', async () => {
        const h = await passthroughRig({ profile: 'betaflight', escCount: 1 });
        // One byte short of what was asked for: the FC's own read budget never
        // completes, so it fabricates a one-param ACK_D_GENERAL_ERROR.
        (h.escs[0] as { shortRead: boolean }).shortRead = true;

        await expect(drive(h.clock, h.fourWay.readAddress(0x7C00, 192))).rejects.toMatchObject({
            name: 'SessionError'
        });
    });

    it('reports a refused init-flash as a session error, not as a raw ACK number', async () => {
        const h = await passthroughRig({ profile: 'ardupilot', escCount: 2 });
        (h.escs[1] as { unresponsive: boolean }).unresponsive = true;

        await expect(drive(h.clock, h.fourWay.initFlash(1))).rejects.toMatchObject({
            name: 'SessionError',
            reason: 'esc-command',
            ack: FOUR_WAY_ACK.ACK_D_GENERAL_ERROR
        });
    });
});

describe('an MCU signature no variant knows', () => {
    it('fails that channel with a named error instead of reading an invented address', async () => {
        // The signature decides the EEPROM offset. Carrying an unknown one
        // forward would send the very next read somewhere made up, and the
        // failure would surface as a short read a step later.
        // A real F051 that reports a signature the variant table has never
        // heard of -- a new part, or a build we have not been taught about.
        const h = rig({ profile: 'betaflight', escCount: 2, esc: { reportedSignature: 0x1234 } });

        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        expect(okTargets(results)).toEqual([]);
        expect(results[0]?.error).toMatch(/unknown MCU signature 0x1234/i);
        // Still a per-channel failure, not an exception out of enumerate.
        expect(results).toHaveLength(2);
    });
});

describe('fault knob: esc[n].corruptCrc -- a bad reply must not poison the next ESC', () => {
    it('retries through two corrupted frames and still enumerates everything', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        // A counted budget rather than `true`, so "the retry recovered" is an
        // exact assertion instead of a timing race.
        (h.escs[1] as { corruptCrc: boolean | number }).corruptCrc = 2;

        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        expect(okTargets(results)).toEqual([0, 1, 2, 3]);
        // The link had to drain and re-send, and the ESC after the corrupt one
        // came back clean.
        expect(h.session.stats.drains).toBeGreaterThan(0);
        expect(results[2]?.info?.settingsBuffer).toHaveLength(192);
    });
});

describe('passthrough that reports zero ESCs', () => {
    it('leaves the 4-way loop instead of sitting in it (Betaflight)', async () => {
        // `esc4wayProcess` is installed unconditionally -- msp.c:328-333 is not
        // guarded by the count -- so a host that shrugs at zero is trapped in a
        // blocking loop with nothing to talk to and only `cmd_InterfaceExit`
        // gets it out.
        const h = rig({ profile: 'betaflight', escCount: 4, motorCount: 0 });

        await drive(h.clock, h.session.connect());
        const count = await drive(h.clock, h.session.enterPassthrough());

        expect(count).toBe(0);
        expect(h.fc.inPassthrough).toBe(false);
        expect(h.session.state).toBe('connected');
        expect(h.logs.some(line => line.startsWith('warn:') && line.includes('0 ESCs'))).toBe(true);
    });

    it('enumerates to an empty list rather than throwing', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4, motorCount: 0 });

        await drive(h.clock, h.session.connect());
        const results = await drive(h.clock, h.session.enumerate());

        expect(results).toEqual([]);
        expect(h.fc.inPassthrough).toBe(false);
    });
});

describe('two callers at once', () => {
    it('serialises overlapping enumerates instead of interleaving their channel selection', async () => {
        // `Link` serialises one *exchange*; without a session-level mutex two
        // `enumerate()` calls interleave into that single FIFO and steal each
        // other's `cmd_DeviceInitFlash`, because a `cmd_DeviceRead` acts on
        // whichever channel was selected last. The result is not an error -- it
        // is one run reporting another ESC's EEPROM image as `ok: true`, which
        // block 6's writeSettings would then write back to the wrong ESC.
        //
        // Two clicks on block 5's Read button is enough to produce it.
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        h.escs.forEach((esc, i) => {
            esc.poke(esc.eepromOffset + EepromLayout.BOOT_LOADER_REVISION.offset, [10 + i]);
        });
        await drive(h.clock, h.session.connect());

        const first = h.session.enumerate();
        // Let the first run get past the passthrough settle and into its ESC
        // loop, which is where the interleaving does its damage.
        await h.clock.advance(2500);
        const second = h.session.enumerate();

        const [a, b] = await drive(h.clock, Promise.all([first, second]));

        for (const results of [a, b]) {
            expect(okTargets(results)).toEqual([0, 1, 2, 3]);
            // Each ESC carries a distinguishable byte, so a swapped image shows
            // up here rather than passing silently.
            expect(results.map(r => r.info?.settings.BOOT_LOADER_REVISION)).toEqual([10, 11, 12, 13]);
        }
    });

    it('does not send MSP_SET_PASSTHROUGH twice when two callers race into it', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        h.fc.mavlinkIdleGate = 0;
        await drive(h.clock, h.session.connect());

        const before = h.fc.counts.msp;
        const [x, y] = await drive(h.clock, Promise.all([
            h.session.enterPassthrough(),
            h.session.enterPassthrough()
        ]));

        expect([x, y]).toEqual([4, 4]);
        // The second caller found the session already in passthrough and sent
        // nothing. On ArduPilot the alternative is worse than wasteful: a second
        // MSP frame arriving in passthrough leaves 4-way and disconnects
        // everything.
        expect(h.fc.counts.msp - before).toBe(1);
        expect(h.fc.inPassthrough).toBe(true);
    });
});

describe('a 4-way reply must echo the command it answers', () => {
    it('rejects a frame left over from an earlier exchange, then recovers', async () => {
        const h = createSimHarness({ profile: 'ardupilot', escCount: 1 });
        const link = new Link(h.transport, { clock: h.clock });
        const policy = DEFAULT_TIMEOUT_POLICY.withVariant('ardupilot');
        const msp = new MspSession({ link, clock: h.clock, policy });
        const fourWay = new FourWaySession({ link, policy, retries: 2, initRetries: 2 });
        h.fc.mavlinkIdleGate = 0;
        await h.open();
        await drive(h.clock, msp.enterPassthrough());
        await drive(h.clock, fourWay.initFlash(0));

        // A complete, CRC-valid reply to a *different* command, arriving ahead of
        // the real one -- the shape a reply left behind by an exchange that gave
        // up has when it lands after the next drain's quiet window.
        const stale = encodeFourWayResponse(
            FOUR_WAY_COMMANDS.cmd_DeviceRead,
            [0xAB, 0xAB, 0xAB, 0xAB],
            FOUR_WAY_ACK.ACK_OK
        );
        h.transport.faults.injectGarbage(stale, { direction: 'rx' });

        const response = await drive(h.clock, fourWay.command(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, {
            retries: 2
        }));

        // Without the echo check the stale ACK_OK frame is accepted and this is
        // cmd_DeviceRead. With it, the attempt is rejected, the link drains, and
        // the retry gets the real answer -- retry-on-bad-data for free, which is
        // the whole reason the check belongs in `validate`.
        expect(response.command).toBe(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive);
        expect(link.stats.drains).toBeGreaterThan(0);
    });
});

describe('lifecycle', () => {
    it('resets a channel and disconnects cleanly', async () => {
        const h = rig({ profile: 'betaflight', escCount: 2 });

        await drive(h.clock, h.session.connect());
        await drive(h.clock, h.session.enumerate());
        await drive(h.clock, h.session.reset(1));

        expect(h.escs[1]?.counts.reset).toBe(1);
        expect(h.escs[1]?.isConnected).toBe(false);

        await drive(h.clock, h.session.disconnect());

        expect(h.session.state).toBe('disconnected');
        expect(h.transport.isOpen).toBe(false);
        // Disconnecting from passthrough sends the exit first, so the FC is not
        // left in its blocking loop for the next session to trip over.
        expect(h.fc.inPassthrough).toBe(false);
    });

    it('stops reporting a channel count once passthrough is left', async () => {
        const h = rig({ profile: 'betaflight', escCount: 4 });
        await drive(h.clock, h.session.connect());

        expect(await drive(h.clock, h.session.enterPassthrough())).toBe(4);
        expect(h.session.escCount).toBe(4);

        await drive(h.clock, h.session.exitPassthrough());
        // The count belonged to that passthrough session. Keeping it would leave
        // `escCount` reporting channels nobody can address, against what the
        // getter promises.
        expect(h.session.escCount).toBe(0);
    });

    it('costs milliseconds of wall time for seconds of protocol time', async () => {
        const h = rig({ profile: 'ardupilot', escCount: 4 });
        await drive(h.clock, h.session.connect());
        await drive(h.clock, h.session.enumerate());

        // The 4 s MAVLink window, the 2 s passthrough settle and three 300 ms
        // inter-ESC gaps all really happened -- on the virtual clock.
        expect(h.clock.now()).toBeGreaterThan(6000);
    });
});
