#!/bin/bash
# dev-start.sh - Start both frontend and Python servers in split tmux panes
# Usage: ./dev-start.sh [--clean] [--detach]

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

usage() {
    echo "Usage: ./dev-start.sh [--clean] [--detach]"
    echo ""
    echo "  --clean   Remove caches/deps and reinstall before starting"
    echo "  --detach  Start (or reuse) tmux session 'dagnet' without attaching; exits quickly (Task Scheduler-safe)"
}

CLEAN_MODE=false
DETACH_MODE=false

for arg in "$@"; do
    case "${arg}" in
        --clean) CLEAN_MODE=true ;;
        --detach) DETACH_MODE=true ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: ${arg}"
            usage
            exit 2
            ;;
    esac
done

if [[ "${CLEAN_MODE}" == "true" && "${DETACH_MODE}" == "true" ]]; then
    echo "ERROR: --clean and --detach cannot be used together."
    exit 2
fi

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  DagNet Development Environment Setup${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

# Detached mode is intended for non-interactive startup (e.g. Task Scheduler):
# - does not install dependencies
# - does not attach to tmux
# - idempotent: if 'dagnet' session exists, exit 0 without spawning duplicates
if [[ "${DETACH_MODE}" == "true" ]]; then
    if ! command -v tmux &> /dev/null; then
        echo "ERROR: tmux not found. Install tmux before using --detach."
        exit 1
    fi

    # Load environment variables from .env.local (priority) or .env (fallback)
    if [ -f "graph-editor/.env.local" ]; then
        # Avoid set -e abort if grep finds no matches
        set +e
        export $(grep -v '^#' graph-editor/.env.local | grep -E '^VITE_PORT=|^PYTHON_API_PORT=|^DB_CONNECTION=' | xargs)
        set -e
    elif [ -f "graph-editor/.env" ]; then
        set +e
        export $(grep -v '^#' graph-editor/.env | grep -E '^VITE_PORT=|^PYTHON_API_PORT=|^DB_CONNECTION=' | xargs)
        set -e
    fi

    VITE_PORT=${VITE_PORT:-5173}
    PYTHON_API_PORT=${PYTHON_API_PORT:-9000}

    if tmux has-session -t dagnet 2>/dev/null; then
        echo "DagNet already running (tmux session 'dagnet' exists)."
        exit 0
    fi

    tmux new-session -d -s dagnet -n dev

    if [[ -f "${ROOT_DIR}/.tmux.conf.dagnet" ]]; then
        tmux source-file "${ROOT_DIR}/.tmux.conf.dagnet" || true
    fi

    # Pane 0: Frontend (Vite)
    tmux send-keys -t dagnet:dev.0 "cd \"${ROOT_DIR}/graph-editor\"" C-m
    tmux send-keys -t dagnet:dev.0 "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; if command -v nvm >/dev/null 2>&1; then nvm use \"\$(cat .nvmrc 2>/dev/null | tr -d '[:space:]' || echo 22)\"; fi; npm run dev" C-m

    # Pane 1: Backend (Python API)
    tmux split-window -h -t dagnet:dev
    tmux send-keys -t dagnet:dev.1 "cd \"${ROOT_DIR}/graph-editor\"" C-m
    tmux send-keys -t dagnet:dev.1 "source venv/bin/activate" C-m
    tmux send-keys -t dagnet:dev.1 "export PYTHON_API_PORT=${PYTHON_API_PORT}" C-m
    tmux send-keys -t dagnet:dev.1 "export VITE_PORT=${VITE_PORT}" C-m
    tmux send-keys -t dagnet:dev.1 "export DB_CONNECTION=\"${DB_CONNECTION}\"" C-m
    tmux send-keys -t dagnet:dev.1 "python dev-server.py" C-m

    echo "Started DagNet in detached tmux session 'dagnet' (window 'dev', panes 0/1)."
    echo "Frontend logs: dagnet:dev.0"
    echo "Backend logs:  dagnet:dev.1"
    exit 0
fi

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
    rm -rf graph-editor/venv
    find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
    find . -type f -name "*.pyc" -delete 2>/dev/null || true
    find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
    find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true
    
    echo -e "${GREEN}✓ Clean complete - fresh install incoming${NC}"
    echo ""
fi

# Ensure Node is installed + set to the repo-pinned version (graph-editor/.nvmrc)
REQUIRED_NODE_MAJOR="$(cat graph-editor/.nvmrc 2>/dev/null | tr -d '[:space:]')"
if [[ -z "${REQUIRED_NODE_MAJOR}" ]]; then
    REQUIRED_NODE_MAJOR="22"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "")"
if [[ "${NODE_MAJOR}" != "${REQUIRED_NODE_MAJOR}" ]]; then
    echo -e "${YELLOW}⚠️  Installing/using Node ${REQUIRED_NODE_MAJOR} (per graph-editor/.nvmrc)...${NC}"

    if [[ ! -s "${HOME}/.nvm/nvm.sh" ]]; then
        # Install nvm (user-space) if missing
        if ! command -v curl &> /dev/null; then
            if [[ "$OSTYPE" == "linux-gnu"* ]]; then
                sudo apt-get update && sudo apt-get install -y curl
            elif [[ "$OSTYPE" == "darwin"* ]]; then
                brew install curl
            fi
        fi
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
    fi

    # shellcheck source=/dev/null
    . "${HOME}/.nvm/nvm.sh"

    cd graph-editor
    nvm install "${REQUIRED_NODE_MAJOR}"
    nvm use "${REQUIRED_NODE_MAJOR}"
    cd ..
fi

# Install frontend dependencies
echo -e "${GREEN}📦 Installing frontend dependencies...${NC}"
cd graph-editor
npm install
cd ..

# Setup Python environment
echo -e "${GREEN}🐍 Setting up Python environment...${NC}"
VENV_DIR="graph-editor/venv"
VENV_ACTIVATE="${VENV_DIR}/bin/activate"

# Ensure `python3 -m venv` will work (needs both venv + ensurepip on Ubuntu/WSL)
if ! python3 -c "import venv, ensurepip" &> /dev/null; then
    echo -e "${YELLOW}⚠️  Installing Python venv support (ensurepip)...${NC}"
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        py_minor="$(python3 -c "import sys; print(sys.version_info.minor)")"
        sudo apt-get update
        if ! sudo apt-get install -y python3-venv; then
            sudo apt-get install -y "python3.${py_minor}-venv"
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Python ensurepip missing. Install a Python build that includes ensurepip (or install via pyenv) and re-run."
        exit 1
    else
        echo "Python ensurepip missing. Please install python3-venv (or equivalent) and re-run."
        exit 1
    fi
fi

# Create (or repair) venv in graph-editor/venv.
# We key off the activate script, not just the directory, because partial venvs can exist.
if [ ! -f "${VENV_ACTIVATE}" ]; then
    rm -rf "${VENV_DIR}"
    cd graph-editor && python3 -m venv venv && cd ..
    INSTALL_PY_DEPS=true
else
    INSTALL_PY_DEPS=false
fi

# Force reinstall in clean mode
if [ "$CLEAN_MODE" = true ]; then
    INSTALL_PY_DEPS=true
fi

if [ ! -f "${VENV_ACTIVATE}" ]; then
    echo -e "${YELLOW}ERROR:${NC} Expected venv activate script not found at ${VENV_ACTIVATE}"
    echo -e "${YELLOW}       venv creation appears to have failed. Try installing python3-venv and re-running.${NC}"
    exit 1
fi

source "${VENV_ACTIVATE}"

if [ "$INSTALL_PY_DEPS" = true ]; then
    echo -e "${GREEN}📦 Installing Python dependencies...${NC}"
    pip install --upgrade pip
    cd graph-editor && pip install -r requirements.txt && cd ..
else
    echo -e "${GREEN}✓ Using existing Python environment${NC}"
fi

echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Load environment variables from .env.local (priority) or .env (fallback)
if [ -f "graph-editor/.env.local" ]; then
    export $(grep -v '^#' graph-editor/.env.local | grep -E '^VITE_PORT=|^PYTHON_API_PORT=|^DB_CONNECTION=' | xargs)
elif [ -f "graph-editor/.env" ]; then
    export $(grep -v '^#' graph-editor/.env | grep -E '^VITE_PORT=|^PYTHON_API_PORT=|^DB_CONNECTION=' | xargs)
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
tmux source-file "${ROOT_DIR}/.tmux.conf.dagnet"

# Left pane: Frontend
tmux send-keys -t dagnet:dev.0 "cd \"${ROOT_DIR}/graph-editor\"" C-m
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
tmux send-keys -t dagnet:dev.1 "cd \"${ROOT_DIR}/graph-editor\"" C-m
tmux send-keys -t dagnet:dev.1 "source venv/bin/activate" C-m
tmux send-keys -t dagnet:dev.1 "export PYTHON_API_PORT=${PYTHON_API_PORT}" C-m
tmux send-keys -t dagnet:dev.1 "export VITE_PORT=${VITE_PORT}" C-m
tmux send-keys -t dagnet:dev.1 "export DB_CONNECTION=\"${DB_CONNECTION}\"" C-m
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

