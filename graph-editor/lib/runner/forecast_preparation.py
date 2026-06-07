"""Shared preparation helpers for forecast chart and CF handlers.

Doc 60 WP1 requires the conditioned-forecast endpoint and the cohort
maturity v3 chart to resolve subjects, pick temporal evidence families,
query snapshots, and compose span evidence through one path. The live
factorised subject path is window-led: subject-frame construction uses
window evidence for the shared `X -> end` helper family, while any
cohort-specific rate evidence must enter through a separate seam.

`subject_is_window` in this module refers only to the frame-evidence
family used to fetch and compose observed rows. It must not be reused as
the subject-helper family for downstream forecast execution.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import date
import re
from typing import Any, Dict, List, Optional


@dataclass
class ForecastPreparation:
    query_from_node: str
    query_to_node: str
    anchor_node: Optional[str]
    last_edge_id: Optional[str]
    is_multi_hop: bool
    anchor_from: str
    anchor_to: str
    sweep_to: str
    total_rows: int
    cohorts_analysed: int
    per_edge_results: List[Dict[str, Any]]
    composed_frames: List[Dict[str, Any]]
    regime_diagnostics: List[Dict[str, Any]]
    # Per-request fetch envelope plan from
    # `runner.request_envelope.build_request_envelope_plan`. Threaded
    # forward to `_fetch_upstream_observations` and to the runtime
    # builder so carrier-side fetches and prebuilt arrival maps stay
    # consistent with the subject-side fetch.
    envelope_plan: Optional[Any] = None
    # The per-query calc horizon this preparation was sized to, picked by
    # `compute_request_extent` from the request's visibility mode / axis /
    # path t95 (render-calc policy doc). The internally-built envelope grid
    # is sized to `min(compute_extent, 400)`, and analysis handlers read
    # this value back as the engine boundary for the projection bundle —
    # so the grid and the projection share one horizon. `None` only for the
    # empty-subjects degenerate.
    compute_extent: Optional[int] = None


@dataclass(frozen=True)
class ForecastContextScope:
    context_key: Optional[str] = None
    context_selector: Optional[str] = None
    mece_dimensions: tuple[str, ...] = ()


def extract_forecast_context_scope(
    effective_query_dsl: str,
    *,
    mece_dimensions: Optional[List[str]] = None,
) -> ForecastContextScope:
    """Extract exact context scope from the scenario effective DSL.

    Graph-level pinned DSL decides candidate-regime discovery upstream; this
    function reads only the scenario's effective DSL because it defines the
    current request scope.
    """
    from query_dsl import parse_query

    if not effective_query_dsl:
        return ForecastContextScope(
            mece_dimensions=tuple(mece_dimensions or ()),
        )
    parsed = parse_query(effective_query_dsl or "")
    context_key = None
    context_selector = None
    if len(parsed.context) == 1 and not parsed.context_any:
        ctx = parsed.context[0]
        context_key = ctx.key
        context_selector = f"context({ctx.key}:{ctx.value})"
    return ForecastContextScope(
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=tuple(mece_dimensions or ()),
    )


def apply_temporal_regime_selection(
    rows: List[Dict[str, Any]],
    subj: Dict[str, Any],
    is_window: bool,
    requested_cohort_anchor: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Select one temporal evidence family per retrieval date.

    Window and cohort are separate evidence families (x-anchored vs
    a-anchored) with different core_hashes. Candidate regimes carry a
    temporal_mode tag, so we rank the requested mode first and then let
    snapshot_regime_selection pick a single regime per retrieved_at date.
    """
    from snapshot_regime_selection import CandidateRegime, select_regime_rows

    cr_raw = subj.get("candidate_regimes")
    if not cr_raw or not isinstance(cr_raw, list):
        print(
            f"[temporal_regime] NO candidate_regimes on subject (rows={len(rows)})"
        )
        return rows
    print(
        "[temporal_regime] "
        f"{len(cr_raw)} candidates, "
        f"modes={[r.get('temporal_mode', '?') for r in cr_raw if isinstance(r, dict)]}"
    )

    regimes = [
        CandidateRegime(
            core_hash=r.get("core_hash", ""),
            equivalent_hashes=[
                e.get("core_hash", "") if isinstance(e, dict) else str(e)
                for e in (r.get("equivalent_hashes") or [])
            ],
            temporal_mode=r.get("temporal_mode", ""),
            cohort_anchor=str(r.get("cohort_anchor") or ""),
        )
        for r in cr_raw
        if isinstance(r, dict) and r.get("core_hash")
    ]
    if not regimes:
        return rows

    preferred = "window" if is_window else "cohort"
    tagged = [
        (regime, cr_raw[i].get("temporal_mode", ""))
        for i, regime in enumerate(regimes)
        if i < len(cr_raw)
    ]
    preferred_regimes = []
    for regime, mode in tagged:
        if mode != preferred:
            continue
        if preferred == "cohort" and requested_cohort_anchor:
            # Explicit-anchor candidates must match the resolved semantic
            # anchor. Unanchored cohort candidates represent the app's
            # convention-derived anchor and remain admissible.
            anchor = str(getattr(regime, "cohort_anchor", "") or "")
            if anchor and anchor != str(requested_cohort_anchor):
                continue
        preferred_regimes.append(regime)
    other_regimes = [regime for regime, mode in tagged if mode != preferred]
    ordered = preferred_regimes + other_regimes

    selection = select_regime_rows(rows, ordered if ordered else regimes)
    if len(selection.rows) != len(rows):
        print(
            f"[temporal_regime] {len(rows)} -> {len(selection.rows)} rows "
            f"(mode={preferred}, {len(selection.regime_per_date)} dates)"
        )
    return selection.rows


def flatten_candidate_regime_hashes(
    candidate_regimes: List[Any],
) -> tuple[str, List[Dict[str, Any]]]:
    """Flatten FE candidate regimes into one queryable hash bundle.

    This mirrors `analysis_subject_resolution.synthesise_snapshot_subjects`:
    one primary hash plus equivalent hashes spanning every candidate
    regime family, so the DB query can return all rows and the temporal
    regime selector can choose the correct family afterwards.
    """
    all_hashes: List[str] = []
    primary_hash = ""

    for regime in candidate_regimes or []:
        if isinstance(regime, str):
            hashes = [regime]
        elif isinstance(regime, dict):
            hashes = [regime.get("core_hash", "")]
            hashes.extend(
                eq.get("core_hash", "") if isinstance(eq, dict) else str(eq)
                for eq in (regime.get("equivalent_hashes") or [])
            )
        else:
            core_hash = getattr(regime, "core_hash", "")
            equivalent_hashes = getattr(regime, "equivalent_hashes", []) or []
            hashes = [core_hash]
            hashes.extend(
                eq.get("core_hash", "") if isinstance(eq, dict) else str(eq)
                for eq in equivalent_hashes
            )

        hashes = [h for h in hashes if h]
        if hashes and not primary_hash:
            primary_hash = hashes[0]
        for hash_value in hashes:
            if hash_value not in all_hashes:
                all_hashes.append(hash_value)

    equivalent_hashes = [
        {"core_hash": hash_value, "operation": "equivalent", "weight": 1.0}
        for hash_value in all_hashes
        if hash_value != primary_hash
    ]
    return (primary_hash, equivalent_hashes)


def resolve_forecast_subjects(
    *,
    graph_data: Dict[str, Any],
    scenario: Dict[str, Any],
    top_analytics_dsl: str,
    path_analysis_type: str,
    whole_graph_analysis_type: Optional[str],
    log_prefix: str,
    emit_traceback: bool = False,
) -> List[Dict[str, Any]]:
    """Resolve snapshot subjects for a forecast consumer."""
    from analysis_subject_resolution import (
        resolve_analysis_subjects,
        synthesise_snapshot_subjects,
    )

    scenario_id = scenario.get("scenario_id", "unknown")
    subject_dsl = top_analytics_dsl or scenario.get("analytics_dsl", "")
    temporal_dsl = scenario.get("effective_query_dsl", "")
    explicit_cohort_anchor = _extract_cohort_anchor_node(
        f"{subject_dsl}.{temporal_dsl}" if subject_dsl and temporal_dsl else (subject_dsl or temporal_dsl)
    )
    subjects = None

    try:
        if subject_dsl:
            full_dsl = (
                f"{subject_dsl}.{temporal_dsl}"
                if subject_dsl and temporal_dsl
                else (subject_dsl or temporal_dsl)
            )
            resolved = resolve_analysis_subjects(
                graph=graph_data,
                query_dsl=full_dsl,
                analysis_type=path_analysis_type,
                candidate_regimes_by_edge=scenario.get("candidate_regimes_by_edge", {}),
            )
            subjects = synthesise_snapshot_subjects(resolved, path_analysis_type)
            if explicit_cohort_anchor:
                for subj in subjects:
                    subj.setdefault("anchor_node_id", explicit_cohort_anchor)
            print(
                f"{log_prefix} Resolved {len(subjects)} subjects from DSL "
                f"'{full_dsl}' (scenario={scenario_id})"
            )
        elif whole_graph_analysis_type:
            resolved = resolve_analysis_subjects(
                graph=graph_data,
                query_dsl=temporal_dsl,
                analysis_type=whole_graph_analysis_type,
                candidate_regimes_by_edge=scenario.get("candidate_regimes_by_edge", {}),
            )
            subjects = synthesise_snapshot_subjects(
                resolved,
                whole_graph_analysis_type,
            )
            if explicit_cohort_anchor:
                for subj in subjects:
                    subj.setdefault("anchor_node_id", explicit_cohort_anchor)
            print(
                f"{log_prefix} Resolved {len(subjects)} subjects from graph "
                f"(all_graph_parameters, scenario={scenario_id})"
            )
    except Exception as exc:
        print(f"{log_prefix} WARNING: subject resolution failed: {exc}")
        if emit_traceback:
            import traceback

            traceback.print_exc()

    if not subjects:
        subjects = scenario.get("snapshot_subjects", [])
    return subjects or []


def _parse_date(raw: Any) -> date:
    return date.fromisoformat(str(raw)[:10])


def _extract_cohort_anchor_node(query_dsl: str) -> Optional[str]:
    """Extract explicit cohort(anchor, ...) node from the raw DSL."""
    match = re.search(r"cohort\(([^)]*)\)", str(query_dsl or ""))
    if not match:
        return None
    args = match.group(1)
    comma_idx = args.find(",")
    if comma_idx <= 0:
        return None
    head = args[:comma_idx].strip()
    if not head or ":" in head:
        return None
    return head


def _parse_date_or_none(raw: Any) -> Optional[date]:
    if not raw:
        return None
    return _parse_date(raw)


def _resolve_anchor_node(
    graph_data: Dict[str, Any],
    target_edge_id: Optional[str],
) -> Optional[str]:
    if not graph_data:
        return None

    nodes = graph_data.get("nodes") or []
    edges = graph_data.get("edges") or []
    if not nodes or not edges:
        return None

    canonical_node_ids: Dict[str, str] = {}
    start_nodes: List[str] = []
    for node in nodes:
        canonical_id = str(node.get("id") or node.get("uuid") or "")
        if not canonical_id:
            continue
        node_id = node.get("id")
        node_uuid = node.get("uuid")
        if node_id:
            canonical_node_ids[str(node_id)] = canonical_id
        if node_uuid:
            canonical_node_ids[str(node_uuid)] = canonical_id
        if (node.get("entry") or {}).get("is_start"):
            start_nodes.append(canonical_id)

    if not start_nodes:
        return None

    target_edge = None
    if target_edge_id:
        target_edge = next(
            (
                edge
                for edge in edges
                if edge.get("uuid") == target_edge_id or edge.get("id") == target_edge_id
            ),
            None,
        )
    if target_edge is None:
        target_edge = edges[0]

    from_node = canonical_node_ids.get(
        str(target_edge.get("from") or ""),
        str(target_edge.get("from") or ""),
    )
    if not from_node:
        return None

    start_node_set = set(start_nodes)
    if from_node in start_node_set:
        return from_node

    reverse_adj: Dict[str, List[str]] = {}
    for edge in edges:
        src = canonical_node_ids.get(
            str(edge.get("from") or ""),
            str(edge.get("from") or ""),
        )
        dst = canonical_node_ids.get(
            str(edge.get("to") or ""),
            str(edge.get("to") or ""),
        )
        if not src or not dst:
            continue
        reverse_adj.setdefault(dst, []).append(src)

    reachable_starts: Dict[str, int] = {}
    queue = deque([(from_node, 0)])
    visited = {from_node}

    while queue:
        node_id, distance = queue.popleft()
        for upstream_id in sorted(reverse_adj.get(node_id, [])):
            if upstream_id in visited:
                continue
            visited.add(upstream_id)
            next_distance = distance + 1
            if upstream_id in start_node_set:
                reachable_starts[upstream_id] = next_distance
            queue.append((upstream_id, next_distance))

    if not reachable_starts:
        return None

    max_distance = max(reachable_starts.values())
    furthest_starts = sorted(
        node_id
        for node_id, distance in reachable_starts.items()
        if distance == max_distance
    )
    return furthest_starts[0]


def prepare_forecast_subject_entry(
    *,
    subj: Dict[str, Any],
    subject_is_window: bool,
    log_prefix: str,
    anchor_from_override: Optional[str] = None,
    sweep_from_override: Optional[str] = None,
    envelope_anchor_from: Optional[str] = None,
    envelope_anchor_to: Optional[str] = None,
) -> Dict[str, Any]:
    """Prepare one forecast subject through the shared snapshot/regime path.

    Used by the main subject preparation flow and by donor/upstream fetches so
    both routes obey the same regime-selection and derivation policy.

    `envelope_anchor_from` / `envelope_anchor_to` (ISO date strings) are the
    fetch envelope derived from the request's binding plan
    (`runner.request_envelope.build_request_envelope_plan`). When supplied,
    they replace `subj['anchor_from']` / `subj['anchor_to']` at the
    `query_snapshots_for_sweep` call only — the prepared subject's own
    `anchor_from` / `anchor_to` keep their public-window values for
    downstream regime-selection and provenance. This is the structural
    replacement for the 73n in-runtime widening and the carrier-side
    `lookback_days` heuristic; see
    `docs/current/snapshot-fetch-envelope-design.md`.
    """
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from snapshot_service import query_snapshots_for_sweep

    prepared_subject = dict(subj)
    if anchor_from_override is not None:
        prepared_subject["anchor_from"] = anchor_from_override
    if sweep_from_override is not None:
        prepared_subject["sweep_from"] = sweep_from_override

    sweep_from = prepared_subject.get("sweep_from")
    sweep_to = prepared_subject.get("sweep_to")

    fetch_anchor_from = (
        envelope_anchor_from
        if envelope_anchor_from is not None
        else prepared_subject["anchor_from"]
    )
    fetch_anchor_to = (
        envelope_anchor_to
        if envelope_anchor_to is not None
        else prepared_subject["anchor_to"]
    )

    try:
        rows = query_snapshots_for_sweep(
            param_id=prepared_subject["param_id"],
            core_hash=prepared_subject["core_hash"],
            slice_keys=prepared_subject.get("slice_keys", [""]),
            anchor_from=_parse_date(fetch_anchor_from),
            anchor_to=_parse_date(fetch_anchor_to),
            sweep_from=_parse_date_or_none(sweep_from),
            sweep_to=_parse_date_or_none(sweep_to),
            equivalent_hashes=prepared_subject.get("equivalent_hashes"),
        )
    except Exception as exc:
        print(f"{log_prefix} WARNING: snapshot query failed: {exc}")
        rows = []

    pre_regime_count = len(rows)
    raw_candidates = prepared_subject.get("candidate_regimes") or []
    candidate_modes = [
        candidate.get("temporal_mode", "?")
        for candidate in raw_candidates
        if isinstance(candidate, dict)
    ]

    rows = apply_temporal_regime_selection(
        rows,
        prepared_subject,
        subject_is_window,
        requested_cohort_anchor=prepared_subject.get("anchor_node_id"),
    )
    post_regime_count = len(rows)

    hash_counts: Dict[str, int] = {}
    for row in rows:
        core_hash = str(row.get("core_hash", ""))[:16]
        hash_counts[core_hash] = hash_counts.get(core_hash, 0) + 1

    print(
        f"{log_prefix} Subject {prepared_subject.get('from_node', '?')}->"
        f"{prepared_subject.get('to_node', '?')}: "
        f"rows={pre_regime_count}->{post_regime_count} "
        f"cands={len(raw_candidates)} modes={candidate_modes} "
        f"hashes_surviving={hash_counts}"
    )

    derivation = derive_cohort_maturity(
        rows,
        sweep_from=sweep_from,
        sweep_to=sweep_to,
    )

    return {
        "raw_row_count": pre_regime_count,
        "regime_diagnostic": {
            "from_node": prepared_subject.get("from_node", ""),
            "to_node": prepared_subject.get("to_node", ""),
            "path_role": prepared_subject.get("path_role", "only"),
            "pre_rows": pre_regime_count,
            "post_rows": post_regime_count,
            "n_candidates": len(raw_candidates),
            "candidate_modes": candidate_modes,
            "subject_is_window": subject_is_window,
            "hashes_surviving": hash_counts,
            "candidate_hashes": [
                {
                    "core": candidate.get("core_hash", "")[:16],
                    "eq": [
                        str(eq.get("core_hash", "") if isinstance(eq, dict) else eq)[:16]
                        for eq in (candidate.get("equivalent_hashes") or [])
                    ],
                    "mode": candidate.get("temporal_mode", "?"),
                }
                for candidate in raw_candidates
                if isinstance(candidate, dict)
            ],
        },
        "per_edge_result": {
            "path_role": prepared_subject.get("path_role", "only"),
            "from_node": prepared_subject.get("from_node", ""),
            "to_node": prepared_subject.get("to_node", ""),
            "subject": prepared_subject,
            "snapshot_covered_days": {
                str(row.get("anchor_day"))
                for row in rows
                if row.get("anchor_day")
            },
            # Post-regime-selection evidence-superset rows. Downstream
            # callers translate these rows into typed candidates; they do
            # not fetch, dedupe, or read graph-side evidence sources.
            "evidence_superset_rows": list(rows),
            "derivation_result": derivation,
        },
    }


def resolve_request_nodes(
    subjects: List[Dict[str, Any]],
    graph_data: Dict[str, Any],
) -> "tuple[str, str, Optional[str], Optional[str]]":
    """Resolve `(query_from_node, query_to_node, last_edge_id, anchor_node)`
    from the request subjects.

    Behaviour-preserving extraction of the derivation that
    `prepare_forecast_subject_group` runs before building the envelope
    plan. It is shared so an analysis handler can pick `compute_extent`
    (which sizes the envelope/arrival-map grid) *before* preparation runs
    without duplicating the subject-shape derivation. The values returned
    here are exactly those preparation derives — `anchor_from` / `sweep_to`
    are read off `subjects[0]` identically by the handler.
    """
    query_from_node = ""
    query_to_node = ""
    last_edge_id: Optional[str] = None
    for subj in subjects:
        role = subj.get("path_role") or "only"
        if role in ("first", "only"):
            query_from_node = subj.get("from_node", "")
        if role in ("last", "only"):
            query_to_node = subj.get("to_node", "")
            last_edge_id = (subj.get("target") or {}).get("targetId") or last_edge_id

    anchor_node = next(
        (
            str(subj.get("anchor_node_id") or "").strip()
            for subj in subjects
            if str(subj.get("anchor_node_id") or "").strip()
        ),
        None,
    )
    if not anchor_node:
        anchor_node = _resolve_anchor_node(graph_data, last_edge_id)
    return query_from_node, query_to_node, last_edge_id, anchor_node


def _compose_subject_span_t95(
    graph_data: Dict[str, Any],
    source_node: str,
    target_node: str,
    *,
    temporal_mode: str = 'window',
    graph_preference: Optional[str] = None,
    forecasting_settings: Any = None,
) -> Optional[float]:
    """Return t95 of the deterministic ``source_node → target_node`` span,
    or ``None`` when the span is empty / has zero asymptotic mass.

    Used by ``compute_request_extent`` to size the request horizon when the
    rightmost edge's stored ``path_t95`` doesn't match the actual subject
    span:

      * window queries — the subject span is ``query_from → query_to``,
        which differs from the stored anchor-rooted ``path_t95`` once
        ``query_from`` sits downstream of the graph anchor.
      * cohort queries with a DSL-overridden anchor — the subject span is
        ``override_anchor → query_to``, which the stored
        ``anchor-default → query_to.path_t95`` likewise overstates (or
        understates) by the chain of carrier edges that sit outside the
        request.

    The compositional grid is sized off ``snapshot_observation_path_t95_multiplier``
    × the per-edge ``t95`` sum (the convolved t95 is bounded by the sum;
    the multiplier is the same headroom budget used in
    ``compute_request_extent`` for compute_extent itself). The kernel is
    composed once with no Bayesian draws — this is a budget read, not the
    projection itself.
    """
    import math as _math

    from runner.forecast_runtime import build_prepared_span_execution
    from runner.span_kernel import compose_span_kernel

    exec_inputs = build_prepared_span_execution(
        graph_data,
        source_node,
        target_node,
        temporal_mode=temporal_mode,
        graph_preference=graph_preference,
    )
    if exec_inputs is None:
        return None

    edge_t95_sum = 0.0
    for _from, _to, e in getattr(exec_inputs.topo, 'edge_list', []) or []:
        lat = (e.get('p', {}) or {}).get('latency', {}) or {}
        et = lat.get('promoted_t95') or lat.get('t95')
        if isinstance(et, (int, float)) and et > 0:
            edge_t95_sum += float(et)

    path_mult = float(
        getattr(forecasting_settings, 'snapshot_observation_path_t95_multiplier', 1.5)
        if forecasting_settings is not None else 1.5
    )
    grid_tau = int(_math.ceil(path_mult * edge_t95_sum)) if edge_t95_sum > 0 else 0
    if grid_tau <= 0:
        return None

    try:
        kernel = compose_span_kernel(
            topo=exec_inputs.topo,
            edge_params=exec_inputs.edge_params,
            max_tau=grid_tau,
        )
    except Exception:
        return None
    if kernel is None or kernel.span_p <= 0:
        return None

    import numpy as _np
    threshold = 0.95 * float(kernel.span_p)
    idx = int(_np.searchsorted(kernel.K, threshold))
    if idx >= len(kernel.K):
        return None
    return float(idx)


def compute_request_extent(
    *,
    display_settings: Dict[str, Any],
    visibility_mode: str,
    anchor_from: str,
    sweep_to: str,
    graph_data: Dict[str, Any],
    last_edge_id: Optional[str],
    forecasting_settings: Any,
    is_window: bool,
    query_from_node: Optional[str] = None,
    query_to_node: Optional[str] = None,
    anchor_node: Optional[str] = None,
) -> int:
    """Pick the engine boundary ``compute_extent`` for one request per the
    span/calc scoping policy in
    ``docs/current/cohort-maturity-render-calc-policy.md``.

    This is the single horizon-picking authority for every CF analysis type
    (cohort_maturity, daily_conversions, conditioned_forecast, surprise
    gauge). It is called from one place — ``prepare_forecast_subject_group``
    — so every analysis type sizes its envelope grid and projection from one
    rule, parameterised by ``visibility_mode`` / ``display_settings`` /
    ``forecasting_settings``, never by a per-handler copy.

    The three cases:

    - **Manual** (``display_settings['tau_extent']`` is a positive number,
      not the literal ``'auto'`` / ``'Auto'``): ``compute_extent = user_axis``.
    - **Auto, F or F+E mode**: the t95 of the convolved subject span
      ``source → query_to`` scaled by
      ``forecasting_settings.snapshot_observation_path_t95_multiplier``
      (default 1.5). Composition source is the request CDF root —
      ``query_from`` for window, ``anchor`` for cohort. Fallbacks (in
      order): target edge ``t95`` × ``snapshot_observation_t95_multiplier``
      (default 2.0); then ``tau_future_max``.
    - **Auto, E only mode**: ``compute_extent = tau_future_max``.

    ``compute_extent`` is ≥ 0; ``(sweep_to - anchor_from).days`` is the
    final floor so the engine has at least the calendar reach to project
    against.
    """
    import math
    from datetime import date as _date

    def _safe_calendar_days() -> int:
        try:
            af = _date.fromisoformat(str(anchor_from)[:10])
            st = _date.fromisoformat(str(sweep_to)[:10])
            return max(int((st - af).days), 0)
        except (ValueError, TypeError):
            return 0

    # Manual override always wins.
    tau_extent_raw = display_settings.get('tau_extent')
    if tau_extent_raw and str(tau_extent_raw) not in ('auto', 'Auto'):
        try:
            user_axis = int(math.ceil(float(tau_extent_raw)))
            if user_axis > 0:
                return user_axis
        except (ValueError, TypeError):
            pass

    tau_future_max = _safe_calendar_days()

    # Auto, E-only: just enough to cover the calendar reach.
    if visibility_mode == 'e':
        return max(tau_future_max, 0)

    # Auto, F / F+E: compose ``source → query_to`` and use its t95 with the
    # path-headroom multiplier. The composition source is the request CDF
    # root — ``query_from`` for window, ``anchor`` for cohort.
    path_mult = float(
        getattr(forecasting_settings, 'snapshot_observation_path_t95_multiplier', 1.5)
        if forecasting_settings is not None else 1.5
    )
    edge_mult = float(
        getattr(forecasting_settings, 'snapshot_observation_t95_multiplier', 2.0)
        if forecasting_settings is not None else 2.0
    )

    source_node = query_from_node if is_window else anchor_node
    reference_t95: Optional[float] = None
    if source_node and query_to_node and source_node != query_to_node:
        reference_t95 = _compose_subject_span_t95(
            graph_data,
            source_node,
            query_to_node,
            temporal_mode='window' if is_window else 'cohort',
            graph_preference=graph_data.get('model_source_preference'),
            forecasting_settings=forecasting_settings,
        )

    if reference_t95 is not None and reference_t95 > 0:
        return max(int(math.ceil(path_mult * reference_t95)), tau_future_max, 0)

    # Fallback: own-edge t95 on the target edge when composition failed.
    if last_edge_id:
        from runner.forecast_runtime import find_edge_by_id

        edge = find_edge_by_id(graph_data, last_edge_id)
        if edge:
            lat = (edge.get('p', {}) or {}).get('latency', {}) or {}
            _et = lat.get('promoted_t95') or lat.get('t95')
            if isinstance(_et, (int, float)) and _et > 0:
                return max(int(math.ceil(edge_mult * float(_et))), tau_future_max, 0)

    # No latency fit available — calendar reach is all we have.
    return max(tau_future_max, 0)


def prepare_forecast_subject_group(
    *,
    graph_data: Dict[str, Any],
    subjects: List[Dict[str, Any]],
    is_window: bool,
    log_prefix: str,
    envelope_plan: Optional[Any] = None,
    as_at: Optional[str] = None,
    scenario_id: Optional[str] = None,
    context_scope: Optional[ForecastContextScope] = None,
    visibility_mode: str = 'f+e',
    display_settings: Optional[Dict[str, Any]] = None,
    forecasting_settings: Any = None,
) -> ForecastPreparation:
    """Build the shared subject/frame bundle for one forecast query path.

    `envelope_plan` is an optional pre-built `RequestEnvelopePlan` from
    `runner.request_envelope.build_request_envelope_plan`. When not
    supplied, this function constructs one internally from the subjects'
    request shape (graph + query_from_node + query_to_node +
    anchor_node + anchor_from + anchor_to + is_window) and uses it to
    bound each subject's `query_snapshots_for_sweep` call. This is the
    structural replacement for the 73n in-runtime widening and the
    carrier-side `lookback_days` heuristic; see
    `docs/current/snapshot-fetch-envelope-design.md`.

    `visibility_mode` / `display_settings` / `forecasting_settings` are the
    request's calc-scope policy inputs. This function is the single place
    that turns them into the per-query `compute_extent` (via
    `compute_request_extent`) for every CF analysis type — so the
    internally-built envelope grid is sized to `min(compute_extent, 400)`
    rather than the legacy 400-day default, and the chosen `compute_extent`
    is returned on `ForecastPreparation.compute_extent` for the handler to
    feed straight into its projection bundle. Grid horizon and projection
    horizon are therefore one value, picked once, here. The defaults
    (`f+e`, no display settings) reproduce the Auto / saturation-seeking
    posture for callers that do not specialise.
    """
    from runner.span_evidence import compose_path_maturity_frames

    if not subjects:
        return ForecastPreparation(
            query_from_node="",
            query_to_node="",
            anchor_node=None,
            last_edge_id=None,
            is_multi_hop=False,
            anchor_from="",
            anchor_to="",
            sweep_to="",
            total_rows=0,
            cohorts_analysed=0,
            per_edge_results=[],
            composed_frames=[],
            regime_diagnostics=[],
            compute_extent=None,
        )

    query_from_node, query_to_node, last_edge_id, anchor_node = resolve_request_nodes(
        subjects, graph_data
    )
    is_multi_hop = len(subjects) > 1

    # Single horizon authority: pick compute_extent from the request's calc
    # policy (Manual axis / Auto-F+E saturation / Auto-E calendar) using the
    # nodes just resolved and the subjects' own anchor/sweep dates. The
    # envelope grid below is then sized to min(compute_extent, 400) — 400 is
    # the absolute ceiling, never the operating value — and the same
    # compute_extent rides back on the ForecastPreparation so the handler's
    # projection bundle and this grid share one horizon.
    compute_extent = compute_request_extent(
        display_settings=display_settings or {},
        visibility_mode=visibility_mode,
        anchor_from=subjects[0].get("anchor_from", ""),
        sweep_to=subjects[0].get("sweep_to") or subjects[0].get("anchor_to", ""),
        graph_data=graph_data,
        last_edge_id=last_edge_id,
        forecasting_settings=forecasting_settings,
        is_window=is_window,
        query_from_node=query_from_node or None,
        query_to_node=query_to_node or None,
        anchor_node=anchor_node,
    )
    envelope_max_tau = min(int(compute_extent), 400)

    # Build the per-request fetch envelope plan from the resolved request
    # shape if the caller did not supply one. This drives every subject's
    # snapshot fetch through arrival-map-derived bounds rather than the
    # public-window anchor_to (which would force the legacy 73n in-runtime
    # widening to fire as a second DB hit). See
    # docs/current/snapshot-fetch-envelope-design.md.
    if envelope_plan is None and subjects and query_from_node and query_to_node:
        try:
            from runner.request_envelope import build_request_envelope_plan as _build_env
            _af = _parse_date(subjects[0].get("anchor_from", ""))
            _at = _parse_date(subjects[0].get("anchor_to", ""))
            envelope_plan = _build_env(
                graph=graph_data,
                query_from_node=str(query_from_node),
                query_to_node=str(query_to_node),
                anchor_from=_af,
                anchor_to=_at,
                population_root=(
                    str(anchor_node)
                    if (anchor_node and not is_window)
                    else str(query_from_node)
                ),
                graph_preference=graph_data.get("model_source_preference"),
                as_at=as_at,
                scenario_id=scenario_id,
                context_key=(
                    context_scope.context_key if context_scope is not None else None
                ),
                context_selector=(
                    context_scope.context_selector if context_scope is not None else None
                ),
                max_tau=envelope_max_tau,
            )
        except Exception as _env_exc:
            print(
                f"{log_prefix} WARNING: envelope plan construction failed "
                f"({_env_exc!r}); falling back to public-window fetch bounds"
            )
            envelope_plan = None

    # Stage 1: the shared factorised subject path is window-led for both
    # single-hop and multi-hop cohort solves. Exact-match cohort evidence, if
    # later admitted, must arrive on a separate evidence seam rather than by
    # retargeting the shared frame-preparation path.
    per_edge_results: List[Dict[str, Any]] = []
    regime_diagnostics: List[Dict[str, Any]] = []
    total_rows = 0

    for subj in subjects:
        env_anchor_from: Optional[str] = None
        env_anchor_to: Optional[str] = None
        if envelope_plan is not None:
            target = subj.get("target") or {}
            edge_uuid = str(target.get("targetId") or "")
            edge_id = str(subj.get("subject_id") or "")
            env = (
                envelope_plan.by_edge_uuid.get(edge_uuid)
                if edge_uuid
                else None
            )
            if env is None and edge_id:
                env = envelope_plan.by_edge_id.get(edge_id)
            if env is not None:
                env_anchor_from = env.anchor_from.isoformat()
                env_anchor_to = env.anchor_to.isoformat()
        prepared_entry = prepare_forecast_subject_entry(
            subj=subj,
            subject_is_window=True,
            log_prefix=log_prefix,
            envelope_anchor_from=env_anchor_from,
            envelope_anchor_to=env_anchor_to,
        )
        total_rows += prepared_entry["raw_row_count"]
        regime_diagnostic = dict(prepared_entry["regime_diagnostic"])
        regime_diagnostic["is_window"] = is_window
        regime_diagnostics.append(regime_diagnostic)
        per_edge_results.append(prepared_entry["per_edge_result"])

    composed_frames: List[Dict[str, Any]] = []
    cohorts_analysed = 0
    if query_from_node and query_to_node:
        composed = compose_path_maturity_frames(
            per_edge_results=per_edge_results,
            query_from_node=query_from_node,
            query_to_node=query_to_node,
            anchor_node=anchor_node,
        )
        composed_frames = composed.get("frames", [])
        cohorts_analysed = composed.get("cohorts_analysed", 0)
        print(
            f"{log_prefix} Composed: from={query_from_node} to={query_to_node} "
            f"anchor={anchor_node} frames={len(composed_frames)} "
            f"cohorts={cohorts_analysed}"
        )
    elif len(per_edge_results) == 1:
        # Fallback snapshot_subjects do not always carry from/to metadata.
        # For a single subject we can still surface its derived frames
        # directly, which keeps minimal cohort handlers emitting frames
        # and forecast tails even when no path composition is possible.
        only_result = per_edge_results[0]
        derivation = only_result.get("derivation_result") or {}
        if not query_from_node:
            query_from_node = only_result.get("from_node", "")
        if not query_to_node:
            query_to_node = only_result.get("to_node", "")
        composed_frames = derivation.get("frames", []) or []
        cohorts_analysed = int(derivation.get("cohorts_analysed", 0) or 0)
        print(
            f"{log_prefix} Composed fallback: from={query_from_node or '?'} "
            f"to={query_to_node or '?'} anchor={anchor_node} "
            f"frames={len(composed_frames)} cohorts={cohorts_analysed}"
        )

    anchor_from = subjects[0].get("anchor_from", "")
    anchor_to = subjects[0].get("anchor_to", "")
    sweep_to = subjects[0].get("sweep_to") or anchor_to

    return ForecastPreparation(
        query_from_node=query_from_node,
        query_to_node=query_to_node,
        anchor_node=anchor_node,
        last_edge_id=last_edge_id,
        is_multi_hop=is_multi_hop,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        total_rows=total_rows,
        cohorts_analysed=cohorts_analysed,
        per_edge_results=per_edge_results,
        composed_frames=composed_frames,
        regime_diagnostics=regime_diagnostics,
        envelope_plan=envelope_plan,
        compute_extent=compute_extent,
    )


# ── Shared upstream-fetch + axis-horizon prep helpers ────────────────────
# Relocated from api_handlers.py (73q Phase 4) so the shared CF analysis
# boundary (runner/cf_analysis.py) and the legacy CF handlers can import
# them from the preparation layer without a cycle back through
# api_handlers. Behaviour is unchanged from the original api_handlers copy.


def _make_envelope_aware_upstream_fetcher(
    envelope_plan: Optional[Any],
    per_edge_results_out: Optional[Dict[str, Dict[str, Any]]] = None,
):
    """Wrap `_fetch_upstream_observations` so it carries `envelope_plan`.

    The runtime-prep call site (`prepare_forecast_runtime_inputs`) invokes
    its `upstream_observation_fetcher` with a fixed kwarg signature; this
    closure captures the per-request envelope_plan so the upstream fetch
    bounds its `query_snapshots_for_sweep` by the carrier-side
    arrival-map envelope rather than the legacy `axis_tau_max * 2 floor 60`
    heuristic. See docs/current/snapshot-fetch-envelope-design.md.

    `per_edge_results_out`, when supplied, captures the per-edge
    derivation result for every carrier edge fetched. Callers that build
    `_stage6_per_edge_evidence` from a per-edge map (e.g. CF whole-graph
    mode) pass their `all_per_edge_results` here so the upstream fetch's
    output is visible to the carrier-evidence builder. Without this the
    carrier primitive degenerates to PRIOR_ONLY and the conditioned
    posterior diverges from CM's (which has its own inline upstream
    fetch already feeding its per-edge map).
    """
    def _fetcher(**kwargs: Any) -> Optional[Dict[str, Any]]:
        kwargs['envelope_plan'] = envelope_plan
        kwargs['per_edge_results_out'] = per_edge_results_out
        return _fetch_upstream_observations(**kwargs)
    return _fetcher


def _fetch_upstream_observations(
    graph_data: Dict[str, Any],
    anchor_node: str,
    query_from_node: str,
    per_edge_results: List[Dict[str, Any]],
    candidate_regimes_by_edge: Dict[str, Any],
    anchor_from: str,
    anchor_to: str,
    sweep_from: str,
    sweep_to: str,
    axis_tau_max: Optional[int] = None,
    log_prefix: str = '[upstream]',
    envelope_plan: Optional[Any] = None,
    per_edge_results_out: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """Fetch upstream edge snapshot data for empirical carrier (Tier 2).

    Shared by v2 and v3 handlers. Queries the snapshot DB for edges
    on the path from anchor to from_node, derives cohort maturity
    frames, and extracts upstream observations.

    Returns upstream_obs dict (for XProvider) or None if fetch fails.
    """
    from datetime import date, timedelta
    from runner.span_kernel import _build_span_topology
    from runner.span_upstream import extract_upstream_observations

    # Collect evidence frames for edges entering from_node
    up_edge_frames: Dict[str, List[Dict[str, Any]]] = {}

    # Index subject edges we already have
    for entry in per_edge_results:
        target_id = (entry.get('subject') or {}).get('target', {}).get('targetId', '')
        if target_id:
            up_edge_frames[target_id] = (
                entry.get('derivation_result', {}).get('frames', [])
            )

    # Find upstream edges not already in subject set
    up_topo = _build_span_topology(graph_data, anchor_node, query_from_node)
    if up_topo is None:
        return None

    def _edge_uuid(e_dict):
        return str(e_dict.get('uuid', e_dict.get('id', '')))

    missing_eids = [
        _edge_uuid(e_data) for _, _, e_data in up_topo.edge_list
        if _edge_uuid(e_data) not in up_edge_frames
    ]
    if missing_eids:
        print(f"{log_prefix} fetching {len(missing_eids)} upstream edges")
        fetch_ok = True
        for eid in missing_eids:
            regimes = candidate_regimes_by_edge.get(eid, [])
            if not regimes:
                print(f"{log_prefix} no regime for {eid[:20]}")
                fetch_ok = False
                break
            core_hash, equivalent_hashes = flatten_candidate_regime_hashes(regimes)
            if not core_hash:
                fetch_ok = False
                break
            up_edge = None
            for e in graph_data.get('edges', []):
                if str(e.get('uuid', e.get('id', ''))) == str(eid):
                    up_edge = e
                    break
            if not up_edge:
                fetch_ok = False
                break
            p_id = up_edge.get('p', {}).get('id', '') or eid
            # Donor-fetch backward extension for the carrier edge: prefer
            # the principled envelope from the request's envelope_plan
            # (carrier-rooted arrival map with backward donor extension by
            # max(t95 + onset) over the carrier sub-tree). Fall back to
            # the legacy `axis_tau_max * 2 floor 60` heuristic only when
            # the envelope_plan is unavailable for this edge — pre-fix
            # behaviour, kept as a defensive backstop.
            envelope_anchor_from: Optional[str] = None
            envelope_anchor_to: Optional[str] = None
            if envelope_plan is not None:
                env = envelope_plan.by_edge_uuid.get(str(eid))
                if env is not None:
                    envelope_anchor_from = env.anchor_from.isoformat()
                    envelope_anchor_to = env.anchor_to.isoformat()
            if envelope_anchor_from is None:
                try:
                    af_d = date.fromisoformat(anchor_from)
                    lookback_days = max((axis_tau_max or 0) * 2, 60)
                    envelope_anchor_from = (af_d - timedelta(days=lookback_days)).isoformat()
                except (ValueError, TypeError):
                    envelope_anchor_from = anchor_from
            if envelope_anchor_to is None:
                envelope_anchor_to = anchor_to
            donor_subject = {
                'subject_id': f'upstream::{eid}',
                'path_role': 'only',
                'param_id': p_id,
                'core_hash': core_hash,
                'equivalent_hashes': equivalent_hashes,
                'slice_keys': [''],
                'anchor_from': anchor_from,
                'anchor_to': anchor_to,
                'sweep_from': sweep_from,
                'sweep_to': sweep_to,
                'candidate_regimes': regimes,
                'target': {'targetId': eid},
                'from_node': str(up_edge.get('from') or ''),
                'to_node': str(up_edge.get('to') or ''),
            }
            prepared_upstream = prepare_forecast_subject_entry(
                subj=donor_subject,
                subject_is_window=True,
                log_prefix=log_prefix,
                anchor_from_override=envelope_anchor_from,
                sweep_from_override=envelope_anchor_from,
                envelope_anchor_from=envelope_anchor_from,
                envelope_anchor_to=envelope_anchor_to,
            )
            up_edge_frames[eid] = (
                prepared_upstream.get('per_edge_result', {})
                .get('derivation_result', {})
                .get('frames', [])
            )
            # Surface the per-edge result so the caller's superset-candidate
            # translator can include this carrier edge for downstream
            # primitive binding. Without this, the carrier primitive falls
            # through to PRIOR_ONLY.
            if per_edge_results_out is not None:
                _per_edge_entry = prepared_upstream.get('per_edge_result')
                if _per_edge_entry:
                    per_edge_results_out[str(eid)] = _per_edge_entry
        if not fetch_ok:
            print(f"{log_prefix} incomplete fetch, discarding partial evidence")
            up_edge_frames = {}

    # Extract observations (sum y across edges entering from_node)
    if up_edge_frames:
        upstream_obs = extract_upstream_observations(
            graph=graph_data,
            anchor_node_id=anchor_node,
            x_node_id=query_from_node,
            per_edge_frames=up_edge_frames,
        )
        if upstream_obs:
            total_obs = sum(len(v) for v in upstream_obs.values())
            print(f"{log_prefix} {total_obs} observations "
                  f"across {len(upstream_obs)} cohorts")
        return upstream_obs
    return None


