/**
 * The exit-code table from issue #3 section 6, and the one decision it does not
 * cover.
 *
 * ```
 * 0  success
 * 1  partial -- some ESCs failed
 * 2  connect or FC detection failure
 * 3  bad arguments
 * ```
 *
 * The contract a script depends on is what each code tells it to *do*: 0, carry
 * on; 1, look at the per-ESC results; 2, the flight controller is not reachable
 * so nothing about the ESCs is known; 3, the command line was wrong and nothing
 * was attempted.
 *
 * ## Where `esc-verify` goes, and why
 *
 * Block 6 added `SessionErrorReason.esc-verify` -- a write the FC reported as
 * `ACK_OK` that did not read back (`AP_BLHeli.cpp:928-932`) -- and its own note
 * flags that section 6's table does not cover it. **It is 1.** The ESC is
 * healthy and answering, so it is not 2; the arguments were fine, so it is not 3.
 * And `write --esc all` on four ESCs where one fails to verify is exactly "some
 * ESCs failed" -- giving that its own code would break the one thing code 1
 * promises, which is that the per-ESC results are where the answer is. A caller
 * that wants to distinguish it has `--json`, where every failed channel carries
 * its `reason`.
 *
 * ## Where `image` goes, and why it is the one exception
 *
 * `image` -- not Intel HEX, or a hex built for another board -- is a bad
 * argument that happens to be discovered on the wire, and `errors.ts` says as
 * much: "block 7 maps it to a different exit code". So:
 *
 *  - A file this CLI can read and reject on its own (unparseable hex, a settings
 *    image of the wrong length) is rejected **before connecting**, and that is a
 *    plain 3.
 *  - A hex that parses but does not match the board is only discoverable per
 *    channel. If **every** attempted channel rejected it for that reason, the
 *    argument was wrong and it is 3. If some channels took it, that is a partial
 *    result and 1 wins -- because something *was* written, and 3 must keep
 *    meaning "nothing was attempted".
 */

import { causedBySessionError, type SessionErrorReason } from 'am32-core/errors';

export const EXIT_OK = 0;
export const EXIT_PARTIAL = 1;
export const EXIT_CONNECT = 2;
export const EXIT_USAGE = 3;

export type ExitCode = typeof EXIT_OK | typeof EXIT_PARTIAL | typeof EXIT_CONNECT | typeof EXIT_USAGE;

/**
 * Reasons that mean the flight controller itself is the problem, so nothing is
 * known about any ESC.
 *
 * `not-connected` is in here because it can only happen when a connect that
 * should have thrown did not -- it is a session-level failure either way, and
 * reporting it as a partial would claim knowledge of channels we never addressed.
 */
const CONNECT_REASONS: ReadonlySet<SessionErrorReason> = new Set<SessionErrorReason>([
    'transport',
    'fc-detect',
    'passthrough',
    'not-connected'
]);

/** The exit code for a failure that stopped the whole command. */
export function exitCodeForError (error: unknown): ExitCode {
    const session = causedBySessionError(error);
    if (!session) {
        // Anything that is not a SessionError got past every guard the session
        // has, so it is not a diagnosis -- 1 keeps it out of the two codes that
        // make a specific claim.
        return EXIT_PARTIAL;
    }
    if (CONNECT_REASONS.has(session.reason)) {
        return EXIT_CONNECT;
    }
    if (session.reason === 'image') {
        return EXIT_USAGE;
    }
    return EXIT_PARTIAL;
}

/** One channel's outcome, as every per-ESC command reports it. */
export interface TargetOutcome {
    ok: boolean
    reason?: SessionErrorReason
}

/**
 * The exit code for a command that walked a set of channels.
 *
 * The `image`-only case is the exception documented at the top of this file: a
 * hex none of the targeted channels would accept is a wrong argument, but a hex
 * one channel accepted is a partial result.
 */
export function exitCodeForTargets (outcomes: readonly TargetOutcome[]): ExitCode {
    if (outcomes.length === 0) {
        return EXIT_OK;
    }

    const failures = outcomes.filter(outcome => !outcome.ok);
    if (failures.length === 0) {
        return EXIT_OK;
    }

    if (failures.length === outcomes.length && failures.every(f => f.reason === 'image')) {
        return EXIT_USAGE;
    }

    return EXIT_PARTIAL;
}
