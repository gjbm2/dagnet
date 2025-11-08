#!/bin/bash
# dev-restart.sh - Restart both servers in current tmux session
# Usage: Call from within tmux session

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔄 Restarting servers...${NC}"

# Load environment variables
if [ -f "graph-editor/.env.local" ]; then
    export $(grep -v '^#' graph-editor/.env.local | grep -E '^VITE_PORT=|^PYTHON_API_PORT=' | xargs 2>/dev/null)
elif [ -f "graph-editor/.env" ]; then
    export $(grep -v '^#' graph-editor/.env | grep -E '^VITE_PORT=|^PYTHON_API_PORT=' | xargs 2>/dev/null)
fi

PYTHON_API_PORT=${PYTHON_API_PORT:-9000}

# Kill both servers
tmux send-keys -t dagnet:dev.0 C-c
tmux send-keys -t dagnet:dev.1 C-c

sleep 1

# Restart frontend (left pane)
tmux send-keys -t dagnet:dev.0 "npm run dev" C-m

# Restart Python (right pane) 
tmux send-keys -t dagnet:dev.1 "python dev-server.py" C-m

echo -e "${GREEN}✅ Servers restarted${NC}"

