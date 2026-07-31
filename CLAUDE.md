# ARK32 Configurator

Nuxt 3 web configurator for AM32 ESCs, talking to a flight controller over Web
Serial (MSP + BLHeli 4-way passthrough). ARK's fork of `am32-configurator`.

The 2026-07 overhaul (**issue #3**: shared protocol core + headless CLI) is
complete. All protocol code lives in `packages/am32-core`; the Nuxt app and the
`ark32` CLI are both thin clients of it. Issue #3 holds the design rationale and
the audit trail; `docs/TESTING.md` explains how the stack is tested.

## Commands

- `./run.sh` — start the dev server and open a browser. Works with no MariaDB,
  MinIO or Redis running. Use this, not `yarn dev`.
- `./install-cli.sh` — build the `ark32` CLI and symlink it to
  `~/.local/bin/ark32` (override with `--prefix`). Peer of `./run.sh` for the
  headless path. Re-run after pulling, or `yarn build:cli` alone to refresh the
  bundle the symlink already points at.
- `yarn verify` — the gate. Runs `lint`, `typecheck` (core + app), `test`. Must
  exit 0 before anything lands.
- `yarn test` / `yarn test:watch` — vitest over `packages/**`.
- `yarn typecheck:core` — the DOM/Node exclusion check (see below).
- `yarn build:cli` — bundle the `ark32` CLI into `packages/am32-cli/dist/`. The
  CLI is the only package that needs a build step (esbuild inlines the
  workspace packages; `serialport` stays external). Not part of `yarn verify`;
  `bash scripts/assert-cli-sim.sh` is the gate that covers it.
- `ark32 --sim <command>` — drive the whole protocol stack with no hardware. The
  fastest way to reproduce a protocol failure or see a session's log lines.
- Yarn 4 only. Never `npm install`. Node 22 (`.nvmrc`).

## Layout

- `packages/am32-core/` — transport-agnostic protocol code. No DOM, no Node, no
  Vue. Its `tsconfig.json` omits the `dom` lib and sets `types: []`, so
  `navigator`, `window`, `Buffer`, `process` and `fs` are **compile errors**
  here. That is deliberate: it is what forces protocol logic out of Vue
  components and keeps the web and CLI paths identical. If you want to add `dom`
  to that tsconfig, the code belongs in a transport package instead.
- `components/`, `pages/`, `stores/` — Nuxt app. A thin client of the core; it
  must not reach below the session layer (an ESLint rule enforces this).
- `packages/am32-web`, `packages/am32-node`, `packages/am32-sim` — the three
  `Transport` implementations: Web Serial, node-serialport, and the simulated FC
  and ESCs. Peers, not variants; a transport moves bytes and nothing else.
- `packages/am32-cli/` — the `ark32` binary. A client of the core exactly as the
  Nuxt app is. No protocol code lives here.
- `src/`, `utils/` — leftover app helpers (db, settings schema, release sync,
  small utils). No protocol code remains here.
- `server/` — Nitro API (firmware catalog from GitHub Releases or MinIO,
  sponsors, admin).

Nuxt consumes `am32-core` straight from TypeScript source via an `alias` +
`build.transpile` in `nuxt.config.ts`. There is no build step for the core.
`am32-node`, `am32-sim` and `am32-cli` are deliberately **not** aliased and
nothing in the app imports them — `serialport` would not survive a browser bundle
and the simulator must never reach one. The CLI is the one thing with a build
step, because it is published and shipped as binaries.

## Git

- Two remotes. **`ark` is ours** (`ARK-Electronics/ark32-configurator`).
  **`origin` is upstream** (`am32-firmware/am32-configurator`). Push and open
  PRs against `ark` only — `gh` has no default repo set, so always pass
  `--repo ARK-Electronics/ark32-configurator`.
- Default branch: **`ark-release`**. Branch from it and open PRs against it.
  Nothing gets pushed until `yarn verify` passes.

## Gotchas

- `yarn lint` has a dozen-odd `no-console` warnings on purpose (protocol and
  server logging). It is green at 0 **errors** — keep it there. New code in
  `packages/` should not add console calls; only the 0-errors part is a gate.
- `prisma/generated/` is generated and eslint-ignored. Never hand-edit it.
- The audit line references in issue #3 were written against commit `4094dad`.
  Re-verify them before trusting them; the overhaul moved most of that code.

## Firmware sources (local, for verifying protocol claims)

- AM32: `~/code/ark/AM32` (branch `ark-release`) — `Inc/eeprom.h` is the
  authority on the 192-byte `EEprom_t`.
- AM32 bootloader: `~/code/ark/AM32-bootloader`
- ArduPilot: `~/code/jake/ardupilot` — `libraries/AP_BLHeli/AP_BLHeli.cpp`,
  `libraries/GCS_MAVLink/GCS_Common.cpp`
- Betaflight: `~/code/ark/betaflight` — `src/main/io/serial_4way.c`,
  `src/main/io/serial_4way_avrootloader.c`, `src/main/msp/msp.c`

Read these with a subagent rather than in the main context — they are large and
you only need the answer.
