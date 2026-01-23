#!/usr/bin/env bash
# dev-bootstrap.sh - Bootstrap a fresh DagNet dev environment (setup only; does NOT start servers).
#
# Notes:
# - `dev-start.sh` already does a lot (tmux + starts Vite + starts the Python API).
# - This script focuses on making a *new* machine ready to run/test, including Playwright browser installs.
#
# Usage:
#   ./dev-bootstrap.sh
#
# After this completes, start dev normally with:
#   ./dev-start.sh
#
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$#" -ne 0 ]]; then
  echo "ERROR: dev-bootstrap.sh takes no arguments."
  echo "Run: ./dev-bootstrap.sh"
  exit 2
fi

cd "${ROOT_DIR}"

if [[ ! -d "${ROOT_DIR}/graph-editor" ]]; then
  echo "ERROR: expected ${ROOT_DIR}/graph-editor to exist."
  exit 1
fi

echo "==> Ensuring repo-pinned Node via nvm"
REQUIRED_NODE_MAJOR="$(tr -d '[:space:]' < "${ROOT_DIR}/graph-editor/.nvmrc" 2>/dev/null || true)"
if [[ -z "${REQUIRED_NODE_MAJOR}" ]]; then
  REQUIRED_NODE_MAJOR="22"
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "${NVM_DIR}/nvm.sh"
else
  echo "ERROR: nvm not found at ${NVM_DIR}/nvm.sh"
  echo "Install nvm, then re-run this script."
  echo "  https://github.com/nvm-sh/nvm"
  exit 1
fi

(
  cd "${ROOT_DIR}/graph-editor"
  nvm install "${REQUIRED_NODE_MAJOR}"
  nvm use "${REQUIRED_NODE_MAJOR}"
)

echo "==> Installing frontend dependencies (graph-editor)"
(
  cd "${ROOT_DIR}/graph-editor"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
)

echo "==> Ensuring Python venv (graph-editor/venv)"
VENV_DIR="${ROOT_DIR}/graph-editor/venv"
VENV_ACTIVATE="${VENV_DIR}/bin/activate"

# Ensure python3 venv works on Ubuntu/WSL (python3-venv provides ensurepip).
if ! python3 -c "import venv, ensurepip" >/dev/null 2>&1; then
  echo "ERROR: python3 venv/ensurepip not available."
  echo "On Ubuntu/WSL you likely need: sudo apt-get update && sudo apt-get install -y python3-venv"
  exit 1
fi

if [[ ! -f "${VENV_ACTIVATE}" ]]; then
  rm -rf "${VENV_DIR}"
  (cd "${ROOT_DIR}/graph-editor" && python3 -m venv venv)
fi

# Activate the repo venv for pip installs (repo convention).
# shellcheck source=/dev/null
source "${VENV_ACTIVATE}"
python -m pip install --upgrade pip
(cd "${ROOT_DIR}/graph-editor" && pip install -r requirements.txt)

echo "==> Installing Playwright browsers"
(
  cd "${ROOT_DIR}/graph-editor"
  if [[ "$(uname -s)" == "Linux" ]]; then
    # On Linux/WSL Playwright's browser needs OS-level libraries (e.g. libnspr4.so).
    # This command installs both browsers + OS deps (requires sudo).
    npx playwright install --with-deps
  else
    npx playwright install
  fi
)

cat <<'EOF'
==> Done.

Next:
  - Start dev servers: ./dev-start.sh
  - Run e2e:          (cd graph-editor && npm run e2e)

Note (Linux/WSL): Playwright may prompt for sudo while installing OS deps.
EOF

