"""
Pytest configuration for tests under graph-editor/lib/tests.

These tests import modules as `lib.*` (e.g. `from lib.runner.graph_builder import ...`).
When pytest is invoked from the repo root, `graph-editor/` is not automatically on
`sys.path`, so `import lib` fails during collection.

This conftest ensures `graph-editor/` is on sys.path regardless of invocation cwd.
"""

from __future__ import annotations

import sys
from pathlib import Path


GRAPH_EDITOR_DIR = Path(__file__).resolve().parents[2]  # .../graph-editor

if str(GRAPH_EDITOR_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))


