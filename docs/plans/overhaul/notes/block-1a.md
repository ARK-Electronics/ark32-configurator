# Block 1a — Delete removed features

Landed on `master` as three commits on top of `8f6d1f9`:

| Commit | What |
|---|---|
| `488800a` | `refactor(serial): delete USB-direct mode and bootloader flashing` |
| `1d25234` | `refactor(catalog): drop bootloader downloads` |
| `af97ffe` | `test(gate): close the holes in assert-deleted` |
| `b1c9bb8` | `fix(app): drop the dangling Direct import from app.vue` |

## Verification

```
yarn verify                    → exit 0  (lint 0 errors / 27 warnings, typecheck:core + typecheck:app clean, 3 tests pass)
bash scripts/assert-deleted.sh → exit 0  (13 assertions, all clear)
yarn build                     → exit 0
```

## ⚠️ Read this first: `yarn verify` does not catch dangling imports in `app.vue`

This bit me, and it will bite **block 5** harder.

After deleting `src/communication/direct.ts` I had `yarn verify` green — lint, both typechecks and tests all passing. `yarn build` was still **broken**:

```
Nuxt build error: RollupError: Could not resolve "./src/communication/direct" from "app.vue"
```

`app.vue` imports `Direct`, `FourWay` and `Msp` and calls `.init()` on each at module scope. Two independent reasons nothing caught it:

1. **`app.vue` is `<script setup>` with no `lang="ts"`**, so `vue-tsc --noEmit` does not typecheck it at all.
2. **`app.vue` is at the repo root**, outside `assert-deleted.sh`'s `SEARCH_DIRS` (`components pages server src stores utils layouts composables`).

Fixed in `b1c9bb8`, and the gate now searches `nuxt.d.ts`, `app.vue` and `run.ts` explicitly via a new `SEARCH_FILES` array. I verified the gate genuinely catches it by re-introducing the import and confirming `assert-deleted.sh` exits 1 on it.

**Block 5 deletes `src/communication/*` — that is `four_way.ts` and `msp.ts`, i.e. the other two imports `app.vue` still has.** You will hit exactly this, and `yarn verify` will tell you everything is fine. Run `yarn build` before you believe it, and rewire `app.vue`'s `Msp.init` / `FourWay.init` calls onto whatever replaces them.

Worth considering (block 0.5's harness territory, not mine to change unilaterally): either add `lang="ts"` to `app.vue` or add `nuxt build` to `yarn verify`. I did not do either — changing the gate definition mid-plan affects every remaining block and the driver, and that is a decision for whoever owns the harness.

## What I built

Pure deletion, no protocol work, exactly the three features in the plan.

**USB-direct mode.** `src/communication/direct.ts` is gone entirely, along with `usbDirectVendorIds`, `usbDirectDeviceIdExceptions`, `isDirectConnectDevice`, `serialStore.isDirectConnect`, and the direct branches in `connectToDevice`, `connectToEsc`, `writeConfig` and `startFlash`. The serial port picker now filters on `usbFCVendorIds` only, and `pages/configurator.vue` gates on `serialStore.isFourWay` alone. Audit item **F** dies with the file rather than being fixed.

**Bootloader flashing.** The `.amj` tab, its file input, its mcuType/pin guards and `AmjType` in `nuxt.d.ts`. `flashTabs` is now two entries (Release, Local).

**Bootloader downloads.** The `bootloader` section config and its entry in the default filter list in `server/api/files.ts`, the `bootloaders` Redis mount in `server/plugins/storage.ts`, the whole AM32-bootloader release sync in `src/fetch-and-upload-releases.ts`, and the `#bootloader_data` accordion plus its `sectionLabels` entry in `pages/downloads.vue`.

Bootloader **info display** stays, as the plan requires: `EscView.vue` still shows `mcu.bootloader.pin` / `.version`, and `Mcu.parseBootLoaderPin` plus the `BOOT_LOADER_REVISION` handling in `four_way.ts` are untouched.

## Design decisions a later block could accidentally undo

1. **`startFlash` is now a single flat 4-way loop.** It used to be `if (isDirectConnect) {...} else {...}`, and the surviving branch was unwrapped in place. Do not re-introduce a branch on connection type — there is only one connection type now. Block 6 rewrites this function anyway; keep it single-path.

2. **`connectToDevice` no longer branches before the ArduPilot wait.** The unconditional 4.5 s MSP-window wait survived deletion unchanged and is still audit **H**'s bug. Block 4 is the one that turns it into probe-then-wait. I deliberately did **not** touch it here — it is out of 1a's scope and changing it without the simulator would be unverifiable.

3. **`flashTabs` indices shifted.** Tab 2 no longer exists. `startModalFlash` handles `currentTab === 0` (release) and `=== 1` (local); the old `=== 2` (amj) branches in both `startModalFlash` and `startFlash` are gone. The "Start flash" `:disabled` expression still reads `currentTab > 0 && !fileInput`, which is correct for a two-tab set. If a later block adds a tab, re-check that expression.

4. **`assert-deleted.sh` grew four assertions** (`Direct`, `DIRECT_COMMANDS`, `amj`, `bootloader_data`). Block 5 is scheduled to extend this script further — extend it, do not rewrite it, and do not drop these.

5. **Nothing moved into `packages/am32-core`.** 1a is deletion only. `packages/am32-core` still contains just the block-0.5 skeleton.

## Where the plan was wrong or stale

- **The plan claims `assert-deleted.sh` "currently lists every site that must go". It did not.** Four real sites had no assertion and would have passed a broken implementation:
  - `Direct` / `DIRECT_COMMANDS` — the two symbols that actually leaked out of `direct.ts` into `SerialDevice.vue` **and `app.vue`**. Only the *path* was asserted.
  - The `.amj` file input in the flash modal. `AmjType` alone does not cover it — you can delete the type and leave the tab.
  - `pages/downloads.vue`'s `#bootloader_data` accordion. The gate asserts `bootloaders` (plural, word-matched); the downloads page uses the singular `bootloader`, so it never matched.
  - Its `SEARCH_DIRS` never covered root-level files, so `app.vue` was invisible to it — see the warning at the top.

  Fixed in `af97ffe` and `b1c9bb8`. The gate is now 13 assertions over 8 dirs + 3 root files, and is a real gate.

- **`CLAUDE.md`'s "36 `no-console` warnings" was correct at the start of this block and is now 27**, because this block deletes code that contained console calls. I updated it and added a line saying the count drifts down as blocks delete code — only "0 errors" is a gate. Expect it to keep dropping; do not treat a lower number as a regression.

- **Audit **H**'s `commands.queue.ts:107`** (the big-endian `data.getUint16(i)` motor-count read) is at **line 108**, not 107. That file has not been touched since `4094dad`, so the reference was off by one in the audit itself, not drifted.

- The plan's premise for deleting bootloader flashing checks out against the firmware, which I verified rather than assumed. `~/code/ark/AM32/Src/bootloader_update.c:46` `maybe_update_bootloader()` is called from `main.c:308` on every boot; `:56-58` `memcmp`s the 4 KiB at `0x08000000` against a bootloader image embedded via `.incbin` (`Src/bl_image.S:22-26`) and reprograms page 0 on any mismatch. **Caveat worth recording:** this is gated to F051 (`Makefile:187`, `filter F051`; `bootloader_update.c:24` `#if defined(EMBED_BOOTLOADER) && defined(MCU_F051)`). `src/mcu.ts` also knows `3506` (ARM64K) and `1506` (NXP). On those variants nothing self-updates the bootloader, and after this block the configurator can no longer flash one either. That is the plan's decision, not a bug I introduced — but if ARK ever ships a non-F051 board that needs a bootloader update, this is the block that removed the only path.

## Plan line references that drifted

`components/SerialDevice.vue` went from 1161 to 972 lines. Every audit reference into it has moved. Re-verified against `HEAD`:

| Audit | Plan said (`4094dad`) | Now |
|---|---|---|
| **B** enumerate loop | `:731-745` | `:657` (`for (let i = 0; i < escStore.expectedCount; ++i)`) |
| **B** empty-settings deref | `:760-763` | `:687` (`escStore.escData.filter(`) |
| **B** 2.19 `TIMING_ADVANCE` deref | `:778-779` | `:705` (`for (const esc of escStore.escData)`) |
| **C** short flash timeout | `:1047` | `:867` (`writeHex(i, hexString, 200)`) |
| **G** `startFlash` no try/catch | `:1044-1076` | `:863-892` |
| **G** flash modal wedge | `:107` | `:107` (unchanged) |
| **H** ArduPilot 4.5 s wait | `:611-617` | `:565-571` |
| **E** `disconnectFromDevice` | `:828-855` | `:750-777` |

Unchanged and re-verified (I did not touch these files): `src/mcu.ts:80` `LAYOUT_SIZE = 0xB8` ✓; `src/eeprom.ts:201` `CAN_SETTINGS` ✓; `stores/serial.ts:2` and `src/communication/serial.ts:1` import `webserial-wrapper` ✓.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** The block's done-when says "The app must still connect and enumerate after this block." I could not test that. What I did instead: `yarn verify` and `yarn build` both clean, and I diffed the surviving 4-way path statement-by-statement against `8f6d1f9` to confirm the unwrapped `else` branches are semantically identical. **Someone should connect to a real FC and confirm connect + enumerate still work before block 4's checkpoint**, so a regression from this block does not get blamed on later ones.
- The `queue` npm dependency and `commands.queue.ts` are still present — block 5's job, not mine.
- `@am32/serial-msp` and `webserial-wrapper` are still present — blocks 1b and 2.

## Three things I would tell the next agent

1. **`yarn verify` green does not mean the app builds.** `app.vue` is untyped and unreachable from both `vue-tsc` and the old gate, so a deleted module left a dangling import that only `yarn build` found. Run `yarn build` before you claim a deletion is complete. Block 5 deletes the other two modules `app.vue` imports and will hit this exactly.

2. **The gate lied, and the plan vouched for it.** `assert-deleted.sh` passed on things it did not actually check. When your block's done-when is a script, read the script and confirm it would *fail* on a half-done implementation before you trust it as your test — I re-introduced the regression and watched the gate go red before believing it.

3. **Every `SerialDevice.vue` line number in issue #3 is now wrong.** The file lost 189 lines. The table above has the current ones. Re-derive by symbol, not by line. And note the surviving 4-way path is verbatim the old `else` branch, bugs included (audit **B**, **C**, **G**) — I verified that statement-by-statement and deliberately fixed none of them, because they are blocks 4 and 6. Do not read the flat structure as "already cleaned up".
