/**
 * `SimTransport` and the two link-level fault knobs.
 *
 * These are the audit **E** / **G** regressions: the old transport installed a
 * single `ondata` handler that `drain` swapped out from under an exchange, so
 * stale or partial bytes were routinely handed to the wrong request. Corrupting
 * the byte stream is the only way to prove the replacement actually recovers
 * rather than merely never being tested.
 */

import { describe, expect, it } from 'vitest';
import { Link, LinkError } from 'am32-core/link/link';
import { DEFAULT_TIMEOUT_POLICY, HOST_LINK_BAUD, wireMs } from 'am32-core/link/timeout-policy';
import { MSP_COMMANDS, encodeMspCommand, isCompleteMspFrame, parseMspResponse } from 'am32-core/framing/msp';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse,
    type FourWayResponse
} from 'am32-core/framing/fourway';
import { VirtualClock } from 'am32-core/clock';
import { createSimHarness, type SimHarnessOptions } from './harness';
import { SimTransport, type SimEndpoint } from './transport';
import { garbageBytes } from './faults';

const policy = DEFAULT_TIMEOUT_POLICY.withVariant('ardupilot');

function rig (options: SimHarnessOptions = {}) {
    const harness = createSimHarness({ profile: 'ardupilot', escCount: 2, ...options });
    harness.fc.mavlinkIdleGate = 0;
    const link = new Link(harness.transport, { clock: harness.clock });
    return { ...harness, link };
}

type Rig = ReturnType<typeof rig>;

async function initFlash (h: Rig, target = 0, retries = 1): Promise<FourWayResponse | LinkError> {
    const command = FOUR_WAY_COMMANDS.cmd_DeviceInitFlash;
    const settled = h.link.request(encodeFourWayRequest(command, [target], 0), {
        probe: isCompleteFourWayFrame,
        timeout: policy.forFourWay(command, 1),
        retries,
        label: 'initFlash'
    }).then(response => parseFourWayResponse(response)).then(r => r, (e: LinkError) => e);
    await h.clock.runAll();
    return settled;
}

describe('SimTransport', () => {
    it('charges wire time in both directions, so a reply is never free', async () => {
        const h = rig();
        await h.open();

        const before = h.clock.now();
        const response = await initFlash(h);

        expect(response).not.toBeInstanceOf(LinkError);
        // 8 bytes out and 12 back at 115200, plus the ESC's soft-serial
        // handshake at 19200. Small, but never zero -- a transport that replied
        // inside `write()` would hide every ordering bug there is.
        expect(h.clock.now()).toBeGreaterThan(before);
    });

    it('rejects a write when the port is not open, and stops delivering after close', async () => {
        const h = rig();

        await expect(h.transport.write(new Uint8Array([1]))).rejects.toThrow(/not open/);

        await h.open();
        expect(h.transport.isOpen).toBe(true);
        await h.transport.close();
        expect(h.transport.isOpen).toBe(false);
        await expect(h.transport.write(new Uint8Array([1]))).rejects.toThrow(/not open/);
    });

    it('drops the FC\'s 4-way state when the port closes', async () => {
        const h = rig();
        await h.open();
        expect(await initFlash(h)).not.toBeInstanceOf(LinkError);
        expect(h.escs[0]?.isConnected).toBe(true);

        await h.transport.close();

        expect(h.escs[0]?.isConnected).toBe(false);
    });
});

describe('fault knob: link.dropBytes', () => {
    it('truncates a reply into a timeout, and the retry recovers', async () => {
        const h = rig();
        await h.open();

        // Eat two bytes out of the middle of the reply: the length byte still
        // claims four params, so the probe never fires and the attempt runs out
        // of budget rather than parsing a short frame as an answer.
        h.transport.faults.dropBytes(2, { skip: 4 });

        const response = await initFlash(h, 0, 2);

        expect(response).not.toBeInstanceOf(LinkError);
        expect((response as FourWayResponse).ack).toBe(FOUR_WAY_ACK.ACK_OK);
        expect(h.link.stats.attempts).toBe(2);
        expect(h.link.stats.timeouts).toBe(1);
        // The truncated bytes were still buffered when the retry started, so the
        // retry had to drain them. That is the fix for "a timed-out ESC poisons
        // the next one".
        expect(h.link.stats.drains).toBeGreaterThan(0);
        expect(h.link.stats.discardedBytes).toBeGreaterThan(0);
    });

    it('eats the start byte, leaving a buffer the probe must refuse to match', async () => {
        const h = rig();
        await h.open();

        // With the 0x2E gone the remaining bytes are a valid frame body at
        // offset -1. `isCompleteFourWayFrame` requires the start byte at offset
        // 0 precisely so this cannot be mistaken for a reply.
        h.transport.faults.dropBytes(1, { skip: 0 });

        const failed = await initFlash(h, 0, 1);

        expect(failed).toBeInstanceOf(LinkError);
        expect((failed as LinkError).reason).toBe('timeout');
        expect(h.link.bufferedBytes).toBeGreaterThan(0);

        // And the next exchange still works, because the drain clears it.
        expect(await initFlash(h)).not.toBeInstanceOf(LinkError);
    });

    it('corrupts the host\'s request too, which the FC simply never answers', async () => {
        const h = rig();
        await h.open();

        // Losing the leading 0x2F leaves nothing the FC's scan can lock onto, so
        // it discards the bytes and stays silent -- and the retry, being a whole
        // frame again, is answered normally.
        h.transport.faults.dropBytes(2, { direction: 'tx', skip: 0 });

        const response = await initFlash(h, 0, 2);

        expect(response).not.toBeInstanceOf(LinkError);
        expect(h.fc.counts.fourWay).toBe(1);
        expect(h.link.stats.timeouts).toBe(1);
    });
});

describe('fault knob: link.injectGarbage', () => {
    it('prefixes the reply, so the probe refuses it and the retry drains it away', async () => {
        const h = rig();
        await h.open();

        h.transport.faults.injectGarbage(6);

        const response = await initFlash(h, 0, 2);

        expect(response).not.toBeInstanceOf(LinkError);
        expect((response as FourWayResponse).ack).toBe(FOUR_WAY_ACK.ACK_OK);
        expect(h.link.stats.timeouts).toBe(1);
        expect(h.link.stats.discardedBytes).toBeGreaterThanOrEqual(6);
    });

    it('delivers stale bytes with nothing pending, which drain must clear', async () => {
        const h = rig();
        await h.open();
        expect(await initFlash(h)).not.toBeInstanceOf(LinkError);

        const drainsBefore = h.link.stats.drains;
        // Unsolicited traffic between exchanges: the FC pushing a frame of its
        // own, or the tail of a reply that arrived after its exchange gave up.
        h.transport.faults.injectGarbage(garbageBytes(12), { now: true });
        expect(h.link.bufferedBytes).toBe(12);

        const response = await initFlash(h);

        expect(response).not.toBeInstanceOf(LinkError);
        // One drain, no timeout: the stale bytes went away before the write, so
        // they were never attributed to this exchange.
        expect(h.link.stats.drains).toBe(drainsBefore + 1);
        expect(h.link.stats.timeouts).toBe(0);
    });

    it('cannot accidentally look like a frame start', () => {
        // 0x24 is '$', 0x2E a 4-way response and 0x2F a 4-way request. If the
        // filler ever contained one, "garbage" would start meaning "a frame we
        // did not send" and these tests would be measuring something else.
        for (let count = 1; count <= 64; count += 1) {
            for (const byte of garbageBytes(count, count)) {
                expect([0x24, 0x2E, 0x2F]).not.toContain(byte);
            }
        }
    });

    it('does not disturb MSP either -- the parser resynchronises past it', async () => {
        const h = rig();
        await h.open();
        h.transport.faults.injectGarbage(4);

        const settled = h.link.request(encodeMspCommand(MSP_COMMANDS.MSP_API_VERSION), {
            probe: isCompleteMspFrame,
            timeout: policy.forMsp(MSP_COMMANDS.MSP_API_VERSION),
            retries: 2,
            label: 'api'
        })
            .then(r => parseMspResponse(r, { expectCommand: MSP_COMMANDS.MSP_API_VERSION }))
            .then(f => f.payload, (e: unknown) => e);
        await h.clock.runAll();

        expect(Array.from((await settled) as Uint8Array)).toEqual([0, 1, 42]);
    });
});

describe('SimTransport: one wire, one order', () => {
    /** An endpoint that emits whatever chunks a test hands it, back to back. */
    class ScriptedEndpoint implements SimEndpoint {
        private readonly listeners = new Set<(chunk: Uint8Array) => void>();
        chunks: Uint8Array[] = [];

        receive (): void {
            for (const chunk of this.chunks) {
                for (const listener of [...this.listeners]) {
                    listener(chunk);
                }
            }
        }

        onTx (cb: (chunk: Uint8Array) => void): () => void {
            this.listeners.add(cb);
            return () => {
                this.listeners.delete(cb);
            };
        }
    }

    it('does not let a short reply overtake a long one already on the wire', async () => {
        // A serial link carries one byte at a time. Scheduling each chunk as
        // `now + wire(chunk)` independently would deliver a 4-byte frame emitted
        // just after a 240-byte one *first*, which no UART can do -- and would
        // hide a reordering bug in whatever is reading.
        const clock = new VirtualClock();
        const endpoint = new ScriptedEndpoint();
        const transport = new SimTransport({ clock, endpoint });
        await transport.open({ baudRate: 115200 });

        const seen: number[] = [];
        transport.onData(chunk => seen.push(chunk.length));

        endpoint.chunks = [new Uint8Array(240).fill(1), new Uint8Array(4).fill(2)];
        await transport.write(new Uint8Array([0x2F]));
        await clock.runAll();

        expect(seen).toEqual([240, 4]);
    });

    it('charges each direction its own wire time at the host link rate', async () => {
        const clock = new VirtualClock();
        const endpoint = new ScriptedEndpoint();
        const transport = new SimTransport({ clock, endpoint });
        await transport.open({ baudRate: 115200 });

        const arrivals: number[] = [];
        transport.onData(() => arrivals.push(clock.now()));

        // 8 bytes out, then 240 back: wire(8) + wire(240) at 115200.
        endpoint.chunks = [new Uint8Array(240)];
        await transport.write(new Uint8Array(8));
        await clock.runAll();

        const expected = wireMs(8, HOST_LINK_BAUD) + wireMs(240, HOST_LINK_BAUD);
        expect(arrivals).toEqual([expected]);
        expect(expected).toBeGreaterThan(20);
    });
});
