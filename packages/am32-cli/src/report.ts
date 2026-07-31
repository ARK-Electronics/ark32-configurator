/**
 * What `ark32` prints, and where.
 *
 * One rule decides everything here: **with `--json`, stdout carries exactly one
 * JSON object and nothing else.** A tool whose machine-readable output has a
 * stray log line in it is a tool every caller has to write a filter for. So the
 * session's log and progress events, and every warning, go to stderr in both
 * modes; only the human-readable rendering and the JSON envelope go to stdout,
 * and never both.
 *
 * Section 6 says `--json` "emits one machine-readable object per command", so the
 * envelope is emitted once, at the end, including when the command failed --
 * `{ ok: false, exitCode: 2, error: { reason, message } }` is more useful to a
 * script than an empty stdout and a message it has to parse out of stderr.
 */

import type { LogEvent, ProgressEvent } from 'am32-core/session';
import { describeError, causedBySessionError } from 'am32-core/errors';
import type { GlobalOptions } from './args';
import type { CliEnv } from './env';
import type { ExitCode } from './exit';

/** What a command produced. Rendered as text, or merged into the JSON envelope. */
export interface CommandOutcome {
    /** Machine-readable body. Keys become top-level fields of the envelope. */
    data: Record<string, unknown>
    /** Human-readable lines for stdout, without trailing newlines. */
    lines: string[]
    exitCode: ExitCode
}

/**
 * Progress ticks printed per phase under `-v`.
 *
 * A flash emits one tick per 256-byte chunk -- around 108 for a 27 KiB image,
 * times four ESCs -- and a wall of them buries the log lines that matter. Four is
 * enough to see that it is moving.
 */
const PROGRESS_TICKS_PER_PHASE = 4;

export class Reporter {
    /** `warn` and `error` log lines, in order. Carried in the JSON envelope. */
    readonly warnings: string[] = [];

    private readonly env: CliEnv;
    private readonly globals: GlobalOptions;
    /** Last printed fraction, per phase, so progress can be thinned. */
    private readonly lastTick = new Map<string, number>();

    constructor (env: CliEnv, globals: GlobalOptions) {
        this.env = env;
        this.globals = globals;
    }

    /** A session `log` event. */
    log (event: LogEvent): void {
        if (event.level === 'info') {
            if (this.globals.verbose) {
                this.env.stderr(`  ${event.message}\n`);
            }
            return;
        }

        this.warnings.push(event.message);
        this.env.stderr(`${event.level === 'warn' ? 'warning' : 'error'}: ${event.message}\n`);
    }

    /** A session `progress` event. Only ever printed under `-v`. */
    progress (event: ProgressEvent): void {
        if (!this.globals.verbose) {
            return;
        }

        const key = `${event.phase}:${event.target ?? '-'}`;
        const fraction = event.total > 0 ? event.current / event.total : 1;
        const bucket = Math.floor(fraction * PROGRESS_TICKS_PER_PHASE);
        if (this.lastTick.get(key) === bucket && fraction < 1) {
            return;
        }
        this.lastTick.set(key, bucket);

        const where = event.target === undefined ? '' : ` ESC #${event.target + 1}`;
        const of = event.total > 0 ? ` ${event.current}/${event.total}` : '';
        this.env.stderr(`  [${event.phase}${where}]${of}\n`);
    }

    /** Something worth saying that did not come from the session. */
    warn (message: string): void {
        this.warnings.push(message);
        this.env.stderr(`warning: ${message}\n`);
    }

    /** A plain diagnostic line. Never machine-read, never stdout. */
    note (message: string): void {
        if (this.globals.verbose) {
            this.env.stderr(`  ${message}\n`);
        }
    }

    /** Print the result of a command that ran, and return its exit code. */
    finish (command: string, outcome: CommandOutcome): ExitCode {
        if (this.globals.json) {
            this.emitJson(command, outcome.exitCode, outcome.data, null);
        } else {
            for (const line of outcome.lines) {
                this.env.stdout(`${line}\n`);
            }
        }
        return outcome.exitCode;
    }

    /** Print a failure that stopped the command, and return its exit code. */
    fail (command: string, error: unknown, exitCode: ExitCode): ExitCode {
        const session = causedBySessionError(error);
        const message = describeError(error);

        if (this.globals.json) {
            this.emitJson(command, exitCode, {}, {
                reason: session?.reason ?? null,
                target: session?.target ?? null,
                message
            });
        } else {
            this.env.stderr(`error: ${message}\n`);
        }
        return exitCode;
    }

    /** A usage failure: no command ran, so there is nothing but the message. */
    usage (command: string | null, message: string, exitCode: ExitCode): ExitCode {
        if (this.globals.json) {
            this.emitJson(command ?? 'ark32', exitCode, {}, { reason: 'usage', target: null, message });
        } else {
            this.env.stderr(`error: ${message}\n`);
        }
        return exitCode;
    }

    private emitJson (
        command: string,
        exitCode: ExitCode,
        data: Record<string, unknown>,
        error: { reason: string | null, target: number | null, message: string } | null
    ): void {
        const envelope = {
            command,
            ok: exitCode === 0,
            exitCode,
            simulated: this.globals.sim,
            ...data,
            warnings: this.warnings,
            error
        };
        this.env.stdout(`${JSON.stringify(envelope, jsonReplacer, 2)}\n`);
    }
}

/**
 * `Uint8Array` is the one type that reaches the envelope and does not survive
 * `JSON.stringify` -- it serialises as `{"0":1,"1":2}`, which is unusable. The
 * CAN block and the startup melody are both byte arrays, so this matters for
 * every `get` and every `read`.
 */
function jsonReplacer (_key: string, value: unknown): unknown {
    return value instanceof Uint8Array ? Array.from(value) : value;
}

/**
 * Render a settings value the way `get` prints it.
 *
 * Byte blobs and the melody are printed as decimal byte lists rather than hex:
 * the CAN block's fields (`can_node`, `esc_index`, `telem_rate`, `filter_hz`)
 * are decimal quantities in the firmware and in the UI, and printing `0xC8`
 * where the user set 200 is a small betrayal.
 */
export function formatSettingValue (value: number | number[] | Uint8Array): string {
    if (typeof value === 'number') {
        return String(value);
    }
    return `[${Array.from(value).join(',')}]`;
}
