# ARK32 Configurator

Nuxt 3 web configurator for AM32 ESCs, talking to a flight controller over Web
Serial (MSP + BLHeli 4-way passthrough). ARK's fork of `am32-configurator`.

Under an active overhaul tracked in **issue #3** (shared protocol core + headless
CLI). Before touching anything under `packages/`, `src/communication/`,
`components/SerialDevice.vue` or the eeprom code, read
`docs/plans/overhaul/STATUS.json` and the block you are working from.

## Commands

- `./run.sh` — start the dev server and open a browser. Works with no MariaDB,
  MinIO or Redis running. Use this, not `yarn dev`.
- `yarn verify` — the gate. Runs `lint`, `typecheck` (core + app), `test`. Must
  exit 0 before any block is called done.
- `yarn test` / `yarn test:watch` — vitest over `packages/**`.
- `yarn typecheck:core` — the DOM/Node exclusion check (see below).
- Yarn 4 only. Never `npm install`. Node v20.20.2 (`.nvmrc`).

## Layout

- `packages/am32-core/` — transport-agnostic protocol code. No DOM, no Node, no
  Vue. Its `tsconfig.json` omits the `dom` lib and sets `types: []`, so
  `navigator`, `window`, `Buffer`, `process` and `fs` are **compile errors**
  here. That is deliberate: it is what forces protocol logic out of Vue
  components and keeps the web and CLI paths identical. If you want to add `dom`
  to that tsconfig, the code belongs in a transport package instead.
- `components/`, `pages/`, `stores/` — Nuxt app. These are becoming a thin
  client of the core; they must not reach below the session layer.
- `src/`, `utils/` — legacy protocol code being migrated into the core.
- `server/` — Nitro API (firmware catalog, sponsors, admin).

Nuxt consumes `am32-core` straight from TypeScript source via an `alias` +
`build.transpile` in `nuxt.config.ts`. There is no build step for the core.

## Git

- Two remotes. **`ark` is ours** (`ARK-Electronics/ark32-configurator`).
  **`origin` is upstream** (`am32-firmware/am32-configurator`). Push and open
  PRs against `ark` only — `gh` has no default repo set, so always pass
  `--repo ARK-Electronics/ark32-configurator`.
- Overhaul blocks commit and push straight to `master` — no PRs. Every block must
  leave `master` in a working state: `yarn verify` green and the app still
  connects. Nothing gets pushed until `yarn verify` passes.

## Gotchas

- `yarn lint` has 27 `no-console` warnings on purpose (protocol logging). It is
  green at 0 **errors** — keep it there. New code in `packages/` should not add
  console calls. The warning count drops as blocks delete legacy code; only the
  0-errors part is a gate.
- `prisma/generated/` is generated and eslint-ignored. Never hand-edit it.
- The audit line references in issue #3 were written against commit `4094dad`.
  Re-verify them before trusting them; earlier blocks move code.

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
