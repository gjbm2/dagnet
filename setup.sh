#!/usr/bin/env bash
# setup.sh — Interactive one-stop setup for DagNet development.
#
# Usage:
#   ./setup.sh                    Interactive prompts
#   ./setup.sh --answers <file>   Pre-supply answers from a gitignored file
#
# Idempotent: safe to re-run at any time. Detects existing state,
# shows what's found, and asks before changing anything.
#
# Phases:
#   1. GitHub personal access token
#   2. Data repo (clone + app config)
#   3. Monorepo (optional, local reference)
#   4. Database connection (optional, for local snapshot writes)
#   5. Write config files + install dependencies
#   6. Summary
#
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

# ── Colours ──────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Answer file support ──────────────────────────────────────────────────────

ANSWERS_FILE=""
declare -A ANSWERS=()

for arg in "$@"; do
  case "${arg}" in
    --answers)
      shift
      ANSWERS_FILE="${1:-}"
      shift || true
      ;;
    --answers=*)
      ANSWERS_FILE="${arg#--answers=}"
      ;;
    -h|--help)
      echo "Usage: ./setup.sh [--answers <file>]"
      echo ""
      echo "  --answers <file>  Pre-supply answers from a key=value file (gitignored)."
      echo "                    Keys: GITHUB_TOKEN, DATA_REPO_URL, DATA_REPO_DIR,"
      echo "                    MONOREPO (y/n), MONOREPO_URL, MONOREPO_DIR,"
      echo "                    DATABASE (y/n), DB_CONNECTION"
      exit 0
      ;;
  esac
done

if [[ -n "${ANSWERS_FILE}" ]]; then
  if [[ ! -f "${ANSWERS_FILE}" ]]; then
    echo -e "${RED}ERROR: Answers file not found: ${ANSWERS_FILE}${NC}"
    exit 1
  fi
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    ANSWERS["$key"]="$value"
  done < "${ANSWERS_FILE}"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

prompt() {
  # prompt <VAR_NAME> <message> [default]
  local var_name="$1" msg="$2" default="${3:-}"
  if [[ -n "${ANSWERS[$var_name]+x}" ]]; then
    eval "$var_name=\"${ANSWERS[$var_name]}\""
    echo -e "  ${BLUE}(from answers file)${NC} $msg ${ANSWERS[$var_name]}"
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "  $msg [$default]: " val
    eval "$var_name=\"${val:-$default}\""
  else
    read -rp "  $msg " val
    eval "$var_name=\"$val\""
  fi
}

prompt_yn() {
  # prompt_yn <VAR_NAME> <message> <default: y|n>
  local var_name="$1" msg="$2" default="$3"
  if [[ -n "${ANSWERS[$var_name]+x}" ]]; then
    eval "$var_name=\"${ANSWERS[$var_name]}\""
    echo -e "  ${BLUE}(from answers file)${NC} $msg ${ANSWERS[$var_name]}"
    return
  fi
  local hint="y/n"
  [[ "$default" == "y" ]] && hint="Y/n"
  [[ "$default" == "n" ]] && hint="y/N"
  read -rp "  $msg ($hint): " val
  val="${val:-$default}"
  val="$(echo "$val" | tr '[:upper:]' '[:lower:]')"
  eval "$var_name=\"$val\""
}

read_env_key() {
  # read_env_key <file> <KEY> — reads KEY=value from a file, returns value
  local file="$1" key="$2"
  if [[ -f "$file" ]]; then
    grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  fi
}

set_env_key() {
  # set_env_key <file> <KEY> <VALUE> — upsert a key in a key=value file
  local file="$1" key="$2" value="$3"
  if [[ -f "$file" ]] && grep -q "^${key}=" "$file" 2>/dev/null; then
    # Replace existing line (portable sed -i)
    local tmp="${file}.tmp.$$"
    sed "s|^${key}=.*|${key}=${value}|" "$file" > "$tmp" && mv "$tmp" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

parse_github_url() {
  # parse_github_url <url> — sets PARSED_OWNER and PARSED_NAME
  local url="$1"
  url="${url%.git}"
  url="${url%/}"
  PARSED_NAME="$(basename "$url")"
  PARSED_OWNER="$(basename "$(dirname "$url")")"
}

github_api() {
  # github_api <path> — GET request to GitHub API, returns body
  curl -sf -H "Authorization: token ${GITHUB_TOKEN}" \
       -H "Accept: application/vnd.github.v3+json" \
       "https://api.github.com${1}" 2>/dev/null || true
}

# ── Banner ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  DagNet — Interactive Setup${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  This script configures your development environment."
echo "  It is idempotent — safe to re-run at any time."
echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 1 — GitHub token
# ═════════════════════════════════════════════════════════════════════════════

echo -e "${BOLD}Phase 1: GitHub personal access token${NC}"
echo ""

ENV_LOCAL="${ROOT_DIR}/graph-editor/.env.local"
EXISTING_TOKEN="$(read_env_key "$ENV_LOCAL" VITE_GITHUB_TOKEN)"
GITHUB_TOKEN=""

if [[ -n "$EXISTING_TOKEN" && "$EXISTING_TOKEN" != "your_github_token_here" ]]; then
  # Verify existing token
  USER_JSON="$(curl -sf -H "Authorization: token ${EXISTING_TOKEN}" \
                    -H "Accept: application/vnd.github.v3+json" \
                    "https://api.github.com/user" 2>/dev/null || true)"
  EXISTING_LOGIN="$(echo "$USER_JSON" | grep '"login"' | head -1 | sed 's/.*: *"//;s/".*//')"

  if [[ -n "$EXISTING_LOGIN" ]]; then
    echo -e "  ${GREEN}Token found${NC} — authenticated as ${BOLD}${EXISTING_LOGIN}${NC}"
    prompt_yn KEEP_TOKEN "Keep current token?" "y"
    if [[ "$KEEP_TOKEN" == "y" ]]; then
      GITHUB_TOKEN="$EXISTING_TOKEN"
    fi
  else
    echo -e "  ${YELLOW}Existing token is invalid or expired.${NC}"
  fi
fi

if [[ -z "$GITHUB_TOKEN" ]]; then
  echo ""
  echo "  You need a GitHub personal access token."
  echo ""
  echo "  Steps:"
  echo "    1. Go to https://github.com/settings/tokens"
  echo "    2. Click 'Generate new token' (classic)"
  echo "    3. Select scopes:"
  echo "       - ${BOLD}repo${NC} (full control of private repositories)"
  echo "       - ${BOLD}read:org${NC} (read org membership)"
  echo "    4. Set expiry (recommended: 90 days)"
  echo "    5. Click 'Generate token' and copy it"
  echo ""

  while true; do
    prompt GITHUB_TOKEN "Paste your token:"
    if [[ -z "$GITHUB_TOKEN" ]]; then
      echo -e "  ${RED}Token cannot be empty.${NC}"
      continue
    fi
    if [[ ! "$GITHUB_TOKEN" =~ ^(ghp_|github_pat_) ]]; then
      echo -e "  ${YELLOW}Warning: token doesn't start with ghp_ or github_pat_ — unusual but proceeding.${NC}"
    fi
    # Verify
    USER_JSON="$(github_api /user)"
    GH_LOGIN="$(echo "$USER_JSON" | grep '"login"' | head -1 | sed 's/.*: *"//;s/".*//')"
    if [[ -n "$GH_LOGIN" ]]; then
      echo -e "  ${GREEN}Authenticated as ${BOLD}${GH_LOGIN}${NC}"
      break
    else
      echo -e "  ${RED}Token verification failed. Check the token and try again.${NC}"
      GITHUB_TOKEN=""
    fi
  done
fi

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 2 — Data repo
# ═════════════════════════════════════════════════════════════════════════════

echo -e "${BOLD}Phase 2: Data repo${NC}"
echo ""
echo "  The data repo contains your conversion graphs, parameters, events,"
echo "  and graph-ops playbooks. DagNet accesses it via the GitHub API, and"
echo "  it will also be cloned locally for direct file access and agentic"
echo "  workflows."
echo ""
echo "  You need ${BOLD}collaborator (write) access${NC} to this repo."
echo "  Ask a team member for the URL if you don't have it."
echo ""

CONF="${ROOT_DIR}/.private-repos.conf"
DATA_REPO_DIR=""
DATA_REPO_URL=""
DATA_REPO_OWNER=""
DATA_REPO_NAME=""
SKIP_DATA_CLONE=false

# Check existing state
EXISTING_DATA_DIR="$(read_env_key "$CONF" DATA_REPO_DIR)"
if [[ -n "$EXISTING_DATA_DIR" && -d "${ROOT_DIR}/${EXISTING_DATA_DIR}/.git" ]]; then
  EXISTING_REMOTE="$(cd "${ROOT_DIR}/${EXISTING_DATA_DIR}" && git remote get-url origin 2>/dev/null || true)"
  echo -e "  ${GREEN}Data repo already cloned${NC} at ${BOLD}${EXISTING_DATA_DIR}/${NC}"
  [[ -n "$EXISTING_REMOTE" ]] && echo "  Remote: ${EXISTING_REMOTE}"
  prompt_yn KEEP_DATA "Keep current?" "y"
  if [[ "$KEEP_DATA" == "y" ]]; then
    DATA_REPO_DIR="$EXISTING_DATA_DIR"
    if [[ -n "$EXISTING_REMOTE" ]]; then
      parse_github_url "$EXISTING_REMOTE"
      DATA_REPO_OWNER="$PARSED_OWNER"
      DATA_REPO_NAME="$PARSED_NAME"
    fi
    SKIP_DATA_CLONE=true
  fi
fi

if [[ -z "$DATA_REPO_DIR" ]]; then
  while true; do
    prompt DATA_REPO_URL "Paste the HTTPS clone URL:"
    if [[ -z "$DATA_REPO_URL" ]]; then
      echo -e "  ${RED}URL cannot be empty.${NC}"
      continue
    fi
    parse_github_url "$DATA_REPO_URL"
    DATA_REPO_OWNER="$PARSED_OWNER"
    DATA_REPO_NAME="$PARSED_NAME"

    echo "  Checking access to ${DATA_REPO_OWNER}/${DATA_REPO_NAME}..."
    REPO_JSON="$(github_api "/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}")"
    if [[ -z "$REPO_JSON" ]]; then
      echo -e "  ${RED}Repo not found or no access. Check the URL and ensure you have collaborator access.${NC}"
      continue
    fi
    HAS_PUSH="$(echo "$REPO_JSON" | grep '"push"' | head -1 | sed 's/.*: *//;s/[, ]*//')"
    if [[ "$HAS_PUSH" != "true" ]]; then
      echo -e "  ${RED}You don't have push access to this repo. Ask the repo owner to add you as a collaborator.${NC}"
      continue
    fi
    echo -e "  ${GREEN}Access verified${NC} (push: true)"
    break
  done

  prompt DATA_REPO_DIR "Local directory name:" "$DATA_REPO_NAME"

  if [[ -d "${ROOT_DIR}/${DATA_REPO_DIR}" ]]; then
    echo -e "  ${YELLOW}Directory ${DATA_REPO_DIR}/ already exists.${NC}"
    if [[ -d "${ROOT_DIR}/${DATA_REPO_DIR}/.git" ]]; then
      echo "  It appears to be a git repo — skipping clone."
      SKIP_DATA_CLONE=true
    else
      echo -e "  ${RED}Directory exists but is not a git repo. Please remove it or choose a different name.${NC}"
      exit 1
    fi
  fi

  if [[ "$SKIP_DATA_CLONE" != true ]]; then
    echo "  Cloning ${DATA_REPO_OWNER}/${DATA_REPO_NAME} into ${DATA_REPO_DIR}/..."
    git clone "$DATA_REPO_URL" "${ROOT_DIR}/${DATA_REPO_DIR}"
    echo -e "  ${GREEN}Cloned.${NC}"
  fi
fi

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 3 — Monorepo (optional)
# ═════════════════════════════════════════════════════════════════════════════

echo -e "${BOLD}Phase 3: Production monorepo (optional)${NC}"
echo ""
echo "  The monorepo is the production web application. Cloned locally for"
echo "  reference — tracing API endpoints, understanding product behaviour."
echo "  Not accessed by DagNet itself."
echo ""

MONOREPO_DIR=""
MONOREPO_URL=""
SKIP_MONO_CLONE=false

EXISTING_MONO_DIR="$(read_env_key "$CONF" MONOREPO_DIR)"
if [[ -n "$EXISTING_MONO_DIR" && -d "${ROOT_DIR}/${EXISTING_MONO_DIR}/.git" ]]; then
  EXISTING_MONO_REMOTE="$(cd "${ROOT_DIR}/${EXISTING_MONO_DIR}" && git remote get-url origin 2>/dev/null || true)"
  echo -e "  ${GREEN}Monorepo already cloned${NC} at ${BOLD}${EXISTING_MONO_DIR}/${NC}"
  [[ -n "$EXISTING_MONO_REMOTE" ]] && echo "  Remote: ${EXISTING_MONO_REMOTE}"
  prompt_yn KEEP_MONO "Keep current?" "y"
  if [[ "$KEEP_MONO" == "y" ]]; then
    MONOREPO_DIR="$EXISTING_MONO_DIR"
    SKIP_MONO_CLONE=true
  fi
fi

if [[ -z "$MONOREPO_DIR" ]]; then
  prompt_yn WANT_MONO "Set up the production monorepo?" "y"
  if [[ "$WANT_MONO" == "y" ]]; then
    while true; do
      prompt MONOREPO_URL "Paste the HTTPS clone URL:"
      if [[ -z "$MONOREPO_URL" ]]; then
        echo -e "  ${RED}URL cannot be empty.${NC}"
        continue
      fi
      parse_github_url "$MONOREPO_URL"

      echo "  Checking access to ${PARSED_OWNER}/${PARSED_NAME}..."
      REPO_JSON="$(github_api "/repos/${PARSED_OWNER}/${PARSED_NAME}")"
      if [[ -z "$REPO_JSON" ]]; then
        echo -e "  ${RED}Repo not found or no access. Check the URL and your permissions.${NC}"
        continue
      fi
      echo -e "  ${GREEN}Access verified.${NC}"
      break
    done

    prompt MONOREPO_DIR "Local directory name:" "$PARSED_NAME"

    if [[ -d "${ROOT_DIR}/${MONOREPO_DIR}" ]]; then
      echo -e "  ${YELLOW}Directory ${MONOREPO_DIR}/ already exists.${NC}"
      if [[ -d "${ROOT_DIR}/${MONOREPO_DIR}/.git" ]]; then
        echo "  It appears to be a git repo — skipping clone."
        SKIP_MONO_CLONE=true
      else
        echo -e "  ${RED}Directory exists but is not a git repo. Please remove it or choose a different name.${NC}"
        exit 1
      fi
    fi

    if [[ "$SKIP_MONO_CLONE" != true ]]; then
      echo "  Cloning into ${MONOREPO_DIR}/..."
      git clone "$MONOREPO_URL" "${ROOT_DIR}/${MONOREPO_DIR}"
      echo -e "  ${GREEN}Cloned.${NC}"
    fi
  else
    echo "  Skipping monorepo setup."
    MONOREPO_DIR="PLACEHOLDER-set-me-later"
  fi
fi

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 4 — Database connection (optional)
# ═════════════════════════════════════════════════════════════════════════════

echo -e "${BOLD}Phase 4: Snapshot database (optional)${NC}"
echo ""
echo "  The Python backend uses a PostgreSQL database to store snapshot data."
echo "  Without it, snapshot writes from your local dev server will silently"
echo "  fail — time-series queries, cohort maturity charts, asat() queries,"
echo "  and Snapshot Manager won't work in your local environment."
echo ""

DB_CONNECTION=""

EXISTING_DB="$(read_env_key "$ENV_LOCAL" DB_CONNECTION)"
if [[ -n "$EXISTING_DB" ]]; then
  # Mask the connection string for display
  DB_MASKED="$(echo "$EXISTING_DB" | sed 's|://[^@]*@|://***@|')"
  echo -e "  ${GREEN}Database connection found${NC}: ${DB_MASKED}"
  prompt_yn KEEP_DB "Keep current?" "y"
  if [[ "$KEEP_DB" == "y" ]]; then
    DB_CONNECTION="$EXISTING_DB"
  fi
fi

if [[ -z "$DB_CONNECTION" ]]; then
  prompt_yn WANT_DB "Configure a snapshot database?" "y"
  if [[ "$WANT_DB" == "y" ]]; then
    echo ""
    echo "  Steps:"
    echo "    1. Sign up at https://neon.tech (free tier is sufficient)"
    echo "    2. Create a new project and database"
    echo "    3. Go to the dashboard and copy the connection string"
    echo ""

    while true; do
      prompt DB_CONNECTION "Paste your PostgreSQL connection string:"
      if [[ -z "$DB_CONNECTION" ]]; then
        echo -e "  ${RED}Connection string cannot be empty.${NC}"
        continue
      fi
      if [[ ! "$DB_CONNECTION" =~ ^postgres(ql)?:// ]]; then
        echo -e "  ${RED}Must start with postgresql:// or postgres://. Check and try again.${NC}"
        DB_CONNECTION=""
        continue
      fi
      echo -e "  ${GREEN}Connection string accepted.${NC}"
      break
    done
  else
    echo "  Skipping database setup. You can re-run this script later to add it."
  fi
fi

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 5 — Write config files + install dependencies
# ═════════════════════════════════════════════════════════════════════════════

echo -e "${BOLD}Phase 5: Writing config files and installing dependencies${NC}"
echo ""

# ── 5a. Write graph-editor/.env.local ────────────────────────────────────────

echo "==> Configuring graph-editor/.env.local"

if [[ ! -f "$ENV_LOCAL" ]]; then
  # Start from .env.example
  cp "${ROOT_DIR}/graph-editor/.env.example" "$ENV_LOCAL"
  echo "  Created from .env.example"
fi

set_env_key "$ENV_LOCAL" "VITE_GITHUB_TOKEN" "$GITHUB_TOKEN"
echo "  Set VITE_GITHUB_TOKEN"

if [[ -n "$DATA_REPO_OWNER" ]]; then
  set_env_key "$ENV_LOCAL" "VITE_GIT_REPO_OWNER" "$DATA_REPO_OWNER"
  echo "  Set VITE_GIT_REPO_OWNER=${DATA_REPO_OWNER}"
fi
if [[ -n "$DATA_REPO_NAME" ]]; then
  set_env_key "$ENV_LOCAL" "VITE_GIT_REPO_NAME" "$DATA_REPO_NAME"
  echo "  Set VITE_GIT_REPO_NAME=${DATA_REPO_NAME}"
fi

if [[ -n "$DB_CONNECTION" ]]; then
  set_env_key "$ENV_LOCAL" "DB_CONNECTION" "$DB_CONNECTION"
  set_env_key "$ENV_LOCAL" "VITE_SNAPSHOTS_ENABLED" "true"
  echo "  Set DB_CONNECTION and VITE_SNAPSHOTS_ENABLED=true"
fi

# ── 5b. Write .private-repos.conf ───────────────────────────────────────────

echo ""
echo "==> Configuring .private-repos.conf"

if [[ -n "$DATA_REPO_DIR" && "$DATA_REPO_DIR" != "PLACEHOLDER-set-me-later" ]]; then
  set_env_key "$CONF" "DATA_REPO_DIR" "$DATA_REPO_DIR"
  echo "  Set DATA_REPO_DIR=${DATA_REPO_DIR}"
fi
if [[ -n "$MONOREPO_DIR" ]]; then
  set_env_key "$CONF" "MONOREPO_DIR" "$MONOREPO_DIR"
  echo "  Set MONOREPO_DIR=${MONOREPO_DIR}"
fi

# ── 5c. Workspace safety setup ──────────────────────────────────────────────

echo ""
echo "==> Running workspace safety setup"

if [[ -f "${ROOT_DIR}/scripts/setup-workspace.sh" ]]; then
  if [[ -f "$CONF" ]]; then
    CONF_DATA="$(read_env_key "$CONF" DATA_REPO_DIR)"
    CONF_MONO="$(read_env_key "$CONF" MONOREPO_DIR)"
    if [[ -n "$CONF_DATA" && "$CONF_DATA" != "PLACEHOLDER-set-me-later" && \
          -n "$CONF_MONO" && "$CONF_MONO" != "PLACEHOLDER-set-me-later" ]]; then
      bash "${ROOT_DIR}/scripts/setup-workspace.sh"
    else
      echo -e "  ${YELLOW}Skipping — .private-repos.conf has placeholder values.${NC}"
      echo "  Run setup-workspace.sh after configuring both repo directories."
    fi
  else
    echo -e "  ${YELLOW}Skipping — .private-repos.conf not found.${NC}"
  fi
else
  echo -e "  ${YELLOW}scripts/setup-workspace.sh not found — skipping.${NC}"
fi

# ── 5d. Install dependencies ────────────────────────────────────────────────

echo ""
echo "==> Installing dependencies"

# Node via nvm
REQUIRED_NODE_MAJOR="$(tr -d '[:space:]' < "${ROOT_DIR}/graph-editor/.nvmrc" 2>/dev/null || echo "22")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
  echo "  Installing nvm..."
  if ! command -v curl &>/dev/null; then
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
      sudo apt-get update && sudo apt-get install -y curl
    elif [[ "$OSTYPE" == "darwin"* ]]; then
      brew install curl
    fi
  fi
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
fi

# shellcheck source=/dev/null
. "${NVM_DIR}/nvm.sh"

echo "  Node: ensuring v${REQUIRED_NODE_MAJOR}"
(
  cd "${ROOT_DIR}/graph-editor"
  nvm install "${REQUIRED_NODE_MAJOR}"
  nvm use "${REQUIRED_NODE_MAJOR}"
)

echo "  npm: installing frontend dependencies"
(
  cd "${ROOT_DIR}/graph-editor"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
)

echo "  Python: ensuring venv"
VENV_DIR="${ROOT_DIR}/graph-editor/venv"
VENV_ACTIVATE="${VENV_DIR}/bin/activate"

if ! python3 -c "import venv, ensurepip" >/dev/null 2>&1; then
  echo -e "  ${YELLOW}Installing python3-venv...${NC}"
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    py_minor="$(python3 -c "import sys; print(sys.version_info.minor)")"
    sudo apt-get update
    sudo apt-get install -y python3-venv || sudo apt-get install -y "python3.${py_minor}-venv"
  else
    echo -e "  ${RED}python3 venv/ensurepip not available. Install python3-venv and re-run.${NC}"
    exit 1
  fi
fi

if [[ ! -f "${VENV_ACTIVATE}" ]]; then
  rm -rf "${VENV_DIR}"
  (cd "${ROOT_DIR}/graph-editor" && python3 -m venv venv)
fi

# shellcheck source=/dev/null
source "${VENV_ACTIVATE}"
python -m pip install --upgrade pip --quiet
(cd "${ROOT_DIR}/graph-editor" && pip install -r requirements.txt --quiet)
echo -e "  ${GREEN}Python venv ready${NC}"

echo "  Playwright: installing browsers"
(
  cd "${ROOT_DIR}/graph-editor"
  if [[ "$(uname -s)" == "Linux" ]]; then
    npx playwright install --with-deps
  else
    npx playwright install
  fi
)

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 6 — Summary
# ═════════════════════════════════════════════════════════════════════════════

echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Setup complete${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo ""

# GitHub user
if [[ -n "${GH_LOGIN:-}" ]]; then
  echo -e "  GitHub user:      ${GREEN}${GH_LOGIN}${NC}"
elif [[ -n "${EXISTING_LOGIN:-}" ]]; then
  echo -e "  GitHub user:      ${GREEN}${EXISTING_LOGIN}${NC} (kept existing token)"
fi

# Data repo
if [[ -n "$DATA_REPO_OWNER" && -n "$DATA_REPO_NAME" ]]; then
  if [[ "$SKIP_DATA_CLONE" == true ]]; then
    echo -e "  Data repo:        ${GREEN}${DATA_REPO_OWNER}/${DATA_REPO_NAME}${NC} (already cloned at ${DATA_REPO_DIR}/)"
  else
    echo -e "  Data repo:        ${GREEN}${DATA_REPO_OWNER}/${DATA_REPO_NAME}${NC} (cloned to ${DATA_REPO_DIR}/)"
  fi
fi

# Monorepo
if [[ -n "$MONOREPO_DIR" && "$MONOREPO_DIR" != "PLACEHOLDER-set-me-later" ]]; then
  if [[ "$SKIP_MONO_CLONE" == true ]]; then
    echo -e "  Monorepo:         ${GREEN}already cloned${NC} at ${MONOREPO_DIR}/"
  else
    echo -e "  Monorepo:         ${GREEN}cloned${NC} to ${MONOREPO_DIR}/"
  fi
else
  echo -e "  Monorepo:         ${YELLOW}skipped${NC}"
fi

# Database
if [[ -n "$DB_CONNECTION" ]]; then
  echo -e "  Database:         ${GREEN}configured${NC}"
else
  echo -e "  Database:         ${YELLOW}skipped${NC} (snapshot writes won't work locally)"
fi

# Deps
NODE_VER="$(node --version 2>/dev/null || echo "unknown")"
echo -e "  Node:             ${GREEN}${NODE_VER}${NC}"
echo -e "  Python venv:      ${GREEN}graph-editor/venv${NC}"
echo -e "  Playwright:       ${GREEN}installed${NC}"

# Workspace hooks
if [[ "$(git config core.hooksPath 2>/dev/null)" == ".githooks" ]]; then
  echo -e "  Workspace hooks:  ${GREEN}active${NC}"
else
  echo -e "  Workspace hooks:  ${YELLOW}not active${NC} (run scripts/setup-workspace.sh after configuring both repos)"
fi

echo ""
echo "  Next:"
echo "    ./dev-start.sh          Start frontend + backend in tmux"
echo "    ./dev-start.sh --clean  Full clean reinstall + start"
echo ""
