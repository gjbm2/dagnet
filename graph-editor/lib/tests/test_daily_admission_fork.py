"""Stage 0 pin: the daily-conversions pre-reducer admission fork.

Single-evidence-admission-binding plan (29-May-26), Stage 0 — "Pin The Daily
Fork In Tests". Purpose: prove the daily-conversions failure starts *before*
reducer logic, in evidence admission.

`_handle_daily_conversions` currently admits evidence through TWO different
pre-reducer paths for the same query:

  Fork 1 (feeds the CF projection bundle):
      resolve_forecast_subjects(path_analysis_type='daily_conversions')
        -> prepare_forecast_subject_group(...)
        -> per_edge_result["evidence_superset_rows"]
    The 'daily_conversions' read mode is 'raw_snapshots'
    (ANALYSIS_TYPE_READ_MODES), so synthesise_snapshot_subjects leaves
    `sweep_to` UNSET. query_snapshots_for_sweep then bounds retrieved_at by
    [sweep_from, sweep_to] = [None, None] -> UNBOUNDED above. The superset
    therefore admits observations *after* the asat frontier.

  Fork 2 (feeds the observed daily series):
      query_snapshots(as_at=<asat>) -> _apply_temporal_regime_selection(...)
        -> derive_daily_conversions(...)
    This path caps retrieved_at <= asat.

So the bundle is built from a later evidence frontier than the observed
series the user sees. That is the upstream cause of the public symptom
recorded in docs/current/handover/29-May-26-daily-conversions-completeness.md
(daily-conversions row completeness ~0.4640 vs scalar completeness ~0.4974
for `from(simple-a).to(simple-b).window(10-Jan-26:10-Jan-26).asat(20-Jan-26)`).

The cutover (Stage 2) deletes Fork 2 and feeds the observed series from the
SAME shared admitted rows the bundle uses: daily needs nothing special. This
test pins the current divergence and asserts the intended shared input.

Snapshot DB access is mocked. The two mocks honour their bound arguments
(sweep date-range vs asat ceiling) exactly as the real SQL does, so the
divergence emerges from the read-mode-driven subject stamping — not by fiat.
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


def test_daily_pre_reducer_admission_fork_diverges_on_asat_frontier():
    from analysis_subject_resolution import ANALYSIS_TYPE_READ_MODES
    from runner.daily_conversions_derivation import derive_daily_conversions

    # The read-mode fork that causes the divergence (names Fork 1's mechanism).
    assert ANALYSIS_TYPE_READ_MODES['daily_conversions'] == 'raw_snapshots'

    with (
        patch("snapshot_service.query_snapshots_for_sweep",
              side_effect=_fake_query_snapshots_for_sweep),
        patch("snapshot_service.query_snapshots",
              side_effect=_fake_query_snapshots),
    ):
        graph, subjects = _resolve_daily_subjects()
        assert subjects, "daily subject resolution produced no subjects"

        # The daily 'raw_snapshots' subject carries no asat-capped sweep_to:
        # its admission is unbounded above. This is the root of the fork.
        daily_subj = subjects[-1]
        assert not daily_subj.get('sweep_to'), (
            "daily subject unexpectedly carries a sweep_to bound; the "
            "raw_snapshots read-mode fork this test pins may have changed"
        )

        shared_rows = _shared_admitted_rows(graph, subjects)
        direct_rows = _direct_observed_rows(subjects)

    # Non-vacuousness (AP17): real evidence on both sides.
    assert shared_rows and direct_rows
    assert all(r["x"] > 0 for r in shared_rows)

    # --- Defect signature 1: latest admitted retrieved_at differs. ---
    shared_frontier = _latest_retrieved_date(shared_rows)
    direct_frontier = _latest_retrieved_date(direct_rows)
    assert shared_frontier == date.fromisoformat("2026-01-25")
    assert direct_frontier == date.fromisoformat(ASAT_DAY)
    assert shared_frontier != direct_frontier, (
        "expected the bundle's evidence frontier to diverge from the "
        "observed series' frontier today"
    )

    # The shared (bundle) admission admits a POST-asat observation that the
    # observed series never sees — the precise pre-reducer defect.
    assert shared_frontier > date.fromisoformat(ASAT_DAY)
    assert all(_to_date(r["retrieved_at"]) <= date.fromisoformat(ASAT_DAY)
               for r in direct_rows)

    # --- Defect signature 2: selected evidence frontier set differs. ---
    shared_dates = {_to_date(r["retrieved_at"]) for r in shared_rows}
    direct_dates = {_to_date(r["retrieved_at"]) for r in direct_rows}
    assert shared_dates != direct_dates
    assert direct_dates < shared_dates  # observed is a strict subset

    # --- Defect signature 3: strict sum(y)/sum(x) at the frontier differs. ---
    shared_y, shared_x = _frontier_strict_xy(shared_rows)
    direct_y, direct_x = _frontier_strict_xy(direct_rows)
    assert (shared_y, shared_x) == (50, 100)
    assert (direct_y, direct_x) == (40, 100)
    assert shared_y / shared_x != direct_y / direct_x, (
        "strict Cohort rate at the selected frontier must differ between the "
        "bundle admission and the observed admission today"
    )

    # --- Defect signature 4: the observed daily series the user sees is
    # built on the divergent (asat-capped) admission, so it disagrees with
    # what the shared admission would produce. This is the upstream cause of
    # the handover's row-vs-scalar completeness mismatch. ---
    observed_current = derive_daily_conversions(direct_rows)
    observed_intended = derive_daily_conversions(shared_rows)

    cur_cohort = observed_current["rate_by_cohort"][0]
    int_cohort = observed_intended["rate_by_cohort"][0]
    assert cur_cohort["date"] == int_cohort["date"] == ANCHOR_DAY_UK
    assert (cur_cohort["x"], cur_cohort["y"]) == (100, 40)
    assert (int_cohort["x"], int_cohort["y"]) == (100, 50)
    assert cur_cohort["rate"] != int_cohort["rate"]
    assert observed_current["total_conversions"] != observed_intended["total_conversions"]


def test_derive_daily_conversions_over_shared_rows_is_the_intended_observed_input():
    """Second Stage 0 assertion: after the cutover, daily needs nothing
    special — its observed series is `derive_daily_conversions` over the SAME
    shared admitted rows the bundle is built from. Pin that this wiring yields
    a coherent observed structure (the Stage 2 target)."""
    from runner.daily_conversions_derivation import derive_daily_conversions

    with (
        patch("snapshot_service.query_snapshots_for_sweep",
              side_effect=_fake_query_snapshots_for_sweep),
        patch("snapshot_service.query_snapshots",
              side_effect=_fake_query_snapshots),
    ):
        graph, subjects = _resolve_daily_subjects()
        shared_rows = _shared_admitted_rows(graph, subjects)

    observed = derive_daily_conversions(shared_rows)

    assert observed["analysis_type"] == "daily_conversions"
    assert len(observed["rate_by_cohort"]) == 1
    cohort = observed["rate_by_cohort"][0]
    assert cohort["date"] == ANCHOR_DAY_UK
    assert cohort["x"] == 100 and cohort["y"] == 50
    assert cohort["rate"] == 0.5
    # Calendar series and totals reflect the full shared admission frontier;
    # date_range is the selected Cohort scope, not the retrieval frontier.
    assert observed["total_conversions"] == 50
    assert observed["date_range"] == {"from": ANCHOR_DAY_UK, "to": ANCHOR_DAY_UK}
    assert observed["cohort_y_at_age"].get(ANCHOR_DAY_UK)


def test_daily_handler_reads_shared_asat_bounded_admission_after_cutover():
    """Stage 2 cutover proof (handler level).

    After the repoint, ``_handle_daily_conversions`` admits evidence through
    the shared cohort-maturity binder only. Its observed series therefore comes
    from the asat-bounded admission — the selected Cohort's frontier is the
    asat day (20-Jan, y=40), NOT the post-asat 25-Jan (y=50) the old unbounded
    ``raw_snapshots`` fetch would have admitted. And the handler no longer
    issues its own direct ``query_snapshots`` fetch.

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
    # Observed reflects the asat-bounded shared admission (frontier 20-Jan):
    # y=40, NOT the unbounded raw_snapshots y=50.
    assert cohort["x"] == pytest.approx(100)
    assert cohort["y"] == pytest.approx(40)
    # rows_analysed reflects the asat-bounded admitted set (15-Jan + 20-Jan).
    assert resp["rows_analysed"] == 2
    # Daily no longer performs its own direct query_snapshots admission.
    direct_query.assert_not_called()
