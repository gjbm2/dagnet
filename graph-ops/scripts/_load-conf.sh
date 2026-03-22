#!/usr/bin/env bash
# Shared helper: load repo directory names from config.
# Source this from other scripts: . "$(dirname "$0")/_load-conf.sh"
#
# graph-ops lives in the dagnet repo. It reads .private-repos.conf from
# the dagnet root to discover the data repo directory name.

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DAGNET_ROOT="$(cd "$_SCRIPT_DIR/../.." && pwd)"

_CONF="$_DAGNET_ROOT/.private-repos.conf"

if [ ! -f "$_CONF" ]; then
  echo "ERROR: Cannot find .private-repos.conf at dagnet root: $_DAGNET_ROOT"
  exit 1
fi

DATA_REPO_DIR=$(grep '^DATA_REPO_DIR=' "$_CONF" | cut -d= -f2-)
MONOREPO_DIR=$(grep '^MONOREPO_DIR=' "$_CONF" | cut -d= -f2-)

if [ -z "$DATA_REPO_DIR" ]; then
  echo "ERROR: DATA_REPO_DIR not set in $_CONF"
  exit 1
fi

# Resolve the data repo path (sibling of dagnet root)
DATA_REPO_PATH="$_DAGNET_ROOT/$DATA_REPO_DIR"

if [ ! -d "$DATA_REPO_PATH" ]; then
  echo "ERROR: Data repo not found at $DATA_REPO_PATH"
  echo "Check DATA_REPO_DIR in $_CONF"
  exit 1
fi
