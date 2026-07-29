/**
 * The link layer: one request/response exchange at a time over a
 * {@link Transport}, with drain, retry and timeout semantics that used to be
 * spread across `src/communication/serial.ts`, `four_way.ts` and
 * `@am32/serial-msp`'s transport -- each with its own bugs.
 *
 * What this file exists to fix (audit items E and G in issue #3):
 *
 *  - **No mutex, no queue.** The old `SerialTransport.exchange` installed a
 *    single `stream.ondata` handler and `Serial.drain` swapped it out from under
 *    it. Two overlapping exchanges ate each other's bytes. Here a promise-chain
 *    mutex makes `request()` strictly single-flight: overlapping requests are
 *    impossible rather than unlikely.
 *  - **Handler swapping.** There is one continuous RX buffer, appended to by one
 *    subscription taken at construction. `drain()` discards bytes; it never
 *    swaps a handler.
 *  - **Double drain.** The old code drained in `sendWithPromise` *and* again in
 *    `writeWithResponse`, each with a >=25 ms floor -- ~12 s of dead time across
 *    a full flash. Here drain happens once per attempt, and costs nothing at all
 *    when the line has been quiet since the last exchange.
 *  - **The promise that never settles.** `four_way.ts` passed an `async`
 *    function to `new Promise`, so anything thrown outside its inner `try` --
 *    a drain failure, a write failure -- was swallowed and the caller hung
 *    forever. Every path here settles: the executor is synchronous, and the
 *    retry loop is a plain `async` function whose rejections propagate.
 *
 * All time comes from the injected {@link Clock}. See `../clock.ts`.
 */

import type { Clock, ClockTimer } from '../clock';
import type { Transport } from '../transport';

/** True once `buffer` holds a structurally complete response. */
export type LinkProbe = (buffer: Uint8Array) => boolean;

/**
 * Rejects a response that is structurally complete but wrong -- an MSP reply
 * that does not echo the command, a 4-way frame whose ACK is not `ACK_OK`, a
 * bad checksum. Throw to reject; a rejected response is retried like a timeout.
 */
export type LinkValidator = (response: Uint8Array) => void;

export type LinkErrorReason =
    /** No structurally complete response inside the budget. */
    | 'timeout'
    /** The transport is not open. */
    | 'closed'
    /** `transport.write` rejected. */
    | 'write'
    /** `validate` rejected every attempt. */
    | 'validate'
    /** The link was disposed while the exchange was in flight. */
    | 'disposed';

export class LinkError extends Error {
    readonly reason: LinkErrorReason;
    readonly attempts: number;

    constructor (reason: LinkErrorReason, message: string, attempts = 1, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'LinkError';
        this.reason = reason;
        this.attempts = attempts;
    }
}

export interface LinkRequestOptions {
    /** When the reply is structurally complete. From `framing/*`, never inline. */
    probe: LinkProbe
    /** Milliseconds for one attempt. From `TimeoutPolicy`, never a literal. */
    timeout: number
    /**
     * Total attempts, not extra attempts: 1 sends the frame once. Matches the
     * meaning the app's `sendWithPromise` retry counter always had.
     */
    retries?: number
    validate?: LinkValidator
    /** Skip the pre-attempt drain. Only for a command whose reply is a stream. */
    drain?: boolean
    /** Shown in log lines and error messages. */
    label?: string
}

export interface LinkOptions {
    clock: Clock
    /** How long the line must be silent for a drain to call it quiet. */
    quietMs?: number
    /** Upper bound on one drain. */
    maxDrainMs?: number
    /** Delay between attempts. */
    retryDelayMs?: number
    /** RX bytes kept while waiting for a probe to fire. Older bytes are dropped. */
    maxRxBytes?: number
    log?: (message: string) => void
}

export interface LinkStats {
    /** Exchanges started, counting retries. */
    attempts: number
    /** Attempts that ran out of budget. */
    timeouts: number
    /** Drains that actually had to wait for a quiet line. */
    drains: number
    /** Bytes thrown away by a drain or by the RX cap. */
    discardedBytes: number
}

const DEFAULT_QUIET_MS = 25;
const DEFAULT_MAX_DRAIN_MS = 200;
const DEFAULT_RETRY_DELAY_MS = 300;

/**
 * A 4-way response tops out at 264 bytes and an MSP v1 response at 262, so this
 * is two orders of magnitude of headroom. It exists so garbage on the line
 * cannot grow the buffer without bound -- the failure mode block 1b fixed in
 * `MspParser` and that applies just as much here.
 */
const DEFAULT_MAX_RX_BYTES = 4096;

const EMPTY = new Uint8Array(0);

interface PendingExchange {
    probe: LinkProbe
    resolve: (response: Uint8Array) => void
    reject: (error: unknown) => void
    done: boolean
}

const describe = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error));

export class Link {
    private readonly transport: Transport;
    private readonly clock: Clock;
    private readonly quietMs: number;
    private readonly maxDrainMs: number;
    private readonly retryDelayMs: number;
    private readonly maxRxBytes: number;
    private readonly log: (message: string) => void;

    /** One continuous RX buffer, never handed to more than one exchange. */
    private rx: Uint8Array = EMPTY;
    private pending: PendingExchange | null = null;
    /** Bytes arrived that no exchange consumed, so the next drain must wait. */
    private dirty = false;
    private lastChunkAt = Number.NEGATIVE_INFINITY;
    private unsubscribe: (() => void) | null;
    private disposed = false;
    /** Mutex: the tail of the chain of exchanges. */
    private tail: Promise<void> = Promise.resolve();

    readonly stats: LinkStats = { attempts: 0, timeouts: 0, drains: 0, discardedBytes: 0 };

    constructor (transport: Transport, options: LinkOptions) {
        this.transport = transport;
        this.clock = options.clock;
        this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
        this.maxDrainMs = options.maxDrainMs ?? DEFAULT_MAX_DRAIN_MS;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.maxRxBytes = options.maxRxBytes ?? DEFAULT_MAX_RX_BYTES;
        this.log = options.log ?? (() => {});
        this.unsubscribe = transport.onData(chunk => this.handleChunk(chunk));
    }

    /**
     * Write `frame` and resolve with the reply.
     *
     * Serialised against every other `request()` and `drain()` on this link, in
     * call order. Rejects with a {@link LinkError} -- it never resolves null,
     * and it never fails to settle.
     */
    request (frame: Uint8Array, options: LinkRequestOptions): Promise<Uint8Array> {
        if (this.disposed) {
            return Promise.reject(new LinkError('disposed', 'link disposed'));
        }
        return this.enqueue(() => this.exchange(frame, options));
    }

    /**
     * Discard buffered RX and wait for a quiet line. Serialised with exchanges,
     * so it can never pull bytes out from under one in flight.
     */
    drain (quietMs?: number, maxMs?: number): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        return this.enqueue(() => this.drainNow(quietMs, maxMs));
    }

    /** Stop listening and fail anything in flight. Does not close the transport. */
    dispose (): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.settleWith(new LinkError('disposed', 'link disposed while an exchange was in flight'));
        this.rx = EMPTY;
    }

    /** Bytes currently buffered. Diagnostics and tests only. */
    get bufferedBytes (): number {
        return this.rx.length;
    }

    private enqueue<T> (work: () => Promise<T>): Promise<T> {
        const result = this.tail.then(work);
        // Keep the chain alive after a failure: a rejected exchange must not
        // wedge every later one, which is the other half of "always settles".
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    private async exchange (frame: Uint8Array, options: LinkRequestOptions): Promise<Uint8Array> {
        const attempts = Math.max(1, Math.floor(options.retries ?? 1));
        const label = options.label ?? 'request';
        let last: unknown = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (attempt > 1) {
                await this.clock.sleep(this.retryDelayMs);
            }

            if (options.drain !== false) {
                await this.drainNow();
            }

            try {
                const response = await this.attempt(frame, options, label);
                options.validate?.(response);
                return response;
            } catch (error) {
                last = error;
                // Whatever is on the line now belongs to a dead exchange.
                this.dirty = true;
                this.log(`${label}: attempt ${attempt}/${attempts} failed: ${describe(error)}`);

                if (error instanceof LinkError &&
                    (error.reason === 'closed' || error.reason === 'disposed')) {
                    throw error;
                }
            }
        }

        throw this.toLinkError(last, attempts, label);
    }

    /** One write and one reply. Every exit path settles the promise. */
    private attempt (frame: Uint8Array, options: LinkRequestOptions, label: string): Promise<Uint8Array> {
        if (!this.transport.isOpen) {
            return Promise.reject(new LinkError('closed', `${label}: transport is not open`));
        }

        this.stats.attempts += 1;

        let settle!: Pick<PendingExchange, 'resolve' | 'reject'>;
        // Synchronous executor on purpose: an async one swallows throws and the
        // promise never settles. That was audit item G.
        const settled = new Promise<Uint8Array>((resolve, reject) => {
            settle = { resolve, reject };
        });

        const exchange: PendingExchange = { ...settle, probe: options.probe, done: false };
        this.pending = exchange;

        const timer: ClockTimer = this.clock.setTimeout(() => {
            if (exchange.done) {
                return;
            }
            exchange.done = true;
            this.stats.timeouts += 1;
            settle.reject(new LinkError(
                'timeout',
                `${label}: no complete response within ${options.timeout}ms (${this.rx.length} byte(s) buffered)`
            ));
        }, options.timeout);

        return this.runAttempt(frame, settled, label)
            .finally(() => {
                timer.cancel();
                exchange.done = true;
                if (this.pending === exchange) {
                    this.pending = null;
                }
            });
    }

    private async runAttempt (frame: Uint8Array, settled: Promise<Uint8Array>, label: string): Promise<Uint8Array> {
        try {
            await this.transport.write(frame);
        } catch (error) {
            // If the timeout already fired while the write was pending, `settled`
            // is rejected and nothing is going to await it. Attach a handler so
            // that does not surface as an unhandled rejection.
            settled.catch(() => {});
            throw new LinkError('write', `${label}: write failed: ${describe(error)}`, 1, { cause: error });
        }
        return settled;
    }

    /**
     * The drain itself. Returns immediately -- costing no time at all -- when
     * nothing has arrived since the last exchange consumed its reply. That is
     * what keeps a 240-write flash from paying a quiet-window tax per page.
     */
    private async drainNow (quietMs = this.quietMs, maxMs = this.maxDrainMs): Promise<void> {
        if (this.rx.length === 0 && !this.dirty) {
            return;
        }

        this.stats.drains += 1;
        const deadline = this.clock.now() + maxMs;
        this.discard();

        for (;;) {
            await this.clock.sleep(quietMs);
            const now = this.clock.now();
            const quiet = (now - this.lastChunkAt) >= quietMs;
            this.discard();

            if (quiet || now >= deadline) {
                this.dirty = false;
                return;
            }
        }
    }

    private discard (): void {
        if (this.rx.length > 0) {
            this.stats.discardedBytes += this.rx.length;
            this.rx = EMPTY;
        }
    }

    private handleChunk (chunk: Uint8Array): void {
        if (this.disposed || chunk.length === 0) {
            return;
        }

        this.lastChunkAt = this.clock.now();
        this.append(chunk);

        const exchange = this.pending;
        if (!exchange || exchange.done) {
            // Nobody is listening: stale or unsolicited bytes.
            this.dirty = true;
            return;
        }

        if (!exchange.probe(this.rx)) {
            return;
        }

        const response = this.rx;
        this.rx = EMPTY;
        this.dirty = false;
        exchange.done = true;
        this.pending = null;
        exchange.resolve(response);
    }

    private append (chunk: Uint8Array): void {
        const merged = new Uint8Array(this.rx.length + chunk.length);
        merged.set(this.rx, 0);
        merged.set(chunk, this.rx.length);

        if (merged.length <= this.maxRxBytes) {
            this.rx = merged;
            return;
        }

        // Keep the tail: a frame that is still arriving is at the end.
        const dropped = merged.length - this.maxRxBytes;
        this.stats.discardedBytes += dropped;
        this.rx = merged.slice(dropped);
        this.log(`link: RX buffer over ${this.maxRxBytes} bytes, dropped ${dropped} stale byte(s)`);
    }

    private settleWith (error: LinkError): void {
        const exchange = this.pending;
        if (!exchange || exchange.done) {
            return;
        }
        exchange.done = true;
        this.pending = null;
        exchange.reject(error);
    }

    private toLinkError (error: unknown, attempts: number, label: string): LinkError {
        if (error instanceof LinkError) {
            return new LinkError(error.reason, `${error.message} (${attempts} attempt(s))`, attempts, { cause: error });
        }
        return new LinkError(
            'validate',
            `${label}: rejected after ${attempts} attempt(s): ${describe(error)}`,
            attempts,
            { cause: error }
        );
    }
}
