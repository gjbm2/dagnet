"""
Statistical Enhancement Library

Provides statistical enhancement methods for time-series aggregation data.
Heavy computations (MCMC, complex Bayesian inference) are implemented here.

Lightweight operations (inverse-variance weighting) are handled in TypeScript.
"""

from typing import Dict, List, Any, Optional, Tuple

# Optional imports for heavy computations
try:
    import numpy as np
    from scipy import stats
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    # Fallback: use basic math for simple operations
    import math


def enhance_aggregation(
    raw_data: Dict[str, Any],
    method: str
) -> Dict[str, Any]:
    """
    Enhance raw aggregation with statistical method.
    
    Args:
        raw_data: RawAggregation dict with:
            - method: 'naive'
            - n: total sample size
            - k: total successes
            - mean: naive mean (k/n)
            - stdev: standard deviation
            - raw_data: List of daily data points [{date, n, k, p}, ...]
            - window: {start, end}
            - days_included: number of days
            - days_missing: number of missing days
        
        method: Enhancement method ('mcmc', 'bayesian-complex', 'trend-aware', 'robust')
    
    Returns:
        EnhancedAggregation dict with enhanced mean, stdev, confidence_interval, trend, etc.
    """
    
    if method == 'mcmc':
        return _enhance_mcmc(raw_data)
    elif method == 'bayesian-complex' or method == 'bayesian':
        return _enhance_bayesian_complex(raw_data)
    elif method == 'trend-aware':
        return _enhance_trend_aware(raw_data)
    elif method == 'robust':
        return _enhance_robust(raw_data)
    else:
        raise ValueError(f"Unknown enhancement method: {method}")


def _enhance_mcmc(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    MCMC sampling for Bayesian inference.
    
    Uses PyMC or similar for MCMC sampling to estimate posterior distribution.
    For now, uses beta distribution (Bayesian conjugate prior).
    """
    if not HAS_SCIPY:
        raise ImportError("scipy is required for MCMC enhancement. Install with: pip install scipy")
    
    n = raw_data['n']
    k = raw_data['k']
    
    if n == 0:
        return {
            'method': 'mcmc',
            'n': n,
            'k': k,
            'mean': 0,
            'stdev': 0,
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'mcmc',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Use beta distribution for binomial proportion (Bayesian conjugate prior)
    # Beta(alpha=1, beta=1) is uniform prior, Beta(alpha=k+1, beta=n-k+1) is posterior
    alpha = k + 1
    beta = n - k + 1
    
    # Calculate mean (mode of beta distribution) and round to 3 decimal places
    mean = round(alpha / (alpha + beta), 3)
    
    # Calculate standard deviation
    variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1))
    stdev = math.sqrt(variance)
    
    # 95% confidence interval, rounded to 3 decimal places
    ci_lower, ci_upper = stats.beta.interval(0.95, alpha, beta)
    
    return {
        'method': 'mcmc',
        'n': n,
        'k': k,
        'mean': float(mean),
        'stdev': float(stdev),
        'confidence_interval': [round(float(ci_lower), 3), round(float(ci_upper), 3)],
        'trend': None,
        'metadata': {
            'raw_method': raw_data['method'],
            'enhancement_method': 'mcmc',
            'data_points': raw_data['days_included'],
        }
    }


def _enhance_bayesian_complex(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Complex Bayesian inference with custom priors and hierarchical models.
    
    TODO: Implement hierarchical Bayesian model with:
    - Prior on conversion rate
    - Day-to-day variation modeling
    - Trend detection
    """
    # For now, same as MCMC (will be enhanced later)
    return _enhance_mcmc(raw_data)


def _enhance_trend_aware(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Trend-aware enhancement using linear regression or ML.
    
    Detects trends in daily data and adjusts mean accordingly.
    """
    if not HAS_SCIPY:
        raise ImportError("scipy is required for trend-aware enhancement. Install with: pip install scipy")
    
    daily_data = raw_data.get('raw_data', [])
    
    if len(daily_data) < 2:
        # Not enough data for trend detection
        return {
            'method': 'trend-aware',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'trend-aware',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Extract daily probabilities
    p_values = [point['p'] for point in daily_data if point['n'] > 0]
    days = list(range(len(p_values)))
    
    if len(p_values) < 2:
        return {
            'method': 'trend-aware',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'trend-aware',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Linear regression to detect trend
    slope, intercept, r_value, p_value, std_err = stats.linregress(days, p_values)
    
    # Determine trend direction
    if abs(slope) < 0.001:  # Essentially flat
        direction = 'stable'
    elif slope > 0:
        direction = 'increasing'
    else:
        direction = 'decreasing'
    
    # Use trend-adjusted mean (project forward or use weighted average)
    # For now, use simple weighted average favoring recent days
    weights = np.linspace(0.5, 1.0, len(p_values))  # More weight to recent
    trend_adjusted_mean = round(np.average(p_values, weights=weights), 3)
    
    # Recalculate k from trend-adjusted mean
    trend_adjusted_k = int(round(trend_adjusted_mean * raw_data['n']))
    
    return {
        'method': 'trend-aware',
        'n': raw_data['n'],
        'k': trend_adjusted_k,
        'mean': float(trend_adjusted_mean),
        'stdev': raw_data['stdev'],  # Keep original stdev
        'confidence_interval': None,
        'trend': {
            'direction': direction,
            'slope': float(slope),
            'significance': float(p_value),  # p-value for trend significance
        },
        'metadata': {
            'raw_method': raw_data['method'],
            'enhancement_method': 'trend-aware',
            'data_points': raw_data['days_included'],
        }
    }


# =============================================================================
# LAG / Latency Stats Pass
# Port of FE lagDistributionUtils.fitLagDistribution + topo pass
# =============================================================================

LATENCY_DEFAULT_SIGMA = 0.7
LATENCY_MIN_FIT_CONVERTERS = 5
LATENCY_MAX_MEAN_MEDIAN_RATIO = 5.0
LATENCY_MIN_MEAN_MEDIAN_RATIO = 0.95


def fit_lag_distribution(
    median_lag: float,
    mean_lag: Optional[float],
    total_k: int,
) -> Dict[str, Any]:
    """Port of FE fitLagDistribution from lagDistributionUtils.ts.

    Derives lognormal mu/sigma from empirical median and mean lag.
    mu = log(median), sigma = sqrt(2 * log(mean/median)).

    Returns dict with mu, sigma, empirical_quality_ok, quality_failure_reason.
    """
    import math

    if not math.isfinite(median_lag):
        return {"mu": 0, "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": False, "total_k": total_k,
                "quality_failure_reason": f"Invalid median lag: {median_lag}"}

    if total_k < LATENCY_MIN_FIT_CONVERTERS:
        return {"mu": math.log(median_lag) if median_lag > 0 else 0,
                "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": False, "total_k": total_k,
                "quality_failure_reason": f"Insufficient converters: {total_k} < {LATENCY_MIN_FIT_CONVERTERS}"}

    if median_lag <= 0:
        return {"mu": 0, "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": False, "total_k": total_k,
                "quality_failure_reason": f"Invalid median lag: {median_lag}"}

    mu = math.log(median_lag)

    if mean_lag is None or mean_lag <= 0:
        return {"mu": mu, "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": True, "total_k": total_k,
                "quality_failure_reason": "Mean lag not available, using default sigma"}

    ratio = mean_lag / median_lag
    if ratio < 1.0:
        return {"mu": mu, "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": ratio >= LATENCY_MIN_MEAN_MEDIAN_RATIO,
                "total_k": total_k,
                "quality_failure_reason": f"Mean/median ratio {ratio:.3f} < 1.0"}

    if ratio > LATENCY_MAX_MEAN_MEDIAN_RATIO:
        return {"mu": mu, "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": False, "total_k": total_k,
                "quality_failure_reason": f"Mean/median ratio too high: {ratio:.3f}"}

    sigma = math.sqrt(2 * math.log(ratio))
    if not math.isfinite(sigma) or sigma < 0:
        return {"mu": mu, "sigma": LATENCY_DEFAULT_SIGMA,
                "empirical_quality_ok": False, "total_k": total_k,
                "quality_failure_reason": f"Invalid sigma from ratio {ratio:.3f}"}

    return {"mu": mu, "sigma": sigma,
            "empirical_quality_ok": True, "total_k": total_k}


def compute_t95(mu: float, sigma: float, onset: float) -> float:
    """t95 = onset + exp(mu + 1.645 * sigma)."""
    import math
    return onset + math.exp(mu + 1.645 * sigma)


def compute_stats_pass(
    graph: Dict[str, Any],
    param_files: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Run the stats pass on a graph: derive mu/sigma/onset/t95 for each
    latency edge from parameter file lag data, then FW-compose path-level
    params. Returns updated graph (deep copy).

    This is the Python port of the FE's topo pass (lagHorizonsService +
    statisticalEnhancementService). It reads median_lag_days/mean_lag_days
    from param file values[], fits lognormal params, and writes them to
    the graph edge's p.latency block.
    """
    import math
    import copy

    g = copy.deepcopy(graph)
    nodes_by_id = {n["id"]: n for n in g.get("nodes", [])}
    nodes_by_uuid = {n["uuid"]: n for n in g.get("nodes", [])}

    def find_node(ref):
        return nodes_by_id.get(ref) or nodes_by_uuid.get(ref)

    # Anchor node
    anchor = None
    for n in g.get("nodes", []):
        if n.get("entry", {}).get("is_start"):
            anchor = n
            break

    # --- Per-edge: fit lag distribution from param file data ---
    edge_fits: Dict[str, Dict] = {}  # edge_uuid → {mu, sigma, onset, t95, ...}

    for edge in g.get("edges", []):
        p = edge.get("p", {})
        param_id = p.get("id")
        if not param_id:
            continue

        lat = p.get("latency", {})
        has_latency = lat.get("latency_parameter", False)
        if not has_latency:
            continue

        # Find param file
        pf = param_files.get(f"parameter-{param_id}") or param_files.get(param_id)
        if not pf:
            continue

        # Extract lag stats from the most data-rich values[] entry
        values = pf.get("values", [])
        best_median = None
        best_mean = None
        best_k = 0
        best_onset = None

        for v in values:
            k_daily = v.get("k_daily", [])
            total_k = sum(k_daily) if isinstance(k_daily, list) else 0

            # Aggregate median/mean lag from daily arrays
            median_lags = v.get("median_lag_daily") or v.get("median_lag_days")
            mean_lags = v.get("mean_lag_daily") or v.get("mean_lag_days")

            if isinstance(median_lags, list) and len(median_lags) > 0:
                # Daily arrays — compute weighted median/mean from converters
                valid = [(ml, mnl, k) for ml, mnl, k in
                         zip(median_lags,
                             mean_lags if isinstance(mean_lags, list) else [None]*len(median_lags),
                             k_daily if isinstance(k_daily, list) else [0]*len(median_lags))
                         if k > 0 and ml is not None and ml > 0]
                if valid and total_k > best_k:
                    weights = [k for _, _, k in valid]
                    w_sum = sum(weights)
                    best_median = sum(ml * k for ml, _, k in valid) / w_sum
                    if all(mnl is not None and mnl > 0 for _, mnl, _ in valid):
                        best_mean = sum(mnl * k for _, mnl, k in valid) / w_sum
                    best_k = total_k
            elif isinstance(median_lags, (int, float)) and median_lags > 0:
                # Scalar
                if total_k > best_k:
                    best_median = float(median_lags)
                    best_mean = float(mean_lags) if isinstance(mean_lags, (int, float)) and mean_lags > 0 else None
                    best_k = total_k

            # Onset from latency block on values entry or graph edge
            v_lat = v.get("latency", {})
            if isinstance(v_lat, dict):
                v_onset = v_lat.get("onset_delta_days")
                if v_onset is not None and best_onset is None:
                    best_onset = float(v_onset)

        # Fall back to graph edge onset
        if best_onset is None:
            best_onset = float(lat.get("onset_delta_days", 0))

        # Use existing FE-computed mu/sigma on the graph edge if present.
        # The Python stats pass is an incomplete port (missing the t95
        # improvement step from improveFitWithT95). Until the port is
        # complete, prefer FE values to avoid prior mismatch.
        # TODO: Complete Python port of full FE stats pipeline, then
        # remove this fallback.
        existing_mu = lat.get("mu")
        existing_sigma = lat.get("sigma")
        if existing_mu is not None and existing_sigma is not None:
            mu = float(existing_mu)
            sigma = float(existing_sigma)
        elif best_median is not None and best_median > 0:
            # Subtract onset before fitting (model-space)
            model_median = max(best_median - best_onset, 1e-6)
            model_mean = max(best_mean - best_onset, 1e-6) if best_mean else None

            fit = fit_lag_distribution(model_median, model_mean, best_k)
            mu = fit["mu"]
            sigma = fit["sigma"]
        else:
            mu = 0.0
            sigma = LATENCY_DEFAULT_SIGMA

        onset = best_onset
        t95 = compute_t95(mu, sigma, onset)

        # Write to graph edge
        lat["mu"] = round(mu, 4)
        lat["sigma"] = round(sigma, 4)
        lat["onset_delta_days"] = round(onset, 2)
        lat["t95"] = round(t95, 2)
        lat["median_lag_days"] = round(best_median, 2) if best_median else None
        lat["mean_lag_days"] = round(best_mean, 2) if best_mean else None

        # Compute forecast.mean = total_k / total_n (mature p estimate)
        total_n = 0
        total_k_all = 0
        for v in values:
            n_daily = v.get("n_daily", [])
            k_daily = v.get("k_daily", [])
            if isinstance(n_daily, list) and isinstance(k_daily, list):
                total_n += sum(n_daily)
                total_k_all += sum(k_daily)
        if total_n > 0:
            p["mean"] = round(total_k_all / total_n, 4)

        edge_fits[edge["uuid"]] = {
            "mu": mu, "sigma": sigma, "onset": onset, "t95": t95,
        }

    # --- FW-compose path-level latency ---
    # Build adjacency: for each edge, find the path from anchor to that edge
    # and compose lognormal params via Fenton-Wilkinson approximation.
    # Simple approach: walk edges in topological order, accumulate path params.
    edges_by_uuid = {e["uuid"]: e for e in g.get("edges", [])}

    # Build node → outgoing edges map
    from collections import defaultdict
    outgoing: Dict[str, List[str]] = defaultdict(list)  # node_uuid → [edge_uuid]
    for e in g.get("edges", []):
        outgoing[e["from"]].append(e["uuid"])

    # BFS from anchor to compute path latency
    if anchor:
        # path_params[node_uuid] = (path_onset, path_mu, path_sigma)
        path_params: Dict[str, Tuple[float, float, float]] = {}
        path_params[anchor["uuid"]] = (0.0, 0.0, 0.0)

        visited = set()
        queue = [anchor["uuid"]]
        while queue:
            node_uuid = queue.pop(0)
            if node_uuid in visited:
                continue
            visited.add(node_uuid)

            for edge_uuid in outgoing.get(node_uuid, []):
                edge = edges_by_uuid.get(edge_uuid)
                if not edge:
                    continue
                to_uuid = edge["to"]

                parent_onset, parent_mu, parent_sigma = path_params.get(node_uuid, (0, 0, 0))

                fit = edge_fits.get(edge_uuid)
                if fit:
                    edge_onset = fit["onset"]
                    edge_mu = fit["mu"]
                    edge_sigma = fit["sigma"]

                    # FW composition: sum of independent lognormals
                    path_onset = parent_onset + edge_onset
                    # Approximate: path = parent_lognormal + edge_lognormal
                    # For the first edge from anchor, parent is trivial (0,0)
                    if parent_mu == 0 and parent_sigma == 0:
                        path_mu = edge_mu
                        path_sigma = edge_sigma
                    else:
                        # Fenton-Wilkinson: match first two moments
                        m1 = math.exp(parent_mu + parent_sigma**2/2) + math.exp(edge_mu + edge_sigma**2/2)
                        m2 = (math.exp(2*parent_mu + parent_sigma**2) * (math.exp(parent_sigma**2) - 1) +
                              math.exp(2*edge_mu + edge_sigma**2) * (math.exp(edge_sigma**2) - 1) +
                              m1**2)
                        if m1 > 0 and m2 > m1**2:
                            path_sigma = math.sqrt(math.log(m2 / m1**2))
                            path_mu = math.log(m1) - path_sigma**2 / 2
                        else:
                            path_mu = edge_mu
                            path_sigma = edge_sigma
                else:
                    path_onset = parent_onset
                    path_mu = parent_mu
                    path_sigma = parent_sigma

                # Store best path to this node (shortest onset for now)
                if to_uuid not in path_params or path_onset < path_params[to_uuid][0]:
                    path_params[to_uuid] = (path_onset, path_mu, path_sigma)

                # Write path-level latency to edge
                lat = edge.get("p", {}).get("latency", {})
                if fit:
                    path_t95 = compute_t95(path_mu, path_sigma, path_onset)
                    lat["path_mu"] = round(path_mu, 4)
                    lat["path_sigma"] = round(path_sigma, 4)
                    lat["path_onset_delta_days"] = round(path_onset, 2)
                    lat["path_t95"] = round(path_t95, 2)

                queue.append(to_uuid)

    return g


def _enhance_robust(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Robust statistics with outlier detection and resistance.
    
    Uses median-based methods and outlier removal.
    """
    if not HAS_SCIPY:
        raise ImportError("numpy is required for robust enhancement. Install with: pip install numpy")
    
    daily_data = raw_data.get('raw_data', [])
    
    if len(daily_data) == 0:
        return {
            'method': 'robust',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'robust',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Extract daily probabilities
    p_values = np.array([point['p'] for point in daily_data if point['n'] > 0])
    
    if len(p_values) == 0:
        return {
            'method': 'robust',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'robust',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Use median as robust estimator (less sensitive to outliers), rounded to 3 decimal places
    robust_mean = round(float(np.median(p_values)), 3)
    
    # Use IQR-based standard deviation (more robust than sample std)
    q1, q3 = np.percentile(p_values, [25, 75])
    iqr = q3 - q1
    robust_stdev = float(iqr / 1.35)  # IQR to std approximation for normal-like distributions
    
    # Recalculate k from robust mean
    robust_k = int(round(robust_mean * raw_data['n']))
    
    return {
        'method': 'robust',
        'n': raw_data['n'],
        'k': robust_k,
        'mean': float(robust_mean),
        'stdev': robust_stdev,
        'confidence_interval': None,
        'trend': None,
        'metadata': {
            'raw_method': raw_data['method'],
            'enhancement_method': 'robust',
            'data_points': raw_data['days_included'],
        }
    }

