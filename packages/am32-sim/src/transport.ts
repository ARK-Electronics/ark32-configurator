/**
 * `SimTransport` -- the simulator's implementation of the core's
 * {@link Transport}.
 *
 * It is a peer of `am32-web`'s Web Serial transport, not a test-only mock, and
 * that is deliberate (issue #3 section 7.3): anything the session needs that a
 * transport cannot provide shows up immediately as a hole here. Like every other
 * transport it moves bytes and nothing else -- no framing, no timeouts, no
 * retries, no drain.
 *
 * What it adds over a plain byte pipe is *time*. Both directions cost wire time
 * at the host link's baud rate, taken from the injected {@link Clock}, so an
 * exchange in the simulator has a duration the timeout policy is actually
 * measured against. Under `VirtualClock` that costs no wall time at all.
 */

import type { Clock } from 'am32-core/clock';
import type { Transport } from 'am32-core/transport';
import { HOST_LINK_BAUD, wireMs } from 'am32-core/link/timeout-policy';
import { LinkFaults, type FaultDirection } from './faults';

/**
 * The far end of the pipe. {@link import('./fc').SimFc} implements it; the
 * interface exists so the transport does not have to import the FC, which
 * imports the ESCs, which import the eeprom layout.
 */
export interface SimEndpoint {
    /** Bytes from the host have arrived. */
    receive(chunk: Uint8Array): void
    /** Subscribe to bytes the far end sends back. Returns an unsubscribe. */
    onTx(cb: (chunk: Uint8Array) => void): () => void
    /** The host closed the port. */
    onClose?(): void
}

export interface SimTransportOptions {
    clock: Clock
    endpoint: SimEndpoint
    /**
     * Host <-> FC link speed used to charge wire time. Defaults to the core's
     * nominal `HOST_LINK_BAUD`; `open()`'s `baudRate` does *not* change it,
     * because a USB CDC port ignores the requested rate exactly as the real one
     * does.
     */
    baudRate?: number
    /** Fixed extra latency each way, on top of wire time. */
    latencyMs?: number
}

export class SimTransport implements Transport {
    readonly faults = new LinkFaults();

    /** Every frame the host wrote, post-fault. Diagnostics and assertions. */
    readonly writes: Uint8Array[] = [];

    private readonly clock: Clock;
    private readonly endpoint: SimEndpoint;
    private readonly baudRate: number;
    private readonly latencyMs: number;
    private readonly listeners = new Set<(chunk: Uint8Array) => void>();
    private unsubscribe: (() => void) | null = null;
    private open_ = false;

    constructor (options: SimTransportOptions) {
        this.clock = options.clock;
        this.endpoint = options.endpoint;
        this.baudRate = options.baudRate ?? HOST_LINK_BAUD;
        this.latencyMs = Math.max(0, options.latencyMs ?? 0);
        this.faults.emit = (bytes, direction) => this.deliverNow(bytes, direction);
    }

    get isOpen (): boolean {
        return this.open_;
    }

    open (_opts: { baudRate: number }): Promise<void> {
        if (this.open_) {
            return Promise.resolve();
        }
        this.open_ = true;
        this.unsubscribe = this.endpoint.onTx(chunk => this.fromEndpoint(chunk));
        return Promise.resolve();
    }

    close (): Promise<void> {
        if (!this.open_) {
            return Promise.resolve();
        }
        this.open_ = false;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.endpoint.onClose?.();
        return Promise.resolve();
    }

    /**
     * Resolves as soon as the bytes are queued, the way a real serial writer
     * does. The bytes reach the FC one wire time later, which is what makes the
     * host-link half of the timeout derivation observable.
     */
    write (data: Uint8Array): Promise<void> {
        if (!this.open_) {
            return Promise.reject(new Error('SimTransport: port is not open'));
        }

        const bytes = this.faults.apply(data.slice(), 'tx');
        this.writes.push(bytes);

        if (bytes.length > 0) {
            this.after(bytes.length, () => {
                if (this.open_) {
                    this.endpoint.receive(bytes);
                }
            });
        }

        return Promise.resolve();
    }

    onData (cb: (chunk: Uint8Array) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    private fromEndpoint (chunk: Uint8Array): void {
        const bytes = this.faults.apply(chunk, 'rx');
        if (bytes.length === 0) {
            return;
        }
        this.after(bytes.length, () => this.deliverNow(bytes, 'rx'));
    }

    private deliverNow (bytes: Uint8Array, direction: FaultDirection): void {
        if (!this.open_ || bytes.length === 0) {
            return;
        }
        if (direction === 'tx') {
            this.endpoint.receive(bytes);
            return;
        }
        for (const listener of [...this.listeners]) {
            listener(bytes);
        }
    }

    private after (byteCount: number, work: () => void): void {
        const delay = wireMs(byteCount, this.baudRate) + this.latencyMs;
        if (delay <= 0) {
            // Still a timer, not a synchronous call: a transport that delivered
            // its reply inside `write()` would hide every ordering bug there is.
            this.clock.setTimeout(work, 0);
            return;
        }
        this.clock.setTimeout(work, delay);
    }
}
