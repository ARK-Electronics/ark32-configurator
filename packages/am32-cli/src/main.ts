/**
 * The `ark32` entry point.
 *
 * Everything it does is turn a process into arguments and an exit code. No
 * `.then()`-free top-level await, deliberately: the single-file binaries are
 * built as CommonJS (Node's SEA takes a CJS main script), and esbuild cannot
 * lower top-level await into CJS.
 */

import { run } from './run';
import { createNodeEnv } from './node-env';

run(process.argv.slice(2), createNodeEnv()).then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        // Nothing should reach here -- `run` maps every failure to an exit code --
        // so if it does, it is a bug in this CLI rather than a protocol failure.
        // Exit 1 keeps it out of the two codes that make a specific claim.
        process.stderr.write(`ark32: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
);
