import type { StreamInfo, WebSerial } from 'webserial-wrapper';

/**
 * Request/response exchange over a Web Serial stream.
 *
 * This is the transport half of `@am32/serial-msp`, which block 1b dropped
 * along with its broken MSP parser. It is deliberately a like-for-like
 * replacement rather than an improvement: **block 2 replaces it wholesale**
 * with `packages/am32-web` plus the core `Link`, which is where the single
 * RX ring buffer, the mutex, the injectable clock and the drain semantics
 * belong. Audit item E lists what is wrong with the shape below; do not fix
 * those here, fix them in block 2.
 *
 * Packet-boundary detection is the one thing that did move: the probes now come
 * from `am32-core/framing/*`, so the browser and the CLI agree on when a frame
 * is complete by construction.
 */

/** Returns true once `buffer` holds a structurally complete response. */
export type SerialPacketProbe = (buffer: Uint8Array) => boolean;

export interface SerialExchangeOptions {
    timeout?: number;
    probe: SerialPacketProbe;
}

export interface SerialTransportInit {
    serial: WebSerial;
    port: SerialPort;
    logError?: (message: string) => void;
    getStream?: () => StreamInfo | null;
    setStream?: (stream: StreamInfo) => void;
}

const DEFAULT_EXCHANGE_TIMEOUT_MS = 250;

const mergeChunks = (...arrays: Uint8Array[]): Uint8Array => {
    const merged = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0));
    let offset = 0;
    for (const array of arrays) {
        merged.set(array, offset);
        offset += array.length;
    }
    return merged;
};

export class SerialTransport {
    private readonly logError: (message: string) => void;
    private readonly serial: WebSerial;
    private readonly port: SerialPort;
    private readonly getStream: () => StreamInfo | null;
    private readonly setStream: (stream: StreamInfo) => void;

    constructor (config: SerialTransportInit) {
        this.logError = config.logError ?? (() => {});
        this.serial = config.serial;
        this.port = config.port;
        this.getStream = config.getStream ?? (() => null);
        this.setStream = config.setStream ?? (() => {});
    }

    /**
     * Write `data` and collect the reply until `probe` says it is complete or
     * `timeout` elapses with no further bytes. Resolves null when nothing came
     * back at all.
     */
    exchange (data: ArrayBuffer, options: SerialExchangeOptions): Promise<Uint8Array | null> {
        const timeout = options.timeout ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
        const request = new Uint8Array(data);
        const { probe } = options;
        const stream = this.ensureStream();

        return new Promise<Uint8Array | null>((resolve, reject) => {
            let response: Uint8Array | null = null;
            let completed = false;
            let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

            const complete = () => {
                if (completed) {
                    return;
                }
                completed = true;
                if (timer) {
                    globalThis.clearTimeout(timer);
                }
                stream.ondata = () => {};
                if (stream.transforms) {
                    stream.reader.cancel().catch(() => {});
                }
                resolve(response);
            };

            const armTimeout = () => {
                if (timer) {
                    globalThis.clearTimeout(timer);
                }
                timer = globalThis.setTimeout(complete, timeout);
            };

            stream.ondata = (chunk: Uint8Array) => {
                if (completed) {
                    return;
                }
                response = mergeChunks(response ?? new Uint8Array(), chunk);
                if (probe(response)) {
                    complete();
                    return;
                }
                armTimeout();
            };

            armTimeout();

            this.serial.writeStream(stream, [...request])
                .then(() => new Promise<void>((resolve) => {
                    globalThis.setTimeout(resolve, 0);
                }))
                .then(() => {
                    this.serial.readStream(stream);
                })
                .catch((error: unknown) => {
                    this.logError(error instanceof Error ? error.message : 'serial writeStream failed');
                    reject(error);
                });
        });
    }

    /**
     * Audit item E: this grabs a second reader while `createStream` still holds
     * the lock, so it throws. It is unreachable today -- only the dead
     * `Msp.read` / `FourWay.read` call it -- and block 5 deletes both callers.
     * Kept identical to the behaviour it replaces rather than half-fixed.
     */
    read<T = Uint8Array> (): Promise<ReadableStreamReadResult<T>> {
        return this.serial.readWithTimeout(this.port, 100) as Promise<ReadableStreamReadResult<T>>;
    }

    private ensureStream (): StreamInfo {
        const existing = this.getStream();
        if (existing) {
            return existing;
        }
        const stream = this.serial.createStream({
            port: this.port,
            frequency: 1,
            ondata: () => {}
        }) as StreamInfo;
        this.setStream(stream);
        return stream;
    }
}
