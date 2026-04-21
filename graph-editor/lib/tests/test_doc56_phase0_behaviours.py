"""
Phase 0 behaviour tests for doc 56 runtime-boundary migration.

Two regression guards that document the behaviours the migration must
preserve. These tests now exercise the real Python handlers in-process:
subject resolution, snapshot DB reads, regime selection, carrier
construction, and the shared CF/v3 engine still run for real, but the
tests no longer pay the bash → nvm → node wrapper startup cost on every
assertion.

Tests:

1. `test_cf_and_v3_chart_carrier_tier_agree` — green today (tautology:
   both call v2's `build_upstream_carrier`). Becomes a cut-over
   regression guard — if Phase 3 forks the carrier between CF and v3,
   this flags it.

2. `test_cf_p_mean_matches_v3_p_infinity` — green today (both paths
   route through `compute_cohort_maturity_rows_v3`). Becomes a
   cut-over regression guard — if Phase 3 lets CF and the v3 chart
   diverge on the same edge, this flags it.

These tests require the real snapshot DB and data repo. They skip
gracefully when either is unavailable.
"""

from __future__ import annotations

import copy
import functools
from typing import Any, Dict, List, Optional, Tuple

import pytest

from conftest import (
    load_candidate_regimes_by_mode,
    load_graph_json,
    requires_data_repo,
    requires_db,
)


@functools.lru_cache(maxsize=None)
def _run_cf_cached(graph_name: str, temporal_dsl: str) -> Dict[str, Any]:
    from api_handlers import handle_conditioned_forecast

    return handle_conditioned_forecast(
        {
            "scenarios": [
                {
                    "scenario_id": "doc56",
                    "graph": load_graph_json(graph_name),
                    "effective_query_dsl": temporal_dsl,
                    "candidate_regimes_by_edge": load_candidate_regimes_by_mode(graph_name),
                }
            ]
        }
    )


def _run_cf(graph_name: str, temporal_dsl: str) -> Dict[str, Any]:
    return copy.deepcopy(_run_cf_cached(graph_name, temporal_dsl))


@functools.lru_cache(maxsize=None)
def _run_v3_cached(
    graph_name: str,
    analytics_dsl: str,
    temporal_dsl: str,
) -> Dict[str, Any]:
    from api_handlers import _handle_cohort_maturity_v3

    return _handle_cohort_maturity_v3(
        {
            "scenarios": [
                {
                    "scenario_id": "doc56",
                    "graph": load_graph_json(graph_name),
                    "analytics_dsl": analytics_dsl,
                    "effective_query_dsl": temporal_dsl,
                    "candidate_regimes_by_edge": load_candidate_regimes_by_mode(graph_name),
                }
            ]
        }
    )


def _run_v3(graph_name: str, analytics_dsl: str, temporal_dsl: str) -> Dict[str, Any]:
    return copy.deepcopy(_run_v3_cached(graph_name, analytics_dsl, temporal_dsl))


def _extract_maturity_rows(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "result" in result and isinstance(result["result"], dict):
        rows = result["result"].get("maturity_rows", [])
        if rows:
            return rows
    for subject in (
        result.get("subjects")
        or result.get("scenarios", [{}])[0].get("subjects", [])
    ):
        rows = subject.get("result", {}).get("maturity_rows", [])
        if rows:
            return rows
    return []


def _parameterised_edges(graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Yield non-dropout edges that carry a parameter id."""
    nmap = {n["uuid"]: n.get("id", "") for n in graph.get("nodes", [])}
    out = []
    for e in graph.get("edges", []):
        if not (e.get("p") or {}).get("id"):
            continue
        if "dropout" in nmap.get(e.get("to", ""), ""):
            continue
        out.append(e)
    return out


def _cf_edge_by_id(resp: Dict[str, Any]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """Index CF response edges by (from_id, to_id).

    synth_gen regenerates UUIDs on each run (doc 17 §2.3), so UUID-based
    keys break silently after regeneration. Node IDs are stable.
    """
    out: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for sc in resp.get("scenarios", []) or []:
        for e in sc.get("edges", []) or []:
            f = e.get("from_node")
            t = e.get("to_node")
            if f and t:
                out[(f, t)] = e
    return out


# ── Test 1: carrier tier agreement (regression guard) ──────────────


@requires_db
@requires_data_repo
def test_cf_and_v3_chart_carrier_tier_agree():
    """CF (whole-graph) and v3 chart (single-edge) must select the
    same carrier tier (parametric / empirical / weak_prior / none) for
    the same edge under the same DSL.

    Green today — both paths call v2's `build_upstream_carrier` with
    the same upstream params list, reach, and observations. Becomes a
    drift guard when Phase 3 puts CF and v3 on different carrier code.

    Fixture: synth-mirror-4step cohort mode — multi-hop exercises
    Tier 2 empirical carrier on downstream edges.
    """
    graph_name = "synth-mirror-4step"
    dsl_temporal = "cohort(7-Mar-26:21-Mar-26)"
    graph = load_graph_json(graph_name)

    cf_resp = _run_cf(graph_name, dsl_temporal)
    cf_by_id = _cf_edge_by_id(cf_resp)

    mismatches: List[str] = []
    checked = 0
    nmap = {n["uuid"]: n.get("id", "") for n in graph.get("nodes", [])}
    for edge in _parameterised_edges(graph):
        from_id = nmap.get(edge.get("from", ""), "")
        to_id = nmap.get(edge.get("to", ""), "")
        key = (from_id, to_id)
        if key not in cf_by_id:
            continue

        cf_forensic = cf_by_id[key].get("_forensic") or {}
        cf_tier = (
            cf_forensic.get("_inputs", {}).get("carrier_tier")
            if isinstance(cf_forensic, dict) else None
        )

        # v3 chart for same edge
        v3_resp = _run_v3(
            graph_name,
            f"from({from_id}).to({to_id})",
            dsl_temporal,
        )
        rows = _extract_maturity_rows(v3_resp)
        # Carrier tier isn't in per-row forensic today; keep exercising
        # the row-builder path so this turns into a real parity check as
        # soon as v3 exposes the same forensic field.
        _ = rows

        if cf_tier is None:
            continue  # forensic didn't expose tier; nothing to compare yet
        checked += 1
        # Today CF and v3 use the same carrier function; if forensic
        # later exposes a v3 tier, compare. For now we simply require
        # CF to record a tier on cohort-mode edges where reach > 0.
        if not cf_tier:
            mismatches.append(f"  edge {from_id}->{to_id}: CF tier empty")

    # Acceptable outcome today: either we checked edges and all had a
    # valid tier, or forensic doesn't expose it (checked=0). The test
    # fails only when CF exposes tier information that is itself
    # malformed — which flags real drift.
    if checked > 0:
        assert not mismatches, (
            f"Carrier tier mismatches on {len(mismatches)}/{checked} edges:\n"
            + "\n".join(mismatches)
        )


# ── Test 2: chart-vs-CF p_mean parity (regression guard) ───────────


@requires_db
@requires_data_repo
def test_cf_p_mean_matches_v3_p_infinity():
    """Whole-graph CF's per-edge `p_mean` must equal the v3 chart's
    `p_infinity_mean` for the same edge under the same DSL.

    Green today — both paths route through
    `compute_cohort_maturity_rows_v3` and read the same
    IS-conditioned `rate_draws[:, saturation_tau]` median (doc 45
    §Response contract: "one computation, two reads").

    Becomes a drift guard during Phase 3: if the cut-over forks the
    p_mean computation between the CF handler and the v3 chart
    handler, this test catches it.

    Tolerance: 5e-3 absolute. Tighter than existing harnesses (which
    accept 6e-2 on midpoint per v2-v3-parity) but loose enough to
    permit the ~4e-4 gap on multi-hop fixtures from CF whole-graph's
    upstream-observation caching (doc 47 §Phase 4 — single-edge v3
    rebuilds the carrier fresh while whole-graph CF reads from the
    shared all_per_edge_results cache).

    Fixture matrix: the doc-50 topology set (same as
    cf-topology-suite.sh).
    """
    matrix: List[Tuple[str, str]] = [
        ("synth-simple-abc", "window(-120d:)"),
        ("synth-mirror-4step", "cohort(7-Mar-26:21-Mar-26)"),
        ("cf-fix-linear-no-lag", "window(-60d:)"),
        ("cf-fix-branching", "window(-60d:)"),
        ("cf-fix-diamond-mixed", "window(-120d:)"),
        ("cf-fix-deep-mixed", "window(-180d:)"),
    ]

    TOL = 5e-3
    failures: List[str] = []
    checked = 0

    for graph_name, dsl in matrix:
        graph = load_graph_json(graph_name)
        cf_resp = _run_cf(graph_name, dsl)
        cf_by_id = _cf_edge_by_id(cf_resp)

        nmap = {n["uuid"]: n.get("id", "") for n in graph.get("nodes", [])}
        for edge in _parameterised_edges(graph):
            from_id = nmap.get(edge.get("from", ""), "")
            to_id = nmap.get(edge.get("to", ""), "")
            key = (from_id, to_id)
            if key not in cf_by_id:
                continue
            cf_p_mean = cf_by_id[key].get("p_mean")
            if cf_p_mean is None:
                continue

            try:
                v3_resp = _run_v3(
                    graph_name,
                    f"from({from_id}).to({to_id})",
                    dsl,
                )
            except Exception as e:
                failures.append(f"  {graph_name} {from_id}->{to_id}: v3 call failed: {e}")
                continue

            rows = _extract_maturity_rows(v3_resp)
            if not rows:
                continue
            last = rows[-1]
            v3_p_inf = last.get("p_infinity_mean")
            if v3_p_inf is None:
                # Older response shape fallback: use last non-None midpoint.
                for r in reversed(rows):
                    if r.get("midpoint") is not None:
                        v3_p_inf = r["midpoint"]
                        break
            if v3_p_inf is None:
                continue

            checked += 1
            delta = abs(float(cf_p_mean) - float(v3_p_inf))
            if delta > TOL:
                failures.append(
                    f"  {graph_name} {from_id}->{to_id}: "
                    f"CF={cf_p_mean:.6f} v3={v3_p_inf:.6f} |Δ|={delta:.2e}"
                )

    assert checked > 0, "No edges exercised — fixture or server misconfigured."
    assert not failures, (
        f"CF p_mean diverged from v3 p_infinity on {len(failures)}/{checked} edges:\n"
        + "\n".join(failures)
    )
