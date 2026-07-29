#!/usr/bin/env bash
#
# Gate for overhaul block 2 (issue #3).
#
# Two properties that are easy to state and easy to regress:
#   1. Nothing below the session layer reads the wall clock directly. All time
#      comes from the injectable Clock, which is what lets the simulator tests
#      run a 60 KB flash in milliseconds instead of a minute.
#   2. webserial-wrapper is gone for real. It was never in package.json -- it
#      was a phantom transitive dep of @am32/serial-msp, imported directly by
#      stores/serial.ts. So "not in package.json" was never a real check.

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
fail() { printf '  FAIL  %s\n' "$1"; FAIL=1; }
pass() { printf '  ok    %s\n' "$1"; }

echo "Injectable clock"
HITS=$(grep -rnE 'Date\.now\(\)|globalThis\.setTimeout|(^|[^.[:alnum:]_])(setTimeout|setInterval)\(' \
    packages/am32-core/src --include='*.ts' 2>/dev/null | grep -v '/clock\.ts' || true)
if [ -n "$HITS" ]; then
    fail "am32-core reads the wall clock outside clock.ts"
    printf '%s\n' "$HITS" | sed 's/^/          /'
else
    pass "am32-core takes all time from clock.ts"
fi

echo
echo "webserial-wrapper"
HITS=$(grep -rn 'webserial-wrapper' components pages stores src packages yarn.lock 2>/dev/null || true)
if [ -n "$HITS" ]; then
    fail "webserial-wrapper still referenced"
    printf '%s\n' "$HITS" | sed 's/^/          /'
else
    pass "webserial-wrapper gone from sources and lockfile"
fi

echo
[ "$FAIL" -eq 0 ] || { echo "assert-core-hygiene: FAILED"; exit 1; }
echo "assert-core-hygiene: all clear"
