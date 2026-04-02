"""
Cohort forecast utilities — generalised functions for forecasting conversion
rates and arrival counts at a given age (τ) using Bayesian model parameters.

Pure functions: no DB, no file I/O, no service dependencies.

Key concepts:
  - forecast_rate(τ, p, mu, sigma, onset) → the model-predicted conversion
    rate at age τ:  p × CDF(τ; onset, mu, sigma).
  - read_edge_cohort_params(edge) → extract cohort-level Bayes params from
    a graph edge dict.
  - get_incoming_edges(graph, node_id) → edges feeding into a node.
  - upstream_arrival_rate(τ, graph, node_id) → forecast rate of arrivals
    at a node by age τ, summing incoming edges' forecast y rates.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple


from .forecast_application import compute_completeness


# ── Core forecast function ─────────────────────────────────────────────


def forecast_rate(
    tau: float,
    p: float,
    mu: float,
    sigma: float,
    onset: float = 0.0,
) -> float:
    """Model-predicted conversion rate at age τ: p × CDF(τ; onset, mu, sigma).

    Args:
        tau: age in days.
        p: ultimate conversion probability (forecast_mean or posterior_p).
        mu: log-mean of the shifted lognormal latency.
        sigma: log-stdev of the shifted lognormal latency.
        onset: dead-time before conversions begin (days).

    Returns:
        Predicted rate in [0, 1].
    """
    if p <= 0 or sigma <= 0 or tau < 0:
        return 0.0
    cdf = compute_completeness(float(tau), mu, sigma, onset)
    return max(0.0, min(1.0, p * cdf))


# ── Edge parameter extraction ──────────────────────────────────────────


def read_edge_cohort_params(
    edge: Dict[str, Any],
) -> Optional[Dict[str, float]]:
    """Extract cohort-level (a-anchored) Bayes params from a graph edge.

    Returns a dict with keys {p, mu, sigma, onset} or None if the edge
    lacks required parameters.

    Prefers posterior values over flat fields.  For probability, prefers
    path_alpha/path_beta (cohort-level) over alpha/beta (window-level).
    """
    p_obj = edge.get('p') or {}
    latency = p_obj.get('latency') or {}
    lat_post = latency.get('posterior') or {}
    prob_post = p_obj.get('posterior') or {}

    # Latency: prefer cohort path-level posterior, then edge posterior, then flat.
    mu = (lat_post.get('path_mu_mean')
          or lat_post.get('mu_mean')
          or latency.get('path_mu')
          or latency.get('mu'))
    sigma = (lat_post.get('path_sigma_mean')
             or lat_post.get('sigma_mean')
             or latency.get('path_sigma')
             or latency.get('sigma'))
    onset = (lat_post.get('path_onset_delta_days')
             or lat_post.get('onset_delta_days')
             or latency.get('path_onset_delta_days')
             or latency.get('promoted_onset_delta_days')
             or latency.get('onset_delta_days')
             or 0.0)

    if not isinstance(mu, (int, float)) or not math.isfinite(mu):
        return None
    if not isinstance(sigma, (int, float)) or not math.isfinite(sigma) or sigma <= 0:
        return None

    # Probability: prefer cohort posterior, then window posterior, then forecast.
    path_alpha = prob_post.get('path_alpha')
    path_beta = prob_post.get('path_beta')
    post_alpha = prob_post.get('alpha')
    post_beta = prob_post.get('beta')
    forecast = (p_obj.get('forecast') or {}).get('mean')

    prob: Optional[float] = None
    if (isinstance(path_alpha, (int, float)) and isinstance(path_beta, (int, float))
            and path_alpha > 0 and path_beta > 0):
        prob = float(path_alpha) / (float(path_alpha) + float(path_beta))
    elif (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
            and post_alpha > 0 and post_beta > 0):
        prob = float(post_alpha) / (float(post_alpha) + float(post_beta))
    elif isinstance(forecast, (int, float)) and math.isfinite(forecast) and forecast > 0:
        prob = float(forecast)

    if prob is None or prob <= 0:
        return None

    # Alpha/beta for Bayesian upstream x-forecast (Phase 2).
    # Prefer path-level (cohort) over window-level.
    _alpha: Optional[float] = None
    _beta: Optional[float] = None
    if (isinstance(path_alpha, (int, float)) and isinstance(path_beta, (int, float))
            and path_alpha > 0 and path_beta > 0):
        _alpha = float(path_alpha)
        _beta = float(path_beta)
    elif (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
            and post_alpha > 0 and post_beta > 0):
        _alpha = float(post_alpha)
        _beta = float(post_beta)

    result: Dict[str, float] = {
        'p': float(prob),
        'mu': float(mu),
        'sigma': float(sigma),
        'onset': float(onset) if isinstance(onset, (int, float)) else 0.0,
    }
    if _alpha is not None and _beta is not None:
        result['alpha'] = _alpha
        result['beta'] = _beta
    return result


# ── Graph topology helpers ─────────────────────────────────────────────


def get_incoming_edges(
    graph: Dict[str, Any],
    node_id: str,
) -> List[Dict[str, Any]]:
    """Return all edges whose 'to' field matches node_id."""
    edges = graph.get('edges', []) if isinstance(graph, dict) else []
    return [e for e in edges if str(e.get('to', '')) == str(node_id)]


def get_edge_from_node(edge: Dict[str, Any]) -> str:
    """Return the from-node ID of an edge."""
    return str(edge.get('from') or edge.get('from_node') or '')


def find_edge_by_id(
    graph: Dict[str, Any],
    edge_id: str,
) -> Optional[Dict[str, Any]]:
    """Find an edge by uuid or id."""
    edges = graph.get('edges', []) if isinstance(graph, dict) else []
    return next(
        (e for e in edges
         if str(e.get('uuid') or e.get('id') or '') == str(edge_id)),
        None,
    )


def compute_reach_probability(
    graph: Dict[str, Any],
    node_id: str,
    _visited: Optional[set] = None,
) -> float:
    """Compute reach probability from anchor/start nodes to `node_id`.

    Walks backward through the DAG, multiplying edge conversion rates
    (p.mean) along each path.  At joins, sums across incoming routes.
    Start nodes (no incoming edges) have reach = 1.0.

    Returns the fraction of anchor population expected to arrive at
    `node_id`.  This is Π(edge_p) along each path, summed at joins.
    """
    if _visited is None:
        _visited = set()
    if node_id in _visited:
        return 0.0  # cycle guard (should not happen in DAG)
    _visited.add(node_id)

    incoming = get_incoming_edges(graph, node_id)
    if not incoming:
        # Start/anchor node — reach = 1.0
        return 1.0

    total = 0.0
    for edge in incoming:
        # Edge conversion rate (y/x semantics).
        p_obj = edge.get('p') or {}
        edge_p = p_obj.get('mean', 0.0)
        if not isinstance(edge_p, (int, float)) or edge_p <= 0:
            continue
        from_node = get_edge_from_node(edge)
        if not from_node:
            continue
        upstream_reach = compute_reach_probability(graph, from_node, _visited)
        total += upstream_reach * float(edge_p)

    return min(total, 1.0)  # cap at 1.0


# ── Upstream arrival forecasting ───────────────────────────────────────


def upstream_arrival_rate(
    tau: float,
    graph: Dict[str, Any],
    node_id: str,
) -> Optional[float]:
    """Forecast arrival rate at `node_id` by age τ.

    Sums the forecast y/x rates of all incoming edges (each using its
    own cohort-level Bayes params).  For a node with a single incoming
    edge, this is simply that edge's forecast_rate(τ).

    Returns None if no incoming edges have usable params.
    """
    incoming = get_incoming_edges(graph, node_id)
    if not incoming:
        return None

    total_rate = 0.0
    any_valid = False
    for edge in incoming:
        params = read_edge_cohort_params(edge)
        if params is None:
            continue
        rate = forecast_rate(tau, params['p'], params['mu'], params['sigma'], params['onset'])
        total_rate += rate
        any_valid = True

    return total_rate if any_valid else None


# ── Test fixture loader ──────────────────────────────────────────────


def load_test_fixture(
    fixture_name: str,
    overrides: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Load a test fixture JSON, optionally regenerating frames with different
    evidence distribution params.

    When *overrides* is provided (or non-empty), the frames are regenerated
    from scratch using the fixture's model params for the graph/edge_params
    but a DIFFERENT distribution for evidence accrual.  This lets you flex the
    evidence shape independently of what the model believes.

    Supported override keys (all optional, defaults from the fixture):
        tf_onset  — evidence onset (dead-time before conversions begin)
        tf_mu     — evidence log-mean
        tf_sigma  — evidence log-stdev
        tf_factor — multiplier on model p (e.g. 0.8 = underperforming)
    """
    import json
    import os

    fixture_dir = os.path.join(os.path.dirname(__file__), 'test_fixtures')
    path = os.path.join(fixture_dir, f'{fixture_name}.json')
    with open(path) as f:
        data = json.load(f)

    if overrides:
        data['frames'] = _regenerate_frames(data, overrides)

    return {
        'frames': data['frames'],
        'graph': data['graph'],
        'target_edge_id': data['target_edge_id'],
        'edge_params': data['edge_params'],
        'anchor_from': data['anchor_from'],
        'anchor_to': data['anchor_to'],
        'sweep_to': data['sweep_to'],
        'is_window': data.get('is_window', True),
        'axis_tau_max': data.get('axis_tau_max'),
    }


def _regenerate_frames(
    data: Dict[str, Any],
    overrides: Dict[str, float],
) -> List[Dict[str, Any]]:
    """Regenerate fixture frames using overridden evidence distribution params.

    The model params (edge_params) stay untouched — only the synthetic
    evidence data changes.  This creates the interesting case where evidence
    follows a DIFFERENT distribution shape than the model believes.
    """
    from datetime import date, timedelta
    # Model params (what the model believes — unchanged)
    ep = data['edge_params']
    p_model = ep['forecast_mean']

    # Evidence params (how data actually accrues — overrideable)
    ev_onset = overrides.get('tf_onset', ep['onset_delta_days'])
    ev_mu = overrides.get('tf_mu', ep['mu'])
    ev_sigma = overrides.get('tf_sigma', ep['sigma'])
    ev_factor = overrides.get('tf_factor', 0.8)
    p_actual = ev_factor * p_model

    def cdf(tau: float, onset: float, mu: float, sigma: float) -> float:
        if tau <= onset:
            return 0.0
        z = (math.log(tau - onset) - mu) / sigma
        return 0.5 * math.erfc(-z / math.sqrt(2.0))

    anchor_from = date.fromisoformat(data['anchor_from'])
    anchor_to = date.fromisoformat(data['anchor_to'])
    sweep_to = date.fromisoformat(data['sweep_to'])

    # Extract x values from the original fixture's last frame
    last_frame = data['frames'][-1]
    cohort_x = {dp['anchor_day']: dp['x'] for dp in last_frame['data_points']}
    n_cohorts = (anchor_to - anchor_from).days + 1

    frames: List[Dict[str, Any]] = []
    total_days = (sweep_to - anchor_from).days
    for d in range(total_days + 1):
        as_at = anchor_from + timedelta(days=d)
        data_points: List[Dict[str, Any]] = []
        for c in range(n_cohorts):
            anchor_day = anchor_from + timedelta(days=c)
            if anchor_day > as_at:
                continue
            tau = (as_at - anchor_day).days
            ad_str = anchor_day.isoformat()
            x = cohort_x.get(ad_str, 60)
            y = round(x * p_actual * cdf(tau, ev_onset, ev_mu, ev_sigma))
            data_points.append({
                'anchor_day': ad_str,
                'x': x,
                'y': y,
                'a': x,
                'rate': round(y / x, 6) if x > 0 else 0.0,
            })
        frames.append({
            'snapshot_date': as_at.isoformat(),
            'data_points': data_points,
        })

    print(f"[test_fixture] Regenerated {len(frames)} frames with "
          f"ev_onset={ev_onset} ev_mu={ev_mu} ev_sigma={ev_sigma} "
          f"ev_factor={ev_factor} p_actual={p_actual:.4f}")

    return frames


# ── Cohort maturity complete row computation ───────────────────────────


def compute_cohort_maturity_rows(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    edge_params: Dict[str, float],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool = True,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
) -> List[Dict[str, Any]]:
    """Compute complete per-τ rows for the cohort maturity chart.

    Phase 1a: window() mode, handles single and multiple Cohorts.

    Each row carries rate, midpoint, fan_upper, fan_lower — everything
    the FE needs to draw.  The FE does NO computation.

    Midpoint and fan use Monte Carlo sampling from the posterior:
      - Draw S parameter samples from MVN(posterior_mean, Σ)
      - For each draw, forecast immature Cohorts using conditional mean
      - Aggregate, take quantiles → fan bounds + midpoint (median)

    Args:
        frames: result['frames'] from derive_cohort_maturity.
        graph: scenario graph with Bayes params on edges.
        target_edge_id: UUID of the target edge.
        edge_params: this edge's resolved Bayes params (mu, sigma, onset, p, SDs).
        anchor_from, anchor_to, sweep_to: date range (ISO strings).
        is_window: True for window() mode (Phase 1), False for cohort() (Phase 2).
        band_level: confidence level for fan bands (0.80, 0.90, 0.95, 0.99).

    Returns:
        List of row dicts sorted by tau_days ascending.
    """
    from datetime import date as _date
    from collections import defaultdict
    from .confidence_bands import _shifted_lognormal_cdf

    # ── Resolve edge and dates ─────────────────────────────────────────
    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return []

    # Chart extent: how far (in tau days) the chart should draw.
    # This is anchor-derived and used only for max_tau / row emission range.
    # NOT the rendering zone boundary — that comes from tau_observed later.
    tau_chart_extent = max(0, (sweep_to_d - anchor_from_d).days)

    # Zone boundaries are deferred until tau_observed is computed per cohort
    # (see § after bucket aggregation).  Initialise to anchor-derived proxies
    # so the rest of the code has valid values even if cohort_list is empty.
    tau_solid_max = max(0, (sweep_to_d - anchor_to_d).days)
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)

    # ── Edge Bayes params ──────────────────────────────────────────────
    # In cohort mode, use PATH-level params (composed anchor → target).
    # In window mode, use EDGE-level params.
    if not is_window:
        edge_mu = edge_params.get('path_mu', edge_params.get('mu', 0.0))
        edge_sigma = edge_params.get('path_sigma', edge_params.get('sigma', 0.0))
        edge_onset = edge_params.get('path_onset_delta_days', edge_params.get('onset_delta_days', 0.0))
        edge_p = (edge_params.get('posterior_p_cohort')
                  or edge_params.get('forecast_mean')
                  or edge_params.get('posterior_p')
                  or 0.0)
        edge_p_sd = edge_params.get('p_stdev_cohort', edge_params.get('p_stdev', 0.0)) or 0.0
        edge_mu_sd = edge_params.get('bayes_path_mu_sd', edge_params.get('bayes_mu_sd', 0.0)) or 0.0
        edge_sigma_sd = edge_params.get('bayes_path_sigma_sd', edge_params.get('bayes_sigma_sd', 0.0)) or 0.0
        edge_onset_sd = edge_params.get('bayes_path_onset_sd', edge_params.get('bayes_onset_sd', 0.0)) or 0.0
        edge_onset_mu_corr = edge_params.get('bayes_path_onset_mu_corr', edge_params.get('bayes_onset_mu_corr', 0.0)) or 0.0
    else:
        edge_mu = edge_params.get('mu', 0.0)
        edge_sigma = edge_params.get('sigma', 0.0)
        edge_onset = edge_params.get('onset_delta_days', 0.0)
        edge_p = (edge_params.get('forecast_mean')
                  or edge_params.get('posterior_p_cohort')
                  or edge_params.get('posterior_p')
                  or 0.0)
        edge_p_sd = edge_params.get('p_stdev', edge_params.get('p_stdev_cohort', 0.0)) or 0.0
        edge_mu_sd = edge_params.get('bayes_mu_sd', edge_params.get('bayes_path_mu_sd', 0.0)) or 0.0
        edge_sigma_sd = edge_params.get('bayes_sigma_sd', edge_params.get('bayes_path_sigma_sd', 0.0)) or 0.0
        edge_onset_sd = edge_params.get('bayes_onset_sd', edge_params.get('bayes_path_onset_sd', 0.0)) or 0.0
        edge_onset_mu_corr = edge_params.get('bayes_onset_mu_corr', edge_params.get('bayes_path_onset_mu_corr', 0.0)) or 0.0

    has_bayes = edge_sigma > 0 and edge_p > 0

    # ── Bayesian prior (α₀, β₀) for per-Cohort rate updating ─────────
    # Used by the Bayesian posterior predictive (midpoint + MC fan).
    # Prefer raw alpha/beta from edge posterior; fall back to method of
    # moments from (p, p_stdev); last resort: weak prior from forecast_mean.
    alpha_0: float = 0.0
    beta_0: float = 0.0
    if not is_window:
        _raw_a = edge_params.get('posterior_path_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_path_beta', 0.0) or 0.0
    else:
        _raw_a = edge_params.get('posterior_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_beta', 0.0) or 0.0
    if _raw_a > 0 and _raw_b > 0:
        alpha_0 = float(_raw_a)
        beta_0 = float(_raw_b)
    elif edge_p > 0 and edge_p_sd > 0:
        # Method of moments: κ = p(1−p)/σ² − 1
        _var = edge_p_sd ** 2
        _pq = edge_p * (1.0 - edge_p)
        if _var < _pq:  # valid only when σ² < p(1-p)
            _kappa = _pq / _var - 1.0
            alpha_0 = edge_p * _kappa
            beta_0 = (1.0 - edge_p) * _kappa
    if alpha_0 <= 0 or beta_0 <= 0:
        # Weak prior from forecast_mean with κ_default = 20
        _KAPPA_DEFAULT = 20.0
        _p_prior = edge_p if edge_p > 0 else 0.5
        alpha_0 = _p_prior * _KAPPA_DEFAULT
        beta_0 = (1.0 - _p_prior) * _KAPPA_DEFAULT

    def _cdf(tau: float) -> float:
        if edge_sigma <= 0:
            return 0.0
        return _shifted_lognormal_cdf(tau, edge_onset, edge_mu, edge_sigma)

    def _upstream_cdf(tau: float) -> float:
        """Upstream CDF at age τ (cohort mode only)."""
        if upstream_params is None:
            return 0.0
        up_sigma = upstream_params.get('sigma', 0.0)
        if up_sigma <= 0:
            return 0.0
        return _shifted_lognormal_cdf(
            tau,
            upstream_params.get('onset', 0.0),
            upstream_params.get('mu', 0.0),
            up_sigma,
        )

    # ── Upstream params (cohort mode only) ─────────────────────────────
    # In cohort() mode, x grows with τ.  To forecast x beyond tau_max,
    # we need the reach probability to the subject's from-node and the
    # path-level latency CDF.
    #
    # Option 1 (cohort-x-per-date-estimation.md §3):
    #   x_model(s, τ) = a_s × reach(from_node) × CDF_path(τ)
    # where reach = product of edge rates from anchor to from_node,
    # and CDF_path = composed path latency from anchor to from_node.
    upstream_params_list: List[Dict[str, float]] = []
    reach_at_from_node: float = 0.0
    upstream_params: Optional[Dict[str, float]] = None
    upstream_alpha: float = 0.0
    upstream_beta: float = 0.0
    if not is_window and target_edge is not None:
        from_node_id = get_edge_from_node(target_edge)
        if from_node_id:
            reach_at_from_node = compute_reach_probability(graph, from_node_id)
            incoming = get_incoming_edges(graph, from_node_id)
            for inc_edge in incoming:
                params = read_edge_cohort_params(inc_edge)
                if params:
                    upstream_params_list.append(params)
            # First valid edge for alpha-beta.
            if upstream_params_list:
                upstream_params = upstream_params_list[0]
                upstream_alpha = upstream_params.get('alpha', 0.0)
                upstream_beta = upstream_params.get('beta', 0.0)
                if upstream_alpha <= 0 or upstream_beta <= 0:
                    _up_p = upstream_params['p']
                    upstream_alpha = _up_p * 20.0
                    upstream_beta = (1.0 - _up_p) * 20.0

    # ── Path-level prior for cohort-mode y-forecast ──────────────────
    # In cohort mode, y_forecast uses a_pop × path_CDF × path_rate.
    # path_rate = P(anchor entrant converts at to-node) = upstream_p × edge_p.
    # alpha_0/beta_0 encode the EDGE rate — we need separate path-level
    # alpha/beta so y/x → edge_rate at τ→∞ (not y/x → 1.0).
    path_alpha: float = alpha_0
    path_beta: float = beta_0
    if not is_window and upstream_params is not None:
        _up_p = upstream_params['p']
        _path_p = edge_p * _up_p  # path rate = edge rate × upstream rate
        # Use the edge's concentration (κ = α₀+β₀) scaled to the path rate
        _kappa_path = alpha_0 + beta_0
        path_alpha = _path_p * _kappa_path
        path_beta = (1.0 - _path_p) * _kappa_path

    # ── Per-Cohort info from last frame ────────────────────────────────
    cohort_info: Dict[str, Dict[str, Any]] = {}
    last_frame = None
    for f in frames:
        if f.get('snapshot_date') and str(f['snapshot_date'])[:10] <= str(sweep_to)[:10]:
            last_frame = f
    # tau_max for each Cohort is based on the last frame's snapshot date
    # (the actual last observation), NOT sweep_to.  When sweep_to extends
    # beyond the data, the Cohort should be immature for the gap — not
    # treated as mature with carry-forward of stale observations.
    last_frame_date = None
    if last_frame:
        try:
            last_frame_date = _date.fromisoformat(str(last_frame.get('snapshot_date', ''))[:10])
        except (ValueError, TypeError):
            pass

    if last_frame and last_frame.get('data_points'):
        for dp in last_frame['data_points']:
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            # Filter: only include Cohorts within the anchor window.
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            a_val = dp.get('a', 0)  # anchor population
            if not isinstance(x_val, (int, float)):
                x_val = 0
            if not isinstance(a_val, (int, float)) or a_val <= 0:
                a_val = max(x_val, 1)  # fallback
            # In cohort mode, x can be 0 for young Cohorts — don't skip.
            # Use anchor population 'a' as the base for forecasting.
            # In window mode, x must be > 0 (fixed denominator).
            if is_window and x_val <= 0:
                continue
            # tau_max = last observed age, not sweep_to - anchor_day
            obs_date = last_frame_date or sweep_to_d
            tau_max = (min(obs_date, sweep_to_d) - ad).days
            cohort_info[ad_str] = {
                'anchor_day': ad,
                'x_frozen': float(x_val) if x_val > 0 else 0.0,
                'y_frozen': float(y_val) if isinstance(y_val, (int, float)) else 0.0,
                'a_frozen': float(a_val),
                'tau_max': tau_max,
            }

    if not cohort_info:
        return []

    cohort_list = list(cohort_info.values())

    # ── Bucket aggregation from all frames ─────────────────────────────
    cohort_at_tau: Dict[str, Dict[int, Tuple[float, float]]] = defaultdict(dict)

    class _Bucket:
        __slots__ = ('sum_y', 'sum_x', 'sum_y_mature', 'sum_x_mature',
                     'sum_proj_y', 'sum_proj_x', 'count', 'mature_count', 'proj_count')
        def __init__(self) -> None:
            self.sum_y = 0.0; self.sum_x = 0.0
            self.sum_y_mature = 0.0; self.sum_x_mature = 0.0
            self.sum_proj_y = 0.0; self.sum_proj_x = 0.0
            self.count = 0; self.mature_count = 0; self.proj_count = 0

    buckets: Dict[int, _Bucket] = {}

    for frame in frames:
        as_at_str = str(frame.get('snapshot_date', ''))[:10]
        if not as_at_str:
            continue
        try:
            as_at_d = _date.fromisoformat(as_at_str)
        except (ValueError, TypeError):
            continue
        for dp in (frame.get('data_points') or []):
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            tau = (as_at_d - ad).days
            if tau < 0:
                continue
            y_val = dp.get('y')
            x_val = dp.get('x')
            proj_y = dp.get('projected_y')
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if tau not in buckets:
                buckets[tau] = _Bucket()
            b = buckets[tau]
            ci = cohort_info.get(ad_str)
            is_mature = ci is not None and tau <= ci['tau_max']
            if y_val is not None and isinstance(y_val, (int, float)):
                b.sum_y += float(y_val)
                b.sum_x += float(x_val)
                b.count += 1
                if is_mature:
                    b.sum_y_mature += float(y_val)
                    b.sum_x_mature += float(x_val)
                    b.mature_count += 1
                cohort_at_tau[ad_str][tau] = (float(x_val), float(y_val))
            if proj_y is not None and isinstance(proj_y, (int, float)):
                b.sum_proj_y += float(proj_y)
                b.sum_proj_x += float(x_val)
                b.proj_count += 1

    # ── Determine tau_observed per Cohort ─────────────────────────────
    # tau_observed is the τ at which the last REAL evidence was obtained.
    # The sweep may extend beyond the last real retrieval with carry-forward
    # frames — using tau_max (= sweep_to - anchor_day) would overstate
    # how much evidence we have, making the fan too narrow.
    #
    # Primary source: p.evidence.retrieved_at from the graph edge, which
    # gives the actual date the data was last fetched.
    # Fallback: heuristic from y changes in the frame data.
    evidence_retrieved_at = edge_params.get('evidence_retrieved_at')
    evidence_retrieved_d: Optional[_date] = None
    if evidence_retrieved_at:
        try:
            # Handle both ISO datetime and date-only strings
            ev_str = str(evidence_retrieved_at)[:10]
            evidence_retrieved_d = _date.fromisoformat(ev_str)
        except (ValueError, TypeError):
            pass

    for c in cohort_list:
        ad = c['anchor_day']
        # Primary: use evidence_retrieved_at from graph
        if evidence_retrieved_d is not None:
            tau_obs = min((evidence_retrieved_d - ad).days, c['tau_max'])
            tau_obs = max(0, tau_obs)
        else:
            # Fallback: no evidence_retrieved_at — assume evidence covers
            # the full sweep range for this cohort (tau_max = sweep_to − anchor).
            # A Y-increase heuristic was previously used here but it breaks
            # when Y plateaus (cohort fully converted) — plateau IS evidence.
            tau_obs = c['tau_max']
        c['tau_observed'] = tau_obs

    # ── Derive rendering zone boundaries from actual evidence ──────────
    # tau_solid_max (epoch A/B boundary): youngest cohort's observation depth
    #   → below this tau, ALL cohorts have evidence. Fan collapsed.
    # tau_future_max (epoch B/C boundary): oldest cohort's observation depth
    #   → above this tau, NO cohort has evidence. Pure projection.
    # See docs/current/codebase/DATE_MODEL_COHORT_MATURITY.md §2.2.
    if cohort_list:
        tau_solid_max = min(c['tau_observed'] for c in cohort_list)
        tau_future_max = max(c['tau_observed'] for c in cohort_list)
    print(f"[zone_boundaries] tau_solid_max={tau_solid_max} tau_future_max={tau_future_max} "
          f"tau_chart_extent={tau_chart_extent} cohorts={len(cohort_list)}")

    # ── Determine max τ for row emission ───────────────────────────────
    # Use the axis extent from the caller (computed from t95/sweep_span
    # in api_handlers), falling back to a local estimate.
    max_tau = tau_chart_extent
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    elif has_bayes:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(0.95, edge_mu, edge_sigma) + edge_onset
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass

    # ── Monte Carlo fan bands ────────────────────────────────────────
    _mc_msg = (f"[MC_diag] has_bayes={has_bayes} edge_mu_sd={edge_mu_sd} edge_sigma_sd={edge_sigma_sd} "
               f"edge_onset_sd={edge_onset_sd} edge_p_sd={edge_p_sd} edge_p={edge_p} "
               f"edge_mu={edge_mu} edge_sigma={edge_sigma} edge_onset={edge_onset} "
               f"cohorts={len(cohort_list)} is_window={is_window}")
    print(_mc_msg)
    # Bayesian prior diagnostic
    print(f"[BAYES_prior] alpha_0={alpha_0:.4f} beta_0={beta_0:.4f} "
          f"prior_rate={alpha_0/(alpha_0+beta_0):.6f}")
    if upstream_params is not None:
        print(f"[BAYES_upstream] p={upstream_params.get('p'):.6f} "
              f"mu={upstream_params.get('mu'):.4f} sigma={upstream_params.get('sigma'):.4f} "
              f"onset={upstream_params.get('onset'):.4f} "
              f"alpha={upstream_alpha:.4f} beta={upstream_beta:.4f} "
              f"up_prior_rate={upstream_alpha/(upstream_alpha+upstream_beta):.6f}")
        print(f"[BAYES_path] path_alpha={path_alpha:.4f} path_beta={path_beta:.4f} "
              f"path_prior_rate={path_alpha/(path_alpha+path_beta):.6f} "
              f"expected_y_x_ratio_at_inf={path_alpha/(path_alpha+path_beta) / (upstream_alpha/(upstream_alpha+upstream_beta)):.4f}")
    # Also write to file for debugging
    try:
        with open('/tmp/mc_diag.log', 'a') as _f:
            _f.write(_mc_msg + '\n')
    except Exception:
        pass
    # Draw S parameter samples from MVN(posterior_mean, Σ).
    # For each draw, forecast each immature Cohort forward using the
    # conditional mean, aggregate, and collect quantiles.
    #
    # This replaces the delta method (Jacobian + conditional variance),
    # which breaks down near the onset due to nonlinearity.
    MC_SAMPLES = 2000
    fan_quantiles: Optional[Dict[int, Tuple[float, float]]] = None  # tau → (lo, hi)

    if has_bayes and edge_mu_sd > 0:
        import numpy as np
        from .confidence_bands import _ndtr

        def _weighted_pct(values, weights, pct):
            """Weighted percentile via sorted cumulative weights."""
            idx = np.argsort(values)
            cumw = np.cumsum(weights[idx])
            return float(values[idx][np.searchsorted(cumw, pct / 100.0)])

        # Build posterior covariance matrix
        # Order: [p, mu, sigma, onset]
        theta_mean = np.array([edge_p, edge_mu, edge_sigma, edge_onset])
        sds = np.array([edge_p_sd, edge_mu_sd, edge_sigma_sd, edge_onset_sd])
        cov = np.diag(sds ** 2)
        # onset-mu off-diagonal
        cov[3, 1] = cov[1, 3] = edge_onset_mu_corr * edge_onset_sd * edge_mu_sd

        rng = np.random.default_rng(42)
        samples = rng.multivariate_normal(theta_mean, cov, size=MC_SAMPLES)

        # Clip to valid ranges
        samples[:, 0] = np.clip(samples[:, 0], 1e-6, 1 - 1e-6)  # p
        samples[:, 2] = np.clip(samples[:, 2], 0.01, 20.0)       # sigma > 0

        # tau grid
        tau_grid = np.arange(0, max_tau + 1, dtype=float)  # (T,)
        T = len(tau_grid)
        S = MC_SAMPLES

        # Compute per-draw latency CDF and conversion fraction.
        # cdf_arr = pure latency CDF (timing only), used for n_eff / posterior update.
        # q = p × CDF (conversion fraction), used for total converted by τ.
        # The Bayes design doc (§2.3) defines n_eff = x × CDF(tau_max), NOT x × p × CDF.
        p_s = samples[:, 0]       # (S,)
        mu_s = samples[:, 1]      # (S,)
        sigma_s = samples[:, 2]   # (S,)
        onset_s = samples[:, 3]   # (S,)

        t_shifted = tau_grid[None, :] - onset_s[:, None]  # (S, T)
        t_shifted = np.maximum(t_shifted, 1e-12)
        z = (np.log(t_shifted) - mu_s[:, None]) / sigma_s[:, None]  # (S, T)
        cdf_arr = _ndtr(z)  # (S, T) — pure latency CDF
        # Zero out pre-onset
        cdf_arr = np.where(tau_grid[None, :] > onset_s[:, None], cdf_arr, 0.0)
        cdf_arr = np.clip(cdf_arr, 0.0, 1.0)
        q = p_s[:, None] * cdf_arr  # (S, T) — conversion fraction p × CDF
        q = np.clip(q, 0.0, 1.0)

        # ── Upstream path CDF for cohort mode (x grows with τ) ─────────
        # Option 1 (cohort-x-per-date-estimation.md §3):
        #   x_model(s, τ) = a_s × reach(from_node) × CDF_path(τ)
        # where reach = product of edge rates from anchor to from_node
        # (computed above), and CDF_path = the path-level latency CDF.
        #
        # The CDF shape comes from upstream edges' path-level latency
        # params.  We use a weighted average CDF across incoming edges
        # (weighted by each route's edge rate contribution).
        # The reach probability provides the correct scaling.
        upstream_path_cdf = None  # (T,) — path latency CDF shape
        if not is_window and upstream_params_list and reach_at_from_node > 0:
            # Weighted-average CDF across incoming routes.
            # Weight = each upstream edge's p (its share of arrivals at the node).
            total_weight = 0.0
            upstream_path_cdf = np.zeros(T)
            for _up in upstream_params_list:
                _up_p = _up['p']
                _up_mu = _up['mu']
                _up_sigma = _up['sigma']
                _up_onset = _up.get('onset', 0.0)
                _up_shifted = tau_grid - _up_onset  # (T,)
                _up_shifted = np.maximum(_up_shifted, 1e-12)
                _up_z = (np.log(_up_shifted) - _up_mu) / _up_sigma
                _up_cdf = _ndtr(_up_z)  # (T,) — pure latency CDF (no p)
                _up_cdf = np.where(tau_grid > _up_onset, _up_cdf, 0.0)
                _up_cdf = np.clip(_up_cdf, 0.0, 1.0)
                upstream_path_cdf += _up_p * _up_cdf
                total_weight += _up_p
            if total_weight > 0:
                upstream_path_cdf /= total_weight  # normalise to [0, 1]
            upstream_path_cdf = np.clip(upstream_path_cdf, 0.0, 1.0)

        # ── Importance weighting: condition MC draws on evidence ─────
        # The MVN draws represent prior parameter uncertainty.
        # The Cohort evidence (k_i conversions out of N_i people at
        # tau_max_i) constrains which draws are plausible.
        #
        # For each draw θ^(b), compute the Binomial likelihood of the
        # observed data:
        #   p_window_i^(b) = p^(b) × CDF(tau_max_i; θ^(b))
        #   log L^(b) = Σ_i [ k_i log(p_w) + (N_i-k_i) log(1-p_w) ]
        #
        # Normalise to get importance weights W^(b).  Resample to get
        # equally-weighted draws from the conditioned posterior.
        #
        # This naturally handles everything:
        #   - Zero maturity → no evidence → uniform weights → confidence band
        #   - More Cohorts / data → stronger conditioning → narrower fan
        #   - Conditions (mu, sigma, onset) too — not just p
        log_weights = np.zeros(S)
        for c in cohort_list:
            N_i = c['x_frozen']
            k_i = c['y_frozen']
            if N_i <= 0 and (is_window or upstream_path_cdf is None):
                continue
            a_idx = min(c['tau_max'], T - 1)
            # p_window = probability a person converts within tau_max
            p_window = p_s * cdf_arr[:, a_idx]              # (S,)
            p_window = np.clip(p_window, 1e-15, 1 - 1e-15)
            # Binomial log-likelihood (dropping constant C(N,k))
            log_weights += k_i * np.log(p_window) + (N_i - k_i) * np.log(1 - p_window)

        # Normalise (log-sum-exp for numerical stability)
        log_weights -= np.max(log_weights)
        weights = np.exp(log_weights)
        weights /= weights.sum()

        # Effective sample size diagnostic
        ess = 1.0 / np.sum(weights ** 2)
        print(f"[BAYES_IS] ESS={ess:.0f}/{S} "
              f"max_weight={weights.max():.4f} "
              f"p_conditioned=[{_weighted_pct(p_s, weights, 10):.4f} "
              f"{_weighted_pct(p_s, weights, 50):.4f} "
              f"{_weighted_pct(p_s, weights, 90):.4f}]")

        # Resample to get equally-weighted conditioned draws
        resample_idx = rng.choice(S, size=S, replace=True, p=weights)
        cdf_arr = cdf_arr[resample_idx]         # (S, T) — conditioned
        p_s = p_s[resample_idx]                  # (S,) — conditioned
        q = q[resample_idx]                      # (S, T) — conditioned
        samples = samples[resample_idx]          # (S, 4) — conditioned

        # Per-Cohort conditional forecast, aggregated
        total_N = sum(c['x_frozen'] for c in cohort_list)
        Y_total = np.zeros((S, T))  # numerator
        X_total = np.zeros((S, T))  # denominator (constant in window mode)

        for c in cohort_list:
            N_i = c['x_frozen']
            k_i = c['y_frozen']
            a_pop = c.get('a_frozen', N_i) or N_i or 1.0  # anchor population
            a_i = c['tau_max']
            ad_str = c['anchor_day'].isoformat()

            a_idx = min(a_i, T - 1)

            if is_window or upstream_path_cdf is None:
                # Window mode: forecast with conditioned draws.
                # y = k + N × remaining_cdf × p (conditioned p and CDF).
                if N_i <= 0:
                    continue  # No arrivals in window mode → skip.
                cdf_at_a = cdf_arr[:, a_idx]      # (S,)
                c_i_b = cdf_at_a[:, None]          # (S, 1)
                remaining_cdf = np.maximum(cdf_arr - c_i_b, 0.0)  # (S, T)
                n_eff_b = N_i * c_i_b                              # (S, 1)
                y_forecast = k_i + N_i * remaining_cdf * p_s[:, None]  # (S, T)
                x_forecast_arr = np.full((S, T), N_i)
                y_forecast = np.clip(y_forecast, k_i, N_i)
            else:
                # Cohort mode: same conditioned draws, growing x.
                cdf_at_a = cdf_arr[:, a_idx]      # (S,)
                c_i_b = cdf_at_a[:, None]          # (S, 1)
                remaining_cdf = np.maximum(cdf_arr - c_i_b, 0.0)  # (S, T)

                # Option 1 (cohort-x-per-date-estimation.md §3):
                #   x_model(s, τ) = a_s × reach(from_node) × CDF_path(τ)
                x_model = a_pop * reach_at_from_node * upstream_path_cdf  # (T,)
                x_model_floored = np.maximum(x_model, N_i)  # floor at x_frozen

                x_forecast_arr = np.broadcast_to(
                    x_model_floored[None, :], (S, T)
                ).copy()

                x_at_frontier = float(x_model_floored[a_idx])
                n_eff_b = N_i * c_i_b                              # (S, 1)
                y_forecast = k_i + x_at_frontier * remaining_cdf * p_s[:, None]  # (S, T)
                y_forecast = np.clip(y_forecast, k_i, x_forecast_arr)

            # Mature ages: use observed (x, y) — same across all draws.
            # In cohort mode, cohort_at_tau is sparse (not every τ has data).
            # Carry forward the last known (x, y) — both can only increase,
            # so carry-forward is monotonically correct.
            # In window mode, x is fixed at N_i for all τ.
            observed_x = np.zeros(T)
            observed_y = np.zeros(T)
            tau_data = cohort_at_tau.get(ad_str, {})
            last_x = 0.0 if not is_window else float(N_i)
            last_y = 0.0
            for t_idx in range(T):
                t_val = int(tau_grid[t_idx])
                if t_val <= a_i:
                    obs = tau_data.get(t_val)
                    if obs:
                        last_x = obs[0]
                        last_y = obs[1]
                    elif is_window:
                        last_x = float(N_i)
                        # last_y stays as previous (carry-forward)
                    observed_x[t_idx] = last_x
                    observed_y[t_idx] = last_y

            # Combine: observed where mature, forecast where immature
            mature_mask = tau_grid <= a_i  # (T,) bool
            Y_cohort = np.where(mature_mask[None, :], observed_y[None, :], y_forecast)
            X_cohort = np.where(mature_mask[None, :], observed_x[None, :], x_forecast_arr)

            # ── Zero-maturity diagnostic ──────────────────────────────────
            # Dump decomposition for low-maturity Cohorts to diagnose
            # degeneration to model curve.  Only for immature Cohorts
            # (tau_max <= 5) to keep output manageable.
            if a_i <= 5:
                _diag_taus = [t for t in [0, 1, 2, 3, 5, 10, 15, 20, 30] if t < T]
                _mode_str = 'window' if is_window else 'cohort'
                _x_front = float(N_i) if is_window else x_at_frontier
                for _dt in _diag_taus:
                    if _dt <= a_i:
                        continue  # mature at this tau, skip
                    _model_rate = edge_p * _shifted_lognormal_cdf(
                        float(_dt), edge_onset, edge_mu, edge_sigma)
                    _x_med = float(np.median(X_cohort[:, _dt]))
                    _y_med = float(np.median(Y_cohort[:, _dt]))
                    _rate_med = _y_med / _x_med if _x_med > 0 else 0.0
                    _r_src = p_s[:, None]  # conditioned p draws
                    _r_draw_med = float(np.median(_r_src))
                    _r_draw_p10 = float(np.percentile(_r_src, 10))
                    _r_draw_p90 = float(np.percentile(_r_src, 90))
                    _n_eff_med = float(np.median(n_eff_b))
                    print(f"[DIAG_0d] {_mode_str} tau={_dt} ad={ad_str} tau_max={a_i} "
                          f"N_i={N_i:.0f} k_i={k_i:.0f} a_pop={a_pop:.0f} "
                          f"c_i_med={float(np.median(c_i_b)):.6f} "
                          f"n_eff_med={_n_eff_med:.3f} "
                          f"r_draw=[{_r_draw_p10:.4f} {_r_draw_med:.4f} {_r_draw_p90:.4f}] "
                          f"x_frontier={_x_front:.1f} "
                          f"x_med={_x_med:.1f} y_med={_y_med:.2f} "
                          f"rate_med={_rate_med:.4f} "
                          f"model_rate={_model_rate:.4f} "
                          f"delta={_rate_med - _model_rate:.4f}")

            Y_total += Y_cohort
            X_total += X_cohort

        # Aggregate rate: (S, T)
        X_total_safe = np.maximum(X_total, 1e-10)
        rate_agg = Y_total / X_total_safe

        # Extract quantiles for all band levels (for Blend mode)
        # plus the user-selected single band level.
        _band_levels = [0.80, 0.90, 0.95, 0.99]
        _pcts = [50.0]  # always need median
        for bl in _band_levels:
            a = (1.0 - bl) / 2.0
            _pcts.extend([a * 100, (1.0 - a) * 100])
        # [50, 10, 90, 5, 95, 2.5, 97.5, 0.5, 99.5]
        _all_q = np.percentile(rate_agg, sorted(set(_pcts)), axis=0)  # (n_pcts, T)
        _pct_sorted = sorted(set(_pcts))
        _q_by_pct = {p: _all_q[i] for i, p in enumerate(_pct_sorted)}

        # User-selected band level
        a_sel = (1.0 - band_level) / 2.0
        q_sel_lo = _q_by_pct.get(a_sel * 100, _q_by_pct.get(5.0))
        q_sel_hi = _q_by_pct.get((1.0 - a_sel) * 100, _q_by_pct.get(95.0))
        q50 = _q_by_pct[50.0]

        fan_quantiles = {}
        for t_idx in range(T):
            tau_val = int(tau_grid[t_idx])
            fan_quantiles[tau_val] = {
                'lo': float(q_sel_lo[t_idx]),
                'mid': float(q50[t_idx]),
                'hi': float(q_sel_hi[t_idx]),
                # All band levels for Blend mode
                'bands': {
                    bl: (float(_q_by_pct[(1.0 - bl) / 2.0 * 100][t_idx]),
                         float(_q_by_pct[(1.0 + bl) / 2.0 * 100][t_idx]))
                    for bl in _band_levels
                },
            }

    # ── Emit rows ──────────────────────────────────────────────────────
    rows: List[Dict[str, Any]] = []

    for tau in range(0, max_tau + 1):
        b = buckets.get(tau)

        # Evidence rate: uses observed (x, y) per Cohort at this τ.
        # For sparse cohort_at_tau (cohort mode), use carry-forward from
        # the precomputed per-Cohort arrays built during MC setup.
        # For immature Cohorts: use frozen (x, y).
        evidence_rate: Optional[float] = None
        if tau <= tau_future_max:
            ev_y = 0.0
            ev_x = 0.0
            for c in cohort_list:
                ad_str = c['anchor_day'].isoformat()
                if tau <= c['tau_max']:
                    # Mature: find the last known (x, y) at or before this τ
                    tau_data = cohort_at_tau.get(ad_str, {})
                    obs = tau_data.get(tau)
                    if obs:
                        ev_x += obs[0]
                        ev_y += obs[1]
                    else:
                        # Carry forward: find the latest τ' ≤ τ with data
                        best_x, best_y = 0.0, 0.0
                        if is_window:
                            best_x = c['x_frozen']  # x fixed in window
                        for t2 in range(tau, -1, -1):
                            obs2 = tau_data.get(t2)
                            if obs2:
                                best_x, best_y = obs2[0], obs2[1]
                                break
                        ev_x += best_x
                        ev_y += best_y
                else:
                    # Immature: carry-forward frozen
                    ev_x += c['x_frozen']
                    ev_y += c['y_frozen']
            if ev_x > 0:
                evidence_rate = max(0.0, min(1.0, ev_y / ev_x))

        # Projected rate from backend annotation
        projected_rate: Optional[float] = None
        if b and b.sum_proj_x > 0 and b.proj_count > 0:
            projected_rate = max(0.0, min(1.0, b.sum_proj_y / b.sum_proj_x))

        # ── Midpoint: calibrated CDF ratio ─────────────────────────────
        midpoint: Optional[float] = None
        total_x_aug = 0.0
        total_y_aug = 0.0

        for c in cohort_list:
            ad_str = c['anchor_day'].isoformat()
            if tau <= c['tau_max']:
                # Mature: use per-τ observed values.
                # In cohort mode, cohort_at_tau is sparse — carry forward
                # the last known (x, y) for this Cohort (both monotonic).
                obs = cohort_at_tau.get(ad_str, {}).get(tau)
                if obs:
                    total_x_aug += obs[0]
                    total_y_aug += obs[1]
                elif is_window:
                    total_x_aug += c['x_frozen']
                    # y stays 0 (no observation at this τ)
                else:
                    # Cohort mode sparse: find last known (x, y) at τ' ≤ τ.
                    tau_data = cohort_at_tau.get(ad_str, {})
                    last_x, last_y = 0.0, 0.0
                    for t_prev in range(tau, -1, -1):
                        prev_obs = tau_data.get(t_prev)
                        if prev_obs:
                            last_x, last_y = prev_obs[0], prev_obs[1]
                            break
                    total_x_aug += last_x
                    total_y_aug += last_y
            else:
                # Immature: Bayesian posterior predictive
                x_frozen = c['x_frozen']
                y_frozen = c['y_frozen']
                c_i = _cdf(c['tau_max'])
                cdf_at_tau = _cdf(tau)

                if is_window or not upstream_params_list or reach_at_from_node <= 0:
                    # Window mode: x fixed, y forecast from edge CDF
                    x_forecast = x_frozen
                    n_eff = x_frozen * c_i
                    posterior_rate = (alpha_0 + y_frozen) / (alpha_0 + beta_0 + n_eff)
                    y_forecast = y_frozen + x_frozen * max(0.0, cdf_at_tau - c_i) * posterior_rate
                    y_forecast = min(x_forecast, y_forecast)
                else:
                    # Cohort mode: x grows with τ.
                    # Option 1: x_model = a_s × reach(from_node) × CDF_path(τ)
                    a_pop = c.get('a_frozen', x_frozen) or x_frozen or 1.0

                    # Weighted-average path CDF at tau and at frontier.
                    cdf_at_tau_w = 0.0
                    cdf_at_frontier_w = 0.0
                    total_w = 0.0
                    for _up in upstream_params_list:
                        _up_sigma = _up.get('sigma', 0.0)
                        if _up_sigma > 0:
                            _up_p = _up['p']
                            cdf_at_tau_w += _up_p * _shifted_lognormal_cdf(
                                tau, _up.get('onset', 0.0), _up['mu'], _up_sigma)
                            cdf_at_frontier_w += _up_p * _shifted_lognormal_cdf(
                                c['tau_max'], _up.get('onset', 0.0), _up['mu'], _up_sigma)
                            total_w += _up_p
                    if total_w > 0:
                        cdf_at_tau_w /= total_w
                        cdf_at_frontier_w /= total_w

                    x_forecast = max(a_pop * reach_at_from_node * cdf_at_tau_w, x_frozen)
                    x_at_frontier = max(a_pop * reach_at_from_node * cdf_at_frontier_w, x_frozen)

                    # y_forecast: Bayesian posterior predictive.
                    # n_eff from x_frozen (observed trials — posterior confidence).
                    # Forward projection from x_at_frontier (model arrivals at frontier).
                    n_eff = x_frozen * c_i
                    posterior_rate = (alpha_0 + y_frozen) / (alpha_0 + beta_0 + n_eff)
                    y_forecast = y_frozen + x_at_frontier * max(0.0, cdf_at_tau - c_i) * posterior_rate
                    y_forecast = min(x_forecast, y_forecast)

                if tau == 10 or tau == 20 or tau == 30:
                    print(f"[MID_cohort] tau={tau} ad={c['anchor_day']} tau_max={c['tau_max']} "
                          f"x_frz={x_frozen:.1f} y_frz={y_frozen:.1f} "
                          f"c_i={c_i:.6f} cdf_tau={cdf_at_tau:.6f} "
                          f"x_fc={x_forecast:.1f} y_fc={y_forecast:.2f} "
                          f"post_r={posterior_rate:.6f} rate={y_forecast/max(x_forecast,0.01):.4f}")

                total_x_aug += x_forecast
                total_y_aug += y_forecast

        if total_x_aug > 0:
            midpoint = max(0.0, min(1.0, total_y_aug / total_x_aug))

        # Epoch A: midpoint = evidence, no value in showing.
        # At tau_solid_max itself, emit midpoint so the dotted line
        # connects with the solid line endpoint (no visual gap).
        if tau < tau_solid_max:
            midpoint = None

        # Epoch C: midpoint IS the projection
        if tau > tau_future_max and midpoint is not None:
            projected_rate = midpoint

        # ── Fan: Monte Carlo quantile bands ──────────────────────────
        fan_upper: Optional[float] = None
        fan_lower: Optional[float] = None

        fan_bands: Optional[Dict[str, Tuple[float, float]]] = None

        if midpoint is not None and fan_quantiles is not None:
            fq = fan_quantiles.get(tau)
            if fq is not None:
                if tau <= tau_solid_max:
                    fan_upper = midpoint
                    fan_lower = midpoint
                    fan_bands = {str(int(bl * 100)): (midpoint, midpoint) for bl in [0.80, 0.90, 0.95, 0.99]}
                else:
                    fan_lower = fq['lo']
                    fan_upper = fq['hi']
                    midpoint = fq['mid']
                    fan_bands = {str(int(bl * 100)): lo_hi for bl, lo_hi in fq['bands'].items()}

        # Diagnostic for epoch B debugging
        if tau in (tau_solid_max, tau_solid_max + 1, tau_solid_max + 2, tau_future_max, tau_future_max + 1):
            _bsy = b.sum_y if b else 0
            _bsx = b.sum_x if b else 0
            _ev = f"{evidence_rate:.4f}" if evidence_rate is not None else "null"
            _mp = f"{midpoint:.4f}" if midpoint is not None else "null"
            _fu = f"{fan_upper:.4f}" if fan_upper is not None else "null"
            _fl = f"{fan_lower:.4f}" if fan_lower is not None else "null"
            print(f"[fan_diag] tau={tau} ev={_ev} mid={_mp} bucket_y/x={_bsy:.1f}/{_bsx:.1f} aug_y/x={total_y_aug:.1f}/{total_x_aug:.1f} fan=[{_fl},{_fu}]")

        # Skip empty rows
        if evidence_rate is None and midpoint is None and projected_rate is None:
            continue

        row: Dict[str, Any] = {
            'tau_days': tau,
            'rate': evidence_rate,
            'projected_rate': projected_rate,
            'midpoint': midpoint,
            'fan_upper': fan_upper,
            'fan_lower': fan_lower,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': b.mature_count if b else 0,
            'cohorts_covered_projected': b.proj_count if b else 0,
        }
        if fan_bands:
            row['fan_bands'] = fan_bands
        rows.append(row)

    return rows
