import type { WebSerial } from 'webserial-wrapper';
import { isCompleteFourWayFrame } from 'am32-core/framing/fourway';
import { isCompleteMspFrame, isMspRequest } from 'am32-core/framing/msp';
import { SerialTransport, type SerialPacketProbe } from '~/src/communication/serial-transport';

/**
 * Pick the completeness probe from the request we are about to send: MSP
 * headers are unmistakable, and everything else on this link is 4-way.
 */
const inferPacketProbe = (request: Uint8Array): SerialPacketProbe =>
    (isMspRequest(request) ? isCompleteMspFrame : isCompleteFourWayFrame);

/**
 * Default exchange timeout for MSP and other short USB serial commands.
 * 50ms was too aggressive: ArduPilot may delay MSP_SET_PASSTHROUGH until
 * soft-serial setup completes, which can exceed 50ms before the first reply byte.
 */
export const DEFAULT_SERIAL_TIMEOUT_MS = 500;

/** Quiet-line window used when draining stale RX between exchanges. */
const DRAIN_QUIET_MS = 25;
/** Upper bound for a single drain attempt. */
const DRAIN_MAX_MS = 200;

class Serial {
    private log: LogFn = (_s: string) => {};
    private logError: LogFn = (_s: string) => {};
    private logWarning: LogFn = (_s: string) => {};

    private serial: WebSerial | null = null;
    private port: SerialPort | null = null;
    private transport: SerialTransport | null = null;

    public init (
        log: LogFn,
        logError: LogFn,
        logWarning: LogFn,
        serial: WebSerial,
        port: SerialPort
    ) {
        this.log = log;
        this.logError = logError;
        this.logWarning = logWarning;

        this.serial = serial;
        this.port = port;
        this.transport = new SerialTransport({
            logError,
            serial,
            port,
            getStream: () => useSerialStore().deviceHandles.stream,
            setStream: (stream) => {
                useSerialStore().deviceHandles.stream = stream;
            }
        });
    }

    public deinit () {
        this.transport = null;
    }

    /**
     * Discard stale inbound bytes until the line has been quiet for quietMs,
     * or maxMs elapses. Prevents partial/timed-out 4-way responses from
     * contaminating the next exchange (a common "last ESC fails" cause).
     */
    public async drain (quietMs = DRAIN_QUIET_MS, maxMs = DRAIN_MAX_MS): Promise<void> {
        const stream = useSerialStore().deviceHandles.stream;
        if (!this.serial || !stream) {
            return;
        }

        // Keep the read loop alive so late bytes are observed and discarded.
        try {
            this.serial.readStream(stream);
        } catch {
            // readStream is a no-op when already running; ignore other failures.
        }

        await new Promise<void>((resolve) => {
            let lastActivity = Date.now();
            const started = Date.now();
            const previous = stream.ondata;

            stream.ondata = () => {
                lastActivity = Date.now();
            };

            const tick = () => {
                const now = Date.now();
                if ((now - lastActivity) >= quietMs || (now - started) >= maxMs) {
                    stream.ondata = typeof previous === 'function' ? previous : () => {};
                    resolve();
                    return;
                }
                globalThis.setTimeout(tick, 5);
            };

            globalThis.setTimeout(tick, quietMs);
        });
    }

    public async writeWithResponse (data: ArrayBuffer, timeout = DEFAULT_SERIAL_TIMEOUT_MS, probe?: SerialPacketProbe): Promise<Uint8Array | null> {
        if (!this.transport || !this.serial || !this.port) {
            throw new Error('WebSerial or SerialPort instance missing');
        }

        await this.drain();

        return this.transport.exchange(data, {
            timeout,
            probe: probe ?? inferPacketProbe(new Uint8Array(data))
        });
    }

    public write (data: ArrayBuffer, ms = DEFAULT_SERIAL_TIMEOUT_MS, probe?: SerialPacketProbe) {
        return this.writeWithResponse(data, ms, probe);
    }

    public canRead (): boolean {
        return this.port !== null;
    }

    public read<T = any> (): Promise<ReadableStreamReadResult<T>> {
        if (this.transport) {
            return this.transport.read<T>();
        }

        this.logError('Serial not initiated!');
        throw new Error('Serial not initiated!');
    }
}

export default new Serial();
