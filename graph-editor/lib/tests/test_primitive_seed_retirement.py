"""
Stage 9 fixed-seed RNG retirement assertions.

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 1 — Primitive Posterior Contract" (final paragraph).

Stage 0a baseline: docs/current/project-bayes/73n-stage-0-baseline.md §1.12
inventories the 14 primitive-draw fixed-seed call sites that Stage 1 owns.
Stage 1's deliverable was the keyed-RNG seam (`runner.primitives.make_rng`);
Stage 9 closure requires the surviving primitive draw sites to consume that
seam directly. The deleted scoped-frame carrier helper is covered by the
active-cohort carrier audit rather than remaining here as an xfail.

The out-of-scope-classified non-primitive RNG sites listed in
73n-stage-0-baseline.md §1.12 are recorded in
docs/current/project-bayes/73n-stage-1-note.md and do not belong in this
file — they are fixed-seed by design (chart determinism, dev-only paths).
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

_RUNNER_DIR = Path(__file__).resolve().parent.parent / "runner"


def _function_body(source: str, fn_name: str) -> str:
    """Return the source of every ``def fn_name(...)`` block, joined.

    Uses Python's AST so multi-line signatures and nested definitions
    extract correctly. If a function is nested inside another, the
    outer function's extracted text already includes it, so the
    static-inspection assertions further down still see calls inside
    nested helpers when the named function is the outer one. When the
    named function is itself nested (e.g. an inner helper), AST walks
    the tree and pulls every match.
    """
    tree = ast.parse(source)
    fragments: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and \
                node.name == fn_name:
            fragments.append(ast.get_source_segment(source, node) or '')
    if not fragments:
        raise AssertionError(f"function {fn_name!r} not found in source")
    return "\n".join(fragments)


# Each entry locates one surviving primitive-draw call site recorded in
# 73n-stage-0-baseline.md §1.12. Stage 9 closure requires the site to use
# the keyed RNG derivation listed here.

_SITE_PARAMS = [
    ("forecast_state.py", "build_node_arrival_cache",
     "node_arrival_cache", "Stage 2"),
    ("forecast_runtime.py", "prepare_forecast_runtime_inputs",
     "subject_span_full_path_mc", "Stage 5b"),
    ("forecast_runtime.py", "prepare_forecast_runtime_inputs",
     "subject_span_epistemic_overlay", "Stage 5b"),
    ("forecast_runtime.py", "prepare_forecast_runtime_inputs",
     "anchor_relative_edge_p_mc", "Stage 5b"),
    ("forecast_runtime.py", "prepare_forecast_runtime_inputs",
     "anchor_relative_edge_epistemic", "Stage 5b"),
    ("forecast_runtime.py", "prepare_forecast_runtime_inputs",
     "last_edge_frontier_cdf", "Stage 5b"),
]


@pytest.mark.parametrize(
    "site",
    _SITE_PARAMS,
)
def test_primitive_draw_site_consumes_keyed_rng(site):
    """Each tracked site must consume `make_rng(key, derivation)` from
    runner.primitives, not `np.random.default_rng(seed=<int>)`. xfail
    strict until the named target stage migrates the site.

    This test inspects the function body in the source file. It is a
    static check, not a runtime check — sufficient because the keyed
    seam is a contract: a call site either uses the seam or it doesn't.
    """
    file_name, fn_name, expected_derivation, _target_stage = site
    src = (_RUNNER_DIR / file_name).read_text(encoding="utf-8")
    body = _function_body(src, fn_name)

    fixed_seed = re.search(
        r"np\.random\.default_rng\(\s*seed\s*=\s*(?:\d+|_BLEND_SEED|_[A-Z_]+SEED)",
        body,
    )
    bare_int_seed = re.search(
        r"np\.random\.default_rng\(\s*\d+\s*\)",
        body,
    )

    assert fixed_seed is None and bare_int_seed is None, (
        f"{file_name}::{fn_name} still uses a fixed-seed RNG; expected "
        f"make_rng(key, {expected_derivation!r}). Migration target: "
        f"{_target_stage}."
    )
    assert "make_rng" in body, (
        f"{file_name}::{fn_name} should consume make_rng from "
        f"runner.primitives with derivation {expected_derivation!r}."
    )


def test_all_xfail_derivations_are_registered():
    """Every tracked derivation must be registered so make_rng accepts it."""
    from runner.primitives import _DERIVATIONS
    for site in _SITE_PARAMS:
        _file, _fn, derivation, _stage = site
        assert derivation in _DERIVATIONS, (
            f"derivation {derivation!r} is named in the Stage 9 closure "
            f"list but not registered in runner.primitives._DERIVATIONS"
        )
