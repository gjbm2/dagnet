"""Stage 1: the shared forecast evidence admission helper.

Single-evidence-admission-binding plan (29-May-26), Stage 1 — "Add A Tiny
Forecast Admission Helper".

`runner.forecast_admission.admit_forecast_evidence` is the named extraction
surface for the cohort-maturity evidence binder. These tests pin the Stage 1
stop conditions:

  1. The helper produces the SAME `ForecastPreparation` as the current
     cohort-maturity path for the known query. The oracle is the inline
     resolve→prepare sequence the cohort-maturity handler runs
     (`api_handlers.py:1511-1544`).
  2. The helper uses cohort-maturity read semantics, so its admitted evidence
     frontier is `asat`-bounded (the property daily must adopt in Stage 2) —
     NOT the unbounded `raw_snapshots` frontier daily uses today.

Snapshot DB access is mocked; the sweep mock honours its `[sweep_from,
sweep_to]` bounds exactly as the real SQL does, so the asat frontier emerges
from the read-mode-driven subject stamping rather than by fiat.
"""

import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import patch  # noqa: E402


SUBJECT_DSL = "from(simple-a).to(simple-b)"
TEMPORAL_DSL = "window(10-Jan-26:10-Jan-26).asat(20-Jan-26)"
ANCHOR_DAY = "2026-01-10"
ASAT_DAY = "2026-01-20"
SLICE_KEY = "window(10-Jan-26:10-Jan-26)"

# One Cohort measured three times; the last observation is AFTER asat. Only the
# unbounded (raw_snapshots) sweep would admit it — cohort_maturity caps at asat.
_RETRIEVED = {"2026-01-15": 30, "2026-01-20": 40, "2026-01-25": 50}


def _master_rows():
    rows = []
    for rday, y in _RETRIEVED.items():
        rows.append({
            "param_id": "pytest-admit-param",
            "core_hash": "admit-hash",
            "slice_key": SLICE_KEY,
            "anchor_day": ANCHOR_DAY,
            "retrieved_at": f"{rday}T12:00:00+00:00",
            "a": 100, "x": 100, "y": y,
            "median_lag_days": 6.0, "mean_lag_days": 6.0,
            "anchor_median_lag_days": 0.0, "anchor_mean_lag_days": 0.0,
            "onset_delta_days": 0.0,
        })
    return rows


def _to_date(val):
    if val is None:
        return None
    if hasattr(val, "isoformat") and hasattr(val, "date"):
        return val.date()
    if hasattr(val, "isoformat"):
        return val
    return date.fromisoformat(str(val)[:10])


def _fake_query_snapshots_for_sweep(**kwargs):
    """Honour the [sweep_from, sweep_to] DATE RANGE on retrieved_at (None =>
    unbounded), and the anchor range — exactly like the real SQL."""
    sweep_from = _to_date(kwargs.get("sweep_from"))
    sweep_to = _to_date(kwargs.get("sweep_to"))
    anchor_from = _to_date(kwargs.get("anchor_from"))
    anchor_to = _to_date(kwargs.get("anchor_to"))
    out = []
    for row in _master_rows():
        ad = _to_date(row["anchor_day"])
        if anchor_from is not None and ad < anchor_from:
            continue
        if anchor_to is not None and ad > anchor_to:
            continue
        rday = _to_date(row["retrieved_at"])
        if sweep_from is not None and rday < sweep_from:
            continue
        if sweep_to is not None and rday > sweep_to:
            continue
        out.append(dict(row))
    return out


def _simple_graph():
    return {
        "nodes": [
            {"uuid": "simple-a", "id": "simple-a", "entry": {"is_start": True}},
            {"uuid": "simple-b", "id": "simple-b"},
        ],
        "edges": [{
            "uuid": "e1", "id": "e1", "edge_id": "e1",
            "from": "simple-a", "to": "simple-b",
            "p": {
                "id": "pytest-admit-param",
                "forecast": {"mean": 0.5},
                "latency": {
                    "latency_parameter": True,
                    "mu": 1.8, "sigma": 0.3, "onset_delta_days": 0.0,
                    "t95": 12.0, "promoted_t95": 12.0,
                    "mu_sd": 0.0, "sigma_sd": 0.0, "onset_sd": 0.0,
                    "onset_mu_corr": 0.0,
                },
                "model_vars": [{
                    "source": "analytic",
                    "probability": {
                        "mean": 0.5, "alpha": 50.0, "beta": 50.0,
                        "alpha_pred": 50.0, "beta_pred": 50.0,
                    },
                    "latency": {
                        "mu": 1.8, "sigma": 0.3, "onset_delta_days": 0.0,
                        "t95": 12.0, "mu_sd": 0.0, "sigma_sd": 0.0,
                        "onset_sd": 0.0, "onset_mu_corr": 0.0,
                    },
                }],
            },
        }],
    }


def _scenario(graph):
    return {
        "scenario_id": "base",
        "effective_query_dsl": TEMPORAL_DSL,
        "graph": graph,
    }


def _cohort_maturity_oracle(graph, scenario):
    """The current cohort-maturity resolve→prepare sequence, inline.

    Replicates api_handlers._handle_cohort_maturity_v3 lines 1511-1544. This is
    the oracle the helper must reproduce.
    """
    from runner.forecast_preparation import (
        extract_forecast_context_scope,
        prepare_forecast_subject_group,
        resolve_forecast_subjects,
    )
    from runner.forecast_runtime import parse_asat_from_dsl

    subjects = resolve_forecast_subjects(
        graph_data=graph,
        scenario=scenario,
        top_analytics_dsl=SUBJECT_DSL,
        path_analysis_type='cohort_maturity',
        whole_graph_analysis_type=None,
        log_prefix='[v3]',
    )
    temporal_dsl = scenario.get('effective_query_dsl', '')
    is_window = 'window(' in temporal_dsl
    context_scope = extract_forecast_context_scope(temporal_dsl, mece_dimensions=[])
    as_at = parse_asat_from_dsl(temporal_dsl)
    return prepare_forecast_subject_group(
        graph_data=graph,
        subjects=subjects,
        is_window=is_window,
        log_prefix='[v3]',
        as_at=as_at,
        scenario_id='base',
        context_scope=context_scope,
    )


def test_helper_matches_cohort_maturity_preparation_for_known_query():
    from runner.forecast_admission import (
        admit_forecast_evidence,
        admission_fingerprint,
        admitted_rows_for_target,
    )

    graph = _simple_graph()
    scenario = _scenario(graph)

    with patch("snapshot_service.query_snapshots_for_sweep",
               side_effect=_fake_query_snapshots_for_sweep):
        oracle = _cohort_maturity_oracle(graph, scenario)
        helper = admit_forecast_evidence(
            graph_data=graph,
            scenario=scenario,
            top_analytics_dsl=SUBJECT_DSL,
            query_dsl=f"{SUBJECT_DSL}.{TEMPORAL_DSL}",
            mece_dimensions=[],
        )

    assert helper is not None

    # Same ForecastPreparation: identical admission fingerprint and rows.
    assert admission_fingerprint(helper) == admission_fingerprint(oracle)
    assert admitted_rows_for_target(helper) == admitted_rows_for_target(oracle)
    assert helper.last_edge_id == oracle.last_edge_id == "e1"
    assert helper.anchor_from == oracle.anchor_from
    assert helper.anchor_to == oracle.anchor_to
    assert helper.sweep_to == oracle.sweep_to
    assert helper.total_rows == oracle.total_rows


def test_helper_admission_frontier_is_asat_bounded():
    """The helper's default (cohort-maturity) read semantics cap the sweep at
    asat: the post-asat observation (25-Jan) is NOT admitted; the frontier is
    the asat day. This is the asat-bounded admission daily adopts in Stage 2."""
    from runner.forecast_admission import (
        admit_forecast_evidence,
        admission_fingerprint,
        admitted_rows_for_target,
    )

    graph = _simple_graph()
    scenario = _scenario(graph)

    with patch("snapshot_service.query_snapshots_for_sweep",
               side_effect=_fake_query_snapshots_for_sweep):
        helper = admit_forecast_evidence(
            graph_data=graph,
            scenario=scenario,
            top_analytics_dsl=SUBJECT_DSL,
            mece_dimensions=[],
        )

    rows = admitted_rows_for_target(helper)
    retrieved = sorted({_to_date(r["retrieved_at"]) for r in rows})
    assert date.fromisoformat("2026-01-25") not in retrieved
    assert retrieved[-1] == date.fromisoformat(ASAT_DAY)

    fp = admission_fingerprint(helper)
    target_fp = next(e for e in fp["per_edge"] if e["target_id"] == "e1")
    assert target_fp["frontier_date"] == ASAT_DAY
    assert fp["sweep_to"] == ASAT_DAY


def test_accessors_select_target_and_fingerprint_is_deterministic_and_serialisable():
    from runner.forecast_admission import (
        admit_forecast_evidence,
        admission_fingerprint,
        admitted_rows_for_target,
        target_per_edge_result,
    )

    graph = _simple_graph()
    scenario = _scenario(graph)

    with patch("snapshot_service.query_snapshots_for_sweep",
               side_effect=_fake_query_snapshots_for_sweep):
        helper = admit_forecast_evidence(
            graph_data=graph,
            scenario=scenario,
            top_analytics_dsl=SUBJECT_DSL,
            mece_dimensions=[],
        )

    target = target_per_edge_result(helper)
    assert (target.get("subject") or {}).get("target", {}).get("targetId") == "e1"
    assert target["evidence_superset_rows"] == admitted_rows_for_target(helper)

    fp1 = admission_fingerprint(helper)
    fp2 = admission_fingerprint(helper)
    assert fp1 == fp2  # deterministic
    json.dumps(fp1)    # JSON-serialisable (used as a diagnostic surface)


def test_helper_returns_none_when_no_subjects_resolve():
    """Absence is surfaced explicitly (perimeter discipline), not as a zero or
    an empty preparation."""
    from runner.forecast_admission import admit_forecast_evidence

    empty_graph = {"nodes": [], "edges": []}
    scenario = {
        "scenario_id": "base",
        "effective_query_dsl": TEMPORAL_DSL,
        "graph": empty_graph,
    }
    with patch("snapshot_service.query_snapshots_for_sweep",
               side_effect=_fake_query_snapshots_for_sweep):
        result = admit_forecast_evidence(
            graph_data=empty_graph,
            scenario=scenario,
            top_analytics_dsl="from(nope-a).to(nope-b)",
            mece_dimensions=[],
        )
    assert result is None
