"""Shared CF analysis boundary: one request → one ``CFProjectionBundle``.

This is the standardised seam every forecast-backed analysis routes
through. ``cohort_maturity``, ``conditioned_forecast`` (whole-graph), and
``daily_conversions`` are all clients: each resolves its subject group,
calls :func:`prepare_cf_projection_bundle` to get the one bundle, then
applies its own reducer (tau reducer / date reducer). No analysis owns the
preparation chain; the chain lives here once.

The boundary is a perimeter orchestrator — it sequences the existing
preparation functions (``prepare_forecast_runtime_inputs``, the superset
candidate builders) and ``build_cf_projection_bundle``. It adds no
mathematics, no conditioning, and no mode fork: ``window`` / ``cohort`` /
single- / multi-hop / identity-carrier all flow through unchanged, exactly
as they do inside the bundle builder (COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_
SEMANTICS §1; FORECAST_RUNTIME_ARCHITECTURE §10).

The whole-graph donor cache that distinguishes ``conditioned_forecast``
from the single-group callers is carried as data, not a branch: the caller
owns the ``per_edge_results_by_uuid`` map (a fresh dict for a single group,
the running cross-edge cache for whole-graph), and
``upstream_per_edge_results`` is just its values.
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence


def reducer_for(analysis_type: str):
    """Resolve the bundle reducer the analysis-types registry names for
    this analysis type.

    ``analysis_types.yaml``'s ``reducer:`` field is the single source of
    truth for which reducer a forecast-backed analysis applies to the
    shared bundle; this binds the declared name to the reducer function.
    Both reducers are bundle readouts (cohort_forecast_v3). An unknown or
    unbound reducer name raises — it is a registry/wiring bug, not a
    runtime fallback.
    """
    from runner.adaptor import get_adaptor
    from runner.cohort_forecast_v3 import (
        reduce_cohort_maturity_rows,
        reduce_daily_conversions_rows,
    )

    by_name = {
        'cohort_maturity': reduce_cohort_maturity_rows,
        'daily_conversions': reduce_daily_conversions_rows,
    }
    return by_name[get_adaptor().get(analysis_type).reducer]


@dataclass(frozen=True)
class CFAnalysisPrepared:
    """The shared bundle plus the preparation artefacts handlers frame
    their response from. The reducers read only ``bundle``; the other
    fields are response-shaping inputs (frames for the model-curve tail,
    the resolved model, edge identity, cohort counts, diagnostics)."""

    bundle: Any                       # CFProjectionBundle
    composed_frames: List[Dict[str, Any]]
    resolved_override: Any            # resolved model when reused, else None
    last_edge_id: Optional[str]
    query_from_node: Optional[str]
    query_to_node: Optional[str]
    anchor_from: str
    anchor_to: str
    sweep_to: str
    total_rows: int
    cohorts_analysed: int
    is_multi_hop: bool
    compute_extent: int               # engine boundary input picked by handler
    runtime_bundle_diag: Any          # for --diag provenance only


def prepare_cf_projection_bundle(
    preparation: Any,
    *,
    graph_data: Dict[str, Any],
    subjects: Sequence[Dict[str, Any]],
    is_window: bool,
    context_scope: Any,
    scenario_id: str,
    as_at: Optional[str],
    candidate_regimes_by_edge: Dict[str, Any],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    compute_extent: int,
    include_epistemic_overlay: bool,
    use_prepared_resolved: bool,
    show_model_curve: bool,
    log_prefix: str,
) -> CFAnalysisPrepared:
    """Run preparation → projection for one resolved subject group.

    ``preparation`` is the already-run ``prepare_forecast_subject_group``
    result; the caller guarantees it resolved an edge
    (``preparation.last_edge_id`` is set) before calling. The caller owns
    ``per_edge_results_by_uuid``: pass a fresh ``{}`` for a single group,
    or the running cross-edge donor cache for whole-graph. This function
    seeds it from this group's per-edge results and threads it through the
    runtime inputs, the upstream fetcher's write-back, and the candidate
    builders.

    ``compute_extent`` is the engine boundary input chosen by the analysis
    handler per ``docs/current/cohort-maturity-render-calc-policy.md``.
    This boundary is a perimeter orchestrator: span/calc scoping policy
    (Manual vs Auto, visibility-mode mapping, multi-scenario reduction,
    pad-out) lives in the handler. The bundle composes the runtime to
    ``compute_extent``, derives ``saturation_τ`` as a latent t95 of the
    composed predictive CDF, and projects per-Cohort at
    ``min(compute_extent, saturation_τ)`` — no policy blending inside the
    engine.

    ``use_prepared_resolved`` reuses the model resolved by
    ``prepare_forecast_runtime_inputs`` (cohort_maturity needs the same
    resolution that drives its epistemic model-curve overlay); when False
    the bundle resolves the model itself.
    """
    from runner.forecast_preparation import _make_envelope_aware_upstream_fetcher
    from runner.forecast_runtime import prepare_forecast_runtime_inputs
    from runner.cohort_forecast_v3 import (
        build_carrier_superset_candidates_by_edge,
        build_cf_projection_bundle,
        build_superset_candidates_by_edge,
    )

    # Seed the caller-owned donor map with this group's per-edge results.
    for entry in preparation.per_edge_results:
        tid = (entry.get('subject') or {}).get('target', {}).get('targetId', '')
        if tid:
            per_edge_results_by_uuid[str(tid)] = entry

    first = subjects[0]
    prepared_runtime = prepare_forecast_runtime_inputs(
        graph_data=graph_data,
        query_from_node=preparation.query_from_node,
        query_to_node=preparation.query_to_node,
        anchor_node_id=preparation.anchor_node,
        last_edge_id=preparation.last_edge_id,
        is_window=is_window,
        is_multi_hop=preparation.is_multi_hop,
        composed_frames=preparation.composed_frames,
        path_per_edge_results=preparation.per_edge_results,
        upstream_per_edge_results=list(per_edge_results_by_uuid.values()),
        axis_tau_max=compute_extent,
        upstream_anchor_from=first.get('anchor_from', ''),
        upstream_anchor_to=first.get('anchor_to', ''),
        upstream_sweep_from=first.get('sweep_from', first.get('anchor_from', '')),
        upstream_sweep_to=first.get('sweep_to', first.get('anchor_to', '')),
        candidate_regimes_by_edge=candidate_regimes_by_edge,
        upstream_observation_fetcher=_make_envelope_aware_upstream_fetcher(
            preparation.envelope_plan,
            per_edge_results_out=per_edge_results_by_uuid,
        ),
        upstream_log_prefix=f'{log_prefix} upstream:',
        p_conditioning_source='snapshot_frames',
        p_conditioning_evidence_points=len(preparation.composed_frames),
        include_epistemic_overlay=include_epistemic_overlay,
        as_at=as_at,
        scenario_id=scenario_id,
    )
    resolved_override = (
        prepared_runtime.resolved_override if use_prepared_resolved else None
    )

    carrier_candidates = build_carrier_superset_candidates_by_edge(
        graph=graph_data,
        anchor_node_id=preparation.anchor_node,
        query_from_node=preparation.query_from_node,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        anchor_from=preparation.anchor_from,
        sweep_to=preparation.sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
        context_key=context_scope.context_key,
        context_selector=context_scope.context_selector,
        mece_dimensions=context_scope.mece_dimensions,
    )
    subject_candidates = build_superset_candidates_by_edge(
        graph=graph_data,
        from_node=preparation.query_from_node,
        to_node=preparation.query_to_node,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        anchor_from=preparation.anchor_from,
        sweep_to=preparation.sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
        context_key=context_scope.context_key,
        context_selector=context_scope.context_selector,
        mece_dimensions=context_scope.mece_dimensions,
    )

    bundle = build_cf_projection_bundle(
        frames=preparation.composed_frames,
        graph=graph_data,
        target_edge_id=preparation.last_edge_id,
        query_from_node=preparation.query_from_node or '',
        query_to_node=preparation.query_to_node or '',
        anchor_from=preparation.anchor_from,
        anchor_to=preparation.anchor_to,
        sweep_to=preparation.sweep_to,
        is_window=is_window,
        compute_extent=compute_extent,
        anchor_node_id=preparation.anchor_node,
        is_multi_hop=preparation.is_multi_hop,
        resolved_override=resolved_override,
        scenario_id=scenario_id,
        as_at=as_at,
        per_edge_upstream_candidates=carrier_candidates,
        per_edge_subject_candidates=subject_candidates,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        show_model_curve=show_model_curve,
        envelope_plan=preparation.envelope_plan,
        context_key=context_scope.context_key,
        context_selector=context_scope.context_selector,
        mece_dimensions=context_scope.mece_dimensions,
    )

    return CFAnalysisPrepared(
        bundle=bundle,
        composed_frames=preparation.composed_frames,
        resolved_override=resolved_override,
        last_edge_id=preparation.last_edge_id,
        query_from_node=preparation.query_from_node,
        query_to_node=preparation.query_to_node,
        anchor_from=preparation.anchor_from,
        anchor_to=preparation.anchor_to,
        sweep_to=preparation.sweep_to,
        total_rows=preparation.total_rows,
        cohorts_analysed=preparation.cohorts_analysed,
        is_multi_hop=preparation.is_multi_hop,
        compute_extent=compute_extent,
        runtime_bundle_diag=prepared_runtime.runtime_bundle,
    )
