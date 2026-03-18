#!/usr/bin/env bash

# Deploy the Bayes Modal app.
# Usage: ./deploy-modal.sh
#
# Deploys bayes/app.py to Modal. Requires `modal` CLI to be installed
# and authenticated (modal token set).
#
# This is separate from release.sh because Modal and Vercel have
# independent deployment lifecycles — Modal only needs redeploying
# when bayes/ code changes.

set -e

# Simple color functions
print_blue() { printf '\033[0;34m%s\033[0m\n' "$*"; }
print_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
print_red() { printf '\033[0;31m%s\033[0m\n' "$*"; }
print_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

cd "$(dirname "$0")"

# Activate venv so modal CLI is on PATH
if [[ -f graph-editor/venv/bin/activate ]]; then
  source graph-editor/venv/bin/activate
fi

# Pre-flight checks
if ! command -v modal &>/dev/null; then
  print_red "Error: 'modal' CLI not found."
  echo "Install: pip install modal (inside graph-editor/venv)"
  echo "Auth:    modal token set"
  exit 1
fi

if [[ ! -f bayes/app.py ]]; then
  print_red "Error: bayes/app.py not found."
  exit 1
fi

print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
print_blue "  Deploying DagNet Bayes to Modal"
print_blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Show what's changed in bayes/ since last commit
BAYES_CHANGES=$(git diff --stat HEAD -- bayes/ 2>/dev/null || true)
if [[ -n "$BAYES_CHANGES" ]]; then
  print_yellow "Uncommitted changes in bayes/:"
  echo "$BAYES_CHANGES"
  echo ""
fi

# Deploy
print_blue "Running: modal deploy bayes/app.py"
echo ""

modal deploy bayes/app.py

echo ""
print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
print_green "  Modal deployment complete"
print_green "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
print_yellow "Note: Warm Modal containers may still run old code"
print_yellow "for a few minutes until they recycle."
echo ""
