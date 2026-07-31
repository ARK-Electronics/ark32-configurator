# `fixture.bin`

The 192-byte settings image issue #3's block-7 done-when names:

```
ark32 --sim write --esc all -i fixture.bin
```

`scripts/assert-cli-sim.sh` copies it into a temporary directory so that command
runs verbatim, and `packages/am32-cli/src/run.test.ts` reads it from here.

It is not arbitrary. Every byte below is planted so that the command is a real
test of what `write` does and does not touch, rather than a smoke test that
would pass on a no-op. A binary fixture nobody can read is a liability, so this
is the key.

| Offset | Field | Value | Why that value |
|---|---|---|---|
| 0x00–0x2F | AM32's `default_settings[]` | verbatim | The same 48 bytes the app serves from `/api/eeprom/<board>`, so the fixture is a realistic configuration file rather than an invention. Then overridden below. |
| 0x00 | `BOOT_BYTE` | `0x00` | **The dangerous one.** `0x00` is the bootloader's "there is no complete application here" marker (`AM32-bootloader/bootloader/main.c:306-319`). If `write` did not drop it, applying this file would leave a working ESC sitting in its bootloader. The simulated ESC holds `0x01`, so a test can prove it survives. |
| 0x01 | `LAYOUT_REVISION` | `2` | The subtle one. Writing a revision onto an ESC changes which fields the firmware's own migration populates (`AM32/Src/settings.c:23-36`). The simulated ESC is revision 3. |
| 0x02 | `BOOT_LOADER_REVISION` | `99` | Unwritable in any case: the bootloader replaces byte 2 with its own version inside every write to the EEPROM base (`main.c:517-525`). The simulated ESC reports 18. |
| 0x03–0x04 | `MAIN_REVISION`, `SUB_REVISION` | `9.99` | No firmware reports this, so a test that sees 9.99 after a write has caught the version bytes being overwritten. The simulated ESC is 2.20. |
| 0x0D–0x10 | firmware `reserved_eeprom_3[4]` | untouched here | Not in the layout at all, so `encodeSettings` can never write them. The simulated ESC holds `DE AD BE EF`; audit item **A** is that they used to be zeroed to `0xFF` on every save. |
| 0x17 | `TIMING_ADVANCE` | `26` | **The field that makes the write change something.** The simulated ESC holds 8. Without at least one differing tunable, `writeSettings` would return `changed: false` and put nothing on the wire, and the done-when would pass without exercising a write at all. |
| 0x30–0xAF | `STARTUP_MELODY` | `80 40 20 10 08 04 02 01`, then zeros | A multi-byte `number[]` field, so the write path's zero-fill is exercised. The player reads a `0,0` pair as the end of the tune. |
| 0xB0–0xB7 | `CAN_SETTINGS` (live bytes) | `99 7 0 2 0 10 0 0` | Deliberately *not* the simulated ESC's `32 1 1 10 1 200 0 1`. Per-ESC identity: applying one file to four channels would give an ARK DroneCAN board four ESCs with the same node ID. Also carries a `can_node` of `0x63` and a `filter_hz` of `0x0A`, neither of which is the `0x20`/`0xC8` pair from audit **A** — those are covered by the codec's property test. |
| 0xB8–0xBF | `can.reserved[8]` | `0xFF` | Inside the 16-byte `CAN_SETTINGS` field but never used by the firmware. Dropped with the rest of the block. |

Five of those rows are the six fields `ark32 write` drops
(`DEFAULTS_PRESERVED_FIELDS` in `am32-core/eeprom/defaults.ts`); see
`packages/am32-cli/src/commands/settings.ts` for why the CLI drops all six where
the web app drops only `CAN_SETTINGS`.

# `firmware.hex`

A 1 KiB Intel HEX firmware image for the simulated F051, so that
`scripts/assert-cli-sim.sh` can exercise `flash` against the **built** binary. That
is the command whose pre-flight is most exposed to a bundling mistake — `parseHex`
runs inside the bundle before anything is opened — which is the whole reason the gate
exists, and it was the one command the gate could not cover until this file existed.

Two things make it a real test rather than a shape:

- The body starts at `0x1000` (`firmware_start` for the F051 and the ARM64K part) and
  is a recognisable ramp, so a stream written at the wrong base address fails the
  bootloader's own `memcmp` rather than passing silently.
- The 32 bytes at `0x7BE0` (`eeprom_offset - 32`) carry `ARK_4IN1_F051`, which is the
  simulated ESC's own firmware name. So `checkImageMatchesEsc` **runs and passes**
  rather than taking the "no name to check against" warning path — which is what a
  hex with a blank name block would have done, quietly turning the MCU-layout check
  into a no-op.

`fixture.bin` doubles as the negative case: the gate feeds it to `flash --hex` and
expects exit 3, because it is not Intel HEX at all.
