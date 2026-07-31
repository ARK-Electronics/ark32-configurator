import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../clock';
import type { Transport } from '../transport';
import {
    FOUR_WAY_ACK,
    FOUR_WAY_COMMANDS,
    crc16Xmodem,
    encodeFourWayRequest,
    isCompleteFourWayFrame,
    parseFourWayResponse
} from '../framing/fourway';
import { Link, LinkError } from './link';

/**
 * A transport that moves bytes and nothing else, so these tests exercise the
 * link layer and only the link layer. Replies are pushed explicitly: nothing
 * happens on its own, which is what makes "did the second write happen yet?"
 * an answerable question.
 */
class FakeTransport implements Transport {
    isOpen = false;
    readonly writes: Uint8Array[] = [];
    writeError: Error | null = null;
    /** When set, `write` returns this instead of resolving -- a stalled write. */
    writeGate: Promise<void> | null = null;
    /** Called after each accepted write, so a test can reply inline. */
    onWrite: ((frame: Uint8Array, index: number) => void) | null = null;

    private readonly listeners = new Set<(chunk: Uint8Array) => void>();

    open (): Promise<void> {
        this.isOpen = true;
        return Promise.resolve();
    }

    close (): Promise<void> {
        this.isOpen = false;
        return Promise.resolve();
    }

    write (data: Uint8Array): Promise<void> {
        if (this.writeError) {
            return Promise.reject(this.writeError);
        }
        this.writes.push(data.slice());
        if (this.writeGate) {
            return this.writeGate;
        }
        this.onWrite?.(data, this.writes.length - 1);
        return Promise.resolve();
    }

    onData (cb: (chunk: Uint8Array) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    /** Deliver bytes as if they had just arrived from the FC. */
    push (bytes: ArrayLike<number>): void {
        const chunk = Uint8Array.from(Array.from(bytes));
        for (const listener of [...this.listeners]) {
            listener(chunk);
        }
    }

    get listenerCount (): number {
        return this.listeners.size;
    }
}

/** A real 4-way response frame, CRC and all. */
function fourWayResponse (
    command: FOUR_WAY_COMMANDS,
    params: number[],
    ack: FOUR_WAY_ACK = FOUR_WAY_ACK.ACK_OK,
    address = 0
): Uint8Array {
    const frame = new Uint8Array(params.length + 8);
    frame[0] = 0x2E;
    frame[1] = command;
    frame[2] = (address >> 8) & 0xFF;
    frame[3] = address & 0xFF;
    frame[4] = params.length === 256 ? 0 : params.length;
    frame.set(params, 5);
    frame[5 + params.length] = ack;
    const crc = crc16Xmodem(frame, 0, 6 + params.length);
    frame[6 + params.length] = (crc >> 8) & 0xFF;
    frame[7 + params.length] = crc & 0xFF;
    return frame;
}

async function makeLink (options: { quietMs?: number, maxDrainMs?: number, retryDelayMs?: number, maxRxBytes?: number } = {}) {
    const transport = new FakeTransport();
    await transport.open();
    const clock = new VirtualClock();
    const link = new Link(transport, { clock, ...options });
    return { transport, clock, link };
}

const readRequest = (bytes: number) =>
    encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceRead, [bytes], 0x7C00);

const baseOptions = { probe: isCompleteFourWayFrame, timeout: 1000 };

/** Reject a promise into a value, so a test can advance the clock first. */
const settle = <T>(promise: Promise<T>) => promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
);

describe('Link: single-flight (audit E)', () => {
    it('serialises two concurrent requests instead of interleaving them', async () => {
        const { transport, clock, link } = await makeLink();

        const first = settle(link.request(readRequest(4), { ...baseOptions, label: 'first' }));
        const second = settle(link.request(readRequest(8), { ...baseOptions, label: 'second' }));

        // Both callers are inside request(); only the first frame may be on the wire.
        await clock.advance(0);
        expect(transport.writes).toHaveLength(1);
        expect(transport.writes[0]).toEqual(readRequest(4));

        const replyToFirst = fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [1, 2, 3, 4]);
        transport.push(replyToFirst);
        await clock.advance(0);

        // Only now does the second exchange start.
        expect(transport.writes).toHaveLength(2);
        expect(transport.writes[1]).toEqual(readRequest(8));

        const replyToSecond = fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [5, 6, 7, 8, 9, 10, 11, 12]);
        transport.push(replyToSecond);
        await clock.advance(0);

        const a = await first;
        const b = await second;
        expect(a.ok && a.value).toEqual(replyToFirst);
        expect(b.ok && b.value).toEqual(replyToSecond);
    });

    it('gives each caller its own bytes when both replies arrive in one chunk', async () => {
        const { transport, clock, link } = await makeLink();

        const replyA = fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [0xAA]);
        const replyB = fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [0xBB]);

        // The FC answers as soon as it is asked, which is how two exchanges used
        // to end up eating each other's bytes.
        transport.onWrite = (_frame, index) => {
            transport.push(index === 0 ? replyA : replyB);
        };

        const first = link.request(readRequest(1), { ...baseOptions, label: 'A' });
        const second = link.request(readRequest(1), { ...baseOptions, label: 'B' });
        await clock.advance(0);

        expect(parseFourWayResponse(await first).params).toEqual(Uint8Array.of(0xAA));
        expect(parseFourWayResponse(await second).params).toEqual(Uint8Array.of(0xBB));
    });

    it('does not wedge the queue when an exchange fails', async () => {
        const { transport, clock, link } = await makeLink();

        const doomed = settle(link.request(readRequest(4), { ...baseOptions, timeout: 100, label: 'doomed' }));
        const next = settle(link.request(readRequest(4), { ...baseOptions, label: 'next' }));

        await clock.advance(100);
        const failed = await doomed;
        expect(failed.ok).toBe(false);

        // The second request must have started despite the first one failing.
        // It drains first -- a timed-out exchange leaves the line suspect --
        // which is the one quiet window it has to pay for.
        await clock.advance(25);
        expect(transport.writes).toHaveLength(2);
        transport.push(fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [1, 2, 3, 4]));
        await clock.advance(0);
        expect((await next).ok).toBe(true);
    });
});

describe('Link: every path settles (audit G)', () => {
    it('rejects when the write fails instead of hanging forever', async () => {
        const { transport, clock, link } = await makeLink();
        transport.writeError = new Error('device disconnected');

        const result = settle(link.request(readRequest(4), { ...baseOptions, retries: 2, label: 'doomed' }));
        await clock.runAll();

        const outcome = await result;
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.error).toBeInstanceOf(LinkError);
        expect(outcome.ok === false && (outcome.error as LinkError).reason).toBe('write');
        expect(outcome.ok === false && (outcome.error as LinkError).message).toContain('device disconnected');
    });

    it('rejects with reason timeout after exhausting the attempts', async () => {
        const { transport, clock, link } = await makeLink();

        const result = settle(link.request(readRequest(4), {
            ...baseOptions,
            timeout: 100,
            retries: 3,
            label: 'read'
        }));
        await clock.runAll();

        const outcome = await result;
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && (outcome.error as LinkError).reason).toBe('timeout');
        expect(outcome.ok === false && (outcome.error as LinkError).attempts).toBe(3);
        expect(transport.writes).toHaveLength(3);
        expect(link.stats.timeouts).toBe(3);
    });

    it('answers the caller at the deadline even when the write is still pending', async () => {
        const { transport, clock, link } = await makeLink();

        // The nastiest ordering: the budget runs out while the write is still
        // pending, and only later does the write fail. The timeout must reach
        // the caller at the deadline -- the write is raced, not awaited -- and
        // the write's own late rejection must stay observed. Vitest fails the
        // run on an unhandled rejection, so the second half pins itself.
        let failWrite!: (error: Error) => void;
        transport.writeGate = new Promise<void>((_resolve, reject) => {
            failWrite = reject;
        });

        const result = settle(link.request(readRequest(4), { ...baseOptions, timeout: 100, retries: 1 }));
        await clock.advance(100);

        const outcome = await result;
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && (outcome.error as LinkError).reason).toBe('timeout');

        failWrite(new Error('device disconnected mid-write'));
        await clock.advance(0);
    });

    it('walks the retry-delay ladder, repeating its last rung', async () => {
        const { clock, link } = await makeLink();

        // No replies ever arrive, so every attempt runs out its 100 ms budget.
        // The ladder gives retries 100 then 500 then 100 again -- the shape
        // initFlash uses, where the long rung is a deliberate silence.
        const result = settle(link.request(readRequest(4), {
            ...baseOptions,
            timeout: 100,
            retries: 5,
            retryDelaysMs: [100, 500, 100]
        }));
        await clock.runAll();

        const outcome = await result;
        expect(outcome.ok).toBe(false);
        // 5 x 100 ms attempts, 100 + 500 + 100 + 100 ms of ladder (the last
        // rung repeats), and a 25 ms quiet-window drain before each retry (the
        // failed attempt marked the line dirty).
        expect(clock.now()).toBe(1400);
    });

    it('bounds a write that never settles instead of hanging the exchange', async () => {
        const { transport, clock, link } = await makeLink();
        // A wedged CDC endpoint: the write neither resolves nor rejects, ever.
        transport.writeGate = new Promise<void>(() => {});

        const result = settle(link.request(readRequest(4), {
            ...baseOptions,
            timeout: 100,
            retries: 2,
            label: 'wedged'
        }));
        await clock.runAll();

        const outcome = await result;
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && (outcome.error as LinkError).reason).toBe('timeout');
        expect(link.stats.timeouts).toBe(2);
        expect(transport.writes).toHaveLength(2);
    });

    it('rejects a request on a closed transport without writing', async () => {
        const { transport, clock, link } = await makeLink();
        await transport.close();

        const result = settle(link.request(readRequest(4), { ...baseOptions, retries: 5 }));
        await clock.runAll();

        const outcome = await result;
        expect(outcome.ok === false && (outcome.error as LinkError).reason).toBe('closed');
        // A closed transport is not a transient fault: no point burning retries.
        expect(transport.writes).toHaveLength(0);
    });

    it('rejects an in-flight exchange when the link is disposed', async () => {
        const { clock, link, transport } = await makeLink();

        const result = settle(link.request(readRequest(4), baseOptions));
        await clock.advance(0);
        link.dispose();

        const outcome = await result;
        expect(outcome.ok === false && (outcome.error as LinkError).reason).toBe('disposed');
        expect(transport.listenerCount).toBe(0);
    });
});

describe('Link: drain (audit G double drain)', () => {
    it('costs no time at all while the line stays quiet', async () => {
        const { transport, clock, link } = await makeLink();
        transport.onWrite = () => {
            transport.push(fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceWrite, [0]));
        };

        for (let i = 0; i < 5; i += 1) {
            await link.request(
                encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceWrite, [1, 2, 3, 4], 0x1000),
                baseOptions
            );
        }

        // The old path drained twice per exchange with a >=25 ms floor each --
        // 250 ms of dead time for these five writes, ~12 s across a full flash.
        expect(link.stats.drains).toBe(0);
        expect(clock.now()).toBe(0);
    });

    it('drains once per attempt, and the cost model is exactly that', async () => {
        const { transport, clock, link } = await makeLink({ quietMs: 25, retryDelayMs: 300 });

        // Unsolicited bytes: the line is dirty, so every attempt must drain.
        transport.push([0xDE, 0xAD]);

        const result = settle(link.request(readRequest(4), {
            ...baseOptions,
            timeout: 100,
            retries: 2,
            label: 'read'
        }));
        await clock.runAll();

        expect((await result).ok).toBe(false);
        expect(link.stats.drains).toBe(2);
        expect(link.stats.attempts).toBe(2);
        // drain 25 + timeout 100 + retry 300 + drain 25 + timeout 100.
        expect(clock.now()).toBe(550);
    });

    it('discards stale bytes so they cannot poison the next exchange', async () => {
        const { transport, clock, link } = await makeLink({ quietMs: 25 });

        // A truncated reply from an exchange that already gave up.
        transport.push([0x2E, 0x3A, 0x7C, 0x00, 0x04, 0x01]);
        expect(link.bufferedBytes).toBe(6);

        const reply = fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [9, 9, 9, 9]);
        const pending = link.request(readRequest(4), baseOptions);

        await clock.advance(25);
        expect(link.bufferedBytes).toBe(0);
        transport.push(reply);
        await clock.advance(0);

        // Byte-identical to the reply: no leftovers prepended.
        expect(await pending).toEqual(reply);
    });

    it('gives up on a line that never goes quiet, bounded by maxDrainMs', async () => {
        const { transport, clock, link } = await makeLink({ quietMs: 25, maxDrainMs: 100 });

        // Something is streaming at us -- MAVLink on an ArduPilot port, say.
        transport.push([0xFD]);
        let flooding = true;
        const tick = () => {
            if (!flooding) {
                return;
            }
            transport.push([0xFD]);
            clock.setTimeout(tick, 5);
        };
        clock.setTimeout(tick, 5);

        const drained = link.drain().then(() => ({ at: clock.now(), buffered: link.bufferedBytes }));
        await clock.advance(500);
        flooding = false;

        // Bounded by maxDrainMs rather than waiting out the flood, and the
        // buffered garbage is gone either way.
        expect(await drained).toEqual({ at: 100, buffered: 0 });
    });
});

describe('Link: one continuous RX buffer (audit E)', () => {
    it('assembles a reply that arrives in three chunks', async () => {
        const { transport, clock, link } = await makeLink();
        const reply = fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [1, 2, 3, 4, 5, 6, 7, 8]);

        const pending = link.request(readRequest(8), baseOptions);
        await clock.advance(0);

        transport.push(reply.subarray(0, 3));
        transport.push(reply.subarray(3, 11));
        await clock.advance(0);
        expect(link.bufferedBytes).toBe(11);

        transport.push(reply.subarray(11));
        await clock.advance(0);

        expect(await pending).toEqual(reply);
        expect(link.bufferedBytes).toBe(0);
    });

    it('caps the buffer instead of growing without bound', async () => {
        const { transport, clock, link } = await makeLink({ maxRxBytes: 64 });

        const pending = settle(link.request(readRequest(4), { ...baseOptions, timeout: 50 }));
        await clock.advance(0);

        for (let i = 0; i < 20; i += 1) {
            transport.push(new Uint8Array(32).fill(0x55));
        }
        expect(link.bufferedBytes).toBe(64);

        await clock.runAll();
        expect((await pending).ok).toBe(false);
        expect(link.stats.discardedBytes).toBeGreaterThan(0);
    });

    it('keeps unsolicited bytes out of the next reply', async () => {
        const { transport, clock, link } = await makeLink({ quietMs: 25 });

        transport.push([0x01, 0x02, 0x03]);
        expect(link.bufferedBytes).toBe(3);

        const reply = fourWayResponse(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, [0]);
        const pending = link.request(
            encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, [0]),
            baseOptions
        );
        await clock.advance(25);
        transport.push(reply);
        await clock.advance(0);

        expect(await pending).toEqual(reply);
    });
});

describe('Link: validate and retry', () => {
    it('retries a non-OK ACK and returns the frame that is finally good', async () => {
        const { transport, clock, link } = await makeLink({ retryDelayMs: 10 });

        transport.onWrite = (_frame, index) => {
            transport.push(index === 0
                ? fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [0], FOUR_WAY_ACK.ACK_D_GENERAL_ERROR)
                : fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [0x1F, 0x06], FOUR_WAY_ACK.ACK_OK));
        };

        const pending = link.request(
            encodeFourWayRequest(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, [0]),
            {
                ...baseOptions,
                retries: 4,
                validate: (response) => {
                    const parsed = parseFourWayResponse(response);
                    if (parsed.ack !== FOUR_WAY_ACK.ACK_OK) {
                        throw new Error(`ack ${parsed.ack}`);
                    }
                }
            }
        );
        await clock.runAll();

        expect(parseFourWayResponse(await pending).params).toEqual(Uint8Array.of(0x1F, 0x06));
        expect(transport.writes).toHaveLength(2);
    });

    it('reports the validator failure when every attempt is rejected', async () => {
        const { transport, clock, link } = await makeLink({ retryDelayMs: 10 });

        transport.onWrite = () => {
            transport.push(fourWayResponse(FOUR_WAY_COMMANDS.cmd_DeviceRead, [0], FOUR_WAY_ACK.ACK_I_INVALID_CHANNEL));
        };

        const result = settle(link.request(readRequest(4), {
            ...baseOptions,
            retries: 3,
            label: 'read',
            validate: () => {
                throw new Error('ACK_I_INVALID_CHANNEL');
            }
        }));
        await clock.runAll();

        const outcome = await result;
        expect(outcome.ok).toBe(false);
        const error = outcome.ok === false ? outcome.error as LinkError : null;
        expect(error?.reason).toBe('validate');
        expect(error?.attempts).toBe(3);
        expect(error?.message).toContain('ACK_I_INVALID_CHANNEL');
        expect(transport.writes).toHaveLength(3);
    });

    it('sends exactly once when retries is 1', async () => {
        const { transport, clock, link } = await makeLink();
        const result = settle(link.request(readRequest(4), { ...baseOptions, timeout: 50, retries: 1 }));
        await clock.runAll();
        expect((await result).ok).toBe(false);
        expect(transport.writes).toHaveLength(1);
    });
});

describe('Link: all time comes from the injected clock', () => {
    it('does nothing on its own when the clock does not move', async () => {
        const { transport, clock, link } = await makeLink();
        const result = settle(link.request(readRequest(4), { ...baseOptions, timeout: 10, retries: 5 }));

        // 10 ms of timeout, five times over, and not one of them can fire while
        // the virtual clock is parked. A stray wall-clock read or host timer
        // below the session layer would show up here as a settled promise.
        await clock.advance(0);
        expect(transport.writes).toHaveLength(1);
        expect(clock.now()).toBe(0);

        await clock.runAll();
        expect((await result).ok).toBe(false);
        // First attempt: 10 ms of timeout, no drain (the line started clean).
        // Each retry: 300 ms retry delay, one 25 ms quiet window because the
        // previous attempt left the line suspect, then 10 ms of timeout.
        expect(clock.now()).toBe(10 + 4 * (300 + 25 + 10));
    });
});
