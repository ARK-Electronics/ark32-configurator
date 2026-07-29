# Block 1b — Protocol core extraction

Landed on `master` on top of `1b31d9c`:

| Commit | What |
|---|---|
| `24f197d` | `feat(core): add eeprom codec, MSP and 4-way framing to am32-core` |
| `f57c29b` | `refactor(app): move protocol code into am32-core and drop @am32/serial-msp` |
| `dd62059` | `style(core): use named exports and named fast-check imports` |
| `41ee527` | `fix(esc): read the layout revision from the ESC's own eeprom byte` |
| `4622003` | `fix(core): drop unparseable RX bytes instead of buffering them forever` |
| `f212e65` | `fix(ui): gate the two min-revision-3 fields the codec now hides` |
| (this file) | the handoff note |

## Verification

```
yarn verify                                → exit 0  (lint 0 errors / 23 warnings, typecheck:core + typecheck:app clean, 93 tests in 5 files)
bash scripts/assert-deleted.sh             → exit 0  (13 assertions, all clear)
yarn build                                 → exit 0  (see the block-1a warning about this)
./run.sh --no-browser                      → dev server up, GET /configurator 200, vue-tsc 0 errors
done-when (the four tests from STATUS.json) → exit 0
```

Test counts by file: `eeprom/codec.prop.test.ts` 19, `framing/msp.test.ts` 36,
`framing/fourway.test.ts` 28, `hex.test.ts` 7, `index.test.ts` 3.

**Lint dropped 27 → 23 warnings, still 0 errors.** Note for whoever keeps the
count honest: the 27 were *not* all `no-console`. 25 were, plus one
`no-use-before-define` and one `no-useless-constructor`, both in
`four_way.ts` and both pre-existing. The extraction also surfaced 20 new
`import/no-named-as-default*` warnings (eslint-plugin-import could not build an
export map through `@am32/serial-msp`, so the rule had been silently skipping
several files); `dd62059` cleared them by dropping the default exports from the
new core modules and importing `fast-check` by name. **`am32-core` has named
exports only — do not add `export default` to a core module.**

## The tests went red first, and here is the proof

For the codec I transcribed the old `buffer-to-settings` / `object-to-settings-array`
pair back into `codec.ts` and ran the new property test against it. Eight tests
failed, including the audit's exact reproduction:

```
× audit A > round-trips can_node 0x20 and filter_hz 0xC8 exactly
  → expected [1, 1, 10, 1, 253, 0, 1, 253] to deeply equal [32, 1, 1, 10, 1, 200, 0, 1]
× audit A > leaves every byte except the edited field untouched
  → expected [13, 14, 15, 16, 23, 176, 178, …(13)] to deeply equal [23]
× audit A > decodes CAN_SETTINGS as bytes, never a string
  -> expected a JS string (the UTF-8 decode of the CAN block) to be an instance of Uint8Array
× eeprom codec round-trip > decode -> encode is byte-identical (property failed after 1 test)
```

That differing-offsets list is the audit's `13,14,15,16,176,178,...` verbatim.
The legacy transcription was then reverted; it is not in the tree.

For MSP the four audit-D cases live in the `audit D: what the old parser got
wrong` describe block, each annotated with what the old parser did with that
exact byte sequence.

**4-way framing had to stay bit-identical, and I checked that separately.** I
transcribed the old `makePackage` / `parseMessage` / `crc16XmodemUpdate` from
`1b31d9c` into a throwaway test and compared them against the core over 2000
random requests (random command, address, and 1-256 random params) and 2000
random responses: byte-identical encodes and field-identical parses, including
the 256-params-as-0 case. That test is **not** in the tree -- it asserts against
code this block deleted, so it would rot immediately. If you need to redo it
after moving this code, it is twenty lines and worth the twenty lines.

## What I built

**`packages/am32-core/src/eeprom/{layout,codec}.ts`.** `EEPROM_SIZE = 192`.
`decodeSettings(buffer, layoutRevision)` → single-byte fields as numbers,
`STARTUP_MELODY` as `number[]`, everything else (today only `CAN_SETTINGS`) as an
opaque `Uint8Array` **copy**. `encodeSettings(base, settings, layoutRevision)`
starts from a copy of the ESC's read-back image and overwrites only named,
version-applicable fields, so reserved bytes 13-16, the CAN block at 176-183 and
`can.reserved` at 184-191 all survive. `patchSettings(base, patch, rev)` is the
read-modify-write convenience.

**`packages/am32-core/src/framing/msp.ts`.** v1 (incl. jumbo) and v2 encode, a
streaming `MspParser` that resynchronises past garbage and counts (rather than
throws on) checksum failures, `parseMspResponse(data, {expectCommand,
allowErrorFrames})`, `isCompleteMspFrame` / `isMspRequest` probes, `crc8DvbS2Data`.

**`packages/am32-core/src/framing/fourway.ts`.** `encodeFourWayRequest`,
`parseFourWayResponse`, `isCompleteFourWayFrame`, CRC-16/XMODEM, the command and
ACK enums.

**`packages/am32-core/src/{mcu,hex}.ts`.** The `Mcu` variant table and helpers
(minus `LAYOUT_SIZE`), `createMcuInfo(params)` replacing `Flash.getInfo`, and the
Intel-HEX parser / image filler.

**App side.** `src/eeprom.ts`, `src/mcu.ts`, `src/flash.ts`,
`utils/buffer-to-settings.ts` and `utils/object-to-settings-array.ts` are
**deleted**; `Hex`, `HexData` and `FourWayResponse` are gone from `nuxt.d.ts` and
now come from the core. `Msp` and `FourWay` are thin Serial plumbing over core
framing. `McuInfo.layoutSize` is gone.

## Design decisions a later block could accidentally undo

1. **`webserial-wrapper` is now a direct dependency in `package.json`.** It was a
   phantom that only reached `node_modules` through `@am32/serial-msp`; dropping
   that package would have broken `stores/serial.ts` and `src/communication/serial.ts`,
   which import it directly. Block 2 deletes it properly along with the transport.
   It resolved offline from the Yarn global cache — no registry access needed.

2. **`src/communication/serial-transport.ts` is a deliberate stopgap.** It is a
   like-for-like reimplementation of `@am32/serial-msp`'s `SerialTransport`, bugs
   and all (audit **E**: no mutex, one `ondata` handler, the dead
   `read()` that grabs a second reader). **Do not fix it in place — block 2
   replaces it with `packages/am32-web` + the core `Link`.** The one thing that
   did move is packet-boundary detection: the probes come from
   `am32-core/framing/*`, so web and CLI cannot disagree about when a frame ends.

3. **`isCompleteMspFrame` uses `>=`, not `==`.** The old
   `isMspPacketComplete` required the buffer length to *equal* the frame length,
   so two frames arriving in one chunk never satisfied the probe and the exchange
   timed out. The new probe fires on the first complete frame and
   `parseMspResponse` picks the one whose command matches. Keep it that way when
   the link layer takes over.

4. **`STARTUP_MELODY` decodes to `number[]`, `CAN_SETTINGS` to `Uint8Array`.**
   Not an accident: the RTTTL editor in `SettingField.vue` writes
   `Array.from(buffer)` back into the settings object, so a typed array there
   would be inconsistent with what the UI produces. `encodeSettings` accepts
   either representation for any multi-byte field. `NUMBER_ARRAY_FIELDS` in
   `layout.ts` is the single place that decides.

5. **`encodeSettings` throws unless `base.length === 192`.** That is the guard
   that makes a truncated read impossible to write back. `decodeSettings`, by
   contrast, is tolerant of short buffers (it skips fields that do not fit) —
   that is what makes loading a 48-byte default-config file or an old 184-byte
   dump do the right thing: the fields the file does not contain are left alone
   on the ESC.

6. **`FOUR_WAY_COMMANDS` / `FOUR_WAY_ACK` / `FourWayResponse` are re-exported
   from `src/communication/four_way.ts`.** Components import them from the app
   facade, not from `am32-core/framing/*`, so block 5's `no-restricted-imports`
   rule will not have to fight `SerialDevice.vue` over them.

7. **`cmd_DeviceVerify = 0x40` was added to the command enum.** Both firmwares
   implement it (BF `serial_4way.c:263`, AP `blheli_4way_protocol.h:112`); the
   app's enum stopped at `0x3F`. Nothing calls it yet — block 6's flash verify is
   the obvious first user.

8. **Version gating is now actually on** — see the behaviour changes below.

## Behaviour changes on real hardware (read this before block 4's checkpoint)

None of these are cosmetic. If a hardware checkpoint misbehaves, start here.

- **The settings read is 192 bytes, not 184.** `cmd_DeviceRead` param count 192,
  still inside the firmware's 256 limit and inside the eeprom page on every
  variant. The write is likewise 192 bytes in one `cmd_DeviceWrite`.
- **Every write is byte-preserving.** "Save", "apply config file" and "apply
  defaults" all now leave the CAN block intact. Previously *apply defaults* was
  the worst offender: the default `.bin` served from MinIO is 48 bytes, so the
  old decoder produced `CAN_SETTINGS === ''` and the old encoder space-filled
  bytes 176-191 with `0x20`.
- **Version gating went from disabled to enabled** (`41ee527`). `getInfo` used to
  pass `info.settings.LAYOUT_REVISION` into the decoder *before* `info.settings`
  was populated, so the argument was `undefined` and every `<` / `>` comparison
  against it was false. It now passes byte 1 of the read-back image. On ARK
  hardware this changes nothing — `ark-release` writes `eeprom_version = 3`
  (`Inc/version.h:14`) — but on a layout-revision-2 ESC the eight fields at
  0x05-0x0C (`MAX_RAMP` … `ACTIVE_BRAKE_POWER`) now decode as absent and render
  blank instead of showing bytes that meant something else. That is correct: the
  firmware overwrites those bytes with defaults on the v2→v3 upgrade path
  (`Src/settings.c:23-36`), so editing them on a v2 ESC never did anything.
  `f212e65` gates the two UI controls that were missing a version guard
  (`ACTIVE_BRAKE_POWER`, `DISABLE_STICK_CALIBRATION`) so they disappear on a v2
  ESC instead of rendering blank and dropping edits.
- **An MSP reply whose command does not echo the request is now rejected.** The
  one place this bites in practice is ArduPilot's failed `MSP_SET_PASSTHROUGH`,
  which replies with the command field set to `0x0F` (`AP_BLHeli.cpp:593-595`,
  an `ACK_D_GENERAL_ERROR` leaking out of the 4-way enum). Before, that frame was
  returned as data and the caller did `data.getUint8(0)` on a zero-length
  payload, i.e. it threw a `RangeError` anyway. Now it throws
  `MspFrameError('echo')` with a useful message.

## Where the plan was wrong, stale, or incomplete

- **The plan's audit-D note says the published `dist/` is useful "only as a
  cross-check for wire compatibility". It is not available for that any more** —
  removing the dependency removes the package. I read it before removing it, and
  the summary is: its v1 encoder and XOR checksum agree with mine; it had no v2
  parse, no jumbo, no echo check, and it accepted `!`. Nothing worth preserving.
  If a later block wants the cross-check, the golden vectors in the two framing
  test files are the durable version of it.

- **Audit D's "MSP v1 length 255 / jumbo frames are unhandled" is real but
  unreachable on this link.** Neither Betaflight nor ArduPilot can *decode* a
  jumbo frame on a serial port — both reject any size over the 192-byte input
  buffer before they look at the `0xFF` marker (`msp_serial.c:184-186`,
  `AP_BLHeli.cpp:221`) — and ArduPilot's BLHeli passthrough handler is **MSP v1
  only** (`AP_BLHeli.cpp:195-245`), so it will never send us `$X` either. Both
  are implemented and tested because the plan asks for them and because
  `packages/am32-sim` and the Betaflight path may exercise them, but do not
  expect a real ARK FPV to produce either frame type.

- **The plan's simplification claim for the codec ("zero fields with `size === 2`",
  "the 16-bit big-endian branch is dead code") checks out.** There is a test
  asserting it (`layout invariants > has no two-byte fields`) so that a future
  two-byte field forces an explicit endianness decision instead of silently
  inheriting the old dead branch.

- **`assert-deleted.sh` was not extended.** Block 1b's done-when is its own four
  commands and `assert-deleted` is block 5's to extend; the symbols this block
  removed (`LAYOUT_SIZE`, `bufferToSettings`, `objectToSettingsArray`,
  `@am32/serial-msp`) have no assertions. If you want them gated, block 5 is the
  place, and the `! grep -q '@am32/serial-msp' package.json` clause in
  `STATUS.json` already covers the dependency.

- **`STATUS.json` was swept into `f57c29b`.** I did not edit it — the driver's own
  `status: in-progress` edit was uncommitted when I ran `git add -A`. The content
  is exactly what the driver wrote.

## Plan line references that had drifted

Everything block 1b touched, re-verified against `1b31d9c` before use:

| Plan said (`4094dad`) | Actually |
|---|---|
| `src/eeprom.ts:201` `CAN_SETTINGS` at `0xB0` size 16 | correct at `1b31d9c`; now `packages/am32-core/src/eeprom/layout.ts` |
| `src/mcu.ts:80` `LAYOUT_SIZE = 0xB8` | correct at `1b31d9c`; deleted |
| `utils/buffer-to-settings.ts:26-27` UTF-8 decode + trim | correct; deleted |
| `utils/object-to-settings-array.ts:6,34` `0xFF` fill + `charCodeAt` | correct; deleted |
| `four_way.ts:359-361` `write()` passing the caller's 200 ms straight to `sendWithPromise` | **now `:279-281`** (the file lost 76 lines) |
| `four_way.ts:399-434` `writeSettings` | **now `:319-358`** |
| `four_way.ts:255` `async` executor passed to `new Promise` (audit **G**) | **now `:207`** (`:248` builds the promise) — still there, block 2 owns it |
| `four_way.ts:258` drain + `serial.ts:101` drain (double drain) | **now `:210`** and `serial.ts:108` — both still there |
| `stores/serial.ts:2` imports `webserial-wrapper` | correct, unchanged |
| `src/communication/serial.ts:1` imports `webserial-wrapper` | correct, unchanged |
| audit **A**'s `EEprom_t` layout | verified against `~/code/ark/AM32/Inc/eeprom.h` by a subagent that compiled the struct: `sizeof == 192`, CAN 176-183, `can.reserved` 184-191, `reserved_eeprom_3[4]` at **13-16** (the header comment `//13-16` is right; `Src/settings.c:32`'s `//14-16` is stale) |

Firmware facts worth not re-deriving:

- **4-way response CRC covers the ACK byte** — everything except its own two
  bytes (`AP_BLHeli.cpp:620` computes over `len + 6`). There is a test for it.
- **A 4-way reply never carries zero params.** Minimum is 1.
- **MSP v1 checksum covers bytes 3..(4+size)**, i.e. size, command and payload —
  not `$`, not the magic, not the direction char. Jumbo additionally covers the
  `0xFF` marker and both little-endian length bytes.
- **`crc8DvbS2` is poly 0xD5, init 0**; the v2 CRC covers the five header bytes
  plus the payload.
- **AM32 byte 0x02 (`BOOT_LOADER_REVISION`) cannot be written from the host.**
  The bootloader force-overwrites it with its own version inside every EEPROM-page
  write: `AM32-bootloader/bootloader/main.c:503-533`,
  `if (address == EEPROM_START_ADD && payload_buffer_size > 2) payLoadBuffer[2] = BOOTLOADER_VERSION;`.
  Two consequences. `four_way.ts`'s "bootloader version unset, setting to 1"
  write has never had the effect it claims — block 6 drops it. And **block 6's
  read-back verification must exempt byte 2**, or every settings write will fail
  verification.
- **A settings write must always be the full 192 bytes from the page base.** The
  write erases the whole 1-2 KiB page first (`Mcu/*/Src/eeprom.c`), so a partial
  sub-range would program without erasing and fail the bootloader's own `memcmp`.
  192 clears every alignment gate in the MCU families (8-byte on l431, 4-byte
  elsewhere, and CH32V203's `length + (addr & 0xFF) <= 256`).
- **Writing 0x05-0x0C without also setting byte 1 to 3 is a no-op**: the firmware
  replaces those bytes with hardcoded defaults on boot whenever
  `eeprom_version < 3` (`Src/settings.c:23-36`) and then persists them.

## Outstanding

- 🔧 **Hardware checkpoint not run — nothing is plugged in.** The behaviour
  changes listed above are all reachable on the first real connect. The highest
  value single check: connect to an ARK FPV, enumerate, confirm the settings read
  now returns 192 bytes, change one field, save, and read back — bytes 176-183
  must be unchanged. That is block 6's checkpoint, but the read half of it is
  live as of this block.
- **`getInfo` does not validate the length of the settings read.** ArduPilot
  answers a failed `cmd_DeviceRead` with a param count of 1 and an
  **uninitialised stack byte**, and on the `BL_SendCMDSetAddress` failure path it
  does so with `ACK_OK` (`AP_BLHeli.cpp:1095-1105`, `:760-765`). So a short read
  can look like success. Today the damage is contained — `encodeSettings` throws
  rather than writing a truncated image — but the right fix is a `validate` in
  the link layer: **if you asked for N > 1 bytes and got 1 back, it is a failed
  read regardless of the ACK.** That belongs to block 2 (`link.request`'s
  `validate`) or block 4. Betaflight is deterministic here (`0x00` plus a real
  error ACK), so only ArduPilot needs the rule.
- ⚠️ **Block 2's own done-when grep does not cover `package.json`.** The plan's
  command is `grep -rn "webserial-wrapper" components pages stores src packages
  yarn.lock` — and `webserial-wrapper` is now a *declared* dependency, so that
  grep can come back empty while the dependency is still in the manifest.
  **Block 2 must remove it from `package.json` too and re-run `yarn install`.**
- **`@am32/serial-msp` is gone; `webserial-wrapper` and `queue` remain** — blocks
  2 and 5.
- **Three MSP call sites in `SerialDevice.vue` have no `.catch`** (`:607`, `:612`,
  `:617`, plus the passthrough await at `:623`). Now that an `!` frame and an echo
  mismatch are rejected instead of being returned as data, a `$M!` reply to
  `MSP_FC_VARIANT` fails the whole connect where it used to log
  `Unknown fc type ''` and carry on. No FC in the two trees errors that command,
  so this is close to theoretical — but block 4's `connect()` is where it gets
  handled deliberately, and it should surface "passthrough setup failed" rather
  than an unhandled rejection.
- Audit items **B**, **C**, **E**, **G**, **H** are untouched by design, and
  `four_way.ts` still carries all of them. See the drift table for where they
  moved to.

## Three things I would tell the next agent

1. **The core is now the only place framing lives, and its tsconfig will fight
   you.** `packages/am32-core` has no `dom` lib and `types: []`, so `TextDecoder`,
   `Buffer` and `setTimeout` are compile errors there — that is how block 2's
   injectable `Clock` gets forced to exist rather than being a nice idea. If you
   reach for one of them, the code you are writing is a transport, not a protocol.

2. **`src/communication/serial-transport.ts` is scaffolding with a demolition
   date.** It exists only because dropping `@am32/serial-msp` took the transport
   away with the parser. Every defect audit **E** lists is still in it, on
   purpose. Block 2 should delete the file, not edit it.

3. **Re-derive by symbol, not by line — including from this note.** `four_way.ts`
   lost 100 lines in this block and block 2 will move the rest of it. What is
   stable is the firmware: the offsets, CRCs and ACK semantics recorded above were
   read out of AM32, Betaflight and ArduPilot with subagents, and the golden
   vectors in the three test files pin them. Trust those over any line number,
   including mine.
