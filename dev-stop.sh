#!/bin/bash
# dev-stop.sh - Stop both dev servers
# Usage: ./dev-stop.sh

set -e

echo "🛑 Stopping DagNet dev servers..."

# Kill tmux session if it exists
if tmux has-session -t dagnet 2>/dev/null; then
    tmux kill-session -t dagnet
    echo "✅ Servers stopped"
else
    echo "ℹ️  No running session found"
fi

# Also kill any stray processes on those ports
echo "🧹 Cleaning up any stray processes..."
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
lsof -ti:9000 | xargs kill -9 2>/dev/null || true

echo "✅ Done"

