#!/usr/bin/env bash
# Build the ark32 CLI and put it on PATH (symlink into a bin directory).
# Peer of ./run.sh: that one is the web UI; this one is the headless CLI.
#
# Usage: ./install-cli.sh [--prefix DIR] [--uninstall] [--no-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PREFIX="${PREFIX:-${HOME}/.local}"
DO_BUILD=1
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="${2:?--prefix requires a value}"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --no-build)
      DO_BUILD=0
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install-cli.sh [--prefix DIR] [--uninstall] [--no-build]

  Builds the ark32 CLI (esbuild bundle) and installs a symlink so `ark32`
  is on your PATH. The bundle *is* required: unlike the Nuxt app, the CLI
  is shipped as a single file with am32-core / am32-node / am32-sim inlined.
  The only external runtime dep is the native `serialport` module, which
  stays resolved from this checkout's node_modules.

  Default prefix: ~/.local  (binary → ~/.local/bin/ark32)

  Options:
    --prefix DIR   Install under DIR/bin (default: ~/.local)
    --uninstall    Remove the symlink and exit
    --no-build     Re-link only; do not run yarn build:cli

  Env:
    PREFIX         Same as --prefix

  After install, re-run this script whenever you want a fresh bundle.
  The symlink always points at packages/am32-cli/dist/ark32.mjs, so a
  plain `yarn build:cli` is enough between full installs.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

BIN_DIR="${PREFIX}/bin"
TARGET="${BIN_DIR}/ark32"
DIST="${ROOT}/packages/am32-cli/dist/ark32.mjs"

if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ -L "$TARGET" ]] || [[ -f "$TARGET" ]]; then
    rm -f "$TARGET"
    echo "==> Removed ${TARGET}"
  else
    echo "==> Nothing to remove at ${TARGET}"
  fi
  exit 0
fi

need_install=0
if [[ ! -d node_modules ]]; then
  need_install=1
elif [[ ! -e node_modules/.yarn-state.yml ]] && [[ ! -d node_modules/serialport ]]; then
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

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> yarn build:cli"
  yarn build:cli
else
  if [[ ! -f "$DIST" ]]; then
    echo "No bundle at ${DIST}; run without --no-build." >&2
    exit 1
  fi
  echo "==> Skipping build (--no-build); using existing ${DIST}"
fi

if [[ ! -f "$DIST" ]]; then
  echo "Build did not produce ${DIST}" >&2
  exit 1
fi
if [[ ! -x "$DIST" ]]; then
  chmod +x "$DIST"
fi

mkdir -p "$BIN_DIR"

# Replace a previous install cleanly (symlink, or a stale file from a bad run).
if [[ -e "$TARGET" ]] || [[ -L "$TARGET" ]]; then
  rm -f "$TARGET"
fi
ln -s "$DIST" "$TARGET"

echo "==> Installed ${TARGET} -> ${DIST}"

# Smoke: the symlink works from outside the repo and --version matches the bundle.
VERSION="$("$TARGET" --version 2>/dev/null || true)"
if [[ -z "$VERSION" ]]; then
  echo "Install link is present but \`ark32 --version\` failed." >&2
  exit 1
fi
echo "==> ark32 --version → ${VERSION}"

if ! command -v ark32 >/dev/null 2>&1; then
  echo ""
  echo "Note: ${BIN_DIR} is not on your PATH in this shell."
  echo "Add it, then open a new terminal (or source your profile):"
  echo "  export PATH=\"${BIN_DIR}:\$PATH\""
  if [[ -f "${HOME}/.bashrc" ]] && ! grep -qF "${BIN_DIR}" "${HOME}/.bashrc" 2>/dev/null; then
    echo "  # e.g. echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
  fi
elif [[ "$(command -v ark32)" != "$TARGET" ]]; then
  echo ""
  echo "Note: \`command -v ark32\` is $(command -v ark32), not ${TARGET}."
  echo "Another ark32 is earlier on PATH; remove it or reorder PATH if this install should win."
else
  echo "==> \`ark32\` is on PATH"
fi

echo ""
echo "Try:  ark32 --sim --fc betaflight --escs 4 enumerate"
echo "      ark32 ports"
