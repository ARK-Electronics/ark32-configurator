/**
 * The connect state machine and the quirk records, against a scripted transport.
 *
 * Deliberately *not* against `am32-sim`: those are the integration tests, and
 * they live in that package (`packages/am32-sim/src/integration/session.test.ts`).
 * What is checked here is the part a simulator makes harder rather than easier
 * to see -- exactly which frames go out, in which order, and what happens when
 * nothing ever comes back. `am32-core` also has no dependency on `am32-sim`, and
 * should not grow one.
 */

import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock';
import { SessionError } from '../errors';
import {
    FOUR_WAY_COMMANDS,
    FOUR_WAY_LOCAL_ESCAPE,
    parseFourWayRequest
} from '../framing/fourway';
import {
    MSP_COMMANDS,
    encodeMspV1,
    isMspRequest,
    parseMspResponse
} from '../framing/msp';
import { Link } from '../link/link';
import { Am32Session } from '../session';
import type { Transport } from '../transport';
import { MspSession } from './msp-session';
import {
    ARDUPILOT_QUIRKS,
    BETAFLIGHT_QUIRKS,
    GENERIC_QUIRKS,
    quirksForFcVariantId,
    quirksForVariant
} from './quirks';

/**
 * A transport whose replies are a function of the request, delivered one tick
 * later on the virtual clock.
 *
 * A tick rather than synchronously inside `write()`: a transport that answered
 * before its own write resolved would hide every ordering bug there is, which
 * is the same reason `am32-sim`'s transport always schedules a timer.
 */
class ScriptedTransport implements Transport {
    isOpen = false;
    readonly writes: Uint8Array[] = [];

    /** Return the reply bytes, or null for silence. */
    respond: (request: Uint8Array) => Uint8Array | null = () => null;

    private readonly listeners = new Set<(chunk: Uint8Array) => void>();
    private readonly clock: VirtualClock;

    constructor (clock: VirtualClock) {
        this.clock = clock;
    }

    open (_opts: { baudRate: number }): Promise<void> {
        this.isOpen = true;
        return Promise.resolve();
    }

    close (): Promise<void> {
        this.isOpen = false;
        return Promise.resolve();
    }

    write (data: Uint8Array): Promise<void> {
        this.writes.push(data.slice());
        const reply = this.respond(data);
        if (reply) {
            this.clock.setTimeout(() => {
                for (const listener of [...this.listeners]) {
                    listener(reply);
                }
            }, 1);
        }
        return Promise.resolve();
    }

    onData (cb: (chunk: Uint8Array) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    /** Every MSP command the host has sent, in order. */
    get mspCommands (): number[] {
        return this.writes
            .filter(frame => isMspRequest(frame))
            .map(frame => parseMspResponse(frame).command);
    }

    /** Every 4-way command the host has sent, in order. */
    get fourWayCommands (): number[] {
        return this.writes
            .filter(frame => frame[0] === FOUR_WAY_LOCAL_ESCAPE)
            .map(frame => parseFourWayRequest(frame).command);
    }
}

/** A well-formed reply to whatever MSP command `request` carries. */
function mspReplies (payloads: Partial<Record<MSP_COMMANDS, number[]>>) {
    return (request: Uint8Array): Uint8Array | null => {
        if (!isMspRequest(request)) {
            return null;
        }
        const command = parseMspResponse(request).command as MSP_COMMANDS;
        const payload = payloads[command];
        return payload
            ? encodeMspV1(command, Uint8Array.from(payload), 'response')
            : null;
    };
}

const BETAFLIGHT_REPLIES = {
    [MSP_COMMANDS.MSP_API_VERSION]: [0, 1, 46],
    [MSP_COMMANDS.MSP_FC_VARIANT]: [0x42, 0x54, 0x46, 0x4C], // 'BTFL'
    [MSP_COMMANDS.MSP_MOTOR_CONFIG]: [232, 3, 208, 7, 232, 3, 4, 14, 0, 0]
};

/**
 * Advance the virtual clock until `work` settles.
 *
 * Turns "the clock ran dry with the promise still pending" into a named failure
 * instead of a ten-second vitest timeout, which is the difference between
 * debugging a deadlock and staring at one.
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

function rig (options: { idleWindowMs?: number, pollIntervalMs?: number } = {}) {
    const clock = new VirtualClock(0);
    const transport = new ScriptedTransport(clock);
    const link = new Link(transport, { clock });
    const msp = new MspSession({
        link,
        clock,
        idleWindowMs: options.idleWindowMs,
        pollIntervalMs: options.pollIntervalMs
    });
    return { clock, transport, link, msp };
}

describe('FC quirks', () => {
    it('resolves the MSP_FC_VARIANT identifiers each firmware actually sends', () => {
        expect(quirksForFcVariantId('ARDU')).toBe(ARDUPILOT_QUIRKS);
        expect(quirksForFcVariantId('BTFL')).toBe(BETAFLIGHT_QUIRKS);
        // INAV ships Betaflight's serial_4way unchanged, blocking loop included.
        expect(quirksForFcVariantId('INAV')).toBe(BETAFLIGHT_QUIRKS);
    });

    it('falls back to generic rather than guessing at an unknown FC', () => {
        expect(quirksForFcVariantId('XXXX')).toBe(GENERIC_QUIRKS);
        expect(quirksForFcVariantId('')).toBe(GENERIC_QUIRKS);
        expect(quirksForVariant('generic')).toBe(GENERIC_QUIRKS);
    });

    it('gives generic the pessimistic value of every field, never a shortcut', () => {
        // An unidentified FC must not be handed ArduPilot's escape hatches nor
        // Betaflight's instant MSP -- the same rule TimeoutPolicy's `generic`
        // variant follows.
        expect(GENERIC_QUIRKS.mspAvailableImmediately).toBe(false);
        expect(GENERIC_QUIRKS.mavlinkIdleMs).toBe(ARDUPILOT_QUIRKS.mavlinkIdleMs);
        expect(GENERIC_QUIRKS.entersFourWayOnBareEscape).toBe(false);
        expect(GENERIC_QUIRKS.readSetAddressFailureAcksOk).toBe(true);
    });

    it('records that only ArduPilot gates MSP behind a MAVLink idle window', () => {
        expect(ARDUPILOT_QUIRKS.mspAvailableImmediately).toBe(false);
        expect(ARDUPILOT_QUIRKS.mavlinkIdleMs).toBe(4000);
        expect(BETAFLIGHT_QUIRKS.mspAvailableImmediately).toBe(true);
        expect(BETAFLIGHT_QUIRKS.mavlinkIdleMs).toBe(0);
    });

    it('records that MSP in passthrough is destructive on ArduPilot, not merely useless', () => {
        // AP:1242-1246 -- the '$' leaves 4-way and calls serial_end().
        expect(ARDUPILOT_QUIRKS.mspInPassthrough).toBe('exits-passthrough');
        // serial_4way.c:453-461 -- the byte is scanned past and discarded.
        expect(BETAFLIGHT_QUIRKS.mspInPassthrough).toBe('ignored');
    });
});

describe('MspSession.connect: probe first, wait only if you must (audit H)', () => {
    it('answers on the first frame and never touches the idle window', async () => {
        const h = rig();
        h.transport.respond = mspReplies(BETAFLIGHT_REPLIES);
        await h.transport.open({ baudRate: 115200 });

        const info = await drive(h.clock, h.msp.connect());

        expect(info.variant).toBe('betaflight');
        expect(info.variantId).toBe('BTFL');
        expect(info.apiVersion).toEqual({ protocol: 0, major: 1, minor: 46 });
        expect(info.motorCount).toBe(4);
        expect(info.waitedForMavlinkWindow).toBe(false);

        // The point of the whole block: no 4-way escape, no polling, and the
        // whole connect inside the 4000 ms ArduPilot alone requires.
        expect(h.transport.fourWayCommands).toEqual([]);
        expect(info.connectMs).toBeLessThan(4000);
        expect(h.transport.mspCommands.filter(c => c === MSP_COMMANDS.MSP_API_VERSION)).toHaveLength(1);
    });

    it('adopts the detected FC\'s timeout budgets exactly once', async () => {
        const h = rig();
        h.transport.respond = mspReplies(BETAFLIGHT_REPLIES);
        await h.transport.open({ baudRate: 115200 });

        expect(h.msp.policy.variant).toBe('generic');
        await drive(h.clock, h.msp.connect());
        // Betaflight allows itself 2 ms per byte on a soft-serial read where
        // ArduPilot allows 1, so the variant is not cosmetic -- it moves every
        // 4-way read budget. See link/timeout-policy.ts.
        expect(h.msp.policy.variant).toBe('betaflight');
    });

    it('tries a 4-way escape before concluding there is no FC', async () => {
        const h = rig({ idleWindowMs: 2000, pollIntervalMs: 200 });
        // Silent until someone gets us out of passthrough -- which is exactly
        // what a session that died mid-flash leaves behind.
        let escaped = false;
        h.transport.respond = (request) => {
            if (request[0] === FOUR_WAY_LOCAL_ESCAPE) {
                escaped = true;
                return null;
            }
            return escaped ? mspReplies(BETAFLIGHT_REPLIES)(request) : null;
        };
        await h.transport.open({ baudRate: 115200 });

        const info = await drive(h.clock, h.msp.connect());

        expect(h.transport.fourWayCommands).toEqual([FOUR_WAY_COMMANDS.cmd_InterfaceExit]);
        expect(info.variantId).toBe('BTFL');
        // The escape happened before the idle window, so no polling was needed.
        expect(info.waitedForMavlinkWindow).toBe(false);
    });

    it('polls through the idle window and succeeds the moment it opens', async () => {
        const h = rig({ idleWindowMs: 8000, pollIntervalMs: 250 });
        const OPENS_AT = 4000;
        let answeredAt: number | null = null;
        h.transport.respond = (request) => {
            if (h.clock.now() < OPENS_AT) {
                // ArduPilot reads the byte and gives it to the MAVLink parser,
                // which rejects it. It is consumed and lost -- and it does NOT
                // re-arm the window (GCS_Common.cpp:1974-1977).
                return null;
            }
            const reply = mspReplies(BETAFLIGHT_REPLIES)(request);
            if (reply && answeredAt === null) {
                answeredAt = h.clock.now();
            }
            return reply;
        };
        await h.transport.open({ baudRate: 115200 });

        const info = await drive(h.clock, h.msp.connect());

        expect(info.waitedForMavlinkWindow).toBe(true);
        // Measured at the first frame the FC actually answered, not at the end
        // of connect -- the identity reads after it have costs of their own and
        // would blur the thing under test.
        expect(answeredAt).toBeGreaterThanOrEqual(OPENS_AT);
        // Polling cost nothing but the lost probes: the connect lands one poll
        // interval after the window opens rather than being pushed back by its
        // own traffic. If a probe ever re-armed the gate, this would run out the
        // 8000 ms budget and fail with `fc-detect` instead.
        expect(answeredAt).toBeLessThan(OPENS_AT + 1500);
    });

    it('gives up with a fc-detect error rather than hanging on a dead port', async () => {
        const h = rig({ idleWindowMs: 1500, pollIntervalMs: 200 });
        h.transport.respond = () => null;
        await h.transport.open({ baudRate: 115200 });

        await expect(drive(h.clock, h.msp.connect())).rejects.toMatchObject({
            name: 'SessionError',
            reason: 'fc-detect'
        });
    });
});

describe('MspSession.enterPassthrough', () => {
    it('sends the empty-payload form, which means 4-way on both firmwares', async () => {
        const h = rig();
        h.transport.respond = mspReplies({
            ...BETAFLIGHT_REPLIES,
            [MSP_COMMANDS.MSP_SET_PASSTHROUGH]: [4]
        });
        await h.transport.open({ baudRate: 115200 });

        const count = await drive(h.clock, h.msp.enterPassthrough());

        expect(count).toBe(4);
        const sent = h.transport.writes.find(
            frame => isMspRequest(frame) && parseMspResponse(frame).command === MSP_COMMANDS.MSP_SET_PASSTHROUGH
        );
        // msp.c:301-303 and AP_BLHeli.cpp:574-575 both read "no payload" as
        // MSP_PASSTHROUGH_ESC_4WAY. Sending [0xFF, 0] would also work; sending
        // nothing is what the app has always sent.
        expect(parseMspResponse(sent as Uint8Array).payload).toHaveLength(0);
    });

    it('reports ArduPilot\'s 0x0F failure reply as a passthrough error, not as data', async () => {
        const h = rig();
        h.transport.respond = (request) => {
            if (!isMspRequest(request)) {
                return null;
            }
            const command = parseMspResponse(request).command;
            if (command === MSP_COMMANDS.MSP_SET_PASSTHROUGH) {
                // AP:594 msp_send_ack(ACK_D_GENERAL_ERROR) -- a well-formed
                // `$M>` frame whose command field is 0x0F rather than 245. Only
                // the command-echo check block 1b added catches this; without
                // it the caller reads payload[0] of an empty payload.
                return encodeMspV1(0x0F, new Uint8Array(0), 'response');
            }
            return mspReplies(BETAFLIGHT_REPLIES)(request);
        };
        await h.transport.open({ baudRate: 115200 });

        await expect(drive(h.clock, h.msp.enterPassthrough())).rejects.toMatchObject({
            name: 'SessionError',
            reason: 'passthrough'
        });
    });
});

describe('Am32Session guards', () => {
    it('opens the transport itself when the caller has not', async () => {
        const clock = new VirtualClock(0);
        const transport = new ScriptedTransport(clock);
        transport.respond = mspReplies(BETAFLIGHT_REPLIES);
        const session = new Am32Session({ transport, clock });

        expect(transport.isOpen).toBe(false);
        await drive(clock, session.connect());
        expect(transport.isOpen).toBe(true);
    });

    it('refuses everything below the session layer until connect() has run', async () => {
        const clock = new VirtualClock(0);
        const transport = new ScriptedTransport(clock);
        const session = new Am32Session({ transport, clock });

        await expect(session.enumerate()).rejects.toMatchObject({ reason: 'not-connected' });
        await expect(session.enterPassthrough()).rejects.toMatchObject({ reason: 'not-connected' });
        await expect(session.readEsc(0)).rejects.toMatchObject({ reason: 'passthrough' });
    });

    it('reports a port that will not open as a transport error', async () => {
        const clock = new VirtualClock(0);
        const transport = new ScriptedTransport(clock);
        transport.open = () => Promise.reject(new Error('Port already in use'));
        const session = new Am32Session({ transport, clock });

        await expect(session.connect()).rejects.toMatchObject({ reason: 'transport' });
        expect(session.state).toBe('idle');
    });

    it('is terminal once disconnected', async () => {
        const clock = new VirtualClock(0);
        const transport = new ScriptedTransport(clock);
        transport.respond = mspReplies(BETAFLIGHT_REPLIES);
        const session = new Am32Session({ transport, clock });

        await drive(clock, session.connect());
        await drive(clock, session.disconnect());

        expect(session.state).toBe('disconnected');
        expect(transport.isOpen).toBe(false);
        await expect(session.connect()).rejects.toBeInstanceOf(SessionError);
    });

    it('emits state transitions and log lines a client can mirror', async () => {
        const clock = new VirtualClock(0);
        const transport = new ScriptedTransport(clock);
        transport.respond = mspReplies(BETAFLIGHT_REPLIES);
        const session = new Am32Session({ transport, clock });

        const states: string[] = [];
        const logs: string[] = [];
        session.on('state', event => states.push(event.state));
        session.on('log', event => logs.push(event.message));

        await drive(clock, session.connect());

        expect(states).toEqual(['connecting', 'connected']);
        expect(logs.some(line => line.includes('BTFL'))).toBe(true);
    });

    it('does not let a throwing listener abort the operation that emitted', async () => {
        const clock = new VirtualClock(0);
        const transport = new ScriptedTransport(clock);
        transport.respond = mspReplies(BETAFLIGHT_REPLIES);
        const session = new Am32Session({ transport, clock });

        session.on('state', () => {
            throw new Error('a component blew up while rendering');
        });

        // A store mirror that throws must not take the flash down with it.
        const info = await drive(clock, session.connect());
        expect(info.variantId).toBe('BTFL');
    });
});
