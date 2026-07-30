/**
 * `ark32`'s argument parser.
 *
 * Hand-rolled rather than a dependency, for three reasons that all point the same
 * way. Exit code 3 is "bad arguments" (issue #3 section 6), so argument
 * validation is a *specified behaviour* of this tool and needs to be tested as
 * one -- a library that prints its own usage and calls `process.exit` takes that
 * away. The whole surface is ten commands and fourteen flags, which is smaller
 * than the configuration a parser library would need. And the CLI is bundled into
 * single-file binaries, where every dependency is bytes and a licence.
 *
 * Everything here is pure: it turns `string[]` into a value or a
 * {@link ParseFailure}, touches no filesystem and no process state, and never
 * exits. That is what lets `args.test.ts` cover the exit-code-3 table exhaustively.
 */

export const COMMANDS = [
    'ports',
    'info',
    'enumerate',
    'read',
    'write',
    'get',
    'set',
    'defaults',
    'flash',
    'reset'
] as const;

export type CommandName = typeof COMMANDS[number];

export const FC_CHOICES = ['auto', 'ardupilot', 'betaflight'] as const;
export type FcChoice = typeof FC_CHOICES[number];

/** Default for `--baud`. What the app has always opened an FC with. */
export const DEFAULT_BAUD_RATE = 115200;
/** Default for `--escs`. Four is an ARK FPV. */
export const DEFAULT_SIM_ESCS = 4;

/**
 * A knob on one simulated ESC, the FC, or the host link.
 *
 * `subject` is spelled the way the user typed it -- `esc3`, `fc`, `link` -- and
 * `target` is the **zero-based** channel it resolves to. `--fault esc3=...` means
 * the same ESC as `--esc 3`, i.e. the one the UI calls ESC #3, i.e. target 2.
 * Mixing those up is the kind of bug a fault-injection flag exists to find, so
 * the conversion happens once, here.
 */
export interface FaultSpec {
    subject: string
    scope: 'esc' | 'fc' | 'link'
    target: number | null
    knob: string
    /**
     * The knob's argument, already validated against
     * {@link KNOB_VALUE_KINDS}. `true` is the "every time, forever" form of a
     * counted knob; a number is the counted or measured form.
     */
    value: number | boolean | null
}

export interface GlobalOptions {
    /** `-p/--port`. Required for a hardware command; unused with `--sim`. */
    port: string | null
    baud: number
    fc: FcChoice
    json: boolean
    verbose: boolean
    /** `--timeout-scale`. Multiplies every derived timeout. */
    timeoutScale: number
    sim: boolean
    /** `--escs`, only meaningful with `--sim`. */
    escs: number
    faults: FaultSpec[]
}

/** `--esc all`, or the zero-based channels `--esc` named. */
export type EscSelector = 'all' | number[];

export interface ParsedArgs {
    command: CommandName
    globals: GlobalOptions
    /** Null when the command does not take `--esc`. */
    escs: EscSelector | null
    /** `-o/--out`, a directory. */
    out: string | null
    /** `-i/--in`, a settings file. */
    input: string | null
    /** `--hex`, a firmware image. */
    hex: string | null
    /** False when `--no-verify` was given. Every write path reads this. */
    verify: boolean
    allowMcuMismatch: boolean
    /** Whatever positional arguments followed the command. */
    operands: string[]
}

export interface ParseFailure {
    kind: 'failure'
    message: string
}

export interface ParseHelp {
    kind: 'help'
    text: string
}

export interface ParseVersion {
    kind: 'version'
}

export interface ParseSuccess extends ParsedArgs {
    kind: 'args'
}

export type ParseResult = ParseSuccess | ParseFailure | ParseHelp | ParseVersion;

const fail = (message: string): ParseFailure => ({ kind: 'failure', message });

/** Flags that take a value, so `--flag value` consumes the next token. */
const VALUED_FLAGS = new Set([
    '-p', '--port',
    '--baud',
    '--fc',
    '--timeout-scale',
    '--escs',
    '--fault',
    '--esc',
    '-o', '--out',
    '-i', '--in',
    '--hex'
]);

/** Which commands accept which command-scoped flags. Anything else is exit 3. */
const COMMAND_FLAGS: Record<CommandName, readonly string[]> = {
    ports: [],
    info: [],
    enumerate: [],
    read: ['--esc', '--out'],
    write: ['--esc', '--in', '--no-verify'],
    get: ['--esc'],
    set: ['--esc', '--no-verify'],
    defaults: ['--esc', '--no-verify'],
    flash: ['--esc', '--hex', '--no-verify', '--allow-mcu-mismatch'],
    reset: ['--esc']
};

/** Commands that require `--esc`. Every command that takes it requires it. */
const NEEDS_ESC = new Set<CommandName>(['read', 'write', 'get', 'set', 'defaults', 'flash', 'reset']);

/**
 * What each fault knob does with its `:VALUE`.
 *
 * The kinds mirror the simulator's own types, so a spec that parses here is a
 * spec `sim.ts` can apply without a second round of validation:
 *
 *  - `none` -- a plain boolean knob; a value is a mistake.
 *  - `number` -- required, and measured in whatever the knob measures (ms for
 *    `slowBy`, bytes for `dropBytes`, an MSP command id for `mspError`).
 *  - `count` -- `boolean | number` in `SimEsc`: absent means the knob's plain
 *    "always" form, a number means whatever that knob counts. For `corruptCrc`,
 *    `silentWriteFailure` and `failingFlashCell` that is "the next N", which is what
 *    makes "the retry recovered" an exact assertion instead of a race. **For
 *    `shortRead` it is a byte count**, not an occurrence count -- `true` is one byte
 *    short and `:2` is "always answer with two" -- which is why `USAGE` spells that
 *    one `[:BYTES]`.
 *  - `flag` -- `true` when bare, or an explicit `true`/`false`.
 *
 * Validating values *here* rather than where they are applied is deliberate:
 * every exit-code-3 decision belongs to the parser, which is pure and fully
 * tested. `sim.ts` must never be able to reject a command line.
 */
export const KNOB_VALUE_KINDS = {
    esc: {
        unresponsive: 'none',
        slowBy: 'number',
        corruptCrc: 'count',
        shortRead: 'count',
        silentWriteFailure: 'count',
        failingFlashCell: 'count'
    },
    fc: {
        blockingFourWay: 'flag',
        mavlinkIdleGate: 'number',
        mspError: 'number'
    },
    link: {
        dropBytes: 'number',
        injectGarbage: 'number'
    }
} as const satisfies Record<string, Record<string, 'none' | 'number' | 'count' | 'flag'>>;

type KnobValueKind = 'none' | 'number' | 'count' | 'flag';

const knobKinds = (scope: 'esc' | 'fc' | 'link'): Record<string, KnobValueKind> =>
    KNOB_VALUE_KINDS[scope];

export const USAGE = `ark32 -- headless configurator for AM32 ESCs behind a flight controller

Usage: ark32 [global flags] <command> [command flags]

Commands
  ports                                   list serial ports with VID:PID
  info                                    FC variant, API version, motor count
  enumerate                               per-ESC status; partial-safe
  read     --esc 1|all -o DIR             dump the 192-byte settings image per ESC
  write    --esc 1|all -i FILE            apply a settings image, byte-preserving
  get      --esc 1 [KEY...]               print named settings
  set      --esc all KEY=VALUE...         read-modify-write, byte-preserving
  defaults --esc all                      reset to AM32's defaults, keeping identity
  flash    --esc 1|all --hex FILE         flash an Intel HEX firmware image
  reset    --esc all                      leave the bootloader and run the firmware

Global flags
  -p, --port PATH        serial device (/dev/ttyACM0, COM3). Required without --sim
      --baud N           port baud rate (default ${DEFAULT_BAUD_RATE})
      --fc CHOICE        auto | ardupilot | betaflight (default auto)
      --json             emit one machine-readable object on stdout
  -v, --verbose          print the session's log and progress events on stderr
      --timeout-scale N  multiply every derived protocol timeout
      --sim              run against the simulated FC and ESCs, with no hardware
      --escs N           simulated ESC count (default ${DEFAULT_SIM_ESCS}); --sim only
      --fault SPEC       inject a fault; repeatable. --sim only
  -h, --help             this text
      --version          print the version

Command flags
      --esc 1|all|1,3    which channels. 1-based, as the UI numbers them
  -o, --out DIR          where 'read' writes its .bin files
  -i, --in FILE          the settings image 'write' applies
      --hex FILE         the firmware image 'flash' writes
      --no-verify        skip read-back verification (write, set, defaults, flash)
      --allow-mcu-mismatch  flash a hex whose firmware name is not this board's

Fault specs (--sim only)
  escN=unresponsive            escN=slowBy:MS           escN=corruptCrc[:COUNT]
  escN=shortRead[:BYTES]       escN=silentWriteFailure[:COUNT]
  escN=failingFlashCell[:COUNT]
  fc=blockingFourWay           fc=mavlinkIdleGate:MS    fc=mspError:COMMAND
  link=dropBytes:COUNT         link=injectGarbage:COUNT

Exit codes
  0 success   1 some ESCs failed   2 connect or FC detection failed   3 bad arguments

Examples
  ark32 --sim enumerate --escs 4
  ark32 --sim write --esc all -i fixture.bin
  ark32 -p /dev/ttyACM0 set --esc all TIMING_ADVANCE=16
  ark32 --sim --fault esc3=unresponsive enumerate --json`;

function parseInteger (flag: string, raw: string, min: number): number | ParseFailure {
    if (!/^\d+$/.test(raw)) {
        return fail(`${flag} needs a whole number, got '${raw}'`);
    }
    const value = Number(raw);
    if (value < min) {
        return fail(`${flag} must be at least ${min}, got ${value}`);
    }
    return value;
}

function parseScale (raw: string): number | ParseFailure {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return fail(`--timeout-scale needs a positive number, got '${raw}'`);
    }
    return value;
}

/**
 * `--esc 1`, `--esc all`, `--esc 1,3`.
 *
 * A comma list is accepted as well as the plan's `1|all` because it is a strict
 * superset that cannot surprise anyone, and "flash channels 1 and 3 on a mixed
 * board" is a real thing to want.
 */
function parseEscSelector (raw: string): EscSelector | ParseFailure {
    if (raw === 'all') {
        return 'all';
    }

    const targets: number[] = [];
    for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (!/^\d+$/.test(trimmed)) {
            return fail(`--esc takes 'all' or 1-based channel numbers, got '${raw}'`);
        }
        const channel = Number(trimmed);
        if (channel < 1) {
            return fail('--esc is 1-based, as the UI numbers ESCs; 0 is not a channel');
        }
        if (!targets.includes(channel - 1)) {
            targets.push(channel - 1);
        }
    }

    if (targets.length === 0) {
        return fail('--esc needs at least one channel');
    }
    return targets;
}

function parseKnobValue (
    subject: string,
    knob: string,
    kind: KnobValueKind,
    raw: string | null
): number | boolean | null | ParseFailure {
    const where = `--fault ${subject}=${knob}`;

    if (kind === 'none') {
        return raw === null ? null : fail(`${where} takes no value, got ':${raw}'`);
    }

    if (kind === 'flag') {
        if (raw === null || raw === 'true') {
            return true;
        }
        if (raw === 'false') {
            return false;
        }
        return fail(`${where} takes true or false, got '${raw}'`);
    }

    if (raw === null) {
        return kind === 'count' ? true : fail(`${where} needs a value, as ${knob}:N`);
    }

    return parseInteger(where, raw, 0);
}

function parseFault (raw: string): FaultSpec | ParseFailure {
    const eq = raw.indexOf('=');
    if (eq < 1) {
        return fail(`--fault needs SUBJECT=KNOB[:VALUE], got '${raw}'`);
    }

    const subject = raw.slice(0, eq);
    const rest = raw.slice(eq + 1);
    const colon = rest.indexOf(':');
    const knob = colon === -1 ? rest : rest.slice(0, colon);
    const rawValue = colon === -1 ? null : rest.slice(colon + 1);

    if (knob.length === 0) {
        return fail(`--fault '${raw}' names no knob`);
    }

    let scope: 'esc' | 'fc' | 'link';
    let target: number | null = null;

    if (subject === 'fc' || subject === 'link') {
        scope = subject;
    } else {
        const esc = /^esc(\d+)$/.exec(subject);
        if (!esc) {
            return fail(`--fault '${raw}': subject must be escN, fc or link`);
        }
        const channel = Number(esc[1]);
        if (channel < 1) {
            return fail(`--fault ${subject}: ESC numbering is 1-based, as --esc is`);
        }
        scope = 'esc';
        target = channel - 1;
    }

    const kinds = knobKinds(scope);
    const kind = kinds[knob];
    if (kind === undefined) {
        return fail(
            `--fault ${subject}=${knob}: unknown ${scope} knob. ` +
            `Known: ${Object.keys(kinds).join(', ')}`
        );
    }

    const value = parseKnobValue(subject, knob, kind, rawValue);
    if (value !== null && typeof value === 'object') {
        return value;
    }

    return { subject, scope, target, knob, value };
}

/** Split `--flag=value` into two tokens so the main loop only sees one form. */
function normalise (argv: readonly string[]): string[] {
    const out: string[] = [];
    for (const token of argv) {
        if (token.startsWith('--') && token.includes('=') && !token.startsWith('--fault=')) {
            const eq = token.indexOf('=');
            out.push(token.slice(0, eq), token.slice(eq + 1));
            continue;
        }
        if (token.startsWith('--fault=')) {
            out.push('--fault', token.slice('--fault='.length));
            continue;
        }
        out.push(token);
    }
    return out;
}

export function parseArgs (argv: readonly string[]): ParseResult {
    const tokens = normalise(argv);

    const globals: GlobalOptions = {
        port: null,
        baud: DEFAULT_BAUD_RATE,
        fc: 'auto',
        json: false,
        verbose: false,
        timeoutScale: 1,
        sim: false,
        escs: DEFAULT_SIM_ESCS,
        faults: []
    };

    let command: CommandName | null = null;
    let escsFlagSeen = false;
    let escSelector: EscSelector | null = null;
    let out: string | null = null;
    let input: string | null = null;
    let hex: string | null = null;
    let verify = true;
    let allowMcuMismatch = false;
    const operands: string[] = [];
    const flagsUsed = new Set<string>();

    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i] as string;

        if (token === '-h' || token === '--help') {
            return { kind: 'help', text: USAGE };
        }
        if (token === '--version') {
            return { kind: 'version' };
        }

        if (VALUED_FLAGS.has(token)) {
            const value = tokens[i + 1];
            if (value === undefined || (value.startsWith('-') && value.length > 1 && !/^-\d/.test(value))) {
                return fail(`${token} needs a value`);
            }
            i += 1;

            switch (token) {
            case '-p':
            case '--port':
                globals.port = value;
                break;
            case '--baud': {
                const parsed = parseInteger('--baud', value, 1);
                if (typeof parsed !== 'number') {
                    return parsed;
                }
                globals.baud = parsed;
                break;
            }
            case '--fc': {
                if (!(FC_CHOICES as readonly string[]).includes(value)) {
                    return fail(`--fc takes ${FC_CHOICES.join(' | ')}, got '${value}'`);
                }
                globals.fc = value as FcChoice;
                break;
            }
            case '--timeout-scale': {
                const parsed = parseScale(value);
                if (typeof parsed !== 'number') {
                    return parsed;
                }
                globals.timeoutScale = parsed;
                break;
            }
            case '--escs': {
                const parsed = parseInteger('--escs', value, 0);
                if (typeof parsed !== 'number') {
                    return parsed;
                }
                globals.escs = parsed;
                escsFlagSeen = true;
                break;
            }
            case '--fault': {
                const parsed = parseFault(value);
                if ('kind' in parsed) {
                    return parsed;
                }
                globals.faults.push(parsed);
                break;
            }
            case '--esc': {
                const parsed = parseEscSelector(value);
                if (typeof parsed === 'object' && 'kind' in parsed) {
                    return parsed;
                }
                escSelector = parsed;
                flagsUsed.add('--esc');
                break;
            }
            case '-o':
            case '--out':
                out = value;
                flagsUsed.add('--out');
                break;
            case '-i':
            case '--in':
                input = value;
                flagsUsed.add('--in');
                break;
            case '--hex':
                hex = value;
                flagsUsed.add('--hex');
                break;
            }
            continue;
        }

        switch (token) {
        case '--json':
            globals.json = true;
            continue;
        case '-v':
        case '--verbose':
            globals.verbose = true;
            continue;
        case '--sim':
            globals.sim = true;
            continue;
        case '--no-verify':
            verify = false;
            flagsUsed.add('--no-verify');
            continue;
        case '--allow-mcu-mismatch':
            allowMcuMismatch = true;
            flagsUsed.add('--allow-mcu-mismatch');
            continue;
        }

        if (token.startsWith('-') && token !== '-') {
            return fail(`unknown flag '${token}'. Try 'ark32 --help'`);
        }

        if (command === null) {
            if (!(COMMANDS as readonly string[]).includes(token)) {
                return fail(`unknown command '${token}'. Known: ${COMMANDS.join(', ')}`);
            }
            command = token as CommandName;
            continue;
        }

        operands.push(token);
    }

    if (command === null) {
        return fail('no command given. Try \'ark32 --help\'');
    }

    // Flags the command does not take are a mistake, not something to ignore --
    // `ark32 read --esc all --hex fw.hex` should not silently read settings.
    const allowed = COMMAND_FLAGS[command];
    for (const flag of flagsUsed) {
        if (!allowed.includes(flag)) {
            return fail(`${command} does not take ${flag}`);
        }
    }

    if (NEEDS_ESC.has(command) && escSelector === null) {
        return fail(`${command} needs --esc: a 1-based channel number, or 'all'`);
    }

    if (command === 'read' && out === null) {
        return fail('read needs -o/--out: a directory to write the .bin files into');
    }
    if (command === 'write' && input === null) {
        return fail('write needs -i/--in: the settings image to apply');
    }
    if (command === 'flash' && hex === null) {
        return fail('flash needs --hex: the Intel HEX firmware image to write');
    }
    if (command === 'set' && operands.length === 0) {
        return fail('set needs at least one KEY=VALUE');
    }

    if (operands.length > 0 && command !== 'get' && command !== 'set') {
        return fail(`${command} takes no positional arguments, got '${operands.join(' ')}'`);
    }

    if (!globals.sim) {
        // A flag that only means something with --sim is a user who thinks they
        // are running against the simulator and is not. Silence would be worse.
        if (globals.faults.length > 0) {
            return fail('--fault only applies to --sim; there is no fault injection on real hardware');
        }
        if (escsFlagSeen) {
            return fail('--escs only applies to --sim; a real FC reports its own channel count');
        }
        if (globals.port === null && command !== 'ports') {
            return fail(`${command} needs -p/--port, or --sim to run against the simulator`);
        }
    } else {
        if (globals.port !== null) {
            return fail('--sim and -p/--port are mutually exclusive');
        }
        // Checked after the loop because --escs may follow --fault on the command
        // line. A knob aimed at a channel the rig does not have would otherwise be
        // applied to nothing, and the run would look like the fault did not fire.
        for (const fault of globals.faults) {
            if (fault.target !== null && fault.target >= globals.escs) {
                return fail(
                    `--fault ${fault.subject}: the rig has ${globals.escs} ESC(s), ` +
                    'so there is no such channel'
                );
            }
        }
    }

    return {
        kind: 'args',
        command,
        globals,
        escs: escSelector,
        out,
        input,
        hex,
        verify,
        allowMcuMismatch,
        operands
    };
}
