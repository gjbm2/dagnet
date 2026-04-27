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
  - compute_cohort_maturity_rows(...) → full maturity chart computation
    with importance-weighted MC fan bands.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

# Gate per-cohort diagnostic prints behind env var (set DAGNET_COHORT_DEBUG=1 to enable)
_COHORT_DEBUG = bool(os.environ.get('DAGNET_COHORT_DEBUG'))


from .forecast_application import compute_completeness


# ── x_provider: upstream arrival provider ─────────────────────────────
#
# Phase A seam (doc 29c §"Phase A x_provider").
#
# The x_provider encapsulates all upstream state needed by the row
# builder to compute the denominator (cumulative arrivals at x).
# In Phase A, the provider wraps the existing legacy upstream logic.
# In Phase B, it will be upgraded with evidence-driven policies.
#
# Contract:
#   - Returns arrivals at x (the query start node), never at u
#   - For single-edge spans, x = u = from_node, so the distinction
#     is invisible
#   - For multi-hop spans, the Phase A provider returns None
#     (Pop C disabled), because the legacy logic computes arrivals
#     at u, not x.  Phase B will implement a proper x-coordinate
#     provider.


@dataclass
class XProvider:
    """Upstream arrival state for the cohort maturity row builder.

    Attributes:
        reach: scalar reach probability from anchor to x.
        upstream_params_list: per-edge upstream params for MC draws.
            Each dict has: p, mu, sigma, onset, and optionally
            mu_sd, sigma_sd, onset_sd, alpha, beta, p_sd.
        enabled: if False, the row builder treats this as "no upstream"
            (equivalent to window mode for the denominator).
        ingress_carrier: path-level latency params from edges entering x.
            Each dict has: p, mu, sigma, onset, and optionally SDs and
            alpha/beta.  The mixture of these carriers gives the
            parametric CDF for arrivals at x.
            None when x = a or window mode.
        upstream_obs: observed arrivals at x from upstream evidence.
            Dict mapping anchor_day (str) to a list of (tau, x_obs)
            tuples, where x_obs is the total observed arrivals at x
            at that tau (summed across incident edges, mass-weighted).
            Used to IS-condition the ingress carrier draws.
            None when no upstream evidence is available.
    """
    reach: float = 0.0
    upstream_params_list: List[Dict[str, float]] = field(default_factory=list)
    enabled: bool = False
    ingress_carrier: Optional[List[Dict[str, float]]] = None
    upstream_obs: Optional[Dict[str, List[Tuple[int, float]]]] = None


def build_x_provider_from_graph(
    graph: Dict[str, Any],
    target_edge: Optional[Dict[str, Any]],
    anchor_node_id: Optional[str],
    is_window: bool,
) -> XProvider:
    """Build the legacy x_provider from graph data.

    This is the Phase A provider: it wraps the existing upstream logic
    that reads from the target edge's from-node.  For single-edge spans,
    from_node = x, so this is correct.

    Args:
        graph: scenario graph dict.
        target_edge: the target edge (last in the span).
        anchor_node_id: anchor node for reach computation.
        is_window: True for window mode (x is flat, no upstream needed).

    Returns:
        XProvider with reach and upstream params populated.
    """
    if is_window or target_edge is None:
        return XProvider(reach=0.0, upstream_params_list=[], enabled=False)

    from_node_id = get_edge_from_node(target_edge)
    if not from_node_id:
        return XProvider(reach=0.0, upstream_params_list=[], enabled=False)

    # Compute reach via topo walk using _resolve_edge_p (same as
    # build_node_arrival_cache in forecast_state.py). Reads from
    # model_vars/posterior — no dependency on p.mean (which is an
    # FE quick pass output and would be circular).
    reach = 0.0
    try:
        from .forecast_state import _resolve_edge_p

        # Build adjacency and topo-sort
        edges = graph.get('edges', [])
        # Edges reference nodes by UUID; anchor_node_id may be a
        # human-readable ID. Build a lookup to resolve.
        id_to_uuid: Dict[str, str] = {}
        node_ids = []
        for n in graph.get('nodes', []):
            uuid = n.get('uuid', '')
            hid = n.get('id', '')
            nid = uuid or hid
            node_ids.append(nid)
            if hid and uuid:
                id_to_uuid[hid] = uuid
        incoming_map: Dict[str, List[Dict]] = {}
        in_degree: Dict[str, int] = {nid: 0 for nid in node_ids}
        for e in edges:
            to_id = e.get('to', '')
            if to_id not in incoming_map:
                incoming_map[to_id] = []
            incoming_map[to_id].append(e)
            in_degree[to_id] = in_degree.get(to_id, 0) + 1

        # Walk in topo order, accumulate reach per node
        node_reach: Dict[str, float] = {}
        anchor = anchor_node_id or ''
        # Resolve human-readable ID to UUID if needed
        if anchor and anchor in id_to_uuid:
            anchor = id_to_uuid[anchor]
        if anchor:
            node_reach[anchor] = 1.0
        queue = sorted([nid for nid in node_ids if in_degree.get(nid, 0) == 0])
        if anchor and anchor not in queue:
            queue.append(anchor)
        visited: set = set()
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            if nid != anchor and nid in incoming_map:
                r = 0.0
                for ie in incoming_map[nid]:
                    ie_from = ie.get('from', '')
                    r += node_reach.get(ie_from, 0.0) * max(0, _resolve_edge_p(ie))
                node_reach[nid] = r
            elif nid not in node_reach:
                node_reach[nid] = 0.0
            for e in edges:
                if e.get('from', '') == nid:
                    to_id = e.get('to', '')
                    in_degree[to_id] = in_degree.get(to_id, 0) - 1
                    if in_degree[to_id] <= 0 and to_id not in visited:
                        queue.append(to_id)

        reach = node_reach.get(from_node_id, 0.0)
        if _COHORT_DEBUG:
            print(f"[REACH] from_node={from_node_id} anchor={anchor_node_id} "
                  f"reach={reach:.6f}")
    except Exception as e:
        print(f"[REACH] Error computing reach: {e}")
        import traceback; traceback.print_exc()

    upstream_params_list: List[Dict[str, float]] = []
    incoming = get_incoming_edges(graph, from_node_id)
    for inc_edge in incoming:
        params = read_edge_cohort_params(inc_edge)
        if params:
            upstream_params_list.append(params)

    enabled = reach > 0 and len(upstream_params_list) > 0
    return XProvider(
        reach=reach,
        upstream_params_list=upstream_params_list,
        enabled=enabled,
    )


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
    cohort_alpha/cohort_beta (cohort-level) over alpha/beta (window-level).
    """
    p_obj = edge.get('p') or {}
    latency = p_obj.get('latency') or {}
    lat_post = latency.get('posterior') or {}
    prob_post = p_obj.get('posterior') or {}

    # Latency: prefer cohort path-level posterior, then edge posterior, then flat.
    # Use _first_num to avoid Python `or` discarding valid 0.0 values.
    def _first_num(*vals):
        for v in vals:
            if isinstance(v, (int, float)) and math.isfinite(v):
                return v
        return None

    mu = _first_num(
        lat_post.get('path_mu_mean'),
        lat_post.get('mu_mean'),
        latency.get('path_mu'),
        latency.get('mu'))
    sigma = _first_num(
        lat_post.get('path_sigma_mean'),
        lat_post.get('sigma_mean'),
        latency.get('path_sigma'),
        latency.get('sigma'))
    onset = _first_num(
        lat_post.get('path_onset_delta_days'),
        lat_post.get('onset_delta_days'),
        latency.get('path_onset_delta_days'),
        latency.get('promoted_onset_delta_days'),
        latency.get('onset_delta_days'))
    if onset is None:
        onset = 0.0

    if not isinstance(mu, (int, float)) or not math.isfinite(mu):
        return None
    if not isinstance(sigma, (int, float)) or not math.isfinite(sigma) or sigma <= 0:
        return None

    # Probability: prefer cohort posterior, then window posterior, then forecast.
    cohort_alpha = prob_post.get('cohort_alpha')
    cohort_beta = prob_post.get('cohort_beta')
    post_alpha = prob_post.get('alpha')
    post_beta = prob_post.get('beta')
    forecast = (p_obj.get('forecast') or {}).get('mean')

    prob: Optional[float] = None
    if (isinstance(cohort_alpha, (int, float)) and isinstance(cohort_beta, (int, float))
            and cohort_alpha > 0 and cohort_beta > 0):
        prob = float(cohort_alpha) / (float(cohort_alpha) + float(cohort_beta))
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
    if (isinstance(cohort_alpha, (int, float)) and isinstance(cohort_beta, (int, float))
            and cohort_alpha > 0 and cohort_beta > 0):
        _alpha = float(cohort_alpha)
        _beta = float(cohort_beta)
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

    # Posterior uncertainty (SDs) for stochastic upstream x (Phase 4).
    # Prefer path-level SDs, then edge-level, from the posterior block.
    # Doc 61: feeds forecasting machinery — read predictive mu_sd first
    # with epistemic fallback. Kept in lockstep with the v3 copy in
    # forecast_runtime.py until doc 56's retirement workstream deletes v1.
    for _src_keys, _dst_key in [
        (('path_mu_sd_pred', 'mu_sd_pred', 'path_mu_sd', 'mu_sd'), 'mu_sd'),
        (('path_sigma_sd', 'sigma_sd'), 'sigma_sd'),
        (('path_onset_sd', 'onset_sd'), 'onset_sd'),
    ]:
        if _dst_key not in result:
            for _src_key in _src_keys:
                _v = lat_post.get(_src_key)
                if isinstance(_v, (int, float)) and math.isfinite(_v) and _v > 0:
                    result[_dst_key] = float(_v)
                    break

    # p uncertainty from alpha/beta (Beta posterior SD)
    if 'p_sd' not in result and _alpha is not None and _beta is not None:
        _s = _alpha + _beta
        result['p_sd'] = float(math.sqrt(_alpha * _beta / (_s * _s * (_s + 1))))

    return result


# ── Graph topology helpers ─────────────────────────────────────────────


def get_incoming_edges(
    graph: Dict[str, Any],
    node_id: str,
) -> List[Dict[str, Any]]:
    """Return all edges whose 'to' field matches node_id.

    Handles UUID-vs-id mismatch: edge['to'] may store a node UUID
    while node_id may be the human-readable id.  Builds a resolution
    map from the graph's nodes array.
    """
    nodes = graph.get('nodes', []) if isinstance(graph, dict) else []
    edges = graph.get('edges', []) if isinstance(graph, dict) else []

    # Build id↔uuid resolution map
    id_to_uuid: Dict[str, str] = {}
    uuid_to_id: Dict[str, str] = {}
    for n in nodes:
        nid = n.get('id', '')
        nuuid = n.get('uuid', nid)
        id_to_uuid[nid] = nuuid
        uuid_to_id[nuuid] = nid
        uuid_to_id[nid] = nid  # identity mapping

    # Resolve the target: could be an id or a uuid
    target_ids = {node_id}
    if node_id in id_to_uuid:
        target_ids.add(id_to_uuid[node_id])
    if node_id in uuid_to_id:
        target_ids.add(uuid_to_id[node_id])

    return [e for e in edges if str(e.get('to', '')) in target_ids]


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


    # compute_reach_probability and upstream_arrival_rate DELETED.
    # Reach now uses calculate_path_probability from path_runner.py
    # (proper DFS, handles joins/splits/multi-root correctly).
    # See compute_cohort_maturity_rows for the replacement.


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
    anchor_node_id: Optional[str] = None,
    sampling_mode: str = 'binomial',
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
        # Doc 61 (forecasting consumer): predictive first, epistemic fallback.
        edge_mu_sd = (edge_params.get('bayes_path_mu_sd_pred')
                      or edge_params.get('bayes_mu_sd_pred')
                      or edge_params.get('bayes_path_mu_sd')
                      or edge_params.get('bayes_mu_sd')
                      or 0.0)
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
        # Doc 61 (forecasting consumer): predictive first, epistemic fallback.
        edge_mu_sd = (edge_params.get('bayes_mu_sd_pred')
                      or edge_params.get('bayes_path_mu_sd_pred')
                      or edge_params.get('bayes_mu_sd')
                      or edge_params.get('bayes_path_mu_sd')
                      or 0.0)
        edge_sigma_sd = edge_params.get('bayes_sigma_sd', edge_params.get('bayes_path_sigma_sd', 0.0)) or 0.0
        edge_onset_sd = edge_params.get('bayes_onset_sd', edge_params.get('bayes_path_onset_sd', 0.0)) or 0.0
        edge_onset_mu_corr = edge_params.get('bayes_onset_mu_corr', edge_params.get('bayes_path_onset_mu_corr', 0.0)) or 0.0

    has_uncertainty = edge_sigma > 0 and edge_p > 0

    # ── Bayesian prior (α₀, β₀) for per-Cohort rate updating ─────────
    # Used by the Bayesian posterior predictive (midpoint + MC fan).
    # Prefer raw alpha/beta from edge posterior; fall back to method of
    # moments from (p, p_stdev); last resort: weak prior from forecast_mean.
    alpha_0: float = 0.0
    beta_0: float = 0.0
    if not is_window:
        _raw_a = edge_params.get('posterior_cohort_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_cohort_beta', 0.0) or 0.0
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

    # ── Upstream params (cohort mode only) ─────────────────────────────
    upstream_params_list: List[Dict[str, float]] = []
    reach_at_from_node: float = 0.0
    if not is_window and target_edge is not None:
        from_node_id = get_edge_from_node(target_edge)
        if from_node_id:
            try:
                from .graph_builder import build_networkx_graph
                from .path_runner import calculate_path_probability
                from .graph_builder import find_entry_nodes
                G = build_networkx_graph(graph)
                if anchor_node_id:
                    path_result = calculate_path_probability(G, anchor_node_id, from_node_id)
                    reach_at_from_node = path_result.probability
                else:
                    entry_nodes = find_entry_nodes(G)
                    for entry in entry_nodes:
                        pr = calculate_path_probability(G, entry, from_node_id)
                        if pr.probability > reach_at_from_node:
                            reach_at_from_node = pr.probability
                if _COHORT_DEBUG:
                    print(f"[REACH] from_node={from_node_id} anchor={anchor_node_id} "
                          f"reach={reach_at_from_node:.6f}")
            except Exception as e:
                print(f"[REACH] Error computing reach: {e}")
                import traceback; traceback.print_exc()

            incoming = get_incoming_edges(graph, from_node_id)
            for inc_edge in incoming:
                params = read_edge_cohort_params(inc_edge)
                if params:
                    upstream_params_list.append(params)

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
        # No cohorts but we have Bayes params — produce model-only rows.
        # This is the true zero-evidence degeneration: unconditioned
        # posterior draws produce the model curve with uncertainty.
        if has_uncertainty and edge_mu_sd > 0 and axis_tau_max is not None and axis_tau_max > 0:
            import numpy as np
            from .confidence_bands import _ndtr

            _max_tau = axis_tau_max
            _tau_grid = np.arange(0, _max_tau + 1, dtype=float)
            _T = len(_tau_grid)
            _S = 2000
            _sds = np.array([edge_p_sd, edge_mu_sd, edge_sigma_sd, edge_onset_sd])
            _cov = np.diag(_sds ** 2)
            _cov[3, 1] = _cov[1, 3] = edge_onset_mu_corr * edge_onset_sd * edge_mu_sd
            _rng = np.random.default_rng(42)
            _samples = _rng.multivariate_normal(
                np.array([edge_p, edge_mu, edge_sigma, edge_onset]), _cov, size=_S)
            _samples[:, 0] = np.clip(_samples[:, 0], 1e-6, 1 - 1e-6)
            _samples[:, 2] = np.clip(_samples[:, 2], 0.01, 20.0)
            _p_s = _samples[:, 0]
            _mu_s = _samples[:, 1]
            _sigma_s = _samples[:, 2]
            _onset_s = _samples[:, 3]
            _t_sh = _tau_grid[None, :] - _onset_s[:, None]
            _t_sh = np.maximum(_t_sh, 1e-12)
            _z = (np.log(_t_sh) - _mu_s[:, None]) / _sigma_s[:, None]
            _cdf_arr = _ndtr(_z)
            _cdf_arr = np.where(_tau_grid[None, :] > _onset_s[:, None], _cdf_arr, 0.0)
            _cdf_arr = np.clip(_cdf_arr, 0.0, 1.0)
            _rate = _p_s[:, None] * _cdf_arr

            _band_levels = [0.80, 0.90, 0.95, 0.99]
            _pcts = [50.0]
            for _bl in _band_levels:
                _a = (1.0 - _bl) / 2.0
                _pcts.extend([_a * 100, (1.0 - _a) * 100])
            _all_q = np.percentile(_rate, sorted(set(_pcts)), axis=0)
            _pct_sorted = sorted(set(_pcts))
            _q_map = {p: _all_q[i] for i, p in enumerate(_pct_sorted)}
            _q50 = _q_map[50.0]
            _a_sel = (1.0 - band_level) / 2.0
            _q_lo = _q_map.get(_a_sel * 100, _q_map.get(5.0))
            _q_hi = _q_map.get((1.0 - _a_sel) * 100, _q_map.get(95.0))

            rows: List[Dict[str, Any]] = []
            for t_idx in range(_T):
                tau = int(_tau_grid[t_idx])
                mid = float(_q50[t_idx])
                lo = float(_q_lo[t_idx])
                hi = float(_q_hi[t_idx])
                if mid < 1e-8 and hi < 1e-8:
                    continue
                fb = {str(int(_bl * 100)): (
                    float(_q_map[(1.0 - _bl) / 2.0 * 100][t_idx]),
                    float(_q_map[(1.0 + _bl) / 2.0 * 100][t_idx]))
                    for _bl in _band_levels}
                rows.append({
                    'tau_days': tau,
                    'rate': None,
                    'projected_rate': mid,
                    'midpoint': mid,
                    'fan_upper': hi,
                    'fan_lower': lo,
                    'tau_solid_max': 0,
                    'tau_future_max': 0,
                    'boundary_date': str(sweep_to)[:10],
                    'cohorts_covered_base': 0,
                    'cohorts_covered_projected': 0,
                    'evidence_y': None,
                    'evidence_x': None,
                    'forecast_y': None,
                    'forecast_x': None,
                    'fan_bands': fb,
                })
            return rows
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
    if _COHORT_DEBUG:
        print(f"[zone_boundaries] tau_solid_max={tau_solid_max} tau_future_max={tau_future_max} "
              f"tau_chart_extent={tau_chart_extent} cohorts={len(cohort_list)} "
              f"axis_tau_max={axis_tau_max} max_tau_will_be={max(tau_chart_extent, axis_tau_max or 0)} "
              f"has_uncertainty={has_uncertainty} edge_mu_sd={edge_mu_sd}")

    # ── Determine max τ for row emission ───────────────────────────────
    # Use the axis extent from the caller (computed from t95/sweep_span
    # in api_handlers), falling back to a local estimate.
    max_tau = tau_chart_extent
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    elif has_uncertainty:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(0.95, edge_mu, edge_sigma) + edge_onset
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass

    # ── Pre-compute dense per-Cohort arrays ───────────────────────────
    # Computed ONCE here, consumed by MC loop, evidence rate, and midpoint.
    # Eliminates scattered is_window branches at each consumption point.
    #
    # For each Cohort:
    #   obs_x[tau]  — observed x with carry-forward (dense, 0..max_tau)
    #   obs_y[tau]  — observed y with carry-forward (dense, 0..max_tau)
    #   x_at_tau[tau] — what x IS at each tau:
    #       window: flat N_i
    #       cohort: a_pop × reach × CDF_path(τ), floored at N_i
    #   x_frontier  — x at the frontier (tau_max)

    # Upstream path CDF: weighted-average CDF across incoming edges.
    # Computed once (point-estimate), used by both pre-computation and MC.
    # None for window mode (x is flat, no upstream model needed).
    upstream_path_cdf_arr: Optional[List[float]] = None
    if not is_window and upstream_params_list and reach_at_from_node > 0:
        total_w = 0.0
        weighted_cdf = [0.0] * (max_tau + 1)
        for _up in upstream_params_list:
            _up_sigma = _up.get('sigma', 0.0)
            if _up_sigma > 0:
                _up_p = _up['p']
                for t in range(max_tau + 1):
                    cdf_val = _shifted_lognormal_cdf(
                        float(t), _up.get('onset', 0.0), _up['mu'], _up_sigma)
                    weighted_cdf[t] += _up_p * cdf_val
                total_w += _up_p
        if total_w > 0:
            for t in range(max_tau + 1):
                weighted_cdf[t] /= total_w
        upstream_path_cdf_arr = weighted_cdf

    for c in cohort_list:
        N_i = c['x_frozen']
        a_i = c['tau_max']
        ad_str = c['anchor_day'].isoformat()
        a_pop = c.get('a_frozen', N_i) or N_i or 1.0
        tau_data = cohort_at_tau.get(ad_str, {})

        # ── observed x/y with carry-forward ───────────────────────
        obs_x = [0.0] * (max_tau + 1)
        obs_y = [0.0] * (max_tau + 1)
        # Window: x is always N_i. Cohort: x only known at observed taus.
        last_x = float(N_i) if is_window else 0.0
        last_y = 0.0
        for t in range(max_tau + 1):
            if t <= a_i:
                obs = tau_data.get(t)
                if obs:
                    last_x = obs[0]
                    last_y = obs[1]
                elif is_window:
                    last_x = float(N_i)
                    # last_y carries forward
                obs_x[t] = last_x
                obs_y[t] = last_y
            else:
                # Beyond frontier: carry-forward frozen values
                obs_x[t] = last_x if last_x > 0 else float(N_i)
                obs_y[t] = last_y
        c['obs_x'] = obs_x
        c['obs_y'] = obs_y

        # ── x at each tau (model-derived or flat) ──────────────────
        # Phase B: upstream_path_cdf_arr is evidence-conditioned when
        # upstream_obs is available (IS step above recomputes the
        # point-estimate from conditioned draws).  The model produces
        # a smooth curve; no raw evidence substitution.
        if upstream_path_cdf_arr is None:
            c['x_at_tau'] = [float(N_i)] * (max_tau + 1)
            c['x_frontier'] = float(N_i)
        else:
            # Cohort: a_pop × reach × CDF_path(τ), floored at N_i.
            x_arr = [max(a_pop * reach_at_from_node * upstream_path_cdf_arr[t], float(N_i))
                     for t in range(max_tau + 1)]
            c['x_at_tau'] = x_arr
            a_idx = min(a_i, max_tau)
            c['x_frontier'] = x_arr[a_idx]

    # ── Monte Carlo fan bands ────────────────────────────────────────
    if _COHORT_DEBUG:
        _mc_msg = (f"[MC_diag] has_uncertainty={has_uncertainty} edge_mu_sd={edge_mu_sd} edge_sigma_sd={edge_sigma_sd} "
                   f"edge_onset_sd={edge_onset_sd} edge_p_sd={edge_p_sd} edge_p={edge_p} "
                   f"edge_mu={edge_mu} edge_sigma={edge_sigma} edge_onset={edge_onset} "
                   f"cohorts={len(cohort_list)} is_window={is_window}")
        print(_mc_msg)
        print(f"[BAYES_prior] alpha_0={alpha_0:.4f} beta_0={beta_0:.4f} "
              f"prior_rate={alpha_0/(alpha_0+beta_0):.6f}")
        if upstream_params_list:
            _up0 = upstream_params_list[0]
            print(f"[BAYES_upstream] p={_up0.get('p', 0):.6f} "
                  f"mu={_up0.get('mu', 0):.4f} sigma={_up0.get('sigma', 0):.4f} "
                  f"onset={_up0.get('onset', 0):.4f} "
                  f"reach={reach_at_from_node:.6f}")
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
    model_fan_quantiles: Optional[Dict[int, Any]] = None  # tau → unconditioned model quantiles

    # v1 only — no span CDF override, no _is_span branches.
    # The v2 row builder lives in cohort_forecast_v2.py.

    if has_uncertainty and edge_mu_sd > 0:
        import numpy as np
        from .confidence_bands import _ndtr

        rng = np.random.default_rng(42)

        # tau grid
        tau_grid = np.arange(0, max_tau + 1, dtype=float)  # (T,)
        T = len(tau_grid)
        S = MC_SAMPLES

        # ── Full parametric draws ─────────────────────────────────
        theta_mean = np.array([edge_p, edge_mu, edge_sigma, edge_onset])
        sds = np.array([edge_p_sd, edge_mu_sd, edge_sigma_sd, edge_onset_sd])
        posterior_cov = np.diag(sds ** 2)
        posterior_cov[3, 1] = posterior_cov[1, 3] = edge_onset_mu_corr * edge_onset_sd * edge_mu_sd

        samples = rng.multivariate_normal(theta_mean, posterior_cov, size=S)
        samples[:, 0] = np.clip(samples[:, 0], 1e-6, 1 - 1e-6)
        samples[:, 2] = np.clip(samples[:, 2], 0.01, 20.0)

        p_s = samples[:, 0]
        mu_s = samples[:, 1]
        sigma_s = samples[:, 2]
        onset_s = samples[:, 3]

        # Compute per-draw latency CDF
        t_shifted = tau_grid[None, :] - onset_s[:, None]
        t_shifted = np.maximum(t_shifted, 1e-12)
        z = (np.log(t_shifted) - mu_s[:, None]) / sigma_s[:, None]
        cdf_arr = _ndtr(z)
        cdf_arr = np.where(tau_grid[None, :] > onset_s[:, None], cdf_arr, 0.0)
        cdf_arr = np.clip(cdf_arr, 0.0, 1.0)

        if _COHORT_DEBUG:
            print(f"[BAYES_PP] edge S={S} "
                  f"p=[{np.percentile(p_s, 10):.4f} {np.median(p_s):.4f} {np.percentile(p_s, 90):.4f}]")
        cdf_arr = np.clip(cdf_arr, 0.0, 1.0)

        # ── Per-cohort drift layer (Phase 2) ───────────────────────
        # Each cohort gets a drifted version of the global posterior
        # parameters.  Drift is on transformed (unconstrained) scales
        # so that p stays in (0,1), sigma stays positive, etc.
        # Drift SD = sqrt(DRIFT_FRACTION × posterior_var_on_transformed_scale).
        from scipy.special import logit as _logit, expit as _expit

        DRIFT_FRACTION = edge_params.get('cohort_drift_fraction', 0.20)

        # Posterior variance on transformed scales (delta method)
        _p_clamp = np.clip(edge_p, 0.01, 0.99)
        _p_var_logit = edge_p_sd**2 / (_p_clamp * (1 - _p_clamp))**2
        _mu_var = edge_mu_sd**2
        _sigma_var_log = edge_sigma_sd**2 / max(edge_sigma, 0.01)**2
        _onset_var_log1p = edge_onset_sd**2 / max(1 + edge_onset, 1.0)**2

        drift_sds = np.sqrt(DRIFT_FRACTION * np.array([
            _p_var_logit, _mu_var, _sigma_var_log, _onset_var_log1p,
        ]))

        # Transform global draws to unconstrained scale
        theta_transformed = np.column_stack([
            _logit(p_s),
            mu_s,
            np.log(np.maximum(sigma_s, 0.01)),
            np.log1p(np.maximum(onset_s, 0.0)),
        ])  # (S, 4)

        # ── Phase 4: Stochastic upstream x in cohort mode ─────────
        # In cohort mode, x = a_pop × reach × CDF_path(τ).  Make it
        # vary per MC draw by perturbing each upstream edge's params
        # using THAT EDGE's own posterior SDs (not the target edge's).
        # Also vary each upstream edge's p per draw from its Beta
        # posterior (alpha/beta) to capture probability uncertainty
        # in the mixture weights.
        # In window mode, x = N_i (observed, deterministic).
        upstream_cdf_mc: Optional[np.ndarray] = None  # (S, T) or None
        if not is_window and upstream_params_list and reach_at_from_node > 0:
            # Accumulate unnormalised weighted CDF per edge, then
            # normalise by the per-draw sum of p values so the
            # mixture weights sum to 1 on each draw.
            _unnorm_cdf = np.zeros((S, T))
            _weight_sum = np.zeros(S)  # per-draw denominator
            _any_edge = False

            for _up in upstream_params_list:
                _up_sigma = _up.get('sigma', 0.0)
                if _up_sigma <= 0:
                    continue
                _any_edge = True
                _up_mu = _up['mu']
                _up_onset = _up.get('onset', 0.0)

                # Use THIS upstream edge's SDs
                _up_mu_sd = _up.get('mu_sd', 0.05)
                _up_sigma_sd = _up.get('sigma_sd', 0.02)
                _up_onset_sd = _up.get('onset_sd', 0.1)

                # Perturb upstream latency params per draw
                _up_mu_s = _up_mu + rng.normal(0, max(DRIFT_FRACTION * _up_mu_sd, 1e-6), size=S)
                _up_sigma_s = np.clip(
                    _up_sigma + rng.normal(0, max(DRIFT_FRACTION * _up_sigma_sd, 1e-6), size=S),
                    0.01, 20.0)
                _up_onset_s = np.maximum(
                    _up_onset + rng.normal(0, max(DRIFT_FRACTION * _up_onset_sd, 1e-6), size=S),
                    0.0)

                # Vary upstream p per draw from Beta posterior
                _up_alpha = _up.get('alpha')
                _up_beta = _up.get('beta')
                if _up_alpha is not None and _up_beta is not None and _up_alpha > 0 and _up_beta > 0:
                    _up_p_s = rng.beta(_up_alpha, _up_beta, size=S)
                else:
                    _up_p_sd = _up.get('p_sd', 0.01)
                    _up_p_s = np.clip(
                        _up['p'] + rng.normal(0, max(DRIFT_FRACTION * _up_p_sd, 1e-6), size=S),
                        1e-6, 1 - 1e-6)

                _t_sh = tau_grid[None, :] - _up_onset_s[:, None]
                _t_sh = np.maximum(_t_sh, 1e-12)
                _z_up = (np.log(_t_sh) - _up_mu_s[:, None]) / _up_sigma_s[:, None]
                _cdf_up = _ndtr(_z_up)
                _cdf_up = np.where(tau_grid[None, :] > _up_onset_s[:, None], _cdf_up, 0.0)
                _cdf_up = np.clip(_cdf_up, 0.0, 1.0)

                # Accumulate unnormalised: p_s × CDF
                _unnorm_cdf += _up_p_s[:, None] * _cdf_up
                _weight_sum += _up_p_s

            if _any_edge:
                # Normalise per draw so mixture weights sum to 1
                _weight_sum = np.maximum(_weight_sum, 1e-10)
                upstream_cdf_mc = _unnorm_cdf / _weight_sum[:, None]


        # Per-Cohort conditional forecast, aggregated
        total_N = sum(c['x_frozen'] for c in cohort_list)
        Y_total = np.zeros((S, T))  # numerator
        X_total = np.zeros((S, T))  # denominator

        import time as _time
        _t_loop_start = _time.monotonic()
        _timings = {'drift': 0.0, 'cdf': 0.0, 'is': 0.0, 'pop_d': 0.0, 'pop_c': 0.0, 'combine': 0.0}

        for _ci, c in enumerate(cohort_list):
            N_i = c['x_frozen']
            k_i = c['y_frozen']
            # Use tau_observed (real evidence depth) for the mature/forecast
            # boundary, not tau_max (which includes carry-forward).
            a_i = c.get('tau_observed', c['tau_max'])
            x_frontier = c['x_frontier']

            if N_i <= 0 and x_frontier <= 0 and upstream_cdf_mc is None:
                continue  # Window mode with no arrivals — genuinely empty

            a_idx = min(a_i, T - 1)

            _t0 = _time.monotonic()
            if _COHORT_DEBUG:
                print(f"[PERF] cohort {_ci}/{len(cohort_list)} a_i={a_i} N_i={N_i} E_i={E_i:.2f} T={T} S={S}", flush=True)
            # ── Cohort-specific drifted parameters ────────────────
            # Draw per-cohort drift on transformed scales, then
            # transform back.  Each cohort gets its own (p, mu, sigma,
            # onset) centred on the global draw but with added noise.
            delta_i = rng.normal(0.0, drift_sds, size=(S, 4))    # (S, 4)
            theta_i = theta_transformed + delta_i                 # (S, 4)

            p_i = _expit(theta_i[:, 0])                           # (S,)
            mu_i = theta_i[:, 1]                                   # (S,)
            sigma_i = np.exp(theta_i[:, 2])                        # (S,)
            sigma_i = np.clip(sigma_i, 0.01, 20.0)
            onset_i = np.expm1(np.clip(theta_i[:, 3], -1, 5))     # (S,)
            onset_i = np.maximum(onset_i, 0.0)

            _timings['drift'] += _time.monotonic() - _t0; _t0 = _time.monotonic()
            # Recompute CDF with cohort-specific latency params
            t_shifted_i = tau_grid[None, :] - onset_i[:, None]    # (S, T)
            t_shifted_i = np.maximum(t_shifted_i, 1e-12)
            z_i = (np.log(t_shifted_i) - mu_i[:, None]) / sigma_i[:, None]
            cdf_i = _ndtr(z_i)                                    # (S, T)
            cdf_i = np.where(tau_grid[None, :] > onset_i[:, None], cdf_i, 0.0)
            cdf_i = np.clip(cdf_i, 0.0, 1.0)

            _timings['cdf'] += _time.monotonic() - _t0; _t0 = _time.monotonic()
            # ── Phase 3: Per-cohort IS conditioning on frontier ────
            # Condition this cohort's drifted draws on its observed
            # frontier evidence: k_i conversions from N_i people at
            # tau_max_i.
            if N_i > 0 and a_i > 0:
                # p_window = probability of converting within tau_max
                p_window_i = p_i * cdf_i[:, a_idx]                # (S,)
                p_window_i = np.clip(p_window_i, 1e-15, 1 - 1e-15)
                # Binomial log-likelihood of frontier observation
                log_w_i = (k_i * np.log(p_window_i)
                           + (N_i - k_i) * np.log(1 - p_window_i))
                log_w_i -= np.max(log_w_i)
                w_i = np.exp(log_w_i)
                w_i /= w_i.sum()
                ess_i = 1.0 / np.sum(w_i ** 2)

                # Resample draws for this cohort
                resample_idx = rng.choice(S, size=S, replace=True, p=w_i)
                p_i = p_i[resample_idx]
                mu_i = mu_i[resample_idx]
                sigma_i = sigma_i[resample_idx]
                onset_i = onset_i[resample_idx]
                cdf_i = cdf_i[resample_idx]

            # ── D/C state decomposition ─────────────────────────────
            # Factorised forecast: upstream A→X and local X→Y are
            # independent.  Two populations beyond the frontier:
            #
            # Pop D (frontier survivors): N_i - k_i people already at X
            #   who haven't converted.  Purely local conditional Binomial.
            #   How they arrived is irrelevant — same formula for window
            #   and cohort mode.
            #
            # Pop C (future arrivals): people arriving at X after the
            #   frontier.  Continuous expectations (model-predicted
            #   populations, not observed — Binomial noise inappropriate).
            #   Only exists in cohort mode (upstream_cdf_mc is not None).
            #
            # X_cohort = N_i + X_C  (not upstream-scaled x_forecast_arr)
            # Y_cohort = k_i + Y_D + Y_C

            cdf_at_a = cdf_i[:, a_idx]                             # (S,)
            c_i_b = cdf_at_a[:, None]                              # (S, 1)
            n_eff_b = N_i * c_i_b                                  # (S, 1) — diagnostic

            _has_upstream = upstream_cdf_mc is not None

            # ── Pop D: frontier survivors (window + cohort) ───────
            # Conditional Binomial: given N_i - k_i people survived to
            # a_i without converting, what is the probability they
            # convert between a_i and tau?
            # q_late = p(CDF(τ) - CDF(a_i)) / (1 - p·CDF(a_i))
            remaining_frontier = max(N_i - k_i, 0.0)
            q_early = p_i[:, None] * c_i_b                        # (S, 1)
            q_early = np.clip(q_early, 0.0, 1 - 1e-10)
            remaining_cdf = np.maximum(cdf_i - c_i_b, 0.0)        # (S, T)
            q_late = (p_i[:, None] * remaining_cdf) / (1 - q_early)
            q_late = np.clip(q_late, 0.0, 1.0)
            if sampling_mode == 'none':
                Y_D = remaining_frontier * q_late                  # (S, T)
            elif sampling_mode == 'normal':
                _mu_d = remaining_frontier * q_late                # (S, T)
                _var_d = remaining_frontier * q_late * (1 - q_late)
                Y_D = np.clip(
                    _mu_d + rng.normal(0.0, np.sqrt(np.maximum(_var_d, 1e-12))),
                    0.0, remaining_frontier)                       # (S, T)
            else:
                Y_D = rng.binomial(int(remaining_frontier), q_late)  # (S, T)

            # ── Pop C: post-frontier arrivals (cohort mode only) ──
            # These are model-predicted populations, not observed people.
            # The model rate at tau is p × CDF_path(tau) — the predicted
            # y/x ratio.  For model-predicted populations, applying the
            # model rate directly gives the correct aggregate and
            # degenerates to the model curve at zero evidence.
            #
            # X_C(tau) = cumulative upstream arrivals beyond the frontier.
            # Y_C(tau) = X_C(tau) × p × CDF_path(tau) per draw.
            # Rate = Y_C / X_C = p × CDF_path(tau) = model rate.
            X_C = np.zeros((S, T), dtype=np.float64)
            Y_C = np.zeros((S, T), dtype=np.float64)

            if _has_upstream:
                _up_scaled = a_pop * reach_at_from_node * upstream_cdf_mc  # (S, T)
                # X_C at tau = cumulative upstream arrivals from a_i+1 to tau
                # = total arrivals at tau minus arrivals at a_i
                _up_at_frontier = _up_scaled[:, a_idx:a_idx+1]     # (S, 1)
                X_C = np.maximum(_up_scaled - _up_at_frontier, 0.0)  # (S, T)
                # Y_C = X_C × model rate per draw
                model_rate_per_draw = p_i[:, None] * cdf_i         # (S, T)
                model_rate_per_draw = np.clip(model_rate_per_draw, 0.0, 1.0)
                Y_C = X_C * model_rate_per_draw

            # ── Combine: X_cohort, Y_cohort ───────────────────────
            X_forecast = float(N_i) + X_C                          # (S, T)
            Y_forecast = float(k_i) + Y_D.astype(np.float64) + Y_C
            Y_forecast = np.clip(Y_forecast, float(k_i), X_forecast)

            _t_cohort_end = _time.monotonic()
            if _COHORT_DEBUG:
                print(f"[PERF] cohort {_ci} done in {_t_cohort_end - _t0:.3f}s Y_D_max={float(Y_D.max()):.1f} Y_C_max={float(Y_C.max()):.1f}", flush=True)

            # Mature ages: use pre-computed observed (x, y) arrays.
            # Carry-forward already baked in during pre-computation.
            observed_x = np.array(c['obs_x'][:T])   # (T,)
            observed_y = np.array(c['obs_y'][:T])   # (T,)

            # Combine: observed where mature, forecast where immature
            mature_mask = tau_grid <= a_i  # (T,) bool
            Y_cohort = np.where(mature_mask[None, :], observed_y[None, :], Y_forecast)
            X_cohort = np.where(mature_mask[None, :], observed_x[None, :], X_forecast)

            # ── Zero-maturity diagnostic ──────────────────────────────────
            # Dump decomposition for low-maturity Cohorts to diagnose
            # degeneration to model curve.  Only for immature Cohorts
            # (tau_max <= 5) to keep output manageable.
            if _COHORT_DEBUG and a_i <= 5:
                _diag_taus = [t for t in [0, 1, 2, 3, 5, 10, 15, 20, 30] if t < T]
                _mode_str = 'window' if is_window else 'cohort'
                _x_front = float(N_i) if is_window else float(x_frontier)
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
        # The MC always produces a rate from the posterior draws.
        # With cohorts: rate = Y_total / X_total (evidence-conditioned).
        # Without cohorts: rate = p × CDF(τ) (unconditioned model).
        # This is not a special case — it's the natural limit as
        # evidence → 0.  The per-cohort loop contributes nothing when
        # cohort_list is empty, so Y_total and X_total are both zero.
        # Use cohort-derived rate when there's meaningful population,
        # otherwise fall back to unconditioned model draws.
        # Threshold: median X across draws must exceed 1 person at
        # at least one tau.  Below that, the Y/X ratio is dominated
        # by integer noise from sub-person Binomial draws.
        _x_median = np.median(X_total, axis=0)  # (T,)
        if np.any(_x_median >= 1.0):
            X_total_safe = np.maximum(X_total, 1e-10)
            rate_agg = Y_total / X_total_safe
        else:
            # Insufficient population: unconditioned model draws
            rate_agg = p_s[:, None] * cdf_arr  # (S, T)

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

        # ── Unconditioned model fan (for f mode) ──────────────────────
        # Pure parameter uncertainty: rate = p × CDF(tau) per draw.
        # No IS conditioning, no Pop D, no evidence contribution.
        rate_model = p_s[:, None] * cdf_arr  # (S, T)
        _model_q = np.percentile(rate_model, _pct_sorted, axis=0)
        _mq_by_pct = {p: _model_q[i] for i, p in enumerate(_pct_sorted)}
        _mq50 = _mq_by_pct[50.0]
        _mq_lo = _mq_by_pct.get(a_sel * 100, _mq_by_pct.get(5.0))
        _mq_hi = _mq_by_pct.get((1.0 - a_sel) * 100, _mq_by_pct.get(95.0))

        model_fan_quantiles: Dict[int, Any] = {}
        for t_idx in range(T):
            tau_val = int(tau_grid[t_idx])
            model_fan_quantiles[tau_val] = {
                'lo': float(_mq_lo[t_idx]),
                'mid': float(_mq50[t_idx]),
                'hi': float(_mq_hi[t_idx]),
                'bands': {
                    bl: (float(_mq_by_pct[(1.0 - bl) / 2.0 * 100][t_idx]),
                         float(_mq_by_pct[(1.0 + bl) / 2.0 * 100][t_idx]))
                    for bl in _band_levels
                },
            }

    # ── Emit rows ──────────────────────────────────────────────────────
    rows: List[Dict[str, Any]] = []

    for tau in range(0, max_tau + 1):
        b = buckets.get(tau)

        # Evidence rate (e+f mode): observed_y / blended_x.
        # Epoch A (all mature): observed x — pure evidence, no model.
        # Epoch B (mixed): mature Cohorts use observed x, immature use
        # model x (x_at_tau).  This creates a natural transition as
        # Cohorts move from observed to forecast denominators.
        # Only show circle at taus with real observation data.
        evidence_rate: Optional[float] = None
        evidence_rate_pure: Optional[float] = None
        ev_y_total: Optional[float] = None
        ev_x_total: Optional[float] = None
        if tau <= tau_future_max:
            has_real_obs = any(
                tau in cohort_at_tau.get(c['anchor_day'].isoformat(), {})
                for c in cohort_list if tau <= c.get('tau_observed', c['tau_max'])
            )
            if has_real_obs:
                ev_y_total = 0.0
                ev_x_total = 0.0
                ev_y_pure = 0.0
                ev_x_pure = 0.0
                for c in cohort_list:
                    _c_obs = c.get('tau_observed', c['tau_max'])
                    if tau <= _c_obs:
                        ev_x_total += c['obs_x'][tau]
                        ev_x_pure += c['obs_x'][tau]
                        ev_y_pure += c['obs_y'][tau]
                    else:
                        ev_x_total += c['x_at_tau'][tau] if tau < len(c['x_at_tau']) else c['x_frontier']
                    ev_y_total += c['obs_y'][tau]
                if ev_x_total > 0:
                    evidence_rate = max(0.0, min(1.0, ev_y_total / ev_x_total))
                if ev_x_pure > 0:
                    evidence_rate_pure = max(0.0, min(1.0, ev_y_pure / ev_x_pure))

        # Projected rate from backend annotation
        projected_rate: Optional[float] = None
        if b and b.sum_proj_x > 0 and b.proj_count > 0:
            projected_rate = max(0.0, min(1.0, b.sum_proj_y / b.sum_proj_x))

        # ── Midpoint + forecast totals ─────────────────────────────
        # Always compute total_x_aug / total_y_aug (needed by payload).
        # Midpoint: prefer MC median (consistent with fan) when available,
        # fall back to deterministic estimate.
        total_x_aug = 0.0
        total_y_aug = 0.0
        for c in cohort_list:
            _c_obs = c.get('tau_observed', c['tau_max'])
            if tau <= _c_obs:
                total_x_aug += c['obs_x'][tau]
                total_y_aug += c['obs_y'][tau]
            else:
                N_i_det = c['x_frozen']
                k_i_det = c['y_frozen']
                a_i_det = _c_obs

                # Pop D deterministic: frontier survivors
                # For multi-hop, use completeness-adjusted exposure.
                cdf_a_det = _cdf(a_i_det)
                cdf_tau_det = _cdf(tau)
                q_early_det = edge_p * cdf_a_det
                q_early_det = min(q_early_det, 1 - 1e-10)
                remaining_det = max(0.0, cdf_tau_det - cdf_a_det)
                q_late_det = (edge_p * remaining_det) / (1 - q_early_det)
                q_late_det = min(max(q_late_det, 0.0), 1.0)
                Y_D_det = max(N_i_det - k_i_det, 0.0) * q_late_det

                # Pop C deterministic: post-frontier upstream arrivals.
                X_C_det = 0.0
                Y_C_det = 0.0
                if upstream_path_cdf_arr is not None and reach_at_from_node > 0:
                    _a_pop_det = c.get('a_frozen', N_i_det) or N_i_det or 1.0
                    tau_clamped = min(tau, len(upstream_path_cdf_arr) - 1)
                    a_clamped = min(a_i_det, len(upstream_path_cdf_arr) - 1)
                    X_C_det = max(0.0, _a_pop_det * reach_at_from_node * (
                        upstream_path_cdf_arr[tau_clamped] - upstream_path_cdf_arr[a_clamped]))
                    model_rate_det = edge_p * cdf_tau_det
                    Y_C_det = X_C_det * min(model_rate_det, 1.0)

                x_total_det = N_i_det + X_C_det
                y_total_det = k_i_det + Y_D_det + Y_C_det
                y_total_det = min(y_total_det, x_total_det)
                total_x_aug += x_total_det
                total_y_aug += y_total_det

        # Midpoint: prefer MC median (consistent with fan), fall back
        # to deterministic estimate for taus without fan quantiles.
        midpoint: Optional[float] = None
        if fan_quantiles is not None:
            fq_mid = fan_quantiles.get(tau)
            if fq_mid is not None:
                midpoint = fq_mid['mid']
        if midpoint is None and total_x_aug > 0:
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
        if _COHORT_DEBUG and tau in (tau_solid_max, tau_solid_max + 1, tau_solid_max + 2, tau_future_max, tau_future_max + 1, 15, 30, 50):
            _bsy = b.sum_y if b else 0
            _bsx = b.sum_x if b else 0
            _ev = f"{evidence_rate:.4f}" if evidence_rate is not None else "null"
            _mp = f"{midpoint:.4f}" if midpoint is not None else "null"
            _fu = f"{fan_upper:.4f}" if fan_upper is not None else "null"
            _fl = f"{fan_lower:.4f}" if fan_lower is not None else "null"
            print(f"[fan_diag] tau={tau} ev={_ev} mid={_mp} bucket_y/x={_bsy:.1f}/{_bsx:.1f} aug_y/x={total_y_aug:.1f}/{total_x_aug:.1f} fan=[{_fl},{_fu}]")

        # Skip rows with no evidence, no midpoint, no projection, AND no
        # model values. Tau=0 often has model_fan_quantiles but no evidence;
        # emitting it keeps v1 output aligned with v2.
        has_model = (model_fan_quantiles is not None
                     and model_fan_quantiles.get(tau) is not None)
        if (evidence_rate is None and midpoint is None
                and projected_rate is None and not has_model):
            continue

        row: Dict[str, Any] = {
            'tau_days': tau,
            'rate': evidence_rate,
            'rate_pure': evidence_rate_pure,
            'projected_rate': projected_rate,
            'midpoint': midpoint,
            'fan_upper': fan_upper,
            'fan_lower': fan_lower,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': b.mature_count if b else 0,
            'cohorts_covered_projected': b.proj_count if b else 0,
            # Tooltip components: evidence y, blended x, forecast y
            'evidence_y': round(ev_y_total, 1) if ev_y_total is not None else None,
            'evidence_x': round(ev_x_total, 1) if ev_x_total is not None else None,
            'forecast_y': round(total_y_aug, 1) if midpoint is not None else None,
            'forecast_x': round(total_x_aug, 1) if midpoint is not None else None,
        }
        if fan_bands:
            row['fan_bands'] = fan_bands
        # Unconditioned model fan (for f mode)
        if model_fan_quantiles is not None:
            mfq = model_fan_quantiles.get(tau)
            if mfq is not None:
                row['model_midpoint'] = mfq['mid']
                row['model_fan_upper'] = mfq['hi']
                row['model_fan_lower'] = mfq['lo']
                row['model_bands'] = {str(int(bl * 100)): lo_hi for bl, lo_hi in mfq['bands'].items()}
        rows.append(row)

    return rows
