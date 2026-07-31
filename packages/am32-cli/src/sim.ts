/**
 * `--sim`: the same rig the test suite builds, driven from the command line.
 *
 * `createSimHarness` is deliberately the *only* way this file makes a simulator
 * (issue #3 section 3: "the CLI's simulator mode and the test suite must build the
 * same object graph, or `--sim` stops being a smoke test of anything real"). What
 * this file adds is the two things a command line needs and a test does not: fault
 * specs turned into knob assignments, and a pump for the virtual clock.
 *
 * ## Why the clock is virtual and not the system one
 *
 * A simulated run on the system clock would take real time for every delay the
 * protocol contains -- ArduPilot's 4 s MAVLink window, the 2 s passthrough settle,
 * 300 ms between channels, and a page-write timeout per chunk of a flash. That is
 * ~9 s for `enumerate` and minutes for a `flash`, which would make `--sim` useless
 * as the CI smoke test the plan wants it to be. On a virtual clock the same run is
 * milliseconds and, more importantly, *deterministic*: the simulator has no wall
 * clock anywhere in it, so a `--sim` run either always works or always does not.
 *
 * The cost, stated plainly: **`--sim` does not exercise real timing.** It proves
 * the protocol logic, the session's ordering and every host-side timeout
 * *derivation* against the firmware's own budgets. It cannot tell you that a real
 * USB link is fast enough. That is what the hardware checkpoints are for.
 */

import { VirtualClock } from 'am32-core/clock';
import { createSimHarness, type SimHarness } from 'am32-sim/harness';
import type { FaultSpec, GlobalOptions } from './args';

export interface SimRig {
    harness: SimHarness
    clock: VirtualClock
    /** One line describing the rig, for the log and the JSON envelope. */
    description: string
}

/**
 * Build the rig `globals` describes and arm its faults.
 *
 * `--fc auto` picks ArduPilot, which is the stricter profile: its MAVLink idle
 * gate is shut when the port opens, so a `--sim` run exercises the probe-then-wait
 * connect rather than the Betaflight fast path. An `auto` that silently chose the
 * easier profile would make `--sim` a weaker smoke test than the default suggests.
 */
export function createSimRig (globals: GlobalOptions): SimRig {
    const profile = globals.fc === 'betaflight' ? 'betaflight' : 'ardupilot';
    const harness = createSimHarness({ profile, escCount: globals.escs });

    for (const fault of globals.faults) {
        applyFault(harness, fault);
    }

    const faults = globals.faults.length > 0
        ? `, faults: ${globals.faults.map(describeFault).join(' ')}`
        : '';

    return {
        harness,
        clock: harness.clock,
        description: `simulated ${profile} with ${globals.escs} ESC(s)${faults}`
    };
}

const describeFault = (fault: FaultSpec): string =>
    `${fault.subject}=${fault.knob}${fault.value === true || fault.value === null ? '' : `:${String(fault.value)}`}`;

/**
 * Arm one knob.
 *
 * Every spec reaching here has already been validated by `parseArgs`, so this
 * cannot reject a command line -- and it must not, because exit code 3 is the
 * parser's to decide. The `default` branches are unreachable and throw rather
 * than shrug, so a knob added to the parser and forgotten here fails loudly
 * instead of silently doing nothing.
 */
function applyFault (harness: SimHarness, fault: FaultSpec): void {
    if (fault.scope === 'esc') {
        const esc = harness.escs[fault.target ?? -1];
        if (!esc) {
            throw new Error(`--fault ${fault.subject}: no such channel on this rig`);
        }
        switch (fault.knob) {
        case 'unresponsive':
            esc.unresponsive = true;
            return;
        case 'slowBy':
            esc.slowBy(fault.value as number);
            return;
        case 'corruptCrc':
            esc.corruptCrc = fault.value as boolean | number;
            return;
        case 'shortRead':
            esc.shortRead = fault.value as boolean | number;
            return;
        case 'silentWriteFailure':
            esc.silentWriteFailure = fault.value as boolean | number;
            return;
        case 'failingFlashCell':
            esc.failingFlashCell = fault.value as boolean | number;
            return;
        default:
            throw new Error(`--fault ${fault.subject}=${fault.knob}: the CLI cannot apply this knob`);
        }
    }

    if (fault.scope === 'fc') {
        switch (fault.knob) {
        case 'blockingFourWay':
            harness.fc.blockingFourWay = fault.value as boolean;
            return;
        case 'mavlinkIdleGate':
            harness.fc.mavlinkIdleGate = fault.value as number;
            return;
        case 'mspError':
            harness.fc.mspError(fault.value as number);
            return;
        default:
            throw new Error(`--fault fc=${fault.knob}: the CLI cannot apply this knob`);
        }
    }

    switch (fault.knob) {
    case 'dropBytes':
        harness.transport.faults.dropBytes(fault.value as number);
        return;
    case 'injectGarbage':
        harness.transport.faults.injectGarbage(fault.value as number);
        return;
    default:
        throw new Error(`--fault link=${fault.knob}: the CLI cannot apply this knob`);
    }
}

/**
 * How many times the pump will find no timer and no settled promise before it
 * gives up.
 *
 * The test suite's own `drive` helper treats a dry clock as an immediate deadlock,
 * because a test does nothing but protocol work. The CLI cannot: a command may
 * legitimately be awaiting something outside the clock -- a file read, a promise
 * resolved by a microtask chain deeper than one turn -- so the pump has to yield
 * to the real event loop and look again. What it must *not* do is spin forever,
 * because a genuine deadlock in the simulator would then hang the CLI with no
 * output at all.
 */
const MAX_IDLE_ROUNDS = 1000;

/**
 * Timers the pump will fire before deciding a callback is rescheduling forever.
 *
 * The same number `VirtualClock.runAll` uses (`am32-core/clock.ts`), and for the
 * same reason. A bound on *idle* rounds cannot catch a timer storm, because every
 * round of one is productive.
 */
const MAX_TIMER_FIRINGS = 100_000;

/**
 * Advance `clock` until `work` settles.
 *
 * The counterpart of the `drive()` helper in the simulator's own integration
 * tests, and it has to exist separately for the reason above: this one yields to
 * the host event loop when the clock runs dry, and reports a deadlock by name
 * rather than hanging.
 */
export async function driveVirtualClock<T> (clock: VirtualClock, work: Promise<T>): Promise<T> {
    // A holder rather than a bare `let`: the flag is set from a promise callback
    // the loop cannot see, which is the shape `no-unmodified-loop-condition` is
    // for, and here it is a false positive.
    const status = { settled: false };
    const tracked = work.then(
        (value) => {
            status.settled = true;
            return value;
        },
        (error: unknown) => {
            status.settled = true;
            throw error;
        }
    );
    tracked.catch(() => {});

    let idle = 0;
    let fired = 0;
    while (!status.settled) {
        const progressed = await clock.advanceToNextTimer();
        if (status.settled) {
            break;
        }
        if (progressed) {
            idle = 0;
            // The *other* way this loop never ends, and the one a bound on idle
            // rounds cannot see: a callback that keeps rescheduling a timer makes
            // every round productive, so `idle` resets forever and the CLI burns
            // CPU with no output and no diagnostic. `VirtualClock.runAll` guards
            // exactly this with the same constant; this pump is the one clock
            // driver in the repo a user is actually waiting on, so it needs the
            // guard more, not less.
            fired += 1;
            if (fired > MAX_TIMER_FIRINGS) {
                throw new Error(
                    `the simulator fired ${MAX_TIMER_FIRINGS} timers without the operation ` +
                    'settling: a callback keeps rescheduling. This is a timer storm, not a slow run.'
                );
            }
            continue;
        }
        // Nothing is waiting on time, so whatever is pending is waiting on the
        // host: give the event loop a turn before deciding it is stuck.
        idle += 1;
        if (idle > MAX_IDLE_ROUNDS) {
            throw new Error(
                'the simulator made no progress: the virtual clock has no pending timers ' +
                'and the operation has not settled. This is a deadlock, not a slow run.'
            );
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    return tracked;
}
