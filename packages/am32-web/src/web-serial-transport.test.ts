import { describe, expect, it, vi } from 'vitest';
import { WebSerialTransport } from './web-serial-transport';

/**
 * A `SerialPort` stand-in built out of real WHATWG streams, so the reader lock
 * semantics that audit item E kept tripping over are the genuine ones rather
 * than a mock's idea of them.
 *
 * `readable` follows Chrome's `SerialPort::readable`: a fresh stream on demand
 * while the port is open, the same one until it errors or closes, and none at
 * all after a fatal read error until the port is closed and reopened.
 */
class FakePort {
    writable: WritableStream<Uint8Array> | null = null;
    written: Uint8Array[] = [];
    openCalls: SerialOptions[] = [];
    closeCalls = 0;

    private portOpen = false;
    private readFatal = false;
    private stream: ReadableStream<Uint8Array> | null = null;
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    private closeGate: Promise<void> | null = null;

    get readable (): ReadableStream<Uint8Array> | null {
        if (this.stream) {
            return this.stream;
        }
        if (!this.portOpen || this.readFatal) {
            return null;
        }
        this.stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.controller = controller;
            }
        });
        return this.stream;
    }

    open (options: SerialOptions): Promise<void> {
        if (this.portOpen) {
            return Promise.reject(new Error('The port is already open.'));
        }
        this.openCalls.push(options);
        this.portOpen = true;
        this.readFatal = false;
        this.writable = new WritableStream<Uint8Array>({
            write: (chunk) => {
                this.written.push(chunk.slice());
            }
        });
        return Promise.resolve();
    }

    async close (): Promise<void> {
        if (!this.portOpen) {
            throw new Error('The port is already closed.');
        }
        // Chrome rejects `port.close()` while either stream is still locked, so
        // this fake does too: forgetting to release a lock has to be a failure
        // here, not a silently leaked port.
        if (this.stream?.locked || this.writable?.locked) {
            throw new Error('cannot close a port whose streams are locked');
        }
        // The port stays open, and refuses open(), until the close lands.
        await this.closeGate;
        this.closeCalls += 1;
        this.portOpen = false;
        this.readFatal = false;
        this.stream = null;
        this.controller = null;
        this.writable = null;
    }

    /** Hold every close() until the returned function is called. */
    holdClose (): () => void {
        let release!: () => void;
        this.closeGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        return () => {
            this.closeGate = null;
            release();
        };
    }

    /** Deliver inbound bytes as the device would. */
    push (bytes: number[]): void {
        this.controller?.enqueue(Uint8Array.from(bytes));
    }

    /**
     * Error the current stream. Fatal is Chrome's lost device (`NetworkError`);
     * non-fatal is an overrun, break, framing or parity error.
     */
    fail (error: Error, options: { fatal: boolean }): void {
        this.readFatal = options.fatal;
        this.controller?.error(error);
        this.stream = null;
        this.controller = null;
    }

    /** End the current stream without an error. */
    end (): void {
        this.readFatal = true;
        this.controller?.close();
        this.stream = null;
        this.controller = null;
    }

    asSerialPort (): SerialPort {
        return this as unknown as SerialPort;
    }
}

const flush = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

const deviceLost = () => new DOMException('The device has been lost.', 'NetworkError');

describe('WebSerialTransport', () => {
    it('opens the port at the requested baud rate and delivers inbound bytes', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        const chunks: Uint8Array[] = [];
        transport.onData(chunk => chunks.push(chunk));

        await transport.open({ baudRate: 115200 });
        // Not Chrome's 255-byte default, which costs a browser round trip per
        // 255 bytes received.
        expect(port.openCalls).toEqual([{ baudRate: 115200, bufferSize: 64 * 1024 }]);
        expect(transport.isOpen).toBe(true);

        port.push([1, 2, 3]);
        port.push([4]);
        await flush();

        expect(chunks.map(c => [...c])).toEqual([[1, 2, 3], [4]]);
        await transport.close();
    });

    it('writes through to the port', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        await transport.open({ baudRate: 115200 });

        await transport.write(Uint8Array.of(0x2F, 0x30));
        expect(port.written.map(c => [...c])).toEqual([[0x2F, 0x30]]);
        await transport.close();
    });

    it('refuses to write when it is not open', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('not open');
    });

    it('feeds every subscriber, and stops feeding one that unsubscribes', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        const first: number[] = [];
        const second: number[] = [];
        transport.onData(chunk => first.push(...chunk));
        const off = transport.onData(chunk => second.push(...chunk));

        await transport.open({ baudRate: 115200 });
        port.push([1]);
        await flush();
        off();
        port.push([2]);
        await flush();

        // The old transport had a single `stream.ondata`, which drain swapped
        // out from under the exchange that installed it.
        expect(first).toEqual([1, 2]);
        expect(second).toEqual([1]);
        await transport.close();
    });

    it('stops the read loop on close, and delivers nothing afterwards', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        const chunks: number[] = [];
        transport.onData(chunk => chunks.push(...chunk));

        await transport.open({ baudRate: 115200 });
        port.push([7]);
        await flush();

        await transport.close();
        expect(transport.isOpen).toBe(false);
        // Both locks released before the port was closed, or the fake would have
        // rejected -- which is exactly what Chrome does.
        expect(port.closeCalls).toBe(1);

        // The port is gone, so this is a no-op -- the point is that the loop is
        // not still spinning on a reader it no longer owns.
        port.push([8]);
        await flush();
        expect(chunks).toEqual([7]);
    });

    it('reopening does not leave a second read loop behind', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        const chunks: number[] = [];
        transport.onData(chunk => chunks.push(...chunk));

        await transport.open({ baudRate: 115200 });
        await transport.close();
        await transport.open({ baudRate: 115200 });
        port.push([9]);
        await flush();

        // Two loops would deliver [9, 9]. `disconnectFromDevice` never set
        // `stream.running = false`, so that is exactly what used to happen.
        expect(chunks).toEqual([9]);
        await transport.close();
    });

    it('reads on through a non-fatal error with the fresh stream the port hands out', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const log = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError, log });
        const chunks: number[] = [];
        transport.onData(chunk => chunks.push(...chunk));

        await transport.open({ baudRate: 115200 });
        port.push([1]);
        await flush();
        port.fail(new DOMException('Buffer overrun', 'BufferOverrunError'), { fatal: false });
        await flush();
        port.push([2]);
        await flush();

        expect(chunks).toEqual([1, 2]);
        expect(transport.isOpen).toBe(true);
        expect(onError).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Buffer overrun'));
        expect(port.closeCalls).toBe(0);

        await transport.close();
        // The re-acquired reader was released too, or this close would reject.
        expect(port.closeCalls).toBe(1);
    });

    it('reports a fatal read error once, closes the port, and does not throw', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError });

        await transport.open({ baudRate: 115200 });
        port.fail(deviceLost(), { fatal: true });
        await flush();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]?.message).toBe('The device has been lost.');
        // A dead stream must read as closed, so the link stops writing into it.
        expect(transport.isOpen).toBe(false);
        // Chrome only hands out a new readable after close() and open().
        expect(port.closeCalls).toBe(1);

        await transport.close();
        expect(port.closeCalls).toBe(1);
    });

    it('reopens the same port after a fatal read error', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        const chunks: number[] = [];
        transport.onData(chunk => chunks.push(...chunk));

        await transport.open({ baudRate: 115200 });
        port.fail(deviceLost(), { fatal: true });
        await flush();

        await transport.open({ baudRate: 115200 });
        expect(port.openCalls).toHaveLength(2);
        expect(transport.isOpen).toBe(true);

        port.push([3]);
        await flush();
        expect(chunks).toEqual([3]);

        await transport.close();
        expect(port.closeCalls).toBe(2);
    });

    it('waits for the fatal teardown to close the port before reopening it', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());

        await transport.open({ baudRate: 115200 });
        const release = port.holdClose();
        port.fail(deviceLost(), { fatal: true });
        await flush();
        expect(transport.isOpen).toBe(false);

        // The loop is still inside port.close(); opening underneath it would
        // throw "already open".
        const reopening = transport.open({ baudRate: 115200 });
        release();
        await reopening;

        expect(transport.isOpen).toBe(true);
        expect(port.openCalls).toHaveLength(2);
        await transport.close();
    });

    it('names the stale-VMIN cause only when the port fails again right after a reopen', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError });

        await transport.open({ baudRate: 115200 });
        port.fail(deviceLost(), { fatal: true });
        await flush();
        await transport.open({ baudRate: 115200 });
        port.fail(deviceLost(), { fatal: true });
        await flush();

        const messages = onError.mock.calls.map(call => (call[0] as Error).message);
        // The first could be an unplug; a reopen that succeeds rules that out.
        expect(messages[0]).toBe('The device has been lost.');
        expect(messages[1]).toContain('VMIN=0');

        // A deliberate close starts the count again.
        await transport.close();
        await transport.open({ baudRate: 115200 });
        port.fail(deviceLost(), { fatal: true });
        await flush();
        expect((onError.mock.calls[2]?.[0] as Error).message).toBe('The device has been lost.');
    });

    it('does not blame a stale VMIN for a failure long after the reopen', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError });
        const now = vi.spyOn(Date, 'now').mockReturnValue(0);

        try {
            await transport.open({ baudRate: 115200 });
            port.fail(deviceLost(), { fatal: true });
            await flush();
            await transport.open({ baudRate: 115200 });

            // An unplug ten minutes into a session that had to reopen once.
            now.mockReturnValue(600_000);
            port.fail(deviceLost(), { fatal: true });
            await flush();
        } finally {
            now.mockRestore();
        }

        expect((onError.mock.calls[1]?.[0] as Error).message).toBe('The device has been lost.');
    });

    it('treats a stream that ends on its own as a dead port', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError });

        await transport.open({ baudRate: 115200 });
        port.end();
        await flush();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(transport.isOpen).toBe(false);
        expect(port.closeCalls).toBe(1);
    });

    it('survives a subscriber that throws', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError });
        const seen: number[] = [];
        transport.onData(() => {
            throw new Error('subscriber blew up');
        });
        transport.onData(chunk => seen.push(...chunk));

        await transport.open({ baudRate: 115200 });
        port.push([5]);
        await flush();
        port.push([6]);
        await flush();

        expect(seen).toEqual([5, 6]);
        expect(onError).toHaveBeenCalledTimes(2);
        expect(transport.isOpen).toBe(true);
        await transport.close();
    });

    it('is idempotent about open and close', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());

        await transport.open({ baudRate: 115200 });
        await transport.open({ baudRate: 115200 });
        expect(port.openCalls).toHaveLength(1);

        await transport.close();
        await transport.close();
        expect(port.closeCalls).toBe(1);
    });

    it('adopts a port the browser already opened without opening it again', async () => {
        const port = new FakePort();
        await port.open({ baudRate: 9600 });
        port.openCalls = [];

        const transport = new WebSerialTransport(port.asSerialPort());
        await transport.open({ baudRate: 115200 });
        expect(port.openCalls).toEqual([]);
        expect(transport.isOpen).toBe(true);

        await transport.close();
        // Not ours to close: we never opened it.
        expect(port.closeCalls).toBe(0);
    });

    it('closes even an adopted port once its read side is dead, so it can be reopened', async () => {
        const port = new FakePort();
        await port.open({ baudRate: 9600 });
        port.openCalls = [];

        const transport = new WebSerialTransport(port.asSerialPort());
        await transport.open({ baudRate: 115200 });
        port.fail(deviceLost(), { fatal: true });
        await flush();
        expect(port.closeCalls).toBe(1);

        await transport.open({ baudRate: 115200 });
        expect(port.openCalls).toHaveLength(1);
        await transport.close();
        expect(port.closeCalls).toBe(2);
    });
});
