#!/usr/bin/env bash
#
# Gate for overhaul block 3 (issue #3): every fault-injection knob in the plan's
# section 3 table exists and is exercised by at least one test.
#
# Each knob maps to a bug the audit found. Without this, "the simulator supports
# fault injection" degrades into "the simulator has a fault injection API that
# nothing calls", and the regressions the knobs exist to prevent quietly return.

set -uo pipefail
cd "$(dirname "$0")/.."

KNOBS=(
    unresponsive        # B  -- partial enumerate must degrade, not throw
    slowBy              # C  -- timeout policy must cover the FC's real budget
    corruptCrc          #    -- retry/drain must recover
    shortRead           #    -- retry/drain must recover
    mspError            # D  -- an MSP '!' frame must not parse as success
    mavlinkIdleGate     # H  -- ArduPilot connect must probe-then-wait
    blockingFourWay     # H  -- Betaflight passthrough must not expect MSP
    dropBytes           # E,G -- framing must resynchronise
    injectGarbage       # E,G -- drain must clear stale RX
    canBlock            # A  -- settings round-trip must preserve 176-183
    # Not in the plan's section 3 table. Added in block 6, which needed a way to
    # reach the one failure the bootloader's own memcmp verify cannot report -- a
    # write the flight controller reported as OK that never took effect
    # (AP_BLHeli.cpp:928-932). Without it, read-back verification has no test that
    # fails when it is removed, and block 3's rule is that a knob nothing exercises
    # is a knob that has stopped working.
    silentWriteFailure  # A,C -- a write must be proven, not assumed
    failingFlashCell    # C  -- a rejected chunk must be repaired at the page base
    # Not in the plan's table either. Added for issue #10, found on hardware
    # after block 7: mid-flash the ESC dropped out of its bootloader and every
    # remaining exchange failed, so the page loops must re-init the channel
    # before rewriting rather than burning their attempts against a bootloader
    # that is not there.
    bootloaderDropout   # #10 -- a channel lost mid-write is re-inited, then rewritten
)

# The test-side check looks for a suite *named after* the knob -- the plan's
# words are "one test named after each of the eight fault knobs" -- rather than
# for the knob's name appearing anywhere in any test file. Block 3 found the
# looser version passing on two false positives: `canBlock` matched an unrelated
# local variable in block 1's codec property test, and `mavlinkIdleGate` matched
# a line of rig setup. Both rows would have stayed green with the knob's real
# test deleted.
#
# This is still only a *presence* check. Nothing here proves a knob does
# anything; that is what the tests themselves are for, and block 3's note
# records the mutation results that establish it.
FAIL=0
echo "Fault-injection knob coverage"
for knob in "${KNOBS[@]}"; do
    impl=$(grep -rl "$knob" packages/am32-sim/src --include='*.ts' 2>/dev/null | grep -v '\.test\.ts' | head -1)
    test_hit=$(grep -rl "describe('fault knob:[^']*${knob}" packages --include='*.test.ts' 2>/dev/null | head -1)
    if [ -z "$impl" ]; then
        printf '  FAIL  %-16s not implemented in am32-sim\n' "$knob"; FAIL=1
    elif [ -z "$test_hit" ]; then
        printf '  FAIL  %-16s no describe("fault knob: ...%s...") suite\n' "$knob" "$knob"; FAIL=1
    else
        printf '  ok    %-16s %s\n' "$knob" "$test_hit"
    fi
done

echo
[ "$FAIL" -eq 0 ] || { echo "assert-fault-coverage: FAILED"; exit 1; }
echo "assert-fault-coverage: all clear"
