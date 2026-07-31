/**
 * am32-cli -- the `ark32` binary.
 *
 * A client of `am32-core`, exactly like the Nuxt app is: it constructs a
 * `Transport` and an `Am32Session` and calls it. There is no protocol code in this
 * package and there must never be -- if a command needs a frame, a timeout or an
 * FC-variant branch, that belongs in the core where the simulator can hold it down
 * (issue #3 sections 7.3 and 7.4).
 */

export { run } from './run';
export { parseArgs, USAGE, COMMANDS } from './args';
export type { CommandName, FaultSpec, GlobalOptions, ParseResult, ParsedArgs } from './args';
export type { CliEnv, OpenPortRequest } from './env';
export { createNodeEnv } from './node-env';
export { VERSION } from './version';
export {
    EXIT_CONNECT,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_USAGE,
    exitCodeForError,
    exitCodeForTargets
} from './exit';
export type { ExitCode } from './exit';
export { createSimRig, driveVirtualClock } from './sim';
