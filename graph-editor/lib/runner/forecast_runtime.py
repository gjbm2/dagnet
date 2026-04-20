"""
Forecast runtime layer — neutral home for the live-stack helpers that
previously lived under v1 (`cohort_forecast.py`), v2 (`cohort_forecast_v2.py`),
and the transitional `span_adapter.py`.

Created by doc 56 Phase 1 (§8 + §11). This module is the runtime-owned
assembly layer around the general engine (`forecast_state.py`). It contains:

  - Graph helpers used by production CF / v3 / engine callers
    (previously on v1): find_edge_by_id, get_incoming_edges,
    get_edge_from_node, XProvider, build_x_provider_from_graph,
    read_edge_cohort_params.

  - Span-prior construction (previously on v2 + span_adapter):
    SpanParams, build_span_params, span_kernel_to_edge_params.

  - Upstream carrier hierarchy (previously on v2): three tiers
    (parametric / empirical / weak-prior) + the dispatcher
    build_upstream_carrier.

Phase 1 exit gate: this module reproduces the legacy behaviour
byte-identically (RNG hash gate in doc 56 §11.1 proves it). No
callers are cut over in Phase 1 — the engine, v3 row builder, and
CF handler still import from the legacy modules. Phase 2 cuts the
engine over; Phase 3 cuts v3 + CF. Phase 4 deletes the legacy files.

Structural κ=20 defect (doc 56 §4.2 / §6.6) is preserved here as
part of the functionality-neutral port; the fix is tracked
separately (§11.2) and lands as a standalone commit on this module
after Phase 3.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from datetime import date as _date
from typing import Any, Callable, Dict, List, Optional, Tuple


_COHORT_DEBUG = bool(os.environ.get('DAGNET_COHORT_DEBUG'))


# ═══════════════════════════════════════════════════════════════════════
# Graph helpers (ex v1 — cohort_forecast.py)
# ═══════════════════════════════════════════════════════════════════════


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

    id_to_uuid: Dict[str, str] = {}
    uuid_to_id: Dict[str, str] = {}
    for n in nodes:
        nid = n.get('id', '')
        nuuid = n.get('uuid', nid)
        id_to_uuid[nid] = nuuid
        uuid_to_id[nuuid] = nid
        uuid_to_id[nid] = nid  # identity mapping

    target_ids = {node_id}
    if node_id in id_to_uuid:
        target_ids.add(id_to_uuid[node_id])
    if node_id in uuid_to_id:
        target_ids.add(uuid_to_id[node_id])

    return [e for e in edges if str(e.get('to', '')) in target_ids]


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

    for _src_key, _dst_key in [
        ('path_mu_sd', 'mu_sd'), ('mu_sd', 'mu_sd'),
        ('path_sigma_sd', 'sigma_sd'), ('sigma_sd', 'sigma_sd'),
        ('path_onset_sd', 'onset_sd'), ('onset_sd', 'onset_sd'),
    ]:
        if _dst_key not in result:
            _v = lat_post.get(_src_key)
            if isinstance(_v, (int, float)) and math.isfinite(_v) and _v > 0:
                result[_dst_key] = float(_v)

    if 'p_sd' not in result and _alpha is not None and _beta is not None:
        _s = _alpha + _beta
        result['p_sd'] = float(math.sqrt(_alpha * _beta / (_s * _s * (_s + 1))))

    return result


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
        upstream_obs: observed arrivals at x from upstream evidence.
            Dict mapping anchor_day (str) to a list of (tau, x_obs) tuples.
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

    Wraps the existing upstream logic that reads from the target edge's
    from-node.  For single-edge spans, from_node = x, so this is correct.
    """
    if is_window or target_edge is None:
        return XProvider(reach=0.0, upstream_params_list=[], enabled=False)

    from_node_id = get_edge_from_node(target_edge)
    if not from_node_id:
        return XProvider(reach=0.0, upstream_params_list=[], enabled=False)

    reach = 0.0
    try:
        from .forecast_state import _resolve_edge_p

        edges = graph.get('edges', [])
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

        node_reach: Dict[str, float] = {}
        anchor = anchor_node_id or ''
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


# ═══════════════════════════════════════════════════════════════════════
# Span kernel → edge params adapter (ex span_adapter.py)
# ═══════════════════════════════════════════════════════════════════════


def span_kernel_to_edge_params(
    kernel,  # SpanKernel (avoid top-level import; resolved lazily by callers)
    graph: Dict[str, Any],
    target_edge_id: str,
    is_window: bool,
) -> Dict[str, float]:
    """Build an edge_params dict from a SpanKernel.

    For the single-edge case, this is equivalent to _read_edge_model_params.
    For multi-hop, it uses the kernel's span_p as the forecast rate and
    the last edge's posterior SDs for MC uncertainty.
    """
    edges = graph.get('edges', [])
    target_edge = None
    for e in edges:
        if str(e.get('uuid', e.get('id', ''))) == str(target_edge_id):
            target_edge = e
            break

    params: Dict[str, Any] = {}

    span_p = kernel.span_p

    if target_edge:
        p_data = target_edge.get('p', {})
        latency = p_data.get('latency', {})
        posterior = latency.get('posterior', {})
        prob_posterior = p_data.get('posterior', {})

        mu = posterior.get('mu_mean') or latency.get('mu') or 0.0
        sigma = posterior.get('sigma_mean') or latency.get('sigma') or 0.0
        onset = (posterior.get('onset_delta_days')
                 or latency.get('promoted_onset_delta_days')
                 or latency.get('onset_delta_days') or 0.0)

        path_mu = posterior.get('path_mu_mean') or latency.get('path_mu')
        path_sigma = posterior.get('path_sigma_mean') or latency.get('path_sigma')
        path_onset = (posterior.get('path_onset_delta_days')
                      or latency.get('path_onset_delta_days'))

        if isinstance(mu, (int, float)):
            params['mu'] = float(mu)
        if isinstance(sigma, (int, float)):
            params['sigma'] = float(sigma)
        if isinstance(onset, (int, float)):
            params['onset_delta_days'] = float(onset)
        if isinstance(path_mu, (int, float)):
            params['path_mu'] = float(path_mu)
        if isinstance(path_sigma, (int, float)) and path_sigma > 0:
            params['path_sigma'] = float(path_sigma)
        if isinstance(path_onset, (int, float)):
            params['path_onset_delta_days'] = float(path_onset)

        params['forecast_mean'] = span_p
        params['posterior_p'] = span_p
        params['posterior_p_cohort'] = span_p

        post_alpha = prob_posterior.get('alpha')
        post_beta = prob_posterior.get('beta')
        cohort_alpha = prob_posterior.get('cohort_alpha')
        cohort_beta = prob_posterior.get('cohort_beta')

        if (isinstance(cohort_alpha, (int, float)) and isinstance(cohort_beta, (int, float))
                and cohort_alpha > 0 and cohort_beta > 0):
            kappa = float(cohort_alpha) + float(cohort_beta)
        elif (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            kappa = float(post_alpha) + float(post_beta)
        else:
            kappa = 20.0  # weak default

        params['posterior_alpha'] = span_p * kappa
        params['posterior_beta'] = (1.0 - span_p) * kappa
        params['posterior_cohort_alpha'] = span_p * kappa
        params['posterior_cohort_beta'] = (1.0 - span_p) * kappa

        span_alpha = span_p * kappa
        span_beta = (1.0 - span_p) * kappa
        if span_alpha > 0 and span_beta > 0:
            s = span_alpha + span_beta
            p_sd = math.sqrt(span_alpha * span_beta / (s * s * (s + 1)))
            params['p_stdev'] = p_sd
            params['p_stdev_cohort'] = p_sd

        _winning_mv_lat = {}
        for _mv in p_data.get('model_vars', []):
            if _mv.get('source') == 'bayesian':
                _winning_mv_lat = _mv.get('latency', {})
                break
        _sd_map = {
            'bayes_mu_sd':              ('promoted_mu_sd',              'mu_sd'),
            'bayes_sigma_sd':           ('promoted_sigma_sd',           'sigma_sd'),
            'bayes_onset_sd':           ('promoted_onset_sd',           'onset_sd'),
            'bayes_onset_mu_corr':      ('promoted_onset_mu_corr',      'onset_mu_corr'),
            'bayes_path_mu_sd':         ('promoted_path_mu_sd',         'path_mu_sd'),
            'bayes_path_sigma_sd':      ('promoted_path_sigma_sd',      'path_sigma_sd'),
            'bayes_path_onset_sd':      ('promoted_path_onset_sd',      'path_onset_sd'),
            'bayes_path_onset_mu_corr': ('promoted_path_onset_mu_corr', 'path_onset_mu_corr'),
        }
        for param_key, (promoted_key, posterior_key) in _sd_map.items():
            val = (latency.get(promoted_key)
                   or posterior.get(posterior_key)
                   or _winning_mv_lat.get(posterior_key))
            if isinstance(val, (int, float)):
                params[param_key] = float(val)

        t95 = latency.get('promoted_t95') or latency.get('t95')
        path_t95 = latency.get('promoted_path_t95') or latency.get('path_t95')
        if isinstance(t95, (int, float)) and t95 > 0:
            params['t95'] = float(t95)
        if isinstance(path_t95, (int, float)) and path_t95 > 0:
            params['path_t95'] = float(path_t95)

        evidence = p_data.get('evidence', {})
        ev_retrieved = evidence.get('retrieved_at')
        if isinstance(ev_retrieved, str) and ev_retrieved:
            params['evidence_retrieved_at'] = ev_retrieved

    return params


# ═══════════════════════════════════════════════════════════════════════
# Span prior (ex v2 — cohort_forecast_v2.py)
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class SpanParams:
    """Resolved span parameters for the v2 row builder.

    All quantities are in x→y coordinates, not anchor→y.
    """
    span_p: float               # K(∞) — asymptotic conversion probability x→y
    C: List[float]              # normalised completeness C(τ) = K(τ)/span_p
    max_tau: int
    # Prior for IS conditioning
    alpha_0: float              # Beta prior α centred on span_p
    beta_0: float               # Beta prior β
    # Posterior SDs for MC drift (from last edge)
    mu_sd: float
    sigma_sd: float
    onset_sd: float
    onset_mu_corr: float
    # Point-estimate latency (for deterministic fallback)
    mu: float
    sigma: float
    onset: float


def build_span_params(
    kernel_cdf: Callable[[float], float],
    span_p: float,
    max_tau: int,
    edge_params: Dict[str, Any],
    is_window: bool,
) -> SpanParams:
    """Build SpanParams from a span kernel and edge_params.

    The kernel_cdf should already be normalised: K(τ)/span_p.
    edge_params provides posterior SDs and alpha/beta for the prior.
    """
    C = [0.0] * (max_tau + 1)
    for t in range(max_tau + 1):
        C[t] = min(max(kernel_cdf(float(t)), 0.0), 1.0)

    alpha_0 = 0.0
    beta_0 = 0.0
    if not is_window:
        _raw_a = edge_params.get('posterior_cohort_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_cohort_beta', 0.0) or 0.0
    else:
        _raw_a = edge_params.get('posterior_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_beta', 0.0) or 0.0
    if _raw_a > 0 and _raw_b > 0:
        kappa = _raw_a + _raw_b
        alpha_0 = span_p * kappa
        beta_0 = (1.0 - span_p) * kappa
    if alpha_0 <= 0 or beta_0 <= 0:
        _KAPPA_DEFAULT = 20.0
        alpha_0 = span_p * _KAPPA_DEFAULT
        beta_0 = (1.0 - span_p) * _KAPPA_DEFAULT

    mu_sd = edge_params.get('bayes_mu_sd', edge_params.get('bayes_path_mu_sd', 0.0)) or 0.0
    sigma_sd = edge_params.get('bayes_sigma_sd', edge_params.get('bayes_path_sigma_sd', 0.0)) or 0.0
    onset_sd = edge_params.get('bayes_onset_sd', edge_params.get('bayes_path_onset_sd', 0.0)) or 0.0
    onset_mu_corr = edge_params.get('bayes_onset_mu_corr', edge_params.get('bayes_path_onset_mu_corr', 0.0)) or 0.0

    mu = edge_params.get('mu', 0.0)
    sigma = edge_params.get('sigma', 0.0)
    onset = edge_params.get('onset_delta_days', 0.0)

    return SpanParams(
        span_p=span_p, C=C, max_tau=max_tau,
        alpha_0=alpha_0, beta_0=beta_0,
        mu_sd=mu_sd, sigma_sd=sigma_sd,
        onset_sd=onset_sd, onset_mu_corr=onset_mu_corr,
        mu=mu, sigma=sigma, onset=onset,
    )


# ═══════════════════════════════════════════════════════════════════════
# Upstream carrier hierarchy (ex v2 — cohort_forecast_v2.py)
# Three tiers: parametric ingress → empirical tail → weak prior backstop.
# ═══════════════════════════════════════════════════════════════════════


def _build_tier1_parametric(
    upstream_params_list: List[Dict[str, Any]],
    reach: float,
    is_window: bool,
    max_tau: int,
    num_draws: int,
    rng,
) -> Optional[Tuple[List[float], Any]]:
    """Tier 1: parametric ingress mixture carrier.

    Returns (deterministic_cdf, mc_cdf) or None if no parametric
    carriers available.
    """
    if is_window or not upstream_params_list or reach <= 0:
        return None

    import numpy as np
    from scipy.special import ndtr as _ndtr
    from .confidence_bands import _shifted_lognormal_cdf

    T = max_tau + 1
    S = num_draws
    DRIFT_FRACTION = 2.0
    tau_grid = np.arange(0, T, dtype=float)

    total_w = 0.0
    weighted_cdf = [0.0] * T
    for _up in upstream_params_list:
        _up_sigma = _up.get('sigma', 0.0)
        if _up_sigma > 0:
            _up_p = _up['p']
            for t in range(T):
                cdf_val = _shifted_lognormal_cdf(
                    float(t), _up.get('onset', 0.0), _up['mu'], _up_sigma)
                weighted_cdf[t] += _up_p * cdf_val
            total_w += _up_p
    if total_w <= 0:
        return None
    for t in range(T):
        weighted_cdf[t] /= total_w

    _unnorm_cdf = np.zeros((S, T))
    _weight_sum = np.zeros(S)
    _any_edge = False
    for _up in upstream_params_list:
        _up_sigma = _up.get('sigma', 0.0)
        if _up_sigma <= 0:
            continue
        _any_edge = True
        _up_mu = _up['mu']
        _up_onset = _up.get('onset', 0.0)
        _up_mu_sd = _up.get('mu_sd', 0.05)
        _up_sigma_sd = _up.get('sigma_sd', 0.02)
        _up_onset_sd = _up.get('onset_sd', 0.1)
        _up_mu_s = _up_mu + rng.normal(0, max(DRIFT_FRACTION * _up_mu_sd, 1e-6), size=S)
        _up_sigma_s = np.clip(
            _up_sigma + rng.normal(0, max(DRIFT_FRACTION * _up_sigma_sd, 1e-6), size=S),
            0.01, 20.0)
        _up_onset_s = np.maximum(
            _up_onset + rng.normal(0, max(DRIFT_FRACTION * _up_onset_sd, 1e-6), size=S),
            0.0)
        _up_alpha = _up.get('alpha')
        _up_beta = _up.get('beta')
        if _up_alpha and _up_beta and _up_alpha > 0 and _up_beta > 0:
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
        _unnorm_cdf += _up_p_s[:, None] * _cdf_up
        _weight_sum += _up_p_s
    if not _any_edge:
        return None
    _weight_sum = np.maximum(_weight_sum, 1e-10)
    mc_cdf = _unnorm_cdf / _weight_sum[:, None]

    return (weighted_cdf, mc_cdf)


def _build_tier2_empirical(
    upstream_obs: Optional[Dict[str, List[Tuple[int, float]]]],
    cohort_list: List[Dict[str, Any]],
    reach: float,
    is_window: bool,
    max_tau: int,
    num_draws: int,
    rng,
) -> Optional[Tuple[List[float], Any]]:
    """Tier 2: empirical tail carrier from observed arrivals at x.

    Uses donor cohorts from upstream_obs to build an empirical CDF
    of arrivals at x.  Mass donors inform the terminal reach; shape
    donors inform the timing of post-frontier arrivals.
    """
    if is_window or not upstream_obs or reach <= 0:
        return None

    import numpy as np

    T = max_tau + 1

    frontier_age = 0
    if cohort_list:
        frontier_age = min(
            c.get('tau_observed', c.get('tau_max', 0))
            for c in cohort_list
        )

    raw_trajectories: List[Tuple[str, List[Tuple[int, float]], float, float]] = []

    for ad_str, obs_pairs in upstream_obs.items():
        if not obs_pairs:
            continue
        max_obs_tau = obs_pairs[-1][0]
        terminal_x = obs_pairs[-1][1]
        if terminal_x <= 0:
            continue

        _a_pop = terminal_x  # fallback
        for c in cohort_list:
            if c['anchor_day'].isoformat() == ad_str:
                _a_pop = c.get('a_frozen', terminal_x) or terminal_x
                break

        raw_trajectories.append((ad_str, obs_pairs, terminal_x, _a_pop))

    mass_donors: List[Tuple[float, float]] = []     # (terminal_x, a_pop)

    mass_threshold = min(frontier_age * 2, 30) if frontier_age > 0 else 10
    for ad_str, obs_pairs, terminal_x, _a_pop in raw_trajectories:
        max_obs_tau = obs_pairs[-1][0]
        if max_obs_tau >= mass_threshold:
            mass_donors.append((terminal_x, _a_pop))

    if len(mass_donors) < 2:
        return None

    mass_ratios = [x / max(ap, 1.0) for x, ap in mass_donors]
    _eventual_reach = float(np.mean(mass_ratios)) if mass_ratios else reach

    shape_donors: List[List[float]] = []

    for ad_str, obs_pairs, terminal_x, _a_pop in raw_trajectories:
        max_obs_tau = obs_pairs[-1][0]
        if max_obs_tau <= frontier_age:
            continue
        eventual_x = max(_a_pop * _eventual_reach, terminal_x)
        norm_cdf = [0.0] * T
        last_val = 0.0
        obs_idx = 0
        for t in range(T):
            while obs_idx < len(obs_pairs) and obs_pairs[obs_idx][0] <= t:
                last_val = obs_pairs[obs_idx][1]
                obs_idx += 1
            norm_cdf[t] = min(last_val / eventual_x, 1.0)
        shape_donors.append(norm_cdf)

    if len(shape_donors) < 2:
        return None

    det_cdf = [0.0] * T
    for donor in shape_donors:
        for t in range(T):
            det_cdf[t] += donor[t]
    for t in range(T):
        det_cdf[t] /= len(shape_donors)

    S = num_draws

    _mean_ratio = np.mean(mass_ratios)
    _var_ratio = np.var(mass_ratios) if len(mass_ratios) > 1 else 0.01
    if _mean_ratio > 0 and _mean_ratio < 1 and _var_ratio > 0:
        _m = _mean_ratio
        _v = min(_var_ratio, _m * (1 - _m) * 0.99)
        _alpha = _m * (_m * (1 - _m) / _v - 1)
        _beta = (1 - _m) * (_m * (1 - _m) / _v - 1)
        _alpha = max(_alpha, 0.5)
        _beta = max(_beta, 0.5)
    else:
        _alpha = 2.0
        _beta = max(2.0 / max(_mean_ratio, 0.01) - 2.0, 1.0)
    mass_draws = rng.beta(_alpha, _beta, size=S)  # (S,)

    donor_idx = rng.integers(0, len(shape_donors), size=S)
    shape_arr = np.array(shape_donors)  # (n_donors, T)
    mc_shapes = shape_arr[donor_idx]    # (S, T)

    _mass_scale = mass_draws / max(_eventual_reach, 1e-10)  # (S,)
    mc_cdf = np.maximum(mc_shapes * _mass_scale[:, None], 0.0)

    print(f"[v2] carrier tier=empirical: {len(mass_donors)} mass donors, "
          f"{len(shape_donors)} shape donors, "
          f"reach_mean={_mean_ratio:.4f} alpha={_alpha:.2f} beta={_beta:.2f}")

    return (det_cdf, mc_cdf)


def _build_tier3_weak_prior(
    reach: float,
    is_window: bool,
    max_tau: int,
    num_draws: int,
    rng,
) -> Tuple[List[float], Any]:
    """Tier 3: weak prior tail carrier (backstop).

    Produces a deliberately wide, uninformative carrier so the fan
    chart is never zero-width just because metadata is missing.

    Always succeeds — this is the final fallback.
    """
    import numpy as np
    from scipy.special import ndtr as _ndtr

    T = max_tau + 1
    S = num_draws
    tau_grid = np.arange(0, T, dtype=float)

    _mu_prior = math.log(30.0)
    _sigma_prior = 1.5

    det_cdf = [0.0] * T
    for t in range(T):
        if t > 0:
            z = (math.log(t) - _mu_prior) / _sigma_prior
            det_cdf[t] = float(_ndtr(z))

    _mu_s = rng.normal(_mu_prior, 0.5, size=S)
    _sigma_s = np.clip(rng.normal(_sigma_prior, 0.3, size=S), 0.3, 3.0)
    _t_safe = np.maximum(tau_grid[None, :], 1e-12)
    _z = (np.log(_t_safe) - _mu_s[:, None]) / _sigma_s[:, None]
    mc_cdf = np.clip(_ndtr(_z), 0.0, 1.0)
    mc_cdf[:, 0] = 0.0

    print(f"[v2] carrier tier=weak_prior: mu_prior={_mu_prior:.2f} "
          f"sigma_prior={_sigma_prior:.2f}")

    return (det_cdf, mc_cdf)


def build_upstream_carrier(
    upstream_params_list: List[Dict[str, Any]],
    upstream_obs: Optional[Dict[str, List[Tuple[int, float]]]],
    cohort_list: List[Dict[str, Any]],
    reach: float,
    is_window: bool,
    max_tau: int,
    num_draws: int,
    rng,
) -> Tuple[Optional[List[float]], Optional[Any], str]:
    """Select and build the upstream continuation carrier.

    Tries Tier 1 (parametric), then Tier 2 (empirical), then Tier 3
    (weak prior).  Returns (det_cdf, mc_cdf, tier_tag).

    det_cdf: List[float] of length max_tau+1, normalised CDF [0,1].
    mc_cdf: ndarray(S, T), per-draw stochastic CDF.
    tier_tag: 'parametric' | 'empirical' | 'weak_prior' | 'none'.
    """
    if is_window or reach <= 0:
        return (None, None, 'none')

    result = _build_tier1_parametric(
        upstream_params_list, reach, is_window, max_tau, num_draws, rng,
    )
    if result is not None:
        print(f"[v2] carrier tier=parametric: {len(upstream_params_list)} edges")
        return (result[0], result[1], 'parametric')

    result = _build_tier2_empirical(
        upstream_obs, cohort_list, reach, is_window, max_tau, num_draws, rng,
    )
    if result is not None:
        return (result[0], result[1], 'empirical')

    det_cdf, mc_cdf = _build_tier3_weak_prior(
        reach, is_window, max_tau, num_draws, rng,
    )
    return (det_cdf, mc_cdf, 'weak_prior')
