import type { Transport } from 'am32-core/transport';

/**
 * Web Serial {@link Transport}. Moves bytes, and nothing else.
 *
 * This replaces the third-party Web Serial wrapper package the overhaul
 * removed -- the hygiene gate greps these paths for its name, so it cannot be
 * spelled out here (issue #3, audit item E, names it). Every one of that item's
 * defects lived in the package or in the shim around it:
 *
 *  - **It patched the global timers at import time.** It installed a Web Worker
 *    "HackTimer" over `setTimeout`/`setInterval`, so every protocol timeout took
 *    a `postMessage` round trip -- jitter injected into exactly the timing 4-way
 *    depends on, and a silent fallback under a CSP that blocks `blob:` workers.
 *    Nothing here touches a global.
 *  - **Its read loop died silently.** `readStream`'s error path did
 *    `delete r.reader; this.reconnect(r)`, and `reconnect` dereferenced
 *    `r.settings.beforedisconnect`, which `createStream` never set -- so a USB
 *    framing error threw inside a promise executor and the stream stopped with
 *    no diagnostic. Here a read error the port recovers from (overrun, break,
 *    framing, parity) is logged and reading carries on with the fresh stream
 *    the port hands out. A fatal one is reported once through `onError`, closes
 *    the port and flips `isOpen` to false; {@link open} reopens it.
 *  - **`disconnectFromDevice` never stopped the loop.** It closed the port but
 *    left `stream.running` true, so the loop kept spinning and reconnecting
 *    started a second one. {@link close} awaits the loop's exit before it lets
 *    go of the port, so there is never more than one reader.
 *  - **One `ondata` handler, swapped between exchanges.** {@link onData} is a
 *    subscription set: the link layer takes one and keeps it for the session.
 *  - **`read()` grabbed a second reader** while the loop held the lock, which
 *    throws. There is no such method: bytes arrive by subscription only.
 */

export interface WebSerialTransportOptions {
    /** Called once per fatal read failure. The loop stops; the port is closed. */
    onError?: (error: Error) => void
    log?: (message: string) => void
}

/**
 * Chrome's default is 255 bytes, so every 255 bytes of inbound data cost a
 * round trip between the browser's device service and the page.
 */
const BUFFER_SIZE = 64 * 1024;

/**
 * Added when the read side dies again right after a reopen succeeded, which
 * rules out an unplugged board. Chrome before 156 keeps whatever VMIN the last
 * program left on the tty, and pyserial leaves 0; a read on an idle port then
 * returns 0 bytes, which Chrome reports as a lost device as soon as the reader
 * catches up with the data (fixed in Chromium 45ccdf6e7af9). Reopening
 * inherits the same VMIN.
 */
const REPEAT_FAILURE_HINT =
    'The port reopened and failed again, so the board is still attached. On Linux, Chrome before 156 ' +
    'does this when another program (pyserial, MAVProxy) left the port with VMIN=0: ' +
    'run `stty -F /dev/ttyACM<n> min 1`, then reconnect.';

/** A failure later than this after a reopen says nothing about the reopen. */
const REPEAT_FAILURE_WINDOW_MS = 5000;

const asError = (error: unknown): Error =>
    (error instanceof Error ? error : new Error(String(error)));

export class WebSerialTransport implements Transport {
    private readonly port: SerialPort;
    private readonly onError: (error: Error) => void;
    private readonly log: (message: string) => void;
    private readonly listeners = new Set<(chunk: Uint8Array) => void>();

    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private loop: Promise<void> = Promise.resolve();
    private running = false;
    /** True only when this instance called `port.open()` and must close it. */
    private opened = false;
    /** The last read loop ended in a fatal error. */
    private failed = false;
    /** `Date.now()` at an open that followed a fatal error. */
    private reopenedAt: number | null = null;

    constructor (port: SerialPort, options: WebSerialTransportOptions = {}) {
        this.port = port;
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

        // A fatal read error closes the port from inside the loop, and opening
        // before that close lands throws "already open".
        await this.loop.catch(() => {});

        // A port the browser already handed us open (a reconnect that never
        // fully closed) has readable set; opening it again throws.
        if (!this.readableStream()) {
            await this.port.open({ baudRate: opts.baudRate, bufferSize: BUFFER_SIZE });
            this.opened = true;
        }

        const readable = this.readableStream();
        const writable = this.port.writable as WritableStream<Uint8Array> | null;
        if (!readable || !writable) {
            await this.releasePort(true);
            throw new Error('serial port opened without a readable/writable stream');
        }

        const reader = readable.getReader();
        this.reader = reader;
        this.writer = writable.getWriter();
        this.reopenedAt = this.failed ? Date.now() : null;
        this.failed = false;
        this.running = true;
        this.loop = this.readLoop(reader);
        this.log(`serial port open at ${opts.baudRate} baud`);
    }

    async close (): Promise<void> {
        this.failed = false;
        this.reopenedAt = null;

        if (!this.running && !this.reader && !this.writer && !this.opened) {
            await this.loop.catch(() => {});
            return;
        }

        // Stop the loop first: cancel() makes the pending read() resolve, and
        // `running = false` keeps it from starting another one.
        this.running = false;

        const reader = this.reader;
        this.reader = null;
        if (reader) {
            await reader.cancel().catch(() => {});
        }

        // The loop owns releasing the reader lock; wait for it to actually exit
        // so we never leave a second one running behind a reconnect.
        await this.loop.catch(() => {});
        await this.releasePort(false);
        this.log('serial port closed');
    }

    async write (data: Uint8Array): Promise<void> {
        if (!this.running || !this.writer) {
            throw new Error('serial port is not open');
        }
        await this.writer.write(data);
    }

    onData (cb: (chunk: Uint8Array) => void): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    /** Null while the port is closed, and after a fatal read error until it is reopened. */
    private readableStream (): ReadableStream<Uint8Array> | null {
        return (this.port.readable as ReadableStream<Uint8Array> | null) ?? null;
    }

    private async readLoop (first: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
        let reader = first;

        while (this.running) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
                result = await reader.read();
            } catch (error) {
                this.releaseReader(reader);
                if (!this.running) {
                    return;
                }

                // The Web Serial spec's non-fatal errors (overrun, break,
                // framing, parity) leave the port handing out a fresh stream.
                const next = this.readableStream();
                if (next) {
                    this.log(`serial read error, reading on: ${asError(error).message}`);
                    reader = next.getReader();
                    this.reader = reader;
                    continue;
                }

                await this.fail(asError(error));
                return;
            }

            if (result.done) {
                this.releaseReader(reader);
                if (this.running) {
                    await this.fail(new Error('the serial port stopped delivering data'));
                }
                return;
            }

            if (result.value.length > 0) {
                this.emit(result.value);
            }
        }

        this.releaseReader(reader);
    }

    /**
     * Report a dead read side once and close the port, even one we adopted: it
     * reads nothing for anyone until it is closed, and closing is what lets
     * {@link open} reopen it.
     */
    private async fail (error: Error): Promise<void> {
        this.running = false;
        this.reader = null;

        const repeat = this.reopenedAt !== null && Date.now() - this.reopenedAt < REPEAT_FAILURE_WINDOW_MS;
        const reported = repeat
            ? new Error(`${error.message} ${REPEAT_FAILURE_HINT}`, { cause: error })
            : error;
        this.failed = true;
        try {
            this.onError(reported);
        } catch {
            // The port still has to be closed.
        }

        await this.releasePort(true);
        this.log('serial port closed');
    }

    private releaseReader (reader: ReadableStreamDefaultReader<Uint8Array>): void {
        try {
            reader.releaseLock();
        } catch {
            // cancel() may have released it already.
        }
        if (this.reader === reader) {
            this.reader = null;
        }
    }

    private async releasePort (closeAdopted: boolean): Promise<void> {
        const writer = this.writer;
        this.writer = null;
        if (writer) {
            // releaseLock rather than close(): `port.close()` only needs the
            // stream unlocked, and releasing is synchronous. Awaiting a
            // `writer.close()` on a device that has already gone away can hang,
            // and this runs on the disconnect button. Every write is awaited by
            // the link, so there is nothing buffered to lose.
            try {
                writer.releaseLock();
            } catch (error: unknown) {
                this.log(`serial writer release failed: ${asError(error).message}`);
            }
        }

        if (this.opened || closeAdopted) {
            this.opened = false;
            await this.port.close().catch((error: unknown) => {
                this.log(`serial port close failed: ${asError(error).message}`);
            });
        }
    }

    private emit (chunk: Uint8Array): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(chunk);
            } catch (error) {
                // A throwing subscriber must not kill the read loop.
                this.onError(asError(error));
            }
        }
    }
}
