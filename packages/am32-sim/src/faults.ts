/**
 * Fault injection knobs for the simulator.
 *
 * Every knob here maps to a bug the audit in issue #3 found, so the fixes stay
 * fixed. `scripts/assert-fault-coverage.sh` fails the build if a knob exists
 * with no test referencing it, or if a knob named in the plan is missing.
 *
 * The link-level knobs live in this file; the ESC-level ones (`unresponsive`,
 * `slowBy`, `corruptCrc`, `shortRead`, `canBlock`) are properties of
 * {@link import('./esc').SimEsc} and the FC-level ones (`mspError`,
 * `mavlinkIdleGate`, `blockingFourWay`) of {@link import('./fc').SimFc},
 * because that is where the state they perturb already lives.
 */

/** `rx` is FC -> host; `tx` is host -> FC. */
export type FaultDirection = 'rx' | 'tx';

interface DropFault {
    remaining: number
    skip: number
    direction: FaultDirection
}

interface GarbageFault {
    bytes: Uint8Array
    direction: FaultDirection
}

export interface DropBytesOptions {
    /** Default `rx`: corruption on the way back from the FC. */
    direction?: FaultDirection
    /**
     * Let this many bytes through first. `skip: 0` eats the start byte, so the
     * host sees a garbage prefix; a `skip` past the header truncates the frame
     * instead. Those are two different recovery paths and both matter.
     */
    skip?: number
}

export interface InjectGarbageOptions {
    direction?: FaultDirection
    /**
     * Deliver the bytes immediately instead of prepending them to the next real
     * chunk. This is the "stale RX while nothing is pending" case that `drain`
     * exists to clear.
     */
    now?: boolean
}

/**
 * The three bytes that begin a frame: `$` (MSP), `.` (a 4-way response) and `/`
 * (a 4-way request). Filler must never contain one, or "garbage" starts meaning
 * "a frame nobody sent" and the tests measure something else.
 */
const FRAME_START_BYTES = new Set([0x24, 0x2E, 0x2F]);

/**
 * Deterministic filler. Not random: a simulator test that fails must fail the
 * same way every time, and `Math.random()` in a fault injector is how you get a
 * suite that is green four times out of five.
 */
export function garbageBytes (count: number, seed = 0): Uint8Array {
    const bytes = new Uint8Array(Math.max(0, count));
    for (let i = 0; i < bytes.length; i += 1) {
        let value = (0xA5 + (i + seed) * 0x37) & 0xFF;
        while (FRAME_START_BYTES.has(value)) {
            value = (value + 1) & 0xFF;
        }
        bytes[i] = value;
    }
    return bytes;
}

/**
 * Byte-level corruption of the host <-> FC link, applied by
 * {@link import('./transport').SimTransport} to every chunk that crosses it.
 *
 * Guards audit items **E** and **G**: the old transport installed a single
 * `ondata` handler that `drain` swapped out from under an exchange, so stale or
 * partial bytes were routinely attributed to the wrong request. The link layer
 * that replaced it must instead time the attempt out, drain, and re-send.
 */
export class LinkFaults {
    private drop: DropFault | null = null;
    private garbage: GarbageFault | null = null;
    private seed = 0;

    /** Set by SimTransport so `injectGarbage(..., { now: true })` can deliver. */
    emit: ((bytes: Uint8Array, direction: FaultDirection) => void) | null = null;

    /**
     * Swallow `count` bytes crossing in `direction`, once.
     *
     * Guards audit **E** and **G**: a truncated reply must make the exchange time out and
     * retry, not wedge the link or be handed to the next exchange as its answer.
     */
    dropBytes (count: number, options: DropBytesOptions = {}): this {
        this.drop = {
            remaining: Math.max(0, Math.floor(count)),
            skip: Math.max(0, Math.floor(options.skip ?? 0)),
            direction: options.direction ?? 'rx'
        };
        return this;
    }

    /**
     * Put `bytes` (or `count` bytes of deterministic filler) on the line.
     *
     * Guards audit **E** and **G**: `drain` must clear stale RX before an exchange, and
     * the framing probes must not accept a frame that starts mid-buffer.
     */
    injectGarbage (bytes: ArrayLike<number> | number, options: InjectGarbageOptions = {}): this {
        const payload = typeof bytes === 'number'
            ? garbageBytes(bytes, this.seed++)
            : Uint8Array.from(Array.from(bytes));
        const direction = options.direction ?? 'rx';

        if (options.now) {
            this.emit?.(payload, direction);
            return this;
        }

        this.garbage = { bytes: payload, direction };
        return this;
    }

    /** Forget every armed fault. */
    clear (): this {
        this.drop = null;
        this.garbage = null;
        return this;
    }

    /** True while any fault is still armed. Diagnostics and assertions. */
    get armed (): boolean {
        return this.drop !== null || this.garbage !== null;
    }

    /**
     * Apply the armed faults to one chunk and return what actually crosses the
     * link. Called by SimTransport; not part of the public knob API.
     */
    apply (chunk: Uint8Array, direction: FaultDirection): Uint8Array {
        let out = chunk;

        if (this.garbage && this.garbage.direction === direction) {
            const prefix = this.garbage.bytes;
            this.garbage = null;
            const merged = new Uint8Array(prefix.length + out.length);
            merged.set(prefix, 0);
            merged.set(out, prefix.length);
            out = merged;
        }

        const drop = this.drop;
        if (drop && drop.direction === direction && drop.remaining > 0) {
            if (drop.skip >= out.length) {
                drop.skip -= out.length;
            } else {
                const start = drop.skip;
                const removed = Math.min(drop.remaining, out.length - start);
                const kept = new Uint8Array(out.length - removed);
                kept.set(out.subarray(0, start), 0);
                kept.set(out.subarray(start + removed), start);
                drop.skip = 0;
                drop.remaining -= removed;
                out = kept;
            }
            if (drop.remaining === 0) {
                this.drop = null;
            }
        }

        return out;
    }
}
