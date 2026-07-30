# Block 6 — Verified settings write and flash

Landed on `master` on top of `a63672c`:

| Commit | What |
|---|---|
| `e1043d2` | `feat(sim): add the silentWriteFailure fault knob` |
| `a66e18d` | `fix(core): raise the host timeout margin to the tolerance the plan requires` |
| `5a8fa0a` | `feat(core): verify writes by read-back, and add applyDefaults` |
| `4c79201` | `refactor(app): reset to defaults through the session` |
| `ecf8460` | `test(gate): require a test for the silentWriteFailure knob` |
| `777b049` | `test(core): pin the verify retry's granularity and its two boundaries` |
| `28bb851` | `fix(core): let the read-back arbitrate a rejected write, and retry the page` |
| `2ee44ce` | `test(core): pin the boot byte's verification and the page-attempt bound` |
| `3b61f8e` | `docs(testing): record what block 6 changed on the wire` |
| `3ab3ad2` | `fix(app): disable Apply while the default settings image is being fetched` |
| `b0e6259` | `test(core): pin the two preserved fields the review found untested` — the diff review's findings |
| this file | the handoff note |

## Verification

```
yarn verify                          → exit 0  (lint 0 errors / 10 warnings, typecheck:core + typecheck:app clean, 319 tests in 16 files)
                                       three consecutive runs, identical
done-when (STATUS.json block 6)      → exit 0
  bash scripts/assert-core-hygiene.sh && bash scripts/assert-fault-coverage.sh
      Injectable clock    ok
      webserial-wrapper   ok
      12 fault knobs, all with a suite named after them
bash scripts/assert-deleted.sh       → exit 0  (30 assertions)
yarn build                           → exit 0
./run.sh --no-browser                → dev server on :3067, GET /configurator 200, vue-tsc 0 errors
```

Test counts: 296 → **319**. All but one of the new tests are in
`packages/am32-sim/src/integration/write-and-flash.test.ts` (18 → 40); the other is
in `packages/am32-core/src/link/timeout-policy.test.ts`.

⚠️ **`yarn build` lied to me once and it is worth knowing how.** I chained it after
a `pkill` in one shell command; the build was signalled, exit code 144, and yet
`/tmp/build.log` ended with "✨ Build complete!" from far enough along that it looked
fine. The `.output/` I then inspected was **block 5's, from 17:57**, and every check
I ran against it was meaningless. `rm -rf .output && yarn build` and check the
chunk's mtime, not just the last line of the log.

After a clean rebuild: `grep -rl am32-sim .output/public` is **0** (the simulator
still stays out of the client bundle) and block 6's own strings are all in the
client chunk — `did not verify`, `built-in defaults`, `re-writing it from its base`,
and the 48-byte default image verbatim as `[1,3,1,1,35,160,4,0,10,100,...]`. The
dev-server check (block 2's standing advice, since `yarn verify` cannot see a broken
Vite alias) resolves both new core modules: `/_nuxt/packages/am32-core/src/bytes.ts`
and `.../eeprom/defaults.ts` both 200, with `DEFAULT_SETTINGS_IMAGE`,
`writeAndVerifyRange` and `applyDefaults` present in the transformed output.

### The two done-when tests, by name

| Requirement | Test |
|---|---|
| a settings write leaves bytes 13–16 and 176–183 unchanged | `Am32Session.writeSettings: read-back verification > leaves the CAN block and the reserved bytes alone across a verified write` (and block 5's `Am32Session.writeSettings > writes the edited field and leaves every byte it does not name alone`, which asserts all 192 bytes) |
| a flash with `esc[n].slowBy(600)` still succeeds | `fault knob: esc[n].slowBy(ms) -- a slow ESC must not fail a flash > block 6 done-when: flashes an ESC that answers 600 ms late, verify included` |

The first was already satisfied by block 5; what is new is that it is now the
*verified* write that is byte-preserving, and the test counts the exchanges (two
reads, not three) so that removing verification fails it.

The second **did not pass with the timeout table as block 2 left it**, and that is
the most consequential thing in this block. See "Where the plan was wrong" below.

## What I built

**Read-back verification, in one primitive.** `Am32Session.writeAndVerifyRange`
writes a range and reads it back. Both write paths go through it: the settings page
(192 bytes at the EEPROM base) and every 256-byte flash chunk.
`FourWaySession.verifyRange` is the exchange half — it reads and compares, and its
failure message names the first differing byte, its absolute address, what it reads
and what was written, plus how many bytes differ. A hardware checkpoint that only
learns "the write did not verify" has nothing to go on.

**One exempt byte, and the condition matters.** `BOOTLOADER_STAMPED_OFFSET` is 2. A
`CMD_PROG_FLASH` whose address is *exactly* `EEPROM_START_ADD` and whose payload is
longer than two bytes has `payLoadBuffer[2]` replaced with the bootloader's own
version (`AM32-bootloader/bootloader/main.c:517-525`).

**Page-granular retry for the flash**, bounded at four attempts —
`PAGE_WRITE_ATTEMPTS`, which is AM32's own `BL_MAX_PAGE_ATTEMPTS`
(`AM32/Src/bootloader_update.c:44`). A mismatch anywhere in a 1024-byte page
re-streams the whole page from its base, because that is the only write that erases
it.

**`applyDefaults(target, options?)`**, with AM32's own 48-byte `default_settings[]`
embedded in `packages/am32-core/src/eeprom/defaults.ts` — so a reset needs no
network. Six fields are preserved rather than written.

**`{ verify: false }`** on both `writeSettings` and `flash`, for block 7's
`--no-verify`. `WriteSettingsResult` gained `verified`, and with verification on its
`image` is now the **read-back**, not what the host sent.

**Two new fault knobs**, because the two ways a write can fail are different shapes:
`esc[n].silentWriteFailure` (accepted, nothing programmed) and
`esc[n].failingFlashCell` (one bit lost, so the bootloader's *own* memcmp rejects
it). Both are in `scripts/assert-fault-coverage.sh`.

**`packages/am32-core/src/bytes.ts`** — `bytesEqual` (moved out of `session.ts`),
`firstDifference` and `countDifferences`, with the exemption set part of the
comparison rather than something a caller filters afterwards.

**App side.** `useEscSession.applyDefaults(escNumbers, image?)`, and
`SerialDevice.vue`'s `applyDefaultConfig` is now a catalog fetch plus one session
call. `decodeSettingsFile` survives for the *user-supplied* config file path only.

## Design decisions a later block could accidentally undo

1. **The read-back is the arbiter of a rejected write. Do not make a non-OK ACK
   fatal again.** This is the subtlest thing in the block. A rejected write means one
   of two completely different things and **the reply cannot tell you which**: either
   the bootloader's own `memcmp` failed, so the page is partly programmed with bits
   that cannot be set back and only a re-erase repairs it — or the channel has gone
   away and the *flight controller* answered `ACK_D_GENERAL_ERROR` on the ESC's
   behalf. My first attempt tried to classify on `SessionError.ack`; it cannot work,
   because an unresponsive ESC produces an ACK too. So a rejected write now sends us
   to *look*: read works and mismatches → the ESC is alive, erase and rewrite; read
   fails too → the channel is gone, report the write's own error promptly; read
   matches → a spurious ACK, carry on with a warning. With `{ verify: false }` there
   is no arbiter, so a rejected write stays fatal.

2. **The flash retry granularity is the page, and the settings write is the whole
   page.** Both follow from the same firmware rule: a page is erased only by a write
   to its base (`Mcu/f051/Src/eeprom.c:34-44`) and flash can only clear bits. Retrying
   a 256-byte chunk into a page that was already programmed cannot repair it. Block 5
   left the chunk-level retry the link gives for free and recorded that it was not the
   firmware's model; this is the model, and `3b` in the mutation table is the test
   that fails if you resume at the failed chunk instead.

3. **`PAGE_WRITE_ATTEMPTS` sits on top of the link's ten, and both are needed.** The
   link retries an exchange that *failed*; this retries an exchange that *succeeded
   and did not take effect*. They are not redundant and neither is a substitute.

4. **`verified` is not `changed`.** A `changed: false` result is `verified: true` —
   the fresh read the patch was encoded onto is itself the proof the ESC holds those
   bytes. `verified: false` happens only when the caller opted out *and* something was
   written.

5. **`writeSettings` returns what the ESC holds, not what was sent.** With
   verification on, `image` is the read-back, so byte 2 carries the bootloader's real
   version. The app mirrors that into `settingsBuffer`, so the bootloader version
   `EscView` shows after a save is now correct rather than the host's guess. If you
   revert this to returning the sent buffer, the mutation table's row 13 goes red.

6. **`applyDefaults` preserves six fields and the list is load-bearing.**
   `DEFAULTS_PRESERVED_FIELDS` in `eeprom/defaults.ts` carries the reason for each.
   The one that is a real bug rather than tidiness: **the layout revision.** AM32's
   default image says 3, and writing 3 onto an older ESC makes the firmware's own
   migration `if (eeprom_version < EEPROM_VERSION)` skip
   (`AM32/Src/settings.c:23-36`), so fields the migration would have populated are
   read as whatever was in flash. The boot byte is the dangerous one: `0x01` on a
   half-flashed board claims a complete application exists.

7. **`DEFAULT_SETTINGS_IMAGE` is a transcription — do not tidy it.** It is AM32's
   `default_settings[]` verbatim, identity bytes included, so it can be diffed against
   its source. The exclusions live in `DEFAULTS_PRESERVED_FIELDS`, which is a policy
   with its own reasons.

8. **The defaults image is 48 bytes and short is correct.** `decodeSettings` omits a
   field that does not fit and `encodeSettings` writes only the fields it is given, so
   the ESC's melody, CAN block and reserved bytes are preserved *by construction*
   rather than by a filter. This is also why the served
   `/api/eeprom/<board>?version=N` files (the same 48 bytes) work unchanged.

9. **The melody is filled only if the image does not carry one** (`??=`). A 48-byte
   default has no melody and *apply defaults* has always cleared it: `tune[0] == 0xFF`
   is the no-melody marker (`AM32/Src/sounds.c:242`). A caller who hands over a full
   192-byte image with a tune in it keeps that tune.

10. **`applyDefaults` shares `writeSettings`'s single read.** `writeSettingsImpl`
    takes a `patchFor(base, layoutRevision)` callback rather than a patch, so
    `applyDefaults` gets the ESC's own revision to decode its image with, without a
    second `cmd_DeviceInitFlash` + 192-byte read. If you add a third caller, give it a
    `patchFor` too.

11. **Every public method still takes `exclusive()` and no `*Impl` does.** Block 4's
    design decision 0, obeyed by `applyDefaults`. `writeAndVerifyRange`,
    `writeSettingsPage` and `flashChunk` are all below the lock.

12. **The boot-byte writes are verified like any other write.** If the write that
    clears byte 0 silently does nothing, the whole safety property of the bracket is
    gone — the flash proceeds over a board that still claims to hold a complete
    application, so a failure part way leaves it booting half an image. This is the
    mutation that survived my first pass (row 11): the flash still failed, one page
    later, with the same reason and the same end state, so the test could not tell.

13. **`HOST_MARGIN_MS` is the knob for host-side slack, not the read floor.** See
    below; a floor big enough to absorb 600 ms erases the per-variant read keying at
    every payload up to ~200 bytes, including the 192-byte settings read.

## Where the plan was wrong, stale, or impossible

- **Block 6's `slowBy(600)` done-when was not satisfiable with block 2's timeout
  table, and this is the one place I changed a number rather than adding code.**
  `slowBy` is charged once per host-visible 4-way command (block 3's design decision
  1, which explicitly says block 6's done-when depends on it). With 600 ms charged to
  *every* exchange, two of a flash's exchanges did not fit: the 32-byte firmware-name
  read (derived ~300 ms, floored at 500) and `cmd_DeviceReset` (552 ms). Everything
  else already absorbed it, because their derivations are dominated by the FC's own
  500 ms / 3000 ms ACK budgets.

  I raised **`HOST_MARGIN_MS` from 250 to 700** (600 + 100 for the exchange itself).
  The argument, in order: `slowBy` is charged *outside* the ESC's operations
  precisely so it models latency in the path rather than ESC-internal time, and this
  constant is the named allowance for latency in the path — so at 250 the allowance
  was smaller than the tolerance the plan requires. It is the knob block 2's own note
  nominated ("if reads start timing out, raise `HOST_MARGIN_MS`"). And it moves back
  toward what real hardware is known to work with: the pre-overhaul app used a flat
  1500 ms for every 4-way read, block 2 took a 192-byte read down to 574–769 ms and
  flagged it as the single riskiest change in the overhaul with no hardware run since.
  It is now 1024 ms (ArduPilot) / 1219 ms (Betaflight).

  **I tried the read floor first (500 → 900) and reverted it**, because two existing
  tests in `timeout-policy.test.ts` failed and were right to: a floor that high
  exceeds the derived budget for every read up to ~200 bytes, so it erases the
  per-variant keying exactly where the app does most of its reading. That is recorded
  because the floor is the obvious place to reach for and it is the wrong one.

  What it costs: nothing on a healthy link, where the reply cancels the timer. A
  dead-but-connected channel takes ~45% longer to be declared dead. A channel that is
  simply absent is unaffected — it fails `cmd_DeviceInitFlash` on the 1000 ms
  interface floor.

- **Read-back verification does not do what the plan implies, and it is worth being
  precise.** The plan's framing is that a write must be *proven*. But the bootloader
  already proves its own writes: `save_flash_nolib` ends in a `memcmp`
  (`Mcu/f051/Src/eeprom.c:61-62`) and a mismatch becomes a bad ACK
  (`bootloader/main.c:527-528`), so **the ESC cannot lie about a programming
  failure**. The gap read-back closes is in the *flight controller*: `BL_WriteA`
  leaks `ACK_OK` when its final `BL_GetACK` times out
  (`AP_BLHeli.cpp:928-932`). So verification is not belt-and-braces over a
  lying ESC — it is coverage for one specific ArduPilot path, plus the retry
  information that lets a rejected write be classified at all (decision 1). That is
  the honest version, and it is what `esc[n].silentWriteFailure` reproduces.

- **The plan's `applyDefaults(target, layoutRevision)` positional parameter is an
  option here.** The right value is the ESC's own, read from the page the write is
  built on; a caller that has to supply it can get it wrong, and the app *did* — it
  clamped anything above 3 to **2** while the server clamped it to **3**.
  `options.layoutRevision` still exists for a caller decoding a known-older image.

- **`writeSettings`'s third parameter is now real.** Block 5 recorded it as
  deliberately absent until something needed it; `{ verify: false }` is that.

- **AM32 has no "default EEPROM on blank flash" path**, which I checked because it
  would have been the better source for the defaults. `default_settings[]`
  (`Src/DroneCAN/DroneCAN.c:294-300`) is used only for the DroneCAN factory reset,
  for `default_value` in GetSet responses, and to seed SITL. Its own comment says it
  is "based on public/assets/eeprom_default.bin in AM32 configurator" — i.e. the
  firmware copy and the configurator's served file have the same ancestor, which is
  what makes embedding it faithful rather than a second opinion.
  Also worth knowing: on truly erased flash `eeprom_version` reads `0xFF`, so
  `255 < 3` is false and **the firmware's migration does not run for a blank
  EEPROM** (`Src/settings.c:23`).

- **`cmd_DeviceVerify` remains unusable, as block 5 said.** AM32 answers
  `CMD_VERIFY_FLASH_ARM` with `brERRORCOMMAND` (`main.c:674-675`). Confirmed again
  this block; nothing in the core calls it.

- **The `bootloader.version === 0xFF` auto-write is gone**, as block 5 claimed. I
  verified rather than took it: nothing under `components/`, `composables/`,
  `stores/` or `packages/` writes on a read path, and the only remaining mentions of
  `BOOT_LOADER_REVISION` are the layout, the exemption constant, one read in
  `readEscUnlabelled` and comments. That line of block 6's text was already done.

## Plan line references that had drifted

Block 6 works from symbols in the core, as block 5 advised, so almost nothing here
depended on a line number. The ones I did re-verify, all with a subagent against the
local checkouts:

| Claim | Earlier note said | Actually, at this block |
|---|---|---|
| byte-2 stamp | `main.c:517-524` (block 5), `:517-525` (block 3) | **`:517-525`**, and the condition is `address == EEPROM_START_ADD && payload_buffer_size > 2` |
| `BOOTLOADER_VERSION` | 18 (block 3) | 18, `AM32-bootloader/Inc/version.h:5` |
| AM32's updater retry | `bootloader_update.c:78-108`, `off = page_base` at `:112` (block 5) | loop at **`:79-116`**, `off = page_base` at `:112`, bound `BL_MAX_PAGE_ATTEMPTS 4u` at **`:44`**, reason at `:99-104` |
| `checkAddressWritable` | `main.c:443-446`, call site `:511` | confirmed; **exactly two** call sites, `:511` (`CMD_PROG_FLASH`) and `:621` (`CMD_ERASE_FLASH`), no upper bound |
| even address/length | `eeprom.c:20-22` | confirmed; `page_size 0x400` at `:13`, memcmp at `:61-62` |
| melody marker | not stated | `tune[0] != ERASED_FLASH_BYTE` at `AM32/Src/sounds.c:242`; **`ERASED_FLASH_BYTE` is `0x39` on `MCU_CH32V203`** (`Inc/targets.h:2437`), where 0xFF would read as a melody |

### Firmware facts this block established, so nobody re-derives them

- **The byte-2 stamp is the *only* substitution anywhere on the write path.** Every
  write to `payLoadBuffer` in the bootloader is the `memset` at `main.c:454`, the
  verbatim copy at `:457`, and `payLoadBuffer[2] = BOOTLOADER_VERSION` at `:524`. The
  read path (`CMD_READ_FLASH_SIL`, `:631-672`) is a straight `read_flash_bin` with no
  EEPROM special case. **So for a 192-byte write at the EEPROM base followed by a
  192-byte read, exactly index 2 can differ.** The three magic addresses
  `0x20`/`0x21`/`0x22` are translations inside `CMD_SET_ADDRESS` only (`:554-562`);
  they never alter returned data.
- **A write shorter than three bytes is not patched** (`payload_buffer_size > 2`), and
  a *mid-page* write is not patched either — only an address exactly equal to the
  base. Neither case is reachable from this codebase, since a settings write must be
  the whole page, but it is why the exemption belongs to the settings-page write
  rather than to `verifyRange` in general.
- **`update_EEPROM()` (`main.c:875-935`, called at `:1250`) also rewrites byte 2 on a
  software reset**, but its early-out at `:888` accepts `BOOTLOADER_VERSION`, `0xFF`
  or `0x00`, so it does not perturb a freshly host-written page.
- **AM32's own updater verifies per chunk by `memcmp` immediately after the write, and
  retries from the page base**, bounded by 4 attempts per page, after which it
  abandons the *whole* update and leaves the running image reachable
  (`Src/bootloader_update.c:79-127`). It relies on the write-erases-aligned-page
  behaviour and never calls an explicit erase. Chunk 256, page 1024 — the same numbers
  this code uses.
- **`EEprom_t` is 192 bytes with byte 0 `reserved_0` and byte 2 `reserved_1`, and the
  firmware never assigns either** (`Inc/eeprom.h:8-75`). It does rewrite them
  byte-for-byte on every save, because `saveEEpromSettings` writes all 192 bytes it
  loaded (`Src/settings.c:255-258`). `tune[128]` is at 48–175, the CAN block at
  176–183, `can.reserved[8]` at 184–191.
- **`EEPROM_VERSION` is 3** (`Inc/version.h:14`), and the firmware persists a bumped
  revision itself in `main()` (`Src/main.c:312-318`).

## Mutate before you believe

Block 3's rule, block 4's and block 5's habit. Every guard broken on purpose with the
suite re-run. Committed first, every time — the two previous notes both lost work to
`git checkout --` and I did not want to make it three.

| Mutation | Result |
|---|---|
| settings-page verification skipped entirely | 7 failed |
| byte-2 stamp exemption removed | 1 failed |
| `verifyRange` never reports a mismatch | 8 failed |
| no page restart at all (a mismatch is fatal) | 4 failed |
| page retry resumes at the failed chunk, not the page base | 1 failed |
| a rejected write stays fatal (no read-back arbitration) | 1 failed |
| `PAGE_WRITE_ATTEMPTS = 1` (no verify retry) | 3 failed |
| `PAGE_WRITE_ATTEMPTS = 400` (bound removed) | **0 → assertion added, then 1 failed** |
| the boot-byte writes are not verified | **0 → assertion added, then 1 failed** |
| `isVerifyFailure` always true (a dead read re-writes) | 1 failed |
| `applyDefaults` writes the six preserved fields | 2 failed |
| `applyDefaults` hardcodes layout revision 3 | 2 failed |
| `applyDefaults` does not clear the melody | 1 failed |
| odd-length final chunk not padded | 2 failed |
| reports the sent image, not what the ESC holds | 1 failed |
| `HOST_MARGIN_MS` back to 250 | 1 failed |
| the knob's `describe('fault knob: …')` suite renamed | gate exits 1, naming the knob |
| `BOOT_BYTE` dropped from the preserved list | **0 → test added, then 1 failed** |
| `CAN_SETTINGS` dropped from the preserved list | **0 → test added, then 1 failed** |
| the exemption set widened to `{0,1,2,3}` (the reviewer's) | 1 failed |

**Five mutations changed the block, four of them by exposing a test that passed for
the wrong reason** (rows 8, 9, 18 and 19 — the boot-byte-verification one is the most
instructive: the flash failed either way, just one page later, with the same reason
and the same end state).

One found a real defect. **Changing the flash's page stride left the suite
green**, and chasing why exposed that the page-base restart only fired for a write
the ESC *accepted* and dropped — where the page is still erased and re-sending the
chunk would have worked anyway. The case the restart exists for, a chunk the
bootloader's own `memcmp` rejected, took the fatal path. Fixing it is `28bb851` and
it is where design decision 1 and the `failingFlashCell` knob came from. Block 3's
"a check that looks load-bearing and never runs", one layer up: the retry ran, but
never for the case it was written for.

One caveat on the gate, inherited and unchanged: deleting only a knob's *declaration*
from `esc.ts` still leaves its doc comment and helper, so the presence grep still
matches. Block 3 documented this; it is why the mutation table exists.

## What the diff review changed

A subagent reviewed the diff against block 6's done-when in a fresh context. It
confirmed every requirement, ran its own nine mutations (including two I had not
thought of — widening the exemption set to `{0,1,2,3}`, which goes red, so the
exemption's *narrowness* is pinned as well as its presence), and read
`writeAndVerifyRange` and `verifyRange` for defects, finding none. **It found five
real gaps, four of them in my tests rather than in the protocol logic**, all fixed in
`b0e6259`. The last row of the mutation table is the reviewer's, not mine.

1. **Two of `applyDefaults`' six preserved fields had no test at all.** Deleting
   `BOOT_BYTE` or `CAN_SETTINGS` from `DEFAULTS_PRESERVED_FIELDS` left all 317 tests
   green, and they were vacuous for opposite reasons: the simulated ESC's boot byte is
   `0x01` and so is the default image's, so `after === before` proved nothing; and
   every `applyDefaults` test used a 48-byte image, which has no CAN block for the
   patch to carry, so the `delete` was a no-op in all of them. These are the two
   *most* consequential exclusions in the list — the boot byte is the one that sends a
   half-flashed board jumping into an absent application, and the CAN block is audit
   item **A**'s own invariant. Now tested against a board whose boot byte is `0x00`
   and against a full 192-byte supplied image, which `ApplyDefaultsOptions` accepts.
   Both mutations now go red.

2. **`DEFAULTS_PRESERVED_FIELDS` was typed `readonly string[]`**, so a typo in any of
   the six names was a silent no-op. Now `readonly EepromLayoutKeys[]`, which makes
   the list self-checking. Good catch and worth generalising: a list of field names as
   strings is a list that can go stale without telling you.

3. **The page-granularity assertion was vacuous.** `>= 2` addresses at the page base
   is satisfied by *one clean pass*, because every chunk write is followed by a
   read-back at the same address. The reviewer proved it by hoisting the chunk cursor
   so a retry resumed at the failed chunk: the test stayed green. Now `>= 3`, with the
   arithmetic written down, and that mutation goes red in two tests.

4. **The `slowBy(600)` test's comment overclaimed.** It said the test would fail if
   the verify pass were bolted on with a literal timeout; in fact at
   `HOST_MARGIN_MS = 250` it fails inside `checkImageMatchesEsc` on the 32-byte
   firmware-name read, before a byte is written, with or without verification. The
   requirement is met and the test is not vacuous, but it pins "the whole path
   tolerates 600 ms with the read-backs in it", not the verify read's budget
   specifically — the verify reads have ~630 ms of slack. Comment corrected, and the
   test now also asserts the read count so that its participation is explicit.

5. **`SerialDevice.vue`'s second fetch hop was not status-checked, contradicting my
   own comment two lines above it.** A non-200 from the presigned URL — a missing
   object, an expired signature, an S3 error document — made that error body *become*
   the default settings image: decoded, written to the ESC, and then **verified**,
   because it was written faithfully. Pre-existing, but I rewrote that function and
   claimed both hops were checked. Now both are, and a failure falls through to the
   built-in defaults.

Two things it raised that I deliberately did not change:

- **`timeout-policy.test.ts`'s `< 1500` bound on a 256-byte flash page write now has
  46 ms of headroom** (it is 1454). It reads like a sanity bound and it still holds;
  tightening or loosening it would be inventing a number. Worth knowing before raising
  the margin again — that assertion is what will fail first.
- **`firstDifference` reports a mismatch at index `common` when the reply is *longer*
  than expected**, and `expectParams` only rejects short replies, so an over-long
  `cmd_DeviceRead` reply would cost four futile page re-erases. Unreachable from
  either firmware or the simulator (both cap params at 256 and echo the requested
  length), so adding a guard would be another check that looks load-bearing and never
  runs — block 3's rule. Recorded rather than fixed.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** This is block 6's own
  checkpoint (issue #3: settings round-trip across a power cycle with the CAN block
  intact, plus a local `.hex` flash) and it is now the accumulated one for blocks 1a
  through 6. `docs/TESTING.md` "Checkpoint 2" carries the full watch-list; this block
  added a third step (apply defaults must leave the CAN node ID and the firmware
  version alone) and these three things to watch:
  - **The highest-risk assumption in the block is byte 2's *index*, not its value.**
    The version number does not matter — byte 2 is exempt whatever it holds — but if
    a real ARK bootloader patches a second byte, **every settings save fails to
    verify**. The message names the byte, so this is diagnosable in one run.
  - **A flash now takes roughly twice as long**, because every chunk is read back.
    Expected, not a regression.
  - **A "re-writing it from its base" warning followed by success** is the page retry
    working. Worth knowing whether it ever fires on real silicon.
- **`slowBy(600)` charged to every exchange is not something hardware can do**, and
  the timeout change rests on it. An ESC that really took 600 ms to answer a 32-byte
  read would have blown the *FC's* own read budget (ArduPilot allows
  `req_bytes * 1000` µs) and the FC would report an error rather than a slow success.
  `slowBy` models path latency, which is why `HOST_MARGIN_MS` is the right home for
  it — but if a later block wants to model an ESC that is slow *internally*, that is
  a per-operation delay in `SimEsc`, not this knob, and the timeout argument would
  need redoing.
- **`progressIsIntermediate` in `SerialDevice.vue` references a `'Verifying'` step
  that no phase produces.** Pre-existing (it predates block 5's `PHASE_LABELS`), and
  now *almost* true: I deliberately did not add a `verify` progress phase, because it
  would flicker the modal's label between "Writing" and "Verifying" ~108 times over a
  flash for a cosmetic gain, and adding a `ProgressEvent` phase is a deliberate
  cross-layer change (block 5's exhaustive `Record` makes it a compile error until the
  UI names it — which is the point). If someone decides the doubled flash time should
  be legible to the user, that string is the hook and this is the decision to revisit.
- **The app layer still has no automated test at all.** Unchanged from block 5:
  `vitest.config.ts` collects `packages/**` only. This block added ~50 lines to
  `SerialDevice.vue` and ~53 to `useEscSession.ts`, all covered by `vue-tsc`,
  `yarn lint`, `yarn build` and reading them.
- **`am32-sim`'s `writeEepromSilentlySucceeds` is still wrong for an AM32 target**
  (block 5's finding: ArduPilot's `cmd_DeviceWriteEEprom` takes the `default:` branch
  for `imARM_BLB` and errors). Still unchanged, still harmless — no host path sends
  that command, and the *conclusion* both the flag and the comments draw is correct.
  I did not touch it because block 6 gave me no reason to and flipping it would leave
  dead config on both profiles.
- **`Transport` still has no error channel.** Flagged by block 2, inherited by 3, 4, 5
  and now 6. An unplug mid-exchange still waits out the full timeout — and those
  timeouts are now 450 ms longer, so this is marginally more visible than it was.
- **Nothing enforces `noUncheckedIndexedAccess` on `am32-sim` or `am32-web`.** Block
  3's open item, still open. The new `SimEsc` code was written to it by hand.
- **`docs/plans/overhaul/STATUS.json` carries the driver's own `in-progress` edit**,
  swept into `777b049` by a `git add -A` because the block must leave no uncommitted
  changes. I did not author that line.

## Three things I would tell the next block's agent

1. **When a failure can mean two things, go and look — do not classify the error.**
   The best code in this block is three lines: a rejected write is not fatal, it
   triggers the read-back, and the read-back decides. I first tried to tell "the
   bootloader refused this page" from "the ESC is gone" by inspecting
   `SessionError.ack`, and it cannot be done, because an unresponsive ESC makes the
   *flight controller* answer with an ACK on its behalf. Both firmwares collapse the
   two cases to one reply. The 4-way protocol is full of this shape — block 3 found
   it for reads (`ACK_OK` with one byte of stack), block 4 for the command echo — so
   when you are about to write a predicate over error reasons, check first whether one
   more exchange would just tell you the answer.

2. **A test that fails is not the same as a test that fails for the reason you
   think.** Four of the mutations run against this block survived a suite of forty
   tests, and in each case a test *did* fail when the feature was removed — one page
   later, or on a byte that happened to hold the same value, or on an image too short
   to contain the field. What fixed them was asserting *where* the failure happened,
   *how many* exchanges it took, and choosing fixture values that differ from the
   defaults. Two I found by mutating; **two the fresh-context reviewer found and I did
   not**, and they were the two most consequential exclusions in `applyDefaults`. If
   your assertion would still hold with the guard moved elsewhere — or if the expected
   value equals the value that was already there — it is pinning the symptom, not the
   guard. Do both passes; they find different things.

3. **Block 7 inherits three things from here, and one of them is a decision.** The
   plan gives the CLI `--no-verify`, which is `{ verify: false }` on `writeSettings`
   and `flash` — it is wired and tested, and `WriteSettingsResult.verified` tells you
   whether it was used, so `ark32 write` should report that rather than print
   "written" either way. `applyDefaults` needs no network, so `ark32 defaults` is one
   call with no fetch and no fixture. And the decision: `SessionErrorReason` now has
   **`esc-verify`**, which section 6's exit-code table does not cover. It is not
   `1` (partial) and it is not `2` (connect failure) — the ESC is healthy and the
   write is not. Pick a code deliberately and write down why.
