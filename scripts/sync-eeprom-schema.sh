#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source_schema=${1:-../AM32/schema/eeprom.json}
python3 - "$source_schema" <<'PY'
import hashlib, json, pathlib, sys
source = pathlib.Path(sys.argv[1]).read_bytes()
schema = json.loads(source)
if schema.get('version', '').split('.')[0] != '1':
    raise SystemExit('Unsupported schema language major')
target = pathlib.Path('packages/am32-core/src/eeprom/eeprom.json')
target.write_bytes(source)
pathlib.Path('SCHEMA_REF').write_text(hashlib.sha256(source).hexdigest() + '\n')
PY
node scripts/gen-eeprom-layout.ts
