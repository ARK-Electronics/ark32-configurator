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
release metadata reports the cached digest. Failed refreshes use a valid cache;
a cold cache, no release asset, and simulation/tests use the bundle.

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
requires a sibling firmware checkout. `scripts/gen-eeprom-layout.ts` emits
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
