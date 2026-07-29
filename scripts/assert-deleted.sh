#!/usr/bin/env bash
#
# Gate for overhaul block 1a (issue #3): the removed features are actually gone.
#
# Deliberately asserts on *specific symbols and paths*, not on substrings.
# A grep for "direct|amj|bootloader" over the source tree matches 136 lines of
# MOTOR_DIRECTION, BIDIRECTIONAL_MODE, sendRedirect and marketing copy, which
# makes it useless as a gate. These are the identifiers that only exist to serve
# the three deleted features.
#
# Bootloader *info display* (pin, version in EscView) stays -- the ESC still
# reports it, we just never flash it.

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
SEARCH_DIRS=(components pages server src stores utils layouts composables)

fail() { printf '  FAIL  %s\n' "$1"; FAIL=1; }
pass() { printf '  ok    %s\n' "$1"; }

assert_symbol_absent() {
    local symbol="$1" why="$2" hits
    hits=$(grep -rnw --include='*.ts' --include='*.vue' --include='*.d.ts' \
        -e "$symbol" "${SEARCH_DIRS[@]}" nuxt.d.ts 2>/dev/null || true)
    if [ -n "$hits" ]; then
        fail "$symbol still present ($why)"
        printf '%s\n' "$hits" | sed 's/^/          /'
    else
        pass "$symbol removed ($why)"
    fi
}

assert_path_absent() {
    local path="$1" why="$2"
    if [ -e "$path" ]; then
        fail "$path still exists ($why)"
    else
        pass "$path removed ($why)"
    fi
}

assert_dep_absent() {
    local dep="$1" why="$2"
    if grep -q "\"$dep\"" package.json; then
        fail "dependency $dep still in package.json ($why)"
    else
        pass "dependency $dep removed ($why)"
    fi
}

echo "USB-direct connection mode"
assert_path_absent   src/communication/direct.ts        "whole module"
assert_symbol_absent isDirectConnectDevice              "USB-direct guard"
assert_symbol_absent usbDirectVendorIds                 "USB-direct guard"
assert_symbol_absent usbDirectDeviceIdExceptions        "USB-direct guard"
assert_symbol_absent isDirectConnect                    "serialStore flag + its branches"

echo
echo "Bootloader flashing"
assert_symbol_absent AmjType                            ".amj flash tab type"

echo
echo "Bootloader downloads"
assert_symbol_absent bootloaders                        "MinIO/Redis mount + catalog listing"
assert_symbol_absent bootloaderData                     "release sync"
assert_symbol_absent bootloaderStream                   "release sync"

echo
if [ "$FAIL" -ne 0 ]; then
    echo "assert-deleted: FAILED"
    exit 1
fi
echo "assert-deleted: all clear"
