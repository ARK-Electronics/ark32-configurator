#!/usr/bin/env bash
#
# Autonomous driver for the ARK32 configurator overhaul (issue #3).
#
# The loop lives HERE, in bash -- not inside a Claude session. Each block gets a
# brand new `claude -p` process, which means a brand new context window. Nothing
# carries over in the model's head; everything that has to survive between blocks
# is written to disk:
#
#   docs/plans/overhaul/STATUS.json      the queue and the record  (driver owns)
#   docs/plans/overhaul/notes/block-*.md handoff notes             (agent owns)
#   git history                          the actual work
#
# That separation is the whole trick. The agent's context is disposable; the
# repo is the memory.
#
# The driver, not the agent, decides whether a block passed. An agent asked
# "are you done?" will usually say yes. `yarn verify` will not.
#
# Usage:
#   ./scripts/overhaul-loop.sh              run until done, stuck, or deadline
#   ./scripts/overhaul-loop.sh --dry-run    show the plan and the prompts, run nothing
#   ./scripts/overhaul-loop.sh --status     print progress and exit
#   ./scripts/overhaul-loop.sh --only 1a    run exactly one block, then stop
#
# Env knobs:
#   OVERHAUL_BRANCH=overhaul/auto   branch to work on (never master)
#   OVERHAUL_DEADLINE_MIN=0         wall-clock budget, 0 = unlimited
#   OVERHAUL_BLOCK_TIMEOUT=5400     per-block timeout in seconds (90 min)
#   OVERHAUL_MAX_ATTEMPTS=2         attempts per block before giving up
#   OVERHAUL_MODEL='opus[1m]'
#   OVERHAUL_EFFORT=xhigh          # see the note in the preflight below

set -uo pipefail
cd "$(dirname "$0")/.."

BRANCH="${OVERHAUL_BRANCH:-overhaul/auto}"
DEADLINE_MIN="${OVERHAUL_DEADLINE_MIN:-0}"
BLOCK_TIMEOUT="${OVERHAUL_BLOCK_TIMEOUT:-5400}"
MAX_ATTEMPTS="${OVERHAUL_MAX_ATTEMPTS:-2}"
MODEL="${OVERHAUL_MODEL:-opus[1m]}"
# xhigh, not max. Anthropic's own guidance is that xhigh is the best setting for
# coding and agentic work, and that max shows diminishing returns and is prone to
# overthinking. For an unattended overnight run the difference is not academic:
# max spends materially more tokens per block for no reliable quality gain.
EFFORT="${OVERHAUL_EFFORT:-xhigh}"

STATUS=docs/plans/overhaul/STATUS.json
LOGDIR=docs/plans/overhaul/logs
NOTEDIR=docs/plans/overhaul/notes
STARTED_AT=$(date +%s)

DRY_RUN=0
ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --only)    ONLY="${2:?--only needs a block id}"; shift 2 ;;
        --status)  python3 scripts/overhaul_status.py report; exit 0 ;;
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 3 ;;
    esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m!!! %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$LOGDIR" "$NOTEDIR"

# --- preflight ---------------------------------------------------------------

command -v claude >/dev/null || die "claude CLI not on PATH"

# Which credential the spawned agents will bill against. The CLI resolves
# ANTHROPIC_API_KEY first and the subscription login second, so a stray key in
# the environment silently moves an overnight run onto API billing.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    warn "ANTHROPIC_API_KEY is set -- this run will bill the API, not your subscription."
    warn "Unset it first if that is not what you want."
else
    say "billing: subscription login (no ANTHROPIC_API_KEY in environment)"
fi
[ -f "$STATUS" ] || die "$STATUS not found"
python3 -c "import json;json.load(open('$STATUS'))" || die "$STATUS is not valid JSON"

if [ -n "$(git status --porcelain)" ]; then
    die "working tree is dirty. Commit or stash before starting an unattended run."
fi

if [ "$DRY_RUN" -eq 0 ]; then
    if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
        say "creating $BRANCH from $(git rev-parse --abbrev-ref HEAD)"
        git checkout -b "$BRANCH" >/dev/null 2>&1 || die "could not create $BRANCH"
    else
        git checkout "$BRANCH" >/dev/null 2>&1 || die "could not switch to $BRANCH"
    fi
    [ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "not on $BRANCH"

    say "baseline check: yarn verify must be green before we start"
    if ! yarn verify >"$LOGDIR/baseline-verify.log" 2>&1; then
        tail -30 "$LOGDIR/baseline-verify.log"
        die "baseline yarn verify is red. Fix that first -- an unattended run on a broken tree just compounds it."
    fi
fi

# --- the per-block prompt ----------------------------------------------------
#
# Deliberately different from the interactive /block skill:
#   - the agent does NOT touch STATUS.json (the driver owns it, so a block
#     cannot mark itself done)
#   - the agent does NOT open a PR or push (the driver owns git plumbing)
#   - hardware checkpoints are recorded as outstanding, not blocked on
#   - the agent writes a handoff note, which is how the next block's fresh
#     context learns what this one found

build_prompt() {
    local id="$1" attempt="$2" failure_log="$3"
    cat <<PROMPT
You are running unattended as one link in an automated chain. Work **block ${id}** of the overhaul plan in GitHub issue #3, start to finish. No human will answer questions, so make the best call you can and record it.

Read first, in this order:
1. \`docs/plans/overhaul/STATUS.json\` -- the block list and where things stand.
2. Every file in \`docs/plans/overhaul/notes/\` -- handoff notes from the blocks before you. This is how you inherit context you no longer have.
3. \`gh issue view 3 --repo ARK-Electronics/ark32-configurator\` -- the plan. Find block ${id} in section 5.
4. \`git log --oneline -20\`.

Then follow \`.claude/skills/block/SKILL.md\`, with these overrides because you are in the automated loop:

- **Do not edit \`docs/plans/overhaul/STATUS.json\`.** The driver owns it. A block that marks itself done is a block that grades its own homework.
- **Do not push and do not open a PR.** Commit locally with real messages; the driver handles branches, tags and pushes.
- **Hardware checkpoints cannot run here** -- nothing is plugged in. Do the simulator-side work, then write the checkpoint as an outstanding item in your handoff note. Do not treat it as blocking.
- **Re-verify the plan's file:line references before trusting them.** They were written against commit 4094dad and earlier blocks move code.
- **Read firmware sources with a subagent**, never in your main context. Paths are in CLAUDE.md. They are large and you need one answer from each.
- **Write the failing test first.** Where the plan gives a fault-injection row, that row is the test. A fix with no test that would have caught it is not done.
- **Never weaken, skip, delete or \`.skip\` a test to make the block pass.** If a test is genuinely wrong, say so in the handoff note and explain why.
- Stay strictly inside block ${id}. Do not start the next block.

Before you finish:
- \`yarn verify\` must exit 0. The driver re-runs it independently, so claiming success without it is pointless.
- Run the block's own done-when command from the plan.
- Have a subagent review your diff against block ${id}'s done-when in a fresh context, and fix any real correctness gaps it finds.
- Commit everything. Leave no uncommitted changes.

Finally, write \`docs/plans/overhaul/notes/block-${id}.md\` and commit it. This file is the only thing the next agent inherits from you. Include:
  - what you built, and any design decision a later block could accidentally undo
  - anything in the plan you found to be wrong, stale, or impossible
  - plan line references that had drifted
  - outstanding items, including any hardware checkpoint
  - what you would tell the next block's agent if you could only say three things
PROMPT

    if [ "$attempt" -gt 1 ] && [ -s "$failure_log" ]; then
        cat <<RETRY

---

**This is attempt ${attempt}.** Your previous attempt was reverted because the driver's verification failed. Do not repeat the same approach. The tail of that failure:

\`\`\`
$(tail -60 "$failure_log")
\`\`\`
RETRY
    fi
}

# --- main loop ---------------------------------------------------------------

while :; do
    if [ "$DEADLINE_MIN" -gt 0 ]; then
        elapsed_min=$(( ($(date +%s) - STARTED_AT) / 60 ))
        if [ "$elapsed_min" -ge "$DEADLINE_MIN" ]; then
            say "deadline reached (${elapsed_min}m). Stopping cleanly."
            break
        fi
    fi

    if [ -n "$ONLY" ]; then
        id="$ONLY"
        python3 scripts/overhaul_status.py runnable "$id" >/dev/null || die "block $ONLY is not runnable (already done, or blocked)"
    else
        id=$(python3 scripts/overhaul_status.py next)
    fi

    if [ -z "$id" ]; then
        say "no runnable blocks left"
        python3 scripts/overhaul_status.py report
        break
    fi

    title=$(python3 scripts/overhaul_status.py title "$id")
    done_cmd=$(python3 scripts/overhaul_status.py donecmd "$id")

    say "block $id -- $title"
    echo "    done-when: ${done_cmd:-yarn verify}"

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "--- prompt ------------------------------------------------------"
        build_prompt "$id" 1 /dev/null
        echo "-----------------------------------------------------------------"
        python3 scripts/overhaul_status.py mark "$id" done --dry >/dev/null
        [ -n "$ONLY" ] && break
        continue
    fi

    attempt=1
    passed=0
    fail_log="$LOGDIR/block-$id-failure.log"

    while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
        base=$(git rev-parse HEAD)
        log="$LOGDIR/block-$id-attempt$attempt.log"
        echo "    attempt $attempt/$MAX_ATTEMPTS -- log: $log"
        python3 scripts/overhaul_status.py mark "$id" in-progress

        build_prompt "$id" "$attempt" "$fail_log" > "$LOGDIR/block-$id-attempt$attempt.prompt"

        timeout "$BLOCK_TIMEOUT" claude -p "$(cat "$LOGDIR/block-$id-attempt$attempt.prompt")" \
            --model "$MODEL" --effort "$EFFORT" \
            --permission-mode bypassPermissions \
            > "$log" 2>&1
        agent_exit=$?
        [ "$agent_exit" -eq 124 ] && warn "block timed out after ${BLOCK_TIMEOUT}s"

        # Sweep up anything the agent left uncommitted, so verification runs
        # against the real tree rather than a half-committed one.
        if [ -n "$(git status --porcelain)" ]; then
            warn "agent left uncommitted changes; committing them"
            git add -A
            git commit -q -m "chore(block-$id): sweep uncommitted changes from automated run"
        fi

        # The driver is the judge. Independent of whatever the agent claimed.
        {
            echo "### driver verification for block $id, attempt $attempt"
            echo "### yarn verify"
        } > "$fail_log"

        if yarn verify >>"$fail_log" 2>&1; then
            if [ -n "$done_cmd" ]; then
                echo "### done-when: $done_cmd" >> "$fail_log"
                if bash -c "$done_cmd" >>"$fail_log" 2>&1; then
                    passed=1
                else
                    warn "done-when command failed"
                fi
            else
                passed=1
            fi
        else
            warn "yarn verify failed"
        fi

        if [ "$passed" -eq 1 ]; then
            break
        fi

        warn "rolling back to $base"
        git reset --hard "$base" >/dev/null
        git clean -fd >/dev/null
        attempt=$((attempt + 1))
    done

    if [ "$passed" -ne 1 ]; then
        python3 scripts/overhaul_status.py mark "$id" stuck
        git add -A && git commit -q -m "docs(plan): record block $id as stuck" 2>/dev/null
        git push -u ark "$BRANCH" 2>/dev/null || warn "push failed"
        say "block $id is stuck after $MAX_ATTEMPTS attempts. Stopping."
        echo "    see $fail_log and $LOGDIR/block-$id-attempt*.log"
        exit 1
    fi

    python3 scripts/overhaul_status.py mark "$id" done
    git add -A
    git commit -q -m "docs(plan): mark block $id done" 2>/dev/null
    git tag -f "block-$id" >/dev/null 2>&1
    git push ark "$BRANCH" >/dev/null 2>&1 || warn "push failed (work is committed locally)"

    say "block $id complete"
    [ -n "$ONLY" ] && break
done

say "run finished"
python3 scripts/overhaul_status.py report
