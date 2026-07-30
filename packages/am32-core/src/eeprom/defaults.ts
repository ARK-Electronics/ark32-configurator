/**
 * AM32's own default settings image, and the fields a "reset to defaults" must
 * not touch.
 *
 * The bytes are the firmware's `default_settings[]`
 * (`AM32/Src/DroneCAN/DroneCAN.c:294-300`, read with a subagent for block 6),
 * which the firmware uses for its DroneCAN factory reset and as the
 * `default_value` it reports for every parameter. Its own comment says it is
 * "based on public/assets/eeprom_default.bin in AM32 configurator, update to 2.19
 * default" -- so this is not a second opinion about what the defaults are, it is
 * the same 48 bytes the configurator has always served, with the firmware as the
 * copy that is kept up to date.
 *
 * 48 bytes, offsets 0..0x2F, stopping where `tune[128]` begins. That is also what
 * the web app's `/api/eeprom/<board>?version=N` files contain and what AM32's
 * factory image builder writes (`AM32/scripts/build_factory_image.py:142-153`
 * leaves 48..191 at 0xFF). Short is correct rather than convenient: `decodeSettings`
 * omits any field that does not fit, and `encodeSettings` only writes the fields it
 * is given, so the ESC's melody, CAN block and reserved bytes are carried through
 * by construction.
 */

import { EepromLayout } from './layout';

/**
 * `default_settings[]` from `AM32/Src/DroneCAN/DroneCAN.c:294-300`, verbatim.
 *
 * Do not "tidy" the identity bytes out of this array -- it is a transcription, and
 * a transcription that has been edited cannot be checked against its source.
 * {@link DEFAULTS_PRESERVED_FIELDS} is where the identity bytes are excluded, and
 * that is a policy decision with its own reasons.
 */
export const DEFAULT_SETTINGS_IMAGE: Uint8Array = Uint8Array.from([
    0x01, 0x03, 0x01, 0x01, 0x23, 0xA0, 0x04, 0x00, 0x0A, 0x64, 0x00, 0x32, 0x02, 0x30, 0x35, 0x31,
    0x20, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x1A, 0x18, 0x64, 0x37, 0x0E, 0x00, 0x00, 0x05, 0x00,
    0x80, 0x80, 0x80, 0x32, 0x00, 0x32, 0x00, 0x00, 0x0F, 0x0A, 0x0A, 0x8D, 0x66, 0x06, 0x01, 0x00
]);

/**
 * The 128-byte startup melody a reset writes: `0xFF` throughout.
 *
 * `tune[0] == ERASED_FLASH_BYTE` is the "no melody" marker and the only byte
 * tested (`AM32/Src/sounds.c:242`), in which case the firmware plays ARK's own
 * tune. It is what a factory image ships and what the app has always written on
 * *apply defaults*.
 *
 * Note `ERASED_FLASH_BYTE` is overridden to `0x39` on `MCU_CH32V203`
 * (`AM32/Inc/targets.h:2437`), where an all-`0xFF` region would instead be read as
 * a melody -- one that emits nothing, because `playBlueJayTune` treats a
 * `255`-with-non-zero-pair as a time-count continuation (`sounds.c:85-86`). ARK
 * ships F051 parts; if a V203 target ever appears, this constant is where it has
 * to become per-MCU.
 */
export const DEFAULT_STARTUP_MELODY: readonly number[] =
    new Array<number>(EepromLayout.STARTUP_MELODY.size).fill(0xFF);

/**
 * Fields a reset to defaults must leave exactly as the ESC has them.
 *
 * Not a style preference -- each one is a byte the default image happens to
 * contain and that writing would get wrong:
 *
 *  - **`BOOT_BYTE`** (0). The bootloader jumps to the application when this is
 *    `0x01` or `0xFF` (`AM32-bootloader/bootloader/main.c:306-319`). The default
 *    image holds `0x01`, so applying it to a half-flashed board would claim a
 *    complete application is present. The flash bracket owns this byte; nothing
 *    else may set it.
 *  - **`LAYOUT_REVISION`** (1). The default image says 3. Writing that onto an
 *    older ESC makes the firmware's own migration `if (eeprom_version <
 *    EEPROM_VERSION)` (`AM32/Src/settings.c:23-36`) skip, so fields the migration
 *    would have populated are read as whatever was in flash. The ESC's firmware
 *    owns its revision and rewrites it itself (`AM32/Src/main.c:312-318`).
 *  - **`BOOT_LOADER_REVISION`** (2). The bootloader stamps this byte inside every
 *    write to the EEPROM base anyway (`main.c:517-525`), so writing it is a no-op
 *    that a verification then has to be told to ignore.
 *  - **`MAIN_REVISION` / `SUB_REVISION`** (3, 4). The ESC's firmware version, not
 *    a setting. The default image carries 1.35, so applying defaults used to make
 *    the configurator report the wrong firmware version until the ESC's next boot
 *    rewrote it.
 *  - **`CAN_SETTINGS`** (176..191). Per-ESC identity -- `can_node` and `esc_index`
 *    among them -- with no editor in the configurator. Resetting four ESCs to the
 *    same node ID is how an ARK DroneCAN board stops working. Block 5's design
 *    decision 13, applied to the other path that writes a whole settings object.
 */
export const DEFAULTS_PRESERVED_FIELDS: readonly string[] = [
    'BOOT_BYTE',
    'LAYOUT_REVISION',
    'BOOT_LOADER_REVISION',
    'MAIN_REVISION',
    'SUB_REVISION',
    'CAN_SETTINGS'
];
