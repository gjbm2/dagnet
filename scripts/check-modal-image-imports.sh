#!/usr/bin/env bash
#
# Verify that the Bayes worker's import chain resolves under the *Modal
# worker image's* dependency surface — i.e. nothing more than
# bayes/requirements.txt plus PYTHONPATH=bayes:graph-editor/lib.
#
# The local dev venv layers BOTH graph-editor/requirements-local.txt AND
# bayes/requirements.txt, so a missing dep on the Modal side is invisible
# locally; this script catches it before deploy.
#
# It caches an isolated venv under ~/.cache/dagnet-cli/modal-image-venv/
# keyed by a hash of bayes/requirements.txt, so re-runs are fast unless
# the requirements change.
#
# Usage: scripts/check-modal-image-imports.sh
# Exit codes: 0 = imports clean; non-zero = something missing or broken.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REQ_FILE="$REPO_ROOT/bayes/requirements.txt"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/dagnet-cli/modal-image-venv"
HASH_FILE="$CACHE_DIR/.requirements.sha256"

if [[ ! -f "$REQ_FILE" ]]; then
  echo "✗ $REQ_FILE not found" >&2
  exit 2
fi

REQ_HASH="$(sha256sum "$REQ_FILE" | awk '{print $1}')"

needs_install=true
if [[ -f "$HASH_FILE" ]] && [[ -x "$CACHE_DIR/bin/python" ]]; then
  if [[ "$(cat "$HASH_FILE")" == "$REQ_HASH" ]]; then
    needs_install=false
  fi
fi

if [[ "$needs_install" == true ]]; then
  echo "Modal-image venv stale or missing — (re)building at $CACHE_DIR"
  rm -rf "$CACHE_DIR"
  python3 -m venv "$CACHE_DIR"
  # shellcheck disable=SC1091
  source "$CACHE_DIR/bin/activate"
  pip install --quiet --upgrade pip
  pip install --quiet -r "$REQ_FILE"
  deactivate
  echo "$REQ_HASH" > "$HASH_FILE"
  echo "  ✓ Modal-image venv built"
fi

# Run the Bayes worker's load-bearing import chain inside the isolated
# venv, with PYTHONPATH matching the Modal worker image
# (bayes/app.py: PYTHONPATH=/root/bayes:/root/lib).
PYTHONPATH="$REPO_ROOT/bayes:$REPO_ROOT/graph-editor/lib" \
  "$CACHE_DIR/bin/python" - <<'PY'
import sys
try:
    # The chain that fit_graph triggers on first invocation.
    # compiler/__init__.py unconditionally loads evidence.py, which loads
    # runner.evidence_adapters → runner/__init__.py → analyzer.py
    # (which top-imports networkx, pydantic, etc.).
    from compiler import (
        analyse_topology,
        bind_evidence,
        build_model,
        run_inference,
        summarise_posteriors,
    )
    from worker import fit_graph
except Exception as exc:
    print(f"✗ Bayes worker import chain failed under Modal-image deps:", file=sys.stderr)
    print(f"  {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(1)
print("✓ Bayes worker imports resolve under bayes/requirements.txt alone")
PY
