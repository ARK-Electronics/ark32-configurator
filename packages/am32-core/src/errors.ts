/**
 * The one error type the session layer throws.
 *
 * Below it, `LinkError` describes *how* an exchange failed (timeout, write,
 * closed) and `MspFrameError` / `FourWayFrameError` describe *what was wrong
 * with the bytes*. Neither is meaningful to a caller deciding whether to show a
 * toast or set an exit code, so the session translates them into a small closed
 * set of reasons and keeps the original as `cause`.
 *
 * Its own module rather than `session.ts` so `fc/msp-session.ts` and
 * `esc/fourway-session.ts` can throw it without importing the class that
 * imports them.
 */

export type SessionErrorReason =
    /** The transport is not open, or a write failed. */
    | 'transport'
    /** No flight controller answered MSP, even after the MAVLink idle window. */
    | 'fc-detect'
    /** `MSP_SET_PASSTHROUGH` failed, or MSP was attempted while in passthrough. */
    | 'passthrough'
    /** `cmd_DeviceInitFlash` did not bring up a channel's bootloader. */
    | 'esc-init'
    /** A read answered non-OK, or came back shorter than it was asked for. */
    | 'esc-read'
    /** Any other 4-way command answered with a non-OK ACK. */
    | 'esc-command'
    /**
     * The firmware image the caller handed us is unusable: not Intel HEX, or
     * built for a different board than the ESC in front of us.
     *
     * Distinct from the `esc-*` reasons because nothing was attempted on the
     * wire -- it is a bad argument, and block 7 maps it to a different exit code.
     */
    | 'image'
    /** The call needs a `connect()` that has not happened. */
    | 'not-connected';

export class SessionError extends Error {
    readonly reason: SessionErrorReason;
    /** The 4-way ACK code, when the failure came back as one. */
    readonly ack?: number;
    /** Zero-based ESC channel, when the failure belongs to one. */
    readonly target?: number;

    constructor (
        reason: SessionErrorReason,
        message: string,
        options: { cause?: unknown, ack?: number, target?: number } = {}
    ) {
        super(message, { cause: options.cause });
        this.name = 'SessionError';
        this.reason = reason;
        this.ack = options.ack;
        this.target = options.target;
    }
}

/** `error.message` for anything, including the non-Errors a listener may throw. */
export function describeError (error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Depth limit for {@link causedBySessionError}, so a cycle cannot spin. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Find the {@link SessionError} a failure grew out of, if any.
 *
 * Needed because `Link.request` wraps whatever `validate` throws in a
 * `LinkError('validate', ...)` with the original as `cause` -- so the precise
 * reason a 4-way exchange failed (`esc-read` for a short reply as against
 * `esc-command` for a rejected ACK) is one or two levels down rather than on the
 * error the caller catches. Losing that distinction flattens exactly the
 * information the session exists to preserve.
 */
export function causedBySessionError (error: unknown): SessionError | null {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
        if (current instanceof SessionError) {
            return current;
        }
        current = (current as { cause?: unknown }).cause;
    }
    return null;
}
