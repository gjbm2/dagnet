#!/bin/bash
# dev-start.sh - Start both frontend and Python servers in split tmux panes
# Usage: ./dev-start.sh [--clean]

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

CLEAN_MODE=false
if [[ "$1" == "--clean" ]]; then
    CLEAN_MODE=true
fi

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  DagNet Development Environment Setup${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo -e "${YELLOW}⚠️  tmux not found. Installing...${NC}"
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        sudo apt-get update && sudo apt-get install -y tmux
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install tmux
    else
        echo "Please install tmux manually: https://github.com/tmux/tmux/wiki"
        exit 1
    fi
fi

# Clean npm cache if requested
if [ "$CLEAN_MODE" = true ]; then
    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  CLEAN MODE: Removing all caches and dependencies${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo ""
    
    echo -e "${GREEN}🧹 Cleaning npm cache and node_modules...${NC}"
    cd graph-editor
    npm cache clean --force 2>/dev/null || true
    rm -rf node_modules package-lock.json
    cd ..
    
    echo -e "${GREEN}🧹 Cleaning Python environment and cache...${NC}"
    rm -rf venv
    find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
    find . -type f -name "*.pyc" -delete 2>/dev/null || true
    find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
    find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true
    
    echo -e "${GREEN}✓ Clean complete - fresh install incoming${NC}"
    echo ""
fi

# Install frontend dependencies
echo -e "${GREEN}📦 Installing frontend dependencies...${NC}"
cd graph-editor
npm install
cd ..

# Setup Python environment
echo -e "${GREEN}🐍 Setting up Python environment...${NC}"
if [ ! -d "venv" ]; then
    python3 -m venv venv
    INSTALL_PY_DEPS=true
else
    INSTALL_PY_DEPS=false
fi

# Force reinstall in clean mode
if [ "$CLEAN_MODE" = true ]; then
    INSTALL_PY_DEPS=true
fi

source venv/bin/activate

if [ "$INSTALL_PY_DEPS" = true ]; then
    echo -e "${GREEN}📦 Installing Python dependencies...${NC}"
    pip install --upgrade pip
    pip install -q fastapi uvicorn[standard] networkx pydantic pytest
else
    echo -e "${GREEN}✓ Using existing Python environment${NC}"
fi

echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Load environment variables from .env.local (priority) or .env (fallback)
if [ -f "graph-editor/.env.local" ]; then
    export $(grep -v '^#' graph-editor/.env.local | grep -E '^VITE_PORT=|^PYTHON_API_PORT=' | xargs)
elif [ -f "graph-editor/.env" ]; then
    export $(grep -v '^#' graph-editor/.env | grep -E '^VITE_PORT=|^PYTHON_API_PORT=' | xargs)
fi

# Default ports if not set
VITE_PORT=${VITE_PORT:-5173}
PYTHON_API_PORT=${PYTHON_API_PORT:-9000}

echo -e "${BLUE}Starting tmux session with split panes...${NC}"
echo -e "${YELLOW}  Left pane:  Frontend (http://localhost:${VITE_PORT})${NC}"
echo -e "${YELLOW}  Right pane: Python API (http://localhost:${PYTHON_API_PORT})${NC}"
echo ""
echo -e "${BLUE}Tmux commands:${NC}"
echo -e "  ${GREEN}Ctrl+B then R${NC}        - ${GREEN}⚡ Restart both servers${NC}"
echo -e "  ${GREEN}Ctrl+B then K${NC}        - ${GREEN}⏹️  Kill both servers${NC}"
echo -e "  Ctrl+B then ←/→      - Switch panes"
echo -e "  Ctrl+B then [        - Scroll mode (q to exit)"
echo -e "  Ctrl+B then d        - Detach (keeps running)"
echo -e "  tmux attach          - Reattach to session"
echo ""
sleep 2

# Kill existing dagnet tmux session if it exists
tmux kill-session -t dagnet 2>/dev/null || true

# Create new tmux session with split panes
tmux new-session -d -s dagnet -n dev

# Load custom keybindings for this session
tmux source-file $(pwd)/.tmux.conf.dagnet

# Left pane: Frontend
tmux send-keys -t dagnet:dev.0 "cd $(pwd)/graph-editor" C-m
tmux send-keys -t dagnet:dev.0 "clear" C-m
tmux send-keys -t dagnet:dev.0 "echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'" C-m
tmux send-keys -t dagnet:dev.0 "echo '  🚀 VITE DEV SERVER (Frontend)'" C-m
tmux send-keys -t dagnet:dev.0 "echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'" C-m
tmux send-keys -t dagnet:dev.0 "echo '  ⚡ Ctrl+B then R  - Restart both servers'" C-m
tmux send-keys -t dagnet:dev.0 "echo '  ⏹️  Ctrl+B then K  - Kill both servers'" C-m
tmux send-keys -t dagnet:dev.0 "echo '  ↔️  Ctrl+B then ←→ - Switch panes'" C-m
tmux send-keys -t dagnet:dev.0 "echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'" C-m
tmux send-keys -t dagnet:dev.0 "echo ''" C-m
tmux send-keys -t dagnet:dev.0 "npm run dev" C-m

# Split window vertically and setup right pane: Python
tmux split-window -h -t dagnet:dev
tmux send-keys -t dagnet:dev.1 "cd $(pwd)" C-m
tmux send-keys -t dagnet:dev.1 "source venv/bin/activate" C-m
tmux send-keys -t dagnet:dev.1 "export PYTHON_API_PORT=${PYTHON_API_PORT}" C-m
tmux send-keys -t dagnet:dev.1 "export VITE_PORT=${VITE_PORT}" C-m
tmux send-keys -t dagnet:dev.1 "clear" C-m
tmux send-keys -t dagnet:dev.1 "echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'" C-m
tmux send-keys -t dagnet:dev.1 "echo '  🐍 PYTHON API SERVER (Backend)'" C-m
tmux send-keys -t dagnet:dev.1 "echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'" C-m
tmux send-keys -t dagnet:dev.1 "echo '  ⚡ Ctrl+B then R  - Restart both servers'" C-m
tmux send-keys -t dagnet:dev.1 "echo '  ⏹️  Ctrl+B then K  - Kill both servers'" C-m
tmux send-keys -t dagnet:dev.1 "echo '  ↔️  Ctrl+B then ←→ - Switch panes'" C-m
tmux send-keys -t dagnet:dev.1 "echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'" C-m
tmux send-keys -t dagnet:dev.1 "echo ''" C-m
tmux send-keys -t dagnet:dev.1 "python dev-server.py" C-m

# Attach to the session
tmux attach-session -t dagnet:dev

