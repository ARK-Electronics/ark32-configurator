import { describe, expect, it, vi } from 'vitest';
import { VirtualClock, createSystemClock } from './clock';

describe('VirtualClock', () => {
    it('does not fire a timer until time is advanced past it', async () => {
        const clock = new VirtualClock();
        const fired: number[] = [];
        clock.setTimeout(() => fired.push(clock.now()), 100);

        await clock.advance(99);
        expect(fired).toEqual([]);
        expect(clock.pending).toBe(1);

        await clock.advance(1);
        expect(fired).toEqual([100]);
        expect(clock.pending).toBe(0);
    });

    it('fires timers in deadline order, then insertion order', async () => {
        const clock = new VirtualClock();
        const order: string[] = [];
        clock.setTimeout(() => order.push('late'), 50);
        clock.setTimeout(() => order.push('early'), 10);
        clock.setTimeout(() => order.push('early-too'), 10);

        await clock.advance(100);
        expect(order).toEqual(['early', 'early-too', 'late']);
    });

    it('fires a timer scheduled by another timer inside the same advance', async () => {
        const clock = new VirtualClock();
        const fired: number[] = [];
        clock.setTimeout(() => {
            fired.push(clock.now());
            clock.setTimeout(() => fired.push(clock.now()), 10);
        }, 10);

        await clock.advance(30);
        expect(fired).toEqual([10, 20]);
    });

    it('leaves a timer scheduled beyond the window pending', async () => {
        const clock = new VirtualClock();
        clock.setTimeout(() => {}, 500);
        await clock.advance(100);
        expect(clock.now()).toBe(100);
        expect(clock.pending).toBe(1);
    });

    it('cancels a timer', async () => {
        const clock = new VirtualClock();
        let fired = false;
        const timer = clock.setTimeout(() => {
            fired = true;
        }, 10);
        timer.cancel();
        await clock.advance(100);
        expect(fired).toBe(false);
    });

    it('resolves sleep() and lets the awaiting chain continue', async () => {
        const clock = new VirtualClock();
        const steps: string[] = [];

        const run = (async () => {
            steps.push(`start@${clock.now()}`);
            await clock.sleep(25);
            steps.push(`middle@${clock.now()}`);
            await clock.sleep(75);
            steps.push(`end@${clock.now()}`);
        })();

        await clock.advance(25);
        expect(steps).toEqual(['start@0', 'middle@25']);

        await clock.runAll();
        await run;
        expect(steps).toEqual(['start@0', 'middle@25', 'end@100']);
    });

    it('runAll jumps to each deadline and stops when nothing is pending', async () => {
        const clock = new VirtualClock();
        const fired: number[] = [];
        clock.setTimeout(() => fired.push(clock.now()), 1);
        clock.setTimeout(() => fired.push(clock.now()), 10_000);

        await clock.runAll();
        expect(fired).toEqual([1, 10_000]);
        expect(clock.now()).toBe(10_000);
        expect(clock.pending).toBe(0);
    });

    it('starts from the offset it was given', () => {
        expect(new VirtualClock(1_700_000_000_000).now()).toBe(1_700_000_000_000);
    });
});

describe('createSystemClock', () => {
    it('routes timers through the host it was handed', () => {
        const calls: number[] = [];
        const handles: unknown[] = [];
        const clock = createSystemClock({
            setTimeout: (_callback, ms) => {
                calls.push(ms);
                return `handle-${calls.length}`;
            },
            clearTimeout: (handle) => {
                handles.push(handle);
            }
        });

        clock.setTimeout(() => {}, 42).cancel();
        expect(calls).toEqual([42]);
        expect(handles).toEqual(['handle-1']);
    });

    it('uses real time and real timers by default', async () => {
        vi.useFakeTimers();
        try {
            const clock = createSystemClock();
            const before = clock.now();
            let resolved = false;
            const sleeping = clock.sleep(1000).then(() => {
                resolved = true;
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(resolved).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await sleeping;
            expect(resolved).toBe(true);
            expect(clock.now() - before).toBeGreaterThanOrEqual(1000);
        } finally {
            vi.useRealTimers();
        }
    });
});
