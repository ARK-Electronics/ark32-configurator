import type { Transport } from 'am32-core/transport';

/**
 * Web Serial {@link Transport}. Moves bytes, and nothing else.
 *
 * This replaces the third-party Web Serial wrapper package block 2 removed --
 * `docs/plans/overhaul/notes/block-2.md` names it, since the hygiene gate greps
 * these paths for the name. Every one of audit item E's defects lived in that
 * package or in the shim around it:
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
 *    no diagnostic. Here a read error ends the loop once, reports through
 *    `onError`, and flips `isOpen` to false.
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
    /** Called once per read-loop failure. The loop stops; the port is closed. */
    onError?: (error: Error) => void
    log?: (message: string) => void
}

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

        // A port the browser already handed us open (a reconnect that never
        // fully closed) has readable set; opening it again throws.
        if (!this.port.readable) {
            await this.port.open({ baudRate: opts.baudRate });
            this.opened = true;
        }

        if (!this.port.readable || !this.port.writable) {
            throw new Error('serial port opened without a readable/writable stream');
        }

        const reader = this.port.readable.getReader();
        this.reader = reader;
        this.writer = this.port.writable.getWriter();
        this.running = true;
        this.loop = this.readLoop(reader);
        this.log(`serial port open at ${opts.baudRate} baud`);
    }

    async close (): Promise<void> {
        if (!this.running && !this.reader && !this.writer) {
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

        const writer = this.writer;
        this.writer = null;
        if (writer) {
            await writer.close().catch(() => {});
            try {
                writer.releaseLock();
            } catch {
                // Already released by close(); nothing to do.
            }
        }

        if (this.opened) {
            this.opened = false;
            await this.port.close().catch((error: unknown) => {
                this.log(`serial port close failed: ${asError(error).message}`);
            });
        }

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

    private async readLoop (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
        try {
            while (this.running) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                if (value && value.length > 0) {
                    this.emit(value);
                }
            }
        } catch (error) {
            // A USB overrun or framing error lands here. Report it once and stop
            // -- do not reconnect blindly, which is what used to lose the port.
            this.running = false;
            this.onError(asError(error));
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // cancel() may have released it already.
            }
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
