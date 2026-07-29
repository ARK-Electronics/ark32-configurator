# Block 3 — Simulated FC and ESCs

Landed on `master` on top of `b74b33f`:

| Commit | What |
|---|---|
| `70aaad5` | `feat(core): expose 4-way request parsing and response encoding` |
| `5454360` | `feat(sim): add am32-sim, a simulated flight controller and its ESCs` |
| `6f4b84c` | `test(sim): cover the rest of the 4-way command set` |
| `72bae8d` | `docs(plan): add the block 3 handoff note` |
| (see below) | `fix(sim): act on the diff review` -- three real bugs, three coverage gaps |

⚠️ **`6f4b84c`'s commit message is inaccurate.** It says it "drops an unreachable
guard in `handleMsp`"; that change actually landed in `5454360`, and `6f4b84c`
contains only tests plus the `pageErase` ACK clarification. The finding itself is
real and written up below. Nothing was pushed, so the message could have been
rewritten -- I left it and recorded the correction here instead, because a note
the next agent reads beats a rewritten history they will not.

## Verification

```
yarn verify                                → exit 0  (lint 0 errors / 19 warnings, typecheck:core + typecheck:app clean, 233 tests in 13 files)
done-when (STATUS.json block 3)            → exit 0
  bash scripts/assert-fault-coverage.sh
      ok  unresponsive     packages/am32-sim/src/fc.fourway.test.ts
      ok  slowBy           packages/am32-sim/src/fc.fourway.test.ts
      ok  corruptCrc       packages/am32-sim/src/fc.fourway.test.ts
      ok  shortRead        packages/am32-sim/src/fc.fourway.test.ts
      ok  mspError         packages/am32-sim/src/fc.msp.test.ts
      ok  mavlinkIdleGate  packages/am32-sim/src/fc.msp.test.ts
      ok  blockingFourWay  packages/am32-sim/src/fc.msp.test.ts
      ok  dropBytes        packages/am32-sim/src/transport.test.ts
      ok  injectGarbage    packages/am32-sim/src/transport.test.ts
      ok  canBlock         packages/am32-sim/src/esc.test.ts
bash scripts/assert-core-hygiene.sh        → exit 0  (block 2's gate, still green)
yarn install --immutable                   → exit 0  (CI's install step; the new workspace is in the lockfile)
./run.sh --no-browser                      → dev server up on :3067, GET /configurator 200, vue-tsc 0 errors
```

The dev-server check is block 2's advice about adding a package, and it still
matters: `yarn verify` cannot see a broken Vite alias. `am32-sim` deliberately
has no alias, so what I checked instead is that the *core* modules it made me
touch still resolve in the browser graph —
`/_nuxt/packages/am32-core/src/framing/fourway.ts`, `.../msp.ts`,
`/_nuxt/src/communication/four_way.ts` and
`/_nuxt/packages/am32-web/src/web-serial-transport.ts` all 200, with the new
`parseFourWayRequest` present in the transformed output.

New test counts: `fc.fourway.test.ts` 23, `fc.msp.test.ts` 19, `esc.test.ts` 12,
`transport.test.ts` 12 — 66 in `am32-sim`. Plus 6 in `framing/fourway.test.ts`
and 3 in `framing/msp.test.ts` for the core's new FC-side framing. The 66
simulator tests cover tens of seconds of protocol time and run in ~80 ms, which
is the payoff from block 2's clock. Three consecutive runs give identical
results; `am32-sim` contains no `Date.now()`, no `new Date()` and no
`Math.random()`, so there is nothing for it to be flaky about.

Lint is unchanged at **19 warnings, 0 errors** — `am32-sim` adds no console calls.

### The gate is a presence check; the tests are the behaviour check

`assert-fault-coverage.sh` greps for each knob's *name* in a non-test file and in
a test file. I checked whether it bites, and **it did not**: renaming
`SimEsc.corruptCrc` still passed, because the string survived in a doc comment.
Worse, the diff review found two rows passing on outright false positives — the
test-side grep took the first hit anywhere under `packages/`, so `canBlock`
matched an unrelated local variable in block 1's `codec.prop.test.ts` and
`mavlinkIdleGate` matched a line of rig setup in `transport.test.ts`. Both rows
would have stayed green with the knob's real test deleted.

**I tightened the gate** to require a suite *named after* the knob —
`describe('fault knob: …<knob>…')`, which is what the plan's own wording asks
for. All ten rows now resolve to their own suite inside `am32-sim`, and renaming
one fails the gate (verified). It is still only a presence check; what proves
behaviour is the test suite, and I established that by mutating each knob's
implementation and watching specific tests fail:

| Mutation | Result |
|---|---|
| `maybeCorrupt` becomes a no-op | `fc.fourway.test.ts` 2 failed |
| `mspAvailable` always true (idle gate never closes) | `fc.msp.test.ts` 2 failed |
| `pumpFourWay` escapes to MSP regardless of the knob | `fc.msp.test.ts` 1 failed |
| `LinkFaults.apply` passes every byte through | `transport.test.ts` 4 failed |
| the `num_motors` clause dropped from the channel guards | `fc.msp.test.ts` 2 failed |
| `cmd_DeviceWrite` stops short-circuiting a refused address | `fc.fourway.test.ts` 1 failed |
| chunks scheduled independently, no wire serialisation | `transport.test.ts` 1 failed |

The third row is worth reading twice. My **first** attempt at that mutation —
deleting the `blockingFourWay` guard from `SimFc.handleMsp` — left all 14 tests
passing, because that guard was **unreachable**: `handleMsp` is only ever called
from `pumpMsp`, which only runs when the mode is already `msp`. The real trapdoor
is in `pumpFourWay`, which eats the bytes before they are ever framed. I deleted
the dead guard rather than leaving a check that looks load-bearing and never
runs. **If block 4 or 5 adds a "belt and braces" guard somewhere, mutate it
before believing it.**

### What the diff review changed

A subagent reviewed the diff against block 3's done-when in a fresh context. It
found three real bugs and three coverage gaps; all six are fixed, and the last
three rows of the mutation table above are the tests that now pin them.

1. **`cmd_DeviceWrite` did not short-circuit a refused `CMD_SET_ADDRESS`.** The
   bootloader leaves its address pointer alone when it refuses an address, so
   carrying on to `CMD_SET_BUFFER` + `CMD_PROG_FLASH` programmed the payload at
   whatever address the *previous* write had targeted — silently corrupting a
   page while correctly reporting `ACK_D_GENERAL_ERROR`. Real firmware returns
   as soon as `BL_SendCMDSetAddress` fails (AP:915-942, BFavr:290-299).
   `cmd_DevicePageErase` had the same shape and is fixed the same way; it was
   harmless only because `erasePage` is a no-op stub. `deviceRead` already
   short-circuited, so the three paths were inconsistent.
2. **`SimTransport` could deliver replies out of order.** Each chunk was
   scheduled independently as `now + wire(chunk)`, so a 4-byte frame emitted just
   after a 240-byte one arrived *first* — which no UART can do. Each direction
   now has a `busyUntil` cursor, so a chunk cannot start shifting out until the
   one before it has finished. Not reachable from the tests as they stood, but it
   becomes reachable the moment an exchange times out with its reply still queued
   and the next exchange is a smaller command — i.e. exactly block 4's
   enumerate-after-timeout path.
3. **`SimFc.rx` was unbounded**, unlike `Link.maxRxBytes`. Capped at 512 (tail
   kept), which is also more faithful: both firmwares have fixed 256-param input
   buffers.
4. **`num_motors` was implemented but never varied**, so `channel >= motorCount`
   in the two channel guards was dead — every test had `motorCount === escs.length`
   and tripped the `escs.length` clause alone. Section 3's "per-channel
   `ACK_I_INVALID_CHANNEL` above `num_motors`" was only nominally covered. Now
   tested at `motorCount: 2` with 4 ESCs, at `motorCount: 0` on Betaflight (the
   trap where the FC reports zero ESCs and enters passthrough anyway), and at
   `motorCount: 0` on ArduPilot (an analog-PWM board, where byte 6 is legitimately
   zero on a flying aircraft).
5. **`MSP_BATTERY_STATE` had no test** despite being named in section 3. Now has
   two, including the no-battery state byte.
6. **No end-to-end 4-way write → 4-way read-back.** Added, and it is the most
   useful test in the block for what comes next: it writes a 192-byte image over
   `cmd_DeviceWrite` and reads it back over `cmd_DeviceRead`, asserting that
   everything survives *except* byte 2, which the bootloader stamps with its own
   version. That is the shape block 6's verification has to have.

Three smaller things it was right about, also fixed: `SimEsc.continueAddress` was
written and never read (the three magic addresses `0x20`/`0x21`/`0x22` are now
implemented, which is what makes it load-bearing, and tested); the `BR_*`
bootloader ACK constants were exported and used nowhere (deleted — the values are
in the `EscAck` docstring); and `FcProfile.readBudgetPerByteMs` was read by
nothing, implying an FC-side read timeout the simulator does not model (deleted —
see Outstanding).

## What I built

**`packages/am32-sim/src/esc.ts` — `SimEsc`.** An AM32 ESC as the *flight
controller* sees it over 19200 soft-serial. Modelled at operation granularity
(`connect`, `setAddress`, `setBuffer`, `read`, `programFlash`, `erasePage`,
`reset`), because nothing above the FC can ever observe the soft-serial bytes.
What *is* modelled byte for byte is each operation's **duration** — `wire(n)` at
19200 plus programming time — since that is the quantity the timeout policy is
derived from. Holds a full 64 KiB flash image with the 192-byte `EEprom_t` at
`0x7C00` and the firmware name in the 32 bytes below it.

**`packages/am32-sim/src/fc.ts` — `SimFc`.** A byte-stream state machine, not a
request/response mock: bytes in, bytes out, with the MSP ↔ 4-way mode switching
done the way each firmware actually does it. That is the point — audit **H** is
the configurator not encoding the difference anywhere, and the difference lives
exactly in the mode switching.

**`packages/am32-sim/src/profiles.ts`.** The plan's FC quirks table as data:
18 fields, every one carrying its firmware citation. Adding a profile is adding a
record, not adding a branch.

**`packages/am32-sim/src/transport.ts` — `SimTransport`.** `Transport`, charging
wire time in both directions from the injected `Clock`. Resolves `write()` as
soon as the bytes are queued, the way a real serial writer does, and delivers one
wire time later.

**`packages/am32-sim/src/faults.ts` — `LinkFaults`.** `dropBytes` and
`injectGarbage`, applied per chunk in either direction.

**`packages/am32-sim/src/harness.ts` — `createSimHarness`.** One call for a whole
rig. Block 7's `ark32 --sim` should use this, so the CLI's simulator mode and the
test suite build the same object graph.

**Core additions** (`70aaad5`): `encodeFourWayResponse`, `parseFourWayRequest`,
`isCompleteFourWayRequest`, `FOUR_WAY_REQUEST_OVERHEAD`, and the MSP parser's
private `frameLength` promoted to an exported `mspFrameLength`. These are in
`am32-core/framing`, not in `am32-sim`, on purpose: a second implementation of
4-way framing would make every simulator test prove only that the simulator
agrees with itself.

### The firmware facts the simulator encodes that a naive model gets wrong

All read with subagents, all cited in the code. These are the ones that will bite
blocks 4 and 6 if they are forgotten:

1. **`CMD_ERASE_FLASH` (0x02) is a stub in the AM32 bootloader** — it validates
   the CRC and the address, then ACKs **without erasing anything**
   (`AM32-bootloader/bootloader/main.c:613-629`). So `cmd_DevicePageErase`
   reports success and does nothing. The erase that matters is implicit in a
   write.
2. **A write erases the page only when the address is page-aligned**
   (`Mcu/f051/Src/eeprom.c:35-44`), then programs and verifies with `memcmp`
   (`:62`). The host must stream pages in ascending order and hit each 1024-byte
   boundary exactly; a non-aligned write into a programmed page fails, because
   flash can only clear bits.
3. **A write to the EEPROM base overwrites payload byte 2 with the bootloader's
   own version** (`main.c:517-525`). `BOOT_LOADER_REVISION` therefore **never
   round-trips**. Block 6's read-back verification cannot be a byte-for-byte
   compare of the whole image — it has to skip byte 2. This is pinned by
   `esc.test.ts > stamps its own version over payload byte 2 of an EEPROM write`.
4. **A read zeroes the address pointer** (`main.c:667-669`, comment: "ensure
   client sends a SET_ADDRESS each time"), so the 4-way `0xFFFF` keep-the-address
   idiom cannot work against AM32.
5. **`CMD_VERIFY_FLASH_ARM` (0x04) and `CMD_PROG_EEPROM` (0x05) are
   unimplemented** (`main.c:674-675`). So `cmd_DeviceVerify` can **never** succeed
   against an AM32 ESC, and `cmd_DeviceWriteEEprom` writes nothing — while
   ArduPilot answers `ACK_OK` anyway, because it discards `BL_WriteA`'s return
   value (`AP_BLHeli.cpp:1210-1212`). Betaflight at least says
   `ACK_D_GENERAL_ERROR` (`serial_4way.c:815`). **Block 6 must write settings with
   `cmd_DeviceWrite` and verify by reading back.**
6. **ArduPilot's idle gate drops the bytes that arrive inside the window and does
   not extend it** (`GCS_Common.cpp:1943,1970-1977`; `last_mavlink_ms` is written
   in exactly one place, `:1977`, and only on `MAVLINK_FRAMING_OK`). Polling
   during the window is free. That is what makes block 4's probe-then-wait connect
   possible at all, and it is why the current unconditional 4.5 s wait is pure
   tax.
7. **A failed `cmd_DeviceRead` can come back `ACK_OK`.** `BL_ReadA` returns false
   at `AP_BLHeli.cpp:786` without touching `blheli.ack` when the
   `CMD_SET_ADDRESS` handshake fails (`:749-761`), so ArduPilot replies `ACK_OK`
   with **one byte of uninitialised stack** (`:1098-1103` — a VLA that is never
   written). Modelled, and pinned by `fc.fourway.test.ts > the ACK_OK that is not
   a success`.

## Design decisions a later block could accidentally undo

1. **`slowBy(ms)` is charged once per host-visible 4-way command, not once per
   bootloader operation.** Charging it inside an operation would blow the *FC's*
   own ACK budget (500 ms for a flash program) and turn every `slowBy` test into
   an FC-side abort, hiding the thing actually under test — the **host's**
   timeout. `slowBy` models an ESC that is slow; `unresponsive` models one that is
   broken. Block 6's done-when (`esc[n].slowBy(600)` and a flash that still
   succeeds) depends on this and fails if it is changed.

2. **`corruptCrc` corrupts the *host-facing* 4-way frame, not the bootloader
   link.** A bootloader-side CRC failure is indistinguishable from `shortRead` by
   the time it reaches the host — both firmwares collapse it to a one-param
   `ACK_D_GENERAL_ERROR` — so injecting it there would leave the host's own
   CRC-rejection path (`parseFourWayResponse`'s checksum branch) untested. The two
   knobs guard two different host code paths on purpose. `corruptCrc` accepts a
   *number* meaning "corrupt the next N replies", which is what makes "the retry
   recovered" an exact assertion instead of a race.

3. **`blockingFourWay` is enforced in one place, `SimFc.pumpFourWay`**, and it
   governs both escapes (the `$` out of 4-way and the `/` into it). Turning it off
   on a Betaflight profile gives that profile ArduPilot's multiplexing and changes
   nothing else. Do not add a second check elsewhere — see the mutation table
   above for what happened the first time.

4. **`mavlinkIdleGate` is a duration, and assigning it re-arms from *now*.**
   `fc.mavlinkIdleGate = 4000` models a GCS frame taking the port back;
   `fc.mavlinkIdleGate = 0` opens it. Bytes that arrive while it is shut are
   counted in `fc.counts.gatedBytes` and thrown away, exactly as ArduPilot does.

5. **`SimEsc.connect()` returns the raw 8-byte `BootInfo`, and `SimFc` reverses it
   into the 4-byte `deviceInfo`.** That split is deliberate: the reversal
   (`deviceInfo[0] = BootInfo[5]`, `[1] = [4]`, `[2] = [3]`, `[3] = interface
   mode`, per `serial_4way_avrootloader.c:225-227` and `AP_BLHeli.cpp:813-815`) is
   the FC's job, and getting it backwards is a real bug the simulator should be
   able to catch. Collapsing them into one step would remove that.

6. **`am32-sim` is deliberately *not* aliased in `nuxt.config.ts`** and nothing in
   the app imports it. It is a peer of `am32-web`, not a test-only mock (issue #3
   section 7.3), but it must never reach the browser bundle. Block 7's
   `am32-node`/`am32-cli` will need aliases; this one should not get one.

7. **The simulator builds no `Link` and no session.** `createSimHarness` returns
   `{ clock, fc, escs, transport }` and stops at the transport boundary. Keeping
   that line sharp is what stops the simulator from growing a second copy of the
   host's logic — which would make the tests tautological. Tests construct their
   own `Link` in one line; block 4's should construct its own `Am32Session`.

8. **`garbageBytes` never emits `0x24`, `0x2E` or `0x2F`.** My first version
   claimed that in a doc comment and did not do it, and `transport.test.ts >
   cannot accidentally look like a frame start` caught it. If filler could contain
   a start byte, "garbage" would start meaning "a frame nobody sent" and the
   fault tests would be measuring something else.

## Where the plan was wrong, stale, or impossible

- **The plan says "one test named after each of the **eight** fault knobs", but
  the table has eight *rows* and ten *knobs*** — two rows name two knobs each
  (`esc[n].corruptCrc, esc[n].shortRead` and `link.dropBytes, link.injectGarbage`).
  `scripts/assert-fault-coverage.sh`, written in block 0.5, already lists all ten.
  I implemented and tested ten. Read the gate, not the sentence.

- **The plan's ESC model says "page-erase-on-write semantics" without saying what
  they are, and the obvious reading is wrong.** "The write erases its page" would
  make a 256-byte chunked flash erase the same page four times and lose three
  quarters of the data. The real rule is "erase *only* when the address is page
  aligned". Modelled and tested.

- **The plan's `fc.blockingFourWay` row says "Betaflight passthrough must not
  expect MSP", which understates it.** Betaflight installs `esc4wayProcess`
  **unconditionally**, even when it just replied that there are zero ESCs
  (`msp.c:330-332` is not guarded by `escCount`). So a host that asks for
  passthrough on a board with no motors is trapped in 4-way with nothing to talk
  to, and only `cmd_InterfaceExit` gets out. Modelled; block 4 should handle a
  zero-ESC passthrough reply by exiting rather than by giving up.

- **Betaflight's `cmd_DeviceReset` 300 ms busy-wait only happens when the request
  sets `ADDR_L == 1`** (`serial_4way.c:588-590,604-611`). The app sends address 0,
  so it never pays that cost — block 2's `DEVICE_RESET_MS = 300` in the timeout
  policy is conservative rather than required. Harmless; do not "optimise" it
  away, because a future hard-reboot path would need it.

- **`cmd_DeviceEraseAll` is not implemented by ArduPilot at all** and only for
  `imSK` by Betaflight, so for any AM32 target both answer `ACK_I_INVALID_CMD`.
  The plan's "the full command set" is therefore satisfied by *rejecting* several
  commands, which is what the simulator does.

- **The plan's `Transport` interface has no error channel**, and block 2's note
  already flagged the consequence ("the link does not learn about a mid-exchange
  transport failure"). `SimTransport` inherits that: closing the port mid-exchange
  leaves the in-flight attempt to time out. I did not change the interface —
  that is block 4's call, and it affects `am32-web` too.

## Plan line references that had drifted

Re-verified against `b74b33f` (this block's base), not against `4094dad`. Block 3
does not depend on any of the audit's app-side line references — it adds a new
package — so the drift that mattered was in the **firmware** citations, several of
which the plan and block 2's note got slightly wrong:

| Claim | Plan / earlier note said | Actually |
|---|---|---|
| Failed `cmd_DeviceRead` ACK | "replies with one byte and `ACK_D_GENERAL_ERROR` on both" (block 2 note) | True for the read itself, but ArduPilot answers **`ACK_OK`** + one uninitialised byte when the failure is in `CMD_SET_ADDRESS` (`AP_BLHeli.cpp:786`, ack never set) |
| `cmd_DeviceInitFlash` reply on connect failure | not stated | **4 params on Betaflight** (`serial_4way.c:636-643`, `SET_DISCONNECTED` zeroes only bytes 0-1, so 2-3 are stale from the previous connect), **1 on ArduPilot** (`AP_BLHeli.cpp:1081-1083`) |
| `cmd_DevicePageErase` echoed address | not stated | Betaflight echoes the *computed* erase address (`:675-680`), ArduPilot forces `0x0000` (`AP_BLHeli.cpp:1122`) |
| Bad 4-way request CRC | not stated | Betaflight replies `ACK_I_INVALID_CRC` (`:487-491`); ArduPilot replies **nothing** (`AP_BLHeli.cpp:298-300`) and never uses that ACK code anywhere |
| `cmd_InterfaceGetName` | not stated | Betaflight sends 9 raw chars `m4wFCIntf` (`:546-547`); ArduPilot sends a **length-prefixed** 5-byte `{4,'A','R','D','U'}` (`AP_BLHeli.cpp:1002`) |
| MSP error frames | audit D implies both firmwares send `$M!` | Only Betaflight (`msp.c:4406-4408`). **ArduPilot has no error frame at all** — unknown command and bad CRC are both silence (`AP_BLHeli.cpp:601-604`, `:238-242`). Its one failure reply is `msp_send_ack(ACK_D_GENERAL_ERROR)`, a normal `$M>` frame whose *command* field is `0x0F` (`:593-595`) |
| AM32 bootloader ACKs | not stated | `brSUCCESS 0x30`, `brERRORCOMMAND 0xC1`, `brERRORCRC 0xC2`. `brERRORVERIFY 0xC0` is **never emitted** — there is no verify support. `CMD_KEEP_ALIVE` answers `0xC1` *on purpose* and both FCs count that as success |
| Bootloader link CRC | block 2 note: "reflected poly 0xA001, little-endian" | Confirmed: CRC-16/ARC, init 0, reflected, no final xor, low byte first (`main.c:364-381`). The greeting and the 9-byte device-info reply carry **no CRC at all** |

**Citations I got wrong the first time**, found by the diff review and corrected
in the code — recorded because the wrong version was in a source comment, which
is where block 4 will read it:

- The idle-gate comment said bytes arriving inside the window "are read and
  discarded ... (GCS:1943,1970-1977)". That range is precisely the code that
  *does* reset the window: the byte **is** handed to the MAVLink parser at
  GCS:1970, and GCS:1974-1977 re-arms the timer on `MAVLINK_FRAMING_OK`. The
  conclusion survives — `$M<` and `/` are not MAVLink, whose magic is 0xFE/0xFD,
  so they never parse and never push the handoff back — but the mechanism is
  "MSP is not valid MAVLink", not "the bytes are thrown away unread".
- `FIRMWARE_START = 0x1000` was labelled `APPLICATION_ADDRESS`. It is
  `FIRMWARE_RELATIVE_START`; `APPLICATION_ADDRESS` is that plus `MCU_FLASH_START`.
  **This matters** — see Outstanding.
- The firmware-name window cited `BL:224-226`, which is the
  `ADDRESS_MAGIC_CONTINUE` define. The right citation is `ADDRESS_MAGIC_FILE_NAME`
  at `BL:556-559`, and the NUL truncation is configurator-side.
- "ArduPilot discards the failure and answers OK" for `cmd_DeviceWriteEEprom` was
  too strong. `BL_WriteA` *does* set `ACK_D_GENERAL_ERROR` (AP:920, :935), as does
  `BL_SendBuf` (AP:671, :687); the only path that leaks `ACK_OK` is a final
  `BL_GetACK` timeout (AP:928-932). Since AM32 answers `CMD_PROG_EEPROM` with
  `brERRORCOMMAND`, that *is* the path taken, so the simulated behaviour was right
  and only the reasoning was wrong.
- `checkAddressWritable` is at `BL:443-446` (`:511-515` is the call site), and
  "num_motors is legitimately zero" is `AP:1500-1505` (`:1460-1466` is the
  `digital_mask` assignment).

Two firmware facts that are **build-dependent**, so do not treat the simulator's
choice as universal: Betaflight's `cmd_InterfaceSetMode` accepts 1..4 only in a
both-bootloaders build (a BLHeli-bootloader-only target accepts {1,2,4} and
rejects 3, BF:568 vs :570); and `MSP_MOTOR`'s idle value is 1000 only when *not*
in passthrough, since `esc4wayInit` calls `motorDisable()` — which the simulator
never exercises, because Betaflight does not answer MSP in passthrough at all.

Two useful things a later block should not re-derive:

- **AM32 always classifies as `imARM_BLB` (4).** `deviceInfo[0]` is a hardcoded
  `0x06` and `deviceInfo[1]` is `FLASH_SIZE_CODE` (`0x1F`/32K, `0x35`/64K,
  `0x2B`/128K), which is always in `(0x00, 0x90)`. So the host-visible signature
  is `FLASH_SIZE_CODE << 8 | 0x06` — `0x1F06` for an F051, which is exactly
  `Mcu.variants['1F06']`. The mapping is not a coincidence and not a lookup: it
  falls out of the bootloader's own constants.
- **`~/code/ark/AM32-bootloader/sitl/` already builds `bootloader/main.c`
  unmodified against stub headers, with an mmap'd fake flash and a virtual
  clock.** It currently only exercises the boot-decision path, not the serial
  protocol. If simulator fidelity ever becomes the bottleneck, driving the *real*
  bootloader from `SimEsc` is a smaller job than it sounds.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** Block 3 has no
  checkpoint of its own in the plan (the first is block 4's), and it changes
  nothing on the wire: `am32-sim` is not reachable from the app, and the core
  changes are purely additive FC-side framing the host never calls. So there is
  no new hardware risk from this block. **Block 2's checkpoint is still
  outstanding and is now two blocks stale** — see `block-2.md`'s list, especially
  the 4-way read timeout dropping from 1500 ms to 769 ms.
- **The simulator has never been checked against real silicon.** That is by
  design (issue #3 section 7.5: fidelity comes from firmware sources, divergence
  is caught at the two hardware checkpoints). The three highest-risk modelling
  choices, in the order I would doubt them: the per-operation **durations** in
  `esc.ts` (invented within the firmware's budgets, not measured); the
  bootloader-version stamp on EEPROM byte 2 (`BOOTLOADER_VERSION` is 18 on the
  branch I read — a different ARK build stamps a different number); and the
  assumption that `ADDRESS_SHIFT` is 0 for the 32K and 64K parts, which is what
  makes flash-relative 4-way addresses work unchanged.
- ⚠️ **`FIRMWARE_START` may be wrong for ARK's firmware.** The simulator uses
  `0x1000`, which is AM32's `FIRMWARE_RELATIVE_START` — but that constant is
  **`0x4000` on a `DRONECAN_SUPPORT` build** (`bootloader/main.c:77`), and the
  simulator's default ESC is an `ARK_4IN1_F051` with a populated CAN block. If
  ARK ships a DroneCAN build, the writable floor here is 12 KiB too low and block
  6's flash tests would validate against the wrong layout. It is a `SimEsc`
  constructor option for exactly that reason. **Check the ARK AM32 build before
  block 6 relies on it** — this is the single most likely place the simulator and
  real silicon disagree.
- **The FC's own per-byte read budget is not modelled.** I removed
  `FcProfile.readBudgetPerByteMs` rather than leave a field nothing read: dead
  config that implies a behaviour is worse than an absent one. The consequence is
  that a slow-but-complete ESC read never becomes an *FC-side* timeout — only
  `shortRead` produces one, and it fabricates it directly. That is a deliberate
  consequence of charging `slowMs` outside the ESC operations (see design
  decision 1). The **host's** budget, which is the thing under test, does key on
  the variant, in the core's `TimeoutPolicy`. If block 6 wants a real FC-side
  read timeout, add a per-operation delay to `SimEsc.read` rather than reviving
  the profile field.
- **`SimEsc` does not model the bootloader's soft-serial framing**, only its
  operations. `link.dropBytes` and `link.injectGarbage` therefore act on the
  host ↔ FC link only. If block 6 wants to test "the FC retries the ESC", the hook
  is a per-operation failure counter on `SimEsc`, not a byte-level fault.
- **A truncated *request* can wedge `SimFc` until more bytes arrive.**
  `faults.dropBytes(n, { direction: 'tx', skip: k })` with `k >= 5` corrupts the
  length byte, and the FC then waits for a frame length that never comes — which
  is exactly what Betaflight does (`USE_TIMEOUT_4WAYIF` is defined nowhere, so
  `ReadByte` spins forever) and roughly what ArduPilot does. Faithful, but it
  means a test using that shape hangs the simulator rather than failing cleanly.
  The committed tx test uses `skip: 0`, which drops the start byte and recovers.
- **`readSetAddressFailureAcksOk` is the only profile flag whose ArduPilot value
  models a firmware *bug* rather than a design difference.** If ArduPilot ever
  fixes `BL_ReadA`, that flag and its test go away together.
- **Nothing enforces `noUncheckedIndexedAccess` on `am32-sim`.** The package has
  no `tsconfig.json` of its own; `typecheck:core` points only at `am32-core`, and
  the generated Nuxt tsconfig that `typecheck:app` uses sets the flag to `false`.
  I compiled all seven non-test sources under the core's exact flags by hand and
  they are clean, but that is discipline, not a gate. `am32-web` has the same
  hole, so it predates this block; a shared strict tsconfig for the non-core
  packages would close both.
- **`docs/TESTING.md` still does not exist.** Block 2's note nominated block 4 to
  create it, since block 4 is the first with a checkpoint of its own. Still true.
- **`components/SerialDevice.vue` is untouched**, as are `src/communication/*`,
  `stores/` and `pages/`. Audit **B**, **C**'s caller side, **G**'s flash-modal
  wedge, **H**'s 4.5 s wait and **I**'s dead code all survive — blocks 4, 5 and 6.
- **`docs/plans/overhaul/STATUS.json` carries the driver's own `in-progress`
  edit**, committed with this note because the block must leave no uncommitted
  changes. I did not author that line.

## Three things I would tell the next agent

1. **Build block 4's session against `createSimHarness`, and let the simulator
   tell you when the API is wrong.** That is the whole reason block 3 comes first
   (issue #3 section 7.3): anything the session needs that a `Transport` cannot
   provide shows up immediately as a hole in `am32-sim`. Two holes are already
   visible from here — the transport has no way to push an error into the link
   (so an unplug during an exchange waits out the full timeout), and nothing
   models the FC *itself* going away mid-passthrough. If you need either, change
   the `Transport` interface deliberately and change `am32-web` with it, rather
   than working around it in the session.

2. **`ACK_OK` does not mean the read returned data.** ArduPilot answers a
   `CMD_SET_ADDRESS` failure with `ACK_OK` and one byte of uninitialised stack,
   and every failed read on both firmwares comes back with exactly one param byte.
   The rule block 1b wrote down and block 2 left open — "if you asked for N > 1
   bytes and got 1 back, it is a failed read regardless of the ACK" — now has a
   simulator that reproduces it (`fc.fourway.test.ts > the ACK_OK that is not a
   success`). Put the length check in the session's read, in `link.request`'s
   `validate` so it retries with a drain, and this class of bug closes for good.

3. **Mutate before you believe, and get the diff reviewed.** The fault-coverage
   gate is a *presence* check; even after I tightened it, passing it proves only
   that a suite exists with the right name. Every claim in this note about a knob
   working is backed by deleting the implementation and watching a specific test
   go red — seven such experiments, two of which found things I had just written
   and would otherwise have left behind (an unreachable guard, and a `num_motors`
   check no test could reach). The fresh-context diff review found three more,
   including one that would have silently corrupted a flash page. Both cost
   minutes. Neither is optional at this point in the plan, because from block 4
   onward the simulator is the *only* thing standing between a protocol bug and
   real hardware.
