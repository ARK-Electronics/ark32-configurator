# Block 4 — Session API

Landed on `master` on top of `218f798`:

| Commit | What |
|---|---|
| `6883f2b` | `feat(core): add Am32Session, FC quirks and the MSP/4-way session layers` |
| `c3b1f9d` | `fix(sim): model the ESC teardown on ArduPilot's MSP escape from passthrough` |
| `ed6918d` | `test(session): prove block 4's done-when against the simulated FC and ESCs` |
| `001ec13` | `docs(testing): add docs/TESTING.md with the two hardware checkpoints` |
| `cc41968` | `fix(session): unstrand the FC when MSP_SET_PASSTHROUGH fails` |
| `a83d360` | `fix(session): serialise session operations and check the 4-way command echo` — the diff review's three findings |
| `55bd221` | `test(session): pin the escCount reset on exitPassthrough` |
| (this file) | the handoff note |

Nothing outside `packages/` and `docs/` changed. `components/`, `pages/`,
`stores/` and `src/communication/` are untouched — the UI is block 5.

## Verification

```
yarn verify                          → exit 0  (lint 0 errors / 19 warnings, typecheck:core + typecheck:app clean, 278 tests in 15 files)
done-when (STATUS.json block 4)      → exit 0
  test -f packages/am32-core/src/session.ts &&
  ls packages/am32-core/src/**/session*.test.ts packages/am32-sim/src/**/*session*.test.ts
      packages/am32-core/src/fc/session-connect.test.ts
      packages/am32-sim/src/integration/session.test.ts
bash scripts/assert-core-hygiene.sh  → exit 0
bash scripts/assert-fault-coverage.sh→ exit 0  (mavlinkIdleGate and blockingFourWay now resolve to this block's suites)
bash scripts/assert-deleted.sh       → exit 0
yarn build                           → exit 0
./run.sh --no-browser                → dev server on :3067, GET /configurator 200, vue-tsc 0 errors
```

Test counts: 233 → **278**. The new files are
`packages/am32-core/src/fc/session-connect.test.ts` (18) and
`packages/am32-sim/src/integration/session.test.ts` (27). They cover ~40 s of
protocol time — a 4 s MAVLink window, a 2 s passthrough settle, ten-attempt
retry budgets — in ~60 ms of wall time.

Lint is unchanged at **19 warnings, 0 errors**. No new console calls.

The dev-server check is block 2's standing advice and it still matters: `yarn
verify` cannot see a broken Vite alias. All seven new core modules resolve and
transform in the browser graph (`/_nuxt/packages/am32-core/src/session.ts` and
friends, 200 each, `Am32Session` present in the transformed output), and
`grep -rl am32-sim .output/public` after a build is **0** — the simulator stays
out of the client bundle, as it must.

### The three done-when tests, by name

| Requirement | Test |
|---|---|
| a simulated 4-ESC ArduPilot connect enumerates all four | `block 4 done-when: a simulated 4-ESC ArduPilot enumerates all four > connects, enters passthrough and reads every channel` |
| the same run with `esc[3].unresponsive` returns three good results and one error without throwing | `fault knob: esc[n].unresponsive -- a partial enumerate degrades (audit B) > returns three good results and one error without throwing` |
| a Betaflight connect completes without paying the 4 s idle wait, on the virtual clock | `block 4 done-when: a Betaflight connect skips the ArduPilot idle wait (audit H) > completes in a fraction of the 4 s window, measured on the virtual clock` |

## Mutate before you believe

Block 3's rule, applied to every guard this block adds. Each row is the
implementation broken on purpose and the suite re-run; each one goes red.

| Mutation | Result |
|---|---|
| `connect()` never probes first, always waits the window | 2 failed |
| `connect()` never enters the idle window | 7 failed |
| `enumerate()` lets a per-target failure propagate (audit **B**) | 4 failed |
| the read length check is dropped, trusting the ACK | 1 failed |
| the MSP-in-passthrough guard is dropped from `connect()` | 1 failed |
| `SimFc`'s `$` escape leaves the ESCs connected (undo the sim fix) | 1 failed |
| `enterPassthrough()` shrugs at a zero-ESC reply | 2 failed |
| `causedBySessionError()` stops unwrapping the `LinkError` | 1 failed |
| the unknown-signature guard is dropped from `readEsc()` | 1 failed |
| no exit after a failed `MSP_SET_PASSTHROUGH` | 1 failed |
| `exclusive()` runs its work immediately — no session mutex | 2 failed |
| the 4-way command-echo check is dropped | 1 failed |
| `readEsc` failures lose their channel prefix again | 2 failed |
| `exitPassthrough` keeps the stale `escCount` | **0 failed → test added, then 1 failed** |

⚠️ **A mutation experiment ate an uncommitted change of mine.** The revert step
is `git checkout -- <file>`, which restores from `HEAD`, so a hardening edit made
after the last commit vanished silently and the mutation "passed" for the wrong
reason. **Commit before you mutate.** I caught it because the grep afterwards did
not match; a less lucky version of this ends with the fix missing from the block.

The last row is the process working: the `escCount` reset shipped with no test,
the mutation stayed green, and the choice was then a test or a deletion. It got a
test.

Two guards did *not* survive scrutiny and were removed rather than left in:

- **`expectParams: 4` on `cmd_DeviceInitFlash`.** Unreachable: both firmwares
  report a failed connect with a non-OK ACK (AP:1081-1083, BF:636-643), which the
  ACK check already catches, and neither can answer `ACK_OK` with a short device
  info. Exactly block 3's "a check that looks load-bearing and never runs".
- What replaced it is reachable and does fire: **`readEsc` rejects a device
  signature no MCU variant knows**, with a test using a new `SimEsc`
  `reportedSignature` option. See below.

## What the diff review changed

A subagent reviewed the diff against block 4's done-when in a fresh context. It
confirmed scope, the three done-when items, the no-time-below-the-session-layer
rule and the firmware citations, and found **three real gaps**. All three are
fixed in `a83d360` and pinned by the last four mutation rows above.

1. **No session-level serialisation, and it corrupts data rather than merely
   racing.** `Link` serialises one *exchange*; nothing serialised a *sequence* of
   them. A 4-way `cmd_DeviceRead` acts on whichever channel the last
   `cmd_DeviceInitFlash` selected, so two overlapping `enumerate()` calls
   interleave into the link's single FIFO and steal each other's channel
   selection. The reviewer reproduced it — one run came back with **ESC #0's
   EEPROM image filed under target 1, `ok: true`, no error and no warning**.
   Block 6's `writeSettings` builds its outgoing buffer from `settingsBuffer`, so
   the same race writes one ESC's settings into another: the same class of
   failure audit **A** was about, arriving by a different road.

   Every public method's guard was a synchronous check *before* its first
   `await`, and `setState` only ran *after* one resolved — so under concurrency
   all of them were decorative. Two clicks on block 5's Read button is enough.
   Fixed with the same promise-chain tail `Link` uses one layer down. **Public
   methods take the lock; the `*Impl` methods they delegate to do not**, which is
   what lets `enumerate` call `enterPassthroughImpl` without deadlocking on a
   lock it already holds. Do not "simplify" that split away.

2. **A 4-way reply was not checked against the command it answers**, though block
   1b added exactly that check for MSP (audit **D**: "whatever frame arrives is
   returned as the answer to whatever was just sent"). A reply left over from an
   exchange that gave up, landing after the next drain's quiet window, satisfies
   the next probe — so a stale `ACK_OK` `cmd_DeviceRead` frame is accepted as
   `cmd_DeviceInitFlash`'s device info and `createMcuInfo` builds an MCU
   signature out of EEPROM bytes.

   The reviewer was honest that they could not construct the failure against the
   simulator with `slowMs` — the drain caught every stale reply. I could, with
   `link.injectGarbage` carrying a complete CRC-valid frame for a *different*
   command, which is exactly the shape a leftover reply has. The test asserts
   recovery, not just rejection: the attempt is rejected, the link drains, the
   retry gets the real answer. **The address is deliberately not checked** —
   ArduPilot forces `cmd_DevicePageErase`'s echoed address to `0x0000` (AP:1122)
   where Betaflight echoes the computed one (BF:675-680), so an address check
   would be wrong on one firmware or the other.

3. **Three smaller ones**, all real: `EscResult.error` lost the channel for
   anything that was not an init-flash failure (a read failure read
   `cmd_DeviceRead failed: no complete response within 500ms` with nothing saying
   which ESC); `exitPassthrough` left `escCount` reporting channels nobody could
   address, against the getter's own doc; and `SessionEmitter.clear`'s comment
   claimed `disconnect()` called it, which it does not and *should not* — doing so
   would swallow the final `state` event.

The reviewer also independently confirmed the `MSP_SET_PASSTHROUGH` stranding I
had found and fixed in `cc41968` while it was still working, which is a decent
sign the two passes were looking at the same thing from different ends.

## What I built

**`packages/am32-core/src/session.ts` — `Am32Session`.** The one public API.
`connect`, `enterPassthrough`, `exitPassthrough`, `enumerate`, `readEsc`,
`readSettings`, `reset`, `disconnect`, `on`. It owns its own `Link`; callers hand
it a `Transport` and a `Clock` and nothing else.

**`packages/am32-core/src/fc/msp-session.ts` — `MspSession`.** Identify the FC,
read the facts that matter, get into passthrough. This is where audit **H** dies.

**`packages/am32-core/src/fc/quirks.ts`.** The plan's FC quirks table as data:
`ARDUPILOT_QUIRKS`, `BETAFLIGHT_QUIRKS`, `GENERIC_QUIRKS`, resolved from the
`MSP_FC_VARIANT` string. Every field carries its firmware citation.

**`packages/am32-core/src/esc/fourway-session.ts` — `FourWaySession`.** Every 4-way
exchange, with the ACK check *and* the length check in `validate`.

**`packages/am32-core/src/events.ts`** — the typed emitter (`log`, `progress`,
`esc`, `state`) block 5 mirrors into the pinia stores and block 7's `-v` prints.
**`errors.ts`** — `SessionError` with a closed set of reasons. **`text.ts`** —
`decodeBytes` / `decodeBytesZ`, because `TextDecoder` does not exist in the core.

**`docs/TESTING.md`** — the file the plan's section 8 references and no block had
created. Blocks 2 and 3 both nominated block 4. It carries both hardware
checkpoints and the accumulated watch-list from every block since anything last
ran on real silicon.

### How connect() actually works

1. **Probe `MSP_API_VERSION` once, immediately.** Betaflight answers the first
   well-formed frame on a fresh port with no warm-up at all (there is no
   time-based gate anywhere in `msp_serial.c`), and so does an ArduPilot whose
   window is already open. This is the whole Betaflight fast path.
2. **On failure, send one `cmd_InterfaceExit` and probe again.** A session that
   died in passthrough leaves the FC in `esc4wayProcess`, where MSP is discarded
   unanswered until that command. Cheaper than concluding "no FC".
3. **On failure again, poll `MSP_API_VERSION` every 250 ms for up to 8 s.**

Step 3 is sound rather than optimistic, and this is the fact the whole block
turns on: **ArduPilot's window is re-armed only by a valid MAVLink frame.**
`alternative.last_mavlink_ms = now_ms` appears in exactly one place,
`GCS_Common.cpp:1977`, reached only on `MAVLINK_FRAMING_OK` at `:1974`. An MSP
probe is not MAVLink, so it can never push the handoff back — the failed probes
cost their own timeouts and nothing else.

Measured on the simulator: ArduPilot with the gate armed at 4000 ms connects at
~4.8 s; Betaflight connects in ~10 ms. The app's fixed 4.5 s wait plus five
retries could reach ~10.7 s before it gave up, so the new 8 s budget is a
reduction on both paths.

## Design decisions a later block could accidentally undo

0. **Every public method takes the session mutex; the `*Impl` methods it
   delegates to do not.** That split is the only thing preventing a deadlock
   (`enumerate` calls `enterPassthroughImpl`, which would otherwise wait on a
   lock its own caller holds) and the only thing making every synchronous guard
   in the class mean anything. If a later block adds a public method, it goes
   through `exclusive()`; if it adds an internal step, it calls an `*Impl`. See
   the review section above for what the absence of this cost.

1. **MSP is refused while in passthrough — do not "relax" this.** The plan's
   quirks table says ArduPilot multiplexes MSP and 4-way. **It does not.**
   `AP_BLHeli.cpp:1242-1246` is a *mode switch with a side effect*: a `$` seen
   between 4-way frames sets `escMode = PROTOCOL_NONE` and calls `serial_end()`,
   which tears down the soft-serial link and marks every ESC disconnected. So the
   MSP reply arrives, looks fine, and some *later* 4-way command is the one that
   fails. `Am32Session.connect()` throws `SessionError('passthrough')` rather than
   letting a caller trigger that, and `SimFc` now models the teardown so the trap
   is reproducible (`c3b1f9d`). If block 5 or 7 wants an MSP read mid-flash, the
   answer is `exitPassthrough()` first, not a relaxed guard.

2. **A read is validated on length, not on the ACK.** `FourWaySession`'s
   `expectParams` is what closes the hazard blocks 1b and 2 both left open:
   ArduPilot answers a `cmd_DeviceRead` whose `CMD_SET_ADDRESS` handshake failed
   with **`ACK_OK` and one byte of uninitialised stack** (`BL_ReadA` returns false
   at AP:786 without touching `blheli.ack`; the reply buffer is a VLA nothing
   writes, AP:1098-1103). The rule: *asked for N > 1 and got fewer back, it is a
   failed read whatever the ACK says.* Because it lives in `link.request`'s
   `validate`, a short reply retries with a drain exactly like a timeout. Block 6
   should give its write-verify the same treatment rather than adding a loop.

3. **`causedBySessionError` exists because `Link` wraps `validate` rejections.**
   `Link.request` turns whatever `validate` throws into
   `LinkError('validate', …, { cause })`, so the precise reason — `esc-read` for a
   short reply as against `esc-command` for a refused ACK — is one or two levels
   down. Flattening it loses exactly the information the session exists to keep.
   The test asserting `reason: 'esc-read'` found this bug; without it the block
   would have shipped with every 4-way failure reported as `esc-command`.

4. **`enterPassthrough()` moves the state to `passthrough` *before* it looks at
   the count.** The FC is in the loop from the moment it sends the reply, whatever
   the count was. Setting the state after an early return would skip the exit and
   leave the next MSP call hanging.

5. **A zero-ESC passthrough exits rather than sitting there.** Betaflight installs
   `esc4wayProcess` unconditionally — `msp.c:328-333` is not guarded by the count
   — so a host that shrugs at zero is trapped in a blocking loop with nothing to
   talk to. `enumerate()` then returns `[]` instead of throwing.

6. **A failed `MSP_SET_PASSTHROUGH` sends an exit before it throws** (`cc41968`).
   The FC enters passthrough when it *sends* the reply, so a reply we never see
   strands it. One exit frame costs nothing when it was never in passthrough:
   Betaflight's MSP parser discards a stray `/`, and ArduPilot enters 4-way on it
   and leaves again on the same frame.

7. **`retries` still means total attempts.** `FOUR_WAY_DEFAULT_RETRIES = 10` and
   `FOUR_WAY_INIT_RETRIES = 10` carry over from the app, and sit on top of the
   three bootloader-handshake retries both firmwares do internally.

8. **The two settle delays are carried over from the app deliberately, not
   invented.** `passthroughSettleMs` 2000 and `interEscDelayMs` 300 are numbers
   real hardware is known to work with, and no hardware checkpoint has run since
   block 0. They are constructor options and free under a virtual clock. The one
   thing I did drop is the app's extra `delay(500)` at the top of `connectToEsc`,
   on the grounds that the ten-attempt `initFlash` budget covers it — so the
   session is 500 ms faster to the first ESC than the app is. If a hardware
   checkpoint sees the first channel failing where later ones succeed, put it
   back.

9. **`writeSettings`, `applyDefaults` and `flash` are absent, not stubbed.** They
   are block 6, which owns read-back verification and page handling. A method that
   exists and does not verify is how audit **A** survived this long.

10. **`readEsc` does not write.** The app's `getInfo` wrote to the ESC when it saw
    `BOOT_LOADER_REVISION === 0xFF` — a read with a side effect, and one that never
    worked, because the bootloader force-overwrites byte 2 with its own version
    inside every EEPROM write (`main.c:517-525`). Block 6 removes it from the app;
    there was never a reason to reproduce it here.

11. **`am32-core` now exports an `EscResult`, and so does `am32-sim`.** They are
    different types — the core's is `{ target, ok, info?, error? }` from
    `enumerate()`, the simulator's is `{ ack, data, durationMs, returnedBytes }`
    from one bootloader operation. Structurally disjoint, so TypeScript separates
    them, but a file importing both should alias one. The plan names the core's
    type, so the plan's name won.

## Where the plan was wrong, stale, or impossible

- **"MSP during passthrough | ArduPilot: Yes, multiplexed" is wrong.** See design
  decision 1. It is a mode switch that disconnects every ESC. This is the single
  most consequential correction in the block and the simulator now reproduces it.

- **The plan's `Am32Session` sketch has `enumerate(): Promise<EscResult[]>` and
  the simulator already exports an unrelated `EscResult`.** Recorded above; not a
  problem, but worth knowing before a later block imports both.

- **`STATUS.json`'s done-when command needs the tests one directory deep.** It is
  `ls packages/am32-core/src/**/session*.test.ts …`, run through `bash -c`, and
  the driver does not `shopt -s globstar` — so `**` is just `*` and the glob
  requires *exactly one* intervening directory. `src/session.test.ts` would not
  have matched. Hence `src/fc/session-connect.test.ts` and
  `src/integration/session.test.ts`. If a later block moves either file, check the
  glob still resolves; `bash -c "$done_cmd"` is what the driver runs
  (`scripts/overhaul-loop.sh`).

- **The plan's `fc/quirks/{ardupilot,betaflight,generic}.ts` is one file here.**
  Three records of the same shape, ~170 lines including citations; splitting them
  across four files buys nothing and `am32-core`'s `"./*": "./src/*.ts"` export
  map does not resolve a directory index. Same call block 3 made for
  `am32-sim/src/profiles.ts`.

- **The plan's `flash()` / `writeSettings()` rows in the API sketch belong to
  block 6, and the plan says so in block 6's own text.** Block 4's done-when
  mentions neither. I built the read half only.

- **`MSP_MOTOR_CONFIG` byte 6 is the motor count on both firmwares, but it is not
  the number `enumerate()` loops over.** The channel count comes from the
  `MSP_SET_PASSTHROUGH` reply: `num_motors` on ArduPilot (AP:581,597) and
  `esc4wayInit()`'s return on Betaflight (`msp.c:328`). Those can differ — the
  Betaflight number counts *configured motor outputs* and probes nothing
  (`serial_4way.c:143-154`). `FcInfo.motorCount` carries byte 6 for display;
  `session.escCount` carries the passthrough reply, and that is the loop bound.

## Plan line references that had drifted

Re-verified against `218f798`, this block's base. Block 4 changes no app file, so
none of these were load-bearing for the work — they are recorded so block 5 does
not have to re-derive them.

| Audit | Plan said (`4094dad`) | At `218f798` |
|---|---|---|
| **B** enumerate loop | `SerialDevice.vue:731-745` | `:637` (`for (let i = 0; i < escStore.expectedCount; ++i)`) |
| **B** empty-settings deref | `:760-763` | `:667` (`escStore.escData.filter(`) |
| **B** 2.19 `TIMING_ADVANCE` deref | `:778-779` | `:685` (`for (const esc of escStore.escData)`) |
| **H** 4.5 s ArduPilot wait | `:611-617` | `:545-551` |
| **H** big-endian `MSP_MOTOR` read | `commands.queue.ts:107` | `:109` (was `:108` at block 1a — the file still has not been touched, so the audit was simply off, and block 1a's correction has itself drifted) |
| **C** `writeHex` call site | `:1047` | `:840`, no timeout argument (block 2) |
| **G** `startFlash` no try/catch | `:1044-1076` | `:833` |

`components/SerialDevice.vue` is 945 lines, down from 1161 at `4094dad`.

### Firmware facts this block established, so nobody re-derives them

Read with subagents against the current trees. The ones that changed a decision:

- **ArduPilot's idle gate is per-byte, not a latch** (`GCS_Common.cpp:1940-1965`).
  Bytes arriving while the window is shut are `_port->read()`-ed at `:1943` and
  handed to the MAVLink parser at `:1970`; nothing is buffered for the alternative
  handler. `last_mavlink_ms` starts at 0, so the handoff arms itself 4 s after
  boot with no MAVLink. There is a second, stronger latch once BLHeli is active:
  `AP_BLHeli.cpp:1261,1271` locks the UART and `update_receive` returns
  immediately at `GCS_Common.cpp:1928-1930`.
- **ArduPilot's `MSP_SET_PASSTHROUGH` failure reply is a zero-length frame whose
  command field is `0x0F`** (`AP_BLHeli.cpp:594`; `msp_send_ack(cmd)` is
  `msp_send_reply(cmd, 0, 0)` at `:309-312`). Wire bytes `$ M > 00 0F 0F`. Only
  block 1b's command-echo check catches it. It fails when
  `hal.rcout->serial_setup_output(...)` returns false at `:593`.
- **ArduPilot's bare-`/` entry into 4-way requires `msp.state == MSP_IDLE` and a
  disarmed vehicle** (`AP_BLHeli.cpp:1247-1251`, `:1290-1293`), and skips
  `serial_setup_output` — which is why the firmware's own comment at `:590-591`
  says doing it through `MSP_SET_PASSTHROUGH` is more reliable. The session always
  uses `MSP_SET_PASSTHROUGH`.
- **Betaflight has no time-based gate on MSP anywhere.** `grep -ci mavlink` over
  `msp.c`, `msp_serial.c` and `serial_4way.c` is 0. The two timers in
  `msp_serial.c` (`:448`, `:632`) are a CLI/bootloader guard and a beeper-muting
  query. A fresh USB port is answered on the first well-formed frame.
- **`esc4wayRelease` re-enables the motors and returns straight to the MSP parser**
  (`serial_4way.c:158-166`, reached from `:923-926`). No reboot, no delay — MSP is
  served on the very next `mspSerialProcess`. So no settle is needed after an exit,
  and the test that re-enters passthrough immediately after exiting is not lucky.
- **`MSP_SET_PASSTHROUGH` takes either no payload or `[mode, argument]`**, and an
  empty payload means 4-way on both (`msp.c:301-303`, `AP_BLHeli.cpp:574-575`).
  The session sends the empty form, which is what the app has always sent.
- **ArduPilot does implement `MSP_BATTERY_STATE`** (`AP_BLHeli.cpp:478`), so the
  best-effort battery read in `connect()` is not a wasted timeout on either FC.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** This is block 4's
  own checkpoint and it is now the accumulated one for blocks 1a, 1b, 2, 3 and 4.
  It is written up properly in `docs/TESTING.md` under "Checkpoint 1", with the
  full watch-list. The two highest-value things it can find:
  - **ArduPilot failing to connect where it used to.** The 4.5 s blind wait is
    gone; the connect now probes, escapes 4-way, then polls for up to 8 s. If a
    real board needs longer, `idleWindowMs` is a constructor option — raise that,
    do not reinstate a fixed wait.
  - **The 4-way read timeout at 769 ms** (block 2 dropped it from 1500 ms). Still
    the one number in the overhaul that moved down.
- **The session is not wired into the app.** `components/SerialDevice.vue` still
  has audit **B**'s crash, **H**'s 4.5 s wait, **C**'s caller side and **G**'s
  flash-modal wedge, all untouched by design. Block 5 replaces them by *using*
  this API — the fixes exist but nothing in the app calls them yet.
- **The session mutex serialises `disconnect()` too.** Clicking disconnect during
  an enumerate makes it wait for that enumerate to finish rather than aborting
  it. Bounded by the enumerate's own timeouts (worst case tens of seconds with
  four dead ESCs), and no worse than the app today, which queues its exit behind
  the same `Link`. The right fix is an abort/cancellation mechanism, which the
  `Transport`/`Link` stack does not have and which is a deliberate design decision
  rather than something to bolt on. If block 5's UI needs a responsive
  disconnect, that is the conversation to have — not an unsynchronised
  `disconnect()`.
- **`Transport` still has no error channel.** Block 2 flagged it, block 3
  inherited it, and I did not change it. An unplug mid-exchange still waits out
  the full timeout before the *next* attempt rejects with `closed`. The session
  makes this slightly more visible (a `disconnect()` during an enumerate leaves
  the in-flight attempt to expire) but not worse. Changing the interface affects
  `am32-web` and `am32-sim` together and is a deliberate decision someone should
  make rather than a bug to fix in passing.
- **A lost `MSP_SET_PASSTHROUGH` reply is recovered, a lost `cmd_InterfaceExit`
  reply is not observable.** `exitPassthrough()` is fire-and-forget by design
  (both firmwares ACK and *then* tear down, so waiting buys nothing), which means
  the session can believe it left passthrough when the FC did not. The recovery is
  the next `connect()`, which escapes 4-way before giving up — tested. There is no
  cheaper check: `cmd_InterfaceTestAlive` would itself be a 4-way frame.
- **Nothing enforces `noUncheckedIndexedAccess` on `am32-sim`.** Still block 3's
  open item; `am32-web` has the same hole. The core's new files are covered
  because they are inside `am32-core`.
- **`FIRMWARE_START` may be wrong for ARK's firmware** (block 3's warning, still
  live and still block 6's problem): the simulator uses `0x1000`, AM32's
  `FIRMWARE_RELATIVE_START`, but that constant is `0x4000` on a `DRONECAN_SUPPORT`
  build. Check the ARK AM32 build before block 6's flash tests are trusted.
- **`docs/plans/overhaul/STATUS.json` carries the driver's own `in-progress`
  edit**, committed with this note because the block must leave no uncommitted
  changes. I did not author that line.

## Three things I would tell the next agent

1. **The API's job is to make the firmware's rules unreachable, not to document
   them.** Every guard in `session.ts` exists because a caller could otherwise do
   something that looks fine and fails somewhere else: MSP in passthrough (which
   *succeeds* on ArduPilot and disconnects every ESC), a read whose `ACK_OK` is a
   lie, a zero-ESC passthrough you can only leave by asking. Block 5's job is to
   delete `SerialDevice.vue`'s protocol code and *call this*, not to reimplement
   the same care in Vue. If you find yourself writing `if (variant === ...)` in a
   component, the quirk belongs in `fc/quirks.ts`.

2. **Commit before you mutate, mutate before you believe, and get the diff
   reviewed anyway.** Fourteen mutations here. Thirteen went red; the fourteenth
   did not, which is how the `escCount` reset got the test it was missing. Three
   of them found things I had just written — an unreachable `expectParams` guard,
   a reason field the link's error wrapping was flattening, and that missing test.
   One revert silently ate an uncommitted fix of mine, because `git checkout --`
   restores from `HEAD`. And none of it caught the biggest bug in the block: the
   missing session mutex, which the fresh-context review found and *reproduced*
   — one ESC's EEPROM image returned as another's, `ok: true`. Mutation testing
   proves the guards you wrote work. It cannot tell you about the guard you never
   thought of.

3. **`session.escCount` and `fc.motorCount` are different numbers and mixing them
   up is a real bug.** The loop bound is the `MSP_SET_PASSTHROUGH` reply — how many
   channels the FC will let you address. `MSP_MOTOR_CONFIG` byte 6 is the
   authoritative *motor* count for display. On Betaflight the first counts
   configured outputs and probes nothing; on ArduPilot both come from
   `num_motors`, which is exactly why an ArduPilot-only test would not catch the
   confusion.
