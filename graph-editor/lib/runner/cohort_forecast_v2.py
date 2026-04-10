"""
Cohort maturity v2 row builder — factorised X_x + K_{x→y} representation.

Parallel implementation to cohort_forecast.compute_cohort_maturity_rows (v1).
v1 is frozen as the parity reference; this module can be refactored freely.

Canonical semantics (doc 29c §Row-builder representation consistency):
  - X_x: upstream arrivals at x, from x_provider
  - K_{x→y}: span kernel CDF (sub-probability, asymptote = span_p)
  - C_{x→y}(τ) = K(τ) / span_p: normalised completeness [0, 1]
  - p_window = span_p × C(a_i): conversion probability by frontier age
  - IS, Pop D, deterministic forecast, fan: all use C consistently
  - No path-level collapsed semantics anywhere

One-edge degeneration: single-edge K equals the legacy edge operator.
Hop count only changes how K is built.
"""

from __future__ import annotations

import math
import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import date as _date
from typing import Any, Callable, Dict, List, Optional, Tuple

_COHORT_DEBUG = bool(os.environ.get('DAGNET_COHORT_DEBUG'))


@dataclass
class SpanParams:
    """Resolved span parameters for the v2 row builder.

    All quantities are in x→y coordinates, not anchor→y.
    """
    span_p: float               # K(∞) — asymptotic conversion probability x→y
    C: List[float]              # normalised completeness C(τ) = K(τ)/span_p, len = max_tau+1
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
    # Build normalised completeness array
    C = [0.0] * (max_tau + 1)
    for t in range(max_tau + 1):
        C[t] = min(max(kernel_cdf(float(t)), 0.0), 1.0)

    # Prior: prefer path-level alpha/beta from edge posterior,
    # re-centred on span_p with the same concentration.
    alpha_0 = 0.0
    beta_0 = 0.0
    if not is_window:
        _raw_a = edge_params.get('posterior_path_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_path_beta', 0.0) or 0.0
    else:
        _raw_a = edge_params.get('posterior_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_beta', 0.0) or 0.0
    if _raw_a > 0 and _raw_b > 0:
        # Re-centre on span_p, keep concentration from posterior
        kappa = _raw_a + _raw_b
        alpha_0 = span_p * kappa
        beta_0 = (1.0 - span_p) * kappa
    if alpha_0 <= 0 or beta_0 <= 0:
        # Weak prior
        _KAPPA_DEFAULT = 20.0
        alpha_0 = span_p * _KAPPA_DEFAULT
        beta_0 = (1.0 - span_p) * _KAPPA_DEFAULT

    # Posterior SDs — use edge-level (not path-level) since the span
    # kernel already composes from edge-level params.
    mu_sd = edge_params.get('bayes_mu_sd', edge_params.get('bayes_path_mu_sd', 0.0)) or 0.0
    sigma_sd = edge_params.get('bayes_sigma_sd', edge_params.get('bayes_path_sigma_sd', 0.0)) or 0.0
    onset_sd = edge_params.get('bayes_onset_sd', edge_params.get('bayes_path_onset_sd', 0.0)) or 0.0
    onset_mu_corr = edge_params.get('bayes_onset_mu_corr', edge_params.get('bayes_path_onset_mu_corr', 0.0)) or 0.0

    # Point-estimate latency (edge-level for v2)
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
# Upstream continuation carrier hierarchy (doc 29d §Three-Tier Carrier)
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
    DRIFT_FRACTION = 0.20
    tau_grid = np.arange(0, T, dtype=float)

    # Deterministic CDF
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

    # Stochastic MC CDF
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

    Returns (deterministic_cdf, mc_cdf) or None if insufficient donors.
    """
    if is_window or not upstream_obs or reach <= 0:
        return None

    import numpy as np

    T = max_tau + 1

    # Youngest plotted cohort frontier age
    frontier_age = 0
    if cohort_list:
        frontier_age = min(
            c.get('tau_observed', c.get('tau_max', 0))
            for c in cohort_list
        )

    # ── First pass: collect raw trajectories and a_pop per cohort ─────
    raw_trajectories: List[Tuple[str, List[Tuple[int, float]], float, float]] = []
    # (ad_str, obs_pairs, terminal_x, a_pop)

    for ad_str, obs_pairs in upstream_obs.items():
        if not obs_pairs:
            continue
        max_obs_tau = obs_pairs[-1][0]
        terminal_x = obs_pairs[-1][1]
        if terminal_x <= 0:
            continue

        # Find a_pop for this cohort from cohort_list
        _a_pop = terminal_x  # fallback
        for c in cohort_list:
            if c['anchor_day'].isoformat() == ad_str:
                _a_pop = c.get('a_frozen', terminal_x) or terminal_x
                break

        raw_trajectories.append((ad_str, obs_pairs, terminal_x, _a_pop))

    # ── Classify donors ──────────────────────────────────────────────
    # Mass donors: cohorts mature enough that x_obs has stabilised
    # Shape donors: trajectories extending past the youngest frontier
    mass_donors: List[Tuple[float, float]] = []     # (terminal_x, a_pop)

    mass_threshold = min(frontier_age * 2, 30) if frontier_age > 0 else 10
    for ad_str, obs_pairs, terminal_x, _a_pop in raw_trajectories:
        max_obs_tau = obs_pairs[-1][0]
        if max_obs_tau >= mass_threshold:
            mass_donors.append((terminal_x, _a_pop))

    # Admissibility check for mass donors early — needed for shape
    # normalisation
    if len(mass_donors) < 2:
        return None

    # Estimate eventual reach from mass donors
    mass_ratios = [x / max(ap, 1.0) for x, ap in mass_donors]
    _eventual_reach = float(np.mean(mass_ratios)) if mass_ratios else reach

    # Shape donors: normalise by estimated eventual mass (a_pop *
    # eventual_reach), not by terminal x_obs.  This keeps the CDF < 1
    # for immature cohorts, preserving post-frontier continuation.
    shape_donors: List[List[float]] = []

    for ad_str, obs_pairs, terminal_x, _a_pop in raw_trajectories:
        max_obs_tau = obs_pairs[-1][0]
        if max_obs_tau <= frontier_age:
            continue
        # Estimated eventual arrivals for this cohort
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

    # Admissibility: need ≥2 shape donors (mass donors already checked)
    if len(shape_donors) < 2:
        return None

    # ── Deterministic CDF: average of shape donors ───────────────────
    det_cdf = [0.0] * T
    for donor in shape_donors:
        for t in range(T):
            det_cdf[t] += donor[t]
    for t in range(T):
        det_cdf[t] /= len(shape_donors)

    # ── Stochastic draws ─────────────────────────────────────────────
    S = num_draws

    # Sample mass: Beta posterior on reach from mass donors
    # mass_ratios already computed above for _eventual_reach
    _mean_ratio = np.mean(mass_ratios)
    _var_ratio = np.var(mass_ratios) if len(mass_ratios) > 1 else 0.01
    # Method-of-moments Beta fit
    if _mean_ratio > 0 and _mean_ratio < 1 and _var_ratio > 0:
        _m = _mean_ratio
        _v = min(_var_ratio, _m * (1 - _m) * 0.99)  # keep valid
        _alpha = _m * (_m * (1 - _m) / _v - 1)
        _beta = (1 - _m) * (_m * (1 - _m) / _v - 1)
        _alpha = max(_alpha, 0.5)
        _beta = max(_beta, 0.5)
    else:
        _alpha = 2.0
        _beta = max(2.0 / max(_mean_ratio, 0.01) - 2.0, 1.0)
    mass_draws = rng.beta(_alpha, _beta, size=S)  # (S,)

    # Sample shape: bootstrap from shape donors
    donor_idx = rng.integers(0, len(shape_donors), size=S)
    shape_arr = np.array(shape_donors)  # (n_donors, T)
    mc_shapes = shape_arr[donor_idx]    # (S, T)

    # Combine: each draw's CDF = shape × (mass_draw / _eventual_reach)
    # The shape is normalised by eventual_reach, so its terminal ≤ 1.
    # Scaling by mass_draw / _eventual_reach makes each particle see
    # a different eventual upstream mass.  Pop C then multiplies by
    # the fixed `reach`, so the effective per-draw reach is
    # reach × mass_draw / _eventual_reach.
    #
    # Do NOT clip to [0, 1]: mass_draw > _eventual_reach means "more
    # mass than the point estimate" — the upper fan needs that.  The
    # CDF here is a mass-scaled arrival fraction, not a probability.
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

    # Broad lognormal prior: median ≈ 30 days, very wide
    _mu_prior = math.log(30.0)
    _sigma_prior = 1.5

    # Deterministic CDF
    det_cdf = [0.0] * T
    for t in range(T):
        if t > 0:
            z = (math.log(t) - _mu_prior) / _sigma_prior
            det_cdf[t] = float(_ndtr(z))

    # Stochastic: sample mu, sigma from broad priors
    _mu_s = rng.normal(_mu_prior, 0.5, size=S)      # wide around log(30)
    _sigma_s = np.clip(rng.normal(_sigma_prior, 0.3, size=S), 0.3, 3.0)
    _t_safe = np.maximum(tau_grid[None, :], 1e-12)
    _z = (np.log(_t_safe) - _mu_s[:, None]) / _sigma_s[:, None]
    mc_cdf = np.clip(_ndtr(_z), 0.0, 1.0)
    # tau=0 is always 0
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

    # Tier 1: parametric ingress
    result = _build_tier1_parametric(
        upstream_params_list, reach, is_window, max_tau, num_draws, rng,
    )
    if result is not None:
        print(f"[v2] carrier tier=parametric: {len(upstream_params_list)} edges")
        return (result[0], result[1], 'parametric')

    # Tier 2: empirical tail
    result = _build_tier2_empirical(
        upstream_obs, cohort_list, reach, is_window, max_tau, num_draws, rng,
    )
    if result is not None:
        return (result[0], result[1], 'empirical')

    # Tier 3: weak prior backstop
    det_cdf, mc_cdf = _build_tier3_weak_prior(
        reach, is_window, max_tau, num_draws, rng,
    )
    return (det_cdf, mc_cdf, 'weak_prior')


def compute_cohort_maturity_rows_v2(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    span_params: SpanParams,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool = True,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
    anchor_node_id: Optional[str] = None,
    sampling_mode: str = 'binomial',
    mc_cdf_arr=None,           # (S, T) per-draw CDF from mc_span_cdfs
    mc_p_s=None,               # (S,) per-draw span_p from mc_span_cdfs
    x_provider=None,           # XProvider for upstream
    upstream_obs=None,         # Dict[str, List[Tuple[int, float]]] from extract_upstream_observations
) -> List[Dict[str, Any]]:
    """Compute per-τ rows for cohort maturity v2 chart.

    Factorised representation: X_x (from x_provider) + K_{x→y} (from
    span_params).  All stages use the normalised completeness C_{x→y}
    consistently.  No collapsed anchor-to-y semantics.

    Args:
        frames: composed evidence frames.
        graph: scenario graph.
        target_edge_id: UUID of last edge in span.
        span_params: resolved span parameters (C, span_p, prior, SDs).
        mc_cdf_arr: (S, T) per-draw normalised CDF from mc_span_cdfs.
            Each row is C_{x→y} for that draw (already normalised to [0,1]).
        mc_p_s: (S,) per-draw span_p from mc_span_cdfs.
        x_provider: upstream arrival provider.

    Returns:
        List of row dicts sorted by tau_days ascending.
    """
    import numpy as np
    from .cohort_forecast import find_edge_by_id, get_incoming_edges, read_edge_cohort_params
    from .confidence_bands import _shifted_lognormal_cdf

    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return []

    sp = span_params
    tau_chart_extent = max(0, (sweep_to_d - anchor_from_d).days)
    max_tau = tau_chart_extent
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    elif sp.sigma > 0:
        # t95 fallback: extend to where 95% of the span CDF has matured
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(0.95, sp.mu, sp.sigma) + sp.onset
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass
    max_tau = min(max_tau, sp.max_tau)
    tau_solid_max = max(0, (sweep_to_d - anchor_to_d).days)
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)

    # ── Deterministic CDF from normalised completeness ────────────────
    def _cdf(tau: float) -> float:
        t = int(round(tau))
        if t < 0:
            return 0.0
        if t >= len(sp.C):
            return sp.C[-1] if sp.C else 0.0
        return sp.C[t]

    # ── Upstream (x_provider) ─────────────────────────────────────────
    from .cohort_forecast import XProvider, build_x_provider_from_graph
    if x_provider is None:
        x_provider = build_x_provider_from_graph(
            graph, target_edge, anchor_node_id, is_window,
        )
    upstream_params_list = (
        x_provider.ingress_carrier
        if x_provider.ingress_carrier
        else x_provider.upstream_params_list
    )
    reach = x_provider.reach
    # Merge upstream_obs sources: prefer explicit param, fall back to x_provider
    _upstream_obs = upstream_obs or x_provider.upstream_obs

    # NOTE: upstream carrier build is deferred to after cohort_list is
    # populated (Tier 2 needs cohort info for donor classification).
    # See "Build upstream carrier" section below.
    upstream_path_cdf_arr: Optional[List[float]] = None

    # ── Parse frames into per-cohort data ─────────────────────────────
    cohort_info: Dict[str, Dict[str, Any]] = {}
    last_frame = None
    for f in frames:
        if f.get('snapshot_date') and str(f['snapshot_date'])[:10] <= str(sweep_to)[:10]:
            last_frame = f
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
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            a_val = dp.get('a', 0)
            if not isinstance(x_val, (int, float)):
                x_val = 0
            if not isinstance(a_val, (int, float)) or a_val <= 0:
                a_val = max(x_val, 1)
            tau_max_c = (last_frame_date - ad).days if last_frame_date else 0
            cohort_info[ad_str] = {
                'x_frozen': float(x_val),
                'y_frozen': float(y_val) if isinstance(y_val, (int, float)) else 0.0,
                'a_frozen': float(a_val),
                'tau_max': max(tau_max_c, 0),
                'anchor_day': ad,
            }

    # ── Bucket aggregation (for evidence rate + projected_rate) ───────
    class _Bucket:
        __slots__ = ('sum_y', 'sum_x', 'sum_y_mature', 'sum_x_mature',
                     'sum_proj_y', 'sum_proj_x', 'count', 'mature_count', 'proj_count')
        def __init__(self):
            self.sum_y = 0.0; self.sum_x = 0.0
            self.sum_y_mature = 0.0; self.sum_x_mature = 0.0
            self.sum_proj_y = 0.0; self.sum_proj_x = 0.0
            self.count = 0; self.mature_count = 0; self.proj_count = 0
    buckets: Dict[int, Any] = {}
    cohort_at_tau: Dict[str, Dict[int, Tuple[float, float]]] = defaultdict(dict)

    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        for dp in f.get('data_points', []):
            ad_str = str(dp.get('anchor_day', ''))[:10]
            ci = cohort_info.get(ad_str)
            if ci is None:
                continue
            try:
                sd_d = _date.fromisoformat(sd_str)
                ad_d = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            tau = (sd_d - ad_d).days
            if tau < 0 or tau > max_tau:
                continue
            y_val = dp.get('y')
            x_val = dp.get('x')
            proj_y = dp.get('projected_y')
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if tau not in buckets:
                buckets[tau] = _Bucket()
            b = buckets[tau]
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

    # ── Determine tau_observed per cohort ──────────────────────────────
    for ad_str, ci in cohort_info.items():
        tau_obs = 0
        if last_frame_date:
            try:
                ad_d = _date.fromisoformat(ad_str)
                tau_obs = (last_frame_date - ad_d).days
            except (ValueError, TypeError):
                pass
        ci['tau_observed'] = min(tau_obs, ci['tau_max'])

    # ── Zone boundaries ───────────────────────────────────────────────
    cohort_list = sorted(cohort_info.values(), key=lambda c: c['anchor_day'])
    if cohort_list:
        youngest = cohort_list[-1]
        tau_solid_max = youngest.get('tau_observed', youngest['tau_max'])
        oldest = cohort_list[0]
        tau_future_max = oldest['tau_max']

    # ── Build upstream carrier (deferred from above) ─────────────────
    # Now that cohort_list is populated, Tier 2 can classify donors.
    import numpy as np
    _carrier_rng = np.random.default_rng(43)
    upstream_path_cdf_arr, upstream_cdf_mc_from_carrier, _carrier_tier = build_upstream_carrier(
        upstream_params_list=upstream_params_list,
        upstream_obs=_upstream_obs,
        cohort_list=cohort_list,
        reach=reach,
        is_window=is_window,
        max_tau=max_tau,
        num_draws=2000,
        rng=_carrier_rng,
    )
    print(f"[v2] carrier: tier={_carrier_tier}")

    # ── Per-cohort obs_x / obs_y / x_at_tau ───────────────────────────
    for c in cohort_list:
        N_i = c['x_frozen']
        a_i = c.get('tau_observed', c['tau_max'])
        a_pop = c.get('a_frozen', N_i) or N_i or 1.0
        ad_str = c['anchor_day'].isoformat()
        tau_data = cohort_at_tau.get(ad_str, {})

        obs_x = [0.0] * (max_tau + 1)
        obs_y = [0.0] * (max_tau + 1)
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
                obs_x[t] = last_x
                obs_y[t] = last_y
            else:
                obs_x[t] = last_x if last_x > 0 else float(N_i)
                obs_y[t] = last_y
        c['obs_x'] = obs_x
        c['obs_y'] = obs_y

        if upstream_path_cdf_arr is None:
            c['x_at_tau'] = [float(N_i)] * (max_tau + 1)
            c['x_frontier'] = float(N_i)
        else:
            x_arr = [max(a_pop * reach * upstream_path_cdf_arr[t], float(N_i))
                     for t in range(max_tau + 1)]
            c['x_at_tau'] = x_arr
            a_idx = min(a_i, max_tau)
            c['x_frontier'] = x_arr[a_idx]

    # ── Monte Carlo fan bands ─────────────────────────────────────────
    MC_SAMPLES = 2000
    fan_quantiles: Optional[Dict[int, Any]] = None

    has_bayes = sp.span_p > 0 and sp.mu_sd > 0

    if has_bayes and mc_cdf_arr is not None and mc_p_s is not None:
        import numpy as np
        from scipy.special import ndtr as _ndtr, logit as _logit, expit as _expit

        rng = np.random.default_rng(42)
        tau_grid = np.arange(0, max_tau + 1, dtype=float)
        T = len(tau_grid)
        S = MC_SAMPLES

        # mc_cdf_arr: (S, T) per-draw normalised CDF [0, 1]
        # mc_p_s: (S,) per-draw span_p
        # Slice MC arrays to match max_tau (they may be wider)
        cdf_arr = np.clip(mc_cdf_arr[:S, :T], 0.0, 1.0)
        p_s = np.clip(mc_p_s[:S], 1e-6, 1 - 1e-6)

        # ── Per-cohort drift layer ────────────────────────────────────
        DRIFT_FRACTION = 0.20
        _p_clamp = np.clip(sp.span_p, 0.01, 0.99)
        _p_var_logit = (sp.alpha_0 / (sp.alpha_0 + sp.beta_0)
                        if sp.alpha_0 > 0 and sp.beta_0 > 0 else 0.01)
        # Use span_p uncertainty for drift, not path-level
        _p_sd = math.sqrt(sp.alpha_0 * sp.beta_0 / (
            (sp.alpha_0 + sp.beta_0) ** 2 * (sp.alpha_0 + sp.beta_0 + 1)
        )) if sp.alpha_0 > 0 and sp.beta_0 > 0 else 0.05
        _p_var_logit = _p_sd ** 2 / (_p_clamp * (1 - _p_clamp)) ** 2
        _mu_var = sp.mu_sd ** 2
        _sigma_var_log = sp.sigma_sd ** 2 / max(sp.sigma, 0.01) ** 2
        _onset_var_log1p = sp.onset_sd ** 2 / max(1 + sp.onset, 1.0) ** 2

        drift_sds = np.sqrt(DRIFT_FRACTION * np.array([
            _p_var_logit, _mu_var, _sigma_var_log, _onset_var_log1p,
        ]))

        # Transform global draws to unconstrained scale
        # For v2: p_s comes from mc_span_cdfs, mu/sigma/onset are fixed
        # (the CDF already varies per draw via reconvolution)
        theta_transformed = np.column_stack([
            _logit(p_s),
            np.full(S, sp.mu),
            np.log(np.maximum(np.full(S, sp.sigma), 0.01)),
            np.log1p(np.maximum(np.full(S, sp.onset), 0.0)),
        ])

        # ── Upstream MC CDF (from carrier hierarchy) ────────────────
        # upstream_cdf_mc_from_carrier was built by build_upstream_carrier
        # above. Slice to match MC sample count and tau grid.
        upstream_cdf_mc = None
        if upstream_cdf_mc_from_carrier is not None:
            upstream_cdf_mc = upstream_cdf_mc_from_carrier[:S, :T]

        # ── IS conditioning on upstream observations ──────────────────
        # Skip for Tier 2: evidence is already incorporated into the
        # empirical carrier.  Conditioning again would double-count,
        # over-tightening the fan.
        if (upstream_cdf_mc is not None
                and _upstream_obs is not None
                and reach > 0
                and _carrier_tier != 'empirical'):
            _all_obs = []
            for c in cohort_list:
                _ad_key = c['anchor_day'].isoformat()
                _cohort_obs = _upstream_obs.get(_ad_key, [])
                _a_pop_c = c.get('a_frozen', c['x_frozen']) or c['x_frozen'] or 1.0
                for (_tau_obs, _x_obs) in _cohort_obs:
                    if 0 <= _tau_obs < T:
                        _all_obs.append((_tau_obs, _x_obs, _a_pop_c))
            if _all_obs:
                _log_w_up = np.zeros(S)
                for (_tau_obs, _x_obs, _a_pop_c) in _all_obs:
                    _x_model = _a_pop_c * reach * upstream_cdf_mc[:, _tau_obs]
                    _sigma_obs = max(math.sqrt(max(_x_obs, 1.0)), 1.0)
                    _log_w_up += -0.5 * ((_x_obs - _x_model) / _sigma_obs) ** 2
                _log_w_up -= np.max(_log_w_up)
                _w_up = np.exp(_log_w_up)
                _w_up /= _w_up.sum()
                _ess_up = 1.0 / np.sum(_w_up ** 2)
                if _ess_up > 5:
                    _resample_idx = rng.choice(S, size=S, replace=True, p=_w_up)
                    upstream_cdf_mc = upstream_cdf_mc[_resample_idx]

        # ── Per-cohort conditional forecast ───────────────────────────
        Y_total = np.zeros((S, T))
        X_total = np.zeros((S, T))

        for _ci, c in enumerate(cohort_list):
            N_i = c['x_frozen']
            k_i = c['y_frozen']
            a_i = c.get('tau_observed', c['tau_max'])
            x_frontier = c['x_frontier']
            a_pop = c.get('a_frozen', N_i) or N_i or 1.0

            if N_i <= 0 and x_frontier <= 0 and upstream_cdf_mc is None:
                continue

            a_idx = min(a_i, T - 1)

            # ── Effective exposure E_i (doc 29d §Frontier Exposure) ──
            # E_i = Σ_u ΔX_x(u) · C(a_i − u)
            # Uses deterministic normalised completeness sp.C.
            obs_x_arr = c.get('obs_x', [])
            _C = sp.C
            _C_len = len(_C)
            E_i = 0.0
            if obs_x_arr and a_i > 0:
                prev_x = 0.0
                for u in range(min(a_i + 1, len(obs_x_arr))):
                    dx = obs_x_arr[u] - prev_x
                    prev_x = obs_x_arr[u]
                    lag = a_i - u
                    c_val = _C[min(lag, _C_len - 1)] if _C_len > 0 else 1.0
                    E_i += max(dx, 0.0) * c_val
            else:
                E_i = float(N_i)
            # E_i can't exceed N_i (mass conservation)
            E_i = min(E_i, float(N_i))

            # Per-cohort drifted params
            delta_i = rng.normal(0.0, drift_sds, size=(S, 4))
            theta_i = theta_transformed + delta_i
            p_i = _expit(theta_i[:, 0])               # (S,)

            # CDF is from mc_span_cdfs — already per-draw, normalised
            # Per-cohort drift only affects p (rate), not CDF shape
            cdf_i = cdf_arr                             # (S, T)

            # ── IS conditioning on frontier evidence ──────────────
            # Doc 29d §Frontier Exposure, parameterisation B:
            # E_i absorbs completeness into the trial count, so the
            # per-trial probability is p (not p × C).  This avoids
            # numerical collapse when C(a_i) is small.
            # Guard: E_eff ≥ k_i so failures are never negative.
            E_eff = max(E_i, k_i)
            _E_fail = E_eff - k_i
            # Skip IS when failure count < 1: the evidence says "almost
            # everything exposed converted" — no information about p
            # except "it's high", which collapses all draws to max(p).
            if E_eff > 0 and a_i > 0 and _E_fail >= 1.0:
                p_i_clip = np.clip(p_i, 1e-15, 1 - 1e-15)
                log_w_i = (k_i * np.log(p_i_clip)
                           + _E_fail * np.log(1 - p_i_clip))
                log_w_i -= np.max(log_w_i)
                w_i = np.exp(log_w_i)
                w_i /= w_i.sum()
                resample_idx = rng.choice(S, size=S, replace=True, p=w_i)
                p_i = p_i[resample_idx]
                cdf_i = cdf_i[resample_idx]

            # ── Pop D: frontier survivors ─────────────────────────
            # q_late = p(C(τ) - C(a_i)) / (1 - p·C(a_i))
            # remaining = N_i - k_i: actual people at x who haven't
            # converted.  (E_i adjusts the IS likelihood, not the
            # frontier population.  Doc 29d's β_post uses E_i for
            # estimating p, but Pop D counts real unconverted people.)
            cdf_at_a = cdf_i[:, a_idx]
            c_i_b = cdf_at_a[:, None]
            remaining_frontier = max(N_i - k_i, 0.0)
            q_early = p_i[:, None] * c_i_b
            q_early = np.clip(q_early, 0.0, 1 - 1e-10)
            remaining_cdf = np.maximum(cdf_i - c_i_b, 0.0)
            q_late = (p_i[:, None] * remaining_cdf) / (1 - q_early)
            q_late = np.clip(q_late, 0.0, 1.0)
            if sampling_mode == 'none':
                Y_D = remaining_frontier * q_late
            elif sampling_mode == 'normal':
                _mu_d = remaining_frontier * q_late
                _var_d = remaining_frontier * q_late * (1 - q_late)
                Y_D = np.clip(
                    _mu_d + rng.normal(0.0, np.sqrt(np.maximum(_var_d, 1e-12))),
                    0.0, remaining_frontier)
            else:
                Y_D = rng.binomial(int(remaining_frontier), q_late)

            # ── Pop C: post-frontier upstream arrivals ────────────
            X_C = np.zeros((S, T), dtype=np.float64)
            Y_C = np.zeros((S, T), dtype=np.float64)
            _has_upstream = upstream_cdf_mc is not None and x_provider.enabled
            if _has_upstream:
                _up_scaled = a_pop * reach * upstream_cdf_mc
                _up_at_frontier = _up_scaled[:, a_idx:a_idx + 1]
                X_C = np.maximum(_up_scaled - _up_at_frontier, 0.0)
                model_rate_per_draw = p_i[:, None] * cdf_i
                model_rate_per_draw = np.clip(model_rate_per_draw, 0.0, 1.0)
                Y_C = X_C * model_rate_per_draw

            # ── Combine ───────────────────────────────────────────
            X_forecast = float(N_i) + X_C
            Y_forecast = float(k_i) + Y_D.astype(np.float64) + Y_C
            Y_forecast = np.clip(Y_forecast, float(k_i), X_forecast)

            observed_x = np.array(c['obs_x'][:T])
            observed_y = np.array(c['obs_y'][:T])
            mature_mask = tau_grid <= a_i
            Y_cohort = np.where(mature_mask[None, :], observed_y[None, :], Y_forecast)
            X_cohort = np.where(mature_mask[None, :], observed_x[None, :], X_forecast)

            Y_total += Y_cohort
            X_total += X_cohort

        # ── Aggregate rate quantiles ──────────────────────────────────
        _x_median = np.median(X_total, axis=0)
        if np.any(_x_median >= 1.0):
            X_total_safe = np.maximum(X_total, 1e-10)
            rate_agg = Y_total / X_total_safe
        else:
            rate_agg = p_s[:S, None] * cdf_arr[:S]

        _band_levels = [0.80, 0.90, 0.95, 0.99]
        _pcts = [50.0]
        for bl in _band_levels:
            a = (1.0 - bl) / 2.0
            _pcts.extend([a * 100, (1.0 - a) * 100])
        _all_q = np.percentile(rate_agg, sorted(set(_pcts)), axis=0)
        _pct_sorted = sorted(set(_pcts))
        _q_by_pct = {p: _all_q[i] for i, p in enumerate(_pct_sorted)}

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
                'bands': {
                    bl: (float(_q_by_pct[(1.0 - bl) / 2.0 * 100][t_idx]),
                         float(_q_by_pct[(1.0 + bl) / 2.0 * 100][t_idx]))
                    for bl in _band_levels
                },
            }

        # Model fan (unconditioned)
        rate_model = p_s[:S, None] * cdf_arr[:S]
        _model_q = np.percentile(rate_model, _pct_sorted, axis=0)
        _mq_by_pct = {p: _model_q[i] for i, p in enumerate(_pct_sorted)}
        _mq50 = _mq_by_pct[50.0]
        _mq_lo = _mq_by_pct.get(a_sel * 100, _mq_by_pct.get(5.0))
        _mq_hi = _mq_by_pct.get((1.0 - a_sel) * 100, _mq_by_pct.get(95.0))

        model_fan_quantiles = {}
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
    else:
        fan_quantiles = None
        model_fan_quantiles = None

    # ── Emit rows ─────────────────────────────────────────────────────
    rows: List[Dict[str, Any]] = []

    for tau in range(0, max_tau + 1):
        b = buckets.get(tau)

        # Evidence rate
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

        # Projected rate — annotation-only on factorised path.
        # projected_y comes from annotate_rows (collapsed edge params),
        # not from span quantities.  In epoch C (tau > tau_future_max),
        # this is overridden with the MC-derived midpoint.
        projected_rate: Optional[float] = None
        if b and b.sum_proj_x > 0 and b.proj_count > 0:
            projected_rate = max(0.0, min(1.0, b.sum_proj_y / b.sum_proj_x))

        # Midpoint + forecast totals (deterministic)
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
                # Compute deterministic E_i for this cohort
                _obs_x_det = c.get('obs_x', [])
                _E_i_det = 0.0
                if _obs_x_det and a_i_det > 0:
                    _prev = 0.0
                    for _u in range(min(a_i_det + 1, len(_obs_x_det))):
                        _dx = _obs_x_det[_u] - _prev
                        _prev = _obs_x_det[_u]
                        _lag = a_i_det - _u
                        _cv = sp.C[min(_lag, len(sp.C) - 1)] if sp.C else 1.0
                        _E_i_det += max(_dx, 0.0) * _cv
                else:
                    _E_i_det = float(N_i_det)
                _E_i_det = min(_E_i_det, float(N_i_det))
                cdf_a_det = _cdf(a_i_det)
                cdf_tau_det = _cdf(tau)
                q_early_det = sp.span_p * cdf_a_det
                q_early_det = min(q_early_det, 1 - 1e-10)
                remaining_det = max(0.0, cdf_tau_det - cdf_a_det)
                q_late_det = (sp.span_p * remaining_det) / (1 - q_early_det)
                q_late_det = min(max(q_late_det, 0.0), 1.0)
                _remaining_det = max(N_i_det - k_i_det, 0.0)
                Y_D_det = _remaining_det * q_late_det

                # Pop C deterministic
                X_C_det = 0.0
                Y_C_det = 0.0
                if upstream_path_cdf_arr is not None and reach > 0 and x_provider.enabled:
                    _a_pop_det = c.get('a_frozen', N_i_det) or N_i_det or 1.0
                    tau_clamped = min(tau, len(upstream_path_cdf_arr) - 1)
                    a_clamped = min(a_i_det, len(upstream_path_cdf_arr) - 1)
                    X_C_det = max(0.0, _a_pop_det * reach * (
                        upstream_path_cdf_arr[tau_clamped] - upstream_path_cdf_arr[a_clamped]))
                    model_rate_det = sp.span_p * cdf_tau_det
                    Y_C_det = X_C_det * min(model_rate_det, 1.0)

                x_total_det = N_i_det + X_C_det
                y_total_det = k_i_det + Y_D_det + Y_C_det
                y_total_det = min(y_total_det, x_total_det)
                total_x_aug += x_total_det
                total_y_aug += y_total_det

        # Midpoint: prefer MC median, fall back to deterministic
        midpoint: Optional[float] = None
        if fan_quantiles is not None:
            fq_mid = fan_quantiles.get(tau)
            if fq_mid is not None:
                midpoint = max(0.0, min(1.0, fq_mid['mid']))
        if midpoint is None and total_x_aug > 0:
            midpoint = max(0.0, min(1.0, total_y_aug / total_x_aug))

        # Epoch A: midpoint = evidence, suppress display.
        # At tau_solid_max itself, emit midpoint so dotted line connects.
        if tau < tau_solid_max:
            midpoint = None

        # Epoch C: midpoint IS the projection
        if tau > tau_future_max and midpoint is not None:
            projected_rate = midpoint

        # Fan
        fan_upper: Optional[float] = None
        fan_lower: Optional[float] = None
        fan_bands: Optional[Dict] = None
        if midpoint is not None and fan_quantiles is not None:
            fq = fan_quantiles.get(tau)
            if fq is not None:
                if tau <= tau_solid_max:
                    # Epoch A: flatten fan to midpoint (no uncertainty)
                    fan_upper = midpoint
                    fan_lower = midpoint
                    fan_bands = {
                        str(int(bl * 100)): [midpoint, midpoint]
                        for bl in [0.80, 0.90, 0.95, 0.99]
                    }
                else:
                    fan_upper = max(0.0, min(1.0, fq['hi']))
                    fan_lower = max(0.0, min(1.0, fq['lo']))
                    midpoint = max(0.0, min(1.0, fq['mid']))
                    fan_bands = {
                        str(int(bl * 100)): [max(0.0, lo), min(1.0, hi)]
                        for bl, (lo, hi) in fq['bands'].items()
                    }

        # Model fan
        model_midpoint: Optional[float] = None
        model_fan_upper: Optional[float] = None
        model_fan_lower: Optional[float] = None
        model_bands: Optional[Dict] = None
        if model_fan_quantiles is not None:
            mfq = model_fan_quantiles.get(tau)
            if mfq is not None:
                model_midpoint = max(0.0, min(1.0, mfq['mid']))
                model_fan_upper = max(0.0, min(1.0, mfq['hi']))
                model_fan_lower = max(0.0, min(1.0, mfq['lo']))
                model_bands = {
                    str(int(bl * 100)): [max(0.0, lo), min(1.0, hi)]
                    for bl, (lo, hi) in mfq['bands'].items()
                }

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
            'evidence_y': round(ev_y_total, 1) if ev_y_total is not None else None,
            'evidence_x': round(ev_x_total, 1) if ev_x_total is not None else None,
            'forecast_y': round(total_y_aug, 1) if midpoint is not None else None,
            'forecast_x': round(total_x_aug, 1) if midpoint is not None else None,
        }
        if fan_bands:
            row['fan_bands'] = fan_bands
        if model_midpoint is not None:
            row['model_midpoint'] = model_midpoint
            row['model_fan_upper'] = model_fan_upper
            row['model_fan_lower'] = model_fan_lower
        if model_bands:
            row['model_bands'] = model_bands
        rows.append(row)

    return rows
