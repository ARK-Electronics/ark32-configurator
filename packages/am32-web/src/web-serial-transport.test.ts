import { describe, expect, it, vi } from 'vitest';
import { WebSerialTransport } from './web-serial-transport';

/**
 * A `SerialPort` stand-in built out of real WHATWG streams, so the reader lock
 * semantics that audit item E kept tripping over are the genuine ones rather
 * than a mock's idea of them.
 */
class FakePort {
    readable: ReadableStream<Uint8Array> | null = null;
    writable: WritableStream<Uint8Array> | null = null;
    written: Uint8Array[] = [];
    openCalls: Array<{ baudRate?: number }> = [];
    closeCalls = 0;
    readError: Error | null = null;

    private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    open (options: { baudRate?: number }): Promise<void> {
        this.openCalls.push(options);
        this.readable = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.controller = controller;
            }
        });
        this.writable = new WritableStream<Uint8Array>({
            write: (chunk) => {
                this.written.push(chunk.slice());
            }
        });
        return Promise.resolve();
    }

    close (): Promise<void> {
        this.closeCalls += 1;
        this.readable = null;
        this.writable = null;
        this.controller = null;
        return Promise.resolve();
    }

    /** Deliver inbound bytes as the device would. */
    push (bytes: number[]): void {
        this.controller?.enqueue(Uint8Array.from(bytes));
    }

    /** Fail the stream, as a USB overrun or framing error does. */
    fail (error: Error): void {
        this.readError = error;
        this.controller?.error(error);
    }

    asSerialPort (): SerialPort {
        return this as unknown as SerialPort;
    }
}

const flush = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

describe('WebSerialTransport', () => {
    it('opens the port at the requested baud rate and delivers inbound bytes', async () => {
        const port = new FakePort();
        const transport = new WebSerialTransport(port.asSerialPort());
        const chunks: Uint8Array[] = [];
        transport.onData(chunk => chunks.push(chunk));

        await transport.open({ baudRate: 115200 });
        expect(port.openCalls).toEqual([{ baudRate: 115200 }]);
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

    it('reports a read error once, closes itself, and does not throw', async () => {
        const port = new FakePort();
        const onError = vi.fn();
        const transport = new WebSerialTransport(port.asSerialPort(), { onError });

        await transport.open({ baudRate: 115200 });
        port.fail(new Error('device overrun'));
        await flush();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]?.message).toBe('device overrun');
        // A dead stream must read as closed, so the link stops writing into it.
        expect(transport.isOpen).toBe(false);
        await transport.close();
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
});
