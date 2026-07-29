import { Link, type LinkRequestOptions } from 'am32-core/link/link';
import { TimeoutPolicy } from 'am32-core/link/timeout-policy';
import { createSystemClock } from 'am32-core/clock';
import { WebSerialTransport } from 'am32-web';

/**
 * The app's handle on the link layer.
 *
 * Block 2 hollowed this out: the exchange loop, the RX buffer, drain, retry and
 * every timeout now live in `am32-core`'s {@link Link} and `TimeoutPolicy`, and
 * the bytes move over `am32-web`'s `WebSerialTransport`. What is left here is
 * the singleton lifetime the Vue side expects. Block 4's `Am32Session` owns that
 * lifetime instead, and this file goes away with it.
 *
 * Deliberately no `read()`: the link holds the only reader. The old
 * `readWithTimeout` path grabbed a second one behind its back and threw
 * (audit item E).
 */
class Serial {
    private log: LogFn = (_s: string) => {};
    private logError: LogFn = (_s: string) => {};

    private transport: WebSerialTransport | null = null;
    private link: Link | null = null;

    /** Timeouts for every exchange. Never a literal at a call site (audit C). */
    policy = new TimeoutPolicy();

    async init (
        log: LogFn,
        logError: LogFn,
        _logWarning: LogFn,
        port: SerialPort,
        baudRate: number
    ): Promise<void> {
        await this.deinit();

        this.log = log;
        this.logError = logError;

        this.transport = new WebSerialTransport(port, {
            log,
            onError: (error: Error) => logError(`Serial read failed: ${error.message}`)
        });
        this.link = new Link(this.transport, {
            clock: createSystemClock(),
            log
        });

        await this.transport.open({ baudRate });
    }

    async deinit (): Promise<void> {
        const link = this.link;
        const transport = this.transport;
        this.link = null;
        this.transport = null;

        link?.dispose();
        if (transport) {
            await transport.close();
        }
    }

    get isOpen (): boolean {
        return this.transport?.isOpen ?? false;
    }

    /**
     * Discard stale inbound bytes and wait for a quiet line. Serialised with
     * exchanges by the link, so it can no longer steal bytes from one in flight.
     */
    async drain (quietMs?: number, maxMs?: number): Promise<void> {
        await this.link?.drain(quietMs, maxMs);
    }

    /** One request/response exchange. Rejects on failure; never resolves null. */
    request (frame: Uint8Array, options: LinkRequestOptions): Promise<Uint8Array> {
        if (!this.link) {
            this.logError('Serial not initiated!');
            throw new Error('Serial not initiated!');
        }
        return this.link.request(frame, options);
    }
}

export default new Serial();
