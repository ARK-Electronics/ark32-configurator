/**
 * One call to stand up a whole simulated rig: a virtual clock, an FC on a
 * profile, its ESCs, and an open {@link SimTransport} in front of them.
 *
 * Used by this package's tests, and by block 7's `ark32 --sim`, which is the
 * point: the CLI's simulator mode and the test suite must build the same object
 * graph, or `--sim` stops being a smoke test of anything real.
 *
 * Deliberately does *not* build a `Link` or a session. The simulator's job ends
 * at the transport boundary; anything above it is the caller's, and keeping that
 * line sharp is what stops the simulator from quietly growing a second copy of
 * the host's logic.
 */

import { VirtualClock } from 'am32-core/clock';
import { SimEsc, type SimEscOptions } from './esc';
import { SimFc, type SimFcOptions } from './fc';
import { SimTransport } from './transport';
import type { FcProfileName } from './profiles';

export interface SimHarnessOptions {
    profile?: FcProfileName
    /** ESC count. Ignored when `escs` is given. */
    escCount?: number
    /** Options applied to every ESC the harness creates. */
    esc?: SimEscOptions
    /** Pre-built ESCs, when a test needs to configure them before construction. */
    escs?: SimEsc[]
    /** Milliseconds the virtual clock starts at. */
    startAt?: number
    /** Fixed extra latency each way on the host link. */
    latencyMs?: number
    motorCount?: SimFcOptions['motorCount']
    battery?: SimFcOptions['battery']
}

export interface SimHarness {
    clock: VirtualClock
    fc: SimFc
    escs: SimEsc[]
    transport: SimTransport
    /** Open the port, as the host would. Resolves immediately. */
    open(): Promise<void>
}

export function createSimHarness (options: SimHarnessOptions = {}): SimHarness {
    const clock = new VirtualClock(options.startAt ?? 0);
    const escs = options.escs ??
        Array.from({ length: options.escCount ?? 4 }, () => new SimEsc(options.esc));

    const fc = new SimFc({
        clock,
        profile: options.profile ?? 'ardupilot',
        escs,
        motorCount: options.motorCount,
        battery: options.battery
    });

    const transport = new SimTransport({
        clock,
        endpoint: fc,
        latencyMs: options.latencyMs
    });

    return {
        clock,
        fc,
        escs,
        transport,
        open: () => transport.open({ baudRate: 115200 })
    };
}
