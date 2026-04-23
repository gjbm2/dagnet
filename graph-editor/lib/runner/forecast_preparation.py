"""Shared preparation helpers for forecast chart and CF handlers.

Doc 60 WP1 requires the conditioned-forecast endpoint and the cohort
maturity v3 chart to resolve subjects, pick temporal evidence families,
query snapshots, and compose span evidence through one path. That keeps
multi-hop cohort queries on doc 47's rule: subject-frame construction
uses window evidence even when the user asked a cohort question.

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
    subject_is_window: bool
    anchor_from: str
    anchor_to: str
    sweep_to: str
    total_rows: int
    cohorts_analysed: int
    per_edge_results: List[Dict[str, Any]]
    composed_frames: List[Dict[str, Any]]
    regime_diagnostics: List[Dict[str, Any]]


def apply_temporal_regime_selection(
    rows: List[Dict[str, Any]],
    subj: Dict[str, Any],
    is_window: bool,
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
    preferred_regimes = [regime for regime, mode in tagged if mode == preferred]
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
) -> Dict[str, Any]:
    """Prepare one forecast subject through the shared snapshot/regime path.

    Used by the main subject preparation flow and by donor/upstream fetches so
    both routes obey the same regime-selection and derivation policy.
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

    try:
        rows = query_snapshots_for_sweep(
            param_id=prepared_subject["param_id"],
            core_hash=prepared_subject["core_hash"],
            slice_keys=prepared_subject.get("slice_keys", [""]),
            anchor_from=_parse_date(prepared_subject["anchor_from"]),
            anchor_to=_parse_date(prepared_subject["anchor_to"]),
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

    rows = apply_temporal_regime_selection(rows, prepared_subject, subject_is_window)
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
            "derivation_result": derivation,
        },
    }


def prepare_forecast_subject_group(
    *,
    graph_data: Dict[str, Any],
    subjects: List[Dict[str, Any]],
    is_window: bool,
    log_prefix: str,
) -> ForecastPreparation:
    """Build the shared subject/frame bundle for one forecast query path."""
    from runner.span_evidence import compose_path_maturity_frames

    if not subjects:
        return ForecastPreparation(
            query_from_node="",
            query_to_node="",
            anchor_node=None,
            last_edge_id=None,
            is_multi_hop=False,
            subject_is_window=is_window,
            anchor_from="",
            anchor_to="",
            sweep_to="",
            total_rows=0,
            cohorts_analysed=0,
            per_edge_results=[],
            composed_frames=[],
            regime_diagnostics=[],
        )

    query_from_node = ""
    query_to_node = ""
    last_edge_id = None
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
    is_multi_hop = len(subjects) > 1
    # Doc 47: multi-hop cohort queries still build subject frames from the
    # window evidence family; exact single-hop cohort queries keep cohort
    # frames here. This flag is about observed-frame retrieval only.
    subject_is_window = is_window or is_multi_hop

    per_edge_results: List[Dict[str, Any]] = []
    regime_diagnostics: List[Dict[str, Any]] = []
    total_rows = 0

    for subj in subjects:
        prepared_entry = prepare_forecast_subject_entry(
            subj=subj,
            subject_is_window=subject_is_window,
            log_prefix=log_prefix,
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
        subject_is_window=subject_is_window,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        total_rows=total_rows,
        cohorts_analysed=cohorts_analysed,
        per_edge_results=per_edge_results,
        composed_frames=composed_frames,
        regime_diagnostics=regime_diagnostics,
    )
