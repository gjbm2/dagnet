#!/usr/bin/env bash
# Start the dagnet-cli daemon.
#
# Reads NDJSON requests on stdin, writes NDJSON responses on stdout. See
# graph-editor/src/cli/daemon.ts for the wire format.
#
# Usage:
#   bash graph-ops/scripts/daemon.sh
#
# Environment:
#   DAGNET_DAEMON_IDLE_MS   Idle timeout in ms (default 300000 = 5 min)
#   PYTHON_API_URL          Python BE URL (default http://localhost:9000)

set -euo pipefail

. "$(dirname "$0")/_load-conf.sh"

# Set up Node via nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

cd "$_DAGNET_ROOT/graph-editor"

if [ -f .nvmrc ]; then
  nvm use "$(cat .nvmrc)" 2>/dev/null >&2 || true
fi

exec npx tsx src/cli/daemon.ts
