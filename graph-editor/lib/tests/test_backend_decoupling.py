"""
Test that the Python backend is logically decoupled from the frontend.

The Python backend may run on a remote server (e.g. Vercel serverless) with
NO access to the frontend filesystem. Production code in lib/ must NOT read
files from frontend directories (public/, src/, etc.).

Acceptable:
  - Reading files WITHIN lib/ (e.g. runner/analysis_types.yaml) — these are
    co-deployed with the backend.
  - sys.path manipulation using __file__ (for dynamic imports within lib/).
  - Test-only code (lib/tests/) reading fixtures.

Not acceptable:
  - Any production code in lib/ that reads from public/, src/, or other
    frontend directories.
"""

import ast
import re
from pathlib import Path

LIB_DIR = Path(__file__).parent.parent
GRAPH_EDITOR_DIR = LIB_DIR.parent

# Directories that are frontend-only — Python must never read from these at runtime.
FRONTEND_DIRS = {'public', 'src', 'node_modules', 'e2e', 'dist'}


def _production_py_files():
    """Yield all production .py files in lib/ (excluding tests/ and tools/)."""
    for py_file in LIB_DIR.rglob('*.py'):
        rel = py_file.relative_to(LIB_DIR)
        parts = rel.parts
        # Skip test and tool directories — they're not production code.
        if any(p in ('tests', 'tools', '__pycache__') for p in parts):
            continue
        yield py_file


def _scan_for_frontend_path_references(filepath: Path) -> list:
    """
    Scan a Python source file for path constructions that reference
    frontend directories (public/, src/, etc.).

    Returns a list of (line_number, line_text, reason) tuples.
    """
    violations = []
    try:
        source = filepath.read_text(encoding='utf-8')
    except Exception:
        return violations

    for i, line in enumerate(source.splitlines(), start=1):
        stripped = line.strip()
        # Skip comments and blank lines.
        if not stripped or stripped.startswith('#'):
            continue
        # Check for string literals that reference frontend directories.
        for frontend_dir in FRONTEND_DIRS:
            # Match path constructions like: / "public" / or /"public"/ or 'public'
            # Also match string literals containing the dir name as a path segment.
            patterns = [
                rf'["\']\.?/?{frontend_dir}/',       # "public/" or 'public/'
                rf'["\']\.?/?{frontend_dir}["\']',    # "public" as a path component
                rf'/\s*["\']{frontend_dir}["\']',     # / "public"
            ]
            for pat in patterns:
                if re.search(pat, stripped):
                    violations.append((i, stripped, f'references frontend directory "{frontend_dir}"'))
                    break

    return violations


class TestBackendDecoupling:
    """Assert that production Python code has no dependencies on frontend directories."""

    def test_no_production_code_reads_from_frontend_directories(self):
        """
        Scan all production .py files in lib/ for path references to
        frontend directories (public/, src/, node_modules/, etc.).

        This test will FAIL if any production code constructs paths to
        frontend directories. The fix is to either:
        - Receive the data via API request instead of reading a file, or
        - Move the file into lib/ (co-deployed with the backend).
        """
        all_violations = {}

        for py_file in _production_py_files():
            violations = _scan_for_frontend_path_references(py_file)
            if violations:
                rel_path = py_file.relative_to(LIB_DIR)
                all_violations[str(rel_path)] = violations

        if all_violations:
            msg_parts = ['Production Python code references frontend directories:\n']
            for filepath, violations in sorted(all_violations.items()):
                for line_no, line_text, reason in violations:
                    msg_parts.append(f'  {filepath}:{line_no}: {reason}')
                    msg_parts.append(f'    {line_text}')
            assert False, '\n'.join(msg_parts)

    def test_no_open_calls_outside_lib(self):
        """
        Parse all production .py files and check that any open() calls
        do not construct paths that escape lib/.

        This is a heuristic check — it looks for Path constructions that
        navigate to parent directories (.parent) combined with frontend
        directory names.
        """
        violations = []

        for py_file in _production_py_files():
            try:
                source = py_file.read_text(encoding='utf-8')
            except Exception:
                continue

            # Simple heuristic: if a file uses .parent to escape lib/
            # AND references a frontend dir, it's likely reading from frontend.
            has_parent_escape = '.parent' in source and any(
                f'"{d}"' in source or f"'{d}'" in source
                for d in FRONTEND_DIRS
            )
            if has_parent_escape:
                rel_path = py_file.relative_to(LIB_DIR)
                # Find the specific lines.
                for i, line in enumerate(source.splitlines(), start=1):
                    if '.parent' in line and any(
                        f'"{d}"' in line or f"'{d}'" in line
                        for d in FRONTEND_DIRS
                    ):
                        violations.append(f'  {rel_path}:{i}: {line.strip()}')

        if violations:
            msg = 'Production code escapes lib/ to reach frontend directories:\n'
            msg += '\n'.join(violations)
            assert False, msg
