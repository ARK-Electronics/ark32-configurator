# Testing the ARK32 configurator

Three layers, in increasing order of cost and decreasing order of how often they
run.

| Layer | Command | Runs on |
|---|---|---|
| Unit + property | `yarn test` | every push, every block |
| Integration against the simulator | `yarn test` (same suite) | every push, every block |
| Hardware checkpoints | by hand, with a board plugged in | twice in the whole overhaul |

`yarn verify` — `lint && typecheck:core && typecheck:app && test` — is the gate.
It must exit 0 before any overhaul block is called done, and CI runs it on push
and PR.

## Unit and property tests

Framing golden vectors, the EEPROM round-trip property test, the hex parser, the
timeout policy table, the clock. They live beside the code as `*.test.ts` under
`packages/`.

The one that carries the most weight is
`packages/am32-core/src/eeprom/codec.prop.test.ts`: fast-check over random
192-byte images, asserting decode → encode is byte-identical and that bytes
13–16 and 176–183 survive untouched. That is audit item **A** pinned as a
property rather than as an example.

## Integration tests against `am32-sim`

`packages/am32-sim` is a stateful simulator of a flight controller and its ESCs
behind the same `Transport` interface as the real ones. It is a peer of
`am32-web`, not a test-only mock — issue #3 section 7.3 — so anything the
session layer needs that a transport cannot provide shows up immediately as a
hole in it rather than as a workaround above it.

Its fidelity comes from the firmware sources, all checked out locally and listed
in `CLAUDE.md`. Read them with a subagent; they are large and you need one answer
from each.

**Everything runs on a virtual clock.** `packages/am32-core/src/clock.ts`
provides `VirtualClock`, and nothing below the session layer may call `Date.now()`
or `setTimeout` — `scripts/assert-core-hygiene.sh` fails the build if it does.
The payoff is direct: the session suite covers tens of seconds of protocol time,
including ArduPilot's 4 s MAVLink window and a 2 s passthrough settle, in tens of
milliseconds of wall time. A slow test therefore means a hang, not a slow
machine.

Tests advance the clock explicitly rather than waiting:

```ts
const promise = session.connect();
await clock.runAll();            // or the `drive()` helper in the session tests
const fc = await promise;
```

### Fault injection

Every knob maps to a bug the audit in issue #3 found, so the fixes stay fixed.
`scripts/assert-fault-coverage.sh` requires each one to be implemented in
`packages/am32-sim` *and* named by a `describe('fault knob: …')` suite.

| Knob | Regression it guards |
|---|---|
| `esc[n].unresponsive` | a partial enumerate must degrade, not throw (**B**) |
| `esc[n].slowBy(ms)` | the timeout policy must cover the FC's real budget (**C**) |
| `esc[n].corruptCrc`, `esc[n].shortRead` | retry and drain must recover without poisoning the next ESC |
| `fc.mspError(cmd)` | an MSP `!` frame must not parse as success (**D**) |
| `fc.mavlinkIdleGate` | the ArduPilot connect must probe-then-wait, not wait unconditionally (**H**) |
| `fc.blockingFourWay` | Betaflight passthrough must not expect MSP (**H**) |
| `link.dropBytes`, `link.injectGarbage` | framing must resynchronise; drain must clear stale RX (**E**, **G**) |
| `esc[n].canBlock = [...]` | a settings round-trip must preserve bytes 176–183 exactly (**A**) |

The gate is a *presence* check. What proves a knob works is mutating its
implementation and watching a specific test go red — see the mutation tables in
`docs/plans/overhaul/notes/block-3.md` and `block-4.md`. Do that before believing
a new guard; block 3 found one that was unreachable and block 4 removed another
for the same reason.

## Hardware checkpoints

The simulator has never been checked against real silicon, and that is by design
(issue #3 section 7.5): fidelity comes from the firmware sources, and divergence
is caught here, at two fixed points. Neither is optional — the UI is rewritten
wholesale in block 5 and nothing else in the plan touches real hardware.

Record what you saw, in this file, under the checkpoint.

## What is *not* covered by `yarn verify`

`vitest.config.ts` collects `packages/**` only, so **nothing under `components/`,
`pages/`, `stores/` or `composables/` has an automated test**. The app layer is
covered by `vue-tsc` (types and template references), `yarn lint`, `yarn build`
and reading it — and that is all. Block 5 rewrote that whole layer, so the
hardware checkpoint below is the first thing that has ever executed it.

Two consequences worth planning around:

- A behaviour that matters must live in `am32-core`, where it can be tested
  against the simulator. That is the reason `session.flash()` owns the boot-byte
  bracket, the page range and the MCU-layout check rather than the Vue component:
  the component half of a rule is a rule nothing checks.
- Adding a component test environment (jsdom + `@nuxt/test-utils`) is a harness
  decision nobody has taken. Blocks 1a, 2 and 5 have each declined to take it
  unilaterally. If the UI grows logic worth testing, that is the conversation.

### Checkpoint 1 — after block 4: connect and enumerate

**Status: outstanding.** Blocks 1a, 1b, 2, 3, 4 and 5 have all landed without it.

Rig: an ARK FPV with 4 ESCs, and separately a Betaflight board. Close Mission
Planner and QGroundControl first — they hold the MAVLink port.

1. Connect to the ArduPilot board. Confirm it enumerates all four ESCs.
2. Connect to the Betaflight board. Confirm it enumerates.
3. Pull the signal wire on one channel and enumerate again: the other three must
   still come back, and the UI must show one error rather than dying.

What to watch for, accumulated from the notes of every block since the last time
anything ran on hardware:

- **The 4-way read timeout dropped from 1500 ms to 769 ms** (192-byte settings
  read, generic variant) in block 2. That is the one number in the whole overhaul
  that moved *down*, and PR #1's 1500 ms was a guess rather than a measurement.
  If reads start timing out, raise `HOST_MARGIN_MS` in
  `packages/am32-core/src/link/timeout-policy.ts` or construct the policy with
  `{ scale: 2 }` — do **not** add a literal at a call site.
- **The flash page write went from 200 ms to ~1000 ms** (block 2, audit **C**).
  Flashing should be more reliable, and roughly 12 s faster from the drain change
  alone.
- **The settings read is 192 bytes, not 184** (block 1b). Still inside the
  firmware's 256-param limit and inside the EEPROM page on every variant.
- **Version gating went from disabled to enabled** (block 1b). On ARK hardware
  this changes nothing — `ark-release` writes `eeprom_version = 3` — but on a
  layout-revision-2 ESC the eight fields at 0x05–0x0C now render blank instead of
  showing bytes that meant something else.
- **Native timers instead of the Web Worker "HackTimer"** the deleted Web Serial
  wrapper installed (block 2). Chrome clamps `setTimeout` to ≥1 s in a
  backgrounded tab. Protocol timeouts firing late are safe; what gets slower is
  deliberate pacing. Keep the tab foregrounded while flashing.
- **The connect no longer waits 4.5 s before its first MSP frame** (block 4,
  audit **H**). It probes immediately, tries a 4-way escape, and only then polls
  through the MAVLink window for up to 8 s. On ArduPilot the connect should land
  a little after the window opens; on Betaflight it should be effectively
  instant. If ArduPilot now fails to connect where it used to succeed, that is
  the highest-value thing this checkpoint can find.
- **Connect no longer enters passthrough** (block 5). It identifies the FC and
  stops; passthrough happens on the first Read, Save or Flash. So "Connect" is
  now fast and quiet, and the ESC cards stay empty until Read is pressed — that
  is deliberate, not a regression.
- **Every button is one session call** (block 5). The UI holds no protocol code
  at all, so a failure that used to be a silent `console.error` now shows as a
  toast plus a log line. If something fails, the log panel should say which ESC
  and why; if it does not, that is a finding worth writing down.
- **A settings write re-reads the ESC first** (block 5). `writeSettings` builds
  its 192 bytes from a fresh read rather than from the buffer the UI is holding,
  so a save costs one extra read per ESC and cannot revert a byte another client
  moved. Still unverified after the write — block 6 adds that.

### Checkpoint 2 — after block 6: settings round-trip and flash

**Status: outstanding** (block 6 has not run).

Rig: an ARK FPV with 4 ESCs and a populated CAN block.

1. Read settings. Change one field. Write. **Power-cycle the ESC.** Read back.
   Bytes 176–183 must be unchanged and the edited field must have stuck. That is
   audit item **A** closed on real hardware.
2. Flash a local `.hex`. Confirm it completes and the ESC boots.

Block 5 moved the write and the flash into `Am32Session`, so both are live as of
that block even though block 6 owns their verification. Two extra things to watch
while doing step 2:

- **The flash stops at the EEPROM page**, not at the end of flash. The
  application region is 0x1000–0x7C00 on the F051 and its last 32 bytes are the
  firmware-name block the configurator identifies the ESC by
  (`AM32/Mcu/f051/STM32F051K6TX_FLASH.ld:43-46`). After a flash, the ESC's
  reported firmware name must be the *new* one.
- **The boot byte is cleared before the first page and set after the last.** Pull
  USB half way through a flash on purpose: the ESC must come back up in its
  bootloader (`EscView` shows "Flash was unsuccessful"), not run a half-written
  image. The bootloader jumps only on `0x01` or `0xFF`
  (`AM32-bootloader/bootloader/main.c:306-319`).

Known simulator/hardware divergence risks, in the order block 3 said to doubt
them:

1. The per-operation **durations** in `packages/am32-sim/src/esc.ts` are invented
   within the firmware's budgets rather than measured.
2. The bootloader-version stamp on EEPROM byte 2 assumes `BOOTLOADER_VERSION` is
   18; a different ARK build stamps a different number.
3. ~~`FIRMWARE_START` may be `0x4000` on a `DRONECAN_SUPPORT` build.~~ **Settled
   in block 5: `0x1000` is correct for ARK's shipped F051 firmware.** The
   bootloader Makefile only defines `DRONECAN_SUPPORT=1` for `_CAN`-suffixed
   targets (`AM32-bootloader/Makefile:105`), the app links its vector table at
   `0x08001000` (`STM32F051K6TX_FLASH.ld:43`) and the factory-image script uses a
   4 KiB bootloader region (`AM32/scripts/build_factory_image.py:31-33`). If ARK
   ever ships a `_CAN` target this comes back: `SimEsc`'s `FIRMWARE_START` and
   `Mcu.variants[...].firmware_start` would both need to be 0x4000 for it.

## Running the app locally

```
./run.sh                # dev server + browser; no MariaDB, MinIO or Redis needed
./run.sh --no-browser   # for a headless check
```

`yarn verify` green does **not** mean the app builds: `app.vue` has no
`lang="ts"`, so `vue-tsc` does not typecheck it, and a deleted module can leave a
dangling import there that only `yarn build` finds. Run `yarn build` before
claiming a deletion is complete.

`yarn verify` also cannot see a broken Vite alias. After any block that adds a
package or a module the app imports, start the dev server and fetch the module
through it:

```
curl -o /dev/null -w '%{http_code}\n' http://localhost:3067/_nuxt/packages/am32-core/src/session.ts
```

A 200 with the expected symbols in the transformed output means Vite resolved and
transformed it in the browser graph. `am32-sim` is deliberately **not** aliased
in `nuxt.config.ts` and nothing in the app imports it; confirm it stays out of
the client bundle with `grep -rl am32-sim .output/public` after a build.
