"""Ensure the repo root is on sys.path so `bayes.*` imports work
regardless of where pytest is invoked from."""

import sys
from pathlib import Path

import pytest

repo_root = str(Path(__file__).resolve().parent.parent.parent)
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: Slow tests (MCMC param recovery, >3min)")
