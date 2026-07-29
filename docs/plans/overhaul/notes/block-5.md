# Block 5 — UI as a thin client

Landed on `master` on top of `e217035`:

| Commit | What |
|---|---|
| `68c429f` | `feat(core): add writeSettings and flash to Am32Session` |
| `003509c` | `refactor(app): drive the UI from Am32Session and delete the legacy stack` |
| `c611a25` | `test(gate): make the session the only door into the core from Vue` |
| `303dcd4` | `test(core): pin the flash ceiling at the EEPROM page` |
| `efe7010` | `test(core): cover the flash of an ESC with no readable firmware name` |
| `427b000` | `fix(app): keep a not-connected click out of the unhandled-rejection path` |
| `457f4c8` | `docs(testing): record what block 5 changed on the wire and what the app layer is not tested by` |
| `bf42d2f` | `refactor(store): drop the write-only settingsDirty flag (audit item I)` |
| (this file) | the handoff note |

## Verification

```
yarn verify                          → exit 0  (lint 0 errors / 10 warnings, typecheck:core + typecheck:app clean, 296 tests in 16 files)
done-when (STATUS.json block 5)      → exit 0
  grep -q 'no-restricted-imports' .eslintrc.json && bash scripts/assert-deleted.sh
      30 assertions, all clear
bash scripts/assert-core-hygiene.sh  → exit 0
bash scripts/assert-fault-coverage.sh→ exit 0
yarn build                           → exit 0   (block 1a's warning: this is the only thing that catches a dangling import in app.vue)
yarn install --immutable             → exit 0   (the queue dependency is out of package.json and the lockfile)
./run.sh --no-browser                → dev server on :3067, GET /configurator 200
```

Test counts: 278 → **296**. The new file is
`packages/am32-sim/src/integration/write-and-flash.test.ts` (18).

**Lint dropped 19 → 10 warnings, still 0 errors.** The nine that went away were
`no-console` calls and two structural warnings in the deleted `four_way.ts`, plus
one debug `console.log` in `SerialDevice.vue`. Nothing in `packages/` or in the
new app code writes to the console.

Dev-server check, which is block 2's standing advice and still the only thing that
catches a broken Vite alias: `/_nuxt/composables/useEscSession.ts`,
`/_nuxt/packages/am32-core/src/session.ts`,
`/_nuxt/packages/am32-web/src/web-serial-transport.ts`,
`/_nuxt/components/SerialDevice.vue`, `/_nuxt/stores/serial.ts` and
`/_nuxt/app.vue` all 200, with `Am32Session`, `WebSerialTransport` and
`flashTargets` present in the transformed output. `grep -rl am32-sim .output/public`
after a build is **0** — the simulator stays out of the client bundle.

`components/SerialDevice.vue`: 945 → **758** lines, and the 187 that went are all
of the protocol code; what is left is the template (355 lines of it) plus store
mirroring. `composables/useEscSession.ts` is 377 lines and is the app's entire
protocol client.

## The thing you most need to know

**Block 4 said `writeSettings` and `flash` were "absent, not stubbed" and belonged
to block 6. They are in `Am32Session` now, and they had to be.** The reason is
structural rather than a change of mind:

- Block 5's job is to delete `src/communication/*`, and the plan says so.
- A `SerialPort` can be opened exactly once, and `Link` serialises exchanges with a
  mutex it owns. Two `Link`s over one transport have two mutexes and therefore no
  serialisation at all — the legacy stack and the session **cannot coexist on one
  port**.
- So the app's Save and Flash buttons had nowhere else to call. The plan's own
  block 5 text ("wraps the flash path so a failure surfaces as a toast") assumes a
  working flash path exists in this block.

What landed is a **behaviour-preserving move** of the code the app already ran,
plus three corrections the firmware settles (below). **Block 6 still owns exactly
what its text says it owns:** read-back verification, `applyDefaults`, and the
`slowBy(600)` flash test. See "What block 6 still has to do" at the bottom — read
that before assuming this block ate your work.

## What I built

**`composables/useEscSession.ts`.** The app's whole protocol client. It owns one
`Am32Session` for the life of a connection, mirrors its four event channels into
the pinia stores, and exposes seven operations (`connect`, `disconnect`, `readAll`,
`saveDirtySettings`, `applySettings`, `flashTargets`, `decodeSettingsFile`). Every
one of them catches, logs and toasts; none of them can throw out of a click
handler.

**`components/SerialDevice.vue`** is UI plus those calls. It contains no frame, no
timeout, no retry count and no FC-variant branch. `stores/serial.ts` and
`stores/esc.ts` are mirrors: `hasConnection` and `isFourWay` are derived from the
session's `state` events rather than poked by hand, and `escStore.count` is a
computed over `escData` rather than a counter that two places incremented.

**`Am32Session.writeSettings(target, patch)`** → `{ target, changed, settings,
image }`. Selects the channel, reads its current 192 bytes, encodes the patch onto
*that* image, writes it back in one `cmd_DeviceWrite` at the page base.

**`Am32Session.flash(target, hex, { allowMcuMismatch })`** → the post-flash
`McuInfo`. Parses the hex, checks its embedded firmware name against the target
channel's own, clears EEPROM byte 0, streams the application region in ascending
256-byte chunks, sets byte 0 back to 1, resets the ESC, waits
`Mcu.RESET_DELAY_MS` and re-reads it. Emits byte-counted `progress` events so the
modal has a real bar.

**`FourWaySession.write(address, data)`** — the missing 4-way primitive, with the
bootloader's three rules (even address, even length, erase only on a page-aligned
write, byte 2 stamped at the EEPROM base) written down where they are used.

**The ESLint rule** (issue #3 section 7.2) and **`assert-deleted.sh`'s** two new
sections.

## Design decisions a later block could accidentally undo

1. **The flash stops at the EEPROM page, not at the end of flash.** The app wrote
   pages `0x04..0x40`, i.e. 0x1000 to the end of a 64 KiB part, bounded only by the
   image length. The application region genuinely ends where the settings page
   begins: `AM32/Mcu/f051/STM32F051K6TX_FLASH.ld:43-46` gives `FLASH` = 27 KiB
   ending at 0x08007C00, with `FILE_NAME` (the 32-byte firmware name the
   configurator identifies an ESC by) as its last bytes at 0x08007BE0. The ceiling
   is `mcu.getEepromOffset()` and there is a test that no write address ever
   exceeds it. Do not "restore" the old bound.

2. **The page range is derived from the MCU variant, not hardcoded.** `begin` is
   `firmware_start`, which is 0x1000 on the F051 and the ARM64K part but **0x4000
   on the NXP one** — and the bootloader refuses anything below
   `APPLICATION_ADDRESS` outright (`AM32-bootloader/bootloader/main.c:443-446`), so
   the old hardcoded page 4 could never have flashed a 1506.

3. **The boot-byte bracket is 0x00 before the first page, 0x01 after the last, and
   the order is the point.** The bootloader jumps to the application only when
   EEPROM byte 0 is `0x01` **or `0xFF`** (`main.c:306-319`, `CHECK_EEPROM_BEFORE_JUMP`
   defaults to 1). So `0x00` is the only usable "there is no complete application
   here" marker — **do not use 0xFF for it**; 0xFF is deliberately allowed so that
   a power loss during the firmware's own `update_EEPROM()` page erase cannot trap
   a board. `EscView` renders a read-back 0x00 as "Flash was unsuccessful".

4. **The hex is checked against the *target* channel's firmware name.** The app
   compared every flash against `firstValidEscData` — ESC #1 — so flashing channel
   3 on a mixed board checked the wrong ESC. `flash()` reads the name off the
   channel it is about to write. An ESC whose name does not read back (fresh,
   bricked, half-flashed) **skips** the check with a warning rather than becoming
   unflashable: that board is exactly the one that needs flashing. Both halves have
   a test, and both mutate red.

5. **`writeSettings` builds its image from a fresh read, not from the caller's
   buffer.** It costs one extra 192-byte read per save and buys two things: a
   *patch* is a legitimate input, and a byte something else moved since the last
   enumerate is not silently reverted. The plan's rule is "build the outgoing buffer
   from the ESC's read-back `settingsBuffer`", and a fresh read is the unambiguous
   reading of it.

6. **`WriteSettingsResult` is not the plan's `EscSettings`.** The caller needs the
   192-byte `image` (the app mirrors it into `settingsBuffer`, which is what a later
   write starts from and what `EscView` reads the boot byte out of) and `changed`
   (the "no changed settings" log line the app has always produced). Returning only
   the settings object would have forced the app to re-read after every save.

7. **`labelled(target, work)` in `session.ts` replaced the ad-hoc wrapper in
   `readEscImpl`, and `selectTarget()` replaced the init-flash prologue.** Every
   per-channel failure now names its ESC and carries `SessionError.target`,
   including from `writeSettings` and `flash`. The reason and the ACK are lifted
   from the innermost `SessionError` because `Link` wraps `validate` rejections —
   block 4's design decision 3, unchanged and still load-bearing.

8. **Public methods take `exclusive()`; the `*Impl` methods do not.** Block 4's
   design decision 0, obeyed by the two new methods. `flashImpl` calls
   `readEscUnlabelled` rather than `readEsc` for exactly this reason (and to avoid
   double-prefixing the error message).

9. **The store's two connection flags are written in one place only** — the
   session's `state` event handler in `useEscSession`. The old code set
   `serialStore.isFourWay = true` by hand at four call sites, one of them *before*
   `MSP_SET_PASSTHROUGH` was known to have succeeded. If you need a new store field,
   derive it from an event; a field the session cannot produce will drift.

10. **`connect()` no longer enters passthrough.** The app's connect ended with
    `MSP_SET_PASSTHROUGH` + a 2 s settle whether or not the user ever pressed Read.
    Now `connect` identifies the FC and stops; `readAll`, `saveDirtySettings` and
    `flashTargets` each call `ensurePassthrough()`. On ArduPilot that also means the
    ESCs are not held in their bootloader for the whole session.

11. **`PHASE_LABELS` in the composable is a `Record<ProgressEvent['phase'], string>`,
    so adding a progress phase in the core is a compile error until the UI names it.**
    That is deliberate — it is the cheapest available substitute for a UI test.

12. **The ESLint rule restricts the `am32-core` barrel too, not just the
    subpaths.** `src/index.ts` re-exports `Link`, `MspParser` and every framing
    helper, so restricting only `am32-core/link` would have been a rule with a hole
    in it. Note the barrel needs `paths: [{ name: 'am32-core' }]` rather than a
    `patterns` group: `patterns.group` uses gitignore semantics, so the group
    `["am32-core"]` matches `am32-core/session` as well and blocks the one import
    the rule exists to permit. That cost me a round trip; the config now has both
    forms for a reason.

## What the diff review changed

<!-- REVIEW SECTION -->

## Mutate before you believe

Block 3's rule, block 4's habit. Every guard this block adds, broken on purpose
with the suite re-run. **Commit before you mutate** — block 4 lost an uncommitted
fix to `git checkout --`.

| Mutation | Result |
|---|---|
| `flash` streams to the end of flash (the app's `0x40`) | 1 failed |
| no boot-byte-down before the stream | 1 failed |
| `writeSettings` encodes onto a `0xFF` fill instead of the read-back image | 4 failed |
| `labelled()` drops the target, so a failure does not name its channel | 5 failed |
| `writeSettings` writes even when nothing changed | 1 failed |
| `flash` begins at address 0 instead of the firmware start | 7 failed |
| the ESC's name is read from channel 0 instead of the target | 1 failed |
| the "no name to check against" warning is dropped | 1 failed |
| `flash` skips the reset and the re-read | 1 failed |
| `flash` emits no per-chunk progress | 1 failed |
| `writeSettings` reports the pre-write image as what it wrote | 1 failed |
| a component imports `am32-core/link`, `am32-core/framing/msp`, the barrel and `am32-web` | 4 lint errors |
| a component imports `am32-core/session` (must stay legal) | 0 lint errors |
| `src/communication/msp.ts` comes back | gate exits 1, naming 3 assertions |
| the `queue` dependency comes back | gate exits 1 |
| a `deviceHandles` field comes back in the store | gate exits 1 |

Three consecutive `vitest run` invocations give identical results (296 passed), and
neither the core nor the simulator can read a wall clock, so there is nothing for
these to be flaky about.

**One mutation survived and it taught me something.** Passing `0` instead of
`target` to `checkImageMatchesEsc` changed nothing: that parameter only feeds the
error/log message, because the *read* acts on whichever channel `selectTarget`
selected. Block 3's "a check that looks load-bearing and never runs", in parameter
form. The behaviour I thought I was pinning is pinned — by the test that flashes
channel 1 on a board whose two ESCs have different firmware names — so what I did
was rewrite the mutation to actually re-select channel 0 (1 failed) and add a test
for the parameter's one real use, the "no name to check against" warning (also 1
failed). Both are in the table.

## Where the plan was wrong, stale, or impossible

- **Block 5 cannot leave `writeSettings` and `flash` to block 6.** The plan assigns
  the deletion of `src/communication/*` to block 5 and the write paths to block 6,
  and those two are incompatible for the transport-ownership reason at the top of
  this note. If the plan is ever rewritten, block 6's text should say "verify the
  write and flash paths block 5 moved" rather than "add them".

- **`no-restricted-imports` in a JSON eslintrc cannot carry a comment.** ESLint 8
  validates the config schema and rejects an unknown `overrides[].comment` key, so
  the rationale lives in the rule's `message` strings and in this note. Do not try
  to add a `comment` key back; if the rationale needs to be longer, the file has to
  become `.eslintrc.cjs`, and block 5's done-when greps `.eslintrc.json` by name.

- **The plan's `writeSettings(target, patch, opts?)` third parameter is absent.**
  Nothing needs it until block 6 adds `{ verify: false }` for the CLI's
  `--no-verify`. Adding a parameter later is source-compatible; shipping an ignored
  one is not honest.

- **The plan's `flash(target, image: HexImage, opts?)` takes a `hex: string`
  instead.** Both callers have a string (a `File.text()` in the browser, a file read
  in the CLI) and `parseHex` lives in the core, so parsing inside `flash()` removes
  the app's only remaining reason to import `am32-core/hex`. A `HexImage` overload
  is easy to add if block 7 wants to parse once and flash four ESCs.

- **Audit item **I**'s list is not quite the set of dead code that existed.**
  `Msp.read`, `Msp.encodeV1`/`encodeV2` and `crc8DvbS2Data` were already gone (block
  1b moved framing into the core, where those names are alive and correct). What was
  still dead and is now deleted: all of `commands.queue.ts`, `FourWay.sendWithCallback`
  / `writeAddress` / `verifyPages` / `writeEEprom`, `Msp.commandCount`,
  `stores/serial.refreshReader`, the whole `deviceHandles` record, `mspData`, and —
  not in the audit's list — the store-level `escStore.settingsDirty` flag, which was
  written in two places and read in none. `utils/{compare,enum-toString,
  mergeUint8Arrays,ascii-to-buffer}.ts` went with their only callers.

- **A `v-if="false && ...">` FC-info block in the template went too.** It rendered
  never and read the `mspData` record this block removes. If someone wants the FC
  variant and API version on screen, `serialStore.fc` carries them; that is a
  product decision, not a refactor.

## Plan line references that had drifted

Re-verified against `e217035`, this block's base.

| Audit | Plan said (`4094dad`) | At `e217035` | Now |
|---|---|---|---|
| **I** big-endian `MSP_MOTOR` read | `commands.queue.ts:107` | `:109` | file deleted; `FcInfo.motorCount` is `MSP_MOTOR_CONFIG` byte 6 |
| **G** `startFlash` no try/catch | `SerialDevice.vue:1044-1076` | `:833-865` | `:658-679`, and the release is in the composable's `finally` |
| **G** flash-modal wedge | `:107` | `:107` | `:107`, unchanged — `:prevent-close="escStore.activeTarget > -1"` |
| **C** `writeHex(i, hex, 200)` | `:1047` | `:840` (no timeout arg since block 2) | `session.flash`, no timeout parameter to pass |
| **B** enumerate loop | `:731-745` | `:637` | `session.enumerate()`, per-target results |
| **B** empty-settings deref | `:760-763` | `:667` | `:565`, over `!isError && data` only |
| **B** 2.19 `TIMING_ADVANCE` deref | `:778-779` | `:685` | `:582`, same guard |
| **H** 4.5 s ArduPilot wait | `:611-617` | `:545-551` | gone; `MspSession.connect` probes first |
| **E** `disconnectFromDevice` | `:828-855` | `:730-747` | `:539-541`, three lines |

The audit's app-side line references are now **all** obsolete: every site it names
either moved into `packages/am32-core` or was deleted. Block 6 and block 7 should
work from symbols in the core, not from `SerialDevice.vue` line numbers.

### Firmware facts this block established, so nobody re-derives them

Read with a subagent against the local checkouts. `AM32/` is `~/code/ark/AM32`
(`ark-release`); `AM32-bootloader/` is `~/code/ark/AM32-bootloader` (currently
checked out on **`master`**, not a release branch — worth knowing before trusting a
line number there).

- **EEPROM byte 0 gates the jump, and the accepted set is `{0x01, 0xFF}`**
  (`bootloader/main.c:319`, read at `:306`, guarded by `CHECK_EEPROM_BEFORE_JUMP`
  which defaults to 1 at `:51`). Two further gates follow: the application's stack
  pointer must be in RAM range and its reset vector inside
  `[APPLICATION_ADDRESS, +256K]` (`:328-345`). The application never writes byte 0 —
  `saveEEpromSettings()` (`AM32/Src/settings.c:255-258`) writes back all 192 bytes
  it loaded — so a 0x00 left there survives a boot and keeps the board in its
  bootloader, which is exactly the intended failure mode.
- **`FIRMWARE_RELATIVE_START` is 0x1000 for ARK's shipped F051 firmware.** It is
  0x4000 only for `MCXA153` or `DRONECAN_SUPPORT` (`bootloader/main.c:75-81`), and
  the bootloader Makefile defines `DRONECAN_SUPPORT=1` only for `_CAN`-suffixed
  targets (`AM32-bootloader/Makefile:105`). Corroborated by the app's linker script
  (`AM32/Mcu/f051/STM32F051K6TX_FLASH.ld:43`, vector table at 0x08001000) and
  `AM32/scripts/build_factory_image.py:31-33`. **This closes block 3's open
  question and `docs/TESTING.md`'s risk 3.**
- **The application region is 0x08001000–0x08007C00 exclusive** — 27 KiB
  (`STM32F051K6TX_FLASH.ld:43-46`), with `EEPROM` at 0x08007C00 (1 KiB) and
  `FILE_NAME` at 0x08007BE0 (32 bytes). The name block **is** in the `.hex` (a
  `.file_name` output section at `:143-149`, fed by
  `AM32/Src/motor_runtime.c:109`), it lives in the last application page
  (0x7800–0x7BFF), and an ascending page-aligned stream covers it.
- **`checkAddressWritable` is a bare lower bound** (`main.c:443-446`), enforced for
  `CMD_PROG_FLASH` at `:511` and `CMD_ERASE_FLASH` at `:621`. There is **no upper
  bound**, which is why streaming to the end of flash would have destroyed the
  settings page rather than being refused.
- **Erase happens only on a page-aligned write** (`Mcu/f051/Src/eeprom.c:34-44`,
  page size 0x400 at `:13`), programming is halfword-at-a-time (`:47-58`) and the
  function ends in `memcmp` (`:62`). Address and length must both be even
  (`:20-22`). `CMD_PROG_FLASH` does not advance the address pointer, so the FC sends
  `CMD_SET_ADDRESS` before every chunk; only a read resets it (`main.c:669`).
- **AM32's own bootloader updater retries a failed chunk from the *page base*, not
  from the chunk** (`AM32/Src/bootloader_update.c:78-108`). Our retry re-sends the
  same chunk, which is safe (reprogramming identical bytes into an already-erased
  page passes the `memcmp`) but is not the firmware's model. If block 6 sees flash
  failures on real hardware, that is the first thing to try.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** This is the
  accumulated checkpoint for blocks 1a, 1b, 2, 3, 4 and now 5, and block 5 is by far
  the largest single change to what a user's clicks do. `docs/TESTING.md` carries the
  full watch-list under "Checkpoint 1"; the additions this block made to it are the
  three highest-value things it can find:
  - **Connect no longer enters passthrough**, so the ESC cards stay empty until Read
    is pressed. Intended, but it is the first thing that will look broken.
  - **Every failure is now a toast plus a log line.** If something fails silently,
    that is a finding.
  - **A save costs one extra 192-byte read per ESC** (the fresh base). If a save is
    noticeably slower on four ESCs, that is why.
- **The app layer has no automated test at all.** `vitest.config.ts` collects
  `packages/**` only, so `components/`, `pages/`, `stores/` and `composables/` are
  covered by `vue-tsc`, `yarn lint`, `yarn build` and reading them. That is the
  reason the flash rules live in `session.flash()` rather than in the component, and
  the reason `PHASE_LABELS` is an exhaustive `Record`. Adding jsdom +
  `@nuxt/test-utils` is a harness decision blocks 1a, 2 and 5 have each declined to
  take unilaterally — written up in `docs/TESTING.md` under "What is *not* covered
  by `yarn verify`".
- **The UI half of audit **G** is verified by inspection, not by a test.** What *is*
  tested is the contract it depends on: a failed flash rejects promptly with the
  channel named and leaves the session usable (`write-and-flash.test.ts`, the
  `audit G:` suite). The `finally` that clears `escStore.activeTarget` lives in
  `useEscSession.flashTargets` rather than in the component so that it is an
  invariant of the operation instead of one call site's manners.
- **A stale session's events could still write to the stores** if a `disconnect()`
  overlapped a `connect()`. It cannot today — `connect()` awaits `disconnect()`
  first, and `disconnect()` drops the reference before it awaits — but nothing
  structurally prevents it. The fix, if it ever bites, is to hold the unsubscribe
  functions `session.on()` returns and call them in `disconnect()`.
- **`Transport` still has no error channel.** Flagged by block 2, inherited by 3, 4
  and now 5. An unplug mid-exchange still waits out the full timeout before the
  *next* attempt rejects with `closed`. Changing the interface touches `am32-web`
  and `am32-sim` together and is a decision someone should make deliberately.
- **The session mutex serialises `disconnect()`** (block 4's item, unchanged).
  Clicking Disconnect during an enumerate waits for that enumerate. The UI makes this
  slightly more visible now, because Disconnect is always enabled.
- **`escStore.expectedCount` is only refreshed where passthrough is entered.** If a
  later block adds an operation that enters passthrough by another route, mirror
  `session.escCount` there too or the chip row will be short.
- **Nothing enforces `noUncheckedIndexedAccess` on `am32-sim` or `am32-web`.**
  Block 3's open item, still open.
- **`docs/plans/overhaul/STATUS.json` carries the driver's own `in-progress` edit**,
  committed with this note because the block must leave no uncommitted changes. I
  did not author that line.

## What block 6 still has to do

Spelled out because this block moved into its territory and the boundary matters:

1. **Read-back verification in `writeSettings`.** It writes and returns; it does not
   verify. The verification must exempt **byte 2** — the bootloader force-overwrites
   it with its own version inside every EEPROM-base write
   (`AM32-bootloader/bootloader/main.c:517-524`), so a byte-for-byte compare of the
   whole image always fails there. Block 2's advice still holds: put it in
   `link.request`'s `validate` so a mismatch retries with a drain, rather than adding
   a second retry loop. `am32-sim` already pins the stamp
   (`esc.test.ts > stamps its own version over payload byte 2`).
2. **`applyDefaults(target, layoutRevision)`.** The app currently fetches the
   default `.bin` from `/api/eeprom/...`, decodes it with
   `useEscSession.decodeSettingsFile` and calls `writeSettings`. That works, but the
   CLI needs the same thing and should not reimplement the fetch.
3. **A verify pass in `flash()`.** `cmd_DeviceVerify` cannot help — AM32 answers
   `CMD_VERIFY_FLASH_ARM` with `brERRORCOMMAND` (`main.c:674-675`) — so it has to be
   a read-back compare, and the retry should probably restart at the page base the
   way the firmware's own updater does.
4. **Its two done-when tests.** Note that the first one — "a settings write leaves
   bytes 13–16 and 176–183 unchanged" — is **already satisfied** by
   `write-and-flash.test.ts > Am32Session.writeSettings > writes the edited field and
   leaves every byte it does not name alone`, which asserts the whole 192 bytes
   byte-for-byte against a simulated ESC with the audit's own CAN block. The second —
   a flash with `esc[n].slowBy(600)` — is **not**: there is a `slowBy(300)` test
   here, deliberately below block 6's number, because 600 ms with a verify read in
   the path is the case block 6 owns. Do not read the green gate as permission to
   skip the work in 1–3.
5. **Drop the `bootloader.version === 0xFF` auto-write** — already gone. It lived in
   the app's `getInfo`, which this block deleted, and `Am32Session.readEsc` never
   reproduced it. That line of block 6's text is done.

## Three things I would tell the next agent

1. **The transport is the constraint that decides where code lives.** One port, one
   `Link`, one mutex — which is why the app could not keep half a protocol stack
   while the session grew the other half, and why "block 5 deletes it, block 6
   replaces it" was never a possible ordering. When a block's scope looks
   contradictory, check what owns the serial port; that usually settles it.

2. **The rules that matter have to be enforceable, and the app layer cannot enforce
   anything.** Nothing under `components/` is tested by `yarn verify`. So the
   boot-byte bracket, the page range, the MCU-name check and the "no ESC prefix
   missing" labelling all live in `am32-core`, where the simulator can hold them
   down, and the app gets what is left: templates, toasts and a `Record` that fails
   to compile if a new progress phase goes unnamed. If you are about to put a rule
   in a `.vue` file, you are about to put it somewhere nothing will ever check it
   again.

3. **Mutate the *behaviour*, not the line.** Eight of my nine code mutations went
   red; the one that survived changed only an error message, and chasing it found
   both a parameter that was nearly decorative and a reachable path with no test at
   all. The gate mutations matter just as much: `assert-deleted.sh` greps comments
   too, so naming a deleted symbol in a doc comment fails the gate — and the ESLint
   `patterns.group` matcher has gitignore semantics, so the obvious way to restrict
   the `am32-core` barrel also blocks `am32-core/session`. Both of those would have
   shipped as "the gate passes" if I had not tried to break them.
