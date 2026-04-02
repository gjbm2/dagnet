#!/usr/bin/env bash
# test-watch.sh — split-screen tmux session running Vitest + pytest in watch mode
#
# Usage:
#   scripts/test-watch.sh          # start the session
#   scripts/test-watch.sh kill     # kill the session
#
# Panes:
#   Top    — Vitest (npm test, watch mode)
#   Bottom — pytest-watch (ptw)
#
# Press Ctrl-B then D to detach. Re-attach with: tmux attach -t test-watch

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="test-watch"

# Kill subcommand
if [[ "${1:-}" == "kill" ]]; then
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "Killed session '$SESSION'" || echo "No session '$SESSION' found"
  exit 0
fi

# Don't nest inside an existing tmux session
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists. Attach with: tmux attach -t $SESSION"
  echo "Or kill it with: $0 kill"
  exit 1
fi

# Source nvm if available (needed for node/npm)
NVM_INIT=""
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  NVM_INIT='export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh";'
fi

# Create session with Vitest in the first pane
tmux new-session -d -s "$SESSION" -c "$REPO_ROOT/graph-editor" \
  "$NVM_INIT nvm use \$(cat .nvmrc) 2>/dev/null; echo '=== Vitest (watch mode) ==='; npm test 2>&1; read"

# Split horizontally and run pytest-watch in the bottom pane
tmux split-window -v -t "$SESSION" -c "$REPO_ROOT" \
  ". graph-editor/venv/bin/activate; echo '=== pytest-watch ==='; ptw -- -x --tb=short 2>&1; read"

# Give equal space to both panes
tmux select-layout -t "$SESSION" even-vertical

# Attach
tmux attach -t "$SESSION"
