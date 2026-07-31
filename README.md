# ARK32 Configurator

Web UI and headless CLI for configuring and flashing [ARK32](https://github.com/ARK-Electronics/ARK32) ESCs through a flight controller's USB serial port (MSP + BLHeli 4-way passthrough). ARK's fork of the [AM32 configurator](https://github.com/am32-firmware/am32-configurator).

## Run locally

```bash
git clone git@github.com:ARK-Electronics/ark32-configurator.git
cd ark32-configurator
./run.sh          # web UI at http://localhost:3067 (Chrome/Edge; Web Serial)
./install-cli.sh  # put `ark32` on PATH (~/.local/bin)
```

`./run.sh` installs deps if needed (Node 22, Yarn 4 via corepack), starts the dev server, and opens a browser. No database, Redis or MinIO needed — the firmware catalog falls back to GitHub Releases.

`./install-cli.sh` builds the headless CLI (required — it is an esbuild bundle) and symlinks it to `~/.local/bin/ark32`. Re-run after pulling, or just `yarn build:cli` to refresh the bundle the symlink already points at.

## What's different from upstream

The fork was rebuilt around a single protocol core in July 2026 — issue #3 has the audit and design rationale.

- **One protocol stack.** All MSP, 4-way and EEPROM code lives in `packages/am32-core`, a transport-agnostic TypeScript package (no DOM, no Node). The web app and the CLI are thin clients of the same `Am32Session` API.
- **`ark32`, a headless CLI.** Every configurator operation — enumerate, read/write settings, get/set fields, flash, apply defaults, reset — scriptable over node-serialport. `--sim` runs any command against a simulated rig with no hardware.
- **A simulated FC and ESCs.** `packages/am32-sim` models ArduPilot and Betaflight passthrough plus AM32 ESCs, with fault injection, behind the same transport interface as real hardware; ~480 tests run against it on a virtual clock.
- **Verified writes.** Every settings write and flash chunk is read back and compared, and the ESC's CAN block (EEPROM bytes 176–183) survives every save — upstream's save path could corrupt it.
- **Correct FC handling.** Connect probes instead of unconditionally sitting out ArduPilot's 4 s MAVLink window, an unresponsive ESC degrades an enumerate instead of crashing it, and flash timeouts match the FC's real budgets.
- **ARK32 firmware catalog.** Release listings come from `ARK-Electronics/ARK32` GitHub Releases (MinIO-backed hosting optional).
- **Removed:** bootloader flashing and USB-direct mode.

## The `ark32` CLI

```bash
./install-cli.sh                                  # build + symlink onto PATH
ark32 ports
ark32 -p /dev/ttyACM0 enumerate
ark32 -p /dev/ttyACM0 read --esc all -o backup/
ark32 -p /dev/ttyACM0 set --esc 1 TIMING_ADVANCE=16
ark32 --sim --fc betaflight --escs 2 -v info      # no hardware needed
```

The CLI **does** need a build step (`yarn build:cli` / `./install-cli.sh`): `am32-core`, `am32-node` and `am32-sim` are inlined into one file; only the native `serialport` module stays external and is loaded from this checkout's `node_modules`. The web app has no equivalent build for the protocol stack — Nuxt consumes the TypeScript source directly.

Exit codes: 0 success, 1 partial, 2 connect failure, 3 bad arguments. `--json` puts exactly one JSON object on stdout. Release builds produce standalone binaries for Linux, macOS and Windows plus an npm package (`@ark/am32-cli`).

## Development

`yarn verify` (lint + typecheck + tests) is the gate CI runs on every push and PR; `bash scripts/assert-cli-sim.sh` smoke-tests the built CLI against the simulator. `docs/TESTING.md` covers the test layers, the fault-injection knobs and the hardware checkpoint procedures.

Layout: `packages/am32-core` (protocol), `packages/am32-{web,node,sim}` (the three transports: Web Serial, serialport, simulator), `packages/am32-cli` (the binary), plus the Nuxt app (`components/`, `pages/`, `stores/`) and its Nitro API (`server/`).
