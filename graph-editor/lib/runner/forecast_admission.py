"""Forecast evidence admission — the shared cohort-maturity evidence binder.

Single-evidence-admission-binding plan (29-May-26), Stage 1.

This module is the *named extraction surface* for the forecast-backed evidence
admission that cohort maturity already performs inline in
``_handle_cohort_maturity_v3`` (``api_handlers.py``). It exists so that
daily conversions — and, later, surprise gauge and conditioned forecast — can
become thin clients of one admission path instead of each baking
``path_analysis_type`` magic strings and bespoke fetch/regime forks before the
shared ``CFProjectionBundle``.

``admit_forecast_evidence`` reproduces, verbatim, the resolve→prepare sequence
the cohort-maturity handler runs (``api_handlers.py:1511-1544``):

    resolve_forecast_subjects(... path_analysis_type='cohort_maturity' ...)
      -> derive temporal_dsl / is_window / context_scope / asat
      -> prepare_forecast_subject_group(...)

It returns the existing ``ForecastPreparation``. The cohort-maturity read
semantics are deliberate: that read mode caps the sweep at ``asat`` (see
``analysis_subject_resolution.synthesise_snapshot_subjects``), so the admitted
evidence frontier is ``asat``-bounded — the property daily conversions must
adopt (Stage 2) in place of its unbounded ``raw_snapshots`` admission.

This module is a *perimeter* wrapper (CF engine discipline / INVARIANTS I-47):
it resolves and prepares typed inputs and surfaces absence explicitly (no
subjects → ``None``). It contains no engine math and no defensive fallbacks.

Accessors operate on the returned ``ForecastPreparation``:

- ``target_per_edge_result(preparation)`` — the per-edge result for the
  query's target (last) edge.
- ``admitted_rows_for_target(preparation)`` — that edge's post-regime
  evidence-superset rows (the observed-evidence input daily reduces).
- ``admission_fingerprint(preparation)`` — a deterministic, comparable
  signature of what was admitted, for cross-handler parity checks (Stage 3).
"""

from typing import Any, Dict, List, Optional

from runner.forecast_preparation import ForecastPreparation


def admit_forecast_evidence(
    *,
    graph_data: Dict[str, Any],
    scenario: Dict[str, Any],
    top_analytics_dsl: str,
    query_dsl: str = '',
    mece_dimensions: Optional[List[Dict[str, Any]]] = None,
    path_analysis_type: str = 'cohort_maturity',
    log_prefix: str = '[forecast_admission]',
) -> Optional[ForecastPreparation]:
    """Admit forecast evidence using the shared cohort-maturity read semantics.

    Returns the ``ForecastPreparation`` for the scenario, or ``None`` when
    subject resolution yields no subjects (the caller owns the empty-scenario
    response, exactly as the handlers do today).
    """
    from runner.forecast_preparation import (
        extract_forecast_context_scope,
        prepare_forecast_subject_group,
        resolve_forecast_subjects,
    )
    from runner.forecast_runtime import parse_asat_from_dsl

    subjects = resolve_forecast_subjects(
        graph_data=graph_data,
        scenario=scenario,
        top_analytics_dsl=top_analytics_dsl,
        path_analysis_type=path_analysis_type,
        whole_graph_analysis_type=None,
        log_prefix=log_prefix,
    )
    if not subjects:
        return None

    temporal_dsl = scenario.get('effective_query_dsl', '')
    is_window = 'window(' in temporal_dsl or 'window(' in query_dsl
    context_scope = extract_forecast_context_scope(
        temporal_dsl,
        mece_dimensions=mece_dimensions or [],
    )
    as_at = parse_asat_from_dsl(temporal_dsl)

    return prepare_forecast_subject_group(
        graph_data=graph_data,
        subjects=subjects,
        is_window=is_window,
        log_prefix=log_prefix,
        as_at=as_at,
        scenario_id=scenario.get('scenario_id', 'unknown'),
        context_scope=context_scope,
    )


def target_per_edge_result(preparation: ForecastPreparation) -> Dict[str, Any]:
    """The per-edge result for the query's target (last) edge.

    Mirrors the target selection the daily/cohort handlers perform: match the
    per-edge result whose subject target is ``preparation.last_edge_id``;
    fall back to the last per-edge result (single-edge queries).
    """
    for per_edge in preparation.per_edge_results:
        subject = per_edge.get('subject') or {}
        target_id = (subject.get('target') or {}).get('targetId')
        if target_id == preparation.last_edge_id:
            return per_edge
    return preparation.per_edge_results[-1]


def admitted_rows_for_target(preparation: ForecastPreparation) -> List[Dict[str, Any]]:
    """The target edge's post-regime evidence-superset rows.

    This is the observed-evidence input daily conversions reduces with
    ``derive_daily_conversions`` after the Stage 2 cutover — the same rows the
    ``CFProjectionBundle`` is built from.
    """
    return target_per_edge_result(preparation)['evidence_superset_rows']


def admission_fingerprint(preparation: ForecastPreparation) -> Dict[str, Any]:
    """A deterministic, comparable signature of what was admitted.

    Stage 3 compares daily conversions' fingerprint to cohort maturity's for
    the known query: after the cutover they must be equal because both read the
    same shared admitted rows.
    """
    per_edge: List[Dict[str, Any]] = []
    for entry in preparation.per_edge_results:
        subject = entry.get('subject') or {}
        rows = entry['evidence_superset_rows']
        retrieved_at_dates = sorted({_retrieved_date(row) for row in rows})
        per_edge.append({
            'target_id': (subject.get('target') or {}).get('targetId'),
            'from_node': entry.get('from_node'),
            'to_node': entry.get('to_node'),
            'path_role': entry.get('path_role'),
            'row_count': len(rows),
            'retrieved_at_dates': retrieved_at_dates,
            'frontier_date': retrieved_at_dates[-1] if retrieved_at_dates else None,
        })

    return {
        'last_edge_id': preparation.last_edge_id,
        'query_from_node': preparation.query_from_node,
        'query_to_node': preparation.query_to_node,
        'anchor_from': preparation.anchor_from,
        'anchor_to': preparation.anchor_to,
        'sweep_to': preparation.sweep_to,
        'total_rows': preparation.total_rows,
        'per_edge': per_edge,
    }


def _retrieved_date(row: Dict[str, Any]) -> str:
    """ISO date (``YYYY-MM-DD``) of a snapshot row's ``retrieved_at``.

    Snapshot rows carry ``retrieved_at`` as an ISO datetime string or a
    datetime; the fingerprint compares at date granularity (the observation
    frontier is a date, per RESERVED_QUERY_TERMS_GLOSSARY ``asat``).
    """
    retrieved_at = row['retrieved_at']
    if hasattr(retrieved_at, 'isoformat'):
        return retrieved_at.date().isoformat() if hasattr(retrieved_at, 'date') else retrieved_at.isoformat()[:10]
    return str(retrieved_at)[:10]
