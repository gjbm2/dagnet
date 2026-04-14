"""
ForecastState — generalised forecast engine output contract.

Produced per edge per subject. Consumers read from this rather than
independently computing completeness, rate, and dispersions.

See doc 29 §ForecastState Contract.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from .model_resolver import ResolvedLatency, ResolvedModelParams


# ═══════════════════════════════════════════════════════════════════════
# Contract types
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class Dispersions:
    """Raw component SDs for consumers that need them."""
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0


@dataclass
class TrajectoryPoint:
    """Per-tau forecast state for trajectory consumers."""
    tau: int
    completeness: float
    completeness_sd: float
    rate_unconditioned: float
    rate_unconditioned_sd: float
    rate_conditioned: float
    rate_conditioned_sd: float


@dataclass
class ForecastState:
    """Per-edge forecast state — the engine's output contract."""

    # Identity
    edge_id: str = ''
    source: str = ''              # 'analytic' | 'analytic_be' | 'bayesian' | 'manual'
    fitted_at: Optional[str] = None
    tier: str = 'fe_instant'      # 'fe_instant' | 'be_forecast' | 'fe_only'

    # Query context
    evaluation_date: str = ''
    evidence_cutoff_date: str = ''
    posterior_cutoff_date: str = ''

    # Completeness
    completeness: float = 0.0
    completeness_sd: Optional[float] = None

    # Model (unconditioned)
    rate_unconditioned: Optional[float] = None
    rate_unconditioned_sd: Optional[float] = None

    # Evidence-conditioned
    rate_conditioned: float = 0.0
    rate_conditioned_sd: Optional[float] = None
    tau_observed: int = 0

    # Raw dispersions
    dispersions: Optional[Dispersions] = None

    # Mode metadata
    mode: str = 'window'          # 'window' | 'cohort'
    path_aware: bool = False

    # Trajectory (optional)
    trajectory: Optional[List[TrajectoryPoint]] = None

    # Resolved params (for MC consumers like v3)
    resolved_params: Optional[ResolvedModelParams] = None


# ═══════════════════════════════════════════════════════════════════════
# Completeness with uncertainty
# ═══════════════════════════════════════════════════════════════════════

_COMPLETENESS_SD_DRAWS = 200


def _compute_completeness_at_age(
    age_days: float,
    mu: float,
    sigma: float,
    onset: float,
) -> float:
    """Compute completeness = CDF(age - onset, mu, sigma).

    Same formula as forecast_application.compute_completeness but
    inlined to avoid circular imports.
    """
    model_age = age_days - onset
    if model_age <= 0 or sigma <= 0:
        return 1.0 if (sigma <= 0 and model_age >= math.exp(mu)) else 0.0
    z = (math.log(model_age) - mu) / sigma
    # Standard normal CDF via erfc
    return 0.5 * math.erfc(-z / math.sqrt(2))


def compute_completeness_with_sd(
    age_days: float,
    latency: ResolvedLatency,
) -> tuple:
    """Compute completeness point estimate and SD from latency dispersions.

    Uses 200 draws from (mu, sigma, onset) with onset_mu_corr.
    Returns (completeness, completeness_sd).

    When SDs are all zero, returns (point_estimate, 0.0).
    """
    mu = latency.mu
    sigma = latency.sigma
    onset = latency.onset_delta_days

    point = _compute_completeness_at_age(age_days, mu, sigma, onset)

    # If no dispersions, SD is zero
    if latency.mu_sd <= 0 and latency.sigma_sd <= 0 and latency.onset_sd <= 0:
        return (point, 0.0)

    rng = np.random.default_rng(seed=71)
    S = _COMPLETENESS_SD_DRAWS

    # Draw mu and onset jointly (correlated via onset_mu_corr)
    mu_draws = rng.normal(mu, max(latency.mu_sd, 1e-10), size=S)
    onset_mean = onset
    onset_sd = max(latency.onset_sd, 1e-10)

    if abs(latency.onset_mu_corr) > 1e-6 and latency.mu_sd > 0:
        # Conditional draw: onset | mu
        rho = latency.onset_mu_corr
        onset_draws = (
            onset_mean
            + rho * (onset_sd / max(latency.mu_sd, 1e-10)) * (mu_draws - mu)
            + rng.normal(0, onset_sd * math.sqrt(max(1 - rho * rho, 0)), size=S)
        )
    else:
        onset_draws = rng.normal(onset_mean, onset_sd, size=S)

    onset_draws = np.maximum(onset_draws, 0.0)

    # Draw sigma independently (no known correlation with mu/onset)
    sigma_draws = np.clip(
        rng.normal(sigma, max(latency.sigma_sd, 1e-10), size=S),
        0.01, 20.0,
    )

    # Evaluate CDF for each draw
    completeness_draws = np.array([
        _compute_completeness_at_age(age_days, float(mu_draws[i]),
                                      float(sigma_draws[i]),
                                      float(onset_draws[i]))
        for i in range(S)
    ])

    c_sd = float(np.std(completeness_draws))
    return (point, c_sd)


# ═══════════════════════════════════════════════════════════════════════
# Composed rate uncertainty
# ═══════════════════════════════════════════════════════════════════════

def _compose_rate_sd(
    p: float,
    p_sd: float,
    completeness: float,
    completeness_sd: float,
) -> float:
    """Compose rate SD from p and completeness uncertainties.

    Independence assumption (doc 29 §note): overestimates rate_sd
    because p and latency are anti-correlated in the posterior.
    Conservative (wider bands than warranted).
    """
    if completeness_sd <= 0 and p_sd <= 0:
        return 0.0
    term_p = completeness * p_sd
    term_c = p * completeness_sd
    return math.sqrt(term_p * term_p + term_c * term_c)


# ═══════════════════════════════════════════════════════════════════════
# Window-mode ForecastState computation
# ═══════════════════════════════════════════════════════════════════════

def compute_forecast_state_window(
    edge_id: str,
    resolved: ResolvedModelParams,
    cohort_ages_and_weights: List[tuple],
    evaluation_date: str = '',
    evidence_cutoff_date: str = '',
    posterior_cutoff_date: str = '',
    evidence_rate: Optional[float] = None,
) -> ForecastState:
    """Compute ForecastState for a window-mode edge.

    Args:
        edge_id: edge UUID.
        resolved: resolved model params from the promoted resolver.
        cohort_ages_and_weights: list of (age_days, n) tuples for
            the cohorts in the query window. Used to compute
            n-weighted completeness.
        evaluation_date: asat date or "now".
        evidence_cutoff_date: snapshot cutoff.
        posterior_cutoff_date: model cutoff.
        evidence_rate: observed k/n if available (for conditioning).

    Returns:
        ForecastState with all window-mode fields populated.
    """
    lat = resolved.latency
    p = resolved.p_mean

    # ── N-weighted completeness with SD ──────────────────────────
    total_n = 0.0
    weighted_c = 0.0
    weighted_c_sd_sq = 0.0  # variance, n-weighted

    for age_days, n in cohort_ages_and_weights:
        c, c_sd = compute_completeness_with_sd(float(age_days), lat)
        weighted_c += n * c
        weighted_c_sd_sq += n * n * c_sd * c_sd
        total_n += n

    if total_n > 0:
        completeness = weighted_c / total_n
        # SD of weighted mean: sqrt(Σ(n_i² × sd_i²)) / Σ(n_i)
        completeness_sd = math.sqrt(weighted_c_sd_sq) / total_n
    else:
        completeness = 0.0
        completeness_sd = 0.0

    # ── Rates ────────────────────────────────────────────────────
    rate_unconditioned = p * completeness
    rate_unconditioned_sd = _compose_rate_sd(p, resolved.p_sd,
                                             completeness, completeness_sd)

    # Evidence-conditioned: blend
    if evidence_rate is not None and completeness > 0:
        # Blend: c × evidence + (1-c) × model
        model_rate = p * completeness
        rate_conditioned = (
            completeness * evidence_rate
            + (1 - completeness) * model_rate
        )
        # Conditioned SD shrinks as completeness → 1
        # At c=1: pure evidence, SD = evidence sampling SD (not computed here)
        # At c=0: pure model, SD = rate_unconditioned_sd
        rate_conditioned_sd = (1 - completeness) * rate_unconditioned_sd
    else:
        rate_conditioned = rate_unconditioned
        rate_conditioned_sd = rate_unconditioned_sd

    # ── Tau observed (n-weighted age) ────────────────────────────
    tau_observed = 0
    if total_n > 0 and cohort_ages_and_weights:
        tau_observed = int(round(
            sum(age * n for age, n in cohort_ages_and_weights) / total_n
        ))

    dispersions = Dispersions(
        p_sd=resolved.p_sd,
        mu_sd=lat.mu_sd,
        sigma_sd=lat.sigma_sd,
        onset_sd=lat.onset_sd,
    )

    return ForecastState(
        edge_id=edge_id,
        source=resolved.source,
        fitted_at=resolved.fitted_at,
        tier='be_forecast',
        evaluation_date=evaluation_date,
        evidence_cutoff_date=evidence_cutoff_date,
        posterior_cutoff_date=posterior_cutoff_date,
        completeness=completeness,
        completeness_sd=completeness_sd,
        rate_unconditioned=rate_unconditioned,
        rate_unconditioned_sd=rate_unconditioned_sd,
        rate_conditioned=rate_conditioned,
        rate_conditioned_sd=rate_conditioned_sd,
        tau_observed=tau_observed,
        dispersions=dispersions,
        mode='window',
        path_aware=False,
        resolved_params=resolved,
    )


# ═══════════════════════════════════════════════════════════════════════
# Phase 3: Cohort-mode upstream-aware completeness
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class NodeArrivalState:
    """Per-node arrival state, cached during the graph-wide topo pass.

    The deterministic CDF and MC CDF represent the distribution of
    arrivals at this node over time, conditioned on reaching it from the
    anchor. Outgoing edges read the from-node's cache as their
    x_provider equivalent.

    See doc 29 §Per-node cache contents.
    """
    deterministic_cdf: Optional[List[float]] = None   # (T,) weighted upstream CDF
    mc_cdf: Optional[np.ndarray] = None               # (S, T) if upstream has uncertainty
    reach: float = 0.0                                 # probability of reaching this node from anchor
    evidence_obs: Optional[Dict[str, Any]] = None      # observations for IS conditioning
    tier: str = 'none'                                 # carrier tier used: 'parametric'|'empirical'|'weak_prior'|'none'


_COHORT_MC_DRAWS = 2000


def compute_forecast_state_cohort(
    edge_id: str,
    resolved: ResolvedModelParams,
    cohort_ages_and_weights: List[tuple],
    from_node_arrival: NodeArrivalState,
    evaluation_date: str = '',
    evidence_cutoff_date: str = '',
    posterior_cutoff_date: str = '',
    evidence_rate: Optional[float] = None,
) -> ForecastState:
    """Compute ForecastState for a cohort-mode edge using upstream arrival state.

    Uses the upstream carrier (from_node_arrival) to compute
    upstream-aware completeness — same maths as cohort_forecast_v2's
    effective exposure computation.

    For each cohort age τ:
        C(τ) = ∫₀ᵗ f_upstream(u) × CDF_edge(τ - u) du / reach

    where f_upstream is the PDF of arrivals at the from-node (derivative
    of the carrier's deterministic CDF), CDF_edge is the edge's
    lognormal CDF, and reach normalises to [0, 1].

    When the from-node has MC draws, completeness_sd is computed from
    the spread across draws (same principle as window-mode but with
    upstream uncertainty included).

    Args:
        edge_id: edge UUID.
        resolved: resolved model params from the promoted resolver.
        cohort_ages_and_weights: list of (age_days, n) tuples.
        from_node_arrival: NodeArrivalState from the per-node cache.
        evaluation_date, evidence_cutoff_date, posterior_cutoff_date: dates.
        evidence_rate: observed k/n if available.

    Returns:
        ForecastState with cohort-mode fields populated.
    """
    lat = resolved.latency
    p = resolved.p_mean

    upstream_cdf = from_node_arrival.deterministic_cdf
    upstream_mc = from_node_arrival.mc_cdf
    reach = from_node_arrival.reach

    # ── Upstream-aware completeness ──────────────────────────────
    # Analytical evaluation: for each cohort age τ, evaluate the
    # convolution of upstream arrival PDF with edge CDF.
    total_n = 0.0
    weighted_c = 0.0

    if upstream_cdf is not None and reach > 0:
        max_tau = len(upstream_cdf)
        for age_days, n in cohort_ages_and_weights:
            if n <= 0:
                continue
            c_tau = _convolve_completeness_at_age(
                age_days, upstream_cdf, reach,
                lat.mu, lat.sigma, lat.onset_delta_days,
            )
            weighted_c += n * c_tau
            total_n += n
    else:
        # No upstream: fall back to simple CDF (window-mode equivalent)
        for age_days, n in cohort_ages_and_weights:
            if n <= 0:
                continue
            c = _compute_completeness_at_age(
                age_days, lat.mu, lat.sigma, lat.onset_delta_days)
            weighted_c += n * c
            total_n += n

    completeness = weighted_c / total_n if total_n > 0 else 0.0

    # ── Completeness SD from joint MC draws ─────────────────────
    # Both upstream carrier uncertainty AND edge latency dispersions
    # contribute. For each draw, sample both the upstream CDF (from
    # carrier mc_cdf) and the edge params (mu, sigma, onset with SDs).
    completeness_sd = 0.0
    has_edge_dispersions = (lat.mu_sd > 0 or lat.sigma_sd > 0 or lat.onset_sd > 0)
    if (upstream_mc is not None or has_edge_dispersions) and total_n > 0:
        S = upstream_mc.shape[0] if upstream_mc is not None else _COMPLETENESS_SD_DRAWS
        rng = np.random.default_rng(seed=71)

        # Sample edge latency params (same correlated draw as window mode)
        if has_edge_dispersions:
            mu_draws = rng.normal(lat.mu, max(lat.mu_sd, 1e-10), size=S)
            if abs(lat.onset_mu_corr) > 1e-6 and lat.mu_sd > 0:
                rho = lat.onset_mu_corr
                onset_draws = (
                    lat.onset_delta_days
                    + rho * (max(lat.onset_sd, 1e-10) / max(lat.mu_sd, 1e-10)) * (mu_draws - lat.mu)
                    + rng.normal(0, max(lat.onset_sd, 1e-10) * math.sqrt(max(1 - rho * rho, 0)), size=S)
                )
            else:
                onset_draws = rng.normal(lat.onset_delta_days, max(lat.onset_sd, 1e-10), size=S)
            onset_draws = np.maximum(onset_draws, 0.0)
            sigma_draws = np.clip(
                rng.normal(lat.sigma, max(lat.sigma_sd, 1e-10), size=S), 0.01, 20.0)
        else:
            mu_draws = np.full(S, lat.mu)
            sigma_draws = np.full(S, lat.sigma)
            onset_draws = np.full(S, lat.onset_delta_days)

        mc_completeness = np.zeros(S)
        for s in range(S):
            # Upstream CDF for this draw (or deterministic if no MC)
            if upstream_mc is not None and s < upstream_mc.shape[0]:
                draw_cdf = upstream_mc[s].tolist()
            elif upstream_cdf is not None:
                draw_cdf = upstream_cdf
            else:
                draw_cdf = None

            wc = 0.0
            tn = 0.0
            for age_days, n in cohort_ages_and_weights:
                if n <= 0:
                    continue
                if draw_cdf is not None and reach > 0:
                    c_tau = _convolve_completeness_at_age(
                        age_days, draw_cdf, reach,
                        float(mu_draws[s]), float(sigma_draws[s]),
                        float(onset_draws[s]),
                    )
                else:
                    c_tau = _compute_completeness_at_age(
                        age_days, float(mu_draws[s]),
                        float(sigma_draws[s]), float(onset_draws[s]))
                wc += n * c_tau
                tn += n
            mc_completeness[s] = wc / tn if tn > 0 else 0.0
        completeness_sd = float(np.std(mc_completeness))

    # ── Rates ────────────────────────────────────────────────────
    rate_unconditioned = p * completeness
    rate_unconditioned_sd = _compose_rate_sd(p, resolved.p_sd,
                                             completeness, completeness_sd)

    if evidence_rate is not None and completeness > 0:
        model_rate = p * completeness
        rate_conditioned = (
            completeness * evidence_rate
            + (1 - completeness) * model_rate
        )
        rate_conditioned_sd = (1 - completeness) * rate_unconditioned_sd
    else:
        rate_conditioned = rate_unconditioned
        rate_conditioned_sd = rate_unconditioned_sd

    tau_observed = 0
    if total_n > 0 and cohort_ages_and_weights:
        tau_observed = int(round(
            sum(age * n for age, n in cohort_ages_and_weights) / total_n
        ))

    dispersions = Dispersions(
        p_sd=resolved.p_sd,
        mu_sd=lat.mu_sd,
        sigma_sd=lat.sigma_sd,
        onset_sd=lat.onset_sd,
    )

    return ForecastState(
        edge_id=edge_id,
        source=resolved.source,
        fitted_at=resolved.fitted_at,
        tier='be_forecast',
        evaluation_date=evaluation_date,
        evidence_cutoff_date=evidence_cutoff_date,
        posterior_cutoff_date=posterior_cutoff_date,
        completeness=completeness,
        completeness_sd=completeness_sd,
        rate_unconditioned=rate_unconditioned,
        rate_unconditioned_sd=rate_unconditioned_sd,
        rate_conditioned=rate_conditioned,
        rate_conditioned_sd=rate_conditioned_sd,
        tau_observed=tau_observed,
        dispersions=dispersions,
        mode='cohort',
        path_aware=True,
        resolved_params=resolved,
    )


def _convolve_completeness_at_age(
    age_days: float,
    upstream_cdf: List[float],
    reach: float,
    mu: float,
    sigma: float,
    onset: float,
) -> float:
    """Evaluate convolution of upstream arrival PDF with edge CDF at a single age.

    C(τ) = (1/reach) × Σ_u f_upstream(u) × CDF_edge(τ - u)

    Uses the deterministic upstream CDF (from the carrier hierarchy).
    The upstream CDF is already scaled by reach, so we normalise by
    reach to get completeness in [0, 1].

    This is the same operation as v2's effective exposure computation
    (Σ_u ΔX_x(u) × C(a_i - u)) but evaluated analytically against
    the carrier CDF rather than observed x_at_tau.
    """
    if reach <= 0 or age_days <= 0:
        return 0.0

    max_idx = min(int(age_days) + 1, len(upstream_cdf))
    conv = 0.0
    for u in range(max_idx):
        # PDF: incremental arrivals at upstream node at age u
        if u == 0:
            f_up = upstream_cdf[0] if upstream_cdf[0] > 0 else 0.0
        else:
            f_up = upstream_cdf[u] - upstream_cdf[u - 1]
        if f_up <= 0:
            continue
        # Edge CDF at remaining time
        remaining = age_days - u
        c_edge = _compute_completeness_at_age(remaining, mu, sigma, onset)
        conv += f_up * c_edge

    return min(conv / reach, 1.0)


def build_node_arrival_cache(
    graph: Dict[str, Any],
    anchor_id: str,
    max_tau: int = 400,
    num_draws: int = _COHORT_MC_DRAWS,
) -> Dict[str, NodeArrivalState]:
    """Build per-node arrival cache by walking the graph in topo order.

    At each node, calls the v2 carrier hierarchy (Tier 1/2/3) to
    compute the arrival CDF from upstream edges. The cache is keyed
    by node UUID.

    The anchor node gets a delta arrival (instant, reach=1.0).
    Each downstream node accumulates from its incoming edges.

    This is the per-node cache described in doc 29 §3.1.
    """
    from .cohort_forecast_v2 import build_upstream_carrier
    from .cohort_forecast import read_edge_cohort_params

    nodes = graph.get('nodes', [])
    edges = graph.get('edges', [])

    # Build adjacency
    incoming: Dict[str, List[Dict]] = {}
    for e in edges:
        to_id = e.get('to', '')
        if to_id not in incoming:
            incoming[to_id] = []
        incoming[to_id].append(e)

    # Find all node IDs
    node_ids = [n.get('uuid') or n.get('id', '') for n in nodes]

    # Topo sort (Kahn's)
    in_degree: Dict[str, int] = {nid: 0 for nid in node_ids}
    for e in edges:
        to_id = e.get('to', '')
        in_degree[to_id] = in_degree.get(to_id, 0) + 1

    queue = sorted([nid for nid in node_ids if in_degree.get(nid, 0) == 0])
    if anchor_id and anchor_id not in queue:
        queue.append(anchor_id)

    # Anchor arrival: instant (delta), reach=1.0
    # Deterministic CDF = [1.0, 1.0, ...] (everyone arrives at anchor instantly)
    anchor_cdf = [1.0] * (max_tau + 1)
    cache: Dict[str, NodeArrivalState] = {
        anchor_id: NodeArrivalState(
            deterministic_cdf=anchor_cdf,
            mc_cdf=np.tile(anchor_cdf, (num_draws, 1)),
            reach=1.0,
            tier='anchor',
        ),
    }

    # Track reach per node
    node_reach: Dict[str, float] = {anchor_id: 1.0}

    rng = np.random.default_rng(seed=42)

    visited = set()
    while queue:
        node_id = queue.pop(0)
        if node_id in visited:
            continue
        visited.add(node_id)

        # For non-anchor nodes: build carrier from incoming edges
        if node_id != anchor_id and node_id in incoming:
            inc_edges = incoming[node_id]
            # Collect upstream params from incoming edges
            upstream_params = []
            for ie in inc_edges:
                params = read_edge_cohort_params(ie)
                if params:
                    upstream_params.append(params)

            # Compute reach: sum of (upstream_reach × edge_p)
            reach = 0.0
            for ie in inc_edges:
                from_id = ie.get('from', '')
                edge_p = (ie.get('p') or {}).get('mean', 0.0) or 0.0
                reach += node_reach.get(from_id, 0.0) * max(0, edge_p)
            node_reach[node_id] = reach

            if upstream_params and reach > 0:
                det_cdf, mc_cdf, tier = build_upstream_carrier(
                    upstream_params_list=upstream_params,
                    upstream_obs=None,  # No per-cohort evidence at graph level
                    cohort_list=[],     # No cohort list at graph level
                    reach=reach,
                    is_window=False,    # Cohort mode
                    max_tau=max_tau,
                    num_draws=num_draws,
                    rng=rng,
                )
                cache[node_id] = NodeArrivalState(
                    deterministic_cdf=det_cdf,
                    mc_cdf=mc_cdf,
                    reach=reach,
                    tier=tier,
                )
            else:
                cache[node_id] = NodeArrivalState(reach=reach, tier='none')
        elif node_id != anchor_id:
            cache[node_id] = NodeArrivalState(reach=0.0, tier='none')

        # Advance topo sort
        for e in edges:
            if e.get('from', '') == node_id:
                to_id = e.get('to', '')
                in_degree[to_id] = in_degree.get(to_id, 0) - 1
                if in_degree[to_id] <= 0 and to_id not in visited:
                    queue.append(to_id)

    return cache


def _compute_weighted_completeness_sd(
    cohort_ages_and_weights: List[tuple],
    lat: ResolvedLatency,
) -> tuple:
    """Compute n-weighted completeness SD from latency dispersions (window-mode fallback)."""
    total_n = 0.0
    weighted_sd_sq = 0.0
    for age_days, n in cohort_ages_and_weights:
        if n <= 0:
            continue
        _, c_sd = compute_completeness_with_sd(float(age_days), lat)
        weighted_sd_sq += n * n * c_sd * c_sd
        total_n += n
    if total_n > 0:
        return (total_n, math.sqrt(weighted_sd_sq) / total_n)
    return (0.0, 0.0)
