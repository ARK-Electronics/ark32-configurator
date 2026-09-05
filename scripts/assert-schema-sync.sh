#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import hashlib, json, pathlib
source = pathlib.Path('packages/am32-core/src/eeprom/eeprom.json').read_bytes()
json.loads(source)
expected = pathlib.Path('SCHEMA_REF').read_text().strip()
actual = hashlib.sha256(source).hexdigest()
if actual != expected:
    raise SystemExit(f'Bundled schema SHA256 differs from SCHEMA_REF: {actual} != {expected}')
print(f'Bundled schema matches SCHEMA_REF: {actual}')
PY
