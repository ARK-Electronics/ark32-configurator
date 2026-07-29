#!/usr/bin/env bash
#
# Launcher for the unattended overhaul run.
#
# scripts/overhaul-loop.sh assumes an interactive developer environment. A
# systemd timer does not provide one: no nvm, no ~/.local/bin, no ssh-agent, a
# minimal PATH. Everything the run needs is therefore set up explicitly here
# rather than inherited, so the job behaves the same at 10pm as it does in a
# terminal.
#
#   bash scripts/overhaul-launch.sh [--only 1a]
#
# Any arguments are passed through to overhaul-loop.sh.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# --- environment -------------------------------------------------------------

export HOME="${HOME:-/home/$(id -un)}"

# claude lives here; nvm supplies node and yarn.
export PATH="$HOME/.local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

# Pushing to ark needs the agent that holds the ed25519 key. Under systemd this
# is not inherited, but the socket path is stable for the login session.
: "${SSH_AUTH_SOCK:=/run/user/$(id -u)/keyring/ssh}"
export SSH_AUTH_SOCK

# Never let a stray key silently move an overnight run onto API billing.
unset ANTHROPIC_API_KEY

export NUXT_TELEMETRY_DISABLED=1
export DATABASE_URL="${DATABASE_URL:-mysql://am32:am32password@127.0.0.1:3308/am32}"

LOGDIR="$REPO/docs/plans/overhaul/logs"
mkdir -p "$LOGDIR"
RUNLOG="$LOGDIR/run.log"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >> "$RUNLOG"; }

# --- preflight ---------------------------------------------------------------

log "=========================================================="
log "launcher starting in $REPO"

MISSING=0
for c in claude node yarn git python3; do
    if command -v "$c" >/dev/null 2>&1; then
        log "  found $c -> $(command -v "$c")"
    else
        log "  MISSING $c"
        MISSING=1
    fi
done
[ "$MISSING" -eq 0 ] || { log "aborting: required tools missing from PATH"; exit 1; }

# A push failure is not fatal -- the loop commits locally either way -- but it is
# worth knowing at the start rather than discovering it at 3am.
#
# Capture to a variable rather than piping into grep: `ssh -T git@github.com`
# exits 1 by design (GitHub allows no shell), and under `pipefail` that makes the
# whole pipeline report failure even when the greeting matched.
SSH_OUT="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 || true)"
case "$SSH_OUT" in
    *"successfully authenticated"*)
        log "  github ssh auth OK" ;;
    *)
        log "  WARNING: github ssh auth failed -- work will commit locally but pushes will not land"
        log "  ssh said: $SSH_OUT" ;;
esac

log "starting overhaul-loop.sh $*"

# --- run ---------------------------------------------------------------------

bash "$REPO/scripts/overhaul-loop.sh" "$@" >> "$RUNLOG" 2>&1
STATUS=$?

log "overhaul-loop.sh exited with status $STATUS"
python3 "$REPO/scripts/overhaul_status.py" report >> "$RUNLOG" 2>&1
log "=========================================================="

exit "$STATUS"
