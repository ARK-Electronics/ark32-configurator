/**
 * `NodeSerialTransport` against a fake port and against `serialport`'s own
 * `SerialPortMock`.
 *
 * The fake is where the behaviour is pinned, because it can be driven into states
 * a mock will not reach on demand -- a write whose drain fails, a `close` event
 * with no `close()` call behind it. The `SerialPortMock` suite at the bottom is
 * the drift guard: it proves the structural `NodeSerialPortLike` really is
 * satisfied by the package, at compile time as well as at run time, so this
 * package cannot quietly type itself against an API `serialport` does not have.
 */

import { SerialPortMock } from 'serialport';
import { describe, expect, it } from 'vitest';
import { NodeSerialTransport } from './node-serial-transport';
import type { NodeCallback, NodeSerialPortLike, NodeSerialPortOptions } from './serialport-types';

type Listener = (...args: never[]) => void;

interface FakeOptions {
    failOpen?: string
    failWrite?: string
    failDrain?: string
    failClose?: string
}

/** A `NodeSerialPortLike` whose every callback can be made to fail. */
class FakePort implements NodeSerialPortLike {
    isOpen = false;
    readonly written: number[][] = [];
    /** Every call in order, so a test can assert write-then-drain rather than both. */
    readonly calls: string[] = [];
    readonly options: NodeSerialPortOptions;

    private readonly listeners = new Map<string, Set<Listener>>();

    constructor (options: NodeSerialPortOptions, private readonly faults: FakeOptions = {}) {
        this.options = options;
    }

    open (callback: NodeCallback): void {
        this.calls.push('open');
        if (this.faults.failOpen) {
            callback(new Error(this.faults.failOpen));
            return;
        }
        this.isOpen = true;
        callback(null);
    }

    close (callback: NodeCallback): void {
        this.calls.push('close');
        this.isOpen = false;
        callback(this.faults.failClose ? new Error(this.faults.failClose) : null);
        this.fire('close');
    }

    write (data: Uint8Array, callback: NodeCallback): boolean {
        this.calls.push('write');
        if (this.faults.failWrite) {
            callback(new Error(this.faults.failWrite));
            return false;
        }
        this.written.push([...data]);
        callback(null);
        return true;
    }

    drain (callback: NodeCallback): void {
        this.calls.push('drain');
        callback(this.faults.failDrain ? new Error(this.faults.failDrain) : null);
    }

    on (event: 'data', listener: (chunk: Uint8Array) => void): unknown;
    on (event: 'error', listener: (error: Error) => void): unknown;
    on (event: 'close', listener: () => void): unknown;
    on (event: string, listener: Listener): unknown {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener);
        return this;
    }

    removeAllListeners (event?: string): unknown {
        if (event === undefined) {
            this.listeners.clear();
        } else {
            this.listeners.delete(event);
        }
        return this;
    }

    /** Test-side: push bytes at the host. */
    emitData (bytes: number[]): void {
        this.fire('data', Uint8Array.from(bytes));
    }

    /** Test-side: the port failed. */
    emitError (message: string): void {
        this.fire('error', new Error(message));
    }

    /** Test-side: the device went away. */
    emitClose (): void {
        this.fire('close');
    }

    get listenerCount (): number {
        let total = 0;
        for (const set of this.listeners.values()) {
            total += set.size;
        }
        return total;
    }

    private fire (event: string, ...args: unknown[]): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            (listener as (...a: unknown[]) => void)(...args);
        }
    }
}

interface Rig {
    transport: NodeSerialTransport
    /** Null until `open()` has run -- the port is built by `open()`, as Node's is. */
    port: () => FakePort
    errors: Error[]
    logs: string[]
}

function rig (faults: FakeOptions = {}): Rig {
    const built: FakePort[] = [];
    const errors: Error[] = [];
    const logs: string[] = [];

    const transport = new NodeSerialTransport({
        path: '/dev/fake0',
        createPort: (options) => {
            const port = new FakePort(options, faults);
            built.push(port);
            return port;
        },
        onError: error => errors.push(error),
        log: message => logs.push(message)
    });

    return {
        transport,
        port: () => {
            const port = built[built.length - 1];
            if (!port) {
                throw new Error('no port built yet; call open() first');
            }
            return port;
        },
        errors,
        logs
    };
}

describe('NodeSerialTransport: open and close', () => {
    it('builds the port with the requested baud rate and autoOpen off', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });

        expect(r.port().options).toEqual({ path: '/dev/fake0', baudRate: 115200, autoOpen: false });
        expect(r.transport.isOpen).toBe(true);
    });

    it('rejects rather than emitting when the port refuses to open', async () => {
        const r = rig({ failOpen: 'no such file or directory' });

        await expect(r.transport.open({ baudRate: 115200 }))
            .rejects.toThrow('no such file or directory');
        // autoOpen: false is what makes this a rejection instead of an unheard
        // 'error' event on an object the caller does not hold yet.
        expect(r.transport.isOpen).toBe(false);
        expect(r.errors).toEqual([]);
    });

    it('is idempotent: a second open does not build a second port', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });
        const first = r.port();
        await r.transport.open({ baudRate: 115200 });

        expect(r.port()).toBe(first);
    });

    it('drops every listener before it closes, so its own close event is not a failure', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });
        expect(r.port().listenerCount).toBeGreaterThan(0);

        const port = r.port();
        await r.transport.close();

        expect(port.listenerCount).toBe(0);
        expect(port.calls).toContain('close');
        expect(r.transport.isOpen).toBe(false);
        // The fake fires 'close' from close(), exactly as node-serialport does.
        expect(r.errors).toEqual([]);
    });

    it('close is safe before open and twice in a row', async () => {
        const r = rig();
        await r.transport.close();
        await r.transport.open({ baudRate: 115200 });
        await r.transport.close();
        await r.transport.close();

        expect(r.port().calls.filter(c => c === 'close')).toHaveLength(1);
    });

    it('logs a close failure instead of rejecting on the disconnect path', async () => {
        const r = rig({ failClose: 'device busy' });
        await r.transport.open({ baudRate: 115200 });

        await expect(r.transport.close()).resolves.toBeUndefined();
        expect(r.logs.join('\n')).toContain('device busy');
    });
});

describe('NodeSerialTransport: bytes', () => {
    it('delivers inbound chunks to every subscriber and honours the unsubscribe', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });

        const a: number[][] = [];
        const b: number[][] = [];
        const off = r.transport.onData(chunk => a.push([...chunk]));
        r.transport.onData(chunk => b.push([...chunk]));

        r.port().emitData([0x2F, 0x00]);
        off();
        r.port().emitData([0x01]);

        expect(a).toEqual([[0x2F, 0x00]]);
        expect(b).toEqual([[0x2F, 0x00], [0x01]]);
    });

    it('ignores an empty chunk rather than waking the link for nothing', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });

        const seen: number[][] = [];
        r.transport.onData(chunk => seen.push([...chunk]));
        r.port().emitData([]);

        expect(seen).toEqual([]);
    });

    it('a throwing subscriber is reported and does not stop the next one', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });

        const seen: number[][] = [];
        r.transport.onData(() => {
            throw new Error('subscriber blew up');
        });
        r.transport.onData(chunk => seen.push([...chunk]));

        r.port().emitData([7]);

        expect(seen).toEqual([[7]]);
        expect(r.errors.map(e => e.message)).toEqual(['subscriber blew up']);
        expect(r.transport.isOpen).toBe(true);
    });

    it('writes then drains, in that order', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });
        await r.transport.write(Uint8Array.from([0x2F, 0x00, 0x01]));

        expect(r.port().written).toEqual([[0x2F, 0x00, 0x01]]);
        // The link starts its timeout when write() resolves, so "resolved" has to
        // mean the bytes have left the UART, not that they are queued.
        expect(r.port().calls).toEqual(['open', 'write', 'drain']);
    });

    it('rejects a write on a port that is not open', async () => {
        const r = rig();
        await expect(r.transport.write(Uint8Array.from([1])))
            .rejects.toThrow('/dev/fake0 is not open');
    });

    it('rejects when the write fails', async () => {
        const r = rig({ failWrite: 'EIO' });
        await r.transport.open({ baudRate: 115200 });

        await expect(r.transport.write(Uint8Array.from([1]))).rejects.toThrow('EIO');
    });

    it('rejects when the drain fails, so a half-sent frame is not reported as sent', async () => {
        const r = rig({ failDrain: 'drain failed' });
        await r.transport.open({ baudRate: 115200 });

        await expect(r.transport.write(Uint8Array.from([1]))).rejects.toThrow('drain failed');
    });
});

describe('NodeSerialTransport: the port going away', () => {
    it('reports an error event once and stops', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });

        r.port().emitError('read error');
        r.port().emitError('and another');

        expect(r.errors.map(e => e.message)).toEqual(['read error']);
        expect(r.transport.isOpen).toBe(false);
    });

    it('reports an unexpected close -- an unplug is otherwise silent', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });

        r.port().emitClose();

        expect(r.errors.map(e => e.message)).toEqual(['serial port /dev/fake0 closed unexpectedly']);
        expect(r.transport.isOpen).toBe(false);
    });

    it('refuses to write after the port has died', async () => {
        const r = rig();
        await r.transport.open({ baudRate: 115200 });
        r.port().emitError('gone');

        await expect(r.transport.write(Uint8Array.from([1]))).rejects.toThrow('is not open');
    });
});

describe('NodeSerialTransport: against serialport\'s own SerialPortMock', () => {
    /**
     * The drift guard, in both directions.
     *
     * **Compile time:** the `createPort` factory is annotated
     * `NodeSerialPortLike`, so if `serialport`'s `SerialPort` stops satisfying
     * that interface -- a renamed method, a changed callback shape, a dropped
     * `drain` -- `yarn typecheck:app` fails here rather than at run time on a
     * bench with a board plugged in.
     *
     * **Run time:** the bytes go through the package's real `write` + `drain` and
     * come back through its real `data` event, so a structural type that happens
     * to compile against a method that does not behave as assumed still fails.
     */
    it('satisfies NodeSerialPortLike, and moves bytes both ways', async () => {
        SerialPortMock.binding.createPort('/dev/mock0', { echo: false, record: true });

        let port: SerialPortMock | null = null;
        const transport = new NodeSerialTransport({
            path: '/dev/mock0',
            createPort: (options): NodeSerialPortLike => {
                port = new SerialPortMock(options);
                return port;
            }
        });

        const received: number[][] = [];
        transport.onData(chunk => received.push([...chunk]));

        await transport.open({ baudRate: 115200 });
        expect(transport.isOpen).toBe(true);

        const frame = [0x2F, 0x00, 0x00, 0x00, 0x01];
        await transport.write(Uint8Array.from(frame));

        const opened = port as unknown as SerialPortMock;
        expect([...(opened.port?.recording ?? [])]).toEqual(frame);

        opened.port?.emitData(Buffer.from([0x2E, 0x00]));
        // The mock delivers on the stream's own schedule; one macrotask is enough.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(received).toEqual([[0x2E, 0x00]]);

        await transport.close();
        expect(transport.isOpen).toBe(false);
        expect(opened.isOpen).toBe(false);
    });
});
