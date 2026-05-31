"""Daily-conversions admission uses the shared CF bundle path.

The canonical daily-conversions handler must admit evidence through the same
forecast preparation path as cohort_maturity, build one CFProjectionBundle, and
reduce that bundle directly. It must not run a second query_snapshots admission
or feed derive_daily_conversions into the date reducer.
"""

import os
import sys
from datetime import date, datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import patch  # noqa: E402


# The known defect query from the completeness handover.
SUBJECT_DSL = "from(simple-a).to(simple-b)"
TEMPORAL_DSL = "window(10-Jan-26:10-Jan-26).asat(20-Jan-26)"
ANCHOR_DAY = "2026-01-10"
ANCHOR_DAY_UK = "10-Jan-26"
ASAT_DAY = "2026-01-20"
SLICE_KEY = "window(10-Jan-26:10-Jan-26)"

# One Cohort (anchor 10-Jan-26) measured three times. x is fixed (window
# mode); y grows as the Cohort matures. The middle observation lands on the
# asat frontier; the last observation is AFTER it.
_RETRIEVED = {
    "2026-01-15": 30,
    "2026-01-20": 40,   # == asat
    "2026-01-25": 50,   # post-asat: only the unbounded sweep path admits this
}


def _master_rows():
    rows = []
    for rday, y in _RETRIEVED.items():
        rows.append({
            "param_id": "pytest-daily-param",
            "core_hash": "daily-fork-hash",
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
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    return date.fromisoformat(str(val)[:10])


def _anchor_keep(row, anchor_from, anchor_to):
    ad = _to_date(row["anchor_day"])
    if anchor_from is not None and ad < _to_date(anchor_from):
        return False
    if anchor_to is not None and ad > _to_date(anchor_to):
        return False
    return True


def _fake_query_snapshots_for_sweep(**kwargs):
    """Mirror snapshot_service.query_snapshots_for_sweep: retrieved_at bounded
    by the [sweep_from, sweep_to] DATE RANGE (None => unbounded)."""
    sweep_from = _to_date(kwargs.get("sweep_from"))
    sweep_to = _to_date(kwargs.get("sweep_to"))
    out = []
    for row in _master_rows():
        if not _anchor_keep(row, kwargs.get("anchor_from"), kwargs.get("anchor_to")):
            continue
        rday = _to_date(row["retrieved_at"])
        if sweep_from is not None and rday < sweep_from:
            continue
        if sweep_to is not None and rday > sweep_to:
            continue
        out.append(dict(row))
    return out


def _fake_query_snapshots(**kwargs):
    """Mirror snapshot_service.query_snapshots: retrieved_at capped by the
    single `as_at` ceiling (date-level)."""
    as_at = _to_date(kwargs.get("as_at"))
    out = []
    for row in _master_rows():
        if not _anchor_keep(row, kwargs.get("anchor_from"), kwargs.get("anchor_to")):
            continue
        if as_at is not None and _to_date(row["retrieved_at"]) > as_at:
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
                "id": "pytest-daily-param",
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


def _resolve_daily_subjects():
    from runner.forecast_preparation import resolve_forecast_subjects
    graph = _simple_graph()
    scenario = {
        "scenario_id": "base",
        "effective_query_dsl": TEMPORAL_DSL,
        "graph": graph,
    }
    # Fork 1, named: the daily path resolves subjects with
    # path_analysis_type='daily_conversions'.
    subjects = resolve_forecast_subjects(
        graph_data=graph,
        scenario=scenario,
        top_analytics_dsl=SUBJECT_DSL,
        path_analysis_type='daily_conversions',
        whole_graph_analysis_type=None,
        log_prefix='[daily-fork-test]',
    )
    return graph, subjects


def _shared_admitted_rows(graph, subjects):
    """Fork 1 output: the evidence superset the CF projection bundle is
    built from."""
    from runner.forecast_preparation import (
        extract_forecast_context_scope,
        prepare_forecast_subject_group,
    )
    from runner.forecast_runtime import parse_asat_from_dsl

    context_scope = extract_forecast_context_scope(TEMPORAL_DSL, mece_dimensions=[])
    as_at = parse_asat_from_dsl(TEMPORAL_DSL)
    preparation = prepare_forecast_subject_group(
        graph_data=graph,
        subjects=subjects,
        is_window=True,
        log_prefix='[daily-fork-test]',
        as_at=as_at,
        scenario_id='base',
        context_scope=context_scope,
    )
    target = next(
        (per_edge for per_edge in preparation.per_edge_results
         if (per_edge.get("subject") or {}).get("target", {}).get("targetId")
         == preparation.last_edge_id),
        preparation.per_edge_results[-1],
    )
    return target["evidence_superset_rows"]


def _direct_observed_rows(subjects):
    """Fork 2 output: daily's separate observed-row admission path, mirroring
    _handle_daily_conversions lines ~1976-1986."""
    import snapshot_service
    from api_handlers import _apply_temporal_regime_selection
    from runner.forecast_runtime import parse_asat_from_dsl

    target_subj = subjects[-1]
    as_at = parse_asat_from_dsl(TEMPORAL_DSL)
    ss_as_at = datetime.fromisoformat(as_at) if as_at else None
    # Fork 2, named: the direct query_snapshots(...) observed path.
    rows = snapshot_service.query_snapshots(
        param_id=target_subj['param_id'],
        core_hash=target_subj['core_hash'],
        slice_keys=target_subj.get('slice_keys', ['']),
        anchor_from=date.fromisoformat(target_subj['anchor_from']),
        anchor_to=date.fromisoformat(target_subj['anchor_to']),
        as_at=ss_as_at,
        equivalent_hashes=target_subj.get('equivalent_hashes'),
    )
    return _apply_temporal_regime_selection(rows, target_subj, True)


def _latest_retrieved_date(rows):
    return max(_to_date(r["retrieved_at"]) for r in rows)


def _frontier_strict_xy(rows):
    """Strict (sum y, sum x) for the selected Cohort at its latest frontier."""
    frontier = _latest_retrieved_date(rows)
    at_frontier = [r for r in rows if _to_date(r["retrieved_at"]) == frontier]
    return (sum(r["y"] for r in at_frontier), sum(r["x"] for r in at_frontier))


def test_daily_handler_reads_shared_asat_bounded_admission_after_cutover():
    """Handler-level proof of bundle-only daily-conversions admission.

    After the repoint, ``_handle_daily_conversions`` admits evidence through
    the shared cohort-maturity binder only and reduces the resulting
    CFProjectionBundle directly. The selected Cohort's strict evidence
    frontier is the asat day (20-Jan, y=40), NOT the post-asat 25-Jan
    (y=50) the old unbounded ``raw_snapshots`` fetch would have admitted.
    The handler no longer issues its own direct ``query_snapshots`` fetch.

    `analytics_dsl` is set so subject resolution actually runs (and stamps the
    cohort-maturity sweep bounds); the sweep query is mocked to honour those
    bounds, exactly as the real SQL does.
    """
    from unittest.mock import MagicMock

    from api_handlers import handle_runner_analyze

    graph = _simple_graph()
    request = {
        "analysis_type": "daily_conversions",
        "analytics_dsl": SUBJECT_DSL,
        "query_dsl": f"{SUBJECT_DSL}.{TEMPORAL_DSL}",
        "display_settings": {"tau_extent": "12"},
        "scenarios": [{
            "scenario_id": "base",
            "name": "Base",
            "visibility_mode": "f+e",
            "effective_query_dsl": TEMPORAL_DSL,
            "graph": graph,
        }],
    }

    direct_query = MagicMock(side_effect=_fake_query_snapshots)
    with (
        patch("snapshot_service.query_snapshots_for_sweep",
              side_effect=_fake_query_snapshots_for_sweep),
        patch("snapshot_service.query_snapshots", direct_query),
    ):
        resp = handle_runner_analyze(request)

    assert resp["success"] is True
    rows = resp["result"]["rate_by_cohort"]
    assert len(rows) == 1
    cohort = rows[0]
    assert cohort["date"] == ANCHOR_DAY_UK
    assert resp["result"]["date_range"] == {
        "from": ANCHOR_DAY_UK,
        "to": ANCHOR_DAY_UK,
    }
    # Strict evidence reflects the asat-bounded shared admission
    # (frontier 20-Jan): y=40, NOT unbounded raw_snapshots y=50.
    assert cohort["x"] == pytest.approx(100)
    assert cohort["y"] == pytest.approx(40)
    # rows_analysed reflects the asat-bounded admitted set (15-Jan + 20-Jan).
    assert resp["rows_analysed"] == 2
    # Daily no longer performs its own direct query_snapshots admission.
    direct_query.assert_not_called()
