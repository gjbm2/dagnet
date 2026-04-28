"""
ForecastState — generalised forecast engine output contract.

Produced per edge per subject. Consumers read from this rather than
independently computing completeness, rate, and dispersions.

See doc 29 §ForecastState Contract.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .forecast_runtime import PreparedForecastRuntimeBundle, serialise_runtime_bundle
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
    source: str = ''              # 'analytic' | 'bayesian' (doc 73b §3.1 — 'manual' retired)
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


def _normalise_log_weights(log_weights: np.ndarray) -> Optional[np.ndarray]:
    """Convert a vector of log-weights into normalised weights.

    Returns None when the input is empty or numerically degenerate
    (non-finite max, or zero/non-finite sum after exponentiation).
    Used by the aggregate tempered IS step in `compute_forecast_trajectory`.
    """
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
) -> Tuple[Optional[np.ndarray], float]:
    """Tempered weights and ESS for a given log-likelihood vector.

    Used by the aggregate tempered-IS bisection step in
    `compute_forecast_trajectory` (replaces the per-cohort sequential IS
    that previously lived inside `_evaluate_cohort`).
    """
    weights = _normalise_log_weights(log_likelihood * tempering_lambda)
    if weights is None:
        return (None, 0.0)
    ess = float(1.0 / np.sum(np.square(weights)))
    return (weights, ess)


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
# Cohort-mode upstream arrival state
# ═══════════════════════════════════════════════════════════════════════

_COHORT_MC_DRAWS = 2000


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


_LEGACY_PMEAN_CARRIER_WARNED: set = set()


def _warn_legacy_pmean_carrier(edge: Dict[str, Any], context: str = '') -> None:
    """One-line warning when a carrier read falls back to legacy `p.mean`.

    Doc 73b §6.5 requires carrier consumers to read the promoted-baseline
    model probability via `resolve_model_params`, never the L5
    current-answer scalar `p.mean`. The fallback below is a documented,
    transitional degrade for pre-Stage 4 graphs / synthetic fixtures that
    have only `p.mean` populated — no `model_vars`, no `posterior`, no
    `forecast.mean`. To be removed once all fixtures populate the
    promoted layer (cf. §3.8 fallback register).
    """
    edge_id = edge.get('id') or edge.get('uuid') or '?'
    key = (edge_id, context)
    if key in _LEGACY_PMEAN_CARRIER_WARNED:
        return
    _LEGACY_PMEAN_CARRIER_WARNED.add(key)
    logging.getLogger(__name__).warning(
        "doc 73b §6.5: edge %r%s falling back to legacy p.mean for carrier "
        "read (no promoted-baseline model — check FE topo / applyPromotion)",
        edge_id,
        f' [{context}]' if context else '',
    )


def _resolve_edge_p(edge: Dict[str, Any]) -> float:
    """Resolve carrier probability via the shared resolver (doc 73b §6.5).

    Carriers MUST read the promoted-baseline model probability through
    `resolve_model_params`, not the L5 current-answer scalar `p.mean`
    (the §3.3.3 layer-isolation invariant — changing only a current
    query-owned scalar must not alter carrier behaviour).

    The fallback to legacy `p.mean` (with one-line WARNING log) is the
    §3.8 documented degrade for pre-Stage 4 graphs / synthetic fixtures
    that lack a promoted-baseline source. Provenance:
    `_warn_legacy_pmean_carrier`. Owner: Stage 4(d) transition.
    """
    from .model_resolver import resolve_model_params

    result = resolve_model_params(edge, scope='edge', temporal_mode='window')
    if result is not None and result.p_mean > 0:
        return float(result.p_mean)
    # Documented fallback (§3.8 register): legacy p.mean only as last
    # resort, with a logged warning so the offending edge surfaces.
    p_obj = edge.get('p') or {}
    legacy = p_obj.get('mean')
    if isinstance(legacy, (int, float)) and legacy > 0:
        _warn_legacy_pmean_carrier(edge, context='_resolve_edge_p')
        return float(legacy)
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
    from .forecast_runtime import build_upstream_carrier, read_edge_cohort_params

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


# ═══════════════════════════════════════════════════════════════════════
# Per-cohort population model sweep (v2 parity)
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class CohortEvidence:
    """Per-cohort evidence for the population model sweep.

    Each cohort is one anchor-day's worth of evidence: observed x/y
    trajectories up to the frontier age, plus frozen frontier values.

    Coordinate B (per-cohort evaluation at a specific date):
    Set anchor_day + eval_date and the engine computes eval_age
    internally. Or set eval_age directly for consumers that work
    in τ coordinates (cohort maturity chart).
    """
    obs_x: List[float]     # x at each τ from 0..frontier_age
    obs_y: List[float]     # y at each τ from 0..frontier_age
    x_frozen: float        # N_i — x at frontier
    y_frozen: float        # k_i — y at frontier
    frontier_age: int      # a_i — last observed age (days)
    a_pop: float           # population for upstream scaling
    # Subject-rate evidence counts for IS/blend. In cohort mode with a
    # real carrier, x_frozen/y_frozen may be carrier-projected population
    # state; these fields remain the raw subject evidence counts.
    evidence_n: Optional[float] = None
    evidence_k: Optional[float] = None
    eval_age: Optional[int] = None  # coordinate B: τᵢ at which to
    # stash per-cohort draws. When set, the sweep retains (S,) draws
    # at this column for this cohort. When None (cohort maturity),
    # no per-cohort stashing — only aggregate Y_total/X_total.
    anchor_day: Optional[str] = None   # ISO date string (e.g. '2026-03-07')
    eval_date: Optional[str] = None    # ISO date string — asat or today

    def __post_init__(self):
        """Compute eval_age from anchor_day + eval_date when not set."""
        if self.evidence_n is None:
            self.evidence_n = self.x_frozen
        if self.evidence_k is None:
            self.evidence_k = self.y_frozen
        if self.eval_age is None and self.anchor_day and self.eval_date:
            from datetime import date as _date
            try:
                a = _date.fromisoformat(str(self.anchor_day)[:10])
                e = _date.fromisoformat(str(self.eval_date)[:10])
                age = (e - a).days
                if age >= 0:
                    self.eval_age = age
            except (ValueError, TypeError):
                pass


@dataclass
class CohortForecastAtEval:
    """Coordinate B output for a single cohort at its eval_age.

    Retained by the sweep when CohortEvidence.eval_age is set.
    Consumers (daily conversions, topo pass) read per-cohort
    forecast values from these without re-running the MC.
    """
    y_draws: np.ndarray    # (S,) Y at eval_age per draw
    x_draws: np.ndarray    # (S,) X at eval_age per draw
    eval_age: int          # τᵢ this was evaluated at
    conditioned: bool      # whether IS fired for this cohort


@dataclass
class ForecastTrajectory:
    """Output of the per-cohort population model sweep.

    Coordinate A: rate_draws (S, T) is the per-draw aggregate rate
    at each τ. Consumers take quantiles for midpoint/fan bands.
    model_rate_draws (S, T) is the unconditioned equivalent.

    Coordinate B: cohort_evals is a list of per-cohort draws at each
    cohort's eval_age (when CohortEvidence.eval_age was set). Empty
    for pure coordinate A consumers (cohort maturity chart).
    """
    rate_draws: np.ndarray           # (S, T) conditioned — coord A
    model_rate_draws: np.ndarray     # (S, T) unconditioned — coord A
    # Coordinate A totals (median across draws)
    det_y_total: Optional[np.ndarray] = None  # (T,) median Y across draws
    det_x_total: Optional[np.ndarray] = None  # (T,) median X across draws
    is_ess: float = 0.0
    n_cohorts_conditioned: int = 0
    # Coordinate B per-cohort output (populated when eval_age is set)
    cohort_evals: Optional[List[CohortForecastAtEval]] = None
    # Blended completeness: n-weighted CDF at each cohort's eval_age,
    # with posterior uncertainty on (mu, sigma, onset). Populated when
    # any cohort has eval_age set (coordinate B consumers: topo pass,
    # asat, daily conversions).
    completeness_mean: Optional[float] = None
    completeness_sd: Optional[float] = None
    # Unconditioned (pre-IS) twins of `completeness_mean` and the
    # posterior-predictive unconditioned rate p × c̄. Populated whenever
    # `completeness_mean` is. Surprise gauge (doc 55) uses these as the
    # "model baseline" against which the conditioned moments are scored.
    completeness_unconditioned: Optional[float] = None
    completeness_unconditioned_sd: Optional[float] = None
    pp_rate_unconditioned: Optional[float] = None
    pp_rate_unconditioned_sd: Optional[float] = None
    # Conditioned per-particle draws (post-IS reindexing). Consumers
    # needing the prior-predictive samples should use the
    # *_unconditioned scalars above rather than re-deriving from these.
    p_draws: Optional[np.ndarray] = None          # (S,)
    mu_draws: Optional[np.ndarray] = None         # (S,)
    sigma_draws: Optional[np.ndarray] = None      # (S,)
    onset_draws: Optional[np.ndarray] = None      # (S,)
    # Forensic diagnostic (temporary)
    _forensic: Optional[Dict[str, Any]] = None
    # Subset-conditioning blend provenance (doc 52 §14.6). When
    # blend_applied=True, rate_draws / Y_total / X_total / cohort_evals
    # all reflect the (1 − r):r mix of conditioned and unconditioned
    # draws computed at engine return time.
    r: Optional[float] = None
    m_S: Optional[float] = None
    m_G: Optional[float] = None
    blend_applied: bool = False
    blend_skip_reason: Optional[str] = None
    runtime_bundle_diag: Optional[Dict[str, Any]] = None


# Default draw count for the sweep — same as v2's MC_SAMPLES.
_SWEEP_DRAWS = 2000
# Temporary forensic stash — last sweep's forensic data.
_last_forensic: Optional[Dict[str, Any]] = None
_SWEEP_DRIFT_FRACTION = 0.20

# Subset-conditioning blend (doc 52) — seeded independently of the
# existing seed=42 streams used for MC/IS so the permutation is
# reproducible without perturbing anything else.
_BLEND_SEED = 43


def _compute_blend_params(
    resolved,
    m_S: float,
) -> Dict[str, Any]:
    """Determine subset-conditioning blend parameters per doc 52 §14.5.

    Returns a dict with keys: applied (bool), r (float|None), m_S,
    m_G (float|None), skip_reason (str|None). Callers use this before
    mixing conditioned with unconditioned draw sets.
    """
    n_eff = getattr(resolved, 'n_effective', None) if resolved is not None else None
    if n_eff is None:
        return {'applied': False, 'r': None, 'm_S': float(m_S),
                'm_G': None, 'skip_reason': 'n_effective_missing'}
    if n_eff <= 0:
        return {'applied': False, 'r': None, 'm_S': float(m_S),
                'm_G': float(n_eff), 'skip_reason': 'n_effective_zero'}
    if m_S <= 0:
        return {'applied': False, 'r': None, 'm_S': float(m_S),
                'm_G': float(n_eff), 'skip_reason': 'no_cohorts'}
    r = min(float(m_S) / float(n_eff), 1.0)
    return {'applied': True, 'r': r, 'm_S': float(m_S),
            'm_G': float(n_eff), 'skip_reason': None}


def _mass_from_cohorts(cohorts) -> float:
    """m_S — total raw observation count across selected Cohorts
    (doc 52 §14.7). Uses subject evidence mass, not carrier-projected
    population mass."""
    return float(sum(float(c.evidence_n) for c in cohorts
                     if c.evidence_n and c.evidence_n > 0))


def _make_blend_permutation(S: int, r: float) -> Tuple[int, np.ndarray]:
    """Return (n_cond, permutation) for the (1 − r):r row-wise mix.

    The permutation is reproducible (seed=43) so the mix is
    deterministic for tests. First `n_cond` entries index the
    conditioned arrays; the remainder index the unconditioned arrays.
    """
    n_cond = int(round((1.0 - r) * S))
    n_cond = max(0, min(S, n_cond))
    blend_rng = np.random.default_rng(seed=_BLEND_SEED)
    return n_cond, blend_rng.permutation(S)


def _evaluate_cohort(
    cohort: CohortEvidence,
    S: int,
    T: int,
    det_cdf: list,
    drift_sds: np.ndarray,
    theta_transformed: np.ndarray,
    cdf_arr: np.ndarray,
    upstream_cdf_mc: Optional[np.ndarray],
    reach: float,
    loop_rng: np.random.Generator,
    _expit,
    edge_cdf_arr: Optional[np.ndarray] = None,
) -> tuple:
    """Evaluate the population model for a single cohort.

    Pure projection: given a fixed (already-conditioned-or-unconditioned)
    set of (p, lag-CDF) draws, project the per-cohort Y/X totals across
    the τ axis. IS conditioning is no longer done per cohort — the
    aggregate tempered IS step at the front of `compute_forecast_trajectory`
    produces the conditioned draws this function consumes (doc 73f F14).
    The unconditioned pass calls this function with the saved unconditioned
    draws so the doc 52 row-blend can mix the two.

    Returns (Y_cohort, X_cohort):
      Y_cohort: (S, T) forecast + observed y per draw
      X_cohort: (S, T) forecast + observed x per draw

    RNG contract: consumes loop_rng in exactly this order per call:
      1. normal(size=(S,4)) — drift
      2. binomial(remaining, q_late) — Pop D sampling
    Callers must pass the same loop_rng instance sequentially across
    cohorts to preserve the RNG stream.
    """
    N_i = cohort.x_frozen
    k_i = cohort.y_frozen
    a_i = cohort.frontier_age
    a_pop = cohort.a_pop

    if N_i <= 0 and a_pop <= 0:
        return None  # Caller must skip — no RNG consumed (matches original `continue`)

    a_idx = min(a_i, T - 1)

    # Per-cohort drift (v2 lines 833-835)
    delta_i = loop_rng.normal(0.0, drift_sds, size=(S, 4))
    theta_i = theta_transformed + delta_i
    p_i = _expit(theta_i[:, 0])
    # Drift only affects p, not CDF (v2 line 839)
    cdf_i = cdf_arr.copy()

    # Pop D: frontier survivors (v2 lines 863-886)
    # For multi-hop, use edge-level CDF when available. Frontier
    # survivors are from-node arrivals who haven't converted at the
    # LAST EDGE yet. Their conversion timing is edge-level, not
    # path-level (they've already completed upstream edges).
    _pop_d_cdf = edge_cdf_arr[:S, :T] if edge_cdf_arr is not None else cdf_i
    cdf_at_a = _pop_d_cdf[:, a_idx]
    remaining = max(N_i - k_i, 0.0)
    q_early = p_i[:, None] * cdf_at_a[:, None]
    q_early = np.clip(q_early, 0.0, 1 - 1e-10)
    remaining_cdf = np.maximum(_pop_d_cdf - cdf_at_a[:, None], 0.0)
    q_late = (p_i[:, None] * remaining_cdf) / (1 - q_early)
    q_late = np.clip(q_late, 0.0, 1.0)
    # v2 default is binomial sampling (display_settings.continuous_forecast)
    Y_D = loop_rng.binomial(int(remaining), q_late)

    # Pop C: post-frontier upstream arrivals.
    #
    # The general factorised solve is carrier-to-X followed by the
    # subject-side X→end progression. That means Pop C's numerator is a
    # convolution over the incremental post-frontier arrivals, not
    # `future_arrivals(t) * CDF_edge(t)`. The latter only happens to look
    # reasonable when the frontier already carries most of the mass; it
    # breaks the zero-evidence limit by collapsing the carrier effect.
    #
    # When edge_cdf_arr is provided (multi-hop), use it; otherwise fall back
    # to cdf_i (single-hop, where path = edge).
    X_C = np.zeros((S, T), dtype=np.float64)
    Y_C = np.zeros((S, T), dtype=np.float64)
    if upstream_cdf_mc is not None and reach > 0:
        _up_scaled = a_pop * reach * upstream_cdf_mc
        _arrival_increments = np.diff(
            np.concatenate([np.zeros((S, 1), dtype=np.float64), _up_scaled], axis=1),
            axis=1,
        )
        _arrival_increments = np.maximum(_arrival_increments, 0.0)
        _arrival_increments[:, :a_idx + 1] = 0.0
        X_C = np.cumsum(_arrival_increments, axis=1)
        _pop_c_cdf = edge_cdf_arr[:S, :T] if edge_cdf_arr is not None else cdf_i
        for s in range(S):
            _conv = np.convolve(
                _arrival_increments[s],
                _pop_c_cdf[s],
                mode='full',
            )[:T]
            Y_C[s, :] = p_i[s] * _conv

    # [v3-debug] Per-cohort carrier internals — diff FE vs CLI arrival shape
    if upstream_cdf_mc is not None and reach > 0:
        _dbg_taus = [t for t in [5, 10, 20, 30, 40, 60, 90] if t < T]
        _xc_med = np.median(X_C, axis=0)
        _yc_med = np.median(Y_C, axis=0)
        _pop_c_med = np.median(_pop_c_cdf, axis=0)
        _inc_med = np.median(_arrival_increments, axis=0)
        print(
            f"[v3-debug] cohort a_i={a_i} N_i={N_i:.4f} k_i={k_i:.4f} a_pop={a_pop} "
            f"reach={reach:.6f} p_i_med={float(np.median(p_i)):.4f}"
        )
        print(
            f"[v3-debug]   X_C median:    " +
            " ".join(f"t{t}:{_xc_med[t]:.4f}" for t in _dbg_taus)
        )
        print(
            f"[v3-debug]   Y_C median:    " +
            " ".join(f"t{t}:{_yc_med[t]:.4f}" for t in _dbg_taus)
        )
        print(
            f"[v3-debug]   pop_c_cdf med: " +
            " ".join(f"t{t}:{_pop_c_med[t]:.4f}" for t in _dbg_taus)
        )
        print(
            f"[v3-debug]   arr_inc med:   " +
            " ".join(f"t{t}:{_inc_med[t]:.4f}" for t in _dbg_taus)
        )

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

    return (Y_cohort, X_cohort)


def compute_forecast_trajectory(
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
    edge_cdf_arr: Optional[np.ndarray] = None,
    runtime_bundle: Optional[PreparedForecastRuntimeBundle] = None,
    extra_evidence: Optional[List[tuple]] = None,
) -> ForecastTrajectory:
    """Per-cohort population model sweep — generalised from v2.

    SUBSYSTEM GUIDE — When to call this (see docs/current/codebase/
    STATS_SUBSYSTEMS.md §3.4):
      - This is an INNER KERNEL. Intended callers are
        `compute_cohort_maturity_rows_v3` (chart row builder) and
        `handle_conditioned_forecast` (BE CF pass enrichment handler).
      - New analysis runners SHOULD NOT call this directly. Instead
        call `handle_conditioned_forecast` (or its /api/forecast/
        conditioned endpoint) with an `analytics_dsl` scoped to your
        analysis path. That handler wraps this function with the
        topo-sequencing, upstream-carrier caching, span-kernel
        composition, and subject resolution that multi-hop paths
        require for correctness (doc 47). Calling this function
        directly per-edge from an analysis runner bypasses all of
        that coordination and produces subtly wrong numbers.
      - Surprise gauge (doc 55) reads its conditioned and unconditioned
        scalars (`completeness_*`, `pp_rate_unconditioned`) directly off
        the trajectory return; new consumers of a full cohort-population
        forecast should go through the handler instead.

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

    if runtime_bundle is not None:
        resolved = runtime_bundle.resolved_params or resolved
        if from_node_arrival is None:
            from_node_arrival = runtime_bundle.carrier_to_x.from_node_arrival
        op_inputs = runtime_bundle.operator_inputs
        if mc_cdf_arr is None:
            mc_cdf_arr = op_inputs.mc_cdf_arr
        if mc_p_s is None:
            mc_p_s = op_inputs.mc_p_s
        if span_alpha is None:
            span_alpha = op_inputs.span_alpha
        if span_beta is None:
            span_beta = op_inputs.span_beta
        if span_mu_sd is None:
            span_mu_sd = op_inputs.span_mu_sd
        if span_sigma_sd is None:
            span_sigma_sd = op_inputs.span_sigma_sd
        if span_onset_sd is None:
            span_onset_sd = op_inputs.span_onset_sd
        if span_onset_mu_corr is None:
            span_onset_mu_corr = op_inputs.span_onset_mu_corr
        if det_norm_cdf is None:
            det_norm_cdf = op_inputs.det_norm_cdf
        if edge_cdf_arr is None:
            edge_cdf_arr = op_inputs.edge_cdf_arr

    lat = resolved.latency
    S = num_draws
    T = max_tau + 1
    rng = np.random.default_rng(seed=42)

    # Diagnostic: trace what's passed to the sweep
    _has_mc = mc_cdf_arr is not None
    _has_det = det_norm_cdf is not None
    _has_carrier = from_node_arrival is not None
    _has_edge_cdf = edge_cdf_arr is not None
    _diag_msg = (f"[sweep-diag] mc_cdf={_has_mc} det_norm_cdf={_has_det} "
          f"carrier={_has_carrier} edge_cdf={_has_edge_cdf} "
          f"span_alpha={span_alpha} span_mu_sd={span_mu_sd} "
          f"mu={lat.mu:.3f} sigma={lat.sigma:.3f} onset={lat.onset_delta_days:.1f} "
          f"max_tau={max_tau} n_cohorts={len(cohorts)}")
    print(_diag_msg)
    import sys; sys.stderr.write(_diag_msg + '\n')
    if _has_mc:
        _mc_med = np.median(mc_cdf_arr[:min(S, mc_cdf_arr.shape[0])], axis=0)
        _taus = [5, 10, 20, 30, 50]
        _cdf_vals = [(t, round(float(_mc_med[t]), 4) if t < len(_mc_med) else 0) for t in _taus]
        _mc_msg = f"[sweep-diag] mc_cdf median: {_cdf_vals}"
        print(_mc_msg)
        import sys; sys.stderr.write(_mc_msg + '\n')

    if lat.sigma <= 0:
        empty = np.zeros((S, T))
        return ForecastTrajectory(rate_draws=empty, model_rate_draws=empty)

    # ── Draw from posterior ───────────────────────────────────────
    # Draw all params in one interleaved call, matching v2's mc_span_cdfs
    # (span_kernel.py:442) which draws (S, n_edges, 4) in a single
    # rng.normal() call. Numpy generates different sequences for one
    # (S,1,4) call vs four (S,) calls, so the interleaving matters for
    # RNG-stream parity.
    # Doc 49: use predictive alpha/beta for forecast MC draws.
    alpha = resolved.alpha_pred if resolved.alpha_pred and resolved.alpha_pred > 0 else 0.0
    beta_ = resolved.beta_pred if resolved.beta_pred and resolved.beta_pred > 0 else 0.0
    if alpha <= 0 or beta_ <= 0:
        alpha = resolved.alpha if resolved.alpha and resolved.alpha > 0 else 0.0
        beta_ = resolved.beta if resolved.beta and resolved.beta > 0 else 0.0
    if alpha <= 0 or beta_ <= 0:
        _p_fb = max(min(resolved.p_mean or 0.5, 0.99), 0.01)
        alpha = _p_fb * 200.0
        beta_ = (1.0 - _p_fb) * 200.0
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

    # ── Upstream MC CDF (cohort mode only) ───────────────────────
    upstream_cdf_mc = None
    if from_node_arrival is not None and from_node_arrival.mc_cdf is not None:
        upstream_cdf_mc = from_node_arrival.mc_cdf[:S, :T]
    elif from_node_arrival is not None and from_node_arrival.deterministic_cdf is not None:
        _det = np.array(from_node_arrival.deterministic_cdf[:T])
        upstream_cdf_mc = np.tile(_det, (S, 1))

    reach = from_node_arrival.reach if from_node_arrival else 0.0

    # ── Aggregate tempered IS conditioning (doc 73f F14) ─────────────
    # Replaces the per-cohort sequential IS that previously lived inside
    # `_evaluate_cohort`. The likelihood per cohort i is
    #   y_i ~ Binomial(n_i, p∞ · c_i_s)
    # with `c_i_s = lag_cdf(τ_i, μ_s, σ_s, onset_s)` per draw — i.e.
    # completeness inside the binomial parameter, NOT as an external
    # cohort weight. Immature cohorts therefore contribute appropriately
    # reduced certainty rather than amplified weight.
    #
    # Tempered resampling (binary search on λ for ESS ≥ target) prevents
    # the degenerate posterior the per-cohort sequential IS was prone to
    # over many cohorts (doc 29g §aggregate IS). After resampling, the
    # conditioned (p, μ, σ, onset, cdf_arr, upstream_cdf_mc, edge_cdf_arr)
    # tuple is consistent with the same particle indices.
    p_draws_unconditioned = p_draws.copy()
    mu_draws_unconditioned = mu_draws.copy()
    sigma_draws_unconditioned = sigma_draws.copy()
    onset_draws_unconditioned = onset_draws.copy()
    cdf_arr_unconditioned = cdf_arr.copy()
    upstream_cdf_mc_unconditioned = (
        upstream_cdf_mc.copy() if upstream_cdf_mc is not None else None
    )
    edge_cdf_arr_unconditioned = (
        edge_cdf_arr.copy() if edge_cdf_arr is not None else None
    )

    is_ess_global = float(S)
    is_tempering_lambda = 1.0
    n_cohorts_conditioned = 0

    _evidence: List[tuple] = []
    for _c in cohorts:
        try:
            _tau_i = int(_c.frontier_age) if _c.frontier_age is not None else 0
        except (TypeError, ValueError):
            _tau_i = 0
        _n_i = float(_c.evidence_n or 0.0)
        _k_i = float(_c.evidence_k or 0.0)
        if _tau_i > 0 and _n_i > 0 and _k_i >= 0:
            _evidence.append((_tau_i, _n_i, _k_i))
    for _item in list(extra_evidence or []):
        try:
            _tau_i, _n_i, _k_i = _item
            _tau_i = int(_tau_i)
            _n_i = float(_n_i or 0.0)
            _k_i = float(_k_i or 0.0)
        except (TypeError, ValueError):
            continue
        if _tau_i > 0 and _n_i > 0 and _k_i >= 0:
            _evidence.append((_tau_i, _n_i, _k_i))

    if _evidence:
        _IS_TARGET_ESS = 20.0
        log_lik = np.zeros(S)
        for tau_i, n_i, k_i in _evidence:
            E_i = np.zeros(S)
            for s in range(S):
                E_i[s] = float(n_i) * _compute_completeness_at_age(
                    float(tau_i),
                    float(mu_draws[s]),
                    float(sigma_draws[s]),
                    float(onset_draws[s]),
                )
            E_eff = np.maximum(E_i, float(k_i))
            E_fail = E_eff - float(k_i)
            mask = E_fail >= 1.0
            if not mask.any():
                continue
            p_clip = np.clip(p_draws, 1e-15, 1 - 1e-15)
            cohort_log_w = np.where(
                mask,
                float(k_i) * np.log(p_clip) + E_fail * np.log(1 - p_clip),
                0.0,
            )
            log_lik += cohort_log_w
            n_cohorts_conditioned += 1

        if n_cohorts_conditioned > 0:
            lo, hi = 0.0, 1.0
            best_w, best_ess, best_lam = None, 0.0, 0.0
            for _ in range(20):  # bisection
                mid = (lo + hi) / 2.0
                w, ess = _weights_and_ess(log_lik, mid)
                if w is not None and ess >= _IS_TARGET_ESS:
                    best_w, best_ess, best_lam = w, ess, mid
                    lo = mid
                else:
                    hi = mid
            w_full, ess_full = _weights_and_ess(log_lik, 1.0)
            if w_full is not None and ess_full >= _IS_TARGET_ESS:
                best_w, best_ess, best_lam = w_full, ess_full, 1.0

            if best_w is not None and best_ess >= _IS_TARGET_ESS:
                indices = rng.choice(S, size=S, replace=True, p=best_w)
                p_draws = p_draws[indices]
                mu_draws = mu_draws[indices]
                sigma_draws = sigma_draws[indices]
                onset_draws = onset_draws[indices]
                cdf_arr = cdf_arr[indices]
                if upstream_cdf_mc is not None:
                    upstream_cdf_mc = upstream_cdf_mc[indices]
                if edge_cdf_arr is not None:
                    edge_cdf_arr = edge_cdf_arr[indices]
                is_ess_global = best_ess
                is_tempering_lambda = best_lam

    # Transform draws to unconstrained space (POST aggregate IS so
    # `theta_transformed` carries the conditioned `p` particle indices).
    # v2 uses CONSTANT mu/sigma/onset in theta_transformed (the per-draw
    # CDF variation is already in cdf_arr). Match that: only p varies
    # per draw in theta_transformed; latency params are fixed.
    def _build_theta_transformed(_p: np.ndarray) -> np.ndarray:
        return np.column_stack([
            _logit(np.clip(_p, 1e-10, 1 - 1e-10)),
            np.full(S, lat.mu),
            np.log(np.maximum(np.full(S, lat.sigma), 0.01)),
            np.log1p(np.maximum(np.full(S, lat.onset_delta_days), 0.0)),
        ])

    theta_transformed = _build_theta_transformed(p_draws)
    theta_transformed_unconditioned = _build_theta_transformed(p_draws_unconditioned)

    # [v3-debug] resolver + carrier shape — used to diff FE vs CLI payloads
    print(
        f"[v3-debug] resolved: source={getattr(resolved, 'source', None)!r} "
        f"p_mean={getattr(resolved, 'p_mean', None)} "
        f"alpha={getattr(resolved, 'alpha', None)} "
        f"beta={getattr(resolved, 'beta', None)} "
        f"alpha_pred={getattr(resolved, 'alpha_pred', None)} "
        f"beta_pred={getattr(resolved, 'beta_pred', None)} "
        f"qscoped={getattr(resolved, 'alpha_beta_query_scoped', None)}"
    )
    print(
        f"[v3-debug] from_node_arrival: reach={reach} tier={getattr(from_node_arrival, 'tier', None) if from_node_arrival else None} "
        f"has_mc_cdf={from_node_arrival is not None and getattr(from_node_arrival, 'mc_cdf', None) is not None} "
        f"has_det_cdf={from_node_arrival is not None and getattr(from_node_arrival, 'deterministic_cdf', None) is not None}"
    )
    if upstream_cdf_mc is not None:
        _car_med = np.median(upstream_cdf_mc, axis=0)
        _car_taus = [t for t in [0, 1, 2, 5, 10, 20, 30, 40, 60, 90] if t < T]
        _car_str = " ".join(f"t{t}:{_car_med[t]:.4f}" for t in _car_taus)
        print(f"[v3-debug] carrier_cdf median: {_car_str}")
    print(f"[v3-debug] cohorts: n={len(cohorts)}")
    for _ci, _c in enumerate(cohorts[:3]):
        _obs_x_head = list(_c.obs_x[:6]) if _c.obs_x else []
        _obs_y_head = list(_c.obs_y[:6]) if _c.obs_y else []
        print(
            f"[v3-debug] cohort[{_ci}]: N={_c.x_frozen:.4f} k={_c.y_frozen:.4f} "
            f"a_i={_c.frontier_age} a_pop={_c.a_pop} eval_age={_c.eval_age} "
            f"obs_x[:6]={[round(x, 4) for x in _obs_x_head]} "
            f"obs_y[:6]={[round(y, 4) for y in _obs_y_head]}"
        )

    # ── Per-cohort population model (v2 lines 800-912) ───────────
    def _run_cohort_loop(
        *,
        p_local: np.ndarray,
        theta_local: np.ndarray,
        cdf_local: np.ndarray,
        upstream_local: Optional[np.ndarray],
        edge_cdf_local: Optional[np.ndarray],
        label: str,
    ) -> tuple:
        """Run the per-cohort population-model loop with a fixed draw set.

        Pure projection: aggregate IS conditioning has already happened
        upstream (doc 73f F14), so this loop does not resample. Caller
        supplies either the conditioned draws (for the conditioned rate
        family) or the unconditioned snapshots (for the model-only fan).

        Uses a fresh rng(42) for drift, matching v2's per-cohort loop
        (cohort_forecast_v2.py:720) which creates its own rng(42)
        independent of mc_span_cdfs' rng.
        """
        _loop_rng = np.random.default_rng(seed=42)
        Y_total = np.zeros((S, T))
        X_total = np.zeros((S, T))
        _cohort_evals: List[CohortForecastAtEval] = []

        for cohort in cohorts:
            result = _evaluate_cohort(
                cohort=cohort,
                S=S, T=T,
                det_cdf=det_cdf,
                drift_sds=drift_sds,
                theta_transformed=theta_local,
                cdf_arr=cdf_local,
                upstream_cdf_mc=upstream_local,
                reach=reach,
                loop_rng=_loop_rng,
                _expit=_expit,
                edge_cdf_arr=edge_cdf_local,
            )
            if result is None:
                continue
            Y_c, X_c = result
            Y_total += Y_c
            X_total += X_c

            # Coordinate B: stash per-cohort draws at eval_age.
            # Populated on BOTH the conditioned and unconditioned passes
            # so the doc 52 blend can mix them row-wise.
            if cohort.eval_age is not None:
                t_i = min(cohort.eval_age, T - 1)
                _cohort_evals.append(CohortForecastAtEval(
                    y_draws=Y_c[:, t_i].copy(),
                    x_draws=X_c[:, t_i].copy(),
                    eval_age=cohort.eval_age,
                    conditioned=(label == 'conditioned'),
                ))

        # Rate draws (v2 lines 914-920)
        X_safe = np.maximum(X_total, 1e-10)
        rate = Y_total / X_safe

        # Diagnostic: median Y/X at a few τ values for parity debugging
        if len(cohorts) > 0:
            _ym = np.median(Y_total, axis=0)
            _xm = np.median(X_total, axis=0)
            _taus = [t for t in [5, 10, 15, 20, 25, 30, 35, 40] if t < T]
            _diag = " ".join(f"t{t}:Y={_ym[t]:.1f}/X={_xm[t]:.1f}" for t in _taus)
            print(f"[sweep_diag] pass={label} {_diag}")

        # When the population model has no denominator mass anywhere, fall
        # back to the unconditioned curve family instead of dividing 0/0.
        #
        # Window and the A=X identity case are just p × CDF(X→end). But when
        # cohort mode has a real upstream carrier, the natural degeneracy is
        # still factorised: carrier_to_x convolved with the subject-span
        # progression. Dropping the carrier here collapses cohort onto window
        # on the zero-evidence path.
        _x_median = np.median(X_total, axis=0)
        _needs_fallback = _x_median <= 1e-9
        if np.any(_needs_fallback):
            fallback_cdf = cdf_local[:S].copy()
            if upstream_local is not None and reach > 0:
                upstream_cdf_clip = np.clip(upstream_local[:S, :T], 0.0, 1.0)
                fallback_cdf = np.zeros_like(cdf_local[:S, :T])
                upstream_pdf = np.diff(
                    np.concatenate(
                        [np.zeros((S, 1), dtype=np.float64), upstream_cdf_clip],
                        axis=1,
                    ),
                    axis=1,
                )
                upstream_pdf = np.maximum(upstream_pdf, 0.0)
                for s in range(S):
                    fallback_cdf[s, :] = np.clip(
                        np.convolve(upstream_pdf[s], cdf_local[s, :T], mode='full')[:T],
                        0.0,
                        1.0,
                    )
            rate[:, _needs_fallback] = (
                p_local[:S, None] * fallback_cdf[:, _needs_fallback]
            )

        return rate, Y_total, X_total, _cohort_evals

    rate_conditioned, Y_cond, X_cond, cohort_evals_cond = _run_cohort_loop(
        p_local=p_draws,
        theta_local=theta_transformed,
        cdf_local=cdf_arr,
        upstream_local=upstream_cdf_mc,
        edge_cdf_local=edge_cdf_arr,
        label='conditioned',
    )
    is_ess = is_ess_global
    n_conditioned = n_cohorts_conditioned
    # Model-only draw family: same specific-Cohort population model as
    # `rate_draws`, but driven by the UNCONDITIONED draws preserved
    # before aggregate IS. Keeps `model_midpoint` carrier-aware in cohort
    # mode instead of collapsing onto the generic p×CDF shortcut.
    rate_unc, Y_unc, X_unc, cohort_evals_unc = _run_cohort_loop(
        p_local=p_draws_unconditioned,
        theta_local=theta_transformed_unconditioned,
        cdf_local=cdf_arr_unconditioned,
        upstream_local=upstream_cdf_mc_unconditioned,
        edge_cdf_local=edge_cdf_arr_unconditioned,
        label='unconditioned',
    )
    rate_model = rate_unc

    # Doc 52 §14.4.1: blend conditioned and unconditioned draw rows when
    # the evidence-mass heuristic says the fully conditioned sweep is too
    # brittle. Reuse the same unconditioned cohort-loop output that backs
    # `model_rate_draws`.
    blend_info = _compute_blend_params(resolved, _mass_from_cohorts(cohorts))
    if blend_info['applied']:
        n_cond, perm = _make_blend_permutation(S, blend_info['r'])
        cond_idx = perm[:n_cond]
        unc_idx = perm[n_cond:]
        # Row-wise blend rate_draws, Y_total, X_total with the same
        # permutation so per-draw rate/(Y,X) coupling is preserved.
        rate_draws_out = np.empty_like(rate_conditioned)
        rate_draws_out[:n_cond, :] = rate_conditioned[cond_idx, :]
        rate_draws_out[n_cond:, :] = rate_unc[unc_idx, :]
        Y_final = np.empty_like(Y_cond)
        X_final = np.empty_like(X_cond)
        Y_final[:n_cond, :] = Y_cond[cond_idx, :]
        Y_final[n_cond:, :] = Y_unc[unc_idx, :]
        X_final[:n_cond, :] = X_cond[cond_idx, :]
        X_final[n_cond:, :] = X_unc[unc_idx, :]
        # Per-Cohort y/x draws — same permutation per entry; assume
        # both lists have the same Cohort ordering because
        # _run_cohort_loop iterates `cohorts` in order.
        cohort_evals: List[CohortForecastAtEval] = []
        if len(cohort_evals_cond) == len(cohort_evals_unc):
            for ce_c, ce_u in zip(cohort_evals_cond, cohort_evals_unc):
                y_blend = np.empty(S)
                x_blend = np.empty(S)
                y_blend[:n_cond] = ce_c.y_draws[cond_idx]
                y_blend[n_cond:] = ce_u.y_draws[unc_idx]
                x_blend[:n_cond] = ce_c.x_draws[cond_idx]
                x_blend[n_cond:] = ce_u.x_draws[unc_idx]
                cohort_evals.append(CohortForecastAtEval(
                    y_draws=y_blend,
                    x_draws=x_blend,
                    eval_age=ce_c.eval_age,
                    conditioned=ce_c.conditioned,
                ))
        else:
            # Mismatch should not occur; fall back to conditioned only.
            cohort_evals = cohort_evals_cond
    else:
        rate_draws_out = rate_conditioned
        Y_final = Y_cond
        X_final = X_cond
        cohort_evals = cohort_evals_cond

    # Deterministic totals: median across blended draws
    _det_y = np.median(Y_final, axis=0)
    _det_x = np.median(X_final, axis=0)

    # Blended completeness: n-weighted CDF at each cohort's eval_age.
    # cdf_arr[s, t] = CDF(t, mu_s, sigma_s, onset_s) per draw — this
    # IS completeness, with full posterior uncertainty on latency params.
    # Compute conditioned and unconditioned families in one pass so the
    # surprise gauge (doc 55) has a baseline to compare against.
    _comp_mean = None
    _comp_sd = None
    _comp_unc_mean = None
    _comp_unc_sd = None
    _pp_unc_mean = None
    _pp_unc_sd = None
    _comp_n = 0.0
    _comp_draws = np.zeros(S)
    _comp_unc_draws = np.zeros(S)
    for c in cohorts:
        if c.eval_age is None:
            continue
        _comp_weight = float(c.x_frozen) if c.x_frozen > 0 else float(c.a_pop or 0.0)
        if _comp_weight <= 0:
            continue
        t_i = min(c.eval_age, T - 1)
        _comp_draws += _comp_weight * cdf_arr[:S, t_i]
        _comp_unc_draws += _comp_weight * cdf_arr_unconditioned[:S, t_i]
        _comp_n += _comp_weight
    if _comp_n > 0:
        _comp_draws /= _comp_n
        _comp_mean = float(np.mean(_comp_draws))
        _comp_sd = float(np.std(_comp_draws))
        _comp_unc_draws /= _comp_n
        _comp_unc_mean = float(np.mean(_comp_unc_draws))
        _comp_unc_sd = float(np.std(_comp_unc_draws))
        # pp_rate_unconditioned: per-draw p × c̄ on the unconditioned
        # set. Surprise gauge's p variable scores observed Σk/Σn
        # against this posterior-predictive expectation at current
        # window maturity (doc 55 §3.2).
        _pp_unc_products = p_draws_unconditioned[:S] * _comp_unc_draws
        _pp_unc_mean = float(np.mean(_pp_unc_products))
        _pp_unc_sd = float(np.std(_pp_unc_products))

    # Forensic: per-tau median Y/X/rate for debugging V2/V3 divergence
    global _last_forensic
    _forensic_taus = [5, 6, 7, 8, 10, 15, 20, 30]
    # Per-cohort forensic at tau=10 — trace exactly what each cohort contributes
    _per_cohort_at_10 = []
    if T > 10:
        for _ci, c in enumerate(cohorts):
            _is_mature = c.frontier_age >= 10
            _obs_x_10 = c.obs_x[10] if len(c.obs_x) > 10 else 0
            _obs_y_10 = c.obs_y[10] if len(c.obs_y) > 10 else 0
            _per_cohort_at_10.append({
                'i': _ci, 'N': round(c.x_frozen, 1), 'k': round(c.y_frozen, 1),
                'a_i': c.frontier_age, 'mature': _is_mature,
                'obs_x_10': round(_obs_x_10, 1), 'obs_y_10': round(_obs_y_10, 1),
                'a_pop': round(c.a_pop, 1),
            })
        # Y/X contributions at tau=10
        _y10 = float(np.median(Y_final[:, 10]))
        _x10 = float(np.median(X_final[:, 10]))
    _forensic = {}
    for _ft in _forensic_taus:
        if _ft < T:
            _ym = float(np.median(Y_cond[:, _ft]))
            _xm = float(np.median(X_cond[:, _ft]))
            _rm = float(np.median(rate_conditioned[:, _ft]))
            _forensic[_ft] = {'Y_med': round(_ym, 2), 'X_med': round(_xm, 2), 'rate_med': round(_rm, 4)}
    _forensic['_inputs'] = {
        'n_cohorts': len(cohorts),
        'T': T,
        'max_tau': max_tau,
        'S': S,
        'has_upstream_cdf_mc': upstream_cdf_mc is not None,
        'reach': round(reach, 6),
        'has_mc_cdf_arr': mc_cdf_arr is not None,
        'has_det_norm_cdf': det_norm_cdf is not None,
        'span_alpha': round(span_alpha, 4) if span_alpha else None,
        'span_beta': round(span_beta, 4) if span_beta else None,
        'span_mu_sd': round(span_mu_sd, 4) if span_mu_sd else None,
        'span_sigma_sd': round(span_sigma_sd, 4) if span_sigma_sd else None,
        'lat_mu': round(lat.mu, 4),
        'lat_sigma': round(lat.sigma, 4),
        'lat_onset': round(lat.onset_delta_days, 4),
        'lat_mu_sd': round(lat.mu_sd, 4),
        'lat_sigma_sd': round(lat.sigma_sd, 4),
        'cdf_arr_shape': list(cdf_arr.shape),
        'cdf_arr_at_taus': {t: round(float(np.median(cdf_arr[:, t])), 6) for t in [5, 10, 15, 20, 30] if t < T},
        'p_draws_median': round(float(np.median(p_draws)), 6),
        'p_draws_std': round(float(np.std(p_draws)), 6),
        'det_cdf_at_taus': {t: round(det_cdf[t], 6) for t in [5, 10, 15, 20, 30] if t < len(det_cdf)},
    }
    _forensic['runtime_bundle'] = serialise_runtime_bundle(runtime_bundle)
    if T > 10:
        _forensic['per_cohort_at_10'] = _per_cohort_at_10
        _forensic['Y10_total'] = round(_y10, 2)
        _forensic['X10_total'] = round(_x10, 2)
        _forensic['has_carrier'] = upstream_cdf_mc is not None
        _forensic['reach'] = round(reach, 6)
    # Per-cohort E_i and a_i (no truncation — F14 investigation needs all)
    _forensic['cohorts'] = []
    for _ci, c in enumerate(cohorts):
        _forensic['cohorts'].append({
            'i': _ci, 'N': round(c.x_frozen, 1), 'k': round(c.y_frozen, 1),
            'evidence_N': round(float(c.evidence_n or 0.0), 1),
            'evidence_k': round(float(c.evidence_k or 0.0), 1),
            'a_i': c.frontier_age, 'a_pop': round(c.a_pop, 1),
            'obs_x_len': len(c.obs_x),
        })

    # F14 aggregate IS forensic: was the maturity correction load-bearing?
    _f14: Dict[str, Any] = {}
    _sum_N = float(sum(n for _, n, _ in _evidence))
    _sum_k = float(sum(k for _, _, k in _evidence))
    _f14['sum_N'] = round(_sum_N, 1)
    _f14['sum_k'] = round(_sum_k, 1)
    _f14['raw_aggregate_k_over_n'] = round(_sum_k / _sum_N, 6) if _sum_N > 0 else None
    _ratios = [
        (float(k) / float(n)) for _, n, k in _evidence
        if n and n > 0 and k is not None
    ]
    if _ratios:
        _ratios_sorted = sorted(_ratios)
        _f14['per_cohort_k_over_n'] = {
            'count': len(_ratios),
            'min': round(min(_ratios), 4),
            'max': round(max(_ratios), 4),
            'mean': round(sum(_ratios) / len(_ratios), 4),
            'median': round(_ratios_sorted[len(_ratios) // 2], 4),
            'p10': round(_ratios_sorted[len(_ratios) // 10], 4),
            'p90': round(_ratios_sorted[(len(_ratios) * 9) // 10], 4),
        }
    _f14['is_evidence_n'] = len(_evidence)
    _f14['is_n_cohorts_conditioned'] = int(n_cohorts_conditioned)
    _f14['is_tempering_lambda'] = round(float(is_tempering_lambda), 4)
    _f14['is_ess_global'] = round(float(is_ess_global), 2)
    _f14['post_IS_p_median'] = round(float(np.median(p_draws)), 6)
    _f14['post_IS_p_std'] = round(float(np.std(p_draws)), 6)
    _f14['pre_IS_p_median'] = round(float(np.median(p_draws_unconditioned)), 6)
    _f14['pre_IS_p_std'] = round(float(np.std(p_draws_unconditioned)), 6)
    # Sample c_s for representative tau values across the cohort range
    _c_samples: Dict[int, Dict[str, float]] = {}
    if cohorts:
        _sample_taus = sorted({
            int(c.frontier_age or 0)
            for c in (cohorts[0], cohorts[len(cohorts) // 2], cohorts[-1])
            if c.frontier_age and c.frontier_age > 0
        })
        for _t in _sample_taus:
            _c_per_draw = [
                _compute_completeness_at_age(
                    float(_t),
                    float(mu_draws_unconditioned[s]),
                    float(sigma_draws_unconditioned[s]),
                    float(onset_draws_unconditioned[s]),
                )
                for s in range(min(S, 200))
            ]
            _c_per_draw_sorted = sorted(_c_per_draw)
            _c_samples[_t] = {
                'min': round(min(_c_per_draw), 6),
                'median': round(_c_per_draw_sorted[len(_c_per_draw) // 2], 6),
                'max': round(max(_c_per_draw), 6),
            }
    _f14['c_s_samples_by_tau'] = _c_samples
    _forensic['f14_is'] = _f14

    import hashlib as _hl
    _rd_hash = _hl.sha256(rate_conditioned.tobytes()).hexdigest()
    _forensic['rate_draws_sha256'] = _rd_hash
    print(f"[rate_draws_sha256] {_rd_hash}")

    _last_forensic = _forensic
    try:
        import json as _jf
        with open('/tmp/v3_forensic.json', 'w') as _ff:
            _ff.write(_jf.dumps(_forensic, default=str))
    except Exception:
        pass

    return ForecastTrajectory(
        rate_draws=rate_draws_out,
        model_rate_draws=rate_model,
        det_y_total=_det_y,
        det_x_total=_det_x,
        is_ess=is_ess,
        n_cohorts_conditioned=n_conditioned,
        cohort_evals=cohort_evals if cohort_evals else None,
        completeness_mean=_comp_mean,
        completeness_sd=_comp_sd,
        completeness_unconditioned=_comp_unc_mean,
        completeness_unconditioned_sd=_comp_unc_sd,
        pp_rate_unconditioned=_pp_unc_mean,
        pp_rate_unconditioned_sd=_pp_unc_sd,
        p_draws=p_draws,
        mu_draws=mu_draws,
        sigma_draws=sigma_draws,
        onset_draws=onset_draws,
        _forensic=_forensic,
        r=blend_info.get('r'),
        m_S=blend_info.get('m_S'),
        m_G=blend_info.get('m_G'),
        blend_applied=bool(blend_info.get('applied')),
        blend_skip_reason=blend_info.get('skip_reason'),
        runtime_bundle_diag=serialise_runtime_bundle(runtime_bundle),
    )
