/**
 * Walking a set of ESC channels without letting one of them end the command.
 *
 * This is audit item **B** one layer up. `Am32Session.enumerate` already returns
 * per-target results and never throws on a partial failure; every *other*
 * per-channel operation -- `readEsc`, `writeSettings`, `applyDefaults`, `flash`,
 * `reset` -- throws, because a single-target call has nothing else it could do.
 * So the CLI is where "four ESCs, one of them dead" turns back into four results,
 * and it has to be, or `ark32 write --esc all` on a board with one bad channel
 * would leave three ESCs in an unknown state and print one error.
 */

import { causedBySessionError, describeError, type SessionErrorReason } from 'am32-core/errors';
import type { EscSelector } from '../args';

export interface TargetOutcome<T> {
    /** Zero-based channel, as `cmd_DeviceInitFlash` numbers them. */
    target: number
    /** One-based, as `--esc` and the UI number them. */
    esc: number
    ok: boolean
    reason?: SessionErrorReason
    error?: string
    value?: T
}

/**
 * Which channels to act on, given what the FC said it will address.
 *
 * A channel the user named explicitly that the FC will not address is **not** a
 * usage error, even though it looks like one. Exit code 3 has to keep meaning
 * "nothing was attempted", and the channel count is only knowable after a
 * connect and a passthrough -- by which point something has been attempted. So it
 * comes back as a failed target: a clear per-channel error, and exit 1.
 */
export function resolveTargets (selector: EscSelector, escCount: number): {
    targets: number[]
    outOfRange: number[]
} {
    if (selector === 'all') {
        return { targets: Array.from({ length: escCount }, (_, i) => i), outOfRange: [] };
    }

    const targets: number[] = [];
    const outOfRange: number[] = [];
    for (const target of selector) {
        if (target < escCount) {
            targets.push(target);
        } else {
            outOfRange.push(target);
        }
    }
    return { targets, outOfRange };
}

function outOfRangeOutcome<T> (target: number, escCount: number): TargetOutcome<T> {
    return {
        target,
        esc: target + 1,
        ok: false,
        reason: 'esc-init',
        error: `the flight controller reports ${escCount} channel(s), so there is no ESC #${target + 1}`
    };
}

/**
 * Run `work` for each target in order, capturing failures instead of throwing.
 *
 * In order, and not concurrently: 4-way is stateful -- a read or a write acts on
 * whichever channel the last `cmd_DeviceInitFlash` selected -- so overlapping
 * per-channel work is exactly the race block 4's session mutex exists to prevent.
 * The mutex would serialise it anyway; issuing it serially keeps the *reporting*
 * in channel order too.
 */
export async function forEachTarget<T> (
    selector: EscSelector,
    escCount: number,
    work: (target: number) => Promise<T>
): Promise<TargetOutcome<T>[]> {
    const { targets, outOfRange } = resolveTargets(selector, escCount);
    const outcomes: TargetOutcome<T>[] = [];

    for (const target of targets) {
        try {
            outcomes.push({ target, esc: target + 1, ok: true, value: await work(target) });
        } catch (error) {
            const session = causedBySessionError(error);
            outcomes.push({
                target,
                esc: target + 1,
                ok: false,
                reason: session?.reason ?? 'esc-command',
                error: describeError(error)
            });
        }
    }

    for (const target of outOfRange) {
        outcomes.push(outOfRangeOutcome<T>(target, escCount));
    }

    // Named channels the FC cannot address are appended above, so sort back into
    // channel order -- a script reading `escs[0]` should get the lowest channel.
    return outcomes.sort((a, b) => a.target - b.target);
}

/**
 * `{ esc, target, ok, reason, error }` for the JSON envelope, without the payload.
 *
 * `reason` and `error` are always present and null on success rather than absent,
 * so a caller reading `escs[i].error` gets `null` instead of `undefined` and every
 * entry in the array has the same keys. A machine-readable array whose shape
 * depends on the outcome is one every consumer has to guard.
 */
export interface OutcomeSummary {
    esc: number
    target: number
    ok: boolean
    reason: SessionErrorReason | null
    error: string | null
}

export function summariseOutcome (outcome: TargetOutcome<unknown>): OutcomeSummary {
    return {
        esc: outcome.esc,
        target: outcome.target,
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason ?? null,
        error: outcome.ok ? null : outcome.error ?? null
    };
}
