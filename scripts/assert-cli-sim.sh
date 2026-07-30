#!/usr/bin/env bash
#
# Gate for overhaul block 7 (issue #3): the `ark32` binary works against the
# simulator with no hardware, and its exit codes are the ones section 6 specifies.
#
# `yarn test` already covers all of this against `run()` in-process. This gate
# exists because it covers something the test suite cannot: that the **built
# binary** has it. Between `run()` and `ark32` sit the esbuild bundle, the shebang,
# the `bin` link and the argv/exit-code plumbing in `main.ts` -- and a bundling
# mistake (a dynamic import that did not survive, a workspace package that was not
# inlined) breaks the binary while leaving 451 green tests behind it.
#
# It runs the plan's two done-when command lines verbatim, from a directory
# containing `fixture.bin`, which is why the fixture is copied rather than passed
# by path.

set -uo pipefail
cd "$(dirname "$0")/.."

REPO="$PWD"
ARK="$REPO/node_modules/.bin/ark32"
FIXTURE="$REPO/packages/am32-cli/fixtures/fixture.bin"

FAIL=0
fail() { printf '  FAIL  %s\n' "$1"; FAIL=1; }
pass() { printf '  ok    %s\n' "$1"; }

# ---- the packages exist (STATUS.json's own done-when command) ----------------

echo "Packages"
for dir in packages/am32-node packages/am32-cli; do
    if [ -d "$dir" ]; then pass "$dir"; else fail "$dir is missing"; fi
done

# ---- the bundle builds ------------------------------------------------------

echo
echo "Build"
if BUILD_OUT=$(node scripts/build-cli.mjs 2>&1); then
    printf '%s\n' "$BUILD_OUT" | sed 's/^/  ok    /'
else
    fail "yarn build:cli"
    printf '%s\n' "$BUILD_OUT" | sed 's/^/          /'
    echo
    echo "assert-cli-sim: FAILED"
    exit 1
fi

# Prefer the bin link, because that is what `npm i -g @ark/am32-cli` installs and
# it exercises the shebang. Yarn only creates it once dist/ exists, though, so a
# first-ever build has no link yet -- fall back to the bundle rather than fail on
# an ordering detail that says nothing about the CLI.
if [ -x "$ARK" ]; then
    RUN_ARK=("$ARK")
    pass "running node_modules/.bin/ark32 (the bin link)"
elif [ -f "$REPO/packages/am32-cli/dist/ark32.mjs" ]; then
    RUN_ARK=(node "$REPO/packages/am32-cli/dist/ark32.mjs")
    pass "running dist/ark32.mjs (no bin link yet -- run 'yarn install' to get one)"
else
    fail "neither node_modules/.bin/ark32 nor packages/am32-cli/dist/ark32.mjs exists"
    echo
    echo "assert-cli-sim: FAILED"
    exit 1
fi

# ---- run from a scratch directory, so `-i fixture.bin` is the plan's line ----

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$FIXTURE" "$WORK/fixture.bin"
cd "$WORK"

# check <expected-exit> <description> -- <command...>
check() {
    local expect="$1"; shift
    local what="$1"; shift
    shift    # the literal --
    local out rc
    out=$("$@" 2>&1)
    rc=$?
    if [ "$rc" -eq "$expect" ]; then
        pass "exit $rc  $what"
    else
        fail "expected exit $expect, got $rc  $what"
        printf '%s\n' "$out" | sed 's/^/          /'
    fi
}

echo
echo "The plan's done-when command lines"
check 0 'ark32 --sim enumerate --escs 4' -- "${RUN_ARK[@]}" --sim enumerate --escs 4
check 0 'ark32 --sim write --esc all -i fixture.bin' -- "${RUN_ARK[@]}" --sim write --esc all -i fixture.bin

echo
echo "The section 6 exit-code table"
check 0 '0 -- success'                          -- "${RUN_ARK[@]}" --sim --escs 2 get --esc all TIMING_ADVANCE
check 1 '1 -- partial: one ESC unresponsive'    -- "${RUN_ARK[@]}" --sim --escs 4 --fault esc4=unresponsive enumerate
check 2 '2 -- connect: the FC never answers'    -- "${RUN_ARK[@]}" --sim --fault fc=mavlinkIdleGate:100000 info
check 3 '3 -- bad arguments: unknown command'   -- "${RUN_ARK[@]}" --sim enumrate
check 3 '3 -- bad arguments: unknown flag'      -- "${RUN_ARK[@]}" --sim enumerate --fast
check 3 '3 -- bad arguments: missing --esc'     -- "${RUN_ARK[@]}" --sim get
check 3 '3 -- bad arguments: no such file'      -- "${RUN_ARK[@]}" --sim write --esc all -i nope.bin

echo
echo "Every command reaches the simulator"
check 0 'ports'     -- "${RUN_ARK[@]}" --sim ports
check 0 'info'      -- "${RUN_ARK[@]}" --sim info
check 0 'enumerate' -- "${RUN_ARK[@]}" --sim --escs 2 enumerate
check 0 'read'      -- "${RUN_ARK[@]}" --sim --escs 2 read --esc all -o dump
check 0 'write'     -- "${RUN_ARK[@]}" --sim --escs 2 write --esc all -i fixture.bin
check 0 'get'       -- "${RUN_ARK[@]}" --sim --escs 2 get --esc 1
check 0 'set'       -- "${RUN_ARK[@]}" --sim --escs 2 set --esc all TIMING_ADVANCE=16
check 0 'defaults'  -- "${RUN_ARK[@]}" --sim --escs 2 defaults --esc all
check 0 'reset'     -- "${RUN_ARK[@]}" --sim --escs 2 reset --esc all

echo
echo "read wrote what it said it wrote"
for esc in 1 2; do
    if [ ! -f "dump/esc-$esc.bin" ]; then
        fail "dump/esc-$esc.bin was not written"
    elif [ "$(wc -c < "dump/esc-$esc.bin")" -ne 192 ]; then
        fail "dump/esc-$esc.bin is $(wc -c < "dump/esc-$esc.bin") bytes, expected 192"
    else
        pass "dump/esc-$esc.bin is 192 bytes"
    fi
done

# ---- --json is machine-readable, which means stdout carries nothing else ----

echo
echo "--json"
JSON=$("${RUN_ARK[@]}" --sim --escs 2 -v --json enumerate 2>/dev/null)
if printf '%s' "$JSON" | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
        const parsed = JSON.parse(input);
        if (parsed.command !== "enumerate") { throw new Error("wrong command field"); }
        if (parsed.ok !== true || parsed.exitCode !== 0) { throw new Error("wrong ok/exitCode"); }
        if (parsed.simulated !== true) { throw new Error("simulated flag not set"); }
        if (!Array.isArray(parsed.escs) || parsed.escs.length !== 2) { throw new Error("wrong escs"); }
        if (!parsed.escs.every(e => e.ok)) { throw new Error("an ESC failed"); }
    });
' 2>/dev/null; then
    # -v was passed, so the session logged plenty. None of it may be on stdout.
    pass 'stdout is exactly one JSON object, even under -v'
else
    fail 'stdout is not exactly one parseable JSON object'
    printf '%s\n' "$JSON" | head -5 | sed 's/^/          /'
fi

JSON=$("${RUN_ARK[@]}" --sim --fault fc=mavlinkIdleGate:100000 --json info 2>/dev/null)
if printf '%s' "$JSON" | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
        const parsed = JSON.parse(input);
        if (parsed.ok !== false || parsed.exitCode !== 2) { throw new Error("wrong ok/exitCode"); }
        if (parsed.error?.reason !== "fc-detect") { throw new Error("wrong error reason"); }
    });
' 2>/dev/null; then
    pass 'a failed command still emits one JSON object, with the reason'
else
    fail 'a failed command did not emit a usable JSON object'
    printf '%s\n' "$JSON" | head -5 | sed 's/^/          /'
fi

# ---- --sim must never load the native module -------------------------------

echo
echo "--sim needs no native module"
if "${RUN_ARK[@]}" --sim --escs 1 enumerate >/dev/null 2>&1 && \
   ! "${RUN_ARK[@]}" --sim --escs 1 -v enumerate 2>&1 | grep -q 'serialport'; then
    pass 'a --sim run mentions serialport nowhere'
else
    fail 'a --sim run touched the serialport module'
fi

echo
[ "$FAIL" -eq 0 ] || { echo "assert-cli-sim: FAILED"; exit 1; }
echo "assert-cli-sim: all clear"
