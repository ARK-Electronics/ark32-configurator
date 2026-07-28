#!/usr/bin/env bash
# Start the ARK32 configurator dev server and open Chrome/Edge on localhost.
# Usage: ./run.sh [--no-browser] [--port PORT]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"
OPEN_BROWSER=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-browser)
      OPEN_BROWSER=0
      shift
      ;;
    --port)
      PORT="${2:?--port requires a value}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./run.sh [--no-browser] [--port PORT]

  Installs deps if needed, starts `yarn dev`, and opens the configurator
  in a Chromium browser (required for Web Serial).

  Env:
    PORT   Dev server port (default 3000)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

URL="http://localhost:${PORT}"

need_install=0
if [[ ! -d node_modules ]]; then
  need_install=1
elif [[ ! -e node_modules/.yarn-state.yml ]] && [[ ! -d node_modules/nuxt ]]; then
  need_install=1
fi

if [[ "$need_install" -eq 1 ]]; then
  echo "==> Enabling corepack / yarn"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable || true
  fi
  echo "==> yarn install"
  yarn install
fi

# Prefer Chromium (Web Serial). Fall back through common names.
open_browser() {
  local url="$1"
  local candidates=(
    google-chrome
    google-chrome-stable
    chromium
    chromium-browser
    microsoft-edge
    microsoft-edge-stable
    xdg-open
  )
  for bin in "${candidates[@]}"; do
    if command -v "$bin" >/dev/null 2>&1; then
      echo "==> Opening ${url} with ${bin}"
      # Detach so the browser does not take over this shell / receive Ctrl-C
      if [[ "$bin" == "xdg-open" ]]; then
        nohup "$bin" "$url" >/dev/null 2>&1 &
      else
        # New window keeps a dedicated session for the configurator
        nohup "$bin" --new-window "$url" >/dev/null 2>&1 &
      fi
      return 0
    fi
  done
  echo "No browser found; open ${url} in Chrome/Edge manually." >&2
  return 1
}

wait_for_server() {
  local url="$1"
  local tries=60
  local i
  for ((i = 1; i <= tries; i++)); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS -o /dev/null --connect-timeout 1 "$url" 2>/dev/null; then
        return 0
      fi
    else
      # Bash /dev/tcp probe when curl is unavailable
      if (echo >/dev/tcp/127.0.0.1/"${PORT}") >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 0.5
  done
  return 1
}

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    echo ""
    echo "==> Stopping dev server (pid ${DEV_PID})"
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> Starting yarn dev on port ${PORT}"
# Nuxt respects PORT; also pass host for LAN access if needed
export PORT
export HOST="${HOST:-0.0.0.0}"
yarn dev --port "$PORT" &
DEV_PID=$!

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  if wait_for_server "$URL"; then
    open_browser "$URL" || true
  else
    echo "Server did not become ready in time; open ${URL} manually once yarn is up." >&2
  fi
else
  echo "==> Browser launch skipped (--no-browser). URL: ${URL}"
fi

echo "==> Dev server running (pid ${DEV_PID}). Ctrl-C to stop."
wait "$DEV_PID"
