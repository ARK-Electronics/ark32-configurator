# EEPROM schema

ARK32's `schema/eeprom.json` is the source for storage layout, settings ranges,
conversions, groups, defaults, and firmware overlays. The configurator loads the
latest release's `eeprom.json` at startup and before connecting. The server uses
the configured releases mirror, falling back to GitHub. CLI hardware sessions
fetch GitHub directly. One loaded document serves every ESC; layout byte 1 and
firmware bytes 3–4 choose each ESC's resolved view.

The loader validates byte coverage, storage widths, disjoint version ranges,
aliases, group membership, and predicates before accepting metadata. Schema
language major versions other than 1 are refused in favor of the bundled schema.
It stores one JSON file and computes its SHA256, skipping asset downloads when
release metadata reports the cached digest. An asset with no SHA256 digest is
not downloaded. Failed refreshes use a valid cache; a cold cache, no release
asset, and simulation/tests use the bundle.

Caches live at `~/.cache/ark32/eeprom.json` for the CLI and
`.cache/ark32/eeprom.json` for the server. `ARK32_SCHEMA_CACHE_DIR` overrides the
server directory. The reusable Node loader accepts `cacheDir`, including an
Electron host's `app.getPath('userData')`; this repository has no Electron host.

Core `decode(bytes, schema, context)` and
`encode(settings, schema, baseImage, context)` operate on raw values. UI
conversion uses `fromRaw(field, raw)` and `toRaw(field, display)`; the latter
rounds to the nearest raw integer. Encoding always starts from the ESC read-back
image, preserving unnamed and excluded bytes. `CAN_SETTINGS` remains an opaque
16-byte alias; explicit future aliases in its reserved tail take precedence.
Defaults and settings-file application preserve identity fields. Canonical new
UI defaults use temperature 255 and current 0 for disabled limits; the generated
48-byte factory image retains the historical bytes 141 and 102.

To refresh the offline copy from a firmware checkout:

```sh
scripts/sync-eeprom-schema.sh ../AM32/schema/eeprom.json
scripts/assert-schema-sync.sh
```

`SCHEMA_REF` contains the bundled file's SHA256. CI checks that copy and never
requires a sibling firmware checkout. `scripts/gen-eeprom-layout.mjs` emits
ignored `layout.generated.ts` and `schema.generated.ts`; package test, typecheck,
development and build scripts generate them before consuming core code. The CLI
build entry point also generates them for direct release/prepack builds.

```sh
corepack yarn typecheck
corepack yarn test
corepack yarn build:cli
node packages/am32-cli/dist/ark32.mjs --sim get --esc 1
node packages/am32-cli/dist/ark32.mjs --sim set --esc 1 MOTOR_KV=25
```

Tests cover runtime fetched aliases, mixed ESC versions, byte preservation,
future little-endian scalars, the factory image, a real HTTP release fixture and
filesystem cache, offline fallback, and unsupported schema language versions.

## Ramp migration: ARK32 layout 3 to 4

ARK32 layout 4 (ARK32 PR #128) runs `MAX_RAMP` as an exact duty rate. Every ARK
release before it (3.0.1-ark to 32.0, layout 3) scaled the stored ramp by
14.8 V / pack voltage and truncated it per tick. The same number therefore flew
slower above 14.8 V: the factory 2.0 %/ms ran at 1.0 on 4S-6S. The firmware
never rewrites the byte, and its first boot stamps layout 4 over the page, so
`Am32Session.flash` migrates it while it still holds the pre-flash page
(`packages/am32-core/src/eeprom/ramp-migration.ts`).

- **When.** The page is layout 3 with `MAIN_REVISION` 3 or 32 (ARK firmware),
  and the hex declares layout 4 or later. ARK32 images carry the layout as a
  third string in the `.file_name` block (`ARK_4IN1_F051\032.0\0e4`). A hex
  without the tag is never migrated for. Upstream AM32 pages are left alone:
  upstream never scaled its ramp, and its layout 4 (2.21) keeps every byte ARK32
  uses where it was.
- **To what.** The rate layout 3 actually ran on this pack, evaluated at full
  charge (4.2 V per cell, its slowest point), taking the slowest of the startup,
  low-rpm and high-rpm regimes. Layout 4 has one rate for all three, so this is
  the value that never ramps faster than before in any regime. Above 14.8 V any
  stored ramp of 1.0 or more becomes 1.0.
- **Write.** The migrated ramp and layout byte 4 go out in the closing boot-byte
  write of the flash, so a flash that dies part way is retried from the original
  value. A second flash reads a layout-4 page and does not migrate again.
- **Cell count.** The flash needs `packCells` (CLI `--cells N`). Without it a
  migrating flash is refused with `SessionError('migration')` (CLI exit 3)
  before anything is written. The app asks in the flash dialog when a selected
  ESC holds an ARK layout-3 page, pre-filled from `MSP_BATTERY_STATE` on
  Betaflight. ArduPilot reports a fixed 4S, which the session discards.

Pages written by tools that do not migrate (the upstream AM32 configurator,
DroneCAN parameter writes) arrive at layout 4 with the stored value unchanged,
and then run it exactly.
