"""
Dependency-audit test for the production forecast stack (doc 56).

After Phase 3 cut-over, these assertions must hold. They are RED
before the migration and turn GREEN as each phase lands.

The production forecast stack comprises three modules:
  - graph-editor/lib/runner/forecast_state.py    (engine)
  - graph-editor/lib/runner/cohort_forecast_v3.py (row builder)
  - handle_conditioned_forecast in api_handlers.py (CF handler)

None of the above may import from:
  - cohort_forecast_v2.py      (parity oracle only — not runtime infra)
  - span_adapter.py            (transitional; deleted in Phase 4)
  - cohort_forecast.py         (v1; deleted in Phase 4 unless a dev-only
                                overlap is explicitly retained)

Imports from the promoted tier (span_kernel, span_evidence, forecast_state
itself, model_resolver) are allowed and expected.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest


_LIB = Path(__file__).resolve().parent.parent
_FORECAST_STATE = _LIB / "runner" / "forecast_state.py"
_V3 = _LIB / "runner" / "cohort_forecast_v3.py"
_API_HANDLERS = _LIB / "api_handlers.py"

BANNED_MODULES = {
    "cohort_forecast_v2",
    "span_adapter",
    "cohort_forecast",
}

# Module name aliases that may appear in `from runner.<name>` or `from .<name>`
BANNED_FROM_TARGETS = {
    *(f"runner.{m}" for m in BANNED_MODULES),
    *(f".{m}" for m in BANNED_MODULES),
    *BANNED_MODULES,
}


def _collect_imports(source: str) -> list[tuple[str, int]]:
    """Return (module_name, line_number) tuples for every import.

    Handles `import X`, `import X as Y`, `from X import Y`,
    `from .X import Y`, `from runner.X import Y`. Catches both module-level
    and function-scope lazy imports, which is important because
    `api_handlers.py` uses many lazy imports inside `handle_conditioned_forecast`.
    """
    tree = ast.parse(source)
    imports: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append((alias.name, node.lineno))
        elif isinstance(node, ast.ImportFrom):
            # Relative imports: node.level>0, node.module is the path after dots
            if node.level and node.module is None:
                continue
            if node.level:
                mod = "." * node.level + (node.module or "")
            else:
                mod = node.module or ""
            imports.append((mod, node.lineno))
    return imports


def _banned_hits_in_file(path: Path) -> list[tuple[str, int]]:
    source = path.read_text()
    hits: list[tuple[str, int]] = []
    for mod, line in _collect_imports(source):
        if mod in BANNED_FROM_TARGETS:
            hits.append((mod, line))
    return hits


def _function_body_imports(func_name: str) -> list[tuple[str, int]]:
    """Return banned imports that live inside a named top-level function.

    The rest of api_handlers.py contains legitimate v2/v1 call sites
    (the frozen v2 chart handler, parity comparators, etc.). We guard
    only the named function body.
    """
    source = _API_HANDLERS.read_text()
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            hits: list[tuple[str, int]] = []
            for sub in ast.walk(node):
                if isinstance(sub, ast.ImportFrom):
                    if sub.level and sub.module is None:
                        continue
                    if sub.level:
                        mod = "." * sub.level + (sub.module or "")
                    else:
                        mod = sub.module or ""
                    if mod in BANNED_FROM_TARGETS:
                        hits.append((mod, sub.lineno))
                elif isinstance(sub, ast.Import):
                    for alias in sub.names:
                        if alias.name in BANNED_FROM_TARGETS:
                            hits.append((alias.name, sub.lineno))
            return hits
    raise AssertionError(f"{func_name} not found in api_handlers.py")


def _handle_conditioned_forecast_imports() -> list[tuple[str, int]]:
    return _function_body_imports("handle_conditioned_forecast")


def _handle_cohort_maturity_v3_imports() -> list[tuple[str, int]]:
    return _function_body_imports("_handle_cohort_maturity_v3")


# ── Assertions (RED until Phase 3 cut-over) ─────────────────────────


@pytest.mark.xfail(reason="Doc 56 Phase 2 — engine cut-over pending", strict=False)
def test_engine_has_no_v1_v2_imports():
    hits = _banned_hits_in_file(_FORECAST_STATE)
    assert hits == [], (
        f"forecast_state.py must not import from {BANNED_MODULES}. "
        f"Found: {hits}"
    )


@pytest.mark.xfail(reason="Doc 56 Phase 3 — v3 cut-over pending", strict=False)
def test_v3_row_builder_has_no_v1_v2_imports():
    hits = _banned_hits_in_file(_V3)
    assert hits == [], (
        f"cohort_forecast_v3.py must not import from {BANNED_MODULES}. "
        f"Found: {hits}"
    )


@pytest.mark.xfail(reason="Doc 56 Phase 3 — CF handler cut-over pending", strict=False)
def test_cf_handler_has_no_v1_v2_imports():
    hits = _handle_conditioned_forecast_imports()
    assert hits == [], (
        f"handle_conditioned_forecast must not import from {BANNED_MODULES}. "
        f"Found: {hits}"
    )


@pytest.mark.xfail(reason="Doc 56 Phase 3 — v3 chart handler cut-over pending", strict=False)
def test_v3_chart_handler_has_no_v1_v2_imports():
    hits = _handle_cohort_maturity_v3_imports()
    assert hits == [], (
        f"_handle_cohort_maturity_v3 must not import from {BANNED_MODULES}. "
        f"Found: {hits}"
    )
