/**
 * The version `ark32 --version` prints.
 *
 * A constant rather than a `package.json` read, because the CLI ships bundled into
 * a single file with no `package.json` beside it. `scripts/build-cli.mjs` fails the
 * build when this and the manifest disagree, so the duplication cannot drift.
 */
export const VERSION = '0.1.0';
