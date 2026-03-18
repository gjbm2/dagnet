"""Ensure the repo root is on sys.path so `bayes.*` imports work
regardless of where pytest is invoked from."""

import sys
from pathlib import Path

repo_root = str(Path(__file__).resolve().parent.parent.parent)
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)
