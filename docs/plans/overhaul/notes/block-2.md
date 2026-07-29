# Block 2 — Link and transports

Landed on `master` on top of `96af85b`:

| Commit | What |
|---|---|
| `4b3aacf` | `feat(core): add Transport, injectable Clock, Link and TimeoutPolicy` |
| `4ba51d9` | `feat(web): add am32-web, a Web Serial transport that only moves bytes` |
| `0c6a2ab` | `refactor(app): move the serial exchange onto the core Link` |
| `230c909` | `fix(web): release the writer lock instead of awaiting writer.close()` |
| `8d47952` | `docs(core): correct the comment on the write-failure race` |
| `774b71f` | `test(core): pin the slow-write-then-fail race in the link` |
| (this file) | the handoff note |

## Verification

```
yarn verify                                → exit 0  (lint 0 errors / 19 warnings, typecheck:core + typecheck:app clean, 155 tests in 9 files)
yarn install --immutable                   → exit 0  (CI's install step; the lockfile change is in sync)
done-when (STATUS.json block 2)            → exit 0
  test -f packages/am32-core/src/link/link.test.ts && bash scripts/assert-core-hygiene.sh
      Injectable clock   ok  am32-core takes all time from clock.ts
      webserial-wrapper  ok  gone from sources and lockfile
yarn build                                 → exit 0  (see the block-1a warning about this)
./run.sh --no-browser                      → dev server up, GET /configurator 200, vue-tsc 0 errors
```

New test counts: `link/link.test.ts` 19, `link/timeout-policy.test.ts` 16,
`clock.test.ts` 10, `am32-web/web-serial-transport.test.ts` 10. The three core
files run in ~20 ms of wall time and cover ~1.4 s of virtual time, which is the
point of the clock.

I also checked that both halves of the gate genuinely fail on a half-done
implementation rather than passing vacuously (block 1a's lesson):
`Date.now()` in `link.ts:312` → `assert-core-hygiene` exits 1 naming the line;
dropping the `writer.releaseLock()` in `am32-web` → three tests fail with
`Invalid state: WritableStream is locked`; dropping the `settled.catch` guard in
`Link.runAttempt` → `vitest run` exits 1 on an unhandled rejection.

Dev-server smoke check beyond the 200: Vite resolves and transforms every new
module in the browser graph —
`/_nuxt/packages/am32-web/src/index.ts`, `/_nuxt/packages/am32-web/src/web-serial-transport.ts`,
`/_nuxt/packages/am32-core/src/link/link.ts`, `/_nuxt/packages/am32-core/src/clock.ts`
and `/_nuxt/src/communication/serial.ts` all 200 with the bare `am32-web`
specifier rewritten to the aliased source. Worth doing again after any block that
adds a package: `yarn verify` cannot see a broken alias.

**Lint is 19 warnings, down from 23, still 0 errors.** The four that went away
were console calls in the deleted `serial-transport.ts` and the old retry loop.

## The tests went red first, and here is the proof

Audit **G**'s hang is the one that needed a reproduction rather than an
assertion, so I transcribed the pre-block-2 `sendWithPromise` shape into a
throwaway test and ran it. With `drain()` rejecting:

```
✓ audit G: the old shape > never settles when drain() throws
✓ audit G: the old shape > settles when nothing throws, which is why this went unnoticed

⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: drain failed
 ❯ callback packages/am32-core/src/link/__throwaway-old-shape.test.ts:19:23
 ❯ oldSendWithPromise ...:30:12

✓ the new Link, same failure > rejects instead of hanging
```

The old promise never settled — the throw escaped as an unhandled rejection and
the caller waited forever. The same failure through `Link` rejects with
`LinkError('write')`. The throwaway is **not** in the tree (it asserts against
code this block deleted, so it would rot immediately; block 1b made the same
call for its framing parity check). The committed equivalent is
`link.test.ts > Link: every path settles (audit G) > rejects when the write fails
instead of hanging forever`.

I also verified the new `am32-web` lock assertion actually bites: removing the
`writer.releaseLock()` in `close()` fails three tests with
`TypeError: Invalid state: WritableStream is locked`, because the fake port
rejects `close()` on a locked stream the way Chrome does.

## What I built

**`packages/am32-core/src/clock.ts`.** `Clock` (`now`, `setTimeout`, `sleep`),
`createSystemClock(host?)` and `VirtualClock`. The core tsconfig has no `dom` lib
and `types: []`, so `setTimeout` is not a declared name here at all —
`createSystemClock` reaches the host timers through a structural `TimerHost` and
`globalThis`. (`globalThis` and `Date.now()` do compile under that tsconfig;
`queueMicrotask` does not, which is why `VirtualClock` drains microtasks with a
fixed-depth `await Promise.resolve()` loop.) `VirtualClock.advance(ms)`,
`advanceToNextTimer()` and `runAll()` are the three shapes tests need.

**`packages/am32-core/src/transport.ts`.** The `Transport` interface, moved out of
`index.ts` where block 1b parked it. Re-exported from `index.ts`, so
`index.test.ts`'s compile-time proof still works.

**`packages/am32-core/src/link/link.ts`.** `Link`:

- **Mutex.** `request()` and the public `drain()` both go through a promise-chain
  tail, so exchanges are strictly FIFO single-flight. The chain is `.catch`ed
  after each link, so a rejected exchange cannot wedge the queue.
- **One RX buffer.** One `transport.onData` subscription taken in the
  constructor, appended to for the life of the link, capped at 4096 bytes
  (tail-kept). No handler is ever swapped.
- **Drain.** Clears the buffer and waits for a `quietMs` silent window, bounded
  by `maxDrainMs`. **Returns immediately, costing nothing, when nothing has
  arrived since the last exchange consumed its reply.** That is what removes the
  per-page drain tax from a flash.
- **Retry.** `retries` is *total attempts* (1 = send once), matching what the
  app's counter always meant. `retryDelayMs` between attempts. `validate` throwing
  is retried exactly like a timeout, which is how a non-OK 4-way ACK retries.
- **Always settles.** Synchronous promise executor; the write and the reply are
  awaited in a plain async function; `finally` cancels the timer and clears the
  pending slot. `LinkError.reason` is one of
  `timeout | closed | write | validate | disposed`.
- `stats` (`attempts`, `timeouts`, `drains`, `discardedBytes`) is real
  instrumentation, not test scaffolding — block 7's `-v` will want it, and it is
  what makes the drain cost model assertable.

**`packages/am32-core/src/link/timeout-policy.ts`.** `TimeoutPolicy`, immutable,
keyed on `(command, payloadBytes, fcVariant)` with `withVariant()`, a `scale`
multiplier for block 7's `--timeout-scale`, and one `HOST_MARGIN_MS = 250`. Every
constant carries its firmware citation in the file header. Derived values:

| | ArduPilot | Betaflight / generic | before block 2 |
|---|---|---|---|
| read 32 B | 500 | 500 | 1500 |
| read 192 B (settings) | 574 | 769 | 1500 |
| read 256 B (page) | 676 | 935 | 1780 |
| write flash 192 B | 965 | 965 | **200** (audit C) |
| write flash 256 B | 1004 | 1004 | **200** |
| write EEPROM 192 B | 3465 | 3465 | 1000 |
| init flash / test alive / exit | 1000 | 1000 | 1000 |
| device reset | 552 | 552 | 1000 |
| MSP | 750 | 750 | 500 |
| `MSP_SET_PASSTHROUGH` | 1250 | 1250 | 500 |

**`packages/am32-web`.** `WebSerialTransport implements Transport`. One reader and
one writer for the session, a read loop that stops on `close()` and is awaited
before the port is released, any number of `onData` subscribers, a read error
reported once through `onError` after which `isOpen` is false, and no `read()`
method at all. `nuxt.config.ts` gained the `am32-web` alias and `transpile` entry
alongside `am32-core`.

**App side.** `src/communication/serial-transport.ts` is **deleted** — block 1b
built it as a stopgap and told block 2 to delete rather than fix it, which is what
happened. `src/communication/serial.ts` is now just the singleton lifetime plus
`request()`/`drain()`. `four_way.ts`'s `sendWithPromise` is a plain async function
over `Serial.request`; `FourWay.read()` is gone with the second-reader path it
used. `stores/serial.ts` keeps only `port`. `SerialDevice.vue` opens through
`Serial.init(log, logError, logWarning, port, baudRate)` and closes through
`await Serial.deinit()`.

## Design decisions a later block could accidentally undo

1. **`retries` means total attempts, not extra attempts.** `retries: 1` sends
   once. This matches the semantics of the old `while (currentTry++ < retries)`
   loop, so `FOUR_WAY_DEFAULT_RETRIES = 10` still means ten sends. If block 4
   redefines it as "additional attempts", every retry budget in the app silently
   grows by one attempt-worth of timeout.

2. **No 4-way method takes a timeout, and none should.** `writeHex`, `write`,
   `writePages`, `readAddress`, `writeEEprom` and `sendWithPromise` all lost their
   timeout parameters; `sendWithPromise` takes an options object
   (`{ retries?, payloadBytes? }`) so nobody can slip a number into a positional
   slot again. `payloadBytes` is *the bytes the ESC moves*, not the 4-way param
   count — for a read the param count is 1 and the payload is 192. Getting that
   wrong silently returns the floor instead of the derived budget.

3. **Drain costs nothing on a quiet line, and that is load-bearing.** The
   `rx.length === 0 && !dirty` early return is what makes ~240 page writes free
   instead of paying a 25 ms quiet window each. `dirty` is set when bytes arrive
   with no exchange pending and when an attempt fails. Do not "simplify" the early
   return away.

4. **A failed attempt marks the line dirty on purpose.** So a retry always drains
   first, which is the fix for "a timed-out ESC poisons the next one". It costs
   25 ms per retry; `link.test.ts` asserts the exact cost model
   (`25 + 100 + 300 + 25 + 100 = 550` for two attempts), so changing this shows up
   as a failing arithmetic assertion rather than a silent regression.

5. **The link never resolves null.** Every failure is a `LinkError`. The app's
   `Msp.send` and `FourWay.send` still catch and return null because their callers
   expect that; `sendWithPromise` rejects, as it always did. Block 4's session
   should propagate `LinkError.reason` rather than flattening it to null.

6. **`am32-web` contains no timers and no `Date.now()`.** The hygiene gate only
   greps `am32-core`, so nothing enforces this in the transport packages. It is
   still the rule: a transport that needs time is a transport doing the link's
   job. Pass it a `Clock` instead.

7. **`@types/dom-serial` is now a direct devDependency, referenced from
   `nuxt.d.ts`.** See the next section — removing it breaks `SerialPort` and
   `navigator.serial` everywhere, and nothing in the app imports it.

8. **`packages/am32-core/package.json` gained an explicit `"./link"` export**
   pointing at `src/link/index.ts`, because the catch-all `"./*" → "./src/*.ts"`
   would map `am32-core/link` to a file that does not exist. Block 5's
   `no-restricted-imports` rule names `am32-core/link`; both that specifier and
   `am32-core/link/link` resolve today.

## Where the plan was wrong, stale, or impossible

- **The plan's MSP floor of 500 ms is too tight for the one command it cites.**
  The table's MSP row is justified by "ArduPilot may block on
  `serial_setup_output` before replying to `MSP_SET_PASSTHROUGH`" — and the
  firmware declares up to **1000 ms** for exactly that (`AP_BLHeli.cpp:592`,
  `EXPECT_DELAY_MS(1000)`, with the reply sent only after `serial_setup_output`
  returns at `:593-599`). So `MSP_SET_PASSTHROUGH` gets 1250 ms and everything
  else gets the 500 ms floor plus margin. The plan's floor is kept as a floor.

- **The plan's read derivation uses ArduPilot's per-byte budget for both FCs.**
  `wire(n) + BL_ReadBuf(n × 1 ms)` is ArduPilot's number
  (`serial_read_bytes(buf, req_bytes, req_bytes * 1000)` µs, `AP_BLHeli.cpp:705`).
  Betaflight has no total budget at all: `suart_getc_` gives each byte its own
  `START_BIT_TIMEOUT_MS = 2` ms start-bit timeout
  (`serial_4way_avrootloader.c:69,82`), so a Betaflight read of *n* bytes can take
  **2 ms per byte** — twice the plan's figure. The policy is keyed on the variant
  for this reason, and `generic` (pre-detection) takes the worse of the two.

- **The plan's done-when grep does not cover `package.json`** — block 1b already
  flagged this. Handled: the dependency is out of `package.json` *and* the
  lockfile, and `yarn install` ran (offline-safe, it only removed).

- **That same grep forbids *naming* the removed package in a comment.** It is
  `grep -rn "webserial-wrapper" components pages stores src packages yarn.lock`,
  so a doc comment in `packages/**` explaining what was removed and why fails the
  gate. I reworded three comments and a package description to say "the Web Serial
  wrapper package block 2 deleted" and pointed them at this note, which is not in
  the grep's path list. **The package was `webserial-wrapper@1.0.4`**, and its only
  dependency was `@types/dom-serial`. Do not reintroduce the literal string under
  `packages/`, `src/`, `stores/`, `components/` or `pages/` — the gate is right to
  be strict, and this file is the place for the name.

- **Removing the dependency silently removes the Web Serial *types*.**
  `webserial-wrapper` was the only path `@types/dom-serial` reached
  `node_modules` by (`yarn why` confirmed it), and the app never imported the
  types package directly — it got the globals as a side effect of
  `stores/serial.ts` importing the wrapper. Drop the wrapper and
  `yarn typecheck:app` produces 14 errors about `SerialPort` and
  `navigator.serial`. Fixed by declaring `@types/dom-serial` as a devDependency
  (same `~1.0.4` range, so the existing lockfile entry still resolves — no
  registry round trip) **and** adding `/// <reference types="dom-serial" />` to
  `nuxt.d.ts`, because nothing imports it any more and Nuxt's generated tsconfig
  sets `types: []`.

- **Audit E's "`SerialTransport.exchange` installs a single `stream.ondata`" is
  described against `@am32/serial-msp`, which no longer exists.** Block 1b
  reimplemented that transport as `src/communication/serial-transport.ts`,
  defects intact, and this block deletes the file. All five E bullets are fixed;
  the last one (`transport.read()` grabbing a second reader) is fixed by deletion
  — `Serial.read` and `FourWay.read` are gone, and `WebSerialTransport` has no
  raw read at all.

- **`Link` does not resynchronise past a garbage prefix inside one attempt.**
  Both probes (`isCompleteFourWayFrame`, `isCompleteMspFrame`) require the start
  byte at offset 0, so garbage ahead of a valid frame means the probe never fires,
  the attempt times out, and the retry drains and tries again. That *is* the
  resynchronisation mechanism, and it is what block 3's `link.dropBytes` /
  `link.injectGarbage` knobs will exercise. If block 3 wants mid-exchange resync
  instead, the hook is five lines in `Link.handleChunk`: an optional
  `sync?: (buffer) => number` in `LinkRequestOptions` returning the offset of a
  plausible frame start. I did not add it because nothing tests it yet.

- **The exchange timeout is now a total per-attempt deadline, not an inactivity
  timer.** The old `SerialTransport.exchange` re-armed its timer on every chunk
  that did not complete the frame, so a slow trickle could take arbitrarily long.
  A total deadline is what the plan's derivations describe ("`wire(n) + ...`"), and
  the FC sends a reply as one USB burst, so in practice this only changes the
  pathological case. Worth knowing if a hardware checkpoint sees a timeout that
  the old code survived.

## Plan line references that had drifted

Re-verified against `96af85b` (this block's base), not against `4094dad`:

| Audit | Plan said (`4094dad`) | At `96af85b` | Now |
|---|---|---|---|
| **E** `stores/serial.ts:2` imports the wrapper | `:2` | `:2` ✓ | gone |
| **E** `src/communication/serial.ts:1` imports the wrapper | `:1` | `:1` ✓ | gone |
| **E** `disconnectFromDevice` | `SerialDevice.vue:828-855` | `:751-778` | `:730-747` |
| **E** single `ondata`, no mutex | `@am32/serial-msp` internals | `serial-transport.ts:100` | file deleted |
| **E** `transport.read()` second reader | `@am32/serial-msp` internals | `serial-transport.ts:134` | deleted with `FourWay.read` |
| **G** `async` executor passed to `new Promise` | `four_way.ts:255` | `:207` (promise built at `:248`) | plain async fn |
| **G** double drain | `four_way.ts:258` + `serial.ts:101` | `:210` (+ `:239`) and `serial.ts:108` | one drain per attempt, in `Link` |
| **G** drain's ≥25 ms floor | `serial.ts:92` | `serial.ts:99` | `Link.drainNow`, skipped on a quiet line |
| **C** `writeHex(i, hexString, 200)` | `SerialDevice.vue:1047` | `:868` | `:840`, no timeout argument |
| **C** `write()` passes the caller's timeout | `four_way.ts:359-361` | `:279-281` | policy-derived |
| **C** `writeEEprom` default 1000 ms | `four_way.ts:370` | `:290-292` | 3465 ms for 192 B |

Firmware facts worth not re-deriving (read with subagents, cited in
`timeout-policy.ts`):

- **ArduPilot read budget: `req_bytes * 1000` µs total, `req_bytes = len + 3`
  when connected** (`AP_BLHeli.cpp:699-711`). 192 B → 195 ms. A short read is
  fatal there: `ACK_D_GENERAL_ERROR`.
- **Betaflight has no total read budget** — 2 ms per byte via
  `START_BIT_TIMEOUT_MS` (`serial_4way_avrootloader.c:69,82,150-176`). 192 B →
  ~390 ms worst case.
- **Flash program ACK is 500 ms on both** (`AP_BLHeli.cpp:941`,
  `serial_4way_avrootloader.c:332`). **EEPROM write and page erase are 3000 ms on
  both** (`AP_BLHeli.cpp:1211,876`, `serial_4way_avrootloader.c:327,320`).
- **`BL_SendCMDSetBuffer` acks twice**: a header ACK that is *expected to time
  out* (AP `BL_GetACK(5)` at `:899`, BF `BL_GetACK(2)` at `:275`), then a payload
  ACK — 40 ms on AP (`:912`), ~80 ms on BF (`:277`, a raw retry count that is not
  divided by `START_BIT_TIMEOUT_MS`).
- **`BL_SendCMDSetAddress` is ~2 ms on AP** (`AP_BLHeli.h:278` default,
  `AP_BLHeli.cpp:760`) **and ~4 ms on BF** (`:264`), and both skip the exchange
  entirely when the address is `0xFFFF`.
- **Betaflight's `cmd_DeviceReset` busy-waits 300 ms before replying**
  (`serial_4way.c:608`).
- **Betaflight's `esc4wayProcess` is an unbounded blocking loop**
  (`serial_4way.c:429-929`, `while (1)` at `:453`, exit only via
  `cmd_InterfaceExit` at `:560-564,923-926`). `USE_TIMEOUT_4WAYIF` is defined
  nowhere in the tree, so `ReadByte` spins on
  `while (!serialRxBytesWaiting(port));` — the CMD/ARG/DAT timeout constants at
  `:89-92` are dead in shipped builds. Block 3's `fc.blockingFourWay` should model
  the spin, not a timeout.
- **A failed `cmd_DeviceRead` replies with one byte and `ACK_D_GENERAL_ERROR`**
  on both, but AP's byte is **uninitialised stack** (`AP_BLHeli.cpp:1095-1105`,
  no `buf[0] = 0` unlike `cmd_DeviceReadEEprom` at `:1196-1199`) while BF's is a
  deterministic zero (`serial_4way.c:465-467,727-731`). Block 1b's outstanding
  "validate a short read" item is still open — see below.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** Block 2 has no
  checkpoint of its own in the plan, but it changes every timeout on the wire and
  replaces the transport, so the block-4 checkpoint now covers two blocks' worth
  of change. The highest-value single check: connect to an ARK FPV, enumerate 4
  ESCs, then flash one. Specifically watch for:
  - **the 4-way read timeout dropping from 1500 ms to 769 ms** (192-byte settings
    read, generic variant). That is ~2x the worst case either firmware allows
    itself, and PR #1's 1500 ms was a guess rather than a measurement — but it is
    the one number in this block that moved *down*. If reads start timing out,
    raise `HOST_MARGIN_MS` in `timeout-policy.ts` or construct the policy with
    `{ scale: 2 }`; do not add a literal at a call site.
  - **the flash page write going from 200 ms to ~1000 ms.** This should make
    flashing *more* reliable, and roughly 12 s faster from the drain change alone.
  - **native timers instead of the removed wrapper's Web Worker "HackTimer".**
    That patch is the one thing the deleted package did which had a defensible
    motive: Chrome clamps `setTimeout` to >=1 s in a backgrounded tab. The
    consequence is asymmetric, though. Protocol *timeouts* firing late is safe --
    the exchange succeeds and the timer is cancelled -- and the read loop is
    driven by the serial reader rather than by a timer, so inbound bytes are never
    delayed. What does get slower is the deliberate `delay(...)` pacing in
    `SerialDevice.vue` (200 ms between ESCs, 300 ms retry gaps): flashing with the
    tab in the background may crawl. If that turns out to matter, the fix is to
    keep the tab foregrounded or to give the *session* a clock backed by a worker
    — not to reinstate a global timer patch, which is what made every protocol
    timeout jittery in the first place.
- **A short read still looks like success** — block 1b's outstanding item, still
  open and now cheap to close. The hook exists: `link.request`'s `validate`. The
  rule is "if you asked for N > 1 bytes and got 1 back, it is a failed read
  regardless of the ACK", and it belongs in `FourWay.readAddress` or block 4's
  session. I did not add it because `readAddress` has no way to know the expected
  length is meaningful for every command, and inventing that plumbing here would
  duplicate what block 4's session read does.
- **The link does not learn about a mid-exchange transport failure.** If the USB
  device is unplugged during an exchange, the read loop errors and `isOpen` goes
  false, but the in-flight attempt still waits out its full timeout (up to ~3.4 s
  for an EEPROM write) before the *next* attempt rejects with `closed`. Bounded
  and harmless, but block 4 could have the transport push an error into the link
  and fail the pending exchange immediately.
- **`docs/TESTING.md` does not exist.** The plan's section 8 says the hardware
  checkpoints are "Documented in docs/TESTING.md", but no block's done-when
  creates it and no block has. Block 4 is the first with a checkpoint of its own,
  so it is the natural place to create the file — and the block-2 items above
  belong in it.
- **`components/SerialDevice.vue` still has audit B, C's caller side, G's flash
  modal wedge and H's unconditional 4.5 s ArduPilot wait.** Untouched by design —
  blocks 4, 5 and 6. The three uncaught MSP call sites block 1b described are also
  still uncaught, for the reasons recorded in that note.
- **`commands.queue.ts`, the `queue` dependency and `FourWay.sendWithCallback` /
  `writeAddress` / `verifyPages` survive.** Audit I, block 5. Nothing feeds the
  queue from the new paths, so it is inert rather than wrong.
- **`docs/plans/overhaul/STATUS.json` carries the driver's own
  `status: in-progress` edit**, committed with the handoff note because the block
  is required to leave no uncommitted changes. I did not author that line.

## Three things I would tell the next agent

1. **Take a `Clock` and never a timer.** `packages/am32-core` cannot even *name*
   `setTimeout` — no `dom` lib, `types: []` — and `scripts/assert-core-hygiene.sh`
   greps for wall-clock reads in every `.ts` under `am32-core/src`, **including
   test files and comments**. Two of my comments failed that grep before the code
   did. Build simulator timing on `VirtualClock.advance` / `runAll`; the payoff is
   real: 44 core tests covering ~1.4 s of protocol time run in 20 ms, so a slow
   test genuinely means a hang.

2. **The timeout table is derived, not chosen, and the derivation is keyed on the
   FC.** Betaflight allows itself twice ArduPilot's per-byte read budget, and
   `generic` deliberately takes the worse. When block 4 identifies the FC it should
   call `policy.withVariant(...)` once and let every call site inherit it — the
   app currently derives the variant per call from `mspData.type` in
   `four_way.ts`, which is a stopgap the session should replace. If you find
   yourself typing a number of milliseconds into a call site, the policy is
   missing a case; add the case.

3. **`link.request`'s `validate` is the extension point everything else wants.**
   4-way ACK checking already goes through it, and it is where "an MSP reply must
   echo its command", "a read that returns 1 byte is a failed read" and block 6's
   write-verify all belong: a `validate` rejection is retried exactly like a
   timeout, with the drain in between, so you get retry-on-bad-data for free
   instead of writing another loop. Do not add a second retry loop above the link
   — that is how the double drain happened the first time.
