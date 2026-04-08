"""
Analysis Subject Resolution — Doc 31

Resolves a DSL query + graph + analysis type into the set of edges
(subjects) the BE needs to process, with path structure annotations.

The FE sends the DSL string and candidate_regimes_by_edge map. This
module parses the DSL, traverses the graph to identify in-scope edges,
looks up their candidate regimes from the FE-provided map, and returns
a structured ResolvedAnalysisPath.

See: docs/current/project-bayes/31-be-analysis-subject-resolution.md
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Union

from graph_select import (
    ResolvedEdge,
    ResolvedPath,
    resolve_all_parameter_edges,
    resolve_children_edges,
    resolve_ordered_path,
)
from query_dsl import ParsedQuery, parse_query
from snapshot_regime_selection import CandidateRegime


# ============================================================
# Data types
# ============================================================

@dataclass
class ResolvedAnalysisSubject:
    """One edge's worth of resolved analysis data."""
    edge_uuid: str
    from_node_id: str
    to_node_id: str
    path_role: str                                  # 'first', 'last', 'intermediate', 'only', 'child', 'all'
    candidate_regimes: List[CandidateRegime]        # looked up from FE map


@dataclass
class ResolvedAnalysisResult:
    """The fully resolved subject set for one analysis request.

    For funnel_path scope rules, from_node/to_node and ordered_edges
    are populated. For other scope rules (children_of_selected_node,
    all_graph_parameters), they are None and subjects are unordered.
    """
    from_node: Optional[str]
    to_node: Optional[str]
    ordered_edge_uuids: Optional[List[str]]         # path order (funnel_path only)
    subjects: List[ResolvedAnalysisSubject]
    scope_rule: str
    temporal_mode: Optional[str] = None             # 'window' or 'cohort', extracted from query_dsl
    anchor_from: Optional[str] = None               # ISO date
    anchor_to: Optional[str] = None                 # ISO date
    sweep_from: Optional[str] = None                # ISO date (cohort_maturity only)
    sweep_to: Optional[str] = None                  # ISO date (cohort_maturity only)


# ============================================================
# Scope rule → analysis type mapping
# ============================================================

# Mirrors the FE's snapshotContract.scopeRule per analysis type.
ANALYSIS_TYPE_SCOPE_RULES: Dict[str, str] = {
    'cohort_maturity': 'funnel_path',
    'daily_conversions': 'funnel_path',
    'lag_histogram': 'funnel_path',
    'lag_fit': 'funnel_path',
    'surprise_gauge': 'funnel_path',
    'outcome_comparison': 'children_of_selected_node',
    'branch_comparison': 'children_of_selected_node',
    'bayes_fit': 'all_graph_parameters',
}

ANALYSIS_TYPE_READ_MODES: Dict[str, str] = {
    'cohort_maturity': 'cohort_maturity',
    'daily_conversions': 'raw_snapshots',
    'lag_histogram': 'raw_snapshots',
    'lag_fit': 'sweep_simple',
    'surprise_gauge': 'sweep_simple',
    'outcome_comparison': 'raw_snapshots',
    'branch_comparison': 'raw_snapshots',
    'bayes_fit': 'sweep_simple',
}


# ============================================================
# Main entry point
# ============================================================

def resolve_analysis_subjects(
    graph: Union[Dict[str, Any], Any],
    query_dsl: str,
    analysis_type: str,
    candidate_regimes_by_edge: Dict[str, List[Dict[str, Any]]],
) -> ResolvedAnalysisResult:
    """Resolve a DSL + graph + analysis type into analysis subjects.

    This is the BE equivalent of the FE's mapFetchPlanToSnapshotSubjects.
    The FE sends the DSL string; the BE parses it, traverses the graph,
    and builds subjects with candidate regimes from the FE-provided map.

    Args:
        graph: Graph object or dict (as received in the request)
        query_dsl: The full query DSL string (e.g. "from(a).to(b).window(-90d:)")
        analysis_type: Analysis type ID (must be in ANALYSIS_TYPE_SCOPE_RULES)
        candidate_regimes_by_edge: FE-computed map of edge UUID → CandidateRegime[]

    Returns:
        ResolvedAnalysisResult with subjects and path structure.

    Raises:
        ValueError: If analysis_type is unknown or DSL is invalid for the scope rule.
    """
    scope_rule = ANALYSIS_TYPE_SCOPE_RULES.get(analysis_type)
    if scope_rule is None:
        raise ValueError(f"Unknown analysis type: {analysis_type}")

    # Parse DSL for temporal info (needed regardless of scope rule).
    # Note: query_dsl.py doesn't parse cohort(), so we extract temporal
    # info from the raw string for cohort clauses.
    parsed = parse_query(query_dsl)
    temporal_mode = _extract_temporal_mode(query_dsl)
    anchor_from, anchor_to = _extract_time_bounds(query_dsl)

    # Resolve edges based on scope rule.
    if scope_rule == 'funnel_path':
        return _resolve_funnel_path(
            graph, query_dsl, parsed, analysis_type, scope_rule,
            candidate_regimes_by_edge, temporal_mode, anchor_from, anchor_to,
        )
    elif scope_rule == 'children_of_selected_node':
        return _resolve_children(
            graph, parsed, analysis_type, scope_rule,
            candidate_regimes_by_edge, temporal_mode, anchor_from, anchor_to,
        )
    elif scope_rule == 'all_graph_parameters':
        return _resolve_all_parameters(
            graph, analysis_type, scope_rule,
            candidate_regimes_by_edge, temporal_mode, anchor_from, anchor_to,
        )
    else:
        raise ValueError(f"Unknown scope rule: {scope_rule}")


# ============================================================
# Per-scope-rule resolution
# ============================================================

def _resolve_funnel_path(
    graph: Union[Dict[str, Any], Any],
    query_dsl: str,
    parsed: ParsedQuery,
    analysis_type: str,
    scope_rule: str,
    candidate_regimes_by_edge: Dict[str, List[Dict[str, Any]]],
    temporal_mode: Optional[str],
    anchor_from: Optional[str],
    anchor_to: Optional[str],
) -> ResolvedAnalysisResult:
    """Resolve funnel_path scope: all edges on paths from(A).to(Z)."""
    resolved_path: ResolvedPath = resolve_ordered_path(graph, query_dsl)

    subjects = [
        ResolvedAnalysisSubject(
            edge_uuid=edge.edge_uuid,
            from_node_id=edge.from_node_id,
            to_node_id=edge.to_node_id,
            path_role=edge.path_role,
            candidate_regimes=_lookup_regimes(edge.edge_uuid, candidate_regimes_by_edge),
        )
        for edge in resolved_path.ordered_edges
    ]

    # For cohort_maturity, sweep_from defaults to anchor_from,
    # sweep_to defaults to today.
    sweep_from = None
    sweep_to = None
    if analysis_type == 'cohort_maturity':
        sweep_from = anchor_from
        # sweep_to: use asat if present, else today
        import datetime
        sweep_to = datetime.date.today().isoformat()

    return ResolvedAnalysisResult(
        from_node=resolved_path.from_node,
        to_node=resolved_path.to_node,
        ordered_edge_uuids=[e.edge_uuid for e in resolved_path.ordered_edges],
        subjects=subjects,
        scope_rule=scope_rule,
        temporal_mode=temporal_mode,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_from=sweep_from,
        sweep_to=sweep_to,
    )


def _resolve_children(
    graph: Union[Dict[str, Any], Any],
    parsed: ParsedQuery,
    analysis_type: str,
    scope_rule: str,
    candidate_regimes_by_edge: Dict[str, List[Dict[str, Any]]],
    temporal_mode: Optional[str],
    anchor_from: Optional[str],
    anchor_to: Optional[str],
) -> ResolvedAnalysisResult:
    """Resolve children_of_selected_node scope.

    The parent node is derived from the DSL. For outcome_comparison /
    branch_comparison, the DSL uses visitedAny() which names the child
    nodes, and from() names the parent.
    """
    parent_node = parsed.from_node
    if not parent_node:
        raise ValueError(
            f"children_of_selected_node scope requires from() in DSL, got: {parsed.raw}"
        )

    edges = resolve_children_edges(graph, parent_node)

    subjects = [
        ResolvedAnalysisSubject(
            edge_uuid=edge.edge_uuid,
            from_node_id=edge.from_node_id,
            to_node_id=edge.to_node_id,
            path_role=edge.path_role,
            candidate_regimes=_lookup_regimes(edge.edge_uuid, candidate_regimes_by_edge),
        )
        for edge in edges
    ]

    return ResolvedAnalysisResult(
        from_node=parent_node,
        to_node=None,
        ordered_edge_uuids=None,
        subjects=subjects,
        scope_rule=scope_rule,
        temporal_mode=temporal_mode,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
    )


def _resolve_all_parameters(
    graph: Union[Dict[str, Any], Any],
    analysis_type: str,
    scope_rule: str,
    candidate_regimes_by_edge: Dict[str, List[Dict[str, Any]]],
    temporal_mode: Optional[str],
    anchor_from: Optional[str],
    anchor_to: Optional[str],
) -> ResolvedAnalysisResult:
    """Resolve all_graph_parameters scope: every edge in the graph."""
    edges = resolve_all_parameter_edges(graph)

    subjects = [
        ResolvedAnalysisSubject(
            edge_uuid=edge.edge_uuid,
            from_node_id=edge.from_node_id,
            to_node_id=edge.to_node_id,
            path_role=edge.path_role,
            candidate_regimes=_lookup_regimes(edge.edge_uuid, candidate_regimes_by_edge),
        )
        for edge in edges
    ]

    return ResolvedAnalysisResult(
        from_node=None,
        to_node=None,
        ordered_edge_uuids=None,
        subjects=subjects,
        scope_rule=scope_rule,
        temporal_mode=temporal_mode,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
    )


# ============================================================
# Helpers
# ============================================================

def _lookup_regimes(
    edge_uuid: str,
    candidate_regimes_by_edge: Dict[str, List[Dict[str, Any]]],
) -> List[CandidateRegime]:
    """Look up candidate regimes for an edge from the FE-provided map.

    Returns empty list if the edge is not in the map (the edge may not
    have been fetched, or may be a structural-only edge with no data).
    """
    raw_list = candidate_regimes_by_edge.get(edge_uuid, [])
    regimes: List[CandidateRegime] = []
    for entry in raw_list:
        if isinstance(entry, CandidateRegime):
            regimes.append(entry)
        elif isinstance(entry, dict):
            regimes.append(CandidateRegime(
                core_hash=entry.get('core_hash', ''),
                equivalent_hashes=entry.get('equivalent_hashes', []),
            ))
    return regimes


def synthesise_snapshot_subjects(
    result: ResolvedAnalysisResult,
    analysis_type: str,
) -> list[dict]:
    """Convert a ResolvedAnalysisResult into legacy snapshot_subjects dicts.

    This allows the existing _handle_snapshot_analyze_subjects handler to
    process BE-resolved subjects without any changes to the iteration or
    derivation logic.  The synthesised dicts contain the same fields the
    handler reads from FE-provided snapshot_subjects.

    The snapshot DB is queried by core_hash (not param_id), so param_id
    is a placeholder.  All candidate regime hashes are flattened into
    equivalent_hashes so the DB query returns rows from every regime;
    _apply_regime_selection then filters to the preferred one.
    """
    read_mode = ANALYSIS_TYPE_READ_MODES.get(analysis_type, 'raw_snapshots')
    subjects: list[dict] = []

    for i, subj in enumerate(result.subjects):
        # Flatten all regime hashes: first regime's core_hash is primary,
        # all others (core + equivalents from every regime) are equivalents.
        all_hashes: list[str] = []
        primary_hash = ''
        for regime in subj.candidate_regimes:
            if not primary_hash:
                primary_hash = regime.core_hash
            for h in regime.all_hashes():
                if h not in all_hashes:
                    all_hashes.append(h)

        # equivalent_hashes = everything except the primary
        eq_hashes = [
            {'core_hash': h, 'operation': 'equivalent', 'weight': 1.0}
            for h in all_hashes if h != primary_hash
        ]

        synth: dict = {
            'subject_id': f'resolved:{subj.edge_uuid}:{i}',
            'param_id': '_resolved',  # not used in DB query when core_hash present
            'core_hash': primary_hash,
            'equivalent_hashes': eq_hashes,
            'candidate_regimes': [
                {'core_hash': r.core_hash, 'equivalent_hashes': r.equivalent_hashes}
                for r in subj.candidate_regimes
            ],
            'read_mode': read_mode,
            'anchor_from': result.anchor_from or '',
            'anchor_to': result.anchor_to or '',
            'slice_keys': [''],  # broad read — regime selection handles filtering
            'target': {'targetId': subj.edge_uuid},
            'from_node': subj.from_node_id,
            'to_node': subj.to_node_id,
            'path_role': subj.path_role,
        }

        if read_mode in ('cohort_maturity', 'sweep_simple'):
            synth['sweep_from'] = result.sweep_from or result.anchor_from or ''
            synth['sweep_to'] = result.sweep_to or ''

        subjects.append(synth)

    return subjects


def _extract_temporal_mode(query_dsl: str) -> Optional[str]:
    """Extract temporal mode from the raw DSL string.

    Checks for window() or cohort() clause presence.
    The BE parser (query_dsl.py) only parses window(); cohort() is
    detected by string matching on the raw DSL.
    """
    if 'cohort(' in query_dsl:
        return 'cohort'
    if 'window(' in query_dsl:
        return 'window'
    return None


def _resolve_date(raw: str | None) -> str:
    """Resolve a DSL date value to an ISO date string.

    Handles: relative offsets (-90d, -7w), UK dates (1-Jan-25),
    ISO dates (2025-01-01), and empty/None (defaults to today).
    """
    import datetime as _dt
    import re as _re

    today = _dt.date.today()

    if not raw or not raw.strip():
        return today.isoformat()

    raw = raw.strip()

    # Relative offset: -90d, -7w, -3m, -1y
    m = _re.match(r'^(-?\d+)([dwmy])$', raw)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if unit == 'd':
            return (today + _dt.timedelta(days=n)).isoformat()
        elif unit == 'w':
            return (today + _dt.timedelta(weeks=n)).isoformat()
        elif unit == 'm':
            return (today + _dt.timedelta(days=n * 30)).isoformat()
        elif unit == 'y':
            return (today + _dt.timedelta(days=n * 365)).isoformat()

    # UK date format: d-MMM-yy (e.g. 1-Jan-25, 8-Jan-26)
    for fmt in ('%d-%b-%y', '%d-%b-%Y'):
        try:
            return _dt.datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue

    # ISO format passthrough
    try:
        return _dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        pass

    return today.isoformat()


def _extract_time_bounds(query_dsl: str) -> tuple:
    """Extract anchor_from and anchor_to from the raw DSL string.

    Parses both window(start:end) and cohort(start:end) clauses.
    The BE parser (query_dsl.py) only handles window(); cohort() must
    be extracted by regex from the raw string.

    Returns (anchor_from, anchor_to) as ISO date strings.
    """
    import re

    # Try window(start:end)
    m = re.search(r'window\(([^:]*):([^)]*)\)', query_dsl)
    if m:
        return (_resolve_date(m.group(1)), _resolve_date(m.group(2)))

    # Try cohort(start:end)
    m = re.search(r'cohort\(([^:]*):([^)]*)\)', query_dsl)
    if m:
        return (_resolve_date(m.group(1)), _resolve_date(m.group(2)))

    import datetime
    today = datetime.date.today().isoformat()
    return (today, today)
