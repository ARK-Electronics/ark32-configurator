import type { Transport } from 'am32-core/transport';
import type { NodeSerialPortLike, NodeSerialPortOptions } from './serialport-types';

/**
 * `node-serialport` {@link Transport}. Moves bytes, and nothing else.
 *
 * The peer of `am32-web`'s `WebSerialTransport`, deliberately built to the same
 * shape so that the CLI and the browser cannot diverge below the link layer: one
 * subscription set for inbound bytes, no framing, no timeouts, no retries, no
 * drain-for-quiet, and **no `read()`**. Everything that could differ between the
 * two lives above this file, in `am32-core`.
 *
 * Two differences from the Web Serial version, both forced by the platform and
 * neither of them behavioural:
 *
 *  - **The port is constructed here, not handed in.** `new SerialPort(...)` takes
 *    the baud rate, where Web Serial takes it in `port.open()`. So the caller
 *    supplies a `createPort` factory and this class calls it from
 *    {@link open} -- which is also what makes the class testable against
 *    `SerialPortMock` and against a hand fake with no serial port present.
 *  - **{@link write} drains.** Web Serial's `writer.write()` resolves once the
 *    bytes are queued in the browser; node-serialport's `write` callback fires
 *    once they reach the binding, which can be a long way from the wire when the
 *    OS buffer is deep. `drain(2)` is what makes "the write resolved" mean "the
 *    bytes have been shifted out", and the link starts its timeout the moment
 *    the write resolves -- so without the drain a slow write would be charged to
 *    the ESC's reply budget.
 *
 * Note what this class still cannot do, which is a gap in the `Transport`
 * interface rather than in this file: it has no way to fail an *in-flight*
 * exchange when the device goes away. Blocks 2 through 6 each recorded it. An
 * unplug mid-exchange is reported through {@link NodeSerialTransportOptions.onError}
 * and flips {@link isOpen}, but the pending attempt still waits out its timeout
 * before the next one rejects with `closed`.
 */

export interface NodeSerialTransportOptions {
    /** OS device path -- `/dev/ttyACM0`, `COM3`. */
    path: string
    /**
     * Builds the port. Production passes the real `SerialPort` constructor
     * (see `serialport-loader.ts`); tests pass `SerialPortMock` or a fake.
     */
    createPort: (options: NodeSerialPortOptions) => NodeSerialPortLike
    /**
     * Called once per unrecoverable port failure -- a read error, or the device
     * disappearing. The transport stops; the caller decides what to do.
     */
    onError?: (error: Error) => void
    log?: (message: string) => void
}

const asError = (error: unknown): Error =>
    (error instanceof Error ? error : new Error(String(error)));

export class NodeSerialTransport implements Transport {
    private readonly path: string;
    private readonly createPort: (options: NodeSerialPortOptions) => NodeSerialPortLike;
    private readonly onError: (error: Error) => void;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<(chunk: Uint8Array) => void>();

    private port: NodeSerialPortLike | null = null;
    private running = false;

    constructor (options: NodeSerialTransportOptions) {
        this.path = options.path;
        this.createPort = options.createPort;
        this.onError = options.onError ?? (() => {});
        this.log = options.log ?? (() => {});
    }

    get isOpen (): boolean {
        return this.running;
    }

    async open (opts: { baudRate: number }): Promise<void> {
        if (this.running) {
            return;
        }

        // autoOpen: false so the failure arrives as a rejected promise rather
        // than an 'error' event on an object the caller does not hold yet.
        const port = this.createPort({ path: this.path, baudRate: opts.baudRate, autoOpen: false });

        await new Promise<void>((resolve, reject) => {
            port.open((error) => {
                if (error) {
                    reject(asError(error));
                } else {
                    resolve();
                }
            });
        });

        port.on('data', chunk => this.emit(chunk));
        port.on('error', error => this.fail(asError(error)));
        // An unplug closes the port under us. Nothing above knows unless it is
        // told, and a silently dead port is the failure blocks 2-6 kept flagging.
        port.on('close', () => {
            if (this.running) {
                this.fail(new Error(`serial port ${this.path} closed unexpectedly`));
            }
        });

        this.port = port;
        this.running = true;
        this.log(`serial port ${this.path} open at ${opts.baudRate} baud`);
    }

    async close (): Promise<void> {
        const port = this.port;
        if (!port) {
            this.running = false;
            return;
        }

        // Clear the handlers before closing: the close itself emits 'close', and
        // that must not be reported as the port dying under us.
        this.running = false;
        this.port = null;
        port.removeAllListeners();

        if (port.isOpen) {
            await new Promise<void>((resolve) => {
                port.close((error) => {
                    if (error) {
                        this.log(`serial port close failed: ${asError(error).message}`);
                    }
                    resolve();
                });
            });
        }

        this.log(`serial port ${this.path} closed`);
    }

    async write (data: Uint8Array): Promise<void> {
        const port = this.port;
        if (!this.running || !port) {
            throw new Error(`serial port ${this.path} is not open`);
        }

        await new Promise<void>((resolve, reject) => {
            port.write(data, (error) => {
                if (error) {
                    reject(asError(error));
                } else {
                    resolve();
                }
            });
        });

        // See the class comment: the link's timeout starts when this resolves,
        // so it has to mean "gone", not "queued".
        await new Promise<void>((resolve, reject) => {
            port.drain((error) => {
                if (error) {
                    reject(asError(error));
                } else {
                    resolve();
                }
            });
        });
    }

    onData (cb: (chunk: Uint8Array) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    private emit (chunk: Uint8Array): void {
        if (chunk.length === 0) {
            return;
        }
        for (const listener of [...this.listeners]) {
            try {
                listener(chunk);
            } catch (error) {
                // A throwing subscriber must not take the port down with it.
                this.onError(asError(error));
            }
        }
    }

    /** Report a port-level failure once, and stop. */
    private fail (error: Error): void {
        if (!this.running) {
            return;
        }
        this.running = false;
        this.onError(error);
    }
}
