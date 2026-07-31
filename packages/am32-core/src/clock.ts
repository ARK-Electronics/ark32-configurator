/**
 * The injectable time source for everything below the session layer.
 *
 * Nothing in `am32-core` may call `Date.now()` or `setTimeout` directly --
 * `scripts/assert-core-hygiene.sh` fails the build if it does, and this file is
 * the single exemption. Two reasons, both load-bearing:
 *
 *  1. Tests against `am32-sim` run on {@link VirtualClock}, so a 60 KB flash
 *     with its ~240 page writes and their real 900 ms timeouts completes in
 *     milliseconds and is deterministic instead of flaky.
 *  2. The web build used to reach the global timers through the Web Serial
 *     wrapper package block 2 deleted, which installed a "HackTimer" over them:
 *     every timeout became a Web Worker `postMessage` round trip, injecting
 *     jitter into exactly the timing the protocol depends on. Taking time
 *     through an interface is what stops an equivalent creeping back in.
 *     (The hygiene gate greps for that package's name, so this file cannot
 *     spell it out.)
 *
 * The core tsconfig omits the `dom` lib and sets `types: []`, so `setTimeout`
 * is not even a declared name here. {@link createSystemClock} therefore reaches
 * the host timers through a narrow structural type rather than a global.
 */

/** A scheduled callback that can still be called off. */
export interface ClockTimer {
    cancel(): void
}

export interface Clock {
    /** Monotonic-enough milliseconds. Only differences are meaningful. */
    now(): number
    setTimeout(callback: () => void, ms: number): ClockTimer
    sleep(ms: number): Promise<void>
}

/**
 * The slice of the host environment {@link createSystemClock} needs. Declared
 * structurally so the core does not depend on DOM or Node timer typings.
 */
export interface TimerHost {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

/**
 * Real time, for production. `host` defaults to the ambient globals; pass one
 * explicitly from a transport package that has to route timers somewhere else.
 */
export function createSystemClock (host?: TimerHost): Clock {
    const timers = host ?? (globalThis as unknown as TimerHost);

    return {
        now: () => Date.now(),
        setTimeout: (callback, ms) => {
            const handle = timers.setTimeout(callback, ms);
            return { cancel: () => timers.clearTimeout(handle) };
        },
        sleep: ms => new Promise<void>((resolve) => {
            timers.setTimeout(() => resolve(), ms);
        })
    };
}

interface VirtualTimer {
    id: number
    dueAt: number
    callback: () => void
}

/**
 * How many microtask ticks {@link VirtualClock} drains between firing timers.
 * Deep enough for any promise chain in the link layer; a fixed count keeps
 * advancing deterministic, which is the whole point of a virtual clock.
 */
const MICROTASK_FLUSH_DEPTH = 64;

/** Guards `runAll` against code that reschedules a timer forever. */
const MAX_TIMER_FIRINGS = 100_000;

/**
 * Deterministic time for tests. Timers fire only when the test advances the
 * clock, and every advance drains the microtask queue so promise chains settle
 * before the next deadline is considered.
 */
export class VirtualClock implements Clock {
    private current: number;
    private nextId = 1;
    private readonly timers = new Map<number, VirtualTimer>();

    constructor (startAt = 0) {
        this.current = startAt;
    }

    now (): number {
        return this.current;
    }

    setTimeout (callback: () => void, ms: number): ClockTimer {
        const id = this.nextId++;
        this.timers.set(id, {
            id,
            dueAt: this.current + Math.max(0, ms),
            callback
        });
        return {
            cancel: () => {
                this.timers.delete(id);
            }
        };
    }

    sleep (ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            this.setTimeout(() => resolve(), ms);
        });
    }

    /** Timers still scheduled. Zero means nothing is waiting on time. */
    get pending (): number {
        return this.timers.size;
    }

    /**
     * Move time forward by `ms`, firing everything due in deadline order --
     * including timers scheduled by a callback that fires along the way.
     */
    async advance (ms: number): Promise<void> {
        const target = this.current + Math.max(0, ms);
        let fired = 0;

        for (;;) {
            await this.flush();
            const next = this.earliestDueBy(target);
            if (!next) {
                break;
            }
            if (++fired > MAX_TIMER_FIRINGS) {
                throw new Error('VirtualClock.advance: timer storm, a callback keeps rescheduling');
            }
            this.timers.delete(next.id);
            this.current = Math.max(this.current, next.dueAt);
            next.callback();
        }

        this.current = target;
        await this.flush();
    }

    /**
     * Jump straight to the next scheduled timer and fire it. Returns false when
     * nothing was pending, so callers can loop to quiescence.
     */
    async advanceToNextTimer (): Promise<boolean> {
        await this.flush();
        const next = this.earliestDueBy(Number.POSITIVE_INFINITY);
        if (!next) {
            return false;
        }
        this.timers.delete(next.id);
        this.current = Math.max(this.current, next.dueAt);
        next.callback();
        await this.flush();
        return true;
    }

    /**
     * Run until no timers remain. This is how a test says "let the operation
     * finish, however long it thinks it takes" without knowing the schedule.
     */
    async runAll (): Promise<void> {
        let fired = 0;
        while (await this.advanceToNextTimer()) {
            if (++fired > MAX_TIMER_FIRINGS) {
                throw new Error('VirtualClock.runAll: timer storm, a callback keeps rescheduling');
            }
        }
    }

    private earliestDueBy (target: number): VirtualTimer | null {
        let best: VirtualTimer | null = null;
        for (const timer of this.timers.values()) {
            if (timer.dueAt > target) {
                continue;
            }
            // Ties break on insertion order, matching a real timer queue.
            if (!best || timer.dueAt < best.dueAt || (timer.dueAt === best.dueAt && timer.id < best.id)) {
                best = timer;
            }
        }
        return best;
    }

    private async flush (): Promise<void> {
        for (let i = 0; i < MICROTASK_FLUSH_DEPTH; i += 1) {
            await Promise.resolve();
        }
    }
}
