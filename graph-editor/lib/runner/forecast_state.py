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

    C(τ) = Σ_u f_upstream(u) × CDF_edge(τ - u)

    The carrier CDF from build_upstream_carrier is conditional (goes to
    1.0, meaning "given you reach this node, probability of arriving by
    age u"). Its derivative f_upstream is a proper PDF (integrates to 1).

    The convolution gives the conditional path completeness: "of the
    eventual converters on this edge, what fraction have completed by
    age τ?" This matches v2's completeness annotation, which evaluates
    CDF(age, path_mu, path_sigma, path_onset) — also a conditional
    quantity going to 1.0.

    No reach scaling: completeness is x-denominated (y/x), not
    a-denominated (y/a). Reach affects absolute counts but not the
    rate at which observed conversions approach their asymptote.
    """
    if reach <= 0 or age_days <= 0:
        return 0.0

    max_idx = min(int(age_days) + 1, len(upstream_cdf))
    conv = 0.0
    for u in range(max_idx):
        # PDF: conditional incremental arrivals at upstream node at age u
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

    return min(conv, 1.0)


def _resolve_edge_p(edge: Dict[str, Any]) -> float:
    """Get edge probability from p.mean, model_vars, or posterior.

    On enriched synth graphs p.mean may be None (it's a topo-pass
    display quantity). Fall back to model_vars or posterior alpha/beta.
    """
    p_obj = edge.get('p') or {}
    # Direct flat value (production graphs after topo pass)
    mean = p_obj.get('mean')
    if isinstance(mean, (int, float)) and mean > 0:
        return float(mean)
    # model_vars (enriched graphs)
    for mv in (p_obj.get('model_vars') or []):
        prob = mv.get('probability') or {}
        mv_mean = prob.get('mean')
        if isinstance(mv_mean, (int, float)) and mv_mean > 0:
            return float(mv_mean)
    # posterior alpha/beta
    post = p_obj.get('posterior') or {}
    alpha = post.get('alpha')
    beta = post.get('beta')
    if alpha and beta and (alpha + beta) > 0:
        return float(alpha) / float(alpha + beta)
    return 0.0


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
                edge_p = _resolve_edge_p(ie)
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


# ═══════════════════════════════════════════════════════════════════════
# Conditioned forecast (doc 29g)
# ═══════════════════════════════════════════════════════════════════════

_IS_DRAWS = 2000


@dataclass
class ConditionedForecast:
    """Engine output with IS-conditioned draws.

    Point estimates are computed from the conditioned draws.
    The draw arrays are exposed for consumers that need quantiles
    (e.g. cohort maturity chart fan bands).
    """
    completeness: float = 0.0
    completeness_sd: float = 0.0
    rate_conditioned: float = 0.0      # p × C(age) — maturity-adjusted rate
    rate_conditioned_sd: float = 0.0
    p_conditioned: float = 0.0        # mean(p_draws) — asymptotic probability after IS
    p_conditioned_sd: float = 0.0
    rate_unconditioned: float = 0.0
    rate_unconditioned_sd: float = 0.0

    # Conditioned draws — consumers evaluate CDF at display τ values
    # using these pre-conditioned params to get fan bands.
    p_draws: np.ndarray = field(default_factory=lambda: np.array([]))
    mu_draws: np.ndarray = field(default_factory=lambda: np.array([]))
    sigma_draws: np.ndarray = field(default_factory=lambda: np.array([]))
    onset_draws: np.ndarray = field(default_factory=lambda: np.array([]))

    # Unconditioned draws (pre-IS) for model-only fan bands
    p_draws_unconditioned: np.ndarray = field(default_factory=lambda: np.array([]))
    mu_draws_unconditioned: np.ndarray = field(default_factory=lambda: np.array([]))
    sigma_draws_unconditioned: np.ndarray = field(default_factory=lambda: np.array([]))
    onset_draws_unconditioned: np.ndarray = field(default_factory=lambda: np.array([]))

    # Metadata
    source: str = ''
    mode: str = 'window'
    is_ess: float = 0.0  # effective sample size after IS
    is_tempering_lambda: float = 1.0  # aggregate likelihood tempering strength


def compute_conditioned_forecast(
    edge_id: str,
    resolved: ResolvedModelParams,
    cohort_ages_and_weights: List[tuple],
    evidence: List[tuple],               # [(τ_i, n_i, k_i), ...]
    from_node_arrival: Optional['NodeArrivalState'] = None,
    num_draws: int = _IS_DRAWS,
) -> ConditionedForecast:
    """Compute ESS-regularised aggregate IS-conditioned forecast.

    Draws (p, mu, sigma, onset) from the joint posterior, evaluates
    completeness at each cohort age per draw, applies IS conditioning
    against observed evidence, and returns conditioned draws + point
    estimates.

    The conditioned draws can be used by consumers to evaluate CDF
    at any display τ range without re-doing MC or IS conditioning.

    Args:
        edge_id: edge UUID.
        resolved: from resolve_model_params.
        cohort_ages_and_weights: [(age_days, n), ...] for completeness.
        evidence: [(τ_i, n_i, k_i), ...] for IS conditioning.
        from_node_arrival: upstream carrier (cohort mode).
        num_draws: MC draw count (default 2000 for IS).

    Returns:
        ConditionedForecast with point estimates and draw arrays.
    """
    lat = resolved.latency
    p_mean = resolved.p_mean
    S = num_draws
    rng = np.random.default_rng(seed=42)
    total_n = sum(n for _, n in cohort_ages_and_weights if n > 0)

    # ── Draw p from Beta posterior ───────────────────────────────
    alpha = resolved.alpha if resolved.alpha and resolved.alpha > 0 else 0.0
    beta_ = resolved.beta if resolved.beta and resolved.beta > 0 else 0.0
    if alpha <= 0 or beta_ <= 0:
        # No posterior available — construct a weak informative prior
        # centred on the forecast mean. Kappa=20 gives enough flexibility
        # for IS conditioning to move the draws, but prevents collapse
        # from a flat Beta(1,1) under sequential resampling.
        _KAPPA_DEFAULT = 20.0
        _p = max(min(p_mean or 0.5, 0.99), 0.01)
        alpha = _p * _KAPPA_DEFAULT
        beta_ = (1.0 - _p) * _KAPPA_DEFAULT
    p_draws = rng.beta(alpha, beta_, size=S)

    # ── Draw latency params (correlated mu-onset) ────────────────
    has_dispersions = (lat.mu_sd > 0 or lat.sigma_sd > 0 or lat.onset_sd > 0)
    if has_dispersions:
        mu_draws = rng.normal(lat.mu, max(lat.mu_sd, 1e-10), size=S)
        if abs(lat.onset_mu_corr) > 1e-6 and lat.mu_sd > 0:
            rho = lat.onset_mu_corr
            onset_draws = (
                lat.onset_delta_days
                + rho * (max(lat.onset_sd, 1e-10) / max(lat.mu_sd, 1e-10))
                * (mu_draws - lat.mu)
                + rng.normal(0, max(lat.onset_sd, 1e-10)
                             * math.sqrt(max(1 - rho * rho, 0)), size=S)
            )
        else:
            onset_draws = rng.normal(
                lat.onset_delta_days, max(lat.onset_sd, 1e-10), size=S)
        onset_draws = np.maximum(onset_draws, 0.0)
        sigma_draws = np.clip(
            rng.normal(lat.sigma, max(lat.sigma_sd, 1e-10), size=S),
            0.01, 20.0)
    else:
        mu_draws = np.full(S, lat.mu)
        sigma_draws = np.full(S, lat.sigma)
        onset_draws = np.full(S, lat.onset_delta_days)

    upstream_cdf = (from_node_arrival.deterministic_cdf
                    if from_node_arrival else None)
    reach = from_node_arrival.reach if from_node_arrival else 0.0

    def _cdf_at_age_for_draw(
        age: float,
        mu: float,
        sigma: float,
        onset: float,
    ) -> float:
        """Path-level completeness (with carrier convolution when available).

        Used for the output completeness estimate. NOT for IS conditioning
        — IS uses edge-level completeness because evidence is edge-level y/x.
        """
        if upstream_cdf is not None and reach > 0:
            return _convolve_completeness_at_age(
                age, upstream_cdf, reach,
                mu, sigma, onset)
        return _compute_completeness_at_age(
            age, mu, sigma, onset)

    def _edge_cdf_at_age_for_draw(
        age: float,
        mu: float,
        sigma: float,
        onset: float,
    ) -> float:
        """Edge-level completeness (no carrier convolution).

        Used for IS conditioning E_i computation. Evidence is edge-level
        y/x so the completeness must also be edge-level, regardless of
        whether a carrier exists.
        """
        return _compute_completeness_at_age(
            age, mu, sigma, onset)

    def _weighted_completeness_draws(
        mu_values: np.ndarray,
        sigma_values: np.ndarray,
        onset_values: np.ndarray,
    ) -> np.ndarray:
        mc_completeness = np.zeros(len(mu_values), dtype=float)
        if total_n <= 0:
            return mc_completeness

        for age, n in cohort_ages_and_weights:
            if n <= 0:
                continue
            age_f = float(age)
            for s in range(len(mu_values)):
                mc_completeness[s] += n * _cdf_at_age_for_draw(
                    age_f,
                    float(mu_values[s]),
                    float(sigma_values[s]),
                    float(onset_values[s]),
                )

        mc_completeness /= total_n
        return mc_completeness

    def _normalise_log_weights(log_weights: np.ndarray) -> Optional[np.ndarray]:
        if log_weights.size == 0:
            return None
        max_log_weight = float(np.max(log_weights))
        if not math.isfinite(max_log_weight):
            return None
        shifted = np.clip(log_weights - max_log_weight, -745.0, 0.0)
        weights = np.exp(shifted)
        weight_sum = float(np.sum(weights))
        if not math.isfinite(weight_sum) or weight_sum <= 0:
            return None
        return weights / weight_sum

    def _weights_and_ess(
        log_likelihood: np.ndarray,
        tempering_lambda: float,
    ) -> tuple[Optional[np.ndarray], float]:
        weights = _normalise_log_weights(log_likelihood * tempering_lambda)
        if weights is None:
            return (None, 0.0)
        ess = float(1.0 / np.sum(np.square(weights)))
        return (weights, ess)

    # Preserve the true pre-evidence baseline. Downstream consumers use
    # this to compare conditioned vs unconditioned forecasts.
    p_draws_unconditioned = p_draws.copy()
    mu_draws_unconditioned = mu_draws.copy()
    sigma_draws_unconditioned = sigma_draws.copy()
    onset_draws_unconditioned = onset_draws.copy()
    mc_completeness_unconditioned = _weighted_completeness_draws(
        mu_draws_unconditioned,
        sigma_draws_unconditioned,
        onset_draws_unconditioned,
    )

    # ── IS conditioning against evidence (doc 29g §aggregate IS) ────
    # Aggregate IS: compute log-likelihood across ALL cohorts
    # simultaneously, then resample once with tempering to maintain
    # ESS ≥ target. This replaces the sequential per-cohort resampling
    # which collapsed draws over 200+ cohorts.
    #
    # Per draw s, the aggregate log-likelihood is:
    #   log w_s = Σ_i [ k_i × log(p_s) + (E_i,s - k_i) × log(1 - p_s) ]
    # where E_i,s = n_i × CDF_s(τ_i) is the effective exposure for
    # cohort i under latency draw s.
    _IS_TARGET_ESS = 20.0
    is_ess = float(S)
    is_tempering_lambda = 1.0
    n_cohorts_conditioned = 0
    if evidence:
        # Accumulate aggregate log-likelihood across all cohorts
        log_lik = np.zeros(S)
        for tau_i, n_i, k_i in evidence:
            if n_i <= 0 or k_i < 0:
                continue

            # E_i per draw: effective exposure at this cohort's age.
            # Uses _cdf_at_age_for_draw which is path-level (with
            # carrier convolution) in cohort mode — correct because
            # evidence ages are anchor-relative and E_i must reflect
            # the fraction of anchor entrants who have had time to
            # reach AND convert at this edge by age τ.
            E_i = np.zeros(S)
            for s in range(S):
                c_s = _cdf_at_age_for_draw(
                    float(tau_i),
                    float(mu_draws[s]),
                    float(sigma_draws[s]),
                    float(onset_draws[s]),
                )
                E_i[s] = n_i * c_s

            E_eff = np.maximum(E_i, float(k_i))
            E_fail = E_eff - float(k_i)

            # Only include cohorts with meaningful failure count
            mask = E_fail >= 1.0
            if not mask.any():
                continue

            p_clip = np.clip(p_draws, 1e-15, 1 - 1e-15)
            # Accumulate per-cohort contribution to aggregate likelihood
            cohort_log_w = np.where(
                mask,
                float(k_i) * np.log(p_clip) + E_fail * np.log(1 - p_clip),
                0.0,
            )
            log_lik += cohort_log_w
            n_cohorts_conditioned += 1

        if n_cohorts_conditioned > 0:
            # Tempered resampling: binary search for λ ∈ [0, 1] such
            # that ESS(Lik^λ) ≥ target (doc 29g §4).
            lo, hi = 0.0, 1.0
            best_w, best_ess, best_lam = None, 0.0, 0.0
            for _ in range(20):  # bisection iterations
                mid = (lo + hi) / 2.0
                w, ess = _weights_and_ess(log_lik, mid)
                if w is not None and ess >= _IS_TARGET_ESS:
                    best_w, best_ess, best_lam = w, ess, mid
                    lo = mid  # try stronger tempering
                else:
                    hi = mid  # back off
            # Try full strength (λ=1)
            w_full, ess_full = _weights_and_ess(log_lik, 1.0)
            if w_full is not None and ess_full >= _IS_TARGET_ESS:
                best_w, best_ess, best_lam = w_full, ess_full, 1.0

            if best_w is not None and best_ess >= _IS_TARGET_ESS:
                indices = rng.choice(S, size=S, replace=True, p=best_w)
                p_draws = p_draws[indices]
                mu_draws = mu_draws[indices]
                sigma_draws = sigma_draws[indices]
                onset_draws = onset_draws[indices]
                is_ess = best_ess
                is_tempering_lambda = best_lam

    # ── Compute point estimates from conditioned draws ───────────
    mc_completeness = _weighted_completeness_draws(
        mu_draws,
        sigma_draws,
        onset_draws,
    )
    completeness = float(np.mean(mc_completeness)) if mc_completeness.size else 0.0
    completeness_sd = float(np.std(mc_completeness)) if mc_completeness.size else 0.0

    # rate_unconditioned: the prior asymptotic edge probability
    # (before IS conditioning). Used by surprise gauge as baseline.
    rate_unconditioned = (
        float(np.mean(p_draws_unconditioned))
        if p_draws_unconditioned.size else 0.0
    )
    rate_unconditioned_sd = (
        float(np.std(p_draws_unconditioned))
        if p_draws_unconditioned.size else 0.0
    )

    # rate_conditioned: the IS-conditioned asymptotic edge probability.
    # This is mean(p_draws) after IS resampling — the posterior estimate
    # of the true edge rate given evidence. NOT p × completeness.
    # Completeness is a separate orthogonal output.
    rate_conditioned = float(np.mean(p_draws)) if p_draws.size else 0.0
    rate_conditioned_sd = float(np.std(p_draws)) if p_draws.size else 0.0

    # Legacy alias — same value, kept for clarity at call sites
    p_conditioned = rate_conditioned
    p_conditioned_sd = rate_conditioned_sd

    return ConditionedForecast(
        completeness=completeness,
        completeness_sd=completeness_sd,
        rate_conditioned=rate_conditioned,
        rate_conditioned_sd=rate_conditioned_sd,
        p_conditioned=p_conditioned,
        p_conditioned_sd=p_conditioned_sd,
        rate_unconditioned=rate_unconditioned,
        rate_unconditioned_sd=rate_unconditioned_sd,
        p_draws=p_draws,
        mu_draws=mu_draws,
        sigma_draws=sigma_draws,
        onset_draws=onset_draws,
        p_draws_unconditioned=p_draws_unconditioned,
        mu_draws_unconditioned=mu_draws_unconditioned,
        sigma_draws_unconditioned=sigma_draws_unconditioned,
        onset_draws_unconditioned=onset_draws_unconditioned,
        source=resolved.source,
        mode='cohort' if from_node_arrival else 'window',
        is_ess=is_ess,
        is_tempering_lambda=is_tempering_lambda,
    )


# ═══════════════════════════════════════════════════════════════════════
# Per-cohort population model sweep (v2 parity)
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class CohortEvidence:
    """Per-cohort evidence for the population model sweep.

    Each cohort is one anchor-day's worth of evidence: observed x/y
    trajectories up to the frontier age, plus frozen frontier values.
    """
    obs_x: List[float]     # x at each τ from 0..frontier_age
    obs_y: List[float]     # y at each τ from 0..frontier_age
    x_frozen: float        # N_i — x at frontier
    y_frozen: float        # k_i — y at frontier
    frontier_age: int      # a_i — last observed age (days)
    a_pop: float           # population for upstream scaling


@dataclass
class ForecastSweepResult:
    """Output of the per-cohort population model sweep.

    rate_draws (S, T) is the per-draw aggregate rate at each τ.
    Consumers take quantiles for midpoint/fan bands.
    model_rate_draws (S, T) is the unconditioned equivalent (for
    model-only bands).
    """
    rate_draws: np.ndarray           # (S, T) conditioned
    model_rate_draws: np.ndarray     # (S, T) unconditioned
    # Deterministic totals (median across draws) for forecast_y/forecast_x
    det_y_total: Optional[np.ndarray] = None  # (T,) median Y across draws
    det_x_total: Optional[np.ndarray] = None  # (T,) median X across draws
    is_ess: float = 0.0
    n_cohorts_conditioned: int = 0


# Default draw count for the sweep — same as v2's MC_SAMPLES.
_SWEEP_DRAWS = 2000
_SWEEP_DRIFT_FRACTION = 0.20


def compute_forecast_sweep(
    resolved: ResolvedModelParams,
    cohorts: List[CohortEvidence],
    max_tau: int,
    from_node_arrival: Optional[NodeArrivalState] = None,
    num_draws: int = _SWEEP_DRAWS,
    mc_cdf_arr: Optional[np.ndarray] = None,
    mc_p_s: Optional[np.ndarray] = None,
    span_alpha: Optional[float] = None,
    span_beta: Optional[float] = None,
    span_mu_sd: Optional[float] = None,
    span_sigma_sd: Optional[float] = None,
    span_onset_sd: Optional[float] = None,
    span_onset_mu_corr: Optional[float] = None,
    det_norm_cdf: Optional[list] = None,
) -> ForecastSweepResult:
    """Per-cohort population model sweep — generalised from v2.

    Reproduces cohort_forecast_v2.py lines 796-912. For each draw,
    for each cohort, for each τ:

    - τ ≤ a_i: use observed (obs_y, obs_x) — evidence splice
    - τ > a_i: forecast Pop D (frontier survivors) + Pop C (upstream)
    - Accumulate Y_total, X_total across cohorts

    Returns rate_draws (S, T) = Y_total / X_total for quantile
    extraction by consumers.

    Also returns model_rate_draws (S, T) — same computation without
    IS conditioning, for unconditioned model-only fan bands.

    Args:
        resolved: from resolve_model_params (edge-level params).
        cohorts: per-cohort evidence with obs_x/obs_y trajectories.
        max_tau: display τ range (0..max_tau inclusive).
        from_node_arrival: upstream carrier (cohort mode only).
        num_draws: MC draw count.
    """
    from scipy.special import logit as _logit, expit as _expit

    lat = resolved.latency
    S = num_draws
    T = max_tau + 1
    rng = np.random.default_rng(seed=42)

    if lat.sigma <= 0:
        empty = np.zeros((S, T))
        return ForecastSweepResult(rate_draws=empty, model_rate_draws=empty)

    # ── Draw from posterior ───────────────────────────────────────
    # Draw all params in one interleaved call, matching v2's mc_span_cdfs
    # (span_kernel.py:442) which draws (S, n_edges, 4) in a single
    # rng.normal() call. Numpy generates different sequences for one
    # (S,1,4) call vs four (S,) calls, so the interleaving matters for
    # RNG-stream parity.
    alpha = resolved.alpha if resolved.alpha and resolved.alpha > 0 else 1.0
    beta_ = resolved.beta if resolved.beta and resolved.beta > 0 else 1.0
    _p_mean = alpha / (alpha + beta_)
    _p_sd = math.sqrt(alpha * beta_ / ((alpha + beta_) ** 2 * (alpha + beta_ + 1)))

    # ── Use pre-computed draws if provided (parity with mc_span_cdfs) ─
    if mc_cdf_arr is not None and mc_p_s is not None:
        # mc_span_cdfs produces (S, T) normalised CDF and (S,) p values.
        # Use these directly — they include the discrete normalisation
        # that the DP uses, ensuring numerical parity with v2.
        cdf_arr = np.clip(mc_cdf_arr[:S, :T], 0.0, 1.0)
        p_draws = np.clip(mc_p_s[:S], 1e-6, 1 - 1e-6)
        mu_draws = np.full(S, lat.mu)
        sigma_draws = np.full(S, lat.sigma)
        onset_draws = np.full(S, lat.onset_delta_days)
    else:
        has_dispersions = (lat.mu_sd > 0 or lat.sigma_sd > 0 or lat.onset_sd > 0)
        if has_dispersions:
            # Use multivariate_normal with onset_mu_corr (matching v1's
            # fan computation in cohort_forecast.py:741). Independent
            # draws produce systematically wider fans because onset and
            # mu are typically anticorrelated.
            _means_4 = np.array([_p_mean, lat.mu, lat.sigma, lat.onset_delta_days])
            _sds_4 = np.array([_p_sd, max(lat.mu_sd, 1e-10),
                               max(lat.sigma_sd, 1e-10), max(lat.onset_sd, 1e-10)])
            _cov = np.diag(_sds_4 ** 2)
            # onset–mu correlation (off-diagonal)
            _cov[3, 1] = _cov[1, 3] = lat.onset_mu_corr * _sds_4[3] * _sds_4[1]
            _draws = rng.multivariate_normal(_means_4, _cov, size=S)
            p_draws = np.clip(_draws[:, 0], 1e-6, 1 - 1e-6)
            mu_draws = _draws[:, 1]
            sigma_draws = np.clip(_draws[:, 2], 0.01, 20.0)
            onset_draws = np.maximum(_draws[:, 3], 0.0)
        else:
            _means = np.array([[_p_mean, lat.mu, lat.sigma, lat.onset_delta_days]])
            _sds = np.array([[_p_sd, 0.0, 0.0, 0.0]])
            _draws = rng.normal(
                loc=_means[None, :, :],
                scale=_sds[None, :, :],
                size=(S, 1, 4),
            )
            p_draws = np.clip(_draws[:, 0, 0], 1e-6, 1 - 1e-6)
            mu_draws = np.full(S, lat.mu)
            sigma_draws = np.full(S, lat.sigma)
            onset_draws = np.full(S, lat.onset_delta_days)

        # ── Build per-draw CDF array (S, T) ──────────────────────────
        # Edge-level CDF only — no carrier convolution here. v2 keeps
        # the carrier separate (used only in Pop C). Convolving it into
        # cdf_arr would double-count upstream arrivals.
        cdf_arr = np.zeros((S, T))
        for s in range(S):
            for t in range(T):
                cdf_arr[s, t] = _compute_completeness_at_age(
                        float(t), float(mu_draws[s]), float(sigma_draws[s]),
                        float(onset_draws[s]))

    # ── Deterministic CDF for E_i computation ────────────────────
    # Use span-level normalised CDF when provided (multi-hop parity).
    # v2 uses sp.C (normalised span kernel CDF) for E_i, not edge-level.
    if det_norm_cdf is not None and len(det_norm_cdf) >= T:
        det_cdf = list(det_norm_cdf[:T])
    else:
        det_cdf = [_compute_completeness_at_age(
            float(t), lat.mu, lat.sigma, lat.onset_delta_days)
            for t in range(T)]

    # ── Drift setup (v2 lines 731-747) ───────────────────────────
    # Use span-level alpha/beta when provided (multi-hop parity).
    _drift_alpha = span_alpha if span_alpha and span_alpha > 0 else alpha
    _drift_beta = span_beta if span_beta and span_beta > 0 else beta_
    _p_clamp = max(min(_drift_alpha / (_drift_alpha + _drift_beta), 0.99), 0.01)
    _p_sd = math.sqrt(_drift_alpha * _drift_beta / (
        (_drift_alpha + _drift_beta) ** 2 * (_drift_alpha + _drift_beta + 1)))
    _p_var_logit = _p_sd ** 2 / (_p_clamp * (1 - _p_clamp)) ** 2
    # Use span-level SDs when provided (v2 parity for multi-hop)
    _eff_mu_sd = span_mu_sd if span_mu_sd and span_mu_sd > 0 else lat.mu_sd
    _eff_sigma_sd = span_sigma_sd if span_sigma_sd and span_sigma_sd > 0 else lat.sigma_sd
    _eff_onset_sd = span_onset_sd if span_onset_sd and span_onset_sd > 0 else lat.onset_sd
    _mu_var = _eff_mu_sd ** 2 if _eff_mu_sd > 0 else 0.01 ** 2
    _sigma_var_log = (_eff_sigma_sd / max(lat.sigma, 0.01)) ** 2 \
        if _eff_sigma_sd > 0 else 0.01 ** 2
    _onset_var_log1p = (_eff_onset_sd / max(1 + lat.onset_delta_days, 1.0)) ** 2 \
        if _eff_onset_sd > 0 else 0.01 ** 2
    drift_sds = np.sqrt(_SWEEP_DRIFT_FRACTION * np.array([
        _p_var_logit, _mu_var, _sigma_var_log, _onset_var_log1p,
    ]))

    # Transform draws to unconstrained space.
    # v2 uses CONSTANT mu/sigma/onset in theta_transformed (the per-draw
    # CDF variation is already in cdf_arr from mc_span_cdfs). Match that:
    # only p varies per draw in theta_transformed; latency params are fixed.
    theta_transformed = np.column_stack([
        _logit(np.clip(p_draws, 1e-10, 1 - 1e-10)),
        np.full(S, lat.mu),
        np.log(np.maximum(np.full(S, lat.sigma), 0.01)),
        np.log1p(np.maximum(np.full(S, lat.onset_delta_days), 0.0)),
    ])

    # ── Upstream MC CDF (cohort mode only) ───────────────────────
    upstream_cdf_mc = None
    if from_node_arrival is not None and from_node_arrival.mc_cdf is not None:
        upstream_cdf_mc = from_node_arrival.mc_cdf[:S, :T]
    elif from_node_arrival is not None and from_node_arrival.deterministic_cdf is not None:
        _det = np.array(from_node_arrival.deterministic_cdf[:T])
        upstream_cdf_mc = np.tile(_det, (S, 1))

    reach = from_node_arrival.reach if from_node_arrival else 0.0

    # ── Per-cohort population model (v2 lines 800-912) ───────────
    def _run_cohort_loop(apply_is: bool) -> np.ndarray:
        """Run the per-cohort loop, optionally with IS conditioning.

        When apply_is=False, produces the unconditioned model forecast.
        When apply_is=True, produces the IS-conditioned forecast.

        Uses a fresh rng(42) for drift + IS resampling, matching v2's
        per-cohort loop (cohort_forecast_v2.py:720) which creates its
        own rng(42) independent of mc_span_cdfs' rng.
        """
        _loop_rng = np.random.default_rng(seed=42)
        Y_total = np.zeros((S, T))
        X_total = np.zeros((S, T))
        _is_ess_last = float(S)
        _n_conditioned = 0

        for cohort in cohorts:
            N_i = cohort.x_frozen
            k_i = cohort.y_frozen
            a_i = cohort.frontier_age
            a_pop = cohort.a_pop

            if N_i <= 0 and a_pop <= 0:
                continue

            a_idx = min(a_i, T - 1)

            # E_i from obs_x trajectory (v2 lines 818-830)
            E_i = 0.0
            if cohort.obs_x and a_i > 0:
                prev_x = 0.0
                for u in range(min(a_i + 1, len(cohort.obs_x))):
                    dx = cohort.obs_x[u] - prev_x
                    prev_x = cohort.obs_x[u]
                    lag = a_i - u
                    c_val = det_cdf[min(lag, T - 1)]
                    E_i += max(dx, 0.0) * c_val
            else:
                E_i = float(N_i)
            E_i = min(E_i, float(N_i))

            # Per-cohort drift (v2 lines 833-835)
            delta_i = _loop_rng.normal(0.0, drift_sds, size=(S, 4))
            theta_i = theta_transformed + delta_i
            p_i = _expit(theta_i[:, 0])
            # Drift only affects p, not CDF (v2 line 839)
            cdf_i = cdf_arr.copy()

            # IS conditioning (v2 lines 841-861)
            if apply_is:
                E_eff = max(E_i, k_i)
                _E_fail = E_eff - k_i
                # v2 resamples unconditionally (no ESS guard) whenever
                # there is meaningful evidence. Match that behaviour.
                if E_eff > 0 and a_i > 0 and _E_fail >= 1.0:
                    p_i_clip = np.clip(p_i, 1e-15, 1 - 1e-15)
                    log_w_i = (k_i * np.log(p_i_clip)
                               + _E_fail * np.log(1 - p_i_clip))
                    log_w_i -= np.max(log_w_i)
                    w_i = np.exp(log_w_i)
                    w_i /= w_i.sum()
                    resample_idx = _loop_rng.choice(S, size=S,
                                              replace=True, p=w_i)
                    p_i = p_i[resample_idx]
                    cdf_i = cdf_i[resample_idx]
                    _is_ess_last = 1.0 / np.sum((w_i) ** 2)
                    _n_conditioned += 1

            # Pop D: frontier survivors (v2 lines 863-886)
            cdf_at_a = cdf_i[:, a_idx]
            remaining = max(N_i - k_i, 0.0)
            q_early = p_i[:, None] * cdf_at_a[:, None]
            q_early = np.clip(q_early, 0.0, 1 - 1e-10)
            remaining_cdf = np.maximum(cdf_i - cdf_at_a[:, None], 0.0)
            q_late = (p_i[:, None] * remaining_cdf) / (1 - q_early)
            q_late = np.clip(q_late, 0.0, 1.0)
            # v2 default is binomial sampling (display_settings.continuous_forecast)
            Y_D = _loop_rng.binomial(int(remaining), q_late)

            # Pop C: post-frontier upstream arrivals (v2 lines 888-898)
            X_C = np.zeros((S, T), dtype=np.float64)
            Y_C = np.zeros((S, T), dtype=np.float64)
            if upstream_cdf_mc is not None and reach > 0:
                _up_scaled = a_pop * reach * upstream_cdf_mc
                _up_at_frontier = _up_scaled[:, a_idx:a_idx + 1]
                X_C = np.maximum(_up_scaled - _up_at_frontier, 0.0)
                model_rate = p_i[:, None] * cdf_i
                model_rate = np.clip(model_rate, 0.0, 1.0)
                Y_C = X_C * model_rate

            # Combine (v2 lines 900-903)
            X_forecast = float(N_i) + X_C
            Y_forecast = float(k_i) + Y_D.astype(np.float64) + Y_C
            Y_forecast = np.clip(Y_forecast, float(k_i), X_forecast)

            # Splice observed/forecast (v2 lines 905-909)
            _obs_x_len = len(cohort.obs_x)
            _obs_y_len = len(cohort.obs_y)
            obs_x_padded = np.zeros(T)
            obs_y_padded = np.zeros(T)
            obs_x_padded[:min(_obs_x_len, T)] = cohort.obs_x[:T]
            obs_y_padded[:min(_obs_y_len, T)] = cohort.obs_y[:T]
            # Extend obs beyond trajectory length with frontier value
            if _obs_x_len < T:
                obs_x_padded[_obs_x_len:] = cohort.x_frozen
            if _obs_y_len < T:
                obs_y_padded[_obs_y_len:] = cohort.y_frozen

            tau_grid = np.arange(T, dtype=float)
            mature_mask = tau_grid <= a_i
            Y_cohort = np.where(mature_mask[None, :],
                                obs_y_padded[None, :], Y_forecast)
            X_cohort = np.where(mature_mask[None, :],
                                obs_x_padded[None, :], X_forecast)

            Y_total += Y_cohort
            X_total += X_cohort

        # Rate draws (v2 lines 914-920)
        X_safe = np.maximum(X_total, 1e-10)
        rate = Y_total / X_safe

        # Diagnostic: median Y/X at a few τ values for parity debugging
        if len(cohorts) > 0:
            _ym = np.median(Y_total, axis=0)
            _xm = np.median(X_total, axis=0)
            _taus = [t for t in [5, 10, 15, 20, 25, 30, 35, 40] if t < T]
            _diag = " ".join(f"t{t}:Y={_ym[t]:.1f}/X={_xm[t]:.1f}" for t in _taus)
            print(f"[sweep_diag] apply_is={apply_is} {_diag}")

        # Fallback when no evidence (v2 line 920)
        _x_median = np.median(X_total, axis=0)
        if not np.any(_x_median >= 1.0):
            rate = p_draws[:S, None] * cdf_arr[:S]

        return rate, _is_ess_last, _n_conditioned, Y_total, X_total

    rate_conditioned, is_ess, n_conditioned, Y_cond, X_cond = _run_cohort_loop(apply_is=True)
    # Model rate: pure p × CDF, no evidence splice or population model.
    # Matches v2's rate_model = p_s × cdf_arr (span_kernel.py:951).
    rate_model = p_draws[:S, None] * cdf_arr[:S]

    # Deterministic totals: median across conditioned draws
    _det_y = np.median(Y_cond, axis=0)
    _det_x = np.median(X_cond, axis=0)

    return ForecastSweepResult(
        rate_draws=rate_conditioned,
        model_rate_draws=rate_model,
        det_y_total=_det_y,
        det_x_total=_det_x,
        is_ess=is_ess,
        n_cohorts_conditioned=n_conditioned,
    )
