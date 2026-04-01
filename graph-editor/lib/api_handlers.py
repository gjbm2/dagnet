"""
Shared API handlers for Python endpoints.

Used by both:
- dev-server.py (FastAPI)
- python-api.py (Vercel serverless)

This ensures dev and prod use identical handler logic.
"""
import math
from typing import Dict, Any, Optional, List


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


def _compute_surprise_gauge(
    graph_data: Dict[str, Any],
    target_id: Optional[str],
    subj: Dict[str, Any],
    data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Compute surprise gauge: compare current evidence against Bayesian posterior.

    Phase 1: uses parameter file scalars (k, n, median_lag, mean_lag).
    Phase 2: will add snapshot DB queries for onset evidence.

    Returns:
        { analysis_type, variables: [{ name, quantile, observed, expected,
          posterior_sd, zone, label, available }] }
    """
    # Pure-math normal CDF/PPF — avoids scipy on Vercel (Lambda size limit).
    def norm_cdf(z: float) -> float:
        return 0.5 * math.erfc(-z / math.sqrt(2.0))

    def norm_ppf(q: float) -> float:
        """Inverse normal CDF (Acklam approximation, max |error| < 1.15e-9)."""
        if q <= 0:
            return float('-inf')
        if q >= 1:
            return float('inf')
        # Coefficients
        a = (-3.969683028665376e+01, 2.209460984245205e+02,
             -2.759285104469687e+02, 1.383577518672690e+02,
             -3.066479806614716e+01, 2.506628277459239e+00)
        b = (-5.447609879822406e+01, 1.615858368580409e+02,
             -1.556989798598866e+02, 6.680131188771972e+01,
             -1.328068155288572e+01)
        c = (-7.784894002430293e-03, -3.223964580411365e-01,
             -2.400758277161838e+00, -2.549732539343734e+00,
             4.374664141464968e+00, 2.938163982698783e+00)
        d = (7.784695709041462e-03, 3.224671290700398e-01,
             2.445134137142996e+00, 3.754408661907416e+00)
        p_low = 0.02425
        p_high = 1 - p_low
        if q < p_low:
            r = math.sqrt(-2.0 * math.log(q))
            return (((((c[0]*r+c[1])*r+c[2])*r+c[3])*r+c[4])*r+c[5]) / \
                   ((((d[0]*r+d[1])*r+d[2])*r+d[3])*r+1)
        elif q <= p_high:
            r = q - 0.5
            r2 = r * r
            return (((((a[0]*r2+a[1])*r2+a[2])*r2+a[3])*r2+a[4])*r2+a[5])*r / \
                   (((((b[0]*r2+b[1])*r2+b[2])*r2+b[3])*r2+b[4])*r2+1)
        else:
            r = math.sqrt(-2.0 * math.log(1 - q))
            return -(((((c[0]*r+c[1])*r+c[2])*r+c[3])*r+c[4])*r+c[5]) / \
                    ((((d[0]*r+d[1])*r+d[2])*r+d[3])*r+1)

    result: Dict[str, Any] = {
        'analysis_type': 'surprise_gauge',
        'analysis_name': 'Expectation Gauge',
        'variables': [],
    }

    if not graph_data or not target_id:
        return result

    # Find the edge
    edges = graph_data.get('edges', []) if isinstance(graph_data, dict) else []
    edge = next(
        (e for e in edges
         if str(e.get('uuid') or e.get('id') or '') == str(target_id)),
        None,
    )
    if not edge:
        return result

    p = edge.get('p') or {}
    model_vars = p.get('model_vars') or []

    # Find Bayesian model vars entry
    bayes_entry = next(
        (mv for mv in model_vars if isinstance(mv, dict) and mv.get('source') == 'bayesian'),
        None,
    )
    # Determine the reference model entry: prefer Bayesian, fall back to any with stdev
    reference_entry = bayes_entry
    reference_source = 'bayesian'
    if not reference_entry:
        # Fall back to analytic_be, then analytic
        for fallback_src in ('analytic_be', 'analytic'):
            reference_entry = next(
                (mv for mv in model_vars if isinstance(mv, dict) and mv.get('source') == fallback_src
                 and isinstance((mv.get('probability') or {}).get('stdev'), (int, float))
                 and (mv.get('probability') or {}).get('stdev', 0) > 0),
                None,
            )
            if reference_entry:
                reference_source = fallback_src
                break
    if not reference_entry:
        result['error'] = 'No model vars with uncertainty available for this edge'
        print(f"[surprise_gauge] No reference entry. model_vars sources: {[mv.get('source') for mv in model_vars if isinstance(mv, dict)]}")
        return result

    result['reference_source'] = reference_source
    if reference_source != 'bayesian':
        result['hint'] = 'Run Bayes model for better indicators'
    print(f"[surprise_gauge] Using {reference_source} entry.")

    ref_quality = reference_entry.get('quality') or {}
    ref_prob = reference_entry.get('probability') or {}
    ref_lat = reference_entry.get('latency') or {}

    latency = p.get('latency') or {}
    lat_posterior = latency.get('posterior') or {}
    prob_posterior = p.get('posterior') or {}

    # --- Determine query mode for window/cohort selection ---
    query_dsl = data.get('query_dsl') or ''
    subj_slice_keys = subj.get('slice_keys') or []
    has_cohort_slice = any('cohort(' in str(sk) for sk in subj_slice_keys)
    is_cohort = has_cohort_slice or ('cohort(' in query_dsl)

    # --- Build reference distribution params ---
    # For Bayesian: read directly from p.posterior (probability) and
    # p.latency.posterior (latency). These are the authoritative MCMC
    # output. In cohort mode, use path-level fields.
    # For analytic: reconstruct from model_vars mean/stdev.

    # Probability: alpha/beta from p.posterior (the correct object)
    b_alpha_raw = None
    b_beta_raw = None
    if reference_source == 'bayesian':
        if is_cohort:
            b_alpha_raw = prob_posterior.get('path_alpha')
            b_beta_raw = prob_posterior.get('path_beta')
        if b_alpha_raw is None or b_beta_raw is None:
            b_alpha_raw = prob_posterior.get('alpha')
            b_beta_raw = prob_posterior.get('beta')
    if b_alpha_raw is None or b_beta_raw is None:
        # Reconstruct from mean/stdev using method of moments
        b_mean = ref_prob.get('mean')
        b_std = ref_prob.get('stdev')
        if (isinstance(b_mean, (int, float)) and isinstance(b_std, (int, float))
                and b_mean > 0 and b_mean < 1 and b_std > 0):
            v = float(b_std) ** 2
            m = float(b_mean)
            if v < m * (1 - m):  # valid Beta
                common = m * (1 - m) / v - 1
                b_alpha_raw = m * common
                b_beta_raw = (1 - m) * common

    # Latency: mu_mean/mu_sd, sigma_mean/sigma_sd, onset
    # For Bayesian in cohort mode: use path-level posterior fields.
    if reference_source == 'bayesian':
        if is_cohort and lat_posterior.get('path_mu_mean') is not None:
            ref_lat_params = {
                'mu_mean': lat_posterior.get('path_mu_mean'),
                'mu_sd': lat_posterior.get('path_mu_sd'),
                'sigma_mean': lat_posterior.get('path_sigma_mean'),
                'sigma_sd': lat_posterior.get('path_sigma_sd'),
                'onset_mean': lat_posterior.get('path_onset_delta_days'),
                'onset_sd': lat_posterior.get('path_onset_sd'),
                'onset_delta_days': lat_posterior.get('path_onset_delta_days') or 0,
            }
        else:
            ref_lat_params = {
                'mu_mean': lat_posterior.get('mu_mean') or ref_lat.get('mu'),
                'mu_sd': lat_posterior.get('mu_sd'),
                'sigma_mean': lat_posterior.get('sigma_mean') or ref_lat.get('sigma'),
                'sigma_sd': lat_posterior.get('sigma_sd'),
                'onset_mean': lat_posterior.get('onset_mean'),
                'onset_sd': lat_posterior.get('onset_sd'),
                'onset_delta_days': lat_posterior.get('onset_delta_days') or ref_lat.get('onset_delta_days') or 0,
            }
    else:
        # Analytic: no posterior SDs available for latency params
        ref_lat_params = {
            'mu_mean': ref_lat.get('mu'),
            'mu_sd': None,
            'sigma_mean': ref_lat.get('sigma'),
            'sigma_sd': None,
            'onset_mean': None,
            'onset_sd': None,
            'onset_delta_days': ref_lat.get('onset_delta_days') or 0,
        }

    # --- Evidence (pure observation — never the blended f+e value) ---
    # See surprise-gauge-design.md §5.0: gauge always compares pure evidence
    # against the model posterior to avoid circular comparison.
    evidence = p.get('evidence') or {}
    evidence_k = evidence.get('k')
    evidence_n = evidence.get('n')

    # Completeness from the topo pass (n-weighted aggregate across cohort dates).
    c_w = latency.get('completeness')
    if not isinstance(c_w, (int, float)) or c_w <= 0:
        c_w = 1.0  # Default: assume fully mature when no lag model

    # --- Observed latency params (from analytic evidence, not promoted/blended) ---
    analytic_entry = next(
        (mv for mv in model_vars if isinstance(mv, dict) and mv.get('source') == 'analytic_be'),
        next(
            (mv for mv in model_vars if isinstance(mv, dict) and mv.get('source') == 'analytic'),
            None,
        ),
    )
    obs_lat_mu = None
    obs_lat_sigma = None
    if analytic_entry:
        a_lat = analytic_entry.get('latency') or {}
        obs_lat_mu = a_lat.get('mu')
        obs_lat_sigma = a_lat.get('sigma')
    # Fallback to promoted latency only for mu/sigma (not for p)
    promoted_lat = p.get('latency') or {}
    if obs_lat_mu is None:
        obs_lat_mu = promoted_lat.get('mu')
    if obs_lat_sigma is None:
        obs_lat_sigma = promoted_lat.get('sigma')

    # n_dates for mu/sigma sampling SE
    anchor_from_str = subj.get('anchor_from')
    anchor_to_str = subj.get('anchor_to')
    n_dates = 1
    if anchor_from_str and anchor_to_str:
        try:
            from datetime import date as date_type
            af = date_type.fromisoformat(str(anchor_from_str)[:10])
            at = date_type.fromisoformat(str(anchor_to_str)[:10])
            n_dates = max(1, (at - af).days + 1)
        except (ValueError, TypeError):
            pass

    # Zone classification from quantile
    def classify_zone(q: float) -> str:
        """Map a CDF quantile (0-1) to a surprise zone."""
        tail = abs(q - 0.5) * 2  # 0 = centre, 1 = extreme
        if tail < 0.60:   return 'expected'      # 20th–80th percentile
        if tail < 0.80:   return 'noteworthy'     # 10th–20th or 80th–90th
        if tail < 0.90:   return 'unusual'        # 5th–10th or 90th–95th
        if tail < 0.98:   return 'surprising'     # 1st–5th or 95th–99th
        return 'alarming'                         # beyond 1st/99th

    def sigma_from_quantile(q: float) -> float:
        """Convert quantile to signed σ distance from centre."""
        q_clamped = max(1e-6, min(1 - 1e-6, q))
        return norm_ppf(q_clamped)

    variables = []

    # --- p (conversion rate) ---
    # Completeness-adjusted comparison: pure evidence k/n vs posterior Beta(α,β)
    # scaled by per-date completeness. See surprise-gauge-design.md §5.1.
    b_alpha = b_alpha_raw
    b_beta_param = b_beta_raw

    if (isinstance(b_alpha, (int, float)) and isinstance(b_beta_param, (int, float))
            and b_alpha > 0 and b_beta_param > 0
            and isinstance(evidence_k, (int, float)) and isinstance(evidence_n, (int, float))
            and evidence_n > 0):
        mu_p = b_alpha / (b_alpha + b_beta_param)
        sigma2_p = (b_alpha * b_beta_param) / ((b_alpha + b_beta_param) ** 2 * (b_alpha + b_beta_param + 1))
        obs_rate = float(evidence_k) / float(evidence_n)

        # Completeness-adjusted expected rate and variance (§5.1)
        expected = mu_p * c_w
        var_post = sigma2_p * (c_w ** 2)
        # Sampling variance at the expected rate
        var_samp = expected * (1.0 - expected) / float(evidence_n)
        combined_sd = math.sqrt(max(1e-20, var_post + var_samp))

        z = (obs_rate - expected) / combined_sd
        quantile = float(norm_cdf(z))
        variables.append({
            'name': 'p',
            'label': 'Conversion rate',
            'quantile': round(quantile, 6),
            'sigma': round(z, 3),
            'observed': round(obs_rate, 6),
            'expected': round(expected, 6),
            'expected_longrun': round(mu_p, 6),
            'posterior_sd': round(math.sqrt(sigma2_p), 6),
            'combined_sd': round(combined_sd, 6),
            'completeness': round(c_w, 4),
            'zone': classify_zone(quantile),
            'available': True,
        })
    else:
        reason = 'No evidence (k/n)' if not (isinstance(evidence_n, (int, float)) and evidence_n > 0) else 'Missing posterior (alpha/beta)'
        variables.append({
            'name': 'p',
            'label': 'Conversion rate',
            'available': False,
            'reason': reason,
        })

    # --- mu (latency location) ---
    # Combined-SD normal approximation: posterior SD + sampling SE. See §5.2.
    b_mu_mean = ref_lat_params.get('mu_mean')
    b_mu_sd = ref_lat_params.get('mu_sd')
    b_onset_mean = ref_lat_params.get('onset_mean') or ref_lat_params.get('onset_delta_days') or 0
    # sigma_lag for sampling SE of median
    sigma_lag = ref_lat_params.get('sigma_mean') or latency.get('sigma')

    if (isinstance(b_mu_mean, (int, float)) and isinstance(b_mu_sd, (int, float))
            and b_mu_sd > 0
            and isinstance(obs_lat_mu, (int, float))):
        # obs_se = sqrt(π/2) × σ_lag / sqrt(n_dates)
        obs_se = 0.0
        if isinstance(sigma_lag, (int, float)) and sigma_lag > 0 and n_dates > 0:
            obs_se = math.sqrt(math.pi / 2) * float(sigma_lag) / math.sqrt(n_dates)
        combined_sd = math.sqrt(float(b_mu_sd) ** 2 + obs_se ** 2)
        z = (float(obs_lat_mu) - float(b_mu_mean)) / combined_sd
        quantile = float(norm_cdf(z))
        variables.append({
            'name': 'mu',
            'label': 'Latency location (μ)',
            'quantile': round(quantile, 6),
            'sigma': round(z, 3),
            'observed': round(float(obs_lat_mu), 4),
            'observed_days': round(math.exp(float(obs_lat_mu)) + float(b_onset_mean), 1),
            'expected': round(float(b_mu_mean), 4),
            'expected_days': round(math.exp(float(b_mu_mean)) + float(b_onset_mean), 1),
            'posterior_sd': round(float(b_mu_sd), 4),
            'combined_sd': round(combined_sd, 4),
            'n_dates': n_dates,
            'zone': classify_zone(quantile),
            'available': True,
        })
    else:
        variables.append({
            'name': 'mu',
            'label': 'Latency location (μ)',
            'available': False,
            'reason': 'Missing Bayesian latency posterior or analytic mu',
        })

    # --- sigma (latency spread) ---
    # Combined-SD normal approximation with n_dates guard. See §5.2.
    b_sigma_mean_val = ref_lat_params.get('sigma_mean')
    b_sigma_sd = ref_lat_params.get('sigma_sd')

    if (isinstance(b_sigma_mean_val, (int, float)) and isinstance(b_sigma_sd, (int, float))
            and b_sigma_sd > 0
            and isinstance(obs_lat_sigma, (int, float))
            and n_dates >= 30):
        # sigma_se = σ_lag / sqrt(2 × n_dates)
        obs_se = 0.0
        if isinstance(sigma_lag, (int, float)) and sigma_lag > 0 and n_dates > 0:
            obs_se = float(sigma_lag) / math.sqrt(2 * n_dates)
        combined_sd = math.sqrt(float(b_sigma_sd) ** 2 + obs_se ** 2)
        z = (float(obs_lat_sigma) - float(b_sigma_mean_val)) / combined_sd
        quantile = float(norm_cdf(z))
        variables.append({
            'name': 'sigma',
            'label': 'Latency spread (σ)',
            'quantile': round(quantile, 6),
            'sigma': round(z, 3),
            'observed': round(float(obs_lat_sigma), 4),
            'expected': round(float(b_sigma_mean_val), 4),
            'posterior_sd': round(float(b_sigma_sd), 4),
            'combined_sd': round(combined_sd, 4),
            'n_dates': n_dates,
            'zone': classify_zone(quantile),
            'available': True,
        })
    elif n_dates < 30 and isinstance(b_sigma_mean_val, (int, float)) and isinstance(obs_lat_sigma, (int, float)):
        variables.append({
            'name': 'sigma',
            'label': 'Latency spread (σ)',
            'available': False,
            'reason': f'Insufficient dates ({n_dates} < 30) for reliable sigma estimate',
        })
    else:
        variables.append({
            'name': 'sigma',
            'label': 'Latency spread (σ)',
            'available': False,
            'reason': 'Missing Bayesian sigma posterior or analytic sigma',
        })

    # --- onset (Phase 2 — placeholder) ---
    b_onset_mean_val = ref_lat_params.get('onset_mean')
    b_onset_sd = ref_lat_params.get('onset_sd')
    if isinstance(b_onset_mean_val, (int, float)) and isinstance(b_onset_sd, (int, float)) and b_onset_sd > 0:
        variables.append({
            'name': 'onset',
            'label': 'Onset (dead time)',
            'available': False,
            'reason': 'Phase 2: requires snapshot DB query for observed onset',
            'expected': round(float(b_onset_mean_val), 2),
            'posterior_sd': round(float(b_onset_sd), 2),
        })
    else:
        variables.append({
            'name': 'onset',
            'label': 'Onset (dead time)',
            'available': False,
            'reason': 'No latent onset posterior available',
        })

    # Quality metadata
    result['variables'] = variables
    result['quality'] = {
        'rhat': ref_quality.get('rhat'),
        'ess': ref_quality.get('ess'),
        'gate_passed': ref_quality.get('gate_passed'),
    }
    result['promoted_source'] = p.get('model_source_preference', 'best_available')

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
    # New path: per-scenario snapshot_subjects
    # Check if any scenario carries snapshot_subjects (per-scenario architecture)
    scenarios_with_snapshots = [
        s for s in data.get('scenarios', [])
        if s.get('snapshot_subjects')
    ]
    if scenarios_with_snapshots:
        return _handle_snapshot_analyze_subjects(data)

    # Legacy path: snapshot_query (single subject)
    snapshot_query = data.get('snapshot_query')
    if snapshot_query:
        return _handle_snapshot_analyze_legacy(data)
    
    # Standard scenario-based analysis (no snapshot data needed)
    from runner import analyze
    from runner.types import AnalysisRequest, ScenarioData
    
    if 'scenarios' not in data or not data['scenarios']:
        raise ValueError("Missing 'scenarios' field")
    
    # Build request
    scenarios = [
        ScenarioData(
            scenario_id=s.get('scenario_id', f'scenario_{i}'),
            name=s.get('name'),
            colour=s.get('colour'),
            visibility_mode=s.get('visibility_mode', 'f+e'),
            graph=s.get('graph', {}),
        )
        for i, s in enumerate(data['scenarios'])
    ]
    
    request_obj = AnalysisRequest(
        scenarios=scenarios,
        query_dsl=data.get('query_dsl'),
        analysis_type=data.get('analysis_type'),
    )
    
    # Run analysis
    response = analyze(request_obj)
    
    # Return JSON-serializable response
    return response.model_dump()


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
    from runner.forecast_application import annotate_rows, compute_completeness
    from runner.lag_distribution_utils import log_normal_cdf, log_normal_inverse_cdf, standard_normal_inverse_cdf

    analysis_type = data.get('analysis_type', 'lag_histogram')
    scenarios = data.get('scenarios', [])

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
        # Evidence retrieval date — needed for tau_observed in fan chart.
        evidence = p.get('evidence') or {}
        ev_retrieved = evidence.get('retrieved_at')
        if isinstance(ev_retrieved, str) and ev_retrieved:
            result['evidence_retrieved_at'] = ev_retrieved
        if isinstance(forecast_mean, (int, float)) and math.isfinite(forecast_mean) and forecast_mean > 0:
            result['forecast_mean'] = float(forecast_mean)
        # Doc 25 §3.3: posterior p from the re-projected slice.
        # After the posteriorSliceResolution fix, alpha/beta always carry
        # window (edge-level) values and path_alpha/path_beta carry cohort
        # (path-level) values. Extract both so the caller can pick the
        # correct one based on query mode.
        post_alpha = prob_posterior.get('alpha')
        post_beta = prob_posterior.get('beta')
        if (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            result['posterior_p'] = float(post_alpha) / (float(post_alpha) + float(post_beta))
            result['posterior_alpha'] = float(post_alpha)
            result['posterior_beta'] = float(post_beta)
        path_alpha = prob_posterior.get('path_alpha')
        path_beta = prob_posterior.get('path_beta')
        if (isinstance(path_alpha, (int, float)) and isinstance(path_beta, (int, float))
                and path_alpha > 0 and path_beta > 0):
            result['posterior_p_cohort'] = float(path_alpha) / (float(path_alpha) + float(path_beta))
            result['posterior_path_alpha'] = float(path_alpha)
            result['posterior_path_beta'] = float(path_beta)
        # Probability posterior uncertainty (for confidence bands).
        # Prefer posterior-derived SD (from alpha/beta) over the flat p.stdev
        # which is the blended analytic estimate, not the MCMC posterior width.
        _post_p_sd = None
        if (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            _s = post_alpha + post_beta
            _post_p_sd = math.sqrt(post_alpha * post_beta / (_s * _s * (_s + 1)))
        _post_p_cohort_sd = None
        if (isinstance(path_alpha, (int, float)) and isinstance(path_beta, (int, float))
                and path_alpha > 0 and path_beta > 0):
            _s = path_alpha + path_beta
            _post_p_cohort_sd = math.sqrt(path_alpha * path_beta / (_s * _s * (_s + 1)))
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
            # Bayesian uncertainty (for confidence bands)
            if src == 'bayesian':
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

        # Bayesian latency posterior — edge-level (window)
        lat_posterior = latency.get('posterior') or {}
        bayes_mu = lat_posterior.get('mu_mean')
        bayes_sigma = lat_posterior.get('sigma_mean')
        if (isinstance(bayes_mu, (int, float)) and math.isfinite(bayes_mu)
                and isinstance(bayes_sigma, (int, float)) and math.isfinite(bayes_sigma) and bayes_sigma > 0):
            result['bayes_mu'] = float(bayes_mu)
            result['bayes_sigma'] = float(bayes_sigma)
            # Phase D.O: prefer posterior onset_mean (latent onset) over prior onset_delta_days
            bayes_onset = lat_posterior.get('onset_mean') or lat_posterior.get('onset_delta_days')
            result['bayes_onset'] = float(bayes_onset) if isinstance(bayes_onset, (int, float)) and math.isfinite(bayes_onset) else 0.0
            bayes_onset_sd = lat_posterior.get('onset_sd')
            if isinstance(bayes_onset_sd, (int, float)) and math.isfinite(bayes_onset_sd) and bayes_onset_sd > 0:
                result['bayes_onset_sd'] = float(bayes_onset_sd)
        # t95 HDI (for axis extents and display)
        for _prefix, _src_prefix in [('bayes_', ''), ('bayes_path_', 'path_')]:
            for _bound in ('lower', 'upper'):
                _key = f'{_src_prefix}hdi_t95_{_bound}'
                _val = lat_posterior.get(_key)
                if isinstance(_val, (int, float)) and math.isfinite(_val) and _val > 0:
                    result[f'{_prefix}hdi_t95_{_bound}'] = float(_val)
        # Bayesian latency posterior — uncertainty (for confidence bands)
        bayes_mu_sd = lat_posterior.get('mu_sd')
        bayes_sigma_sd = lat_posterior.get('sigma_sd')
        if (isinstance(bayes_mu_sd, (int, float)) and math.isfinite(bayes_mu_sd) and bayes_mu_sd > 0):
            result['bayes_mu_sd'] = float(bayes_mu_sd)
        if (isinstance(bayes_sigma_sd, (int, float)) and math.isfinite(bayes_sigma_sd) and bayes_sigma_sd > 0):
            result['bayes_sigma_sd'] = float(bayes_sigma_sd)
        # Onset-mu correlation (for covariance-aware confidence bands)
        bayes_onset_mu_corr = lat_posterior.get('onset_mu_corr')
        if isinstance(bayes_onset_mu_corr, (int, float)) and math.isfinite(bayes_onset_mu_corr):
            result['bayes_onset_mu_corr'] = float(bayes_onset_mu_corr)
        bayes_path_onset_mu_corr = lat_posterior.get('path_onset_mu_corr')
        if isinstance(bayes_path_onset_mu_corr, (int, float)) and math.isfinite(bayes_path_onset_mu_corr):
            result['bayes_path_onset_mu_corr'] = float(bayes_path_onset_mu_corr)
        # Bayesian latency posterior — path-level (cohort)
        bayes_path_mu = lat_posterior.get('path_mu_mean')
        bayes_path_sigma = lat_posterior.get('path_sigma_mean')
        if (isinstance(bayes_path_mu, (int, float)) and math.isfinite(bayes_path_mu)
                and isinstance(bayes_path_sigma, (int, float)) and math.isfinite(bayes_path_sigma) and bayes_path_sigma > 0):
            result['bayes_path_mu'] = float(bayes_path_mu)
            result['bayes_path_sigma'] = float(bayes_path_sigma)
            bayes_path_onset = lat_posterior.get('path_onset_delta_days')
            result['bayes_path_onset'] = float(bayes_path_onset) if isinstance(bayes_path_onset, (int, float)) and math.isfinite(bayes_path_onset) else 0.0
            # Path-level uncertainty
            bayes_path_mu_sd = lat_posterior.get('path_mu_sd')
            bayes_path_sigma_sd = lat_posterior.get('path_sigma_sd')
            if (isinstance(bayes_path_mu_sd, (int, float)) and math.isfinite(bayes_path_mu_sd) and bayes_path_mu_sd > 0):
                result['bayes_path_mu_sd'] = float(bayes_path_mu_sd)
            if (isinstance(bayes_path_sigma_sd, (int, float)) and math.isfinite(bayes_path_sigma_sd) and bayes_path_sigma_sd > 0):
                result['bayes_path_sigma_sd'] = float(bayes_path_sigma_sd)
            bayes_path_onset_sd = lat_posterior.get('path_onset_sd')
            if isinstance(bayes_path_onset_sd, (int, float)) and math.isfinite(bayes_path_onset_sd) and bayes_path_onset_sd > 0:
                result['bayes_path_onset_sd'] = float(bayes_path_onset_sd)

        # ── Fallback SDs from model_vars (source_curves) ──────────────
        # The SDs may live in model_vars[bayesian].latency rather than
        # in lat_posterior directly.  Promote them to top-level if not
        # already set from the posterior.
        bayes_sc = source_curves.get('bayesian') if source_curves else None
        if bayes_sc:
            for _src_key, _dst_key in [
                ('mu_sd', 'bayes_mu_sd'), ('sigma_sd', 'bayes_sigma_sd'),
                ('onset_sd', 'bayes_onset_sd'), ('p_stdev', 'p_stdev'),
                ('path_mu_sd', 'bayes_path_mu_sd'), ('path_sigma_sd', 'bayes_path_sigma_sd'),
                ('path_onset_sd', 'bayes_path_onset_sd'),
            ]:
                if _dst_key not in result:
                    _v = bayes_sc.get(_src_key)
                    if isinstance(_v, (int, float)) and math.isfinite(_v) and _v > 0:
                        result[_dst_key] = float(_v)

        return result

    def _append_synthetic_cohort_maturity_frames(args: Dict[str, Any]) -> None:
        """
        Phase 2 (cohort maturity): append synthetic future frames (forecast-only tail).

        This does NOT change the meaning of existing (real) frames. It simply extends
        `result['frames']` with additional frames beyond the latest real as_at_date so
        the frontend can plot a forecast-only tail.

        Contract:
        - Synthetic frames are tagged with `is_synthetic: true`.
        - Each synthetic frame uses the same `data_points` shape as real frames.
        - Data points are re-annotated using annotate_rows with retrieved_at_override set
          to the synthetic as_at_date.
        """
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

        # Only append tail when there is at least one real frame with data points
        # and those points have projected_y (requires completeness annotation).
        real_frames = [f for f in frames if not f.get('is_synthetic')]
        if not real_frames:
            return

        # Last real frame with any data points.
        last_real = None
        for f in reversed(real_frames):
            if isinstance(f, dict) and isinstance(f.get('data_points'), list) and len(f.get('data_points')) > 0:
                last_real = f
                break
        if not last_real:
            return

        last_as_at = str(last_real.get('as_at_date') or '')[:10]
        if not last_as_at:
            return

        try:
            last_as_at_d = date.fromisoformat(last_as_at)
            anchor_to_d = date.fromisoformat(anchor_to[:10])
        except ValueError:
            return

        # Determine tail horizon: extend until the latest cohort (anchor_to) reaches ~t95
        # under the fitted lognormal model.
        #
        # We use 0.95 here (Phase 2). If/when forecasting_settings.t95_percentile is threaded
        # into snapshot_analyze, swap to that request value.
        try:
            t95_model = log_normal_inverse_cdf(0.95, mu, sigma)
        except Exception:
            return
        if not isinstance(t95_model, (int, float)) or not math.isfinite(t95_model) or t95_model <= 0:
            return

        tail_days = int(math.ceil(float(t95_model) + onset))
        if tail_days <= 0:
            return

        tail_to_d = anchor_to_d + timedelta(days=tail_days)
        start_d = last_as_at_d + timedelta(days=1)
        if start_d > tail_to_d:
            return

        base_points = last_real.get('data_points') or []
        if not isinstance(base_points, list) or len(base_points) == 0:
            return

        # Build tail frames at daily cadence.
        #
        # Each synthetic point carries:
        #   y          = frozen evidence (last real observation) — keeps Σy stable
        #   x          = frozen x (last real observation) — keeps Σx stable
        #   projected_y = model prediction at this τ — the forecast curve
        #   forecast_y  = max(0, projected_y - y) — the crown
        #
        # The FE computes evidence_rate = Σy/Σx (stable, plateauing) and
        # projected_rate = Σprojected_y/Σx (rising toward model). The crown
        # is the gap between them.
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

                # Frozen evidence from last real frame.
                y_evidence = float(p.get('y') or p.get('Y') or 0)

                # Model prediction at this future age.
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
                "as_at_date": as_at_iso,
                "is_synthetic": True,
                "data_points": synth_points,
                "total_y": total_y,
            })
            d += timedelta(days=1)

        # Append and keep chronological ordering.
        # We preserve the original (real) frames as-is and append the future tail.
        result['frames'] = frames + new_frames
        result['forecast_tail'] = {
            "from": start_d.isoformat(),
            "to": tail_to_d.isoformat(),
            "t95_model_days": float(t95_model),
            "onset_delta_days": float(onset),
        }

    per_scenario_results: List[Dict[str, Any]] = []
    total_rows = 0

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
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
                # Cohort maturity: use sweep query
                sweep_from = date.fromisoformat(subj['sweep_from']) if subj.get('sweep_from') else None
                sweep_to = date.fromisoformat(subj['sweep_to']) if subj.get('sweep_to') else None

                print(f"[snapshot_analyze] cohort_maturity query: "
                      f"param_id={subj['param_id']}, core_hash={subj['core_hash']}, "
                      f"slice_keys={subj.get('slice_keys', [''])}, "
                      f"anchor_from={subj['anchor_from']}, anchor_to={subj['anchor_to']}, "
                      f"sweep_from={sweep_from}, sweep_to={sweep_to}")

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

                print(f"[snapshot_analyze] cohort_maturity result: {len(rows)} rows")

                scenario_rows += len(rows)

                if not rows:
                    # IMPORTANT:
                    # Cohort maturity sweep may intentionally yield no rows for an epoch
                    # (e.g. a planned "gap" epoch, or days before the first retrieval).
                    # This must be treated as a successful empty result, not an error.
                    result = derive_cohort_maturity(
                        [],
                        sweep_from=subj.get('sweep_from'),
                        sweep_to=subj.get('sweep_to'),
                    )
                    per_subject_results.append({
                        "subject_id": subj.get('subject_id'),
                        "success": True,
                        "result": result,
                        "rows_analysed": 0,
                    })
                    continue

                result = derive_cohort_maturity(
                    rows,
                    sweep_from=subj.get('sweep_from'),
                    sweep_to=subj.get('sweep_to'),
                )
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
                )

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
                elif analysis_type == 'cohort_maturity':
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
            if _test_fixture and analysis_type == 'cohort_maturity':
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
                    query_dsl = data.get('query_dsl') or ''
                    is_window = 'window(' in query_dsl or '.window(' in query_dsl

                mu, sigma, onset, cdf_mode = _resolve_completeness_params(model_params, is_window)

                # Extract forecast_mean for annotation (model-based projection)
                fm = model_params.get('forecast_mean', 0.0) or 0.0

                if analysis_type == 'cohort_maturity' and 'frames' in result:
                    for frame in result['frames']:
                        as_at_date = frame.get('as_at_date', '')
                        if frame.get('data_points'):
                            frame['data_points'] = annotate_rows(
                                frame['data_points'], mu, sigma, onset,
                                forecast_mean=fm,
                                retrieved_at_override=as_at_date,
                            )
                    # Phase 2: append synthetic future frames (forecast-only tail).
                    _append_synthetic_cohort_maturity_frames({
                        'result': result,
                        'mu': mu,
                        'sigma': sigma,
                        'onset_delta_days': onset,
                        'forecast_mean': fm,
                        'anchor_to': subj.get('anchor_to'),
                    })
                elif analysis_type == 'daily_conversions' and 'rate_by_cohort' in result:
                    result['rate_by_cohort'] = annotate_rows(
                        result['rate_by_cohort'], mu, sigma, onset,
                        forecast_mean=fm,
                    )

                # ── Model CDF curve (cohort maturity only) ──────────────
                # Generate the theoretical cumulative lognormal curve so the
                # frontend can overlay it on the empirical maturity chart.
                # Uses the same resolved params as annotation (doc 1 §17.1).
                is_gap_epoch = any(str(sk) == '__epoch_gap__' for sk in subj_slice_keys)

                if analysis_type == 'cohort_maturity' and ('forecast_mean' in model_params or 'posterior_p' in model_params) and not is_gap_epoch:
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

                    # Axis extent: max(upper_hdi(t95), upper_hdi(path_t95), sweep_span).
                    # Uses posterior HDI values directly — no recomputation from params.
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

                    # t95 / path_t95 point estimates from the graph edge — always present
                    edge_t95_val = model_params.get('t95')
                    path_t95_val = model_params.get('path_t95')

                    candidates = [c for c in [sweep_span, edge_t95_val, path_t95_val] if c and c > 0]
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

                            # For non-bayesian sources in cohort mode, use path params
                            if cdf_mode == 'cohort_path' and src_name != 'bayesian':
                                s_pmu = src_params.get('path_mu')
                                s_psigma = src_params.get('path_sigma')
                                s_ponset = src_params.get('path_onset_delta_days')
                                if s_pmu is not None and s_psigma is not None and s_psigma > 0:
                                    s_mu = s_pmu
                                    s_sigma = s_psigma
                                    if s_ponset is not None:
                                        s_onset = s_ponset

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

                            # Bayesian confidence bands (covariance-aware delta method)
                            if src_name == 'bayesian':
                                from runner.confidence_bands import compute_confidence_band
                                band_mu_sd = src_params.get('mu_sd') or 0.0
                                band_sigma_sd = src_params.get('sigma_sd') or 0.0
                                band_onset_sd = src_params.get('onset_sd') or 0.0
                                band_p_sd = src_params.get('p_stdev', 0.0)
                                band_onset_mu_corr = model_params.get('bayes_path_onset_mu_corr') if cdf_mode == 'cohort_path' else model_params.get('bayes_onset_mu_corr', 0.0)
                                if band_onset_mu_corr is None:
                                    band_onset_mu_corr = 0.0

                                # Model overlay band always uses 90% — independent of
                                # the fan chart band setting (which controls the fan only).
                                band_level = 0.90

                                if band_mu_sd > 0:
                                    ages = list(range(0, axis_tau_max + 1))
                                    upper_rates, lower_rates = compute_confidence_band(
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
                    if (analysis_type == 'cohort_maturity'
                            and 'frames' in result
                            and subj.get('anchor_from') and subj.get('anchor_to')
                            and subj.get('sweep_to')):
                        try:
                            from runner.cohort_forecast import compute_cohort_maturity_rows

                            # Resolve band level from display settings
                            _bl_str = str(_ds.get('bayes_band_level', 'blend'))
                            _bl_map = {'80': 0.80, '90': 0.90, '95': 0.95, '99': 0.99, 'blend': 0.90}
                            _fan_band_level = _bl_map.get(_bl_str, 0.90)

                            # Test fixture fork: reuse _fixture_data loaded above
                            # (edge_params already have tf_ overrides applied).
                            if _test_fixture:
                                maturity_rows = compute_cohort_maturity_rows(**_fixture_data, band_level=_fan_band_level)
                            else:
                                maturity_rows = compute_cohort_maturity_rows(
                                    frames=result['frames'],
                                    graph=graph,
                                    target_edge_id=target_id,
                                    edge_params=model_params,
                                    anchor_from=subj['anchor_from'],
                                    anchor_to=subj['anchor_to'],
                                    sweep_to=subj['sweep_to'],
                                    is_window=is_window,
                                    axis_tau_max=axis_tau_max,
                                    band_level=_fan_band_level,
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
            if (analysis_type == 'cohort_maturity'
                    and result and 'frames' in result
                    and 'maturity_rows' not in result
                    and subj.get('anchor_from') and subj.get('anchor_to')
                    and subj.get('sweep_to')):
                try:
                    from runner.cohort_forecast import compute_cohort_maturity_rows
                    _graph = graph if graph else (scenario.get('graph') or {})
                    _tid = target_id if target_id else ((subj.get('target') or {}).get('targetId') or '')
                    _is_win = 'window(' in str(data.get('query_dsl', ''))
                    maturity_rows = compute_cohort_maturity_rows(
                        frames=result['frames'],
                        graph=_graph,
                        target_edge_id=_tid,
                        edge_params={},
                        anchor_from=subj['anchor_from'],
                        anchor_to=subj['anchor_to'],
                        sweep_to=subj['sweep_to'],
                        is_window=_is_win,
                    )
                    if maturity_rows:
                        result['maturity_rows'] = maturity_rows
                except Exception as e:
                    print(f"[cohort_maturity_rows fallback] Error: {e}")

            per_subject_results.append({
                "subject_id": subj.get('subject_id'),
                "success": True,
                "result": result,
                "rows_analysed": len(rows),
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

    result = enhance_graph_latencies(graph, param_lookup, settings, edge_contexts)

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

    edges_out = []
    for ev in result.edge_values:
        edges_out.append({
            'edge_uuid': ev.edge_uuid,
            'conditional_index': ev.conditional_index,
            't95': ev.t95,
            'path_t95': ev.path_t95,
            'completeness': ev.completeness,
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
            'blended_mean': ev.blended_mean,
        })

    return {
        'success': True,
        'edges': edges_out,
        'summary': {
            'edges_processed': result.edges_processed,
            'edges_with_lag': result.edges_with_lag,
        },
    }
