"""
Shared API handlers for Python endpoints.

Used by both:
- dev-server.py (FastAPI)
- python-api.py (Vercel serverless)

This ensures dev and prod use identical handler logic.
"""
import math
import os
from typing import Dict, Any, Optional, List

from perf_profile import maybe_profile

_COHORT_DEBUG = bool(os.environ.get('DAGNET_COHORT_DEBUG'))


def handle_generate_all_parameters(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle generate-all-parameters endpoint.
    
    Args:
        data: Request body containing:
            - graph: Graph data (required)
            - paramTypes: Optional filter by type
            - downstream_of: Optional incremental updates
            - edge_id: Optional filter to single edge (returns base p, cost_gbp, labour_cost)
            - conditional_index: Optional filter to specific conditional (requires edge_id)
            - maxChecks: Optional (default 200)
            - literal_weights: Optional
            - preserve_condition: Optional (default True)
            - preserveCaseContext: Optional (default True)
    
    Returns:
        Response dict with parameters and stats
    """
    graph_data = data.get('graph')
    param_types = data.get('paramTypes')  # Optional: filter by type
    downstream_of = data.get('downstream_of')  # Optional: incremental updates
    edge_id = data.get('edge_id')  # Optional: filter to single edge
    conditional_index = data.get('conditional_index')  # Optional: filter to specific conditional
    max_checks = data.get('maxChecks', 200)
    literal_weights = data.get('literal_weights')
    preserve_condition = data.get('preserve_condition', True)
    preserve_case_context = data.get('preserveCaseContext', True)
    
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    from msmdc import generate_all_parameter_queries, generate_queries_by_type
    from graph_types import Graph
    
    graph = Graph.model_validate(graph_data)
    
    # Generate all parameters or filter by type/downstream/edge
    # Pass edge_id and conditional_index directly to MSMDC for efficiency
    if param_types:
        params_by_type = generate_queries_by_type(
            graph, param_types, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context
        )
        all_params = []
        for ptype, params in params_by_type.items():
            all_params.extend(params)
    else:
        all_params = generate_all_parameter_queries(
            graph, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context,
            edge_uuid=edge_id,  # Pass edge filter directly to MSMDC
            conditional_index=conditional_index  # Pass conditional filter directly to MSMDC
        )
    
    # Compute anchor_node_id for all edges (furthest upstream START node)
    from msmdc import compute_all_anchor_nodes
    anchor_map = compute_all_anchor_nodes(graph)
    
    # Format response
    parameters = []
    stats_by_type = {}
    
    for param in all_params:
        parameters.append({
            "paramType": param.param_type,
            "paramId": param.param_id,
            "edgeUuid": getattr(param, "edge_uuid", None),
            "edgeKey": param.edge_key,
            "condition": param.condition,
            "query": param.query,
            "nQuery": getattr(param, "n_query", None),
            "stats": param.stats
        })
        
        # Count by type
        if param.param_type not in stats_by_type:
            stats_by_type[param.param_type] = 0
        stats_by_type[param.param_type] += 1
    
    return {
        "parameters": parameters,
        "anchors": anchor_map,  # Edge UUID → anchor_node_id (for cohort queries)
        "stats": {
            "total": len(parameters),
            "byType": stats_by_type
        },
        "success": True
    }


def _format_retrieved_at_for_display(retrieved_at) -> Optional[str]:
    """Format a retrieved_at value for gauge display (d-MMM-yy)."""
    if not retrieved_at:
        return None
    try:
        from datetime import date as date_type, datetime
        months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        if isinstance(retrieved_at, str):
            # Already in d-MMM-yy?
            if any(m in retrieved_at for m in months):
                return retrieved_at
            d = date_type.fromisoformat(str(retrieved_at)[:10])
        elif isinstance(retrieved_at, (date_type, datetime)):
            d = retrieved_at if isinstance(retrieved_at, date_type) else retrieved_at.date()
        else:
            return str(retrieved_at)
        return f"{d.day}-{months[d.month - 1]}-{str(d.year)[-2:]}"
    except (ValueError, TypeError):
        return str(retrieved_at) if retrieved_at else None


def _compute_surprise_gauge(
    graph_data: Dict[str, Any],
    target_id: Optional[str],
    subj: Dict[str, Any],
    data: Dict[str, Any],
    scenario: Dict[str, Any],
    *,
    effective_query_dsl: str = '',
) -> Dict[str, Any]:
    """Surprise gauge: scalar-reducer callsite over the shared CF bundle
    (doc 55, 73q Phase 5a).

    The gauge is a two-distribution z-score over four marginal pairs the
    scalar reducer emits at ``bundle.saturation_tau``:

      needle: FC predictive (post-evidence continuation, predictive σ)
      dial:   unconditioned epistemic (model overlay, epistemic σ)

      z = (needle_mean − dial_mean) / sqrt(needle_sd² + dial_sd²)

    Two variables, same shape:

      - p: FC vs unconditioned posterior on the asymptotic per-arrival rate.
        "Did the evidence shift my belief about the conversion rate?"
      - completeness: FC vs unconditioned posterior on rate(frontier)/rate(∞).
        "Did the evidence shift my belief about how mature this cohort is?"

    The raw evidence sums (Σn, Σk) are surfaced on the response as
    display context — they are not consumed by the gauge maths (the FC
    needle already incorporates them).

    No analytic fallback, no bespoke maths, no model_vars branching. If
    the bundle cannot be built (no resolved params, σ ≤ 0, no snapshot
    rows, missing subject fields), the variable reports available: false
    with a reason.
    """
    from runner.model_resolver import resolve_model_params
    from runner.forecast_preparation import (
        extract_forecast_context_scope,
        prepare_forecast_subject_group,
    )
    from runner.cf_analysis import prepare_cf_scalar_bundle
    from runner.cohort_forecast_v3 import reduce_cf_scalars
    from runner.forecast_runtime import parse_asat_from_dsl

    def norm_cdf(z: float) -> float:
        return 0.5 * math.erfc(-z / math.sqrt(2.0))

    def classify_zone(q: float) -> str:
        tail = abs(q - 0.5) * 2
        if tail < 0.60:   return 'expected'
        if tail < 0.80:   return 'noteworthy'
        if tail < 0.90:   return 'unusual'
        if tail < 0.98:   return 'surprising'
        return 'alarming'

    def _unavailable(
        reason: str,
        *,
        cf_mode: Optional[str] = None,
        cf_reason: Optional[str] = None,
        reference_source: Optional[str] = None,
    ) -> Dict[str, Any]:
        result = {
            'analysis_type': 'surprise_gauge',
            'analysis_name': 'Expectation Gauge',
            'variables': [
                {'name': 'p', 'label': 'Conversion rate',
                 'available': False, 'reason': reason},
                {'name': 'completeness', 'label': 'Completeness',
                 'available': False, 'reason': reason},
            ],
            'error': reason,
        }
        if cf_mode is not None:
            result['cf_mode'] = cf_mode
        if cf_reason is not None:
            result['cf_reason'] = cf_reason
        if reference_source is not None:
            result['reference_source'] = reference_source
        return result

    if not graph_data or not target_id:
        return _unavailable('No graph data or target_id')

    # ── Find the edge ───────────────────────────────────────────
    edges = graph_data.get('edges', []) if isinstance(graph_data, dict) else []
    edge = next(
        (e for e in edges
         if str(e.get('uuid') or e.get('id') or '') == str(target_id)),
        None,
    )
    if not edge:
        return _unavailable('Edge not found')

    # ── Scope / temporal mode from DSL ──────────────────────────
    query_dsl = data.get('query_dsl') or data.get('analytics_dsl') or ''
    subj_slice_keys = subj.get('slice_keys') or []
    has_cohort_slice = any('cohort' in str(sk) for sk in subj_slice_keys)
    combined_temporal_dsl = f"{effective_query_dsl} {query_dsl}"
    if has_cohort_slice or 'cohort(' in combined_temporal_dsl:
        is_window = False
    elif 'window(' in combined_temporal_dsl:
        is_window = True
    else:
        is_window = True
    # Surprise gauge is a single-edge surface. In cohort mode it uses the
    # edge-level latency model plus the upstream carrier, matching the
    # conditioned-forecast and cohort-maturity v3 paths. Resolving a
    # path-level latency here would double-count the upstream leg.
    scope = 'edge'
    temporal = 'window' if is_window else 'cohort'

    # ── Resolve model params ────────────────────────────────────
    graph_pref = (graph_data.get('model_source_preference')
                  if isinstance(graph_data, dict) else None)
    resolved = resolve_model_params(
        edge, scope=scope, temporal_mode=temporal, graph_preference=graph_pref,
    )
    if not resolved:
        print("[surprise_gauge] no resolved params or σ≤0")
        return _unavailable('No resolved model params (σ must be > 0)')
    if resolved.latency.sigma <= 0:
        print("[surprise_gauge] no resolved params or σ≤0")
        return _unavailable('No resolved model params (σ must be > 0)')

    # ── Subject must carry snapshot-query fields ────────────────
    if not (
        subj.get('param_id') and subj.get('core_hash')
        and subj.get('anchor_from') and subj.get('anchor_to')
    ):
        print("[surprise_gauge] missing subject fields for snapshot query")
        return _unavailable('Missing subject fields for snapshot query')

    # ── Prepare snapshots/evidence via the shared forecast path ────────
    scenario_id = str(scenario.get('scenario_id', ''))
    combined_temporal_dsl_full = f"{effective_query_dsl} {query_dsl}".strip()
    sg_as_at = parse_asat_from_dsl(combined_temporal_dsl_full)
    context_scope = extract_forecast_context_scope(
        combined_temporal_dsl_full,
        mece_dimensions=data.get('mece_dimensions') or [],
    )
    try:
        preparation = prepare_forecast_subject_group(
            graph_data=graph_data,
            subjects=[subj],
            is_window=is_window,
            log_prefix='[surprise_gauge]',
            as_at=sg_as_at,
            scenario_id=scenario_id,
            context_scope=context_scope,
        )
    except Exception as e:
        print(f"[surprise_gauge] forecast preparation failed: {e}")
        return _unavailable('Snapshot query failed')

    if not preparation.last_edge_id:
        return _unavailable('No resolvable subject edge for gauge')

    # Retrieved-at for display: latest frame's snapshot_date (the FE
    # renders this beside the gauge to date the evidence). Pure display
    # metadata — not part of the gauge maths.
    derivation = (
        preparation.per_edge_results[0].get('derivation_result', {})
        if preparation.per_edge_results
        else {}
    )
    frames = derivation.get('frames', [])
    last_frame = frames[-1] if frames else {}
    retrieved_at = str(last_frame.get('snapshot_date', ''))[:10] or None

    # ── Build the shared scalar bundle (FC + unc epistemic overlay) ──
    cf_compute_extent = _compute_extent_for_scenario(
        display_settings=(
            scenario.get('display_settings')
            or data.get('display_settings')
            or {}
        ),
        visibility_mode='f+e',
        anchor_from=preparation.anchor_from,
        sweep_to=preparation.sweep_to,
        graph_data=graph_data,
        last_edge_id=preparation.last_edge_id,
        forecasting_settings=__import__(
            'runner.forecasting_settings', fromlist=['current_settings'],
        ).current_settings(),
        is_window=is_window,
        query_from_node=preparation.query_from_node or '',
        query_to_node=preparation.query_to_node or '',
        anchor_node=preparation.anchor_node,
    )
    try:
        prepared = prepare_cf_scalar_bundle(
            preparation,
            graph_data=graph_data,
            subjects=[subj],
            is_window=is_window,
            context_scope=context_scope,
            scenario_id=scenario_id,
            as_at=sg_as_at,
            candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
            per_edge_results_by_uuid={},
            compute_extent=cf_compute_extent,
            log_prefix='[surprise_gauge]',
            include_epistemic_overlay=True,
        )
    except Exception as e:
        print(f"[surprise_gauge] bundle preparation failed: {e}")
        return _unavailable('Bundle preparation failed')

    scalars = reduce_cf_scalars(prepared.bundle)

    # ── Compute combined-spread z-scores ────────────────────────
    # z = (needle_mean − dial_mean) / sqrt(needle_sd² + dial_sd²)
    # The denominator floors at 1e-12 to give a defined z under a
    # degenerate prior (e.g. a cohort too young for onset, tight σ → 0):
    # at that point a zero-distance needle reads z = 0 ("no surprise"),
    # any other distance reads as extreme. Doc 55 §3.3.
    def _combined_z(needle_mean: float, needle_sd: float,
                    dial_mean: float, dial_sd: float) -> float:
        denom = math.sqrt(max(needle_sd, 0.0) ** 2 + max(dial_sd, 0.0) ** 2)
        denom = denom if denom > 1e-12 else 1e-12
        return (needle_mean - dial_mean) / denom

    p_needle_mean = float(scalars.fc_terminal_rate_mean or 0.0)
    p_needle_sd = float(scalars.fc_terminal_rate_sd_predictive or 0.0)
    p_dial_mean = float(scalars.unconditioned_terminal_rate_mean_epistemic or 0.0)
    p_dial_sd = float(scalars.unconditioned_terminal_rate_sd_epistemic or 0.0)

    c_needle_mean = float(scalars.fc_frontier_to_terminal_rate_ratio_mean or 0.0)
    c_needle_sd = float(scalars.fc_frontier_to_terminal_rate_ratio_sd_predictive or 0.0)
    c_dial_mean = float(scalars.unconditioned_frontier_to_terminal_cdf_ratio_mean or 0.0)
    c_dial_sd = float(scalars.unconditioned_frontier_to_terminal_cdf_ratio_sd_epistemic or 0.0)

    z_p = _combined_z(p_needle_mean, p_needle_sd, p_dial_mean, p_dial_sd)
    q_p = float(norm_cdf(z_p))
    z_c = _combined_z(c_needle_mean, c_needle_sd, c_dial_mean, c_dial_sd)
    q_c = float(norm_cdf(z_c))

    total_n = int(scalars.strict_empirical_terminal_evidence_n or 0)
    total_k = int(scalars.strict_empirical_terminal_evidence_k or 0)
    obs_rate = float(total_k) / float(total_n) if total_n > 0 else 0.0
    combined_sd_p = math.sqrt(p_needle_sd ** 2 + p_dial_sd ** 2)
    combined_sd_c = math.sqrt(c_needle_sd ** 2 + c_dial_sd ** 2)

    cf_mode_value = prepared.bundle.cf_mode or 'sweep'
    cf_reason_value: Optional[str] = prepared.bundle.cf_reason

    variables: List[Dict[str, Any]] = [
        {
            'name': 'p',
            'label': 'Conversion rate',
            'quantile': round(q_p, 6),
            'sigma': round(z_p, 3),
            # Gauge needle/dial: FC posterior vs unconditioned prior.
            'observed': round(p_needle_mean, 6),
            'expected': round(p_dial_mean, 6),
            'posterior_sd': round(p_dial_sd, 6),
            'combined_sd': round(combined_sd_p, 6),
            # Raw evidence (display context — not consumed by the maths).
            'completeness': round(c_dial_mean, 4),
            'evidence_n': total_n,
            'evidence_k': total_k,
            'evidence_retrieved_at': _format_retrieved_at_for_display(retrieved_at),
            'zone': classify_zone(q_p),
            'available': True,
        },
        {
            'name': 'completeness',
            'label': 'Completeness',
            'quantile': round(q_c, 6),
            'sigma': round(z_c, 3),
            'observed': round(c_needle_mean, 6),
            'expected': round(c_dial_mean, 6),
            'posterior_sd': round(c_dial_sd, 6),
            'combined_sd': round(combined_sd_c, 6),
            'unconditioned': round(c_dial_mean, 6),
            'unconditioned_sd': round(c_dial_sd, 6),
            'conditioned': round(c_needle_mean, 6),
            'conditioned_sd': round(c_needle_sd, 6),
            'evidence_retrieved_at': _format_retrieved_at_for_display(retrieved_at),
            'zone': classify_zone(q_c),
            'available': True,
        },
    ]

    result: Dict[str, Any] = {
        'analysis_type': 'surprise_gauge',
        'analysis_name': 'Expectation Gauge',
        'variables': variables,
        'reference_source': resolved.source,
        'cf_mode': cf_mode_value,
    }
    if cf_reason_value is not None:
        result['cf_reason'] = cf_reason_value

    print(f"[surprise_gauge] source={resolved.source} cf_mode={cf_mode_value} "
          f"p: needle={p_needle_mean:.4f}±{p_needle_sd:.4f} "
          f"dial={p_dial_mean:.4f}±{p_dial_sd:.4f} z={z_p:.3f} "
          f"c: needle={c_needle_mean:.4f}±{c_needle_sd:.4f} "
          f"dial={c_dial_mean:.4f}±{c_dial_sd:.4f} z={z_c:.3f}")

    return result


def handle_stats_enhance(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle stats-enhance endpoint.
    
    Args:
        data: Request body containing:
            - raw: Raw aggregation data (required)
            - method: Enhancement method (required)
    
    Returns:
        Enhanced aggregation response
    """
    raw_data = data.get('raw')
    method = data.get('method')
    
    if not raw_data:
        raise ValueError("Missing 'raw' field")
    if not method:
        raise ValueError("Missing 'method' field")
    
    from stats_enhancement import enhance_aggregation
    
    enhanced = enhance_aggregation(raw_data, method)
    
    return {
        **enhanced,
        "success": True
    }


def handle_parse_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle parse-query endpoint.
    
    Args:
        data: Request body containing:
            - query: Query DSL string (required)
    
    Returns:
        Parsed query structure
    """
    query_str = data.get('query')
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    
    from query_dsl import parse_query_strict, validate_query
    
    # Validate (require endpoints for data retrieval)
    is_valid, error = validate_query(query_str, require_endpoints=True)
    if not is_valid:
        raise ValueError(f"Invalid query: {error}")
    
    # Parse (strict - requires from/to for data retrieval)
    parsed = parse_query_strict(query_str)
    
    # Return structured response
    return {
        "query": query_str,
        "parsed": {
            "from_node": parsed.from_node,
            "to_node": parsed.to_node,
            "exclude": parsed.exclude,
            "visited": parsed.visited,
            "visited_any": getattr(parsed, "visited_any", []),
            "context": [{"key": c.key, "value": c.value} for c in parsed.context],
            "cases": [{"key": c.key, "value": c.value} for c in parsed.cases]
        },
        "valid": True,
        "reconstructed": parsed.raw
    }


@maybe_profile("runner-analyze")
def handle_runner_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle runner/analyze endpoint.

    Args:
        data: Request body containing EITHER:
            Scenario-based analysis (with optional per-scenario snapshot_subjects):
                - scenarios: List of scenario data (required)
                  Each scenario may carry snapshot_subjects[] (per-scenario DB coordinates)
                - query_dsl: DSL query string (optional)
                - analysis_type: Override analysis type (optional)

            Legacy snapshot-based analysis:
                - snapshot_query: {param_id, core_hash, anchor_from, anchor_to, slice_keys?}
                - analysis_type: 'lag_histogram' | 'daily_conversions'

            Optional on any shape:
                - no_cache: bool — when true, bypass the snapshot_service TTL cache
                  for every DB read made by this request. Works identically on dev
                  and Vercel (does not depend on URL parsing / middleware).

    Returns:
        Analysis results
    """
    from runner.forecasting_settings import settings_from_dict, use_request_settings
    settings = settings_from_dict(data.get('forecasting_settings'))
    # Body-level cache bypass — works on every transport (dev FastAPI, Vercel
    # BaseHTTPRequestHandler, direct Python callers). The dev middleware already
    # handles ?no-cache=1 at the URL level; this covers the request body path.
    with use_request_settings(settings):
        if data.get('no_cache'):
            from snapshot_service import cache_bypass_ctx
            with cache_bypass_ctx():
                return _handle_runner_analyze_impl(data)
        return _handle_runner_analyze_impl(data)


def _handle_runner_analyze_impl(data: Dict[str, Any]) -> Dict[str, Any]:
    # ── Read top-level fields ────────────────────────────────────────
    # analytics_dsl (new): the subject — from(x).to(y), constant across scenarios.
    # query_dsl (deprecated): falls back for old clients that haven't migrated.
    analytics_dsl = data.get('analytics_dsl') or data.get('query_dsl') or ''
    analysis_type = data.get('analysis_type', '')

    # ── Route to snapshot handler when analysis type needs snapshot DB ──
    from analysis_subject_resolution import ANALYSIS_TYPE_SCOPE_RULES
    is_snapshot_type = analysis_type in ANALYSIS_TYPE_SCOPE_RULES
    # Snapshot path requires: (a) a snapshot-aware type AND (b) either
    # top-level analytics_dsl or per-scenario snapshot_subjects (legacy).
    has_snapshot_data = bool(analytics_dsl) or any(
        s.get('snapshot_subjects') for s in data.get('scenarios', [])
    )
    if is_snapshot_type and has_snapshot_data:
        # cohort_maturity → v3 engine (doc 29 Phase 5)
        if analysis_type in ('cohort_maturity', 'cohort_maturity_v3'):
            print("[v3-router] DISPATCHING TO V3 HANDLER")
            return _handle_cohort_maturity_v3(data)
        if analysis_type == 'daily_conversions':
            return _handle_daily_conversions(data)
        return _handle_snapshot_analyze_subjects(data)

    # Legacy path: snapshot_query (single subject)
    snapshot_query = data.get('snapshot_query')
    if snapshot_query:
        return _handle_snapshot_analyze_legacy(data)

    # ── Standard runner path (graph-only analysis types) ───────────
    from runner import analyze
    from runner.types import AnalysisRequest, ScenarioData

    if 'scenarios' not in data or not data['scenarios']:
        raise ValueError("Missing 'scenarios' field")

    scenarios = [
        ScenarioData(
            scenario_id=s.get('scenario_id', f'scenario_{i}'),
            name=s.get('name'),
            colour=s.get('colour'),
            visibility_mode=s.get('visibility_mode', 'f+e'),
            graph=s.get('graph', {}),
            effective_query_dsl=s.get('effective_query_dsl'),
            candidate_regimes_by_edge=s.get('candidate_regimes_by_edge'),
        )
        for i, s in enumerate(data['scenarios'])
    ]

    request_obj = AnalysisRequest(
        scenarios=scenarios,
        analytics_dsl=analytics_dsl,
        # Backward compat shim: standard runner reads query_dsl for
        # subject parsing. Set it to analytics_dsl until Phase 3
        # updates analyzer.py to read analytics_dsl directly.
        query_dsl=analytics_dsl,
        analysis_type=analysis_type,
        mece_dimensions=data.get('mece_dimensions'),
    )

    response = analyze(request_obj)
    return response.model_dump()


# _make_envelope_aware_upstream_fetcher and _fetch_upstream_observations
# were relocated to runner/forecast_preparation.py (73q Phase 4) so the
# shared CF analysis boundary (runner/cf_analysis.py) can import them
# from the preparation layer without a cycle back through api_handlers.
# The two CF handlers below import them where used.
#
# Span/calc scoping (the former ``_compute_axis_tau_max`` policy blend) is
# now perimeter-owned per ``docs/current/cohort-maturity-render-calc-policy.md``:
# each handler picks ``compute_extent`` via the helper below and passes it
# into the shared bundle boundary, which exposes the latent ``saturation_τ``
# and the projection horizon (= ``min(compute_extent, saturation_τ)``)
# back on the bundle for the handler to use for chart axis / pad-out.


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

    Used by ``_compute_extent_for_scenario`` to size the request horizon
    when the rightmost edge's stored ``path_t95`` doesn't match the actual
    subject span:

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
    ``_compute_extent_for_scenario`` for compute_extent itself). The kernel
    is composed once with no Bayesian draws — this is a budget read, not
    the projection itself.
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


def _compute_extent_for_scenario(
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
    """Pick the engine boundary ``compute_extent`` for one scenario per the
    span/calc scoping policy in
    ``docs/current/cohort-maturity-render-calc-policy.md``.

    The three cases:

    - **Manual** (``display_settings['tau_extent']`` is a positive number,
      not the literal ``'auto'`` / ``'Auto'``): ``compute_extent = user_axis``.
      The chart axis matches and the engine works only what the user asked
      for.
    - **Auto, F or F+E mode**: the t95 of the convolved subject span
      ``source → query_to`` (composed via ``compose_span_kernel``), scaled
      by ``forecasting_settings.snapshot_observation_path_t95_multiplier``
      (default 1.5). The composition source is the same node the engine
      uses as the request CDF root:

      * **Window** — ``query_from_node``.
      * **Cohort** — ``anchor_node`` (the effective anchor for the
        request, incl. DSL overrides via ``cohort(<anchor>, …)``). The
        rightmost edge's stored ``path_t95`` is anchored at the graph
        default, so composing from the effective anchor handles default
        and DSL-overridden anchors uniformly.

      Fallbacks (in order): target edge ``t95`` ×
      ``snapshot_observation_t95_multiplier`` (default 2.0); then
      ``tau_future_max`` (= ``(sweep_to - anchor_from).days``).
    - **Auto, E only mode**: ``compute_extent = tau_future_max``. E-mode
      reads strict evidence only; saturation discovery is not needed.

    ``compute_extent`` must be ≥ 0; ``(sweep_to - anchor_from).days`` is
    used as a final floor so the engine has at least the calendar reach
    to project against.
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

    # Auto, E-only: just enough to cover the calendar reach. The engine
    # composes only to its window; no saturation read needed.
    if visibility_mode == 'e':
        return max(tau_future_max, 0)

    # Auto, F / F+E: compose ``source → query_to`` and use its t95 with
    # the path-headroom multiplier. The composition source is the request
    # CDF root — ``query_from`` for window, ``anchor`` for cohort. One
    # rule for every hop count and every (default / overridden) anchor.
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

    # Fallback: own-edge t95 on the target edge when composition failed
    # (missing source / target, no path, or no per-edge latency fit).
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


def _apply_temporal_regime_selection(
    rows: List[Dict[str, Any]],
    subj: Dict[str, Any],
    is_window: bool,
) -> List[Dict[str, Any]]:
    """Compatibility wrapper for the shared forecast preparation helper."""
    from runner.forecast_preparation import apply_temporal_regime_selection

    return apply_temporal_regime_selection(rows, subj, is_window)


def _apply_snapshot_regime_selection(
    rows: List[Dict[str, Any]],
    subj: Dict[str, Any],
    *,
    mece_dimensions: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Filter broad snapshot reads to the chosen candidate regime family."""
    from snapshot_regime_selection import (
        CandidateRegime,
        select_regime_rows,
        validate_mece_for_aggregation,
    )

    cr_raw = subj.get('candidate_regimes')
    if not cr_raw or not isinstance(cr_raw, list):
        return rows

    regimes = [
        CandidateRegime(
            core_hash=r.get('core_hash', ''),
            equivalent_hashes=[
                e.get('core_hash', '') if isinstance(e, dict) else str(e)
                for e in (r.get('equivalent_hashes') or [])
            ],
        )
        for r in cr_raw if isinstance(r, dict) and r.get('core_hash')
    ]
    if not regimes:
        return rows

    selection = select_regime_rows(rows, regimes)
    if mece_dimensions and selection.rows:
        non_mece = validate_mece_for_aggregation(selection.rows, mece_dimensions)
        if non_mece:
            print(f"[regime_selection] WARNING: non-MECE dimensions in rows: {non_mece} "
                  f"(subject={subj.get('subject_id', '?')}). Aggregation over these dimensions may be unsafe.")
    return selection.rows


def _handle_cohort_maturity_v3(data: Dict[str, Any]) -> Dict[str, Any]:
    """Doc 29 Phase 5: cohort maturity consuming the forecast engine.

    Reuses v2's subject resolution and evidence framing pipeline, then
    calls cohort_forecast_v3.compute_cohort_maturity_rows_v3 which
    delegates completeness/carrier/model resolution to the engine.
    """
    from runner.forecast_preparation import (
        extract_forecast_context_scope,
        prepare_forecast_subject_group,
        resolve_forecast_subjects,
    )
    from runner.forecasting_settings import settings_from_dict

    analysis_type = 'cohort_maturity'
    scenarios = data.get('scenarios', [])
    top_analytics_dsl = data.get('analytics_dsl', '')
    display_settings = data.get('display_settings') or {}
    forecasting_settings = settings_from_dict(data.get('forecasting_settings'))
    _emit_diagnostics = bool(data.get('_diagnostics'))
    _diag: Dict[str, Any] = {} if _emit_diagnostics else {}

    # Per-scenario tracking for the multi-scenario chart-axis reduction +
    # last-row pad-out at end (policy doc §"Multiple scenarios.cohort_maturity").
    per_scenario_extents: List[Dict[str, Any]] = []

    per_scenario_results: List[Dict[str, Any]] = []

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        graph_data = scenario.get('graph') or {}

        # ── Resolve subjects from DSL (shared with v2) ───────────────
        subjects = resolve_forecast_subjects(
            graph_data=graph_data,
            scenario=scenario,
            top_analytics_dsl=top_analytics_dsl,
            path_analysis_type=analysis_type,
            whole_graph_analysis_type=None,
            log_prefix='[v3]',
        )
        if not subjects:
            per_scenario_results.append({
                "scenario_id": scenario_id, "success": True,
                "subjects": [], "rows_analysed": 0,
            })
            continue

        temporal_dsl = scenario.get('effective_query_dsl', '')
        query_dsl = data.get('query_dsl') or top_analytics_dsl or ''
        is_window = 'window(' in temporal_dsl or 'window(' in query_dsl
        context_scope = extract_forecast_context_scope(
            temporal_dsl,
            mece_dimensions=data.get('mece_dimensions') or [],
        )

        from runner.forecast_runtime import parse_asat_from_dsl as _parse_asat_for_envelope
        _envelope_as_at = _parse_asat_for_envelope(temporal_dsl)
        preparation = prepare_forecast_subject_group(
            graph_data=graph_data,
            subjects=subjects,
            is_window=is_window,
            log_prefix='[v3]',
            as_at=_envelope_as_at,
            scenario_id=scenario_id,
            context_scope=context_scope,
        )
        query_from_node = preparation.query_from_node or None
        query_to_node = preparation.query_to_node or None
        anchor_node = preparation.anchor_node
        per_edge_results = preparation.per_edge_results
        total_rows = preparation.total_rows
        composed_frames = preparation.composed_frames
        last_edge_id = preparation.last_edge_id
        anchor_from_str = preparation.anchor_from
        sweep_to_final = preparation.sweep_to
        last_regime_diag = (
            preparation.regime_diagnostics[-1]
            if preparation.regime_diagnostics
            else {}
        )
        if _emit_diagnostics and last_regime_diag:
            _diag['regime_selection'] = last_regime_diag

        band_raw = display_settings.get('bayes_band_level', '90')
        try:
            band_level = float(band_raw) / 100.0 if band_raw not in ('off', 'blend') else 0.90
        except (ValueError, TypeError):
            band_level = 0.90

        # Build the one shared CF projection bundle and reduce it with the
        # registry-selected reducer (tau reducer for cohort_maturity). The
        # preparation→bundle boundary lives in runner.cf_analysis; this
        # handler is a thin client. find_edge_by_id / resolve_model_params
        # remain for the synthetic-future-frame tail below.
        from runner.forecast_runtime import (
            find_edge_by_id,
            serialise_rate_evidence_provenance,
        )
        from runner.model_resolver import resolve_model_params
        from runner.cf_analysis import prepare_cf_projection_bundle, reducer_for

        # Per-scenario visibility mode drives the compute_extent policy in
        # Auto. Default 'f+e' matches the snapshot scenario default and the
        # v1 handler's read (api_handlers.py:683 for `visibility_mode`).
        visibility_mode = scenario.get('visibility_mode', 'f+e')

        maturity_rows = []
        prepared = None
        compute_extent: Optional[int] = None
        saturation_tau: Optional[int] = None
        if composed_frames and last_edge_id:
            compute_extent = _compute_extent_for_scenario(
                display_settings=display_settings,
                visibility_mode=visibility_mode,
                anchor_from=anchor_from_str,
                sweep_to=sweep_to_final,
                graph_data=graph_data,
                last_edge_id=last_edge_id,
                forecasting_settings=forecasting_settings,
                is_window=is_window,
                query_from_node=query_from_node,
                query_to_node=query_to_node,
                anchor_node=anchor_node,
            )
            prepared = prepare_cf_projection_bundle(
                preparation,
                graph_data=graph_data,
                subjects=subjects,
                is_window=is_window,
                context_scope=context_scope,
                scenario_id=scenario_id,
                as_at=_envelope_as_at,
                candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                per_edge_results_by_uuid={},
                compute_extent=compute_extent,
                include_epistemic_overlay=True,
                use_prepared_resolved=True,
                show_model_curve=bool(display_settings.get('show_model_curve')),
                log_prefix='[v3]',
            )
            saturation_tau = int(prepared.bundle.saturation_tau)
            maturity_rows = reducer_for('cohort_maturity')(
                prepared.bundle,
                band_level=band_level,
                sweep_to=prepared.sweep_to,
                emit_diagnostics=_emit_diagnostics,
            )
            if _emit_diagnostics and prepared.runtime_bundle_diag is not None:
                _diag['rate_evidence_provenance'] = serialise_rate_evidence_provenance(
                    prepared.runtime_bundle_diag
                )
        # ``axis_tau_max`` survives as the chart-extent hand-off for the
        # synthetic-future-frame tail below (Forecast-tail synthesis). Under
        # the new policy it is ``compute_extent`` for Manual and
        # ``saturation_τ`` (single-scenario) for Auto / F+E — these coincide
        # with the bundle's ``max_tau`` in the single-scenario case; the
        # multi-scenario reducer below revisits this for the pad-out.
        axis_tau_max = compute_extent

        print(f"[v3] compute_cohort_maturity_rows returned {len(maturity_rows)} rows")

        if _emit_diagnostics and maturity_rows:
            _sel_proj = maturity_rows[0].pop('_selected_cohort_projection', None)
            if _sel_proj is not None:
                _diag['selected_cohort_projection'] = _sel_proj

        # ── Model curve generation (FE overlay contract) ─────────────
        # The FE chart builder reads model_curve, model_curve_params,
        # source_model_curves, and promoted_source from the result to
        # render CDF overlay curves.
        #
        # Single-hop: resolve from the target edge (as before).
        # Multi-hop:  use the convolved span kernel so the CDF and p
        #             reflect the full x→y path, not the last edge.
        subject_result: Dict[str, Any] = {
            'analysis_type': analysis_type,
            'maturity_rows': maturity_rows,
            'frames': composed_frames,
            'span_kernel': None,
        }
        # Promoted model source label for FE chart hint and outside-in
        # acceptance. The resolved source is computed once per request by
        # `prepare_forecast_runtime_inputs` from the graph-level
        # preference and the available source curves; surface it on the
        # subject result so the FE normaliser can lift it to the
        # AnalysisResult.
        _resolved_for_response = getattr(prepared, 'resolved_override', None)
        _promoted_source = getattr(_resolved_for_response, 'source', None)
        if _promoted_source:
            subject_result['promoted_source'] = _promoted_source
        if maturity_rows:
            _row_cf_mode = maturity_rows[0].get('_cf_mode')
            _row_cf_reason = maturity_rows[0].get('_cf_reason')
            if _row_cf_mode is not None:
                subject_result['cf_mode'] = _row_cf_mode
            if _row_cf_reason is not None:
                subject_result['cf_reason'] = _row_cf_reason
            _row_runtime_provenance = maturity_rows[0].pop(
                '_runtime_provenance', None
            )
            if _row_runtime_provenance is not None:
                subject_result['runtime_provenance'] = _row_runtime_provenance
                if _emit_diagnostics:
                    _diag['primitive_runtime_provenance'] = _row_runtime_provenance

        # Model-curve fields live on every row (model_curve_midpoint /
        # model_curve_fan_* / model_curve_bands). The FE chart builder
        # reads them directly from maturity_rows when show_model_curve
        # is on; no subject-level mirror needed.

        # ── Record per-scenario data for the post-loop multi-scenario
        # chart-axis reduction + last-row pad-out + synthetic-frames tail
        # emit. Synthetic frames are deferred so they see the combined
        # chart axis rather than each scenario's own natural extent.
        from datetime import date as _date_for_extents
        try:
            _af_d = _date_for_extents.fromisoformat(str(anchor_from_str)[:10])
            _st_d = _date_for_extents.fromisoformat(str(sweep_to_final)[:10])
            tau_future_max_s = max(int((_st_d - _af_d).days), 0)
        except (ValueError, TypeError):
            tau_future_max_s = 0
        per_scenario_extents.append({
            'scenario_id': scenario_id,
            'subject_result': subject_result,
            'maturity_rows': maturity_rows,
            'visibility_mode': visibility_mode,
            'compute_extent': compute_extent,
            'saturation_tau': saturation_tau,
            'tau_future_max': tau_future_max_s,
            'graph_data': graph_data,
            'last_edge_id': last_edge_id,
            'is_window': is_window,
            'anchor_to': subjects[0].get('anchor_to', '') if subjects else '',
            'composed_frames': composed_frames,
            'frontier_taus': (
                list(prepared.bundle.selected_retrieval_frontier.paired_frontier_by_anchor.values())
                if prepared is not None else []
            ),
        })

        # ── Build response (same shape as v1/v2) ─────────────────────
        per_scenario_results.append({
            "scenario_id": scenario_id,
            "success": True,
            "subjects": [{
                "subject_id": f"v3:{query_from_node}:{query_to_node}",
                "success": True,
                "result": subject_result,
                "rows_analysed": total_rows,
                "_debug_regime": {
                    "pre_count": last_regime_diag.get('pre_rows'),
                    "post_count": last_regime_diag.get('post_rows'),
                    "n_candidates": last_regime_diag.get('n_candidates'),
                    "is_window": last_regime_diag.get('subject_is_window', is_window),
                },
            }],
            "rows_analysed": total_rows,
        })

    # ── Multi-scenario chart axis + last-row pad-out + synthetic-frames
    # tail (policy doc §"Multiple scenarios.cohort_maturity"). Shared τ
    # axis across scenarios: ``chart_axis_τ_combined`` is the user_axis in
    # Manual, otherwise ``max(natural_extent_s)`` across scenarios with
    # ``natural_extent_s = saturation_τ_s`` for F/F+E and ``tau_future_max_s``
    # for E. Each F/F+E scenario's rows are extended to
    # ``chart_axis_τ_combined`` by last-row replay (exact: the CDF is flat
    # past saturation). E-mode scenarios are NOT padded — their curve ends
    # naturally at the evidence frontier; padding past it would misrepresent
    # "data we don't have" as "data that's saturated".
    tau_extent_raw = display_settings.get('tau_extent')
    _is_manual = False
    user_axis: Optional[int] = None
    if tau_extent_raw and str(tau_extent_raw) not in ('auto', 'Auto'):
        try:
            user_axis = int(math.ceil(float(tau_extent_raw)))
            if user_axis > 0:
                _is_manual = True
        except (ValueError, TypeError):
            pass
    if _is_manual:
        chart_axis_tau_combined = int(user_axis)
    else:
        _natural_extents: List[int] = []
        for entry in per_scenario_extents:
            if entry['visibility_mode'] == 'e':
                _natural_extents.append(int(entry['tau_future_max']))
            elif entry['saturation_tau'] is not None:
                _natural_extents.append(int(entry['saturation_tau']))
            else:
                # No bundle was prepared for this scenario (no edge / frames);
                # fall back to the calendar reach so its axis contribution is
                # well-defined.
                _natural_extents.append(int(entry['tau_future_max']))
        chart_axis_tau_combined = max(_natural_extents) if _natural_extents else 0

    for entry in per_scenario_extents:
        rows = entry['maturity_rows']
        mode = entry['visibility_mode']
        # Pad cumulative evidence through the selected evidence frontier:
        # counts that have happened cannot unhappen, but applicability must
        # be recomputed for the padded tau instead of copied wholesale.
        frontier_taus = [
            int(t) for t in (entry.get('frontier_taus') or [])
            if isinstance(t, (int, float))
        ]
        evidence_pad_limit = (
            min(int(chart_axis_tau_combined), max(frontier_taus))
            if frontier_taus else -1
        )
        if rows and len(rows) - 1 < evidence_pad_limit:
            last = rows[-1]
            last_tau = int(last.get('tau_days', len(rows) - 1))
            for _tau in range(last_tau + 1, evidence_pad_limit + 1):
                replay = dict(last)
                replay['tau_days'] = _tau
                if frontier_taus:
                    applicable = sum(1 for t in frontier_taus if _tau <= t)
                    coverage = applicable / float(len(frontier_taus))
                    replay['coverage'] = coverage
                    replay['cohorts_covered_base'] = applicable
                    replay['cohorts_covered_projected'] = applicable
                rows.append(replay)

        # Pad F / F+E scenarios with last-row replay up to the combined
        # chart axis. E-mode stops at the evidence frontier.
        if mode != 'e' and rows and len(rows) - 1 < chart_axis_tau_combined:
            last = rows[-1]
            last_tau = int(last.get('tau_days', len(rows) - 1))
            for _tau in range(last_tau + 1, chart_axis_tau_combined + 1):
                replay = dict(last)
                replay['tau_days'] = _tau
                rows.append(replay)

        # Synthetic forecast-tail frames for the FE composite chart.
        # ``tau_extent`` is the chart axis the FE will render to.
        if entry['composed_frames'] and entry['last_edge_id']:
            edge = find_edge_by_id(entry['graph_data'], entry['last_edge_id'])
            if edge:
                scope = 'edge' if entry['is_window'] else 'path'
                temporal = 'window' if entry['is_window'] else 'cohort'
                _graph_pref = entry['graph_data'].get('model_source_preference')
                ft_resolved = resolve_model_params(
                    edge, scope=scope, temporal_mode=temporal,
                    graph_preference=_graph_pref,
                )
                if ft_resolved and ft_resolved.latency.sigma > 0 and entry['anchor_to']:
                    _append_synthetic_frames_impl({
                        'result': entry['subject_result'],
                        'mu': ft_resolved.latency.mu,
                        'sigma': ft_resolved.latency.sigma,
                        'onset_delta_days': ft_resolved.latency.onset_delta_days,
                        'forecast_mean': ft_resolved.p_mean,
                        'anchor_to': entry['anchor_to'],
                        'tau_extent': chart_axis_tau_combined,
                    })

    # Simplify response for single-scenario / single-subject cases
    # (must match _handle_snapshot_analyze_subjects flattening)
    if len(per_scenario_results) == 1:
        single_scenario = per_scenario_results[0]
        subjects_list = single_scenario.get("subjects", [])
        if len(subjects_list) == 1:
            single = subjects_list[0]
            resp = {
                "success": single.get("success", False),
                "result": single.get("result"),
                "error": single.get("error"),
                "rows_analysed": single.get("rows_analysed", 0),
                "subject_id": single.get("subject_id"),
                "scenario_id": single_scenario.get("scenario_id"),
            }
            if _diag:
                resp["_diagnostics"] = _diag
            return resp
        return {
            "success": single_scenario.get("success", False),
            "scenario_id": single_scenario.get("scenario_id"),
            "subjects": subjects_list,
            "rows_analysed": single_scenario.get("rows_analysed", 0),
        }
    return {"success": True, "scenarios": per_scenario_results}


def _handle_daily_conversions(data: Dict[str, Any]) -> Dict[str, Any]:
    """Daily conversions on the shared CF runtime (73q Phase 4).

    A client of the same preparation→bundle boundary cohort_maturity uses:
    admit shared forecast evidence → build the one shared
    ``CFProjectionBundle`` → reduce it with the registry-selected date
    reducer. The observed ``data`` / ``cohort_y_at_age`` /
    ``total_conversions`` / ``date_range`` and the observed ``x`` / ``y`` /
    ``rate`` per Cohort stay owned by ``derive_daily_conversions`` over the
    shared admitted rows — the SAME asat-bounded rows the bundle is built
    from, so observed and forecast cannot diverge on admission frontier (the
    bundle is a Cohort×tau projection, not the calendar-delta observed
    series) — and the date reducer joins each observed row to its Cohort by
    ``anchor_day``. Daily has no bespoke pre-reducer admission: no second
    ``query_snapshots`` fetch, no daily-specific read mode, no separate
    regime selection. See single-evidence-admission-binding plan Stage 2.
    """
    from runner.daily_conversions_derivation import derive_daily_conversions
    from runner.forecast_admission import (
        admit_forecast_evidence,
        admitted_rows_for_target,
    )
    from runner.forecast_preparation import extract_forecast_context_scope
    from runner.forecast_runtime import (
        parse_asat_from_dsl,
        serialise_rate_evidence_provenance,
    )
    from runner.cf_analysis import prepare_cf_projection_bundle, reducer_for
    from runner.forecasting_settings import settings_from_dict

    scenarios = data.get('scenarios', [])
    top_analytics_dsl = data.get('analytics_dsl', '')
    display_settings = data.get('display_settings') or {}
    mece_dimensions = data.get('mece_dimensions') or []
    forecasting_settings = settings_from_dict(data.get('forecasting_settings'))
    _emit_diagnostics = bool(data.get('_diagnostics'))
    _diag: Dict[str, Any] = {} if _emit_diagnostics else {}

    per_scenario_results: List[Dict[str, Any]] = []

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        graph_data = scenario.get('graph') or {}

        query_dsl = data.get('query_dsl') or top_analytics_dsl or ''

        # Shared forecast admission — the same cohort-maturity evidence binder
        # cohort_maturity uses. One asat-bounded admitted-row set feeds BOTH
        # the observed series and the CF projection bundle; daily carries no
        # bespoke pre-reducer admission of its own.
        preparation = admit_forecast_evidence(
            graph_data=graph_data,
            scenario=scenario,
            top_analytics_dsl=top_analytics_dsl,
            query_dsl=query_dsl,
            mece_dimensions=mece_dimensions,
            log_prefix='[daily_conv]',
        )
        if preparation is None:
            per_scenario_results.append({
                "scenario_id": scenario_id, "success": True,
                "subjects": [], "rows_analysed": 0,
            })
            continue

        temporal_dsl = scenario.get('effective_query_dsl', '')
        is_window = 'window(' in temporal_dsl or 'window(' in query_dsl
        context_scope = extract_forecast_context_scope(
            temporal_dsl, mece_dimensions=mece_dimensions,
        )
        _as_at = parse_asat_from_dsl(temporal_dsl)
        subjects = [pe['subject'] for pe in preparation.per_edge_results]

        # Observed series: the shared admitted rows for the target edge,
        # reduced by derive_daily_conversions. These are the SAME rows the CF
        # projection bundle is built from — observed and forecast can no longer
        # diverge on admission frontier. Owns the calendar `data` series,
        # per-Cohort observed x/y/rate, cohort_y_at_age, totals, date_range.
        admitted_rows = admitted_rows_for_target(preparation)
        observed = derive_daily_conversions(admitted_rows)
        observed['date_range'] = {
            'from': _format_retrieved_at_for_display(preparation.anchor_from),
            'to': _format_retrieved_at_for_display(preparation.anchor_to),
        }

        # Forecast enrichment: the date reducer over the shared bundle. No
        # edge resolved → no projection; the observed series stands alone.
        if preparation.last_edge_id:
            visibility_mode = scenario.get('visibility_mode', 'f+e')
            compute_extent = _compute_extent_for_scenario(
                display_settings=display_settings,
                visibility_mode=visibility_mode,
                anchor_from=preparation.anchor_from,
                sweep_to=preparation.sweep_to,
                graph_data=graph_data,
                last_edge_id=preparation.last_edge_id,
                forecasting_settings=forecasting_settings,
                is_window=is_window,
                query_from_node=preparation.query_from_node or None,
                query_to_node=preparation.query_to_node or None,
                anchor_node=preparation.anchor_node,
            )
            prepared = prepare_cf_projection_bundle(
                preparation,
                graph_data=graph_data,
                subjects=subjects,
                is_window=is_window,
                context_scope=context_scope,
                scenario_id=scenario_id,
                as_at=_as_at,
                candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                per_edge_results_by_uuid={},
                compute_extent=compute_extent,
                include_epistemic_overlay=False,
                use_prepared_resolved=False,
                show_model_curve=False,
                log_prefix='[daily_conv]',
            )
            result = reducer_for('daily_conversions')(prepared.bundle, observed)
            if _emit_diagnostics and prepared.runtime_bundle_diag is not None:
                _diag['rate_evidence_provenance'] = serialise_rate_evidence_provenance(
                    prepared.runtime_bundle_diag
                )
        else:
            result = observed

        per_scenario_results.append({
            "scenario_id": scenario_id,
            "success": True,
            "subjects": [{
                "subject_id": f"daily_conv:{preparation.query_from_node}:{preparation.query_to_node}",
                "success": True,
                "result": result,
                "rows_analysed": len(admitted_rows),
            }],
            "rows_analysed": len(admitted_rows),
        })

    # Flatten single-scenario / single-subject (matches the other handlers).
    if len(per_scenario_results) == 1:
        single_scenario = per_scenario_results[0]
        subjects_list = single_scenario.get("subjects", [])
        if len(subjects_list) == 1:
            single = subjects_list[0]
            resp = {
                "success": single.get("success", False),
                "result": single.get("result"),
                "error": single.get("error"),
                "rows_analysed": single.get("rows_analysed", 0),
                "subject_id": single.get("subject_id"),
                "scenario_id": single_scenario.get("scenario_id"),
            }
            if _diag:
                resp["_diagnostics"] = _diag
            return resp
        return {
            "success": single_scenario.get("success", False),
            "scenario_id": single_scenario.get("scenario_id"),
            "subjects": subjects_list,
            "rows_analysed": single_scenario.get("rows_analysed", 0),
        }
    return {"success": True, "scenarios": per_scenario_results}


@maybe_profile("conditioned-forecast")
def handle_conditioned_forecast(data: Dict[str, Any]) -> Dict[str, Any]:
    """Conditioned forecast — graph enrichment endpoint (doc 45).

    SUBSYSTEM GUIDE — When to call this (see docs/current/codebase/
    STATS_SUBSYSTEMS.md §3.4 "BE CF pass"):
      - Analysis runners that need query-scoped, evidence-conditioned
        per-edge scalars (p_mean, p_sd, completeness, completeness_sd)
        SHOULD call this (or its /api/forecast/conditioned endpoint),
        optionally scoped by `analytics_dsl` to a specific path/span.
      - The fetch pipeline calls this as Stage 2 whole-graph enrichment.
    When NOT to call:
      - Do NOT reach into compute_forecast_trajectory directly — it is
        the inner kernel and bypasses the topo-sequencing + upstream-
        carrier coordination this handler performs (doc 47). Calling the
        inner kernel per-edge from an analysis runner loses that
        coordination and produces subtly different numbers on multi-hop
        paths.
    This is the remaining BE enrichment surface: the old analytic topo
    pass has been removed, so this handler owns the evidence-conditioned
    MC-with-IS path.

    Produces per-edge per-scenario scalars (p_mean, p_sd, completeness)
    using the full MC population model with snapshot DB evidence. Same
    data pipeline as cohort_maturity v3, different output format.

    This is NOT an analysis type — it's a graph enrichment endpoint.
    It produces scalars written back to the graph, not chart data.

    The handler runs the v3 pipeline end-to-end (subject resolution →
    DB query → regime selection → derive → compose → v3 row builder)
    and reads p@∞ from the last chart row. This guarantees identical
    numbers to the cohort maturity v3 chart with zero new engine code.
    """
    from runner.forecasting_settings import settings_from_dict, use_request_settings
    _request_settings = settings_from_dict(data.get('forecasting_settings'))
    with use_request_settings(_request_settings):
        return _handle_conditioned_forecast_impl(data)


def _handle_conditioned_forecast_impl(data: Dict[str, Any]) -> Dict[str, Any]:
    import math
    import numpy as _np
    from runner.forecast_preparation import (
        extract_forecast_context_scope,
        prepare_forecast_subject_group,
        resolve_forecast_subjects,
    )

    scenarios = data.get('scenarios', [])
    top_analytics_dsl = data.get('analytics_dsl', '')
    _emit_diagnostics = bool(data.get('_diagnostics'))
    _diag: Dict[str, Any] = {} if _emit_diagnostics else {}

    per_scenario_results: List[Dict[str, Any]] = []

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        graph_data = scenario.get('graph') or {}

        # ── Resolve subjects ────────────────────────────────────────
        # Two modes:
        #   (a) analytics_dsl provided → funnel_path scope (single edge/path)
        #   (b) no analytics_dsl → all_graph_parameters scope (doc 47)
        # Mode (b) is the whole-graph conditioned forecast pass.
        temporal_dsl = scenario.get('effective_query_dsl', '')
        subjects = resolve_forecast_subjects(
            graph_data=graph_data,
            scenario=scenario,
            top_analytics_dsl=top_analytics_dsl,
            path_analysis_type='cohort_maturity',
            whole_graph_analysis_type='conditioned_forecast',
            log_prefix='[forecast]',
            emit_traceback=True,
        )
        if not subjects:
            per_scenario_results.append({
                "scenario_id": scenario_id, "success": True, "edges": [],
            })
            continue

        # ── Whole-graph mode: iterate per-edge ──────────────────────
        # In whole-graph mode (path_role='all'), each subject is an
        # independent edge. Process each one as a single-edge pipeline
        # pass, identical to the v3 chart path with path_role='only'.
        # This guarantees parity with the single-edge reference (doc 47).
        #
        # Edges are processed in topological order so upstream edges
        # are computed before downstream edges. Derivation results are
        # cached and passed to _fetch_upstream_observations so downstream
        # edges get empirical carrier evidence (Tier 2) without re-querying.
        is_whole_graph = any(s.get('path_role') == 'all' for s in subjects)
        if is_whole_graph:
            from runner.forecast_runtime import order_subjects_topologically

            eligible_subjects = order_subjects_topologically(
                graph_data,
                [
                    dict(subject, path_role='only')
                    for subject in subjects
                    if subject.get('core_hash')
                ],
            )
            subject_groups = [[s] for s in eligible_subjects]
        else:
            subject_groups = [subjects]

        query_dsl = data.get('query_dsl') or top_analytics_dsl or ''
        is_window = 'window(' in temporal_dsl or 'window(' in query_dsl
        context_scope = extract_forecast_context_scope(
            temporal_dsl,
            mece_dimensions=data.get('mece_dimensions') or [],
        )

        edge_results: List[Dict[str, Any]] = []
        skipped_edges: List[Dict[str, Any]] = []
        # Running cache of derivation results across edges (whole-graph mode).
        # Key by edge UUID so donor reuse is semantic, not dependent on
        # incidental subject or graph edge-list order.
        all_per_edge_results: Dict[str, Dict[str, Any]] = {}

        from runner.forecast_runtime import parse_asat_from_dsl as _parse_asat_for_cf_envelope
        _cf_envelope_as_at = _parse_asat_for_cf_envelope(temporal_dsl)
        # 73q Phase 5e Step C.2: the CF endpoint owns its own draw count.
        # The override has to cover BOTH the subject-group preparation
        # (which builds the per-request envelope plan with arrival maps
        # sized at the prevailing `current_mc_draws()` — see
        # request_envelope.py:372 / 433 / 511) AND the bundle build that
        # consumes the envelope plan's draws via `compose_primitive_span`.
        # Without this outer wrapper the envelope plan ships at the full
        # default draws while the bundle ships at the reduced count — the
        # broadcast collapses at composition time.
        # The CF endpoint's scalar reducer aggressively collapses dispersion
        # (a Beta-like scalar over the saturation distribution), so the
        # endpoint runs at default_mc_draws / 10. This tracks the
        # prevailing forecast-settings default rather than hard-coding a
        # constant: if the project default S changes, the CF endpoint
        # scales with it.
        import dataclasses as _dc
        from runner.forecasting_settings import (
            current_settings as _cs,
            use_request_settings as _urs,
        )
        _cf_endpoint_mc_draws = max(64, int(_cs().mc_draws) // 10)
        _cf_endpoint_settings = _dc.replace(_cs(), mc_draws=float(_cf_endpoint_mc_draws))
        for subj_group in subject_groups:
            with _urs(_cf_endpoint_settings):
                preparation = prepare_forecast_subject_group(
                    graph_data=graph_data,
                    subjects=subj_group,
                    is_window=is_window,
                    log_prefix='[forecast]',
                    as_at=_cf_envelope_as_at,
                    scenario_id=scenario_id,
                    context_scope=context_scope,
                )
            query_from_node = preparation.query_from_node or None
            query_to_node = preparation.query_to_node or None
            anchor_node = preparation.anchor_node
            if not query_from_node or not query_to_node:
                continue

            per_edge_results = preparation.per_edge_results
            total_rows = preparation.total_rows
            # Cache derivation results for downstream carrier building
            for entry in per_edge_results:
                target_id = (entry.get('subject') or {}).get('target', {}).get('targetId', '')
                if target_id:
                    all_per_edge_results[target_id] = entry

            # No early-exit on total_rows == 0. Let the unified runtime
            # path handle the natural degeneration: zero evidence →
            # prior where a usable prior exists. Class D (no α/β either)
            # is then a genuine empty return, caught by the
            # `if maturity_rows:` check below and routed to
            # skipped_edges there.

            composed_frames = preparation.composed_frames
            last_edge_id = preparation.last_edge_id
            anchor_from_str = preparation.anchor_from
            sweep_to_final = preparation.sweep_to
            display_settings = (
                scenario.get('display_settings')
                or data.get('display_settings')
                or {}
            )
            # Build the one shared CF projection bundle and reduce it with
            # the registry-selected reducer. Whole-graph conditioned
            # forecast reads the same tau reducer as cohort_maturity and
            # extracts per-edge scalars from its last row below. The
            # whole-graph donor cache (all_per_edge_results) is carried as
            # data: the shared boundary seeds it and threads it through the
            # upstream fetcher and candidate builders.
            from runner.forecast_runtime import serialise_rate_evidence_provenance
            from runner.cf_analysis import prepare_cf_scalar_bundle
            from runner.cohort_forecast_v3 import reduce_cf_scalars

            if last_edge_id:
                from runner.forecasting_settings import current_settings as _current_settings
                # CF endpoint is the whole-graph enrichment surface; per
                # the policy doc, visibility_mode is irrelevant here — the
                # endpoint always reads through to saturation (p@∞ requires
                # the plateau). Use the F/F+E branch of the compute_extent
                # policy so the composed CDF reaches plateau even when the
                # FE happens to be in E mode for charting.
                cf_compute_extent = _compute_extent_for_scenario(
                    display_settings=display_settings,
                    visibility_mode='f+e',
                    anchor_from=preparation.anchor_from,
                    sweep_to=preparation.sweep_to,
                    graph_data=graph_data,
                    last_edge_id=last_edge_id,
                    forecasting_settings=_current_settings(),
                    is_window=is_window,
                    query_from_node=query_from_node,
                    query_to_node=query_to_node,
                    anchor_node=anchor_node,
                )
                # 73q Phase 5e Step B/C: scalar-only CF callsite. The CF
                # endpoint builds its own bundle (not the cohort_maturity
                # tau reducer's) and reads every per-edge scalar from the
                # scalar reducer + bundle metadata fields. The bundle
                # build is wrapped in the same ``_cf_endpoint_settings``
                # the upstream ``prepare_forecast_subject_group`` ran
                # under, so the envelope plan and the runtime see the
                # SAME draw count (Step C.2 broadcast fix).
                # ``mc_draws_override`` is therefore None — the outer
                # ``use_request_settings`` block already supplies the
                # CF-endpoint draw count.
                with _urs(_cf_endpoint_settings):
                    prepared = prepare_cf_scalar_bundle(
                        preparation,
                        graph_data=graph_data,
                        subjects=subj_group,
                        is_window=is_window,
                        context_scope=context_scope,
                        scenario_id=scenario_id,
                        as_at=_cf_envelope_as_at,
                        candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                        per_edge_results_by_uuid=all_per_edge_results,
                        compute_extent=cf_compute_extent,
                        log_prefix='[forecast]',
                        mc_draws_override=None,
                        include_epistemic_overlay=True,
                    )
                if _emit_diagnostics and prepared.runtime_bundle_diag is not None:
                    _diag.setdefault('rate_evidence_provenance_by_edge', []).append({
                        'scenario_id': scenario_id,
                        'edge_uuid': last_edge_id,
                        'from_node': query_from_node,
                        'to_node': query_to_node,
                        **serialise_rate_evidence_provenance(prepared.runtime_bundle_diag),
                    })

                bundle = prepared.bundle
                runtime = bundle.runtime
                if runtime.public_moments is None:
                    # Class D — no usable α/β (no Bayes fit, no
                    # parameter-file evidence, no promoted source) AND
                    # no query-scoped snapshot rows. The runtime built
                    # nothing scalar-projectable. See doc 50 §2 Class D
                    # + §3.2.
                    skipped_edges.append({
                        'edge_uuid': last_edge_id,
                        'reason': 'no prior and no evidence',
                    })
                else:
                    # All per-edge scalars come from the scalar reducer
                    # plus bundle metadata; no row scraping. Boundary
                    # mapping only: public response names stay stable
                    # (`p_mean`, `p_sd`, etc.) while the reducer fields are
                    # named for the represented projection quantities.
                    cf_scalars = reduce_cf_scalars(bundle)
                    p_mean = cf_scalars.fc_terminal_rate_mean
                    p_sd = cf_scalars.fc_terminal_rate_sd_predictive
                    p_sd_epistemic = (
                        cf_scalars.conditioned_span_terminal_rate_sd_epistemic
                        if cf_scalars.conditioned_span_terminal_rate_sd_epistemic is not None
                        else p_sd
                    )
                    completeness = cf_scalars.fc_frontier_to_terminal_rate_ratio_mean
                    completeness_sd = cf_scalars.fc_frontier_to_terminal_rate_ratio_sd_predictive
                    evidence_n = cf_scalars.strict_empirical_terminal_evidence_n
                    evidence_k = cf_scalars.strict_empirical_terminal_evidence_k

                    # The four request-level sentinels the row builder
                    # used to attach to row[0] (_attach_cf_row_metadata):
                    # cf_mode/cf_reason live on the bundle already;
                    # `conditioned` is exactly the predicate the row
                    # builder uses at cohort_forecast_v3.py:2397; the
                    # subset-conditioning provenance owner is the same
                    # constant `_attach_cf_row_metadata` writes; and the
                    # role-labelled runtime provenance block comes
                    # straight off the runtime.
                    _conditioned = runtime.public_moments.p_mean is not None
                    _cf_mode = bundle.cf_mode
                    _cf_reason = bundle.cf_reason
                    _cond = {'owner': 'primitive_conditioning'}
                    _runtime_provenance = runtime.project_runtime_provenance()
                    _evidence_provenance = None

                    edge_results.append({
                        'edge_uuid': last_edge_id,
                        'from_node': query_from_node,
                        'to_node': query_to_node,
                        'p_mean': p_mean,
                        'p_sd': p_sd,
                        'p_sd_epistemic': p_sd_epistemic,
                        'completeness': completeness,
                        'completeness_sd': completeness_sd,
                        'evidence_k': evidence_k,
                        'evidence_n': evidence_n,
                        'conditioned': bool(_conditioned),
                        'cf_mode': _cf_mode,
                        'cf_reason': _cf_reason,
                        'tau_max': int(bundle.max_tau),
                        'n_cohorts': preparation.cohorts_analysed,
                        **(
                            {'runtime_provenance': _runtime_provenance}
                            if _runtime_provenance is not None
                            else {}
                        ),
                        **({'conditioning': _cond} if _cond else {}),
                        **(
                            {'evidence_provenance': _evidence_provenance}
                            if _evidence_provenance is not None
                            else {}
                        ),
                    })
                    print(f"[forecast] {scenario_id}: {query_from_node}→{query_to_node} "
                          f"p={p_mean if p_mean is None else f'{p_mean:.4f}'} "
                          f"conditioned={bool(_conditioned)} "
                          f"tau_max={int(bundle.max_tau)} "
                          f"cohorts={preparation.cohorts_analysed} "
                          f"rows={total_rows}")
            else:
                # No last_edge_id resolvable from subject group —
                # malformed subject. Treat as Class D.
                _maybe_uuid = ''
                if subj_group:
                    _maybe_uuid = (subj_group[0].get('target') or {}).get('targetId', '')
                if _maybe_uuid:
                    skipped_edges.append({
                        'edge_uuid': _maybe_uuid,
                        'reason': 'no prior and no evidence',
                    })

        per_scenario_results.append({
            "scenario_id": scenario_id,
            "success": True,
            "edges": edge_results,
            "skipped_edges": skipped_edges,
        })

    resp = {"success": True, "scenarios": per_scenario_results}
    if _diag:
        resp["_diagnostics"] = _diag
    return resp


def _append_synthetic_frames_impl(args: Dict[str, Any]) -> None:
    """Append synthetic future frames (forecast-only tail) to a cohort maturity result.

    Extracted to module level so both _handle_snapshot_analyze_subjects and
    _handle_cohort_maturity_v3 can call it. Mutates result['frames'] in place.

    Args dict keys: result, mu, sigma, onset_delta_days, forecast_mean,
    anchor_to, tau_extent (optional).
    """
    import math
    from datetime import date, timedelta
    from runner.forecast_application import compute_completeness
    from runner.lag_distribution_utils import log_normal_inverse_cdf

    result = args.get('result') or {}
    frames = result.get('frames') if isinstance(result, dict) else None
    if not isinstance(frames, list) or len(frames) == 0:
        return

    mu = float(args['mu'])
    sigma = float(args['sigma'])
    onset = float(args.get('onset_delta_days') or 0.0)
    fm = float(args.get('forecast_mean') or 0.0)
    anchor_to = args.get('anchor_to')
    if not isinstance(anchor_to, str) or not anchor_to:
        return

    real_frames = [f for f in frames if not f.get('is_synthetic')]
    if not real_frames:
        return

    last_real = None
    for f in reversed(real_frames):
        if isinstance(f, dict) and isinstance(f.get('data_points'), list) and len(f.get('data_points')) > 0:
            last_real = f
            break
    if not last_real:
        return

    last_as_at = str(last_real.get('snapshot_date') or last_real.get('as_at_date') or '')[:10]
    if not last_as_at:
        return

    try:
        last_as_at_d = date.fromisoformat(last_as_at)
        anchor_to_d = date.fromisoformat(anchor_to[:10])
    except ValueError:
        return

    try:
        t95_model = log_normal_inverse_cdf(0.95, mu, sigma)
    except Exception:
        return
    if not isinstance(t95_model, (int, float)) or not math.isfinite(t95_model) or t95_model <= 0:
        return

    tail_days = int(math.ceil(float(t95_model) + onset))
    tau_extent = args.get('tau_extent')
    if isinstance(tau_extent, (int, float)) and tau_extent > 0 and tau_extent > tail_days:
        tail_days = int(math.ceil(tau_extent))
    if tail_days <= 0:
        return

    tail_to_d = anchor_to_d + timedelta(days=tail_days)
    start_d = last_as_at_d + timedelta(days=1)
    if start_d > tail_to_d:
        return

    base_points = last_real.get('data_points') or []
    if not isinstance(base_points, list) or len(base_points) == 0:
        return

    new_frames: List[Dict[str, Any]] = []
    d = start_d
    while d <= tail_to_d:
        as_at_iso = d.isoformat()
        synth_points: List[Dict[str, Any]] = []
        total_y = 0.0

        for p in base_points:
            if not isinstance(p, dict):
                continue
            anchor_day = str(p.get('anchor_day') or '')[:10]
            if not anchor_day:
                continue
            x = p.get('x') or 0
            a = p.get('a') or 0
            try:
                x = float(x)
            except (ValueError, TypeError):
                x = 0.0
            try:
                a = float(a)
            except (ValueError, TypeError):
                a = 0.0
            if not math.isfinite(x) or x <= 0:
                continue
            if fm <= 0:
                continue
            y_evidence = float(p.get('y') or p.get('Y') or 0)
            try:
                cohort_age_days = (d - date.fromisoformat(anchor_day)).days
            except ValueError:
                cohort_age_days = 0
            c_future = compute_completeness(float(cohort_age_days), mu, sigma, onset)
            c_future = max(0.0, min(1.0, float(c_future)))
            projected_y = x * fm * c_future
            projected_y = min(projected_y, x)
            forecast_y = max(0.0, projected_y - y_evidence)
            rate = (y_evidence / x) if x > 0 else 0.0
            rate = max(0.0, min(1.0, rate))
            total_y += y_evidence
            synth_points.append({
                "anchor_day": anchor_day,
                "y": y_evidence,
                "x": x,
                "a": a,
                "rate": rate,
                "completeness": c_future,
                "layer": "forecast",
                "evidence_y": y_evidence,
                "forecast_y": forecast_y,
                "projected_y": projected_y,
            })

        new_frames.append({
            "snapshot_date": as_at_iso,
            "is_synthetic": True,
            "data_points": synth_points,
            "total_y": total_y,
        })
        d += timedelta(days=1)

    result['frames'] = frames + new_frames
    result['forecast_tail'] = {
        "from": start_d.isoformat(),
        "to": tail_to_d.isoformat(),
        "t95_model_days": float(t95_model),
        "onset_delta_days": float(onset),
    }


def _handle_snapshot_analyze_subjects(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshot-based analysis using per-scenario snapshot_subjects.
    
    Each scenario may carry its own `snapshot_subjects` array (derived from that
    scenario's effective DSL).  The backend processes each scenario's subjects
    independently and returns results grouped by scenario.
    
    See: docs/current/project-db/1-reads.md §9
    """
    from datetime import date, datetime, timedelta
    from snapshot_service import query_snapshots, query_snapshots_for_sweep
    from runner.histogram_derivation import derive_lag_histogram
    from runner.daily_conversions_derivation import derive_daily_conversions
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from runner.lag_fit_derivation import derive_lag_fit
    from runner.forecast_application import compute_completeness
    from runner.lag_distribution_utils import log_normal_cdf, log_normal_inverse_cdf, standard_normal_inverse_cdf

    analysis_type = data.get('analysis_type', 'lag_histogram')
    scenarios = data.get('scenarios', [])
    # Doc 30 §4.1: MECE dimension names for aggregation safety.
    # Currently logged for diagnostics; enforcement in derivation
    # functions is a future hardening step.
    mece_dimensions = data.get('mece_dimensions', [])
    if mece_dimensions:
        print(f"[analyze] mece_dimensions: {mece_dimensions}")

    def _apply_regime_selection(rows: List[Dict], subj: Dict) -> List[Dict]:
        return _apply_snapshot_regime_selection(
            rows,
            subj,
            mece_dimensions=mece_dimensions,
        )

    def _read_edge_model_params(graph: Any, target_id: str) -> Optional[Dict[str, float]]:
        """Read mu/sigma/onset/t95/path_t95, forecast.mean, and posterior p from graph edge.

        Doc 25 §3.3: After Phase 3 re-projection, p.posterior.alpha/beta on
        the graph edge carry the correct slice for the active query context.
        We compute posterior_p = alpha/(alpha+beta) and prefer it over
        forecast_mean for model CDF scaling.
        """
        if not graph or not target_id:
            return None
        edges = graph.get('edges', []) if isinstance(graph, dict) else []
        edge = next(
            (e for e in edges
             if str(e.get('uuid') or e.get('id') or '') == str(target_id)),
            None,
        )
        if not edge:
            return None
        p = edge.get('p') or {}
        latency = p.get('latency') or {}
        lat_posterior = latency.get('posterior') or {}
        prob_posterior = p.get('posterior') or {}

        # Edge-level latency: prefer posterior (MCMC) over flat (stats pass).
        mu = lat_posterior.get('mu_mean') or latency.get('mu')
        sigma = lat_posterior.get('sigma_mean') or latency.get('sigma')
        if not isinstance(mu, (int, float)) or not isinstance(sigma, (int, float)):
            return None
        onset = lat_posterior.get('onset_delta_days') or latency.get('promoted_onset_delta_days') or latency.get('onset_delta_days') or 0
        forecast = p.get('forecast') or {}
        forecast_mean = forecast.get('mean')
        t95 = latency.get('promoted_t95') or latency.get('t95')
        path_t95 = latency.get('promoted_path_t95') or latency.get('path_t95')
        result: Dict[str, Any] = {
            'mu': float(mu),
            'sigma': float(sigma),
            'onset_delta_days': float(onset) if isinstance(onset, (int, float)) else 0.0,
        }
        # Bayesian edge-level latency — set only when the posterior carries
        # these values so the per-source curve builder knows Bayes is available.
        bayes_mu = lat_posterior.get('mu_mean')
        bayes_sigma = lat_posterior.get('sigma_mean')
        if (isinstance(bayes_mu, (int, float)) and math.isfinite(bayes_mu)
                and isinstance(bayes_sigma, (int, float)) and math.isfinite(bayes_sigma) and bayes_sigma > 0):
            result['bayes_mu'] = float(bayes_mu)
            result['bayes_sigma'] = float(bayes_sigma)
            bayes_onset = lat_posterior.get('onset_delta_days')
            result['bayes_onset'] = float(bayes_onset) if isinstance(bayes_onset, (int, float)) and math.isfinite(bayes_onset) else 0.0
            # Edge-level uncertainty SDs from the posterior.
            # Doc 61: bare mu_sd is epistemic, mu_sd_pred is predictive.
            for _post_key, _result_key in [
                ('mu_sd', 'bayes_mu_sd'),              # epistemic
                ('mu_sd_pred', 'bayes_mu_sd_pred'),    # predictive (kappa_lat)
                ('sigma_sd', 'bayes_sigma_sd'),
                ('onset_sd', 'bayes_onset_sd'),
                ('onset_mu_corr', 'bayes_onset_mu_corr'),
            ]:
                _v = lat_posterior.get(_post_key)
                if isinstance(_v, (int, float)) and math.isfinite(_v) and (_v > 0 or 'corr' in _post_key):
                    result[_result_key] = float(_v)
        # Evidence retrieval date — needed for tau_observed in fan chart.
        evidence = p.get('evidence') or {}
        ev_retrieved = evidence.get('retrieved_at')
        if isinstance(ev_retrieved, str) and ev_retrieved:
            result['evidence_retrieved_at'] = ev_retrieved
        if isinstance(forecast_mean, (int, float)) and math.isfinite(forecast_mean) and forecast_mean > 0:
            result['forecast_mean'] = float(forecast_mean)
        # Doc 25 §3.3: posterior p from the re-projected slice.
        # After the posteriorSliceResolution fix, alpha/beta always carry
        # window (edge-level) values and cohort_alpha/cohort_beta carry cohort
        # (path-level) values. Extract both so the caller can pick the
        # correct one based on query mode.
        post_alpha = prob_posterior.get('alpha')
        post_beta = prob_posterior.get('beta')
        if (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            result['posterior_p'] = float(post_alpha) / (float(post_alpha) + float(post_beta))
            result['posterior_alpha'] = float(post_alpha)
            result['posterior_beta'] = float(post_beta)
        cohort_alpha = prob_posterior.get('cohort_alpha')
        cohort_beta = prob_posterior.get('cohort_beta')
        if (isinstance(cohort_alpha, (int, float)) and isinstance(cohort_beta, (int, float))
                and cohort_alpha > 0 and cohort_beta > 0):
            result['posterior_p_cohort'] = float(cohort_alpha) / (float(cohort_alpha) + float(cohort_beta))
            result['posterior_cohort_alpha'] = float(cohort_alpha)
            result['posterior_cohort_beta'] = float(cohort_beta)
        # Probability posterior uncertainty (for confidence bands).
        # Prefer posterior-derived SD (from alpha/beta) over the flat p.stdev
        # which is the blended analytic estimate, not the MCMC posterior width.
        _post_p_sd = None
        if (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            _s = post_alpha + post_beta
            _post_p_sd = math.sqrt(post_alpha * post_beta / (_s * _s * (_s + 1)))
        _post_p_cohort_sd = None
        if (isinstance(cohort_alpha, (int, float)) and isinstance(cohort_beta, (int, float))
                and cohort_alpha > 0 and cohort_beta > 0):
            _s = cohort_alpha + cohort_beta
            _post_p_cohort_sd = math.sqrt(cohort_alpha * cohort_beta / (_s * _s * (_s + 1)))
        p_stdev = _post_p_sd or p.get('stdev')
        if isinstance(p_stdev, (int, float)) and math.isfinite(p_stdev) and p_stdev > 0:
            result['p_stdev'] = float(p_stdev)
        if _post_p_cohort_sd is not None:
            result['p_stdev_cohort'] = float(_post_p_cohort_sd)
        if isinstance(t95, (int, float)) and math.isfinite(t95) and t95 > 0:
            result['t95'] = float(t95)
        if isinstance(path_t95, (int, float)) and math.isfinite(path_t95) and path_t95 > 0:
            result['path_t95'] = float(path_t95)
        # Path-level latency: prefer posterior over flat fields.
        path_mu = lat_posterior.get('path_mu_mean') or latency.get('path_mu')
        path_sigma = lat_posterior.get('path_sigma_mean') or latency.get('path_sigma')
        if isinstance(path_mu, (int, float)) and math.isfinite(path_mu):
            result['path_mu'] = float(path_mu)
        if isinstance(path_sigma, (int, float)) and math.isfinite(path_sigma) and path_sigma > 0:
            result['path_sigma'] = float(path_sigma)
        path_onset = lat_posterior.get('path_onset_delta_days') or latency.get('path_onset_delta_days')
        if isinstance(path_onset, (int, float)) and math.isfinite(path_onset) and path_onset >= 0:
            result['path_onset_delta_days'] = float(path_onset)
        # Bayesian path-level latency — set only when the posterior carries
        # path params so the per-source curve builder can distinguish
        # "path from Bayes posterior" from "path from analytic flat".
        bayes_path_mu = lat_posterior.get('path_mu_mean')
        bayes_path_sigma = lat_posterior.get('path_sigma_mean')
        if (isinstance(bayes_path_mu, (int, float)) and math.isfinite(bayes_path_mu)
                and isinstance(bayes_path_sigma, (int, float)) and math.isfinite(bayes_path_sigma) and bayes_path_sigma > 0):
            result['bayes_path_mu'] = float(bayes_path_mu)
            result['bayes_path_sigma'] = float(bayes_path_sigma)
            bayes_path_onset = lat_posterior.get('path_onset_delta_days')
            result['bayes_path_onset'] = float(bayes_path_onset) if isinstance(bayes_path_onset, (int, float)) and math.isfinite(bayes_path_onset) else 0.0
            # Path-level uncertainty SDs from the posterior.
            # Doc 61: bare path_mu_sd is epistemic; path_mu_sd_pred is
            # predictive (absent in current model — no path-level kappa_lat).
            for _post_key, _result_key in [
                ('path_mu_sd', 'bayes_path_mu_sd'),           # epistemic
                ('path_mu_sd_pred', 'bayes_path_mu_sd_pred'),
                ('path_sigma_sd', 'bayes_path_sigma_sd'),
                ('path_onset_sd', 'bayes_path_onset_sd'),
                ('path_onset_mu_corr', 'bayes_path_onset_mu_corr'),
            ]:
                _v = lat_posterior.get(_post_key)
                if isinstance(_v, (int, float)) and math.isfinite(_v) and (_v > 0 or 'corr' in _post_key):
                    result[_result_key] = float(_v)
        # Per-source model vars — extract latency params from each source
        # so the frontend can render separate overlay curves per model.
        model_vars = p.get('model_vars') or []
        source_curves: Dict[str, Dict[str, float]] = {}
        for mv in model_vars:
            if not isinstance(mv, dict):
                continue
            src = mv.get('source', '')
            if src not in ('analytic', 'bayesian'):
                continue
            mv_lat = mv.get('latency') or {}
            mv_mu = mv_lat.get('mu')
            mv_sigma = mv_lat.get('sigma')
            if not isinstance(mv_mu, (int, float)) or not isinstance(mv_sigma, (int, float)):
                continue
            if not math.isfinite(mv_mu) or not math.isfinite(mv_sigma) or mv_sigma <= 0:
                continue
            entry: Dict[str, float] = {
                'mu': float(mv_mu),
                'sigma': float(mv_sigma),
                'onset_delta_days': float(mv_lat.get('onset_delta_days') or 0),
            }
            # Path-level params (for cohort mode)
            mv_pmu = mv_lat.get('path_mu')
            mv_psigma = mv_lat.get('path_sigma')
            if isinstance(mv_pmu, (int, float)) and math.isfinite(mv_pmu):
                entry['path_mu'] = float(mv_pmu)
            if isinstance(mv_psigma, (int, float)) and math.isfinite(mv_psigma) and mv_psigma > 0:
                entry['path_sigma'] = float(mv_psigma)
            mv_ponset = mv_lat.get('path_onset_delta_days')
            if isinstance(mv_ponset, (int, float)) and math.isfinite(mv_ponset) and mv_ponset >= 0:
                entry['path_onset_delta_days'] = float(mv_ponset)
            # Probability mean from this source (for forecast_mean per source)
            mv_prob = mv.get('probability') or {}
            mv_pmean = mv_prob.get('mean')
            if isinstance(mv_pmean, (int, float)) and math.isfinite(mv_pmean) and mv_pmean > 0:
                entry['forecast_mean'] = float(mv_pmean)
            # Uncertainty params (for confidence bands) — extract for all sources.
            # Bayesian source may carry its own SDs in model_vars; analytic
            # entries typically don't, so the band computation step falls back to edge-level
            # heuristic SDs from model_params.
            mv_q = mv.get('quality') or {}
            mv_prob_stdev = mv_prob.get('stdev')
            if isinstance(mv_prob_stdev, (int, float)) and math.isfinite(mv_prob_stdev) and mv_prob_stdev > 0:
                entry['p_stdev'] = float(mv_prob_stdev)
            # Doc 61: extract both epistemic (bare) and predictive (_pred)
            # μ SDs so downstream band consumers can select the correct flavour.
            mv_mu_sd = mv_lat.get('mu_sd')             # epistemic
            mv_mu_sd_pred = mv_lat.get('mu_sd_pred')   # predictive
            mv_sigma_sd = mv_lat.get('sigma_sd')
            mv_onset_sd = mv_lat.get('onset_sd')
            if isinstance(mv_mu_sd, (int, float)) and math.isfinite(mv_mu_sd) and mv_mu_sd > 0:
                entry['mu_sd'] = float(mv_mu_sd)
            if isinstance(mv_mu_sd_pred, (int, float)) and math.isfinite(mv_mu_sd_pred) and mv_mu_sd_pred > 0:
                entry['mu_sd_pred'] = float(mv_mu_sd_pred)
            if isinstance(mv_sigma_sd, (int, float)) and math.isfinite(mv_sigma_sd) and mv_sigma_sd > 0:
                entry['sigma_sd'] = float(mv_sigma_sd)
            if isinstance(mv_onset_sd, (int, float)) and math.isfinite(mv_onset_sd) and mv_onset_sd > 0:
                entry['onset_sd'] = float(mv_onset_sd)
            # Path-level uncertainty
            mv_pmu_sd = mv_lat.get('path_mu_sd')
            mv_pmu_sd_pred = mv_lat.get('path_mu_sd_pred')
            mv_psigma_sd = mv_lat.get('path_sigma_sd')
            mv_ponset_sd = mv_lat.get('path_onset_sd')
            if isinstance(mv_pmu_sd, (int, float)) and math.isfinite(mv_pmu_sd) and mv_pmu_sd > 0:
                entry['path_mu_sd'] = float(mv_pmu_sd)
            if isinstance(mv_pmu_sd_pred, (int, float)) and math.isfinite(mv_pmu_sd_pred) and mv_pmu_sd_pred > 0:
                entry['path_mu_sd_pred'] = float(mv_pmu_sd_pred)
            if isinstance(mv_psigma_sd, (int, float)) and math.isfinite(mv_psigma_sd) and mv_psigma_sd > 0:
                entry['path_sigma_sd'] = float(mv_psigma_sd)
            if isinstance(mv_ponset_sd, (int, float)) and math.isfinite(mv_ponset_sd) and mv_ponset_sd > 0:
                entry['path_onset_sd'] = float(mv_ponset_sd)
            source_curves[src] = entry
        if source_curves:
            result['source_curves'] = source_curves
        # Identify the promoted source
        msp = p.get('model_source_preference') or 'best_available'
        result['promoted_source'] = msp

        # ── SDs from promoted fields (source-agnostic) ──────────────
        # The FE's model source resolution (modelVarsResolution.ts)
        # selects the winning model_vars entry and writes its values to
        # promoted_* fields via applyPromotion.  The BE reads these
        # unconditionally — it does not second-guess the source selection
        # by preferring Bayes-specific locations.
        if latency:
            # Doc 61: promote both epistemic (bare) and predictive (_pred)
            # variants for μ so band consumers can pick the correct flavour.
            for _src_key, _dst_key in [
                ('promoted_mu_sd', 'bayes_mu_sd'),
                ('promoted_mu_sd_pred', 'bayes_mu_sd_pred'),
                ('promoted_sigma_sd', 'bayes_sigma_sd'),
                ('promoted_onset_sd', 'bayes_onset_sd'),
                ('promoted_onset_mu_corr', 'bayes_onset_mu_corr'),
                ('promoted_path_mu_sd', 'bayes_path_mu_sd'),
                ('promoted_path_mu_sd_pred', 'bayes_path_mu_sd_pred'),
                ('promoted_path_sigma_sd', 'bayes_path_sigma_sd'),
                ('promoted_path_onset_sd', 'bayes_path_onset_sd'),
            ]:
                _v = latency.get(_src_key)
                if isinstance(_v, (int, float)) and math.isfinite(_v) and (_v > 0 or 'corr' in _src_key):
                    result[_dst_key] = float(_v)

        return result

    per_scenario_results: List[Dict[str, Any]] = []
    total_rows = 0

    # Top-level analytics_dsl (subject) — constant across scenarios.
    # Fall back to per-scenario analytics_dsl for backward compat.
    top_analytics_dsl = data.get('analytics_dsl', '')

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        # Doc 31: resolve subjects from analytics_dsl (subject) +
        # effective_query_dsl (temporal). Falls back to snapshot_subjects
        # when resolution fails or analytics_dsl absent.
        subjects = None
        subject_dsl = top_analytics_dsl or scenario.get('analytics_dsl', '')
        if subject_dsl:
            try:
                from analysis_subject_resolution import resolve_analysis_subjects, synthesise_snapshot_subjects
                temporal_dsl = scenario.get('effective_query_dsl', '')
                # Compose: subject + temporal. They are separate concerns
                # and should never overlap.
                if subject_dsl and temporal_dsl:
                    full_dsl = f"{subject_dsl}.{temporal_dsl}"
                else:
                    full_dsl = subject_dsl or temporal_dsl
                resolved = resolve_analysis_subjects(
                    graph=scenario.get('graph', {}),
                    query_dsl=full_dsl,
                    analysis_type=analysis_type,
                    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                )
                subjects = synthesise_snapshot_subjects(resolved, analysis_type)
                print(f"[doc31] Resolved {len(subjects)} subjects from DSL "
                      f"'{full_dsl}' for {analysis_type} "
                      f"(scenario={scenario_id})")
            except Exception as e:
                print(f"[doc31] WARNING: DSL resolution failed for scenario={scenario_id}: {e}")
                subjects = None

        # Fallback: use FE-resolved snapshot_subjects if analytics_dsl absent or failed
        if not subjects:
            subjects = scenario.get('snapshot_subjects')

        if not subjects:
            # No snapshot subjects for this scenario — skip snapshot analysis
            per_scenario_results.append({
                "scenario_id": scenario_id,
                "success": True,
                "subjects": [],
                "rows_analysed": 0,
            })
            continue

        per_subject_results: List[Dict[str, Any]] = []
        scenario_rows = 0

        # ── Determine temporal mode early (needed for regime selection) ──
        # Doc #47: regime selection must prefer the correct evidence family
        # BEFORE derivation runs. The same logic is used later for annotation
        # (line ~3822) but we need it here for _apply_temporal_regime_selection.
        _eff_dsl_early = scenario.get('effective_query_dsl', '')
        _top_dsl_early = data.get('query_dsl') or ''
        _combined_dsl_early = _eff_dsl_early + ' ' + _top_dsl_early
        if 'cohort(' in _combined_dsl_early:
            _scenario_is_window = False
        elif 'window(' in _combined_dsl_early:
            _scenario_is_window = True
        else:
            _scenario_is_window = True  # default: window semantics

        # ── Epoch unification for cohort_maturity ─────────────────
        # Group epoch siblings (baseId::epoch:0, baseId::epoch:1, ...)
        # so we can merge their frames into a single call to
        # compute_cohort_maturity_rows.  This avoids overlapping tau
        # ranges and zigzag fan artifacts at epoch boundaries.
        def _base_subject_id(sid: str) -> str:
            idx = str(sid).find('::epoch:')
            return str(sid)[:idx] if idx >= 0 else str(sid)

        # Collect frames per base subject across epoch subjects.
        # Key: base_subject_id → list of (subj, frames) from each epoch.
        _epoch_frames: Dict[str, List[Any]] = {}
        _epoch_subjects: Dict[str, List[Any]] = {}
        _epoch_row_counts: Dict[str, int] = {}  # base_sid → total pre-fetched rows
        for subj in subjects:
            if subj.get('read_mode') == 'cohort_maturity':
                base_sid = _base_subject_id(subj.get('subject_id', ''))
                if base_sid not in _epoch_subjects:
                    _epoch_subjects[base_sid] = []
                _epoch_subjects[base_sid].append(subj)

        # Pre-fetch frames for all cohort_maturity epoch subjects
        for base_sid, epoch_subjs in _epoch_subjects.items():
            merged_frames = []
            for subj in epoch_subjs:
                # Skip gap epochs
                subj_slice_keys = subj.get('slice_keys', [''])
                if any(str(sk) == '__epoch_gap__' for sk in subj_slice_keys):
                    continue
                sweep_from = date.fromisoformat(subj['sweep_from']) if subj.get('sweep_from') else None
                sweep_to = date.fromisoformat(subj['sweep_to']) if subj.get('sweep_to') else None
                rows = query_snapshots_for_sweep(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj_slice_keys,
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    sweep_from=sweep_from,
                    sweep_to=sweep_to,
                    equivalent_hashes=subj.get('equivalent_hashes'),
                )
                # Doc 30: apply regime selection before derivation
                rows = _apply_regime_selection(rows, subj)
                if _COHORT_DEBUG:
                    print(f"[epoch_unify] base={base_sid[:40]} epoch_anchor={subj['anchor_from']}..{subj['anchor_to']} rows={len(rows)}")
                scenario_rows += len(rows)
                _epoch_row_counts[base_sid] = _epoch_row_counts.get(base_sid, 0) + len(rows)
                if rows:
                    frames = derive_cohort_maturity(
                        rows,
                        sweep_from=subj.get('sweep_from'),
                        sweep_to=subj.get('sweep_to'),
                    ).get('frames', [])
                    merged_frames.extend(frames)
            _epoch_frames[base_sid] = merged_frames

        for subj in subjects:
            # Validate required fields (all frontend-computed)
            if not subj.get('param_id'):
                raise ValueError(f"snapshot_subjects[].param_id required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")
            if not subj.get('core_hash'):
                raise ValueError(f"snapshot_subjects[].core_hash required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")
            if not subj.get('anchor_from'):
                raise ValueError(f"snapshot_subjects[].anchor_from required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")
            if not subj.get('anchor_to'):
                raise ValueError(f"snapshot_subjects[].anchor_to required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")

            read_mode = subj.get('read_mode', 'raw_snapshots')

            if analysis_type == 'surprise_gauge':
                # Surprise gauge: scalar-reducer callsite over the shared
                # CF projection bundle (73q Phase 5a). The handler now
                # builds the same bundle the CF endpoint does, calls
                # ``reduce_cf_scalars``, and frames the gauge's two-
                # distribution z-score from the marginal pairs.
                graph_data = scenario.get('graph') or {}
                target_id = (subj.get('target') or {}).get('targetId')
                print(f"[surprise_gauge] target_id={target_id}, graph_edges={len(graph_data.get('edges', []))}")
                result = _compute_surprise_gauge(
                    graph_data,
                    target_id,
                    subj,
                    data,
                    scenario,
                    effective_query_dsl=scenario.get('effective_query_dsl', ''),
                )
                print(f"[surprise_gauge] result vars: {[(v.get('name'), v.get('available'), v.get('reason','')) for v in result.get('variables',[])]}")
                per_subject_results.append({
                    "subject_id": subj.get('subject_id'),
                    "success": True,
                    "result": result,
                    "rows_analysed": 0,
                })
                continue

            if read_mode == 'cohort_maturity':
                # ── Epoch-unified cohort maturity ─────────────────────
                # Frames were pre-fetched and merged across epoch subjects
                # in the epoch unification block above.  Use the merged
                # frames for the BASE subject only; skip epoch siblings.
                base_sid = _base_subject_id(subj.get('subject_id', ''))
                subj_sid = str(subj.get('subject_id', ''))
                is_gap = any(str(sk) == '__epoch_gap__' for sk in subj.get('slice_keys', ['']))

                # The primary epoch is the first non-gap epoch for this
                # base subject.  All other epochs (gaps + siblings) are
                # skipped — their frames were already merged in pre-fetch.
                # Fallback: if no epoch siblings registered (non-epoch
                # subject), treat the subject itself as primary.
                _sibs = _epoch_subjects.get(base_sid, [])
                _primary_sid = subj_sid  # default: self is primary
                for _s in _sibs:
                    _s_keys = _s.get('slice_keys', [''])
                    if not any(str(sk) == '__epoch_gap__' for sk in _s_keys):
                        _primary_sid = str(_s.get('subject_id', ''))
                        break
                is_primary = (subj_sid == _primary_sid)

                if not is_primary:
                    # Gap epochs and non-primary epoch siblings are handled
                    # by the unified computation on the primary epoch.
                    # Emit a minimal result so the response shape is correct.
                    per_subject_results.append({
                        "subject_id": subj.get('subject_id'),
                        "success": True,
                        "result": {"analysis_type": analysis_type, "frames": []},
                        "rows_analysed": 0,
                    })
                    continue

                # Use merged frames from all epochs for this base subject
                merged = _epoch_frames.get(base_sid, [])
                if _COHORT_DEBUG:
                    print(f"[epoch_unify] computing unified maturity for {base_sid[:40]} "
                          f"merged_frames={len(merged)} epochs={len(_epoch_subjects.get(base_sid, []))}")

                if merged:
                    result = {'frames': merged, 'analysis_type': analysis_type}
                else:
                    result = derive_cohort_maturity(
                        [],
                        sweep_from=subj.get('sweep_from'),
                        sweep_to=subj.get('sweep_to'),
                    )
                # rows count already accumulated during pre-fetch;
                # keep the count for per-subject reporting, but clear rows
                # to avoid double-counting in scenario_rows.
                _prefetch_row_count = _epoch_row_counts.get(base_sid, 0)
                rows = []
            elif read_mode == 'sweep_simple':
                # Simple sweep (no epoch splitting) — used by lag_fit
                sweep_from = date.fromisoformat(subj['sweep_from']) if subj.get('sweep_from') else None
                sweep_to = date.fromisoformat(subj['sweep_to']) if subj.get('sweep_to') else None

                rows = query_snapshots_for_sweep(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    sweep_from=sweep_from,
                    sweep_to=sweep_to,
                    equivalent_hashes=subj.get('equivalent_hashes'),
                )

                # sweep_simple reads a broad hash family; prefer the
                # requested temporal evidence family before derivation.
                _subj_slice_keys = subj.get('slice_keys') or []
                _has_w_slice = any('window(' in str(sk) for sk in _subj_slice_keys)
                _has_c_slice = any('cohort(' in str(sk) for sk in _subj_slice_keys)
                if _has_w_slice or _has_c_slice:
                    _subj_is_window = _has_w_slice and not _has_c_slice
                else:
                    _subj_is_window = _scenario_is_window
                rows = _apply_temporal_regime_selection(rows, subj, _subj_is_window)
                scenario_rows += len(rows)

                if analysis_type == 'lag_fit':
                    graph_data = scenario.get('graph') or {}
                    target_id = (subj.get('target') or {}).get('targetId')
                    edge_model = _read_edge_model_params(graph_data, target_id)

                    result = derive_lag_fit(
                        rows,
                        t95_constraint=edge_model.get('t95') if edge_model else None,
                        onset_override=edge_model.get('onset_delta_days') if edge_model else None,
                        from_node=subj.get('from_node', ''),
                        to_node=subj.get('to_node', ''),
                        edge_label=subj.get('edge_label', ''),
                    )
                else:
                    result = {'analysis_type': analysis_type, 'data': [], 'error': f'sweep_simple does not support analysis_type={analysis_type}'}
            else:
                # raw_snapshots / virtual_snapshot: existing query path
                as_at = None
                if subj.get('as_at'):
                    as_at = datetime.fromisoformat(str(subj['as_at']).replace('Z', '+00:00'))

                rows = query_snapshots(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    as_at=as_at,
                    equivalent_hashes=subj.get('equivalent_hashes'),
                )

                # Doc 30 + Doc #47: apply regime selection with temporal
                # preference before derivation. Per-subject slice_keys
                # override the scenario-level mode if present.
                _subj_slice_keys = subj.get('slice_keys') or []
                _has_w_slice = any('window(' in str(sk) for sk in _subj_slice_keys)
                _has_c_slice = any('cohort(' in str(sk) for sk in _subj_slice_keys)
                if _has_w_slice or _has_c_slice:
                    _subj_is_window = _has_w_slice and not _has_c_slice
                else:
                    _subj_is_window = _scenario_is_window
                rows = _apply_temporal_regime_selection(rows, subj, _subj_is_window)
                scenario_rows += len(rows)

                if not rows:
                    per_subject_results.append({
                        "subject_id": subj.get('subject_id'),
                        "success": False,
                        "error": "No snapshot data found",
                    })
                    continue

                # Route to appropriate derivation
                if analysis_type == 'lag_histogram':
                    result = derive_lag_histogram(rows)
                elif analysis_type == 'branch_comparison':
                    result = derive_daily_conversions(rows)
                elif analysis_type == 'conversion_rate':
                    # Doc 49 Part B — non-latency edges only.
                    from runner.conversion_rate_derivation import derive_conversion_rate
                    _cr_graph = scenario.get('graph') or {}
                    _cr_target = (subj.get('target') or {}).get('targetId')
                    _cr_edge = next(
                        (e for e in _cr_graph.get('edges', [])
                         if e.get('uuid') == _cr_target),
                        None,
                    )
                    print(f"[conversion_rate] target_id={_cr_target} edge_found={_cr_edge is not None} rows={len(rows)}", flush=True)
                    # Gate: suppress for edges DECLARED as latency edges (doc 49 §B.2).
                    # The authoritative signal is `latency.latency_parameter`, not a
                    # sigma value — non-latency edges can carry promoted sigma/mu from
                    # Bayes fits on sibling latency stats without being latency edges
                    # themselves.
                    _cr_p = (_cr_edge or {}).get('p') or {}
                    _cr_lat = _cr_p.get('latency') or {}
                    _cr_is_latency_edge = bool(_cr_lat.get('latency_parameter'))
                    _cr_has_latency = _cr_is_latency_edge
                    if _cr_has_latency:
                        # Per-subject failure — other subjects in this scenario
                        # may be non-latency and should still compute.
                        per_subject_results.append({
                            "subject_id": subj.get('subject_id'),
                            "success": False,
                            "error": (
                                "conversion_rate analysis is not yet supported for "
                                "edges with latency dispersion (doc 49 Phase 3 — "
                                "separate design)."
                            ),
                        })
                        continue
                    # Determine bin_size from display_settings (default 'day')
                    _cr_bin = (
                        (data.get('display_settings') or {}).get('bin_size')
                        or 'day'
                    )
                    # Determine temporal_mode from subject resolution
                    _cr_tmode = 'window' if _subj_is_window else 'cohort'
                    print(f"[conversion_rate] bin={_cr_bin} temporal_mode={_cr_tmode} edge_found={_cr_edge is not None} has_latency={_cr_has_latency}", flush=True)
                    try:
                        result = derive_conversion_rate(
                            rows,
                            bin_size=_cr_bin,
                            edge=_cr_edge,
                            temporal_mode=_cr_tmode,
                        )
                        print(f"[conversion_rate] derive OK, bins={len(result.get('data', []))}", flush=True)
                    except Exception as _cr_err:
                        import traceback as _tb
                        print(f"[conversion_rate] derive FAILED: {_cr_err}\n{_tb.format_exc()}", flush=True)
                        raise
                else:
                    raise ValueError(f"Unknown analysis_type for snapshot: {analysis_type}")

            per_subject_results.append({
                "subject_id": subj.get('subject_id'),
                "success": True,
                "result": result,
                "rows_analysed": _prefetch_row_count if read_mode == 'cohort_maturity' else len(rows),
            })

        total_rows += scenario_rows
        per_scenario_results.append({
            "scenario_id": scenario_id,
            "success": any(s.get("success") for s in per_subject_results) if per_subject_results else True,
            "subjects": per_subject_results,
            "rows_analysed": scenario_rows,
        })

    # Simplify response for single-scenario / single-subject cases
    if len(per_scenario_results) == 1:
        single_scenario = per_scenario_results[0]
        subjects_list = single_scenario.get("subjects", [])
        if len(subjects_list) == 1:
            # Single scenario, single subject — flatten fully
            single = subjects_list[0]
            return {
                "success": single.get("success", False),
                "result": single.get("result"),
                "error": single.get("error"),
                "rows_analysed": single.get("rows_analysed", 0),
                "subject_id": single.get("subject_id"),
                "scenario_id": single_scenario.get("scenario_id"),
            }
        # Single scenario, multiple subjects
        return {
            "success": single_scenario.get("success", False),
            "scenario_id": single_scenario.get("scenario_id"),
            "subjects": subjects_list,
            "rows_analysed": single_scenario.get("rows_analysed", 0),
        }

    # Multi-scenario: return grouped by scenario
    any_success = any(s.get("success") for s in per_scenario_results)
    return {
        "success": any_success,
        "analytics_dsl": top_analytics_dsl,
        "query_dsl": top_analytics_dsl,  # backward compat
        "scenarios": per_scenario_results,
        "rows_analysed": total_rows,
    }


def _handle_snapshot_analyze_legacy(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Legacy handler: snapshot_query (single-subject, used by older callers).
    
    Queries snapshot DB and derives analytics (histogram, daily conversions).
    """
    from datetime import date, datetime
    from snapshot_service import query_snapshots
    from runner.histogram_derivation import derive_lag_histogram
    from runner.daily_conversions_derivation import derive_daily_conversions
    
    snapshot_query = data['snapshot_query']
    analysis_type = data.get('analysis_type', 'lag_histogram')
    
    # Validate required fields
    if not snapshot_query.get('param_id'):
        raise ValueError("snapshot_query.param_id required")
    if not snapshot_query.get('anchor_from'):
        raise ValueError("snapshot_query.anchor_from required")
    if not snapshot_query.get('anchor_to'):
        raise ValueError("snapshot_query.anchor_to required")
    
    # Optional point-in-time cut-off (supports serial cron-run simulation)
    as_at = None
    if snapshot_query.get('as_at'):
        as_at = datetime.fromisoformat(str(snapshot_query['as_at']).replace('Z', '+00:00'))

    # Query snapshots
    rows = query_snapshots(
        param_id=snapshot_query['param_id'],
        core_hash=snapshot_query.get('core_hash'),
        slice_keys=snapshot_query.get('slice_keys', ['']),
        anchor_from=date.fromisoformat(snapshot_query['anchor_from']),
        anchor_to=date.fromisoformat(snapshot_query['anchor_to']),
        as_at=as_at,
        equivalent_hashes=snapshot_query.get('equivalent_hashes'),
    )
    
    if not rows:
        return {
            "success": False,
            "error": "No snapshot data found for query",
            "query": snapshot_query,
        }
    
    # Route to appropriate derivation
    if analysis_type == 'lag_histogram':
        result = derive_lag_histogram(rows)
    elif analysis_type == 'daily_conversions':
        result = derive_daily_conversions(rows)
    elif analysis_type == 'conversion_rate':
        from runner.conversion_rate_derivation import derive_conversion_rate
        result = derive_conversion_rate(rows, bin_size='day')
    else:
        raise ValueError(f"Unknown analysis_type for snapshot: {analysis_type}")

    return {
        "success": True,
        "result": result,
        "rows_analysed": len(rows),
    }


# ----------------------------------------------------------------------------
# Test compatibility shim
# ----------------------------------------------------------------------------
def _handle_snapshot_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Backwards-compatible helper retained for existing tests.

    Historically tests imported `_handle_snapshot_analyze` directly and passed a legacy
    `snapshot_query` payload. The production entrypoint is `handle_runner_analyze()`,
    which now dispatches between per-scenario snapshot_subjects and the legacy single
    snapshot_query format.

    This wrapper preserves the older test import without changing runtime behaviour.
    """
    return _handle_snapshot_analyze_legacy(data)


def handle_runner_available_analyses(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle runner/available-analyses endpoint.
    
    Args:
        data: Request body containing:
            - graph: Graph data (optional)
            - query_dsl: DSL query string (optional)
            - scenario_count: Number of scenarios (optional, default 1)
    
    Returns:
        List of available analyses
    """
    from runner import get_available_analyses
    
    graph_data = data.get('graph', {})
    scenario_count = data.get('scenario_count', 1)
    query_dsl = data.get('query_dsl')
    
    available = get_available_analyses(
        graph_data=graph_data,
        query_dsl=query_dsl,
        scenario_count=scenario_count,
    )
    
    return {"analyses": available}


def handle_compile_exclude(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle compile-exclude endpoint.
    
    Compiles a query with excludes() terms to minus/plus form for providers
    that don't support native excludes (like Amplitude).
    
    Args:
        data: Request body containing:
            - query: Query DSL string with excludes() (required)
            - graph: Graph data for topology analysis (required)
    
    Returns:
        Response dict with compiled_query
    """
    import re
    query_str = data.get('query')
    graph_data = data.get('graph')
    
    print(f"[compile_exclude] Received request with query: {query_str[:200] if query_str else 'None'}...")
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    # Parse the query to extract from, to, and excludes
    from query_dsl import parse_query_strict
    from graph_types import Graph
    
    try:
        parsed = parse_query_strict(query_str)
        print(f"[compile_exclude] Parsed query: from={parsed.from_node}, to={parsed.to_node}, exclude={parsed.exclude}, visited={parsed.visited}")
    except Exception as e:
        print(f"[compile_exclude] Failed to parse query: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": f"Query parse failed: {str(e)}",
            "success": False
        }
    
    if not parsed.exclude:
        # No excludes, return original query
        print(f"[compile_exclude] No excludes found in parsed query")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "success": True
        }
    
    # Build graph for topology analysis
    try:
        graph = Graph.model_validate(graph_data)
        print(f"[compile_exclude] Graph validated: {len(graph.nodes)} nodes, {len(graph.edges)} edges")
    except Exception as e:
        print(f"[compile_exclude] Failed to validate graph: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": f"Graph validation failed: {str(e)}",
            "success": False
        }
    
    # Import the inclusion-exclusion compiler
    import sys
    from pathlib import Path
    algorithms_path = Path(__file__).parent / 'algorithms'
    sys.path.insert(0, str(algorithms_path))
    
    from connection_capabilities import supports_native_exclude
    
    # Check if we need to compile (Amplitude doesn't support native excludes)
    # For this endpoint, we assume caller has already determined compilation is needed
    
    # Build networkx graph for the compiler
    import networkx as nx
    G = nx.DiGraph()
    
    # Add nodes
    for node in graph.nodes:
        node_id = node.id or node.uuid
        G.add_node(node_id)
    
    # Add edges
    for edge in graph.edges:
        from_id = edge.from_node
        to_id = edge.to
        # Resolve from/to to node IDs
        from_node_match = next((n for n in graph.nodes if n.uuid == from_id or n.id == from_id), None)
        to_node_match = next((n for n in graph.nodes if n.uuid == to_id or n.id == to_id), None)
        if from_node_match and to_node_match:
            from_node_id = from_node_match.id or from_node_match.uuid
            to_node_id = to_node_match.id or to_node_match.uuid
            G.add_edge(from_node_id, to_node_id)
    
    print(f"[compile_exclude] Built networkx graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    
    # Get from/to nodes
    from_node = parsed.from_node
    to_node = parsed.to_node
    exclude_nodes = parsed.exclude
    
    print(f"[compile_exclude] Compiling: from={from_node}, to={to_node}, exclude={exclude_nodes}")
    
    # Check if nodes exist in graph
    missing_nodes = []
    for node_id in [from_node, to_node] + exclude_nodes:
        if node_id and node_id not in G.nodes():
            missing_nodes.append(node_id)
    
    if missing_nodes:
        print(f"[compile_exclude] WARNING: Nodes not found in graph: {missing_nodes}")
        print(f"[compile_exclude] Available nodes: {list(G.nodes())[:20]}...")  # First 20 nodes
    
    # Import the optimized inclusion-exclusion compiler
    from optimized_inclusion_exclusion import compile_optimized_inclusion_exclusion
    
    try:
        compiled_query, terms = compile_optimized_inclusion_exclusion(
            G, from_node, to_node, to_node, exclude_nodes
        )
        
        print(f"[compile_exclude] Successfully compiled: {len(terms)} terms")
        print(f"[compile_exclude] Compiled query: {compiled_query[:200]}...")
        
        # Prepend any visited() terms from original query
        if parsed.visited:
            visited_str = f".visited({','.join(parsed.visited)})"
            # Insert visited after to() but before minus()
            if '.minus(' in compiled_query:
                parts = compiled_query.split('.minus(', 1)
                compiled_query = f"{parts[0]}{visited_str}.minus({parts[1]}"
            else:
                compiled_query = f"{compiled_query}{visited_str}"
        
        return {
            "compiled_query": compiled_query,
            "was_compiled": True,
            "terms_count": len(terms),
            "success": True
        }
    except Exception as e:
        import traceback
        print(f"[compile_exclude] Compilation failed: {e}")
        print(f"[compile_exclude] Traceback: {traceback.format_exc()}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": str(e),
            "success": False
        }


def handle_snapshots_append(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle append-snapshots endpoint.
    
    Shadow-writes time-series data to the snapshot database after successful fetches.
    
    Args:
        data: Request body containing:
            - param_id: Workspace-prefixed parameter ID (required)
            - canonical_signature: Canonical semantic signature string (required; frontend `query_signature`)
            - inputs_json: Evidence blob for audit + diff UI (required; JSON object)
            - sig_algo: Signature algorithm identifier (required)
            - slice_key: Context slice DSL or '' (required)
            - retrieved_at: ISO timestamp string (required)
            - rows: List of daily data points (required)
            - diagnostic: bool (optional) - if true, return detailed diagnostic info
    
    Returns:
        Response dict with:
            - success: bool
            - inserted: int
            - diagnostic: dict (only if diagnostic=true in request)
    """
    from datetime import datetime
    from snapshot_service import append_snapshots
    
    param_id = data.get('param_id')
    canonical_signature = data.get('canonical_signature')
    inputs_json = data.get('inputs_json')
    sig_algo = data.get('sig_algo')
    slice_key = data.get('slice_key', '')
    retrieved_at_str = data.get('retrieved_at')
    rows = data.get('rows', [])
    diagnostic = data.get('diagnostic', False)
    
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    if not canonical_signature:
        raise ValueError("Missing 'canonical_signature' field")
    if inputs_json is None or not isinstance(inputs_json, dict):
        raise ValueError("Missing/invalid 'inputs_json' field (must be a JSON object)")
    if not sig_algo:
        raise ValueError("Missing 'sig_algo' field")
    if not retrieved_at_str:
        raise ValueError("Missing 'retrieved_at' field")
    
    # Parse ISO timestamp
    retrieved_at = datetime.fromisoformat(retrieved_at_str.replace('Z', '+00:00'))
    
    result = append_snapshots(
        param_id=param_id,
        canonical_signature=canonical_signature,
        inputs_json=inputs_json,
        sig_algo=sig_algo,
        slice_key=slice_key,
        retrieved_at=retrieved_at,
        rows=rows,
        diagnostic=diagnostic,
        core_hash=data.get('core_hash'),  # Frontend-computed (hash-fixes.md)
    )
    
    return result


def handle_snapshots_health(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshots health check endpoint.
    
    Returns database connectivity status for feature flag decisions.
    """
    from snapshot_service import health_check
    return health_check()


def handle_snapshots_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshots query endpoint.
    
    Query snapshots from the database for a given param_id.
    Used for integration testing verification.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID to query (required)
    
    Returns:
        Response dict with rows
    """
    from snapshot_service import get_db_connection
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT param_id, core_hash, slice_key, anchor_day, retrieved_at,
                   A as a, X as x, Y as y, 
                   median_lag_days, mean_lag_days,
                   anchor_median_lag_days, anchor_mean_lag_days,
                   onset_delta_days
            FROM snapshots
            WHERE param_id = %s
            ORDER BY anchor_day, slice_key
        """, (param_id,))
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        return {
            'success': True,
            'rows': rows,
            'count': len(rows)
        }
    finally:
        conn.close()


def handle_snapshots_delete_test(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle delete-test-snapshots endpoint.
    
    Delete test data from the snapshot database by param_id prefix.
    ONLY for integration testing cleanup - requires prefix starting with 'pytest-'.
    
    Args:
        data: Request body containing:
            - param_id_prefix: Prefix to match for deletion (required, must start with 'pytest-')
    
    Returns:
        Response dict with deleted count
    """
    from snapshot_service import get_db_connection
    
    prefix = data.get('param_id_prefix')
    if not prefix:
        raise ValueError("Missing 'param_id_prefix' field")
    
    # Safety: only allow deletion of test data
    if not prefix.startswith('pytest-'):
        raise ValueError("param_id_prefix must start with 'pytest-' for safety")
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{prefix}%',))
        deleted = cur.rowcount
        conn.commit()
        return {
            'success': True,
            'deleted': deleted
        }
    finally:
        conn.close()


# =============================================================================
# Phase 2: Read Path — Query Endpoints
# =============================================================================

def handle_snapshots_query_full(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle full snapshot query endpoint.
    
    Query snapshots with filtering by date range, signature, slices.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID (required)
            - core_hash: Query signature (optional)
            - slice_keys: List of slice keys (optional)
            - anchor_from: Start date ISO string (optional)
            - anchor_to: End date ISO string (optional)
            - as_at: Timestamp ISO string for point-in-time query (optional)
            - limit: Max rows (optional, default 10000)
    
    Returns:
        Response dict with rows
    """
    from datetime import date, datetime
    from snapshot_service import query_snapshots
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    # Parse optional date filters
    anchor_from = None
    if data.get('anchor_from'):
        anchor_from = date.fromisoformat(data['anchor_from'])
    
    anchor_to = None
    if data.get('anchor_to'):
        anchor_to = date.fromisoformat(data['anchor_to'])
    
    as_at = None
    if data.get('as_at'):
        as_at = datetime.fromisoformat(data['as_at'].replace('Z', '+00:00'))

    retrieved_ats = None
    if data.get('retrieved_ats') is not None:
        if not isinstance(data.get('retrieved_ats'), list):
            raise ValueError("'retrieved_ats' must be a list of ISO datetime strings")
        parsed = []
        for ts in data.get('retrieved_ats') or []:
            if not isinstance(ts, str) or not ts:
                continue
            parsed.append(datetime.fromisoformat(ts.replace('Z', '+00:00')))
        retrieved_ats = parsed
    
    rows = query_snapshots(
        param_id=param_id,
        core_hash=data.get('core_hash'),
        slice_keys=data.get('slice_keys'),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        as_at=as_at,
        retrieved_ats=retrieved_ats,
        equivalent_hashes=data.get('equivalent_hashes'),
        limit=data.get('limit', 10000)
    )
    
    return {
        'success': True,
        'rows': rows,
        'count': len(rows)
    }


def handle_snapshots_inventory(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch inventory endpoint.
    
    Get snapshot inventory for multiple parameters in a single request.
    
    Args:
        data: Request body containing:
            - param_ids: List of parameter IDs (required)
    
    Returns:
        Response dict with inventory per param_id (V2: signature families).
    """
    param_ids = data.get("param_ids")
    if not param_ids:
        raise ValueError("Missing 'param_ids' field")

    if not isinstance(param_ids, list):
        raise ValueError("'param_ids' must be a list")

    from snapshot_service import get_batch_inventory_v2
    inventory = get_batch_inventory_v2(
        param_ids=param_ids,
        current_signatures=data.get("current_signatures") or None,
        current_core_hashes=data.get("current_core_hashes") or None,  # Frontend-computed (hash-fixes.md)
        slice_keys_by_param=data.get("slice_keys") or None,
        equivalent_hashes_by_param=data.get("equivalent_hashes_by_param") or None,
        limit_families_per_param=int(data.get("limit_families_per_param", 50)),
        limit_slices_per_family=int(data.get("limit_slices_per_family", 200)),
    )
    return {"success": True, "inventory_version": 2, "inventory": inventory}


def handle_snapshots_batch_retrieval_days(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch retrieval days endpoint.

    Return distinct retrieved_day per param_id in a single query.
    Used by the aggregate as-at calendar when no edge is selected.

    Args:
        data: Request body containing:
            - param_ids: List of parameter IDs (required)
            - limit_per_param: Max days per param (optional, default 200)

    Returns:
        Response dict with per-param retrieved_days lists.
    """
    param_ids = data.get("param_ids")
    if not param_ids:
        raise ValueError("Missing 'param_ids' field")
    if not isinstance(param_ids, list):
        raise ValueError("'param_ids' must be a list")

    from snapshot_service import query_batch_retrieval_days
    days_by_param = query_batch_retrieval_days(
        param_ids=param_ids,
        limit_per_param=int(data.get("limit_per_param", 200)),
    )
    return {"success": True, "days_by_param": days_by_param}


def handle_snapshots_batch_retrievals(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch snapshot retrievals endpoint.

    Signature-filtered retrieved_days for N subjects in a single request.
    Replaces N separate /api/snapshots/retrievals calls with one round-trip,
    critical for the @ calendar on large graphs (31+ edges).

    Args:
        data: Request body containing:
            - subjects: List of { param_id, core_hash, slice_keys?, equivalent_hashes? }
            - limit_per_subject: Max timestamps per subject (optional, default 200)

    Returns:
        Response dict with per-subject retrieved_at + retrieved_days.
    """
    from snapshot_service import query_batch_retrievals

    subjects = data.get('subjects')
    if not subjects or not isinstance(subjects, list):
        raise ValueError("Missing or invalid 'subjects' field (must be a list)")

    limit_per_subject = int(data.get('limit_per_subject', 200))
    results = query_batch_retrievals(
        subjects=subjects,
        limit_per_subject=limit_per_subject,
    )
    return {"success": True, "results": results}


def handle_snapshots_retrievals(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshot retrievals endpoint.

    Return distinct snapshot retrieval timestamps (`retrieved_at`) for a given subject.
    Used by Phase 2 `@` UI to highlight available snapshot days.

    Args:
        data: Request body containing:
            - param_id: Parameter ID (required)
            - canonical_signature: Canonical signature (optional; frontend `query_signature`)
            - slice_keys: List of slice keys (optional)
            - anchor_from: Start date ISO string (optional)
            - anchor_to: End date ISO string (optional)
            - limit: Max timestamps (optional, default 200)

    Returns:
        Response dict with retrieved_at + derived retrieved_days.
    """
    from datetime import date
    from snapshot_service import query_snapshot_retrievals, _require_core_hash

    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")

    anchor_from = None
    if data.get('anchor_from'):
        anchor_from = date.fromisoformat(data['anchor_from'])

    anchor_to = None
    if data.get('anchor_to'):
        anchor_to = date.fromisoformat(data['anchor_to'])

    # Frontend must provide core_hash. None means "query all hashes for this param" (hash-fixes.md)
    req_core_hash = data.get('core_hash')
    core_hash = _require_core_hash(req_core_hash, context="retrievals") if req_core_hash else None

    return query_snapshot_retrievals(
        param_id=param_id,
        core_hash=core_hash,
        slice_keys=data.get('slice_keys'),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        equivalent_hashes=data.get('equivalent_hashes'),
        include_summary=bool(data.get('include_summary', False)),
        limit=data.get('limit', 200)
    )


def handle_snapshots_delete(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshot delete endpoint.
    
    Delete snapshots for a specific parameter, optionally scoped to core_hashes.
    Used by "Delete snapshots (X)" UI feature.
    
    Args:
        data: Request body containing:
            - param_id: Exact parameter ID to delete (required)
            - core_hashes: Optional list of core_hash values to scope the delete
    
    Returns:
        Response dict with deleted count
    """
    from datetime import datetime
    from snapshot_service import delete_snapshots
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    core_hashes = data.get('core_hashes')
    if core_hashes is not None and not isinstance(core_hashes, list):
        raise ValueError("'core_hashes' must be a list of strings")

    retrieved_ats = data.get('retrieved_ats')
    if retrieved_ats is not None:
        if not isinstance(retrieved_ats, list):
            raise ValueError("'retrieved_ats' must be a list of ISO datetime strings")
        parsed = []
        for ts in retrieved_ats:
            if not isinstance(ts, str) or not ts:
                continue
            parsed.append(datetime.fromisoformat(ts.replace('Z', '+00:00')))
        retrieved_ats = parsed

    return delete_snapshots(param_id, core_hashes=core_hashes, retrieved_ats=retrieved_ats)


def handle_snapshots_query_virtual(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle virtual snapshot query endpoint for asat() DSL.
    
    Returns the "virtual snapshot": latest row per anchor_day (and slice_key)
    as-of a given timestamp. This supports historical queries without
    returning raw snapshot rows.
    
    Performance invariant: executes at most ONE SQL query per param_id.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID (required)
            - as_at: ISO datetime string for point-in-time (required)
            - anchor_from: Start date ISO string (required)
            - anchor_to: End date ISO string (required)
            - canonical_signature: Canonical semantic signature string (REQUIRED; frontend `query_signature`)
            - slice_keys: List of slice keys (optional)
            - limit: Max rows (optional, default 10000)
    
    Returns:
        Response dict with:
        - success: bool
        - rows: List of virtual snapshot rows
        - count: int
        - latest_retrieved_at_used: str | None
        - has_anchor_to: bool
        - error: str (if failed)
    """
    from datetime import date, datetime
    from snapshot_service import query_virtual_snapshot, _require_core_hash
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")

    # Semantic integrity requirement: historical reads MUST be keyed by the canonical signature.
    canonical_signature = data.get('canonical_signature')
    if not canonical_signature:
        raise ValueError("Missing 'canonical_signature' field (required for semantic integrity)")
    # Frontend must provide core_hash — backend never derives hashes (hash-fixes.md)
    core_hash = _require_core_hash(data.get('core_hash'), context="query-virtual")
    
    as_at_str = data.get('as_at')
    if not as_at_str:
        raise ValueError("Missing 'as_at' field")
    
    anchor_from_str = data.get('anchor_from')
    if not anchor_from_str:
        raise ValueError("Missing 'anchor_from' field")
    
    anchor_to_str = data.get('anchor_to')
    if not anchor_to_str:
        raise ValueError("Missing 'anchor_to' field")
    
    # Parse dates
    as_at = datetime.fromisoformat(as_at_str.replace('Z', '+00:00'))
    anchor_from = date.fromisoformat(anchor_from_str)
    anchor_to = date.fromisoformat(anchor_to_str)
    
    return query_virtual_snapshot(
        param_id=param_id,
        as_at=as_at,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        core_hash=core_hash,
        slice_keys=data.get('slice_keys'),
        equivalent_hashes=data.get('equivalent_hashes'),
        limit=data.get('limit', 10000)
    )


# =============================================================================
# Batch Anchor Coverage — missing anchor-day ranges for Retrieve All preflight
# =============================================================================


def handle_snapshots_batch_anchor_coverage(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch anchor coverage endpoint.

    For each subject, compute which anchor-day ranges are missing from the
    snapshot DB within [anchor_from, anchor_to], considering equivalence closure.

    Args:
        data: Request body containing:
            - subjects: List of dicts, each with:
                - param_id (str, required)
                - core_hash (str, required)
                - slice_keys (list[str], required)
                - anchor_from (ISO date str, required)
                - anchor_to (ISO date str, required)


    Returns:
        Response dict with:
            - success: bool
            - results: list of per-subject coverage results
    """
    from datetime import date as date_type
    from snapshot_service import batch_anchor_coverage
    diagnostic = bool(data.get("diagnostic", False))

    subjects_raw = data.get("subjects")
    if not subjects_raw:
        raise ValueError("Missing 'subjects' field")
    if not isinstance(subjects_raw, list):
        raise ValueError("'subjects' must be a list")

    # Parse and validate each subject
    subjects = []
    for i, s in enumerate(subjects_raw):
        if not isinstance(s, dict):
            raise ValueError(f"subjects[{i}] must be a dict")
        param_id = s.get("param_id")
        if not param_id:
            raise ValueError(f"subjects[{i}] missing 'param_id'")
        core_hash = s.get("core_hash")
        if not core_hash:
            raise ValueError(f"subjects[{i}] missing 'core_hash'")
        anchor_from_str = s.get("anchor_from")
        if not anchor_from_str:
            raise ValueError(f"subjects[{i}] missing 'anchor_from'")
        anchor_to_str = s.get("anchor_to")
        if not anchor_to_str:
            raise ValueError(f"subjects[{i}] missing 'anchor_to'")
        subjects.append({
            "param_id": param_id,
            "core_hash": core_hash,
            "slice_keys": s.get("slice_keys") or [],
            "anchor_from": date_type.fromisoformat(anchor_from_str),
            "anchor_to": date_type.fromisoformat(anchor_to_str),
            "equivalent_hashes": s.get("equivalent_hashes"),
        })

    results = batch_anchor_coverage(subjects, diagnostic=diagnostic)
    return {"success": True, "results": results}


# =============================================================================
# Flexible signatures: Signature Links UI routes
# =============================================================================


def handle_sigs_list(data: Dict[str, Any]) -> Dict[str, Any]:
    """List signature registry rows for a param_id, or list distinct param_ids.

    Modes:
    - param_id set: list signatures for that param (original behaviour)
    - list_params=True: list distinct param_ids with summary counts
    Filters: param_id_prefix (workspace scoping), graph_name (provenance)
    """
    from snapshot_service import list_signatures
    param_id = data.get("param_id")
    list_params = bool(data.get("list_params", False))
    if not param_id and not list_params:
        raise ValueError("Either 'param_id' or 'list_params' must be provided")
    limit = data.get("limit", 200)
    include_inputs = bool(data.get("include_inputs", False))
    param_id_prefix = data.get("param_id_prefix")
    graph_name = data.get("graph_name")
    return list_signatures(
        param_id=param_id,
        param_id_prefix=param_id_prefix,
        graph_name=graph_name,
        list_params=list_params,
        limit=limit,
        include_inputs=include_inputs,
    )


def handle_sigs_get(data: Dict[str, Any]) -> Dict[str, Any]:
    """Get a single signature registry row."""
    from snapshot_service import get_signature
    param_id = data.get("param_id")
    core_hash = data.get("core_hash")
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    if not core_hash:
        raise ValueError("Missing 'core_hash' field")
    return get_signature(param_id=param_id, core_hash=core_hash)


def handle_cache_clear(data: Dict[str, Any]) -> Dict[str, Any]:
    """Clear the snapshot service result cache.  Returns pre-clear stats."""
    from snapshot_service import cache_clear
    stats = cache_clear()
    return {"success": True, **stats}


def handle_cache_stats(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return current cache statistics (non-destructive)."""
    from snapshot_service import cache_stats
    return {"success": True, **cache_stats()}


# REMOVED: handle_sigs_links_list, handle_sigs_links_create,
# handle_sigs_links_deactivate, handle_sigs_resolve
# Equivalence is now FE-owned via hash-mappings.json.
# See: docs/current/project-db/hash-mappings-table-location-be-contract-12-Feb-26.md


def handle_lag_recompute_models(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Recompute lag models for a set of subjects using snapshot DB evidence.

    Request shape (see analysis-forecasting.md §5.2):
      - subjects: array of {subject_id, param_id, core_hash, slice_keys,
                             anchor_from, anchor_to, target: {targetId, ...}}
      - forecasting_settings: required settings object (see §4.5)
      - graph: scenario graph (for reading t95 constraint from edge)
      - training_anchor_from/to: ISO dates (optional; defaults to subject anchor range)
      - as_at: ISO datetime (optional; for as-at evidence selection)

    Returns per-subject fitted model params.
    """
    from datetime import date, datetime
    from snapshot_service import query_snapshots
    from runner.lag_model_fitter import fit_model_from_evidence
    from runner.forecasting_settings import settings_from_dict, compute_settings_signature

    # ── Validate required fields ──────────────────────────────
    forecasting_settings_raw = data.get('forecasting_settings')
    if not forecasting_settings_raw:
        raise ValueError("Missing required 'forecasting_settings' field")
    settings = settings_from_dict(forecasting_settings_raw)
    sig = compute_settings_signature(settings)

    subjects = data.get('subjects', [])
    if not subjects:
        raise ValueError("Missing or empty 'subjects' array")

    graph = data.get('graph', {})
    edges = graph.get('edges', []) if isinstance(graph, dict) else []
    as_at_str = data.get('as_at')
    diagnostic = bool(data.get('diagnostic', False))
    # Accept both ISO with offset and Zulu suffix.
    as_at = datetime.fromisoformat(as_at_str.replace('Z', '+00:00')) if as_at_str else None

    # ── Process each subject ──────────────────────────────────
    results = []
    for subj in subjects:
        subject_id = subj.get('subject_id', '')
        param_id = subj.get('param_id')
        core_hash = subj.get('core_hash')
        if not param_id or not core_hash:
            results.append({
                'subject_id': subject_id,
                'success': False,
                'error': 'Missing param_id or core_hash',
            })
            continue

        slice_keys = subj.get('slice_keys', [''])
        anchor_from_str = data.get('training_anchor_from') or subj.get('anchor_from')
        anchor_to_str = data.get('training_anchor_to') or subj.get('anchor_to')

        print(f"[lag_recompute] subject={subject_id}, param_id={param_id}, core_hash={core_hash[:12]}..., slice_keys={slice_keys}, anchor_from={anchor_from_str}, anchor_to={anchor_to_str}")

        try:
            anchor_from = date.fromisoformat(anchor_from_str) if anchor_from_str else None
            anchor_to = date.fromisoformat(anchor_to_str) if anchor_to_str else None
        except (ValueError, TypeError):
            anchor_from = None
            anchor_to = None

        # Read t95 constraint from graph edge (one-way sigma constraint).
        target = subj.get('target', {})
        target_id = target.get('targetId')
        t95_constraint = None
        if target_id and edges:
            edge = next(
                (e for e in edges
                 if str(e.get('uuid') or e.get('id') or '') == str(target_id)),
                None,
            )
            if edge:
                p = edge.get('p') or {}
                latency = p.get('latency') or {}
                t95_val = latency.get('t95') or p.get('t95')
                if isinstance(t95_val, (int, float)) and t95_val > 0:
                    t95_constraint = float(t95_val)

        # Onset: prefer the explicit FE fitting onset sent per-subject.
        # This is the onset the FE actually used when computing mu/sigma
        # (derived from window() histogram data). The graph edge's
        # onset_delta_days may be stale; do NOT read it from the edge.
        # In future the BE may independently derive onset from historic
        # snapshots, but for now the FE value is authoritative.
        onset_override = None
        subj_onset = subj.get('onset_delta_days')
        if isinstance(subj_onset, (int, float)) and subj_onset >= 0:
            onset_override = float(subj_onset)

        # Query DB evidence.
        subj_equiv_hashes = subj.get('equivalent_hashes')
        try:
            rows = query_snapshots(
                param_id=param_id,
                core_hash=core_hash,
                slice_keys=slice_keys,
                anchor_from=anchor_from,
                anchor_to=anchor_to,
                as_at=as_at,
                equivalent_hashes=subj_equiv_hashes,
            )
        except Exception as e:
            results.append({
                'subject_id': subject_id,
                'success': False,
                'error': f'DB query failed: {e}',
            })
            continue

        # Fit model from evidence.
        training_window = {}
        if anchor_from_str:
            training_window['anchor_from'] = anchor_from_str
        if anchor_to_str:
            training_window['anchor_to'] = anchor_to_str

        fit = fit_model_from_evidence(
            rows=rows,
            settings=settings,
            t95_constraint=t95_constraint,
            onset_override=onset_override,
            use_authoritative_t95=True,
            training_window=training_window or None,
            settings_signature=sig,
            reference_datetime=as_at,
            diagnostic=diagnostic,
        )

        result_entry: Dict[str, Any] = {
            'subject_id': subject_id,
            'success': True,
            'mu': fit.mu,
            'sigma': fit.sigma,
            't95_days': fit.t95_days,
            'onset_delta_days': fit.onset_delta_days,
            'quality_ok': fit.quality_ok,
            'total_k': fit.total_k,
            'quality_failure_reason': fit.quality_failure_reason,
            'training_window': fit.training_window,
            'settings_signature': fit.settings_signature,
            'evidence_anchor_days': fit.evidence_anchor_days,
        }
        if diagnostic and fit.diagnostic_evidence is not None:
            result_entry['diagnostic_evidence'] = fit.diagnostic_evidence
        results.append(result_entry)

    return {
        'success': True,
        'subjects': results,
    }


