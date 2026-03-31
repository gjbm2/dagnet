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
from typing import Any, Dict, List, Optional


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

    return {
        'p': float(prob),
        'mu': float(mu),
        'sigma': float(sigma),
        'onset': float(onset) if isinstance(onset, (int, float)) else 0.0,
    }


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


# ── Cohort maturity fan chart computation ──────────────────────────────


def compute_cohort_maturity_fan(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    edge_params: Dict[str, float],
    band_upper_by_tau: Dict[int, float],
    band_lower_by_tau: Dict[int, float],
    model_rate_by_tau: Dict[int, float],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
) -> Dict[int, Dict[str, Optional[float]]]:
    """Compute per-τ midpoint and fan bounds for the cohort maturity chart.

    For each τ in epochs B and C:
      - Forecasts x growth for dropped cohorts using upstream edge params
      - Forecasts y using this edge's params
      - Computes midpoint = (Σy_observed + Σy_forecast) / (Σx_observed + Σx_forecast)
      - Computes fan bounds from the Bayesian confidence band, centred on midpoint

    Args:
        frames: result['frames'] from derive_cohort_maturity — per-day per-cohort data.
        graph: the scenario graph (with Bayes params on edges).
        target_edge_id: UUID of the target edge.
        edge_params: this edge's resolved params (mu, sigma, onset, forecast_mean, etc.).
        band_upper_by_tau: model band upper envelope keyed by τ.
        band_lower_by_tau: model band lower envelope keyed by τ.
        model_rate_by_tau: promoted model curve rate keyed by τ.
        anchor_from, anchor_to: cohort date range (ISO strings).
        sweep_to: boundary date (ISO string).

    Returns:
        Dict keyed by τ (int days) → {midpoint, fan_upper, fan_lower}.
        Only includes τ values where fan data is meaningful (epoch B+C).
    """
    from datetime import date as _date

    # Find the target edge and its from-node
    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return {}
    from_node_id = get_edge_from_node(target_edge)
    if not from_node_id:
        return {}

    # Parse dates
    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return {}

    # Epoch boundaries
    tau_solid_max = (sweep_to_d - anchor_to_d).days
    tau_future_max = (sweep_to_d - anchor_from_d).days
    if tau_solid_max < 0 or tau_future_max < 0:
        return {}

    # Upstream arrival rate function for x forecasting
    upstream_params_list: List[Dict[str, float]] = []
    for inc_edge in get_incoming_edges(graph, from_node_id):
        params = read_edge_cohort_params(inc_edge)
        if params is not None:
            upstream_params_list.append(params)

    def _upstream_rate(tau: float) -> Optional[float]:
        if not upstream_params_list:
            return None
        total = 0.0
        for up in upstream_params_list:
            total += forecast_rate(tau, up['p'], up['mu'], up['sigma'], up['onset'])
        return total

    # This edge's forecast rate for y
    edge_mu = edge_params.get('mu', 0.0)
    edge_sigma = edge_params.get('sigma', 0.0)
    edge_onset = edge_params.get('onset_delta_days', 0.0)
    edge_p = edge_params.get('forecast_mean') or edge_params.get('posterior_p_cohort') or edge_params.get('posterior_p') or 0.0

    def _edge_rate(tau: float) -> float:
        return forecast_rate(tau, edge_p, edge_mu, edge_sigma, edge_onset)

    # Extract per-cohort x at their last observed frame (sweep_to).
    # The last frame in the sweep gives us x_frozen for each anchor_day.
    last_frame = None
    for f in frames:
        if f.get('as_at_date') and str(f['as_at_date'])[:10] <= str(sweep_to)[:10]:
            last_frame = f

    if last_frame is None or not last_frame.get('data_points'):
        return {}

    # Build per-cohort info: anchor_day → {x_frozen, y_frozen, tau_max}
    cohorts: List[Dict[str, Any]] = []
    for dp in last_frame['data_points']:
        ad_str = str(dp.get('anchor_day', ''))[:10]
        try:
            ad = _date.fromisoformat(ad_str)
        except (ValueError, TypeError):
            continue
        x = dp.get('x', 0)
        y = dp.get('y', 0)
        if not isinstance(x, (int, float)) or x <= 0:
            continue
        tau_max = (sweep_to_d - ad).days  # max observed age for this cohort
        cohorts.append({
            'anchor_day': ad,
            'x_frozen': float(x),
            'y_frozen': float(y),
            'tau_max': tau_max,
        })

    if not cohorts:
        return {}

    # Pre-compute upstream rates at each cohort's dropout τ for x scaling
    for c in cohorts:
        c['upstream_rate_at_dropout'] = _upstream_rate(c['tau_max'])

    # Compute fan for each τ from tau_solid_max to the extent of the band data
    max_band_tau = max(band_upper_by_tau.keys()) if band_upper_by_tau else tau_future_max
    result: Dict[int, Dict[str, Optional[float]]] = {}

    for tau in range(tau_solid_max, max_band_tau + 1):
        # Accumulate observed + forecast across all cohorts
        total_x = 0.0
        total_y = 0.0

        for c in cohorts:
            if tau <= c['tau_max']:
                # Live cohort: use observed values.
                # For the exact x/y at this τ we'd need per-τ data, but
                # we only have the last-frame snapshot.  Use frozen values
                # as a reasonable approximation (x doesn't change much
                # within the observed range).
                total_x += c['x_frozen']
                total_y += c['y_frozen']
            else:
                # Dropped cohort: forecast x growth and y.
                x_frozen = c['x_frozen']
                upstream_at_dropout = c['upstream_rate_at_dropout']
                upstream_at_tau = _upstream_rate(tau)

                if upstream_at_dropout and upstream_at_tau and upstream_at_dropout > 0:
                    x_forecast = x_frozen * upstream_at_tau / upstream_at_dropout
                else:
                    x_forecast = x_frozen  # no upstream data — assume x stable

                y_forecast = x_forecast * _edge_rate(tau)
                total_x += x_forecast
                total_y += y_forecast

        if total_x <= 0:
            continue

        midpoint = total_y / total_x
        midpoint = max(0.0, min(1.0, midpoint))

        # Fan bounds from the model band, centred on midpoint
        bu = band_upper_by_tau.get(tau)
        bl = band_lower_by_tau.get(tau)
        fan_upper: Optional[float] = None
        fan_lower: Optional[float] = None
        if bu is not None and bl is not None:
            half_width = (bu - bl) / 2.0
            fan_upper = min(1.0, midpoint + half_width)
            fan_lower = max(0.0, midpoint - half_width)

        result[tau] = {
            'midpoint': midpoint,
            'fan_upper': fan_upper,
            'fan_lower': fan_lower,
        }

    return result
