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

from file_evidence_supplement import (
    iter_uncovered_bare_cohort_daily_points,
    normalise_supported_date,
)

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
) -> Dict[str, Any]:
    """Surprise gauge: thin projection of compute_forecast_summary (doc 55).

    Two variables:
      - p: observed Σk/Σn vs unconditioned posterior-predictive rate
           (pp_rate_unconditioned moments from the summary).
      - completeness: unconditioned vs IS-conditioned posterior completeness.
                      Dial = unconditioned (model baseline); needle =
                      conditioned (evidence-informed).

    Both variables are single-number z-score projections of fields
    returned by compute_forecast_summary. No analytic fallback, no
    bespoke maths, no model_vars branching. If the summary cannot be
    computed (no resolved params, no snapshot rows, no valid cohorts,
    engine error, degenerate posterior), the variable reports
    available: false with a reason. Low IS ESS is not a failure —
    it displays with a warning icon (doc 55 §3.3).
    """
    from runner.model_resolver import resolve_model_params
    from runner.forecast_runtime import (
        get_cf_mode_and_reason,
        is_cf_sweep_eligible,
    )
    from runner.forecast_state import (
        compute_forecast_summary,
        build_node_arrival_cache,
    )
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from snapshot_service import query_snapshots_for_sweep
    from datetime import date as date_type

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
    query_dsl = data.get('query_dsl') or ''
    subj_slice_keys = subj.get('slice_keys') or []
    has_cohort_slice = any('cohort(' in str(sk) for sk in subj_slice_keys)
    is_cohort = has_cohort_slice or ('cohort(' in query_dsl)
    scope = 'path' if is_cohort else 'edge'
    temporal = 'cohort' if is_cohort else 'window'

    # ── Resolve model params ────────────────────────────────────
    graph_pref = (graph_data.get('model_source_preference')
                  if isinstance(graph_data, dict) else None)
    resolved = resolve_model_params(
        edge, scope=scope, temporal_mode=temporal, graph_preference=graph_pref,
    )
    if not resolved:
        print("[surprise_gauge] no resolved params or σ≤0")
        return _unavailable('No resolved model params (σ must be > 0)')
    cf_mode, cf_reason = get_cf_mode_and_reason(resolved)
    if not is_cf_sweep_eligible(resolved):
        return _unavailable(
            cf_reason or 'query_scoped_posterior',
            cf_mode=cf_mode,
            cf_reason=cf_reason,
            reference_source=resolved.source,
        )
    if resolved.latency.sigma <= 0:
        print("[surprise_gauge] no resolved params or σ≤0")
        return _unavailable('No resolved model params (σ must be > 0)')

    # ── Subject must carry snapshot-query fields ────────────────
    param_id = subj.get('param_id')
    core_hash = subj.get('core_hash')
    anchor_from_str = subj.get('anchor_from')
    anchor_to_str = subj.get('anchor_to')
    if not (param_id and core_hash and anchor_from_str and anchor_to_str):
        print("[surprise_gauge] missing subject fields for snapshot query")
        return _unavailable('Missing subject fields for snapshot query')

    # ── Query snapshots ─────────────────────────────────────────
    try:
        anchor_from = date_type.fromisoformat(str(anchor_from_str)[:10])
        anchor_to = date_type.fromisoformat(str(anchor_to_str)[:10])
        rows = query_snapshots_for_sweep(
            param_id=param_id,
            core_hash=core_hash,
            slice_keys=subj.get('slice_keys', ['']),
            anchor_from=anchor_from,
            anchor_to=anchor_to,
            equivalent_hashes=subj.get('equivalent_hashes'),
        )
    except Exception as e:
        print(f"[surprise_gauge] snapshot query failed: {e}")
        return _unavailable('Snapshot query failed')

    if not rows:
        print("[surprise_gauge] no snapshot rows")
        return _unavailable('No snapshot data in window')

    # ── Derive cohort frames ────────────────────────────────────
    derivation = derive_cohort_maturity(rows)
    frames = derivation.get('frames', [])
    if not frames:
        return _unavailable('Could not derive cohort frames')

    last_frame = frames[-1]
    data_points = last_frame.get('data_points', [])
    if not data_points:
        return _unavailable('No cohort data points in last frame')

    last_frame_date = None
    sd_str = str(last_frame.get('snapshot_date', ''))[:10]
    if sd_str:
        try:
            last_frame_date = date_type.fromisoformat(sd_str)
        except (ValueError, TypeError):
            pass

    # ── Extract cohort ages/weights and (τ, n, k) evidence ──────
    # Observed Σk, Σn come from these same rows — observed and
    # expected share a single source of truth (doc 55 §4.4).
    cohort_ages_and_weights: List[tuple] = []
    evidence: List[tuple] = []
    total_k = 0.0
    total_n = 0.0
    for dp in data_points:
        ad_str = str(dp.get('anchor_day', ''))[:10]
        try:
            ad = date_type.fromisoformat(ad_str)
        except (ValueError, TypeError):
            continue
        if ad < anchor_from or ad > anchor_to:
            continue
        x_val = dp.get('x', 0)
        y_val = dp.get('y', 0)
        if not isinstance(x_val, (int, float)) or x_val <= 0:
            continue
        if not isinstance(y_val, (int, float)):
            y_val = 0
        age = (last_frame_date - ad).days if last_frame_date else 0
        if age < 0:
            continue
        age_i = int(round(age))
        cohort_ages_and_weights.append((age_i, float(x_val)))
        evidence.append((age_i, float(x_val), float(y_val)))
        total_k += float(y_val)
        total_n += float(x_val)

    if not cohort_ages_and_weights or total_n <= 0:
        return _unavailable('No valid cohorts in window')

    # ── Upstream carrier (cohort mode) ──────────────────────────
    from_node_arrival = None
    if is_cohort:
        try:
            anchor_id = None
            for n in graph_data.get('nodes', []):
                if (n.get('entry') or {}).get('is_start'):
                    anchor_id = n.get('uuid') or n.get('id')
                    break
            if anchor_id is None and graph_data.get('nodes'):
                anchor_id = (graph_data['nodes'][0].get('uuid')
                             or graph_data['nodes'][0].get('id', ''))
            if anchor_id:
                cache = build_node_arrival_cache(
                    graph_data, anchor_id=anchor_id, max_tau=400,
                )
                from_id = edge.get('from', '')
                from_node_arrival = cache.get(from_id)
        except Exception as e:
            print(f"[surprise_gauge] node arrival cache failed: {e}")

    # ── Call CF engine ──────────────────────────────────────────
    edge_id = str(edge.get('uuid') or edge.get('id') or '')
    try:
        summary = compute_forecast_summary(
            edge_id=edge_id,
            resolved=resolved,
            cohort_ages_and_weights=cohort_ages_and_weights,
            evidence=evidence,
            from_node_arrival=from_node_arrival,
        )
    except Exception as e:
        print(f"[surprise_gauge] compute_forecast_summary failed: {e}")
        return _unavailable('Forecast engine failed')

    # ── Project summary → gauge variables ───────────────────────
    obs_rate = total_k / total_n if total_n > 0 else 0.0
    retrieved_at = last_frame_date.isoformat() if last_frame_date else None

    variables: List[Dict[str, Any]] = []

    # p variable
    if summary.pp_rate_unconditioned_sd > 1e-12:
        z_p = ((obs_rate - summary.pp_rate_unconditioned)
               / summary.pp_rate_unconditioned_sd)
        q_p = float(norm_cdf(z_p))
        p_var: Dict[str, Any] = {
            'name': 'p',
            'label': 'Conversion rate',
            'quantile': round(q_p, 6),
            'sigma': round(z_p, 3),
            'observed': round(obs_rate, 6),
            'expected': round(summary.pp_rate_unconditioned, 6),
            'posterior_sd': round(summary.pp_rate_unconditioned_sd, 6),
            'combined_sd': round(summary.pp_rate_unconditioned_sd, 6),
            'completeness': round(summary.completeness_unconditioned, 4),
            'evidence_n': int(round(total_n)),
            'evidence_k': int(round(total_k)),
            'evidence_retrieved_at': _format_retrieved_at_for_display(retrieved_at),
            'zone': classify_zone(q_p),
            'available': True,
        }
        variables.append(p_var)
    else:
        variables.append({
            'name': 'p',
            'label': 'Conversion rate',
            'available': False,
            'reason': 'Posterior-predictive SD effectively zero',
        })

    # completeness variable — dial centred on unconditioned mean,
    # needle at conditioned mean. Surprise = how much the evidence
    # shifted the model's view of maturity.
    if summary.completeness_unconditioned_sd > 1e-12:
        z_c = ((summary.completeness - summary.completeness_unconditioned)
               / summary.completeness_unconditioned_sd)
        q_c = float(norm_cdf(z_c))
        c_var: Dict[str, Any] = {
            'name': 'completeness',
            'label': 'Completeness',
            'quantile': round(q_c, 6),
            'sigma': round(z_c, 3),
            # Dial shows expected (unconditioned); needle shows
            # observed (conditioned). Same convention as p.
            'observed': round(summary.completeness, 6),
            'expected': round(summary.completeness_unconditioned, 6),
            'posterior_sd': round(summary.completeness_unconditioned_sd, 6),
            'combined_sd': round(summary.completeness_unconditioned_sd, 6),
            # Raw pair — convenient for detail rendering.
            'unconditioned': round(summary.completeness_unconditioned, 6),
            'unconditioned_sd': round(summary.completeness_unconditioned_sd, 6),
            'conditioned': round(summary.completeness, 6),
            'conditioned_sd': round(summary.completeness_sd, 6),
            'evidence_retrieved_at': _format_retrieved_at_for_display(retrieved_at),
            'zone': classify_zone(q_c),
            'available': True,
        }
        variables.append(c_var)
    else:
        variables.append({
            'name': 'completeness',
            'label': 'Completeness',
            'available': False,
            'reason': 'Unconditioned completeness SD effectively zero',
        })

    result: Dict[str, Any] = {
        'analysis_type': 'surprise_gauge',
        'analysis_name': 'Expectation Gauge',
        'variables': variables,
        'reference_source': resolved.source,
        'cf_mode': cf_mode,
        'is_ess': round(summary.is_ess, 1),
    }
    if cf_reason is not None:
        result['cf_reason'] = cf_reason

    print(f"[surprise_gauge] source={resolved.source} is_ess={summary.is_ess:.1f} "
          f"p: obs={obs_rate:.4f} exp={summary.pp_rate_unconditioned:.4f} "
          f"sd={summary.pp_rate_unconditioned_sd:.4f} "
          f"c: unc={summary.completeness_unconditioned:.4f} "
          f"cond={summary.completeness:.4f} "
          f"unc_sd={summary.completeness_unconditioned_sd:.4f}")

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
    
    Returns:
        Analysis results
    """
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
        if analysis_type == 'cohort_maturity_v2':
            return _handle_cohort_maturity_v2(data)
        if analysis_type == 'cohort_maturity_v1':
            return _handle_snapshot_analyze_subjects(data)
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
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from snapshot_service import query_snapshots_for_sweep

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
            regime = regimes[0]
            if isinstance(regime, str):
                core_hash = regime
                regime = {'core_hash': regime, 'equivalent_hashes': []}
            else:
                core_hash = regime.get('core_hash', '')
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
            # Widen anchor_from for upstream fetch so Tier 2 can
            # discover older donor cohorts (doc 29d §donor-fetch).
            try:
                af_d = date.fromisoformat(anchor_from)
                lookback_days = max((axis_tau_max or 0) * 2, 60)
                af_widened = (af_d - timedelta(days=lookback_days)).isoformat()
            except (ValueError, TypeError):
                af_widened = anchor_from
            try:
                up_rows = query_snapshots_for_sweep(
                    param_id=p_id,
                    core_hash=core_hash,
                    slice_keys=[''],
                    anchor_from=date.fromisoformat(af_widened),
                    anchor_to=date.fromisoformat(anchor_to),
                    sweep_from=date.fromisoformat(af_widened),
                    sweep_to=date.fromisoformat(sweep_to) if sweep_to else None,
                    equivalent_hashes=[
                        h if isinstance(h, dict) else {'core_hash': h}
                        for h in (regime.get('equivalent_hashes') or [])
                    ],
                )
                print(f"{log_prefix} edge {eid[:20]} → {len(up_rows)} rows")
                up_derivation = derive_cohort_maturity(
                    up_rows, sweep_from=sweep_from, sweep_to=sweep_to,
                )
                up_edge_frames[eid] = up_derivation.get('frames', [])
            except Exception as ex:
                import traceback
                print(f"{log_prefix} query failed for {eid[:20]}: {ex}")
                traceback.print_exc()
                fetch_ok = False
                break
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


def _apply_temporal_regime_selection(
    rows: List[Dict[str, Any]],
    subj: Dict[str, Any],
    is_window: bool,
) -> List[Dict[str, Any]]:
    """Apply regime selection with temporal mode preference ordering.

    Window and cohort are separate evidence families (x-anchored vs
    a-anchored) with different core_hashes. The FE emits them as
    separate CandidateRegime entries with temporal_mode tags. This
    function reorders the candidates so the requested mode is tried
    first, then delegates to select_regime_rows which picks one
    regime per retrieved_at date.

    When candidate_regimes is absent (backward compat), returns rows
    unchanged.
    """
    from snapshot_regime_selection import CandidateRegime, select_regime_rows

    cr_raw = subj.get('candidate_regimes')
    if not cr_raw or not isinstance(cr_raw, list):
        print(f"[temporal_regime] NO candidate_regimes on subject (rows={len(rows)})")
        return rows
    print(f"[temporal_regime] {len(cr_raw)} candidates, modes={[r.get('temporal_mode','?') for r in cr_raw if isinstance(r,dict)]}")

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

    # Reorder: preferred temporal mode first. The temporal_mode tag
    # on each raw candidate tells us which evidence family it represents.
    # Candidates matching the requested mode rank before others so
    # regime selection picks them when data exists for a given date.
    preferred = 'window' if is_window else 'cohort'
    tagged = [(r, cr_raw[i].get('temporal_mode', '')) for i, r in enumerate(regimes) if i < len(cr_raw)]
    preferred_regimes = [r for r, m in tagged if m == preferred]
    other_regimes = [r for r, m in tagged if m != preferred]
    ordered = preferred_regimes + other_regimes

    selection = select_regime_rows(rows, ordered if ordered else regimes)

    if len(selection.rows) != len(rows):
        print(f"[temporal_regime] {len(rows)} → {len(selection.rows)} rows "
              f"(mode={preferred}, {len(selection.regime_per_date)} dates)")

    return selection.rows


def _handle_cohort_maturity_v2(data: Dict[str, Any]) -> Dict[str, Any]:
    """Phase A: completely parallel cohort_maturity_v2 handler.

    This function is independent of _handle_snapshot_analyze_subjects.
    It resolves subjects, derives per-edge frames, composes span-level
    evidence, builds the span kernel, and calls compute_cohort_maturity_rows
    with composed inputs.

    For single-edge spans, the composed evidence and kernel degenerate to
    the single-edge case, producing identical output to v1 (parity gate).
    """
    import math
    from datetime import date, datetime, timedelta
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from runner.cohort_forecast import XProvider, build_x_provider_from_graph
    from runner.cohort_forecast_v2 import compute_cohort_maturity_rows_v2, build_span_params
    from runner.span_evidence import compose_path_maturity_frames
    from runner.span_kernel import compose_span_kernel, _build_span_topology, mc_span_cdfs
    from runner.span_adapter import span_kernel_to_edge_params
    from snapshot_service import query_snapshots_for_sweep

    analysis_type = 'cohort_maturity_v2'
    scenarios = data.get('scenarios', [])
    top_analytics_dsl = data.get('analytics_dsl', '')
    display_settings = data.get('display_settings') or {}

    per_scenario_results: List[Dict[str, Any]] = []

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        graph_data = scenario.get('graph') or {}

        # ── Resolve subjects from DSL ─────────────────────────────────
        subjects = None
        subject_dsl = top_analytics_dsl or scenario.get('analytics_dsl', '')
        if subject_dsl:
            try:
                from analysis_subject_resolution import resolve_analysis_subjects, synthesise_snapshot_subjects
                temporal_dsl = scenario.get('effective_query_dsl', '')
                full_dsl = f"{subject_dsl}.{temporal_dsl}" if subject_dsl and temporal_dsl else (subject_dsl or temporal_dsl)
                resolved = resolve_analysis_subjects(
                    graph=graph_data,
                    query_dsl=full_dsl,
                    analysis_type=analysis_type,
                    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                )
                subjects = synthesise_snapshot_subjects(resolved, analysis_type)
                print(f"[v2] Resolved {len(subjects)} subjects from DSL "
                      f"'{full_dsl}' (scenario={scenario_id})")
            except Exception as e:
                print(f"[v2] WARNING: DSL resolution failed: {e}")
                subjects = None

        if not subjects:
            subjects = scenario.get('snapshot_subjects', [])

        if not subjects:
            per_scenario_results.append({
                "scenario_id": scenario_id,
                "success": True,
                "subjects": [],
                "rows_analysed": 0,
            })
            continue

        # ── Determine query start/end nodes and anchor ────────────────
        # Default path_role to 'only' to match the per_edge_results
        # construction below (line ~908). Subjects built directly (e.g.
        # test fixtures, legacy callers) may omit path_role when the
        # subject is single-edge; the canonical DSL-resolved subjects
        # always include it.
        query_from_node = None
        query_to_node = None
        anchor_node = None
        for subj in subjects:
            role = subj.get('path_role') or 'only'
            if role in ('first', 'only'):
                query_from_node = subj.get('from_node')
            if role in ('last', 'only'):
                query_to_node = subj.get('to_node')

        # Resolve anchor node from graph
        try:
            from msmdc import compute_anchor_node_id
            from graph_types import Graph
            g_obj = Graph(**graph_data) if graph_data else None
            if g_obj and g_obj.edges:
                anchor_node = compute_anchor_node_id(g_obj, g_obj.edges[0])
        except Exception:
            pass

        # Detect window vs cohort mode from the temporal DSL.
        # The FE sends analytics_dsl (subject: from(x).to(y)) separately
        # from effective_query_dsl (temporal: window(-90d:) or cohort(...)).
        # Check the temporal DSL first, then the full composed DSL.
        temporal_dsl = scenario.get('effective_query_dsl', '')
        query_dsl = data.get('query_dsl') or top_analytics_dsl or ''
        is_window = 'window(' in temporal_dsl or 'window(' in query_dsl

        # ── Derive frames per edge ────────────────────────────────────
        # Doc #47: multi-hop cohort must use window evidence for subject
        # frames. See v3 handler comment for rationale.
        is_multihop = len(subjects) > 1
        subject_is_window = is_window or is_multihop

        per_edge_results: List[Dict[str, Any]] = []
        total_rows = 0

        for subj in subjects:
            sweep_from = subj.get('sweep_from')
            sweep_to_str = subj.get('sweep_to')
            try:
                rows = query_snapshots_for_sweep(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    sweep_from=date.fromisoformat(sweep_from) if sweep_from else None,
                    sweep_to=date.fromisoformat(sweep_to_str) if sweep_to_str else None,
                    equivalent_hashes=subj.get('equivalent_hashes'),
                )
            except Exception as e:
                print(f"[v2] WARNING: snapshot query failed for {subj.get('subject_id')}: {e}")
                rows = []

            total_rows += len(rows)
            print(f"[v2] Subject {subj.get('subject_id','?')}: "
                  f"role={subj.get('path_role')} from={subj.get('from_node')} "
                  f"to={subj.get('to_node')} rows={len(rows)} "
                  f"param_id={subj.get('param_id','?')[:40]} "
                  f"core_hash={subj.get('core_hash','?')} "
                  f"eq_hashes={len(subj.get('equivalent_hashes') or [])} "
                  f"slice_keys={subj.get('slice_keys')}")

            rows = _apply_temporal_regime_selection(rows, subj, subject_is_window)
            derivation = derive_cohort_maturity(
                rows,
                sweep_from=sweep_from,
                sweep_to=sweep_to_str,
            )

            per_edge_results.append({
                'path_role': subj.get('path_role', 'only'),
                'from_node': subj.get('from_node', ''),
                'to_node': subj.get('to_node', ''),
                'subject': subj,
                'derivation_result': derivation,
            })

        # ── Compose span-level evidence ───────────────────────────────
        composed = compose_path_maturity_frames(
            per_edge_results=per_edge_results,
            query_from_node=query_from_node or '',
            query_to_node=query_to_node or '',
            anchor_node=anchor_node,
        )
        composed_frames = composed.get('frames', [])
        print(f"[v2] Composed: from={query_from_node} to={query_to_node} "
              f"anchor={anchor_node} frames={len(composed_frames)} "
              f"cohorts={composed.get('cohorts_analysed', 0)}")

        composed_frames = composed.get('frames', [])

        # ── Build span kernel ─────────────────────────────────────────
        # Resolve max_tau from display settings or sweep range
        tau_extent_raw = display_settings.get('tau_extent')
        max_tau = 400  # default
        if tau_extent_raw and str(tau_extent_raw) not in ('auto', 'Auto'):
            try:
                max_tau = int(float(tau_extent_raw))
            except (ValueError, TypeError):
                pass

        kernel = None
        if query_from_node and query_to_node:
            kernel = compose_span_kernel(
                graph=graph_data,
                x_node_id=query_from_node,
                y_node_id=query_to_node,
                is_window=is_window,
                max_tau=max_tau,
            )

        # ── Find last edge for adapter (SDs, alpha/beta) ─────────────
        last_edge_id = None
        for entry in per_edge_results:
            if entry['path_role'] in ('last', 'only'):
                last_edge_id = (entry['subject'].get('target') or {}).get('targetId')
                break

        # ── Build edge_params from span kernel or last edge ───────────
        if kernel and last_edge_id:
            edge_params = span_kernel_to_edge_params(
                kernel=kernel,
                graph=graph_data,
                target_edge_id=last_edge_id,
                is_window=is_window,
            )
        else:
            # Fallback: read from last edge directly
            edge_params = _read_edge_model_params(graph_data, last_edge_id) or {}

        # ── Annotate composed frames (projected_y, completeness) ────
        # Same mu/sigma/onset resolution as v1's _resolve_completeness_params:
        # cohort mode prefers path-level params; window mode uses edge-level.
        _can_annotate = (
            composed_frames and edge_params
            and 'mu' in edge_params and 'sigma' in edge_params
            and 'onset_delta_days' in edge_params
        )
        if _can_annotate:
            from runner.forecast_application import annotate_rows
            if is_window:
                _ann_mu = edge_params['mu']
                _ann_sigma = edge_params['sigma']
                _ann_onset = edge_params['onset_delta_days']
            else:
                _p_mu = edge_params.get('path_mu')
                _p_sigma = edge_params.get('path_sigma')
                if _p_mu is not None and _p_sigma is not None:
                    _ann_mu = _p_mu
                    _ann_sigma = _p_sigma
                    _ann_onset = edge_params.get('path_onset_delta_days',
                                                  edge_params['onset_delta_days'])
                else:
                    _ann_mu = edge_params['mu']
                    _ann_sigma = edge_params['sigma']
                    _ann_onset = edge_params['onset_delta_days']
            _ann_fm = edge_params.get('forecast_mean', 0) or 0
            for frame in composed_frames:
                sd = frame.get('snapshot_date', '') or frame.get('as_at_date', '')
                if frame.get('data_points'):
                    frame['data_points'] = annotate_rows(
                        frame['data_points'], _ann_mu, _ann_sigma, _ann_onset,
                        forecast_mean=_ann_fm,
                        retrieved_at_override=sd,
                    )

        # ── Call compute_cohort_maturity_rows ──────────────────────────
        if kernel:
            print(f"[v2] Kernel: span_p={kernel.span_p:.4f} max_tau={kernel.max_tau}")
        maturity_rows = []
        if composed_frames and last_edge_id and edge_params:
            anchor_from_str = subjects[0].get('anchor_from', '')
            anchor_to_str = subjects[0].get('anchor_to', '')
            sweep_to_final = subjects[0].get('sweep_to') or subjects[0].get('anchor_to', '')

            # ── Compute axis_tau_max (same logic as v1 handler) ──────
            # Candidates: sweep_span, edge-level t95, path-level t95,
            # user tau_extent display setting.
            _sweep_span = None
            try:
                if anchor_from_str and sweep_to_final:
                    _af_d = date.fromisoformat(str(anchor_from_str)[:10])
                    _st_d = date.fromisoformat(str(sweep_to_final)[:10])
                    _sweep_span = (_st_d - _af_d).days
            except (ValueError, TypeError):
                pass
            _edge_t95 = edge_params.get('t95')
            _path_t95 = edge_params.get('path_t95')
            _tau_extent_setting = None
            if tau_extent_raw and str(tau_extent_raw) not in ('auto', 'Auto'):
                try:
                    _tau_extent_setting = float(tau_extent_raw)
                except (ValueError, TypeError):
                    pass
            # User-explicit tau_extent overrides auto-derived candidates.
            if _tau_extent_setting and _tau_extent_setting > 0:
                axis_tau_max = int(math.ceil(_tau_extent_setting))
            else:
                _axis_candidates = [c for c in [_sweep_span, _edge_t95, _path_t95] if c and c > 0]
                axis_tau_max = int(math.ceil(max(_axis_candidates))) if _axis_candidates else None
            print(f"[v2] axis_tau_max={axis_tau_max} tau_extent_setting={_tau_extent_setting}")

            # Sampling mode from display settings
            sampling_mode = display_settings.get('continuous_forecast', 'binomial')

            # Band level
            band_raw = display_settings.get('bayes_band_level', '90')
            try:
                band_level = float(band_raw) / 100.0 if band_raw not in ('off', 'blend') else 0.90
            except (ValueError, TypeError):
                band_level = 0.90

            # ── x_provider (doc 29c/29d) ─────────────────────────────
            # The upstream provider runs for ALL v2 queries (single-hop
            # and multi-hop).  The is_multi_hop flag only controls the
            # span CDF override (convolution), not the provider.
            is_multi_hop = len(per_edge_results) > 1

            from runner.cohort_forecast import get_incoming_edges, read_edge_cohort_params
            from runner.span_upstream import extract_upstream_observations
            from runner.span_kernel import _build_span_topology

            # Read ingress carrier: path latency params from edges
            # entering x (query_from_node).
            _ingress = []
            if query_from_node:
                for inc_edge in get_incoming_edges(graph_data, query_from_node):
                    _params = read_edge_cohort_params(inc_edge)
                    if _params:
                        _ingress.append(_params)

            # ── Compute reach from anchor to x ────────────────────
            _reach_to_x = 0.0
            if query_from_node and anchor_node and not is_window:
                try:
                    from runner.graph_builder import build_networkx_graph
                    from runner.path_runner import calculate_path_probability
                    # build_networkx_graph uses UUIDs; anchor_node and
                    # query_from_node are human IDs — must convert.
                    _id_to_uuid_v2 = {n.get('id', ''): n['uuid']
                                      for n in graph_data.get('nodes', [])}
                    _a_uuid_v2 = _id_to_uuid_v2.get(anchor_node, anchor_node)
                    _x_uuid_v2 = _id_to_uuid_v2.get(query_from_node, query_from_node)
                    G = build_networkx_graph(graph_data)
                    path_result = calculate_path_probability(G, _a_uuid_v2, _x_uuid_v2)
                    _reach_to_x = path_result.probability
                except Exception as _e:
                    print(f"[v2] reach computation failed: {_e}")

            # ── Upstream provider ─────────────────────────────────
            # Active whenever x ≠ a and we have reach (cohort mode).
            # Evidence conditions the ingress carrier via IS.
            _upstream_obs = None
            _upstream_enabled = _reach_to_x > 0 and not is_window
            print(f"[v2] upstream: ingress={len(_ingress)} reach={_reach_to_x:.6f} "
                  f"x={query_from_node} a={anchor_node} enabled={_upstream_enabled}")

            if (_upstream_enabled
                    and query_from_node and anchor_node
                    and query_from_node != anchor_node):
                # Collect evidence frames for edges entering x
                _up_edge_frames: Dict[str, List[Dict[str, Any]]] = {}

                # Index subject edges we already have
                for entry in per_edge_results:
                    _target_id = (entry.get('subject') or {}).get('target', {}).get('targetId', '')
                    if _target_id:
                        _up_edge_frames[_target_id] = (
                            entry.get('derivation_result', {}).get('frames', [])
                        )

                # Find upstream edges not already in subject set
                _up_topo = _build_span_topology(graph_data, anchor_node, query_from_node)
                if _up_topo is not None:
                    def _edge_uuid(e_dict):
                        return str(e_dict.get('uuid', e_dict.get('id', '')))
                    _missing_eids = [
                        _edge_uuid(e_data) for _, _, e_data in _up_topo.edge_list
                        if _edge_uuid(e_data) not in _up_edge_frames
                    ]
                    if _missing_eids:
                        print(f"[v2] upstream: fetching {len(_missing_eids)} upstream edges")
                        candidate_regimes = scenario.get('candidate_regimes_by_edge', {})
                        _fetch_ok = True
                        for _eid in _missing_eids:
                            _regimes = candidate_regimes.get(_eid, [])
                            if not _regimes:
                                print(f"[v2] upstream: no regime for {_eid[:20]}")
                                _fetch_ok = False
                                break
                            _regime = _regimes[0]
                            if isinstance(_regime, str):
                                _core_hash = _regime
                                _regime = {'core_hash': _regime, 'equivalent_hashes': []}
                            else:
                                _core_hash = _regime.get('core_hash', '')
                            if not _core_hash:
                                _fetch_ok = False
                                break
                            _up_edge = None
                            for e in graph_data.get('edges', []):
                                if str(e.get('uuid', e.get('id', ''))) == str(_eid):
                                    _up_edge = e
                                    break
                            if not _up_edge:
                                _fetch_ok = False
                                break
                            _p_id = _up_edge.get('p', {}).get('id', '') or _eid
                            _af = subjects[0].get('anchor_from', '')
                            _at = subjects[0].get('anchor_to', '')
                            _sf = subjects[0].get('sweep_from', _af)
                            _st = subjects[0].get('sweep_to', _at)
                            # Widen anchor_from for upstream fetch so
                            # Tier 2 can discover older donor cohorts
                            # outside the plotted window (doc 29d
                            # §donor-fetch contract).  Lookback is
                            # data-driven: 2× axis_tau_max (reflects
                            # t95 / sweep extent), floored at 60 days.
                            try:
                                _af_d = date.fromisoformat(_af)
                                from datetime import timedelta
                                _lookback_days = max(
                                    (axis_tau_max or 0) * 2,
                                    60,
                                )
                                _af_widened = (_af_d - timedelta(days=_lookback_days)).isoformat()
                            except (ValueError, TypeError):
                                _af_widened = _af
                            try:
                                _up_rows = query_snapshots_for_sweep(
                                    param_id=_p_id,
                                    core_hash=_core_hash,
                                    slice_keys=[''],
                                    anchor_from=date.fromisoformat(_af_widened),
                                    anchor_to=date.fromisoformat(_at),
                                    sweep_from=date.fromisoformat(_af_widened) if _af_widened else None,
                                    sweep_to=date.fromisoformat(_st) if _st else None,
                                    equivalent_hashes=[
                                        h if isinstance(h, dict) else {'core_hash': h}
                                        for h in (_regime.get('equivalent_hashes') or [])
                                    ],
                                )
                                print(f"[v2] upstream: edge {_eid[:20]} → {len(_up_rows)} rows")
                                _up_derivation = derive_cohort_maturity(
                                    _up_rows, sweep_from=_sf, sweep_to=_st,
                                )
                                _up_edge_frames[_eid] = _up_derivation.get('frames', [])
                            except Exception as _e:
                                import traceback as _tb
                                print(f"[v2] upstream: query failed for {_eid[:20]}: {_e}")
                                _tb.print_exc()
                                _fetch_ok = False
                                break
                        # Discard partial results on incomplete fetch
                        if not _fetch_ok:
                            print(f"[v2] upstream: incomplete fetch, discarding partial evidence")
                            _up_edge_frames = {}

                # Extract observations (sum y across edges entering x)
                if _up_edge_frames:
                    _upstream_obs = extract_upstream_observations(
                        graph=graph_data,
                        anchor_node_id=anchor_node,
                        x_node_id=query_from_node,
                        per_edge_frames=_up_edge_frames,
                    )
                    if _upstream_obs:
                        _total_obs = sum(len(v) for v in _upstream_obs.values())
                        print(f"[v2] upstream: {_total_obs} observations "
                              f"across {len(_upstream_obs)} cohorts")

            _x_provider = XProvider(
                reach=_reach_to_x,
                upstream_params_list=_ingress,
                enabled=_upstream_enabled,
                ingress_carrier=_ingress if _ingress else None,
                upstream_obs=_upstream_obs,
            )

            # ── Span topology for mc_span_cdfs ─────────────────────────
            # For single-edge cohort with anchor ≠ from_node, widen the
            # span to anchor → to_node so mc_span_cdfs produces a
            # path-level CDF. This gives correct Pop D timing for
            # anchor-relative ages. The carrier handles x growth (Pop C).
            #
            # For multi-hop, the span is already from → to (path-level).
            # For window mode, edge-level is correct (ages are from-node-relative).
            _widen_span = (
                not is_multi_hop
                and not is_window
                and anchor_node
                and query_from_node
                and anchor_node != query_from_node
            )
            _span_x = anchor_node if _widen_span else query_from_node
            print(f"[v2] planner: factorised (multi_hop={is_multi_hop} "
                  f"widen_span={_widen_span} span={_span_x}→{query_to_node})")

            try:
                if kernel is not None and kernel.span_p > 0:
                    # Build span params from the edge kernel (edge p for
                    # rate asymptote, edge SDs for IS conditioning).
                    def _norm_cdf(tau: float) -> float:
                        raw = kernel.cdf_at(int(round(tau)))
                        return raw / kernel.span_p

                    _span_params = build_span_params(
                        kernel_cdf=_norm_cdf,
                        span_p=kernel.span_p,
                        max_tau=max_tau,
                        edge_params=edge_params,
                        is_window=is_window,
                    )

                    # MC CDF: from widened span (path-level) or edge span.
                    _span_topo = _build_span_topology(graph_data, _span_x, query_to_node)
                    _mc_cdf_arr = None
                    _mc_p_s = None
                    if _span_topo is not None:
                        import numpy as _np
                        _rng = _np.random.default_rng(42)
                        _mc_cdf_arr, _mc_p_s = mc_span_cdfs(
                            topo=_span_topo,
                            graph=graph_data,
                            is_window=is_window,
                            max_tau=max_tau,
                            num_draws=2000,
                            rng=_rng,
                        )
                        # When span is widened, mc_p_s is path probability
                        # (product of all edge p's). Override with edge p
                        # from the edge-level span so the rate converges
                        # to the target edge's p, not the path p.
                        if _widen_span:
                            _edge_topo = _build_span_topology(
                                graph_data, query_from_node, query_to_node)
                            if _edge_topo is not None:
                                _rng_edge = _np.random.default_rng(42)
                                _, _mc_p_s = mc_span_cdfs(
                                    topo=_edge_topo,
                                    graph=graph_data,
                                    is_window=is_window,
                                    max_tau=max_tau,
                                    num_draws=2000,
                                    rng=_rng_edge,
                                )

                    maturity_rows = compute_cohort_maturity_rows_v2(
                        frames=composed_frames,
                        graph=graph_data,
                        target_edge_id=last_edge_id,
                        span_params=_span_params,
                        anchor_from=anchor_from_str,
                        anchor_to=anchor_to_str,
                        sweep_to=sweep_to_final,
                        is_window=is_window,
                        axis_tau_max=axis_tau_max,
                        band_level=band_level,
                        anchor_node_id=anchor_node,
                        sampling_mode=sampling_mode,
                        mc_cdf_arr=_mc_cdf_arr,
                        mc_p_s=_mc_p_s,
                        x_provider=_x_provider,
                        upstream_obs=_upstream_obs,
                    )
                else:
                    maturity_rows = []
                print(f"[v2] compute_cohort_maturity_rows returned {len(maturity_rows)} rows")
            except Exception as e:
                print(f"[v2] ERROR in compute_cohort_maturity_rows: {e}")
                import traceback; traceback.print_exc()

        # ── Build response ────────────────────────────────────────────
        # Must match v1 shape: { success, scenario_id, subjects: [{subject_id, success, result}] }
        # The FE expects per-subject results even for composed spans.
        subject_result: Dict[str, Any] = {
            'analysis_type': analysis_type,
            'maturity_rows': maturity_rows,
            'frames': composed_frames,
            'span_kernel': {
                'span_p': kernel.span_p if kernel else None,
                'max_tau': kernel.max_tau if kernel else None,
            } if kernel else None,
        }

        per_scenario_results.append({
            "scenario_id": scenario_id,
            "success": True,
            "subjects": [{
                "subject_id": f"v2:{query_from_node}:{query_to_node}",
                "success": True,
                "result": subject_result,
                "rows_analysed": total_rows,
            }],
            "rows_analysed": total_rows,
        })

    # ── Final response ────────────────────────────────────────────────
    if len(per_scenario_results) == 1:
        return per_scenario_results[0]
    return {
        "success": True,
        "scenarios": per_scenario_results,
    }


def _handle_cohort_maturity_v3(data: Dict[str, Any]) -> Dict[str, Any]:
    """Doc 29 Phase 5: cohort maturity consuming the forecast engine.

    Reuses v2's subject resolution and evidence framing pipeline, then
    calls cohort_forecast_v3.compute_cohort_maturity_rows_v3 which
    delegates completeness/carrier/model resolution to the engine.
    """
    import math
    from datetime import date, timedelta
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3
    from runner.span_evidence import compose_path_maturity_frames
    from snapshot_service import query_snapshots_for_sweep

    analysis_type = 'cohort_maturity'
    scenarios = data.get('scenarios', [])
    top_analytics_dsl = data.get('analytics_dsl', '')
    display_settings = data.get('display_settings') or {}
    _emit_diagnostics = bool(data.get('_diagnostics'))
    _diag: Dict[str, Any] = {} if _emit_diagnostics else {}

    per_scenario_results: List[Dict[str, Any]] = []

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        graph_data = scenario.get('graph') or {}

        # ── Resolve subjects from DSL (shared with v2) ───────────────
        subjects = None
        subject_dsl = top_analytics_dsl or scenario.get('analytics_dsl', '')
        if subject_dsl:
            try:
                from analysis_subject_resolution import resolve_analysis_subjects, synthesise_snapshot_subjects
                temporal_dsl = scenario.get('effective_query_dsl', '')
                full_dsl = f"{subject_dsl}.{temporal_dsl}" if subject_dsl and temporal_dsl else (subject_dsl or temporal_dsl)
                resolved = resolve_analysis_subjects(
                    graph=graph_data, query_dsl=full_dsl, analysis_type=analysis_type,
                    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                )
                subjects = synthesise_snapshot_subjects(resolved, analysis_type)
                print(f"[v3] Resolved {len(subjects)} subjects from DSL "
                      f"'{full_dsl}' (scenario={scenario_id})")
            except Exception as e:
                print(f"[v3] WARNING: DSL resolution failed: {e}")

        if not subjects:
            subjects = scenario.get('snapshot_subjects', [])
        if not subjects:
            per_scenario_results.append({
                "scenario_id": scenario_id, "success": True,
                "subjects": [], "rows_analysed": 0,
            })
            continue

        # ── Determine query nodes and anchor ─────────────────────────
        # Default path_role to 'only' to match the per_edge_results
        # construction below. See _handle_snapshot_analyze_subjects for
        # the same pattern.
        query_from_node = query_to_node = anchor_node = None
        for subj in subjects:
            role = subj.get('path_role') or 'only'
            if role in ('first', 'only'):
                query_from_node = subj.get('from_node')
            if role in ('last', 'only'):
                query_to_node = subj.get('to_node')

        # Resolve anchor (same method as v2)
        try:
            from msmdc import compute_anchor_node_id
            from graph_types import Graph
            g_obj = Graph(**graph_data) if graph_data else None
            if g_obj and g_obj.edges:
                anchor_node = compute_anchor_node_id(g_obj, g_obj.edges[0])
        except Exception:
            pass

        temporal_dsl = scenario.get('effective_query_dsl', '')
        query_dsl = data.get('query_dsl') or top_analytics_dsl or ''
        is_window = 'window(' in temporal_dsl or 'window(' in query_dsl

        # ── Derive frames per edge (shared with v2) ──────────────────
        # Doc #47: for multi-hop cohort queries, subject-frame construction
        # must use window evidence. Cohort semantics apply at the path level
        # (x_provider, frontier, IS conditioning, path CDF), not at per-edge
        # evidence selection. Without this override, cohort evidence is
        # maturity-diluted and suppresses the baseline.
        is_multihop = len(subjects) > 1
        subject_is_window = is_window or is_multihop

        per_edge_results: List[Dict[str, Any]] = []
        total_rows = 0
        for subj in subjects:
            sweep_from = subj.get('sweep_from')
            sweep_to_str = subj.get('sweep_to')
            try:
                rows = query_snapshots_for_sweep(
                    param_id=subj['param_id'], core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    sweep_from=date.fromisoformat(sweep_from) if sweep_from else None,
                    sweep_to=date.fromisoformat(sweep_to_str) if sweep_to_str else None,
                    equivalent_hashes=subj.get('equivalent_hashes'),
                )
            except Exception as e:
                print(f"[v3] WARNING: snapshot query failed: {e}")
                rows = []
            total_rows += len(rows)
            _pre_regime_count = len(rows)
            _cands_raw = subj.get('candidate_regimes') or []
            _n_cands = len(_cands_raw)
            _cand_modes = [c.get('temporal_mode', '?') for c in _cands_raw if isinstance(c, dict)]
            rows = _apply_temporal_regime_selection(rows, subj, subject_is_window)
            _post_regime_count = len(rows)
            # Count rows by core_hash to verify temporal separation
            _hash_counts: Dict[str, int] = {}
            for _r in rows:
                _h = str(_r.get('core_hash', ''))[:16]
                _hash_counts[_h] = _hash_counts.get(_h, 0) + 1
            print(f"[v3] Subject {subj.get('from_node','?')}→{subj.get('to_node','?')}: "
                  f"rows={_pre_regime_count}→{_post_regime_count} "
                  f"cands={_n_cands} modes={_cand_modes} "
                  f"hashes_surviving={_hash_counts}")
            if _emit_diagnostics:
                _diag['regime_selection'] = {
                    'pre_rows': _pre_regime_count,
                    'post_rows': _post_regime_count,
                    'n_candidates': _n_cands,
                    'candidate_modes': _cand_modes,
                    'is_window': is_window,
                    'hashes_surviving': _hash_counts,
                    'candidate_hashes': [
                        {'core': c.get('core_hash','')[:16], 'eq': [str(e)[:16] for e in (c.get('equivalent_hashes') or [])], 'mode': c.get('temporal_mode','?')}
                        for c in _cands_raw if isinstance(c, dict)
                    ],
                }
            derivation = derive_cohort_maturity(rows, sweep_from=sweep_from, sweep_to=sweep_to_str)
            per_edge_results.append({
                'path_role': subj.get('path_role', 'only'),
                'from_node': subj.get('from_node', ''),
                'to_node': subj.get('to_node', ''),
                'subject': subj,
                'derivation_result': derivation,
            })

        # ── Compose span-level evidence (shared with v2) ─────────────
        composed = compose_path_maturity_frames(
            per_edge_results=per_edge_results,
            query_from_node=query_from_node or '',
            query_to_node=query_to_node or '',
            anchor_node=anchor_node,
        )
        composed_frames = composed.get('frames', [])
        print(f"[v3] Composed: from={query_from_node} to={query_to_node} "
              f"anchor={anchor_node} frames={len(composed_frames)} "
              f"cohorts={composed.get('cohorts_analysed', 0)}")

        # ── Find last edge ───────────────────────────────────────────
        last_edge_id = None
        for entry in per_edge_results:
            if entry['path_role'] in ('last', 'only'):
                last_edge_id = (entry['subject'].get('target') or {}).get('targetId')
                break

        # ── Axis extent (matching v2's multi-candidate approach) ─────
        anchor_from_str = subjects[0].get('anchor_from', '')
        sweep_to_final = subjects[0].get('sweep_to') or subjects[0].get('anchor_to', '')

        tau_extent_raw = display_settings.get('tau_extent')
        _sweep_span = None
        try:
            if anchor_from_str and sweep_to_final:
                from datetime import date as _date_cls
                _af_d = _date_cls.fromisoformat(str(anchor_from_str)[:10])
                _st_d = _date_cls.fromisoformat(str(sweep_to_final)[:10])
                _sweep_span = (_st_d - _af_d).days
        except (ValueError, TypeError):
            pass

        # Edge-level and path-level t95 — read from edge latency block
        # (same source as v2's span_adapter, not scope-gated by resolver)
        _edge_t95 = None
        _path_t95 = None
        if last_edge_id:
            from runner.forecast_runtime import find_edge_by_id
            _t95_edge = find_edge_by_id(graph_data, last_edge_id)
            if _t95_edge:
                _t95_lat = _t95_edge.get('p', {}).get('latency', {})
                _t95_val = _t95_lat.get('promoted_t95') or _t95_lat.get('t95')
                if isinstance(_t95_val, (int, float)) and _t95_val > 0:
                    _edge_t95 = float(_t95_val)
                _pt95_val = _t95_lat.get('promoted_path_t95') or _t95_lat.get('path_t95')
                if isinstance(_pt95_val, (int, float)) and _pt95_val > 0:
                    _path_t95 = float(_pt95_val)

        _tau_extent_setting = None
        if tau_extent_raw and str(tau_extent_raw) not in ('auto', 'Auto'):
            try:
                _tau_extent_setting = float(tau_extent_raw)
            except (ValueError, TypeError):
                pass

        # User-explicit tau_extent overrides auto-derived candidates.
        if _tau_extent_setting and _tau_extent_setting > 0:
            axis_tau_max = int(math.ceil(_tau_extent_setting))
        else:
            _axis_candidates = [c for c in [_sweep_span, _edge_t95, _path_t95] if c and c > 0]
            axis_tau_max = int(math.ceil(max(_axis_candidates))) if _axis_candidates else None
        print(f"[v3] axis_tau_max={axis_tau_max} tau_extent_setting={_tau_extent_setting} "
              f"last_edge_id={last_edge_id is not None}")

        band_raw = display_settings.get('bayes_band_level', '90')
        try:
            band_level = float(band_raw) / 100.0 if band_raw not in ('off', 'blend') else 0.90
        except (ValueError, TypeError):
            band_level = 0.90

        # G.4: annotate_rows removed from v3. projected_rate now uses
        # MC mean from the sweep (same draws as midpoint/fan bands).
        # Frame annotation was only needed for projected_y aggregation
        # which is superseded by the engine.
        from runner.model_resolver import resolve_model_params
        from runner.forecast_runtime import find_edge_by_id

        # ── Build span kernel + MC draws (shared with v2 for parity) ──
        _mc_cdf_v3 = None
        _mc_p_v3 = None
        _is_multi_hop_v3 = False
        _edge_mc_cdf_v3 = None  # Edge-level CDF for Pop C (multi-hop only)
        _det_norm_cdf = None
        _det_span_p = None
        _span_alpha_v3 = None
        _span_beta_v3 = None
        _span_params_v3 = None
        _edge_kernel_v3 = None
        if composed_frames and last_edge_id and query_from_node and query_to_node:
            from runner.span_kernel import compose_span_kernel, _build_span_topology, mc_span_cdfs
            _is_multi_hop_v3 = len(subjects) > 1

            # ── Span widening (matching v2) ───────────────────────────
            _widen_span_v3 = (
                not _is_multi_hop_v3
                and not is_window
                and anchor_node
                and query_from_node
                and anchor_node != query_from_node
            )
            _span_x_v3 = anchor_node if _widen_span_v3 else query_from_node
            print(f"[v3] planner: factorised (multi_hop={_is_multi_hop_v3} "
                  f"widen_span={_widen_span_v3} span={_span_x_v3}→{query_to_node})")

            # Edge kernel (span_p for rate asymptote, span_params for IS)
            _edge_kernel_v3 = compose_span_kernel(
                graph=graph_data,
                x_node_id=query_from_node,
                y_node_id=query_to_node,
                is_window=is_window,
                max_tau=400,
            )
            # CDF kernel (widened or edge)
            _kernel_v3 = (compose_span_kernel(
                graph=graph_data,
                x_node_id=_span_x_v3,
                y_node_id=query_to_node,
                is_window=is_window,
                max_tau=400,
            ) if _widen_span_v3 else _edge_kernel_v3)

            if _kernel_v3 is not None and _kernel_v3.span_p > 0:
                _det_span_p = _edge_kernel_v3.span_p if _edge_kernel_v3 else _kernel_v3.span_p
                # det_norm_cdf from edge kernel (for E_i), matching v2's
                # sp.C which uses the edge kernel's CDF. Edge CDF gives
                # larger E_i at young frontier ages → IS conditioning fires.
                _det_cdf_kernel = _edge_kernel_v3 or _kernel_v3
                _det_norm_cdf = [
                    min(max(_det_cdf_kernel.cdf_at(t) / _det_cdf_kernel.span_p, 0.0), 1.0)
                    for t in range(401)
                ]
                # Span-adapted params from edge kernel
                from runner.forecast_runtime import span_kernel_to_edge_params, build_span_params
                _ek = _edge_kernel_v3 or _kernel_v3
                _span_edge_params = span_kernel_to_edge_params(
                    _ek, graph_data, last_edge_id, is_window=is_window)
                def _norm_cdf_v3(tau):
                    raw = _ek.cdf_at(int(round(tau)))
                    return raw / _ek.span_p
                _span_params_v3 = build_span_params(
                    _norm_cdf_v3, _ek.span_p, 400,
                    _span_edge_params, is_window=is_window)
                _span_alpha_v3 = _span_params_v3.alpha_0
                _span_beta_v3 = _span_params_v3.beta_0

            # MC draws: CDF from widened span, p from edge span
            _span_topo_v3 = _build_span_topology(graph_data, _span_x_v3, query_to_node)
            if _span_topo_v3 is not None:
                import numpy as _np
                _rng_v3 = _np.random.default_rng(42)
                _mc_cdf_v3, _mc_p_v3 = mc_span_cdfs(
                    topo=_span_topo_v3,
                    graph=graph_data,
                    is_window=is_window,
                    max_tau=400,
                    num_draws=2000,
                    rng=_rng_v3,
                )
                if _widen_span_v3:
                    _edge_topo_v3 = _build_span_topology(
                        graph_data, query_from_node, query_to_node)
                    if _edge_topo_v3 is not None:
                        _rng_edge_v3 = _np.random.default_rng(42)
                        _edge_mc_cdf_v3, _mc_p_v3 = mc_span_cdfs(
                            topo=_edge_topo_v3,
                            graph=graph_data,
                            is_window=is_window,
                            max_tau=400,
                            num_draws=2000,
                            rng=_rng_edge_v3,
                        )

        # ── Edge-level MC CDF for Pop C (multi-hop only) ─────────────
        # Pop C arrivals have traversed upstream edges and need the
        # EDGE-level CDF for conversion timing, not the path CDF.
        # Build from the last edge in the query path.
        if _is_multi_hop_v3 and _edge_mc_cdf_v3 is None and _mc_cdf_v3 is not None:
            _last_entry = next(
                (e for e in per_edge_results if e['path_role'] in ('last', 'only')),
                None,
            )
            if _last_entry:
                _last_from = _last_entry['from_node']
                _last_to = _last_entry['to_node']
                _last_edge_topo = _build_span_topology(graph_data, _last_from, _last_to)
                if _last_edge_topo is not None:
                    import numpy as _np
                    _rng_last_edge = _np.random.default_rng(42)
                    _edge_mc_cdf_v3, _ = mc_span_cdfs(
                        topo=_last_edge_topo,
                        graph=graph_data,
                        is_window=is_window,
                        max_tau=400,
                        num_draws=2000,
                        rng=_rng_last_edge,
                    )

        # ── Build x_provider (matching v2 handler construction) ────────
        # Carrier is needed even for collapsed shortcut: path CDF handles
        # conversion timing, carrier handles x growth (Pop C upstream
        # arrivals). These are orthogonal, not double-counting.
        _v3_x_provider = None
        if not is_window and query_from_node and anchor_node:
            from runner.forecast_runtime import XProvider, get_incoming_edges, read_edge_cohort_params
            _v3_ingress = []
            for inc_edge in get_incoming_edges(graph_data, query_from_node):
                _params = read_edge_cohort_params(inc_edge)
                if _params:
                    _v3_ingress.append(_params)
            # Compute reach from anchor to x.
            # build_networkx_graph uses UUIDs; anchor_node and
            # query_from_node are human IDs — must convert.
            _v3_reach = 0.0
            try:
                from runner.graph_builder import build_networkx_graph
                from runner.path_runner import calculate_path_probability
                _id_to_uuid = {n.get('id', ''): n['uuid']
                               for n in graph_data.get('nodes', [])}
                _a_uuid = _id_to_uuid.get(anchor_node, anchor_node)
                _x_uuid = _id_to_uuid.get(query_from_node, query_from_node)
                G = build_networkx_graph(graph_data)
                path_result = calculate_path_probability(G, _a_uuid, _x_uuid)
                _v3_reach = path_result.probability
            except Exception:
                pass
            _v3_upstream_enabled = _v3_reach > 0
            print(f"[v3] upstream: ingress={len(_v3_ingress)} reach={_v3_reach:.6f} "
                  f"x={query_from_node} a={anchor_node} enabled={_v3_upstream_enabled}")
            # Fetch upstream evidence for empirical carrier (Tier 2)
            _v3_upstream_obs = None
            if _v3_upstream_enabled and query_from_node != anchor_node:
                _v3_af = subjects[0].get('anchor_from', '')
                _v3_at = subjects[0].get('anchor_to', '')
                _v3_sf = subjects[0].get('sweep_from', _v3_af)
                _v3_st = subjects[0].get('sweep_to', _v3_at)
                _v3_upstream_obs = _fetch_upstream_observations(
                    graph_data=graph_data,
                    anchor_node=anchor_node,
                    query_from_node=query_from_node,
                    per_edge_results=per_edge_results,
                    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                    anchor_from=_v3_af,
                    anchor_to=_v3_at,
                    sweep_from=_v3_sf,
                    sweep_to=_v3_st,
                    axis_tau_max=axis_tau_max,
                    log_prefix='[v3] upstream:',
                )
            _v3_x_provider = XProvider(
                reach=_v3_reach,
                upstream_params_list=_v3_ingress,
                enabled=_v3_upstream_enabled,
                ingress_carrier=_v3_ingress if _v3_ingress else None,
                upstream_obs=_v3_upstream_obs,
            )

        _v3_resolved_override = None

        # ── Call v3 row builder ───────────────────────────────────────
        _is_multi_hop = len(subjects) > 1
        maturity_rows = []
        if composed_frames and last_edge_id:
            anchor_to_str = subjects[0].get('anchor_to', '')

            maturity_rows = compute_cohort_maturity_rows_v3(
                frames=composed_frames,
                graph=graph_data,
                target_edge_id=last_edge_id,
                query_from_node=query_from_node or '',
                query_to_node=query_to_node or '',
                anchor_from=anchor_from_str,
                anchor_to=anchor_to_str,
                sweep_to=sweep_to_final,
                is_window=is_window,
                axis_tau_max=axis_tau_max,
                band_level=band_level,
                anchor_node_id=anchor_node,
                display_settings=display_settings,
                mc_cdf_arr=_mc_cdf_v3,
                mc_p_s=_mc_p_v3,
                det_norm_cdf=_det_norm_cdf,
                det_span_p=_det_span_p,
                x_provider_override=_v3_x_provider,
                span_alpha=_span_alpha_v3,
                span_beta=_span_beta_v3,
                span_mu_sd=_span_params_v3.mu_sd if _span_params_v3 else None,
                span_sigma_sd=_span_params_v3.sigma_sd if _span_params_v3 else None,
                span_onset_sd=_span_params_v3.onset_sd if _span_params_v3 else None,
                span_onset_mu_corr=_span_params_v3.onset_mu_corr if _span_params_v3 else None,
                is_multi_hop=_is_multi_hop,
                resolved_override=_v3_resolved_override,
                edge_cdf_arr=_edge_mc_cdf_v3,
            )

        print(f"[v3] compute_cohort_maturity_rows returned {len(maturity_rows)} rows")

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
        if maturity_rows:
            _row_cf_mode = maturity_rows[0].get('_cf_mode')
            _row_cf_reason = maturity_rows[0].get('_cf_reason')
            if _row_cf_mode is not None:
                subject_result['cf_mode'] = _row_cf_mode
            if _row_cf_reason is not None:
                subject_result['cf_reason'] = _row_cf_reason

        if composed_frames and last_edge_id:
            from runner.forecast_application import compute_completeness
            from runner.confidence_bands import compute_confidence_band

            edge = find_edge_by_id(graph_data, last_edge_id)
            if edge:
                scope = 'edge' if is_window else 'path'
                temporal = 'window' if is_window else 'cohort'
                _graph_pref = graph_data.get('model_source_preference')
                mc_resolved = resolve_model_params(
                    edge, scope=scope, temporal_mode=temporal,
                    graph_preference=_graph_pref)

                # ── Determine axis extent ──────────────────────────────
                _tau_max_candidates = []
                if maturity_rows:
                    _tau_max_candidates.append(maturity_rows[-1]['tau_days'])
                if axis_tau_max:
                    _tau_max_candidates.append(axis_tau_max)
                if mc_resolved and mc_resolved.latency.sigma > 0:
                    try:
                        from runner.lag_distribution_utils import log_normal_inverse_cdf
                        _lat = mc_resolved.latency
                        _t95 = log_normal_inverse_cdf(0.95, _lat.mu, _lat.sigma) + _lat.onset_delta_days
                        _tau_max_candidates.append(int(math.ceil(_t95)))
                    except Exception:
                        pass
                # For multi-hop, use 95th percentile of the span CDF
                # (not the full grid which is 400 — too wide)
                if _is_multi_hop and _edge_kernel_v3 is not None and _edge_kernel_v3.span_p > 0:
                    _sp = _edge_kernel_v3.span_p
                    for _t in range(min(_edge_kernel_v3.max_tau + 1, 401)):
                        if _edge_kernel_v3.cdf_at(_t) >= 0.95 * _sp:
                            _tau_max_candidates.append(_t)
                            break
                _curve_tau_max = int(max(_tau_max_candidates)) if _tau_max_candidates else 0

                # ── Unified overlay: span-kernel MC median, all cases ─────
                # Doc 51 §P0 (WS1): single-hop, multi-hop, window, and
                # cohort-widened all render via the same span-kernel
                # construction. The promoted curve reads `_mc_cdf_v3` /
                # `_mc_p_v3` already computed at the top of this handler
                # (mc_span_cdfs on the widened or edge span, depending on
                # mode). Per-source curves call `mc_span_cdfs_for_source`
                # on the same topology. Both midlines and bands are
                # quantile summaries — midline = MC median, bands = MC
                # quantiles — aligning with the main chart's construction
                # (rate_model median + quantile fans) at all τ.
                #
                # Replaces the earlier split between (a) multi-hop
                # compose_span_kernel (deterministic) + per-source MC,
                # and (b) single-hop analytic compute_completeness with
                # scalar path_mu_mean for cohort-path mode. The analytic
                # branch was the source of the discretisation mismatch
                # and the scalar-fit mismatch documented in doc 51
                # §3.2 and §3.3.
                if _curve_tau_max > 0:
                    from runner.span_kernel import (
                        mc_span_cdfs_for_source,
                        _build_span_topology,
                    )
                    import numpy as _np_bands

                    # Same span-x decision the main chart used upstream:
                    # widened (anchor → to_node) for single-hop cohort
                    # with anchor ≠ from_node, else from_node → to_node.
                    _widen_span = (
                        not _is_multi_hop
                        and not is_window
                        and anchor_node
                        and query_from_node
                        and anchor_node != query_from_node
                    )
                    _overlay_span_x = anchor_node if _widen_span else query_from_node

                    # Promoted curve: MC median from the already-computed
                    # `_mc_cdf_v3` and `_mc_p_v3`. These arrays were built
                    # by mc_span_cdfs with the same topology the main
                    # chart uses, so the overlay midline is the same
                    # quantity as the main chart's model_midpoint.
                    if _mc_cdf_v3 is not None and _mc_p_v3 is not None:
                        T_mc = min(_mc_cdf_v3.shape[1], _curve_tau_max + 1)
                        _abs = _mc_cdf_v3[:, :T_mc] * _mc_p_v3[:, None]
                        _mid = _np_bands.median(_abs, axis=0)
                        curve = [
                            {'tau_days': t, 'model_rate': round(float(_mid[t]), 8)}
                            for t in range(T_mc)
                        ]
                        _fm_promoted = float(_np_bands.median(_mc_p_v3))
                        subject_result['model_curve'] = curve
                        subject_result['model_curve_params'] = {
                            'forecast_mean': _fm_promoted,
                            'mode': 'span_convolved_mc_median',
                            'promoted_source': mc_resolved.source if mc_resolved else 'unknown',
                        }
                        subject_result['promoted_source'] = mc_resolved.source if mc_resolved else 'best_available'

                    # Per-source curves via mc_span_cdfs_for_source.
                    #
                    # Rate scaling: the chart's y-axis is the edge rate
                    # (y/x at target edge), so per-source curves must
                    # asymptote to the TARGET EDGE's per-source p, not
                    # the widened-span's cumulative path p. The promoted
                    # curve already handles this by combining widened-CDF
                    # (`_mc_cdf_v3`) with edge-p (`_mc_p_v3`). Mirror that
                    # here: when span is widened, run two per-source MC
                    # calls — widened topology for the CDF shape, edge
                    # topology for the p scalar. When not widened, one
                    # call suffices (edge_topo == span_topo).
                    _src_span_topo = _build_span_topology(
                        graph_data, _overlay_span_x, query_to_node)
                    _src_edge_topo = (
                        _build_span_topology(graph_data, query_from_node, query_to_node)
                        if _widen_span else _src_span_topo
                    )
                    source_curve_results: Dict[str, Any] = {}
                    if _src_span_topo is not None and _src_edge_topo is not None:
                        for src_name in ('analytic', 'analytic_be', 'bayesian'):
                            _rng_shape = _np_bands.random.default_rng(
                                hash(src_name) & 0xFFFFFFFF)
                            _src_cdf, _src_span_p = mc_span_cdfs_for_source(
                                topo=_src_span_topo,
                                graph=graph_data,
                                source_name=src_name,
                                is_window=is_window,
                                max_tau=_curve_tau_max,
                                num_draws=500,
                                rng=_rng_shape,
                            )
                            if _src_cdf is None or _src_span_p is None:
                                continue
                            if float(_np_bands.max(_src_span_p)) <= 0:
                                continue
                            # Edge p — for widened case, a separate MC call
                            # on the edge topology. For non-widened, reuse
                            # the span draws (span == edge).
                            if _widen_span:
                                _rng_edge = _np_bands.random.default_rng(
                                    (hash(src_name) & 0xFFFFFFFF) ^ 0xE06E)
                                _, _src_edge_p = mc_span_cdfs_for_source(
                                    topo=_src_edge_topo,
                                    graph=graph_data,
                                    source_name=src_name,
                                    is_window=is_window,
                                    max_tau=_curve_tau_max,
                                    num_draws=500,
                                    rng=_rng_edge,
                                )
                            else:
                                _src_edge_p = _src_span_p
                            if _src_edge_p is None or float(_np_bands.max(_src_edge_p)) <= 0:
                                continue
                            T_mc = min(_src_cdf.shape[1], _curve_tau_max + 1)
                            abs_rates = _src_cdf[:, :T_mc] * _src_edge_p[:, None]
                            s_mid = _np_bands.median(abs_rates, axis=0)
                            s_upper = _np_bands.quantile(abs_rates, 0.95, axis=0)
                            s_lower = _np_bands.quantile(abs_rates, 0.05, axis=0)
                            s_fm = float(_np_bands.median(_src_edge_p))
                            src_entry: Dict[str, Any] = {
                                'curve': [
                                    {'tau_days': t, 'model_rate': round(float(s_mid[t]), 8)}
                                    for t in range(T_mc)
                                ],
                                'params': {
                                    'forecast_mean': s_fm,
                                    'source': src_name,
                                    'mode': 'span_convolved_mc_median',
                                },
                                'band_upper': [
                                    {'tau_days': t, 'model_rate': round(float(s_upper[t]), 8)}
                                    for t in range(T_mc)
                                ],
                                'band_lower': [
                                    {'tau_days': t, 'model_rate': round(float(s_lower[t]), 8)}
                                    for t in range(T_mc)
                                ],
                            }
                            source_curve_results[src_name] = src_entry

                    if source_curve_results:
                        subject_result['source_model_curves'] = source_curve_results

                    print(f"[v3] model curves: span-kernel MC median, "
                          f"span_x={_overlay_span_x}→{query_to_node}, "
                          f"widen={_widen_span}, "
                          f"sources={list(source_curve_results.keys())}")

        # ── Synthetic future frames (forecast tail) ──────────────────
        if composed_frames and last_edge_id:
            edge = find_edge_by_id(graph_data, last_edge_id)
            if edge:
                scope = 'edge' if is_window else 'path'
                temporal = 'window' if is_window else 'cohort'
                _graph_pref = graph_data.get('model_source_preference')
                ft_resolved = resolve_model_params(
                    edge, scope=scope, temporal_mode=temporal,
                    graph_preference=_graph_pref)
                if ft_resolved and ft_resolved.latency.sigma > 0:
                    anchor_to_str_ft = subjects[0].get('anchor_to', '')
                    if anchor_to_str_ft:
                        _append_synthetic_frames_impl({
                            'result': subject_result,
                            'mu': ft_resolved.latency.mu,
                            'sigma': ft_resolved.latency.sigma,
                            'onset_delta_days': ft_resolved.latency.onset_delta_days,
                            'forecast_mean': ft_resolved.p_mean,
                            'anchor_to': anchor_to_str_ft,
                            'tau_extent': axis_tau_max,
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
                    "pre_count": _pre_regime_count,
                    "post_count": _post_regime_count,
                    "n_candidates": _n_cands,
                    "is_window": is_window,
                },
            }],
            "rows_analysed": total_rows,
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


def _cf_supplement_evidence_counts_from_file(
    graph_data: Dict[str, Any],
    edge_uuid: str,
    anchor_from: str,
    anchor_to: str,
    snapshot_covered_days: set[str],
) -> Dict[str, int]:
    """Supplement CF evidence counts from engorged file data.

    Mirrors the Bayes binder's uncovered-day rule:
      - only bare cohort daily arrays are eligible
      - context-qualified entries are skipped
      - days already covered by snapshot rows are not counted again

    Returns counts only; CF's p.mean remains snapshot-conditioned.
    """
    anchor_from_iso = normalise_supported_date(anchor_from)
    anchor_to_iso = normalise_supported_date(anchor_to)
    if not edge_uuid or not anchor_from_iso or not anchor_to_iso:
        return {'n': 0, 'k': 0, 'supplemented_days': 0}

    edge = next(
        (
            e for e in (graph_data.get('edges', []) or [])
            if (e.get('uuid') or e.get('id')) == edge_uuid
        ),
        None,
    )
    if not isinstance(edge, dict):
        return {'n': 0, 'k': 0, 'supplemented_days': 0}

    bayes_evidence = edge.get('_bayes_evidence')
    if not isinstance(bayes_evidence, dict):
        return {'n': 0, 'k': 0, 'supplemented_days': 0}

    cohort_entries = bayes_evidence.get('cohort') or []
    if not isinstance(cohort_entries, list):
        return {'n': 0, 'k': 0, 'supplemented_days': 0}

    total_n = 0
    total_k = 0
    supplemented_days = 0

    for _, _, n_val, k_val in iter_uncovered_bare_cohort_daily_points(
        cohort_entries,
        snapshot_covered_days,
        anchor_from=anchor_from_iso,
        anchor_to=anchor_to_iso,
    ):
        total_n += n_val
        total_k += k_val
        supplemented_days += 1

    return {'n': total_n, 'k': total_k, 'supplemented_days': supplemented_days}


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
      - Do NOT reach into compute_forecast_trajectory or
        compute_forecast_summary directly — they are inner kernels
        and bypass the topo-sequencing + upstream-carrier coordination
        this handler performs (doc 47). Calling inner kernels per-edge
        from an analysis runner loses that coordination and produces
        subtly different numbers on multi-hop paths.
    Distinct from the BE topo pass (/api/lag/topo-pass →
    handle_stats_topo_pass) which is an analytic pass producing
    `analytic_be` model_vars, not this MC-with-IS enrichment.

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
    import math
    import numpy as _np
    from datetime import date, timedelta
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3
    from runner.span_evidence import compose_path_maturity_frames
    from snapshot_service import query_snapshots_for_sweep

    scenarios = data.get('scenarios', [])
    top_analytics_dsl = data.get('analytics_dsl', '')

    per_scenario_results: List[Dict[str, Any]] = []

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        graph_data = scenario.get('graph') or {}

        # ── Resolve subjects ────────────────────────────────────────
        # Two modes:
        #   (a) analytics_dsl provided → funnel_path scope (single edge/path)
        #   (b) no analytics_dsl → all_graph_parameters scope (doc 47)
        # Mode (b) is the whole-graph conditioned forecast pass.
        subjects = None
        subject_dsl = top_analytics_dsl or scenario.get('analytics_dsl', '')
        temporal_dsl = scenario.get('effective_query_dsl', '')
        try:
            from analysis_subject_resolution import resolve_analysis_subjects, synthesise_snapshot_subjects
            if subject_dsl:
                # Mode (a): single-edge/path via analytics DSL
                full_dsl = f"{subject_dsl}.{temporal_dsl}" if subject_dsl and temporal_dsl else (subject_dsl or temporal_dsl)
                resolved = resolve_analysis_subjects(
                    graph=graph_data, query_dsl=full_dsl, analysis_type='cohort_maturity',
                    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                )
                subjects = synthesise_snapshot_subjects(resolved, 'cohort_maturity')
                print(f"[forecast] Resolved {len(subjects)} subjects from DSL "
                      f"'{full_dsl}' (scenario={scenario_id})")
            else:
                # Mode (b): whole-graph — resolve ALL parameterised edges
                resolved = resolve_analysis_subjects(
                    graph=graph_data, query_dsl=temporal_dsl, analysis_type='conditioned_forecast',
                    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                )
                subjects = synthesise_snapshot_subjects(resolved, 'conditioned_forecast')
                print(f"[forecast] Resolved {len(subjects)} subjects from graph "
                      f"(all_graph_parameters, scenario={scenario_id})")
        except Exception as e:
            print(f"[forecast] WARNING: subject resolution failed: {e}")
            import traceback; traceback.print_exc()

        if not subjects:
            subjects = scenario.get('snapshot_subjects', [])
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
            # Build topo order for edge processing
            eligible_subjects = [
                dict(s, path_role='only')
                for s in subjects
                if s.get('core_hash')
            ]
            # Sort by topological depth: edges from START nodes first,
            # then edges whose from_node is another edge's to_node.
            _start_uuids = {
                n['uuid'] for n in graph_data.get('nodes', [])
                if n.get('entry', {}).get('is_start')
            }
            def _topo_key(s):
                from_uuid = None
                for n in graph_data.get('nodes', []):
                    if n.get('id') == s.get('from_node'):
                        from_uuid = n['uuid']
                        break
                return 0 if from_uuid in _start_uuids else 1
            eligible_subjects.sort(key=_topo_key)
            subject_groups = [[s] for s in eligible_subjects]
        else:
            subject_groups = [subjects]

        query_dsl = data.get('query_dsl') or top_analytics_dsl or ''
        is_window = 'window(' in temporal_dsl or 'window(' in query_dsl

        edge_results: List[Dict[str, Any]] = []
        skipped_edges: List[Dict[str, Any]] = []
        # Running cache of derivation results across edges (whole-graph mode).
        # Passed to _fetch_upstream_observations so downstream edges find
        # upstream frames already cached, enabling Tier 2 empirical carriers.
        all_per_edge_results: List[Dict[str, Any]] = []

        for subj_group in subject_groups:
            # ── Determine query nodes and anchor ────────────────────
            # Default path_role to 'only' to match the per_edge_results
            # construction below.
            query_from_node = query_to_node = anchor_node = None
            for subj in subj_group:
                role = subj.get('path_role') or 'only'
                if role in ('first', 'only'):
                    query_from_node = subj.get('from_node')
                if role in ('last', 'only'):
                    query_to_node = subj.get('to_node')

            if not query_from_node or not query_to_node:
                continue

            # Per-edge anchor (doc 47: use compute_all_anchor_nodes)
            try:
                from msmdc import compute_anchor_node_id
                from graph_types import Graph
                g_obj = Graph(**graph_data) if graph_data else None
                if g_obj:
                    edge_uuid = subj_group[0].get('target', {}).get('targetId', '')
                    g_edge = next((e for e in g_obj.edges if e.uuid == edge_uuid), None)
                    if g_edge:
                        anchor_node = compute_anchor_node_id(g_obj, g_edge)
                    elif g_obj.edges:
                        anchor_node = compute_anchor_node_id(g_obj, g_obj.edges[0])
            except Exception:
                pass

            # ── Derive frames per edge (same as v3) ─────────────────
            per_edge_results: List[Dict[str, Any]] = []
            total_rows = 0
            for subj in subj_group:
                sweep_from = subj.get('sweep_from')
                sweep_to_str = subj.get('sweep_to')
                try:
                    rows = query_snapshots_for_sweep(
                        param_id=subj['param_id'], core_hash=subj['core_hash'],
                        slice_keys=subj.get('slice_keys', ['']),
                        anchor_from=date.fromisoformat(subj['anchor_from']),
                        anchor_to=date.fromisoformat(subj['anchor_to']),
                        sweep_from=date.fromisoformat(sweep_from) if sweep_from else None,
                        sweep_to=date.fromisoformat(sweep_to_str) if sweep_to_str else None,
                        equivalent_hashes=subj.get('equivalent_hashes'),
                    )
                except Exception as e:
                    print(f"[forecast] WARNING: snapshot query failed: {e}")
                    rows = []
                total_rows += len(rows)
                rows = _apply_temporal_regime_selection(rows, subj, is_window)
                snapshot_covered_days = {
                    str(row.get('anchor_day'))
                    for row in rows
                    if row.get('anchor_day')
                }
                derivation = derive_cohort_maturity(rows, sweep_from=sweep_from, sweep_to=sweep_to_str)
                per_edge_results.append({
                    'path_role': subj.get('path_role', 'only'),
                    'from_node': subj.get('from_node', ''),
                    'to_node': subj.get('to_node', ''),
                    'subject': subj,
                    'snapshot_covered_days': snapshot_covered_days,
                    'derivation_result': derivation,
                })

            # Cache derivation results for downstream carrier building
            all_per_edge_results.extend(per_edge_results)

            # No early-exit on total_rows == 0. Let the row builder
            # handle the natural degeneration: zero evidence → prior.
            # The row builder falls back to _non_latency_rows(fe=None, ...)
            # which produces a prior-only row set when cohort evidence
            # cannot be built. Class D (no α/β either) is then a genuine
            # empty return, caught by the `if maturity_rows:` check
            # below and routed to skipped_edges there.

            # ── Compose span-level evidence (same as v3) ────────────
            composed = compose_path_maturity_frames(
                per_edge_results=per_edge_results,
                query_from_node=query_from_node or '',
                query_to_node=query_to_node or '',
                anchor_node=anchor_node,
            )
            composed_frames = composed.get('frames', [])

            # ── Find last edge ──────────────────────────────────────
            last_edge_id = None
            for entry in per_edge_results:
                if entry['path_role'] in ('last', 'only'):
                    last_edge_id = (entry['subject'].get('target') or {}).get('targetId')
                    break

            # ── Dates ───────────────────────────────────────────────
            anchor_from_str = subj_group[0].get('anchor_from', '')
            sweep_to_final = subj_group[0].get('sweep_to') or subj_group[0].get('anchor_to', '')

            # ── Build span kernel + carrier + x_provider (same as v3)
            from runner.model_resolver import resolve_model_params
            from runner.forecast_runtime import find_edge_by_id

            _mc_cdf = None
            _mc_p = None
            _is_multi_hop = len(subj_group) > 1
            _edge_mc_cdf = None
            _det_norm_cdf = None
            _span_alpha = None
            _span_beta = None
            _span_params = None
            _edge_kernel = None
            if composed_frames and last_edge_id and query_from_node and query_to_node:
                from runner.span_kernel import compose_span_kernel, _build_span_topology, mc_span_cdfs
                _widen_span = (
                    not _is_multi_hop
                    and not is_window
                    and anchor_node
                    and query_from_node
                    and anchor_node != query_from_node
                )
                _span_x = anchor_node if _widen_span else query_from_node

                _edge_kernel = compose_span_kernel(
                    graph=graph_data, x_node_id=query_from_node,
                    y_node_id=query_to_node, is_window=is_window, max_tau=400,
                )
                _kernel = (compose_span_kernel(
                    graph=graph_data, x_node_id=_span_x,
                    y_node_id=query_to_node, is_window=is_window, max_tau=400,
                ) if _widen_span else _edge_kernel)

                if _kernel is not None and _kernel.span_p > 0:
                    _det_cdf_kernel = _edge_kernel or _kernel
                    _det_norm_cdf = [
                        min(max(_det_cdf_kernel.cdf_at(t) / _det_cdf_kernel.span_p, 0.0), 1.0)
                        for t in range(401)
                    ]
                    from runner.forecast_runtime import span_kernel_to_edge_params, build_span_params
                    _ek = _edge_kernel or _kernel
                    _span_edge_params = span_kernel_to_edge_params(
                        _ek, graph_data, last_edge_id, is_window=is_window)
                    def _norm_cdf(tau):
                        return _ek.cdf_at(int(round(tau))) / _ek.span_p
                    _span_params = build_span_params(
                        _norm_cdf, _ek.span_p, 400,
                        _span_edge_params, is_window=is_window)
                    _span_alpha = _span_params.alpha_0
                    _span_beta = _span_params.beta_0

                _span_topo = _build_span_topology(graph_data, _span_x, query_to_node)
                if _span_topo is not None:
                    _rng = _np.random.default_rng(42)
                    _mc_cdf, _mc_p = mc_span_cdfs(
                        topo=_span_topo, graph=graph_data,
                        is_window=is_window, max_tau=400, num_draws=2000, rng=_rng,
                    )
                    if _widen_span:
                        _edge_topo = _build_span_topology(graph_data, query_from_node, query_to_node)
                        if _edge_topo is not None:
                            _rng_edge = _np.random.default_rng(42)
                            _edge_mc_cdf, _mc_p = mc_span_cdfs(
                                topo=_edge_topo, graph=graph_data,
                                is_window=is_window, max_tau=400, num_draws=2000, rng=_rng_edge,
                            )

            # Multi-hop edge CDF (same as v3)
            if _is_multi_hop and _edge_mc_cdf is None and _mc_cdf is not None:
                _last_entry = next(
                    (e for e in per_edge_results if e['path_role'] in ('last', 'only')), None)
                if _last_entry:
                    from runner.span_kernel import _build_span_topology, mc_span_cdfs
                    _last_topo = _build_span_topology(graph_data, _last_entry['from_node'], _last_entry['to_node'])
                    if _last_topo is not None:
                        _rng_last = _np.random.default_rng(42)
                        _edge_mc_cdf, _ = mc_span_cdfs(
                            topo=_last_topo, graph=graph_data,
                            is_window=is_window, max_tau=400, num_draws=2000, rng=_rng_last,
                        )

            # x_provider (same as v3)
            _x_provider = None
            if not is_window and query_from_node and anchor_node:
                from runner.forecast_runtime import XProvider, get_incoming_edges, read_edge_cohort_params
                _ingress = []
                for inc_edge in get_incoming_edges(graph_data, query_from_node):
                    _params = read_edge_cohort_params(inc_edge)
                    if _params:
                        _ingress.append(_params)
                _reach = 0.0
                try:
                    from runner.graph_builder import build_networkx_graph
                    from runner.path_runner import calculate_path_probability
                    _id_to_uuid = {n.get('id', ''): n['uuid'] for n in graph_data.get('nodes', [])}
                    _a_uuid = _id_to_uuid.get(anchor_node, anchor_node)
                    _x_uuid = _id_to_uuid.get(query_from_node, query_from_node)
                    G = build_networkx_graph(graph_data)
                    path_result = calculate_path_probability(G, _a_uuid, _x_uuid)
                    _reach = path_result.probability
                except Exception:
                    pass
                _upstream_enabled = _reach > 0
                _upstream_obs = None
                if _upstream_enabled and query_from_node != anchor_node:
                    _af = subj_group[0].get('anchor_from', '')
                    _at = subj_group[0].get('anchor_to', '')
                    _sf = subj_group[0].get('sweep_from', _af)
                    _st = subj_group[0].get('sweep_to', _at)
                    # In whole-graph mode, pass all_per_edge_results so
                    # upstream edges' derivation frames are found in the
                    # cache instead of re-querying the DB. This gives
                    # downstream edges the same Tier 2 empirical carrier
                    # that the single-edge v3 path computes (doc 47 §Phase 4).
                    _upstream_cache = all_per_edge_results if is_whole_graph else per_edge_results
                    _upstream_obs = _fetch_upstream_observations(
                        graph_data=graph_data, anchor_node=anchor_node,
                        query_from_node=query_from_node,
                        per_edge_results=_upstream_cache,
                        candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
                        anchor_from=_af, anchor_to=_at, sweep_from=_sf, sweep_to=_st,
                        log_prefix='[forecast] upstream:',
                    )
                _x_provider = XProvider(
                    reach=_reach, upstream_params_list=_ingress,
                    enabled=_upstream_enabled,
                    ingress_carrier=_ingress if _ingress else None,
                    upstream_obs=_upstream_obs,
                )

            # ── Call v3 row builder and read scalars ────────────────
            # Call unconditionally when we have an edge id — the row
            # builder handles empty frames via the _non_latency_rows
            # fallback (prior-only rows). Class D (no α/β) produces
            # an empty maturity_rows and routes to skipped_edges
            # below. See doc 50 §§2-3.
            if last_edge_id:
                anchor_to_str = subj_group[0].get('anchor_to', '')
                maturity_rows = compute_cohort_maturity_rows_v3(
                    frames=composed_frames,
                    graph=graph_data,
                    target_edge_id=last_edge_id,
                    query_from_node=query_from_node or '',
                    query_to_node=query_to_node or '',
                    anchor_from=anchor_from_str,
                    anchor_to=anchor_to_str,
                    sweep_to=sweep_to_final,
                    is_window=is_window,
                    anchor_node_id=anchor_node,
                    mc_cdf_arr=_mc_cdf,
                    mc_p_s=_mc_p,
                    det_norm_cdf=_det_norm_cdf,
                    x_provider_override=_x_provider,
                    span_alpha=_span_alpha,
                    span_beta=_span_beta,
                    span_mu_sd=_span_params.mu_sd if _span_params else None,
                    span_sigma_sd=_span_params.sigma_sd if _span_params else None,
                    span_onset_sd=_span_params.onset_sd if _span_params else None,
                    span_onset_mu_corr=_span_params.onset_mu_corr if _span_params else None,
                    is_multi_hop=_is_multi_hop,
                    edge_cdf_arr=_edge_mc_cdf,
                )

                if maturity_rows:
                    last_row = maturity_rows[-1]
                    # p@∞: evaluated by the engine at saturation_tau
                    # (2·t95 window / 2·path_t95 cohort) off the same
                    # IS-conditioned rate_draws the chart uses. Falls
                    # back to last_row.midpoint for pre-fix callers /
                    # older snapshots that didn't surface p_infinity.
                    p_mean = last_row.get('p_infinity_mean')
                    p_sd = last_row.get('p_infinity_sd')
                    # Doc 49: epistemic SD (rate-only) alongside the
                    # default predictive SD (kappa-inflated). Funnel
                    # runner combines them via completeness weighting
                    # per doc 52 §3.5. Falls back to p_sd if absent.
                    p_sd_epistemic = last_row.get('p_infinity_sd_epistemic')
                    if p_mean is None:
                        p_mean = last_row.get('midpoint')
                        fan_upper = last_row.get('fan_upper')
                        fan_lower = last_row.get('fan_lower')
                        if p_sd is None and fan_upper is not None and fan_lower is not None and p_mean is not None:
                            p_sd = (fan_upper - fan_lower) / (2 * 1.645)
                    if p_sd_epistemic is None:
                        p_sd_epistemic = p_sd

                    # Doc 45 §Response contract: per-edge output MUST
                    # include `completeness` and `completeness_sd`. The
                    # engine (compute_forecast_trajectory) computes these
                    # once and cohort_forecast_v3 threads them onto
                    # every maturity row, so both the CF endpoint and
                    # the cohort maturity chart read the same scalar
                    # ("one computation, two reads").
                    completeness = last_row.get('completeness')
                    completeness_sd = last_row.get('completeness_sd')

                    # Scope-observed counts at horizon. v3 sets evidence_y
                    # (cumulative conversions, k) and evidence_x (cumulative
                    # arrivals, n) per maturity row from the cohort-scoped
                    # sweep — same source as the [sweep_diag] Y/X lines.
                    # Surface as evidence_k/evidence_n so callers (e.g. the
                    # funnel runner's compute_bars_e) can render the e
                    # component at the user's DSL scope rather than reading
                    # unscoped edge.evidence from the scenario graph.
                    evidence_k = last_row.get('evidence_y')
                    evidence_n = last_row.get('evidence_x')
                    # Non-latency / no-frame-evidence fallback: when the row
                    # builder went through _non_latency_rows with fe=None
                    # (narrow cohort, no usable frame composition),
                    # last_row.evidence_y/x are None. Fall back to summing
                    # across composed_frames — for each (anchor_day) take
                    # the latest snapshot's y/x and accumulate. Same scope,
                    # just re-derived without the frame composition step.
                    if (evidence_k is None or evidence_n is None) and composed_frames:
                        latest_yx_per_anchor: Dict[Any, Dict[str, Any]] = {}
                        for frame in composed_frames:
                            sd = frame.get('snapshot_date', '') or frame.get('as_at_date', '')
                            for dp in frame.get('data_points', []) or []:
                                ad = dp.get('anchor_day')
                                prev = latest_yx_per_anchor.get(ad)
                                if prev is None or sd > prev.get('_sd', ''):
                                    latest_yx_per_anchor[ad] = {
                                        'y': dp.get('y'),
                                        'x': dp.get('x'),
                                        '_sd': sd,
                                    }
                        sum_y = 0
                        sum_x = 0
                        for entry in latest_yx_per_anchor.values():
                            try:
                                sum_y += int(entry.get('y') or 0)
                                sum_x += int(entry.get('x') or 0)
                            except (TypeError, ValueError):
                                pass
                        if evidence_k is None:
                            evidence_k = sum_y
                        if evidence_n is None:
                            evidence_n = sum_x

                    last_entry = next(
                        (
                            entry for entry in per_edge_results
                            if entry.get('path_role') in ('last', 'only')
                        ),
                        None,
                    )
                    if last_entry is not None:
                        last_subject = last_entry.get('subject') or {}
                        file_supplement = _cf_supplement_evidence_counts_from_file(
                            graph_data=graph_data,
                            edge_uuid=last_edge_id,
                            anchor_from=last_subject.get('anchor_from', anchor_from_str),
                            anchor_to=last_subject.get('anchor_to', anchor_to_str),
                            snapshot_covered_days=last_entry.get('snapshot_covered_days') or set(),
                        )
                        if file_supplement.get('supplemented_days', 0) > 0:
                            evidence_k = (float(evidence_k) if evidence_k is not None else 0.0) + float(file_supplement['k'])
                            evidence_n = (float(evidence_n) if evidence_n is not None else 0.0) + float(file_supplement['n'])
                            print(
                                f"[forecast] supplemented {file_supplement['supplemented_days']} uncovered file days "
                                f"for {last_edge_id[:12]}… (+k={file_supplement['k']} +n={file_supplement['n']})"
                            )

                    if evidence_k is not None:
                        try:
                            evidence_k = int(round(float(evidence_k)))
                        except (TypeError, ValueError):
                            evidence_k = None
                    if evidence_n is not None:
                        try:
                            evidence_n = int(round(float(evidence_n)))
                        except (TypeError, ValueError):
                            evidence_n = None

                    from runner.forecast_state import _last_forensic
                    # Doc 52 §14.6: subset-conditioning provenance,
                    # stashed on the first row by v3 as a sentinel.
                    # Extract into a dedicated response block and remove
                    # from the row to keep the row schema clean.
                    first_row = maturity_rows[0] if maturity_rows else {}
                    _cond = first_row.pop('_conditioning', None) if isinstance(first_row, dict) else None
                    _cf_mode = (
                        first_row.pop('_cf_mode', 'sweep')
                        if isinstance(first_row, dict) else 'sweep'
                    )
                    _cf_reason = (
                        first_row.pop('_cf_reason', None)
                        if isinstance(first_row, dict) else None
                    )
                    # Whether observed evidence was actually applied to
                    # this edge's result (True) or the result is the
                    # untouched prior (False). Consumers that need to
                    # distinguish real conditioned output from
                    # prior-fallback output read this field directly;
                    # they should NOT infer it from the latency flag
                    # or from evidence_k/n.
                    _conditioned = first_row.pop('_conditioned', False) if isinstance(first_row, dict) else False
                    _forensic = (
                        {'cf_mode': _cf_mode, 'cf_reason': _cf_reason}
                        if _cf_mode == 'analytic_degraded'
                        else _last_forensic
                    )
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
                        'tau_max': last_row.get('tau'),
                        'n_rows': len(maturity_rows),
                        'n_cohorts': composed.get('cohorts_analysed', 0),
                        '_forensic': _forensic,
                        **({'conditioning': _cond} if _cond else {}),
                    })
                    print(f"[forecast] {scenario_id}: {query_from_node}→{query_to_node} "
                          f"p={p_mean:.4f} conditioned={bool(_conditioned)} "
                          f"tau_max={last_row.get('tau')} "
                          f"cohorts={composed.get('cohorts_analysed', 0)} "
                          f"rows={total_rows}")
                else:
                    # Class D — row builder returned []. This means the
                    # resolver had no usable α/β (no Bayes fit, no
                    # parameter-file evidence, no promoted source)
                    # AND no query-scoped snapshot rows. CF has
                    # literally nothing to report for this edge.
                    # See doc 50 §2 Class D + §3.2.
                    skipped_edges.append({
                        'edge_uuid': last_edge_id,
                        'reason': 'no prior and no evidence',
                    })
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

    return {"success": True, "scenarios": per_scenario_results}


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
    from snapshot_regime_selection import CandidateRegime, select_regime_rows, validate_mece_for_aggregation
    from runner.histogram_derivation import derive_lag_histogram
    from runner.daily_conversions_derivation import derive_daily_conversions
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from runner.lag_fit_derivation import derive_lag_fit
    from runner.forecast_application import annotate_rows, compute_completeness
    from runner.lag_distribution_utils import log_normal_cdf, log_normal_inverse_cdf, standard_normal_inverse_cdf

    analysis_type = data.get('analysis_type', 'lag_histogram')
    _is_cohort_maturity = analysis_type in ('cohort_maturity', 'cohort_maturity_v1')  # v2/v3 have own handlers
    scenarios = data.get('scenarios', [])
    # Doc 30 §4.1: MECE dimension names for aggregation safety.
    # Currently logged for diagnostics; enforcement in derivation
    # functions is a future hardening step.
    mece_dimensions = data.get('mece_dimensions', [])
    if mece_dimensions:
        print(f"[analyze] mece_dimensions: {mece_dimensions}")

    def _apply_regime_selection(rows: List[Dict], subj: Dict) -> List[Dict]:
        """Apply regime selection if candidate_regimes is present on the subject.

        Doc 30 §4.2: when candidate_regimes is provided, filter rows to
        one regime per retrieved_at date. When absent, return rows unchanged
        (backward compatible).
        """
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
        # Validate MECE safety if mece_dimensions provided
        if mece_dimensions and selection.rows:
            non_mece = validate_mece_for_aggregation(selection.rows, mece_dimensions)
            if non_mece:
                print(f"[regime_selection] WARNING: non-MECE dimensions in rows: {non_mece} "
                      f"(subject={subj.get('subject_id', '?')}). Aggregation over these dimensions may be unsafe.")
        return selection.rows

    def _resolve_promoted_source(model_params: Dict[str, Any], source_curves: Dict[str, Any]) -> Optional[str]:
        """Determine the actual promoted model source.

        Priority: explicit preference > bayesian > analytic_be > analytic.
        Returns the source name string, or None if no source available.
        """
        msp = model_params.get('promoted_source', 'best_available')
        if msp and msp != 'best_available' and msp in source_curves:
            return msp
        # best_available: prefer bayesian > analytic_be > analytic
        for candidate in ('bayesian', 'analytic_be', 'analytic'):
            if candidate in source_curves:
                return candidate
        return None

    def _resolve_completeness_params(model_params: Dict[str, Any], is_window: bool) -> tuple:
        """Select mu/sigma/onset based on query mode and path param availability.

        Returns (mu, sigma, onset, mode_tag).
        See doc 1 §16.1 truth table and §17.1 shared helper.
        """
        if is_window:
            return (model_params['mu'], model_params['sigma'],
                    model_params['onset_delta_days'], 'window')
        # cohort mode
        path_mu = model_params.get('path_mu')
        path_sigma = model_params.get('path_sigma')
        if path_mu is not None and path_sigma is not None:
            # Use path_onset_delta_days if available, fall back to edge onset
            path_onset = model_params.get('path_onset_delta_days',
                                           model_params['onset_delta_days'])
            return (path_mu, path_sigma, path_onset, 'cohort_path')
        return (model_params['mu'], model_params['sigma'],
                model_params['onset_delta_days'], 'cohort_edge_fallback')

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
            # Edge-level uncertainty SDs from the posterior
            for _post_key, _result_key in [
                ('mu_sd', 'bayes_mu_sd'),
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
            # Path-level uncertainty SDs from the posterior
            for _post_key, _result_key in [
                ('path_mu_sd', 'bayes_path_mu_sd'),
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
            if src not in ('analytic', 'analytic_be', 'bayesian'):
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
            # Bayesian source may carry its own SDs in model_vars; analytic/analytic_be
            # typically don't, so the band computation step falls back to edge-level
            # heuristic SDs from model_params.
            mv_q = mv.get('quality') or {}
            mv_prob_stdev = mv_prob.get('stdev')
            if isinstance(mv_prob_stdev, (int, float)) and math.isfinite(mv_prob_stdev) and mv_prob_stdev > 0:
                entry['p_stdev'] = float(mv_prob_stdev)
            mv_mu_sd = mv_lat.get('mu_sd')
            mv_sigma_sd = mv_lat.get('sigma_sd')
            mv_onset_sd = mv_lat.get('onset_sd')
            if isinstance(mv_mu_sd, (int, float)) and math.isfinite(mv_mu_sd) and mv_mu_sd > 0:
                entry['mu_sd'] = float(mv_mu_sd)
            if isinstance(mv_sigma_sd, (int, float)) and math.isfinite(mv_sigma_sd) and mv_sigma_sd > 0:
                entry['sigma_sd'] = float(mv_sigma_sd)
            if isinstance(mv_onset_sd, (int, float)) and math.isfinite(mv_onset_sd) and mv_onset_sd > 0:
                entry['onset_sd'] = float(mv_onset_sd)
            # Path-level uncertainty
            mv_pmu_sd = mv_lat.get('path_mu_sd')
            mv_psigma_sd = mv_lat.get('path_sigma_sd')
            mv_ponset_sd = mv_lat.get('path_onset_sd')
            if isinstance(mv_pmu_sd, (int, float)) and math.isfinite(mv_pmu_sd) and mv_pmu_sd > 0:
                entry['path_mu_sd'] = float(mv_pmu_sd)
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
            for _src_key, _dst_key in [
                ('promoted_mu_sd', 'bayes_mu_sd'),
                ('promoted_sigma_sd', 'bayes_sigma_sd'),
                ('promoted_onset_sd', 'bayes_onset_sd'),
                ('promoted_onset_mu_corr', 'bayes_onset_mu_corr'),
                ('promoted_path_mu_sd', 'bayes_path_mu_sd'),
                ('promoted_path_sigma_sd', 'bayes_path_sigma_sd'),
                ('promoted_path_onset_sd', 'bayes_path_onset_sd'),
            ]:
                _v = latency.get(_src_key)
                if isinstance(_v, (int, float)) and math.isfinite(_v) and (_v > 0 or 'corr' in _src_key):
                    result[_dst_key] = float(_v)

        return result

    def _append_synthetic_cohort_maturity_frames(args: Dict[str, Any]) -> None:
        """Thin wrapper — delegates to module-level _append_synthetic_frames_impl."""
        _append_synthetic_frames_impl(args)

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
            if subj.get('read_mode') == 'cohort_maturity' and _is_cohort_maturity:
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
                # Surprise gauge: compute directly from graph edge model_vars
                # and parameter file values. No snapshot query needed.
                graph_data = scenario.get('graph') or {}
                target_id = (subj.get('target') or {}).get('targetId')
                print(f"[surprise_gauge] target_id={target_id}, graph_edges={len(graph_data.get('edges', []))}")
                result = _compute_surprise_gauge(graph_data, target_id, subj, data)
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

                # Doc 30: apply regime selection before derivation
                rows = _apply_regime_selection(rows, subj)
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
                elif analysis_type == 'daily_conversions':
                    result = derive_daily_conversions(rows)
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
                elif _is_cohort_maturity:
                    # Fallback: cohort_maturity without cohort_maturity read_mode
                    result = derive_cohort_maturity(rows)
                else:
                    raise ValueError(f"Unknown analysis_type for snapshot: {analysis_type}")

            # ── Completeness annotation (Phase 6) ──────────────
            # If the graph edge has mu/sigma (from a prior recompute),
            # annotate each data point with completeness and layer.
            # This is naturally dormant until Phase 7 persists mu/sigma.
            graph = scenario.get('graph') or {}
            target_id = (subj.get('target') or {}).get('targetId')
            model_params = _read_edge_model_params(graph, target_id)

            # ── Test fixture: override model_params with fixture values ──
            # When a test fixture is active, the model curves / confidence
            # bands / maturity rows must ALL use the fixture's params, not
            # whatever the real graph edge happens to have.
            _test_fixture = data.get('test_fixture') or data.get('display_settings', {}).get('test_fixture')
            _ds = data.get('display_settings') or {}
            if _test_fixture and _is_cohort_maturity:
                from runner.cohort_forecast import load_test_fixture as _ltf
                _fixture_data = _ltf(_test_fixture)  # frames are static, never regenerated
                _ep = dict(_fixture_data['edge_params'])  # copy — we'll apply URL overrides

                # tf_ URL params override the MODEL, not the evidence.
                # This lets you move the Bayes curve / fan while keeping
                # evidence fixed, to see how the model fits the data.
                for _src, _dst in [('tf_onset', 'onset_delta_days'), ('tf_mu', 'mu'), ('tf_sigma', 'sigma')]:
                    _v = data.get(_src) or data.get('display_settings', {}).get(_src)
                    if _v is not None:
                        _ep[_dst] = float(_v)
                _tf_factor = data.get('tf_factor') or data.get('display_settings', {}).get('tf_factor')
                if _tf_factor is not None:
                    _ep['forecast_mean'] = _ep['forecast_mean'] * float(_tf_factor)

                # Also update edge_params in the fixture data so maturity rows use the same model
                _fixture_data['edge_params'] = _ep

                # Compute posterior_p from fixture graph's alpha/beta
                _fg = _fixture_data['graph']
                _fe = next((e for e in _fg.get('edges', []) if e.get('uuid') == _fixture_data['target_edge_id']), {})
                _fp = (_fe.get('p') or {}).get('posterior') or {}
                _fa, _fb = _fp.get('alpha', 0), _fp.get('beta', 0)
                _posterior_p = _fa / (_fa + _fb) if _fa > 0 and _fb > 0 else _ep.get('forecast_mean', 0.83)
                # If tf_factor changed p, override posterior_p too
                if _tf_factor is not None:
                    _posterior_p = _ep['forecast_mean']
                _p_sd_from_beta = math.sqrt(_fa * _fb / ((_fa + _fb) ** 2 * (_fa + _fb + 1))) if _fa > 0 and _fb > 0 else _ep.get('p_stdev', 0.05)
                model_params = {
                    'mu': _ep['mu'],
                    'sigma': _ep['sigma'],
                    'onset_delta_days': _ep['onset_delta_days'],
                    'forecast_mean': _ep['forecast_mean'],
                    'posterior_p': _posterior_p,
                    'p_stdev': _ep.get('p_stdev', _p_sd_from_beta),
                    'evidence_retrieved_at': _ep.get('evidence_retrieved_at'),
                    # Bayes keys (drive the promoted/bayesian model curve)
                    'bayes_mu': _ep['mu'],
                    'bayes_sigma': _ep['sigma'],
                    'bayes_onset': _ep['onset_delta_days'],
                    'bayes_mu_sd': _ep.get('bayes_mu_sd', 0.0),
                    'bayes_sigma_sd': _ep.get('bayes_sigma_sd', 0.0),
                    'bayes_onset_sd': _ep.get('bayes_onset_sd', 0.0),
                    'bayes_onset_mu_corr': _ep.get('bayes_onset_mu_corr', 0.0),
                    'promoted_source': 'bayesian',
                    # Carry axis_tau_max from fixture as t95 so model curve
                    # is generated even when sweep_span = 0 (zero-maturity query).
                    't95': _fixture_data.get('axis_tau_max', 60),
                }
                print(f"[test_fixture] model_params: mu={_ep['mu']} sigma={_ep['sigma']} "
                      f"onset={_ep['onset_delta_days']} p={_ep['forecast_mean']:.4f} "
                      f"posterior_p={_posterior_p:.4f}")

            if model_params and result:
                # Determine query mode once — used by both annotation and chart CDF.
                # See doc 1 §16.1 truth table: annotation and chart must use the
                # same resolved params (Divergence 1 fix).
                subj_slice_keys = subj.get('slice_keys') or []
                has_window_slice = any('window(' in str(sk) for sk in subj_slice_keys)
                has_cohort_slice = any('cohort(' in str(sk) for sk in subj_slice_keys)
                if has_window_slice or has_cohort_slice:
                    is_window = has_window_slice and not has_cohort_slice
                else:
                    # Check per-scenario effective_query_dsl first (carries
                    # the temporal mode), then top-level query_dsl as fallback.
                    _eff_dsl_mode = scenario.get('effective_query_dsl', '')
                    _top_dsl_mode = data.get('query_dsl') or ''
                    _combined_dsl = _eff_dsl_mode + ' ' + _top_dsl_mode
                    if 'cohort(' in _combined_dsl:
                        is_window = False
                    elif 'window(' in _combined_dsl:
                        is_window = True
                    else:
                        is_window = True  # default: window semantics

                mu, sigma, onset, cdf_mode = _resolve_completeness_params(model_params, is_window)

                # Extract forecast_mean for annotation (model-based projection)
                fm = model_params.get('forecast_mean', 0.0) or 0.0

                if _is_cohort_maturity and 'frames' in result:
                    for frame in result['frames']:
                        snapshot_date = frame.get('snapshot_date', '') or frame.get('as_at_date', '')
                        if frame.get('data_points'):
                            frame['data_points'] = annotate_rows(
                                frame['data_points'], mu, sigma, onset,
                                forecast_mean=fm,
                                retrieved_at_override=snapshot_date,
                            )
                    # Phase 2: append synthetic future frames (forecast-only tail).
                    # Parse tau_extent from display_settings (user-requested axis extent).
                    _te_raw = (data.get('display_settings') or {}).get('tau_extent')
                    _te_val = None
                    if _te_raw and str(_te_raw) not in ('auto', 'Auto'):
                        try:
                            _te_val = float(_te_raw)
                        except (ValueError, TypeError):
                            pass
                    _append_synthetic_cohort_maturity_frames({
                        'result': result,
                        'mu': mu,
                        'sigma': sigma,
                        'onset_delta_days': onset,
                        'forecast_mean': fm,
                        'anchor_to': subj.get('anchor_to'),
                        'tau_extent': _te_val,
                    })
                elif analysis_type == 'daily_conversions' and 'rate_by_cohort' in result:
                    # G.1b: route through forecast engine (coordinate B)
                    # instead of annotate_rows. Same codepath as topo pass.
                    _dc_annotated = False
                    try:
                        from runner.forecast_state import compute_forecast_trajectory, CohortEvidence
                        from runner.model_resolver import resolve_model_params as _rmp
                        from runner.forecast_application import compute_completeness as _cc
                        from runner.forecast_runtime import (
                            get_cf_mode_and_reason,
                            is_cf_sweep_eligible,
                        )

                        _edge_dict = next(
                            (e for e in graph.get('edges', [])
                             if e.get('uuid') == target_id),
                            None,
                        )
                        _temporal = 'window' if is_window else 'cohort'
                        _graph_pref = graph.get('model_source_preference')
                        _resolved = (_rmp(_edge_dict,
                                         scope='edge' if is_window else 'path',
                                         temporal_mode=_temporal,
                                         graph_preference=_graph_pref)
                                     if _edge_dict else None)

                        if _resolved and _resolved.latency.sigma > 0:
                            _cf_mode, _cf_reason = get_cf_mode_and_reason(_resolved)
                            result['cf_mode'] = _cf_mode
                            if _cf_reason is not None:
                                result['cf_reason'] = _cf_reason
                            # Parse asat date from DSL; default to today.
                            # DSL dates are d-MMM-yy (e.g. 16-Apr-26) or
                            # relative (e.g. -30d). Use the same parser as
                            # analysis_subject_resolution.
                            import re as _re
                            _eval_date_str = date.today().isoformat()
                            _eff_dsl = scenario.get('effective_query_dsl', '')
                            _asat_m = _re.search(r'(?:asat|at)\(([^)]*)\)', _eff_dsl)
                            if _asat_m and _asat_m.group(1).strip():
                                try:
                                    from analysis_subject_resolution import _resolve_date
                                    _eval_date_str = _resolve_date(_asat_m.group(1).strip())
                                except Exception:
                                    pass

                            # Build CohortEvidence per rate_by_cohort row.
                            # Use anchor_day + eval_date — the engine computes
                            # eval_age in __post_init__.
                            #
                            # Key: eval_age is set to the maturity horizon (t95),
                            # NOT the Cohort's actual age. The sweep produces
                            # draws at τ=t95 where the CDF has converged —
                            # giving the eventual total forecast (projected_y).
                            # The Cohort's real age is used only for completeness.
                            _lat = _resolved.latency
                            _t95 = int(math.ceil(_lat.t95)) if _lat.t95 > 0 else 60
                            _maturity_tau = max(_t95, 30)  # at least 30 days

                            _sweep_eligible = is_cf_sweep_eligible(_resolved)
                            _engine_cohorts = []
                            _row_map = []  # parallel index: row reference
                            _cohort_real_ages = []  # actual age per Cohort (for completeness)
                            for _row in result['rate_by_cohort']:
                                _ad_str = str(_row.get('date', ''))[:10]
                                _x = float(_row.get('x', 0) or 0)
                                _y = float(_row.get('y', 0) or 0)
                                if _x <= 0 or not _ad_str:
                                    continue
                                # Compute real age from dates
                                try:
                                    _ad = date.fromisoformat(_ad_str)
                                    _ed = date.fromisoformat(_eval_date_str[:10])
                                    _real_age = (_ed - _ad).days
                                except (ValueError, TypeError):
                                    continue
                                if _real_age < 0:
                                    continue
                                if _sweep_eligible:
                                    _engine_cohorts.append(CohortEvidence(
                                        obs_x=[_x],
                                        obs_y=[_y],
                                        x_frozen=_x,
                                        y_frozen=_y,
                                        # frontier = real age: the engine must know
                                        # where the evidence ends so IS conditioning
                                        # can fire (E_i = N_i × CDF(frontier_age)).
                                        # With frontier=0, CDF(0)≈0, E_i≈0, IS never
                                        # fires → unconditioned prior p → wildly wrong.
                                        frontier_age=_real_age,
                                        a_pop=_x,
                                        eval_age=_maturity_tau,  # read draws at maturity
                                    ))
                                _row_map.append(_row)
                                _cohort_real_ages.append(_real_age)

                            if not _sweep_eligible:
                                from scipy.stats import beta as _beta_dist

                                _alpha = max(float(_resolved.alpha or 0.0), 0.0)
                                _beta = max(float(_resolved.beta or 0.0), 0.0)
                                if _row_map and _alpha > 0 and _beta > 0:
                                    _p_mean = _alpha / (_alpha + _beta)
                                    _forecast_band_levels = [0.80, 0.90, 0.95, 0.99]
                                    _forecast_bands = {
                                        str(int(_bl * 100)): [
                                            float(_beta_dist.ppf((1 - _bl) / 2, _alpha, _beta)),
                                            float(_beta_dist.ppf((1 + _bl) / 2, _alpha, _beta)),
                                        ]
                                        for _bl in _forecast_band_levels
                                    }

                                    for _row, _real_age in zip(_row_map, _cohort_real_ages):
                                        _ev_y = float(_row.get('y', 0) or 0)
                                        _x = float(_row.get('x', 0) or 0)
                                        _c = _cc(_real_age, _lat.mu, _lat.sigma, _lat.onset_delta_days)
                                        _c = max(0.0, min(1.0, _c))
                                        _proj_y = _x * _p_mean
                                        _row['completeness'] = _c
                                        _row['evidence_y'] = _ev_y
                                        _row['projected_y'] = _proj_y
                                        _row['forecast_y'] = max(0.0, _proj_y - _ev_y)
                                        _row['layer'] = 'mature' if _c >= 0.95 else ('forecast' if _c > 1e-9 else 'evidence')
                                        if _x > 0:
                                            _row['forecast_bands'] = {
                                                _level: [float(_bounds[0]), float(_bounds[1])]
                                                for _level, _bounds in _forecast_bands.items()
                                            }
                                    _dc_annotated = True
                                    result['promoted_source'] = _resolved.source or 'best_available'
                                    print(f"[daily_conv] Degraded annotation: {len(_row_map)} cohorts, "
                                          f"conditioned={any((_r.get('completeness') or 0) > 0 for _r in _row_map)}, "
                                          f"maturity_tau={_maturity_tau}, "
                                          f"p_mean={_p_mean:.4f}, "
                                          f"alpha={_alpha:.2f}, beta={_beta:.2f}, "
                                          f"mu={_lat.mu:.3f}, sigma={_lat.sigma:.3f}, "
                                          f"source={_resolved.source}")

                                    # ── Latency bands (deterministic degraded path) ──
                                    _ds = data.get('display_settings') or {}
                                    if _ds.get('show_latency_bands') and _lat.sigma > 0:
                                        from runner.lag_distribution_utils import log_normal_inverse_cdf as _inv_cdf

                                        _band_taus = []
                                        for _q in [0.25, 0.50, 0.75]:
                                            _raw = _inv_cdf(_q, _lat.mu, _lat.sigma) + _lat.onset_delta_days
                                            _tau_d = max(1, round(_raw))
                                            if _tau_d not in [t for t, _ in _band_taus]:
                                                _band_taus.append((_tau_d, f'{_tau_d}d'))
                                        if not _band_taus:
                                            _band_taus = [(1, '1d')]

                                        _cohort_y_at_age_raw = result.get('cohort_y_at_age') or {}
                                        _obs_by_cohort_age: dict = {}
                                        for _ad_str, _ages in _cohort_y_at_age_raw.items():
                                            for _age_str, _y_val in _ages.items():
                                                _obs_by_cohort_age[(_ad_str, int(_age_str))] = float(_y_val)

                                        _latency_band_levels = [0.80, 0.90]
                                        _latency_band_lookup = {
                                            str(int(_bl * 100)): [
                                                float(_beta_dist.ppf((1 - _bl) / 2, _alpha, _beta)),
                                                float(_beta_dist.ppf((1 + _bl) / 2, _alpha, _beta)),
                                            ]
                                            for _bl in _latency_band_levels
                                        }

                                        for _row, _real_age in zip(_row_map, _cohort_real_ages):
                                            _x = float(_row.get('x', 0) or 0)
                                            _ad_str = str(_row.get('date', ''))[:10]
                                            if _x <= 0 or not _ad_str:
                                                continue
                                            for _bt, _bt_label in _band_taus:
                                                if _real_age >= _bt:
                                                    _obs_rate = None
                                                    for _look_age in range(_bt, -1, -1):
                                                        _obs_y = _obs_by_cohort_age.get((_ad_str, _look_age))
                                                        if _obs_y is not None:
                                                            _obs_rate = _obs_y / _x
                                                            break
                                                    if _obs_rate is not None:
                                                        if 'latency_bands' not in _row:
                                                            _row['latency_bands'] = {}
                                                        _row['latency_bands'][_bt_label] = {
                                                            'rate': _obs_rate,
                                                            'source': 'evidence',
                                                        }
                                                else:
                                                    _c_bt = _cc(_bt, _lat.mu, _lat.sigma, _lat.onset_delta_days)
                                                    _c_bt = max(0.0, min(1.0, _c_bt))
                                                    if 'latency_bands' not in _row:
                                                        _row['latency_bands'] = {}
                                                    _row['latency_bands'][_bt_label] = {
                                                        'rate': _p_mean * _c_bt,
                                                        'source': 'forecast',
                                                        'bands': {
                                                            _level: [float(_bounds[0] * _c_bt), float(_bounds[1] * _c_bt)]
                                                            for _level, _bounds in _latency_band_lookup.items()
                                                        },
                                                    }
                            elif _engine_cohorts:
                                _sweep = compute_forecast_trajectory(
                                    resolved=_resolved,
                                    cohorts=_engine_cohorts,
                                    max_tau=_maturity_tau,
                                )
                                _lat = _resolved.latency
                                if _sweep.cohort_evals and len(_sweep.cohort_evals) == len(_row_map):
                                    import numpy as _np
                                    for _ce, _row, _real_age in zip(_sweep.cohort_evals, _row_map, _cohort_real_ages):
                                        _proj_y = float(_np.mean(_ce.y_draws))
                                        _ev_y = float(_row.get('y', 0) or 0)
                                        _x = float(_row.get('x', 0) or 0)
                                        _c = _cc(_real_age, _lat.mu, _lat.sigma, _lat.onset_delta_days)
                                        _c = max(0.0, min(1.0, _c))
                                        _row['completeness'] = _c
                                        _row['evidence_y'] = _ev_y
                                        _row['projected_y'] = _proj_y
                                        _row['forecast_y'] = max(0.0, _proj_y - _ev_y)
                                        _row['layer'] = 'mature' if _c >= 0.95 else ('forecast' if _c > 1e-9 else 'evidence')
                                        # Forecast rate bands from MC draws
                                        if _x > 0 and len(_ce.y_draws) > 10:
                                            _rate_draws = _ce.y_draws / _x
                                            _row['forecast_bands'] = {
                                                '80': [float(_np.percentile(_rate_draws, 10)), float(_np.percentile(_rate_draws, 90))],
                                                '90': [float(_np.percentile(_rate_draws, 5)), float(_np.percentile(_rate_draws, 95))],
                                                '95': [float(_np.percentile(_rate_draws, 2.5)), float(_np.percentile(_rate_draws, 97.5))],
                                                '99': [float(_np.percentile(_rate_draws, 0.5)), float(_np.percentile(_rate_draws, 99.5))],
                                            }
                                    _dc_annotated = True
                                    # Propagate promoted_source for FE hint rendering
                                    result['promoted_source'] = _resolved.source or 'best_available'
                                    print(f"[daily_conv] Engine annotation: {len(_row_map)} cohorts, "
                                          f"IS_ESS={_sweep.is_ess:.0f}, "
                                          f"conditioned={_sweep.n_cohorts_conditioned}, "
                                          f"maturity_tau={_maturity_tau}, "
                                          f"p_mean={_resolved.p_mean:.4f}, "
                                          f"alpha={_resolved.alpha:.2f}, beta={_resolved.beta:.2f}, "
                                          f"mu={_lat.mu:.3f}, sigma={_lat.sigma:.3f}, "
                                          f"source={_resolved.source}")

                                    # ── Latency bands (optional) ──────────────────
                                    # Per-Cohort rate at fixed maturity τ values
                                    # (25th/50th/75th percentile of the latency CDF).
                                    # Evidence where age ≥ τ; forecast+fan where age < τ.
                                    _ds = data.get('display_settings') or {}
                                    if _ds.get('show_latency_bands') and _lat.sigma > 0:
                                        from runner.lag_distribution_utils import log_normal_inverse_cdf as _inv_cdf

                                        _band_taus = []
                                        for _q in [0.25, 0.50, 0.75]:
                                            _raw = _inv_cdf(_q, _lat.mu, _lat.sigma) + _lat.onset_delta_days
                                            _tau_d = max(1, round(_raw))
                                            if _tau_d not in [t for t, _ in _band_taus]:
                                                _band_taus.append((_tau_d, f'{_tau_d}d'))
                                        if not _band_taus:
                                            _band_taus = [(1, '1d')]

                                        # Per-(anchor_day, age) observed Y — from the derivation,
                                        # using the same per-series aggregation as the main rate.
                                        # Guaranteed consistent: Y at any age ≤ final Y.
                                        _cohort_y_at_age_raw = result.get('cohort_y_at_age') or {}
                                        _obs_by_cohort_age: dict = {}
                                        for _ad_str, _ages in _cohort_y_at_age_raw.items():
                                            for _age_str, _y_val in _ages.items():
                                                _obs_by_cohort_age[(_ad_str, int(_age_str))] = float(_y_val)

                                        # Run sweep per band τ and annotate rows
                                        _latency_band_results = {}
                                        for _bt, _bt_label in _band_taus:
                                            _band_cohorts = []
                                            _band_row_refs = []
                                            for _row, _real_age in zip(_row_map, _cohort_real_ages):
                                                _x = float(_row.get('x', 0) or 0)
                                                _y = float(_row.get('y', 0) or 0)
                                                _ad_str = str(_row.get('date', ''))[:10]
                                                if _x <= 0 or not _ad_str:
                                                    continue
                                                _band_cohorts.append(CohortEvidence(
                                                    obs_x=[_x],
                                                    obs_y=[_y],
                                                    x_frozen=_x,
                                                    y_frozen=_y,
                                                    frontier_age=min(_real_age, _bt),
                                                    a_pop=_x,
                                                    eval_age=_bt,
                                                ))
                                                _band_row_refs.append((_row, _real_age, _ad_str))

                                            if not _band_cohorts:
                                                continue

                                            _band_sweep = compute_forecast_trajectory(
                                                resolved=_resolved,
                                                cohorts=_band_cohorts,
                                                max_tau=_bt,
                                            )

                                            if _band_sweep.cohort_evals and len(_band_sweep.cohort_evals) == len(_band_row_refs):
                                                for _bce, (_row, _real_age, _ad_str) in zip(_band_sweep.cohort_evals, _band_row_refs):
                                                    _x = float(_row.get('x', 0) or 0)
                                                    if _x <= 0:
                                                        continue
                                                    if _real_age >= _bt:
                                                        # Evidence: find observed y at age ≤ τ,
                                                        # divided by FINAL x (not snapshot x).
                                                        # y accumulates monotonically; rate at
                                                        # age τ must be ≤ rate at maturity.
                                                        _obs_rate = None
                                                        for _look_age in range(_bt, -1, -1):
                                                            _obs_y = _obs_by_cohort_age.get((_ad_str, _look_age))
                                                            if _obs_y is not None:
                                                                _obs_rate = _obs_y / _x  # y_at_age / x_final
                                                                break
                                                        if _obs_rate is not None:
                                                            if 'latency_bands' not in _row:
                                                                _row['latency_bands'] = {}
                                                            _row['latency_bands'][_bt_label] = {
                                                                'rate': _obs_rate,
                                                                'source': 'evidence',
                                                            }
                                                    else:
                                                        # Forecast: use engine draws
                                                        _rate_draws = _bce.y_draws / _x
                                                        _median = float(_np.median(_rate_draws))
                                                        _bands = {
                                                            '80': [float(_np.percentile(_rate_draws, 10)), float(_np.percentile(_rate_draws, 90))],
                                                            '90': [float(_np.percentile(_rate_draws, 5)), float(_np.percentile(_rate_draws, 95))],
                                                        }
                                                        if 'latency_bands' not in _row:
                                                            _row['latency_bands'] = {}
                                                        _row['latency_bands'][_bt_label] = {
                                                            'rate': _median,
                                                            'source': 'forecast',
                                                            'bands': _bands,
                                                        }

                                        _active_bands = [lb for _, lb in _band_taus]
                                        print(f"[daily_conv] Latency bands: {_active_bands}")

                    except Exception as _dc_err:
                        import traceback as _tb
                        print(f"[daily_conv] WARNING: engine annotation failed: {_dc_err}")
                        _tb.print_exc()

                    if not _dc_annotated:
                        # Fallback: legacy annotate_rows (produces zeros
                        # due to field name mismatch — but avoids crash)
                        result['rate_by_cohort'] = annotate_rows(
                            result['rate_by_cohort'], mu, sigma, onset,
                            forecast_mean=fm,
                        )

                # ── Model CDF curve (cohort maturity only) ──────────────
                # Generate the theoretical cumulative lognormal curve so the
                # frontend can overlay it on the empirical maturity chart.
                # Uses the same resolved params as annotation (doc 1 §17.1).
                is_gap_epoch = any(str(sk) == '__epoch_gap__' for sk in subj_slice_keys)

                if _is_cohort_maturity and ('forecast_mean' in model_params or 'posterior_p' in model_params) and not is_gap_epoch:
                    # Doc 25 §3.3: prefer posterior p over forecast_mean.
                    # In cohort mode, use cohort p (path-level); in window mode, use window p (edge-level).
                    if not is_window and 'posterior_p_cohort' in model_params:
                        forecast_mean = model_params['posterior_p_cohort']
                    else:
                        forecast_mean = model_params.get('posterior_p') or model_params.get('forecast_mean')

                    cdf_mu = mu
                    cdf_sigma = sigma
                    cdf_onset = onset

                    # Resolve the actual promoted source and override CDF params
                    # to use that source's latency, not the mixed generic params.
                    # Without this, cohort mode uses analytic path_mu/path_sigma
                    # even when the promoted source should be bayesian.
                    _src_curves = model_params.get('source_curves') or {}
                    _promoted_source = _resolve_promoted_source(model_params, _src_curves)
                    if _promoted_source and _promoted_source in _src_curves:
                        _ps = _src_curves[_promoted_source]
                        if cdf_mode == 'cohort_path' and _promoted_source != 'bayesian':
                            _p_mu = _ps.get('path_mu')
                            _p_sigma = _ps.get('path_sigma')
                            if _p_mu is not None and _p_sigma is not None and _p_sigma > 0:
                                cdf_mu = _p_mu
                                cdf_sigma = _p_sigma
                                cdf_onset = _ps.get('path_onset_delta_days', _ps.get('onset_delta_days', 0.0))
                        elif _promoted_source == 'bayesian':
                            # Bayesian: prefer path params from model_params (from posterior),
                            # fall back to edge-level bayesian params.
                            _bp_mu = model_params.get('bayes_path_mu')
                            _bp_sigma = model_params.get('bayes_path_sigma')
                            if cdf_mode == 'cohort_path' and _bp_mu is not None and _bp_sigma is not None and _bp_sigma > 0:
                                cdf_mu = _bp_mu
                                cdf_sigma = _bp_sigma
                                cdf_onset = model_params.get('bayes_path_onset', model_params.get('bayes_onset', 0.0))
                            else:
                                cdf_mu = model_params.get('bayes_mu', cdf_mu)
                                cdf_sigma = model_params.get('bayes_sigma', cdf_sigma)
                                cdf_onset = model_params.get('bayes_onset', cdf_onset)

                    # Axis extent: use the resolved global extent so all
                    # scenarios in this request share the same tau range.
                    # _max_sweep_span and _tau_extent_resolved are computed
                    # once before the per-subject loop.
                    anchor_from_str = subj.get('anchor_from', '')
                    sweep_to_str = subj.get('sweep_to', '')
                    sweep_span = None
                    try:
                        if anchor_from_str and sweep_to_str:
                            af = date.fromisoformat(str(anchor_from_str)[:10])
                            st = date.fromisoformat(str(sweep_to_str)[:10])
                            sweep_span = (st - af).days
                    except (ValueError, TypeError):
                        pass

                    edge_t95_val = model_params.get('t95')
                    path_t95_val = model_params.get('path_t95')

                    # Include user-requested tau_extent from display_settings.
                    # The FE resolves 'auto' to the max sweep span across all
                    # scenarios before sending, so a concrete number arrives here.
                    _tau_extent_raw = (data.get('display_settings') or {}).get('tau_extent')
                    _tau_extent = None
                    if _tau_extent_raw and str(_tau_extent_raw) not in ('auto', 'Auto'):
                        try:
                            _tau_extent = float(_tau_extent_raw)
                        except (ValueError, TypeError):
                            pass

                    candidates = [c for c in [sweep_span, edge_t95_val, path_t95_val, _tau_extent] if c and c > 0]
                    axis_tau_max = int(math.ceil(max(candidates))) if candidates else None

                    if axis_tau_max and axis_tau_max > 0:
                        # Promoted model curve (backward-compatible: model_curve / model_curve_params)
                        curve = []
                        for tau in range(0, axis_tau_max + 1):
                            c = compute_completeness(float(tau), cdf_mu, cdf_sigma, cdf_onset)
                            c = max(0.0, min(1.0, float(c)))
                            curve.append({
                                'tau_days': tau,
                                'model_rate': round(forecast_mean * c, 8),
                            })
                        result['model_curve'] = curve
                        result['model_curve_params'] = {
                            'mu': cdf_mu,
                            'sigma': cdf_sigma,
                            'onset_delta_days': cdf_onset,
                            'forecast_mean': forecast_mean,
                            'mode': cdf_mode,
                            'promoted_source': _promoted_source or 'unknown',
                        }

                        # Method B comparison curve (old approach)
                        if cdf_mode == 'cohort_path':
                            edge_onset = model_params['onset_delta_days']
                            path_onset_val = model_params.get('path_onset_delta_days')
                            if (isinstance(path_onset_val, (int, float))
                                    and path_onset_val > edge_onset + 0.01):
                                upstream_onset = path_onset_val - edge_onset
                                mu_b = math.log(upstream_onset + math.exp(cdf_mu))
                                sigma_b = cdf_sigma
                                curve_b = []
                                for tau in range(0, axis_tau_max + 1):
                                    cb = compute_completeness(
                                        float(tau), mu_b, sigma_b, edge_onset,
                                    )
                                    cb = max(0.0, min(1.0, float(cb)))
                                    curve_b.append({
                                        'tau_days': tau,
                                        'model_rate': round(forecast_mean * cb, 8),
                                    })
                                result['model_curve_method_b'] = curve_b
                                result['model_curve_method_b_params'] = {
                                    'mu': mu_b,
                                    'sigma': sigma_b,
                                    'onset_delta_days': edge_onset,
                                    'forecast_mean': forecast_mean,
                                    'mode': 'cohort_path_method_b',
                                }

                        # --- Per-source model curves ---
                        # Each source gets its own CDF curve, enabling the
                        # frontend to toggle analytic/analytic_be/bayesian overlays
                        # independently via display settings.
                        #
                        # Bayesian source: reads directly from the posterior on
                        # the graph edge (the authoritative Bayes data), NOT from
                        # model_vars which is a copy that may be stale/incomplete.
                        # Analytic sources: read from model_vars as before.
                        source_curves = model_params.get('source_curves') or {}
                        _ds = data.get('display_settings') or {}
                        source_curve_results: Dict[str, Any] = {}

                        # Build the bayesian source curve from the posterior
                        # directly — this is the canonical Bayes output.
                        if 'bayes_mu' in model_params:
                            if cdf_mode == 'cohort_path' and 'bayes_path_mu' in model_params:
                                s_mu = model_params['bayes_path_mu']
                                s_sigma = model_params['bayes_path_sigma']
                                s_onset = model_params.get('bayes_path_onset', 0.0)
                                s_mu_sd = model_params.get('bayes_path_mu_sd')
                                s_sigma_sd = model_params.get('bayes_path_sigma_sd')
                                s_onset_sd = model_params.get('bayes_path_onset_sd')
                            else:
                                s_mu = model_params['bayes_mu']
                                s_sigma = model_params['bayes_sigma']
                                s_onset = model_params.get('bayes_onset', 0.0)
                                s_mu_sd = model_params.get('bayes_mu_sd')
                                s_sigma_sd = model_params.get('bayes_sigma_sd')
                                s_onset_sd = model_params.get('bayes_onset_sd')
                            if not is_window and 'posterior_p_cohort' in model_params:
                                s_fm = model_params['posterior_p_cohort']
                            elif 'posterior_p' in model_params:
                                s_fm = model_params['posterior_p']
                            else:
                                s_fm = forecast_mean
                            bayes_entry_dict: Dict[str, Any] = {
                                'mu': s_mu, 'sigma': s_sigma,
                                'onset_delta_days': s_onset,
                                'forecast_mean': s_fm,
                            }
                            if s_mu_sd is not None:
                                bayes_entry_dict['mu_sd'] = s_mu_sd
                            if s_sigma_sd is not None:
                                bayes_entry_dict['sigma_sd'] = s_sigma_sd
                            if s_onset_sd is not None:
                                bayes_entry_dict['onset_sd'] = s_onset_sd
                            if not is_window and 'p_stdev_cohort' in model_params:
                                bayes_entry_dict['p_stdev'] = model_params['p_stdev_cohort']
                            elif 'p_stdev' in model_params:
                                bayes_entry_dict['p_stdev'] = model_params['p_stdev']
                            source_curves['bayesian'] = bayes_entry_dict

                        for src_name, src_params in source_curves.items():
                            s_mu = src_params.get('mu')
                            s_sigma = src_params.get('sigma')
                            s_onset = src_params.get('onset_delta_days', 0.0)
                            s_fm = src_params.get('forecast_mean', forecast_mean)
                            if s_mu is None or s_sigma is None:
                                continue

                            # For non-bayesian sources in cohort mode, use path params.
                            # No fallback to edge params — if path params are missing,
                            # skip this source entirely so the defect is visible.
                            if cdf_mode == 'cohort_path' and src_name != 'bayesian':
                                s_pmu = src_params.get('path_mu')
                                s_psigma = src_params.get('path_sigma')
                                s_ponset = src_params.get('path_onset_delta_days')
                                if s_pmu is not None and s_psigma is not None and s_psigma > 0:
                                    s_mu = s_pmu
                                    s_sigma = s_psigma
                                    if s_ponset is not None:
                                        s_onset = s_ponset
                                else:
                                    print(f"[source_curve] SKIPPING {src_name}: cohort_path mode but path_mu={s_pmu} path_sigma={s_psigma} — FE topo pass did not produce path params")
                                    continue

                            s_curve = []
                            for tau in range(0, axis_tau_max + 1):
                                sc = compute_completeness(float(tau), s_mu, s_sigma, s_onset)
                                sc = max(0.0, min(1.0, float(sc)))
                                s_curve.append({
                                    'tau_days': tau,
                                    'model_rate': round(s_fm * sc, 8),
                                })
                            src_entry: Dict[str, Any] = {
                                'curve': s_curve,
                                'params': {
                                    'mu': s_mu,
                                    'sigma': s_sigma,
                                    'onset_delta_days': s_onset,
                                    'forecast_mean': s_fm,
                                    'source': src_name,
                                },
                            }

                            # Confidence bands (covariance-aware delta method) — all sources.
                            # In cohort_path mode, use path-level SDs to match the
                            # path-level mu/sigma the curve uses.
                            from runner.confidence_bands import compute_confidence_band
                            _use_path = (cdf_mode == 'cohort_path')
                            band_mu_sd = (
                                (src_params.get('path_mu_sd') if _use_path else None)
                                or src_params.get('mu_sd')
                                or model_params.get('bayes_path_mu_sd' if _use_path else 'bayes_mu_sd', 0.0)
                                or 0.0
                            )
                            band_sigma_sd = (
                                (src_params.get('path_sigma_sd') if _use_path else None)
                                or src_params.get('sigma_sd')
                                or model_params.get('bayes_path_sigma_sd' if _use_path else 'bayes_sigma_sd', 0.0)
                                or 0.0
                            )
                            band_onset_sd = (
                                (src_params.get('path_onset_sd') if _use_path else None)
                                or src_params.get('onset_sd')
                                or model_params.get('bayes_path_onset_sd' if _use_path else 'bayes_onset_sd', 0.0)
                                or 0.0
                            )
                            band_p_sd = src_params.get('p_stdev', 0.0) or model_params.get('p_stdev', 0.0) or 0.0
                            band_onset_mu_corr = model_params.get('bayes_path_onset_mu_corr') if _use_path else model_params.get('bayes_onset_mu_corr', 0.0)
                            if band_onset_mu_corr is None:
                                band_onset_mu_corr = 0.0

                            # Model overlay band always uses 90% — independent of
                            # the fan chart band setting (which controls the fan only).
                            band_level = 0.90

                            if band_mu_sd > 0:
                                ages = list(range(0, axis_tau_max + 1))
                                upper_rates, lower_rates, _median_rates = compute_confidence_band(
                                    ages=ages,
                                    p=s_fm, mu=s_mu, sigma=s_sigma, onset=s_onset,
                                    p_sd=band_p_sd, mu_sd=band_mu_sd,
                                    sigma_sd=band_sigma_sd, onset_sd=band_onset_sd,
                                    onset_mu_corr=band_onset_mu_corr,
                                    level=band_level,
                                )
                                src_entry['band_upper'] = [
                                    {'tau_days': t, 'model_rate': round(r, 8)}
                                    for t, r in zip(ages, upper_rates)
                                ]
                                src_entry['band_lower'] = [
                                    {'tau_days': t, 'model_rate': round(r, 8)}
                                    for t, r in zip(ages, lower_rates)
                                ]

                            source_curve_results[src_name] = src_entry

                        if source_curve_results:
                            result['source_model_curves'] = source_curve_results
                            result['promoted_source'] = _promoted_source or model_params.get('promoted_source', 'best_available')

                    # ── Cohort maturity complete rows ──────────────────
                    # Compute per-τ rows with rate, midpoint, fan bounds.
                    # All computation here — the FE just draws.
                    if (_is_cohort_maturity
                            and ('frames' in result or _test_fixture)
                            and subj.get('anchor_from') and subj.get('anchor_to')
                            and subj.get('sweep_to')):
                        try:
                            from runner.cohort_forecast import compute_cohort_maturity_rows

                            # Thread COHORT_DRIFT_FRACTION from forecasting settings
                            _fc_settings = data.get('forecasting_settings') or {}
                            _drift = _fc_settings.get('COHORT_DRIFT_FRACTION')
                            if _drift is not None and model_params:
                                model_params['cohort_drift_fraction'] = float(_drift)

                            # Resolve band level from display settings
                            _bl_str = str(_ds.get('bayes_band_level', 'blend'))
                            _bl_map = {'80': 0.80, '90': 0.90, '95': 0.95, '99': 0.99, 'blend': 0.90}
                            _fan_band_level = _bl_map.get(_bl_str, 0.90)

                            # Sampling mode: 'binomial', 'normal', or 'none'
                            _sampling_mode = str(_ds.get('continuous_forecast', 'binomial'))

                            # Resolve anchor node for cohort mode
                            _anchor_node_id = None
                            if not is_window and target_id:
                                try:
                                    from graph_types import Graph as _Graph
                                    from msmdc import compute_anchor_node_id as _compute_anchor
                                    _g_model = _Graph.model_validate(graph)
                                    _target_edge = next(
                                        (e for e in _g_model.edges if e.uuid == target_id), None)
                                    if _target_edge:
                                        _anchor_node_id = _compute_anchor(_g_model, _target_edge)
                                except Exception as _e:
                                    # Truncate to first line — full Pydantic dumps are extremely verbose
                                    _e_first = str(_e).split('\n')[0][:120]
                                    if _COHORT_DEBUG:
                                        print(f"[anchor_resolve] Failed: {_e}")
                                    else:
                                        print(f"[anchor_resolve] Failed (set DAGNET_COHORT_DEBUG=1 for detail): {_e_first}")

                            # Test fixture fork: use fixture's frames/graph/edge_params
                            # but the APP's query dates (anchor_from/to, sweep_to)
                            # so the user can control the date window from the UI.
                            if _test_fixture:
                                print(f"[test_fixture_dates] anchor_from={subj['anchor_from']} anchor_to={subj['anchor_to']} sweep_to={subj['sweep_to']}")
                                maturity_rows = compute_cohort_maturity_rows(
                                    frames=_fixture_data['frames'],
                                    graph=_fixture_data['graph'],
                                    target_edge_id=_fixture_data['target_edge_id'],
                                    edge_params=_fixture_data['edge_params'],
                                    anchor_from=subj['anchor_from'],
                                    anchor_to=subj['anchor_to'],
                                    sweep_to=subj['sweep_to'],
                                    is_window=_fixture_data.get('is_window', is_window),
                                    axis_tau_max=_fixture_data.get('axis_tau_max'),
                                    band_level=_fan_band_level,
                                    anchor_node_id=_fixture_data.get('anchor_node_id'),
                                    sampling_mode=_sampling_mode,
                                )
                            else:
                                # For unified epoch subjects, derive the date
                                # range from the actual frames (not subject
                                # metadata, which may all carry the same epoch).
                                _all_anchor_days = []
                                for _f in result.get('frames', []):
                                    for _dp in (_f.get('data_points') or []):
                                        _ad = _dp.get('anchor_day')
                                        if _ad:
                                            _all_anchor_days.append(str(_ad)[:10])
                                _epoch_sibs = _epoch_subjects.get(base_sid, [subj])
                                if _all_anchor_days:
                                    _unified_anchor_from = min(_all_anchor_days)
                                    _unified_anchor_to = max(_all_anchor_days)
                                else:
                                    _unified_anchor_from = min(s['anchor_from'] for s in _epoch_sibs)
                                    _unified_anchor_to = max(s['anchor_to'] for s in _epoch_sibs)
                                _unified_sweep_to = max(s.get('sweep_to', s['anchor_to']) for s in _epoch_sibs)

                                if _COHORT_DEBUG:
                                    print(f"[pre_compute] frames={len(result.get('frames',[]))} anchor={_unified_anchor_from}..{_unified_anchor_to} sweep={_unified_sweep_to}", flush=True)
                                maturity_rows = compute_cohort_maturity_rows(
                                    frames=result['frames'],
                                    graph=graph,
                                    target_edge_id=target_id,
                                    edge_params=model_params,
                                    anchor_from=_unified_anchor_from,
                                    anchor_to=_unified_anchor_to,
                                    sweep_to=_unified_sweep_to,
                                    is_window=is_window,
                                    axis_tau_max=axis_tau_max,
                                    band_level=_fan_band_level,
                                    sampling_mode=_sampling_mode,
                                    anchor_node_id=_anchor_node_id,
                                )
                            _sd_keys = {k: v for k, v in model_params.items() if 'sd' in k.lower() or 'stdev' in k.lower() or 'corr' in k.lower()}
                            print(f"[cohort_maturity_rows] Computed {len(maturity_rows)} rows for {subj.get('subject_id', '?')[:40]}  is_window={is_window}  SDs={_sd_keys}")
                            if maturity_rows:
                                result['maturity_rows'] = maturity_rows
                        except Exception as e:
                            print(f"[cohort_maturity_rows] Error: {e}")
                            import traceback; traceback.print_exc()

            # ── Fallback maturity rows (no Bayes params) ─────────
            # If the model_params guard above didn't fire, still produce
            # basic maturity_rows (rate/projected_rate, no fan/midpoint)
            # so the FE has data to draw.
            if (_is_cohort_maturity
                    and result and 'frames' in result
                    and 'maturity_rows' not in result
                    and subj.get('anchor_from') and subj.get('anchor_to')
                    and subj.get('sweep_to')):
                try:
                    from runner.cohort_forecast import compute_cohort_maturity_rows
                    _graph = graph if graph else (scenario.get('graph') or {})
                    _tid = target_id if target_id else ((subj.get('target') or {}).get('targetId') or '')
                    _is_win = 'window(' in str(data.get('query_dsl', ''))

                    # Resolve anchor node for cohort mode (mirrors primary path)
                    _fb_anchor_node_id = None
                    if not _is_win and _tid:
                        try:
                            from graph_types import Graph as _Graph
                            from msmdc import compute_anchor_node_id as _compute_anchor
                            _g_model = _Graph.model_validate(_graph)
                            _target_edge = next(
                                (e for e in _g_model.edges if e.uuid == _tid), None)
                            if _target_edge:
                                _fb_anchor_node_id = _compute_anchor(_g_model, _target_edge)
                        except Exception as _e:
                            _e_first = str(_e).split('\n')[0][:120]
                            if _COHORT_DEBUG:
                                print(f"[anchor_resolve fallback] Failed: {_e}")
                            else:
                                print(f"[anchor_resolve fallback] Failed: {_e_first}")

                    maturity_rows = compute_cohort_maturity_rows(
                        frames=result['frames'],
                        graph=_graph,
                        target_edge_id=_tid,
                        edge_params={},
                        anchor_from=subj['anchor_from'],
                        anchor_to=subj['anchor_to'],
                        sweep_to=subj['sweep_to'],
                        is_window=_is_win,
                        anchor_node_id=_fb_anchor_node_id,
                    )
                    if maturity_rows:
                        result['maturity_rows'] = maturity_rows
                except Exception as e:
                    print(f"[cohort_maturity_rows fallback] Error: {e}")

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


def handle_stats_topo_pass(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run the BE analytic stats/topo pass on a graph.

    SUBSYSTEM GUIDE — When to call this (see docs/current/codebase/
    STATS_SUBSYSTEMS.md §3.3 "BE topo pass"):
      - This is the ANALYTIC topo pass producing `analytic_be`
        model_vars (mu, sigma, t95, path_t95, completeness, p_infinity,
        blended_mean + heuristic dispersion SDs) via Fenton-Wilkinson
        composition on query-scoped cohort data. Python port of FE
        `enhanceGraphLatencies`.
      - This is NOT the sophisticated BE CF pass. The CF pass lives
        in `handle_conditioned_forecast` (/api/forecast/conditioned,
        §3.4 in STATS_SUBSYSTEMS.md) and produces IS-conditioned
        per-edge (p_mean, p_sd, completeness, completeness_sd) via
        full MC with snapshot DB evidence and topo-sequenced upstream
        carrier propagation.
      - Analysis runners SHOULD NOT call this directly. The fetch
        pipeline invokes it fire-and-forget alongside the FE topo
        pass and CF pass. If an analysis needs evidence-conditioned
        scalars, it wants `handle_conditioned_forecast`, not this.

    Computes per-edge latency stats (mu, sigma, t95, path_t95, completeness,
    p_infinity, blended_mean) and path-level lognormal params (path_mu,
    path_sigma, path_onset_delta_days) via a topological traversal with
    Fenton-Wilkinson composition.

    This is the Python port of FE enhanceGraphLatencies().

    Request shape:
      - graph: full graph snapshot (nodes, edges)
      - cohort_data: dict of edge_uuid → list of cohort data dicts
            Each cohort dict: {date, age, n, k, median_lag_days?,
            mean_lag_days?, anchor_median_lag_days?, anchor_mean_lag_days?}
      - forecasting_settings: optional settings object

    Returns:
      - edges: list of per-edge results with latency scalars
      - summary: {edges_processed, edges_with_lag}
    """
    from runner.stats_engine import (
        CohortData,
        EdgeContext,
        enhance_graph_latencies,
    )
    from runner.forecasting_settings import settings_from_dict

    graph = data.get('graph', {})
    if not graph:
        raise ValueError("Missing required 'graph' field")

    settings_raw = data.get('forecasting_settings')
    settings = settings_from_dict(settings_raw) if settings_raw else None

    def _parse_cohorts(cohort_list: list) -> list:
        parsed = []
        for c in cohort_list:
            parsed.append(CohortData(
                date=c.get('date', ''),
                age=float(c.get('age', 0)),
                n=int(c.get('n', 0)),
                k=int(c.get('k', 0)),
                anchor_median_lag_days=c.get('anchor_median_lag_days'),
                anchor_mean_lag_days=c.get('anchor_mean_lag_days'),
                median_lag_days=c.get('median_lag_days'),
                mean_lag_days=c.get('mean_lag_days'),
            ))
        return parsed

    # Parse cohort data per edge
    raw_cohorts = data.get('cohort_data', {})
    param_lookup: Dict[str, list] = {}
    for edge_id, cohort_list in raw_cohorts.items():
        param_lookup[edge_id] = _parse_cohorts(cohort_list)

    # Parse per-edge context (onset from window slices, window cohorts, nBaseline)
    raw_contexts = data.get('edge_contexts', {})
    edge_contexts: Dict[str, EdgeContext] = {}
    for edge_id, ctx_dict in raw_contexts.items():
        window_cohorts = None
        if ctx_dict.get('window_cohorts'):
            window_cohorts = _parse_cohorts(ctx_dict['window_cohorts'])
        scoped_cohorts = None
        if ctx_dict.get('scoped_cohorts'):
            scoped_cohorts = _parse_cohorts(ctx_dict['scoped_cohorts'])
        edge_contexts[edge_id] = EdgeContext(
            onset_from_window_slices=ctx_dict.get('onset_from_window_slices'),
            window_cohorts=window_cohorts,
            n_baseline_from_window=ctx_dict.get('n_baseline_from_window'),
            scoped_cohorts=scoped_cohorts,
        )

    # D1 FIX: parse query_mode so BE can match FE's cohort/window semantics
    query_mode = data.get('query_mode', 'cohort')  # default cohort for backward compat

    # D5 FIX: parse FE-computed active edge set
    raw_active_edges = data.get('active_edges')
    active_edges_set = set(raw_active_edges) if isinstance(raw_active_edges, list) else None

    result = enhance_graph_latencies(
        graph, param_lookup, settings, edge_contexts,
        query_mode=query_mode, active_edges=active_edges_set,
    )

    # If FE outputs were sent alongside, write the golden fixture to debug/
    fe_outputs = data.get('fe_outputs')
    if fe_outputs:
        import json as _json
        import os as _os
        debug_dir = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), '..', 'debug')
        _os.makedirs(debug_dir, exist_ok=True)
        fixture_path = _os.path.join(debug_dir, 'tmp.topo-pass-golden.json')
        with open(fixture_path, 'w') as _f:
            _json.dump({
                'inputs': {
                    'graph': data.get('graph'),
                    'cohort_data': data.get('cohort_data'),
                    'edge_contexts': data.get('edge_contexts'),
                    'forecasting_settings': data.get('forecasting_settings'),
                },
                'fe_outputs': fe_outputs,
            }, _f, indent=2)
        print(f'[lag/topo-pass] Golden fixture written to {fixture_path}')

    # ── Compute forecast per edge via shared engine (doc 29f §G.1) ──
    # Uses the same _evaluate_cohort primitive as the cohort maturity
    # chart (coordinate B: per-cohort at each cohort's own age,
    # aggregated into scalars).
    import time as _time
    _fs_t0 = _time.monotonic()
    from runner.model_resolver import resolve_model_params
    from runner.forecast_state import (
        compute_forecast_trajectory,
        CohortEvidence,
        NodeArrivalState,
        build_node_arrival_cache,
    )
    import numpy as _np

    edges_by_uuid = {}
    for e in graph.get('edges', []):
        eid = str(e.get('uuid', e.get('id', '')))
        edges_by_uuid[eid] = e

    is_window = query_mode in ('window', 'none')

    # Phase 3: build per-node arrival cache for cohort-mode edges
    _node_arrival_cache = None
    if not is_window:
        try:
            _anchor_id = None
            for n in graph.get('nodes', []):
                if (n.get('entry') or {}).get('is_start'):
                    _anchor_id = n.get('uuid') or n.get('id')
                    break
            if _anchor_id is None and graph.get('nodes'):
                _anchor_id = graph['nodes'][0].get('uuid') or graph['nodes'][0].get('id', '')
            if _anchor_id:
                _node_arrival_cache = build_node_arrival_cache(
                    graph, anchor_id=_anchor_id, max_tau=400)
        except Exception as _e:
            print(f"[topo-pass] WARNING: node arrival cache failed: {_e}")

    edges_out = []
    _fs_count = 0
    for ev in result.edge_values:
        fs = None
        improved_p_sd = ev.p_sd
        edge_dict = edges_by_uuid.get(ev.edge_uuid)
        if edge_dict is not None:
            _graph_pref = graph.get('model_source_preference')
            resolved = resolve_model_params(edge_dict,
                                            scope='edge' if is_window else 'path',
                                            temporal_mode='window' if is_window else 'cohort',
                                            graph_preference=_graph_pref)
            if resolved and resolved.latency.sigma > 0:
                # D18 + review finding #7: use scoped cohorts when available
                _ec = edge_contexts.get(ev.edge_uuid)
                cohorts_raw = (
                    (_ec.scoped_cohorts if _ec and _ec.scoped_cohorts else None)
                    or param_lookup.get(ev.edge_uuid, [])
                )
                # Build CohortEvidence with eval_age (coordinate B)
                engine_cohorts = []
                max_age = 0
                for c in cohorts_raw:
                    if c.n <= 0 or c.age < 0:
                        continue
                    age_i = int(round(c.age))
                    if age_i > max_age:
                        max_age = age_i
                    # Minimal obs_x/obs_y: single-point at frontier.
                    # _evaluate_cohort degrades gracefully (E_i = N_i).
                    obs_x = [float(c.n)]
                    obs_y = [float(c.k) if c.k >= 0 else 0.0]
                    engine_cohorts.append(CohortEvidence(
                        obs_x=obs_x,
                        obs_y=obs_y,
                        x_frozen=float(c.n),
                        y_frozen=float(c.k) if c.k >= 0 else 0.0,
                        frontier_age=0 if is_window else age_i,
                        a_pop=float(c.n),
                        eval_age=age_i,
                    ))
                if engine_cohorts and max_age > 0:
                    from_node_id = edge_dict.get('from', '')
                    _from_arrival = (
                        _node_arrival_cache.get(from_node_id)
                        if _node_arrival_cache else None
                    )
                    try:
                        sweep = compute_forecast_trajectory(
                            resolved=resolved,
                            cohorts=engine_cohorts,
                            max_tau=max_age,
                            from_node_arrival=_from_arrival if not is_window else None,
                        )
                        # Read coordinate B: aggregate per-cohort draws
                        if sweep.cohort_evals:
                            total_n = sum(c.n for c in cohorts_raw if c.n > 0 and c.age >= 0)
                            sum_y_draws = _np.zeros(sweep.rate_draws.shape[0])
                            sum_x_draws = _np.zeros(sweep.rate_draws.shape[0])
                            for ce in sweep.cohort_evals:
                                sum_y_draws += ce.y_draws
                                sum_x_draws += ce.x_draws
                            x_safe = _np.maximum(sum_x_draws, 1e-10)
                            rate_draws = sum_y_draws / x_safe

                            class _FS:
                                pass
                            fs = _FS()
                            # Use engine's blended completeness (n-weighted
                            # CDF at each cohort's eval_age, with posterior
                            # uncertainty on latency params).
                            fs.completeness = sweep.completeness_mean if sweep.completeness_mean is not None else ev.completeness
                            fs.completeness_sd = sweep.completeness_sd if sweep.completeness_sd is not None else 0.0
                            fs.rate_conditioned = float(_np.median(rate_draws))
                            fs.rate_conditioned_sd = float(_np.std(rate_draws))
                            fs.p_conditioned = fs.rate_conditioned
                            fs.p_conditioned_sd = fs.rate_conditioned_sd
                            _fs_count += 1
                            if fs.rate_conditioned_sd > 0:
                                improved_p_sd = fs.rate_conditioned_sd
                    except Exception as _sweep_err:
                        print(f"[topo-pass] WARNING: sweep failed for {ev.edge_uuid}: {_sweep_err}")

        # Doc 29 §Schema Change: engine writes to existing fields,
        # not a separate forecast_state object. When the engine ran,
        # its improved values replace the stats-engine defaults.
        edges_out.append({
            'edge_uuid': ev.edge_uuid,
            'conditional_index': ev.conditional_index,
            't95': ev.t95,
            'path_t95': ev.path_t95,
            'completeness': fs.completeness if fs else ev.completeness,
            'completeness_stdev': fs.completeness_sd if fs else None,
            'mu': ev.mu,
            'sigma': ev.sigma,
            'onset_delta_days': ev.onset_delta_days,
            'median_lag_days': ev.median_lag_days,
            'mean_lag_days': ev.mean_lag_days,
            'path_mu': ev.path_mu,
            'path_sigma': ev.path_sigma,
            'path_onset_delta_days': ev.path_onset_delta_days,
            'p_infinity': ev.p_infinity,
            'p_evidence': ev.p_evidence,
            'forecast_available': ev.forecast_available,
            'blended_mean': fs.rate_conditioned if fs else ev.blended_mean,
            'p_sd': improved_p_sd,
            'mu_sd': ev.mu_sd,
            'sigma_sd': ev.sigma_sd,
            'onset_sd': ev.onset_sd,
            'onset_mu_corr': ev.onset_mu_corr,
            'path_mu_sd': ev.path_mu_sd,
            'path_sigma_sd': ev.path_sigma_sd,
            'path_onset_sd': ev.path_onset_sd,
        })

    _fs_ms = (_time.monotonic() - _fs_t0) * 1000
    print(f"[topo-pass] forecast_state: {_fs_count}/{len(edges_out)} edges "
          f"in {_fs_ms:.0f}ms")

    return {
        'success': True,
        'edges': edges_out,
        'summary': {
            'edges_processed': result.edges_processed,
            'edges_with_lag': result.edges_with_lag,
            'forecast_state_count': _fs_count,
            'forecast_state_ms': round(_fs_ms),
        },
    }
