/**
 * `run(argv, env)` -- the whole CLI, as one function that returns an exit code.
 *
 * It never calls `process.exit`, never reads `process.argv` and never touches the
 * filesystem except through {@link CliEnv}, which is what makes every command and
 * every exit code testable end to end against the simulator. `main.ts` is the only
 * file that knows about the process.
 *
 * ## The shape of a command
 *
 * Everything that can be decided from the command line alone is decided *before*
 * anything is opened -- unknown flags, a missing `--esc`, an unparseable hex, a
 * settings file of the wrong length, an unknown setting name. That is what makes
 * exit code 3 mean "nothing was attempted", which is the only thing that makes it
 * useful to a script. After that: connect, enter passthrough if the command needs
 * it, walk the channels capturing per-channel failures, disconnect, report.
 *
 * ## What `--sim` shares with hardware, and what it does not
 *
 * Everything above the transport. Same `Am32Session`, same `Link`, same
 * `TimeoutPolicy`, same quirk records -- issue #3 section 7.3, and the reason there
 * is no second protocol stack anywhere in this repo. What differs is exactly two
 * objects: the transport, and the clock (see `sim.ts` for why the simulated clock
 * is virtual).
 */

import { createSystemClock, type Clock } from 'am32-core/clock';
import { SessionError, describeError } from 'am32-core/errors';
import { parseHex } from 'am32-core/hex';
import { TimeoutPolicy, type FcVariant } from 'am32-core/link/timeout-policy';
import { Am32Session, type FcInfo } from 'am32-core/session';
import type { Transport } from 'am32-core/transport';
import { parseArgs, type GlobalOptions, type ParsedArgs } from './args';
import type { CliEnv } from './env';
import {
    EXIT_CONNECT,
    EXIT_OK,
    EXIT_USAGE,
    exitCodeForError,
    type ExitCode
} from './exit';
import { Reporter, type CommandOutcome } from './report';
import { createSimRig, driveVirtualClock } from './sim';
import { commandEnumerate, commandInfo } from './commands/info';
import { commandPorts } from './commands/ports';
import {
    SETTING_KEYS,
    commandDefaults,
    commandGet,
    commandRead,
    commandSet,
    commandWrite,
    parseAssignment,
    validateSettingsImage,
    type Assignment,
    type ReadFile
} from './commands/settings';
import { commandFlash, commandReset } from './commands/firmware';

/** Commands that need 4-way passthrough. `info` deliberately does not. */
const NEEDS_PASSTHROUGH = new Set(['enumerate', 'read', 'write', 'get', 'set', 'defaults', 'flash', 'reset']);

/**
 * A failure this CLI decided on its own, before or outside the session.
 *
 * Its own class so `run` can tell "the command line was wrong" from "the ESC said
 * no" without inspecting messages.
 */
class UsageError extends Error {
    constructor (message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

/** Everything a command needs that is not its own arguments. */
interface Rig {
    session: Am32Session
    transport: Transport
    clock: Clock
    escCount: number
    fc: FcInfo
    /** Wraps a command body so a simulated run advances its virtual clock. */
    drive: <T>(work: () => Promise<T>) => Promise<T>
    description: string
}

export async function run (argv: readonly string[], env: CliEnv): Promise<ExitCode> {
    const parsed = parseArgs(argv);

    if (parsed.kind === 'help') {
        env.stdout(`${parsed.text}\n`);
        return EXIT_OK;
    }
    if (parsed.kind === 'version') {
        env.stdout(`${env.version}\n`);
        return EXIT_OK;
    }
    if (parsed.kind === 'failure') {
        // No globals were parsed, so there is no --json to honour. A usage error
        // goes to stderr as text, always.
        env.stderr(`error: ${parsed.message}\n`);
        env.stderr('run \'ark32 --help\' for usage\n');
        return EXIT_USAGE;
    }

    const reporter = new Reporter(env, parsed.globals);

    try {
        return await dispatch(parsed, env, reporter);
    } catch (error) {
        if (error instanceof UsageError) {
            return reporter.usage(parsed.command, error.message, EXIT_USAGE);
        }
        return reporter.fail(parsed.command, error, exitCodeForError(error));
    }
}

async function dispatch (args: ParsedArgs, env: CliEnv, reporter: Reporter): Promise<ExitCode> {
    if (args.command === 'ports') {
        return reporter.finish('ports', await commandPorts(env, args.globals.sim));
    }

    // Pre-flight: everything that can be rejected without opening anything.
    const assignments = args.command === 'set' ? parseAssignments(args.operands) : [];
    if (args.command === 'get') {
        checkKeys(args.operands);
    }
    const settingsImage = args.command === 'write' ? await readSettingsImage(args, env) : null;
    const hex = args.command === 'flash' ? await readHex(args, env) : null;

    return withRig(args, env, reporter, async (rig) => {
        // The two commands that address the FC rather than a channel, so neither
        // takes `--esc` and neither reaches the selector guard below.
        if (args.command === 'info') {
            return reporter.finish('info', commandInfo(rig.fc));
        }
        if (args.command === 'enumerate') {
            const results = await rig.session.enumerate();
            return reporter.finish('enumerate', commandEnumerate(rig.fc, rig.escCount, results));
        }

        const selector = args.escs;
        if (selector === null) {
            // Unreachable: the parser requires --esc for every command that
            // reaches here. Thrown rather than asserted so that adding a command
            // and forgetting the parser entry fails loudly -- as it did the first
            // time, when `enumerate` sat below this guard and every run exited 3.
            throw new UsageError(`${args.command} needs --esc`);
        }

        switch (args.command) {
        case 'read': {
            const { outcome, files } = await commandRead(
                rig.session, selector, rig.escCount, args.out as string, env
            );
                // Written after the session work, deliberately: a filesystem await
                // inside a driven virtual clock has no timer to advance.
            await writeFiles(files, args.out as string, env);
            return reporter.finish('read', outcome);
        }
        case 'get':
            return reporter.finish(
                'get',
                await commandGet(rig.session, selector, rig.escCount, args.operands)
            );
        case 'set':
            return reporter.finish('set', await commandSet(
                rig.session, selector, rig.escCount, assignments, args.verify, reporter
            ));
        case 'write':
            return reporter.finish('write', await commandWrite(
                rig.session, selector, rig.escCount, settingsImage as Uint8Array, args.verify, reporter
            ));
        case 'defaults':
            return reporter.finish('defaults', await commandDefaults(
                rig.session, selector, rig.escCount, args.verify, reporter
            ));
        case 'flash':
            return reporter.finish('flash', await commandFlash(
                rig.session, selector, rig.escCount, hex as string,
                { allowMcuMismatch: args.allowMcuMismatch, verify: args.verify }
            ));
        case 'reset':
            return reporter.finish(
                'reset',
                await commandReset(rig.session, selector, rig.escCount)
            );
        default:
            throw new UsageError(`${String(args.command)} is not implemented`);
        }
    });
}

// ---- pre-flight validation -------------------------------------------------

function parseAssignments (operands: readonly string[]): Assignment[] {
    const assignments: Assignment[] = [];
    for (const operand of operands) {
        const parsed = parseAssignment(operand);
        if (typeof parsed === 'string') {
            throw new UsageError(parsed);
        }
        assignments.push(parsed);
    }
    return assignments;
}

function checkKeys (keys: readonly string[]): void {
    for (const key of keys) {
        if (!SETTING_KEYS.includes(key)) {
            throw new UsageError(
                `unknown setting '${key}'. Run 'ark32 get --esc 1' with no keys to list them.`
            );
        }
    }
}

async function readSettingsImage (args: ParsedArgs, env: CliEnv): Promise<Uint8Array> {
    const path = args.input as string;
    const bytes = await env.readFile(path).catch((error: unknown) => {
        throw new UsageError(`cannot read ${path}: ${describeError(error)}`);
    });

    const problem = validateSettingsImage(bytes, path);
    if (problem) {
        throw new UsageError(problem);
    }
    return bytes;
}

async function readHex (args: ParsedArgs, env: CliEnv): Promise<string> {
    const path = args.hex as string;
    const text = await env.readTextFile(path).catch((error: unknown) => {
        throw new UsageError(`cannot read ${path}: ${describeError(error)}`);
    });

    // Parsed here as well as inside `flash()` so that a malformed file is exit 3
    // with nothing opened, rather than exit 3 after a connect and a passthrough.
    const parsedHex = parseHex(text);
    if (!parsedHex || parsedHex.data.length === 0) {
        throw new UsageError(`${path} is not a valid Intel HEX file`);
    }
    return text;
}

async function writeFiles (files: readonly ReadFile[], outDir: string, env: CliEnv): Promise<void> {
    if (files.length === 0) {
        return;
    }
    await env.ensureDir(outDir);
    for (const file of files) {
        await env.writeFile(file.path, file.bytes);
    }
}

// ---- the session ------------------------------------------------------------

/**
 * Open a transport, connect, run `work`, and always disconnect.
 *
 * The `finally` is the whole point of the shape. Leaving a real FC in 4-way
 * passthrough means every ESC stays in its bootloader and the motors stay
 * disabled, so a command that throws still has to send `cmd_InterfaceExit` and
 * close the port -- and a `--sim` run that skipped it would not notice.
 */
async function withRig (
    args: ParsedArgs,
    env: CliEnv,
    reporter: Reporter,
    work: (rig: Rig) => Promise<ExitCode>
): Promise<ExitCode> {
    const { globals } = args;
    const policy = new TimeoutPolicy({
        variant: fcVariant(globals),
        scale: globals.timeoutScale
    });

    let transport: Transport;
    let clock: Clock;
    let drive: Rig['drive'];
    let description: string;

    if (globals.sim) {
        const rig = createSimRig(globals);
        await rig.harness.open();
        transport = rig.harness.transport;
        clock = rig.clock;
        drive = work_ => driveVirtualClock(rig.clock, work_());
        description = rig.description;
    } else {
        const path = globals.port as string;
        clock = createSystemClock();
        transport = await env.openPort({
            path,
            baudRate: globals.baud,
            onError: error => reporter.warn(`serial port: ${error.message}`),
            log: message => reporter.note(message)
        });
        drive = work_ => work_();
        description = `${path} at ${globals.baud} baud`;
    }

    reporter.note(`using ${description}`);

    const session = new Am32Session({ transport, clock, policy });
    session.on('log', event => reporter.log(event));
    session.on('progress', event => reporter.progress(event));
    // Under -v the state channel is what makes the teardown legible: a run that
    // ends anywhere other than `disconnected` left the FC in passthrough, which on
    // a real board means every ESC is still held in its bootloader.
    session.on('state', event => reporter.note(`session ${event.previous} -> ${event.state}`));

    try {
        return await drive(async () => {
            const fc = await session.connect();
            const escCount = NEEDS_PASSTHROUGH.has(args.command)
                ? await session.enterPassthrough()
                : 0;

            return work({
                session, transport, clock, escCount, fc, drive, description
            });
        });
    } finally {
        // Never let a teardown failure replace the command's own result: the
        // command is what the caller asked about.
        await drive(() => session.disconnect().catch((error: unknown) => {
            reporter.warn(`disconnect: ${describeError(error)}`);
        }));
    }
}

/**
 * `--fc` as a timeout-policy variant.
 *
 * `auto` is `generic`, which takes the *worse* of the two firmwares' budgets for
 * every derivation -- Betaflight allows itself 2 ms per byte on a read where
 * ArduPilot allows 1 -- so an unknown FC is never given a timeout that is too
 * tight. Naming the FC only affects the exchanges *before* detection, because
 * `connect()` calls `policy.withVariant()` with what the FC actually reported the
 * moment it knows. So `--fc` is a hint, not an override, and cannot make the
 * session believe a Betaflight board is an ArduPilot one.
 */
function fcVariant (globals: GlobalOptions): FcVariant {
    return globals.fc === 'auto' ? 'generic' : globals.fc;
}

/** Re-exported so `main.ts` and the tests agree on what a connect failure is. */
export { EXIT_CONNECT, SessionError };
export type { CommandOutcome };
