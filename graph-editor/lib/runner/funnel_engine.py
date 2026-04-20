"""Pure-numpy engine for conversion_funnel Level 2 (doc 52).

Three regimes on a linear path of edges:
- e  — raw observed ratios + Wilson CI
- f  — Beta draws from each edge's promoted-source posterior, cumprod, quantiles
- e+f — path product of CF-conditioned means for bars; moment-matched Beta
        draws for bands; striation = (e, (e+f) − e)

No forecast-engine imports, no network calls, no scipy. The scoped CF
invocation for e+f mode is performed outside this module; the response
is passed in as `cf_per_edge`.

See docs/current/project-bayes/52-funnel-hi-lo-bars-design.md for the
semantic framework and doc 52 §4.2 for the procedure this mirrors.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist
from typing import Any, Optional

import numpy as np

from .model_resolver import resolve_model_params


@dataclass
class FunnelStageBars:
    """Per-stage bar heights and bands for one regime × scenario.

    All list fields are length N+1 (one per stage including stage 0).
    Stage 0 is by convention bar=1.0; lo/hi are None for stage 0.
    """
    bar: list[float]
    lo: list[Optional[float]]
    hi: list[Optional[float]]
    # Striation (e+f mode only)
    bar_e: Optional[list[float]] = None
    bar_f_residual: Optional[list[float]] = None


# ── Closed-form stats helpers ─────────────────────────────────────────


def wilson_ci(k: int, n: int, alpha: float = 0.10) -> tuple[float, float]:
    """Wilson score interval for a Binomial proportion.

    Closed-form arithmetic; no scipy. Default alpha=0.10 gives a 90 % CI.
    Returns (lo, hi) clipped to [0, 1]. When n <= 0 returns (0, 0).
    """
    if n <= 0:
        return (0.0, 0.0)
    z = NormalDist().inv_cdf(1.0 - alpha / 2.0)
    p_hat = k / n
    denom = 1.0 + (z * z) / n
    centre = (p_hat + (z * z) / (2.0 * n)) / denom
    halfwidth = (
        z * math.sqrt(p_hat * (1.0 - p_hat) / n + (z * z) / (4.0 * n * n))
    ) / denom
    return (max(0.0, centre - halfwidth), min(1.0, centre + halfwidth))


def moment_match_beta(p_mean: float, p_sd: float) -> Optional[tuple[float, float]]:
    """Moment-match (mean, sd) to a Beta(alpha, beta) distribution.

    Returns (alpha, beta) when the moments are feasible; None otherwise
    (p_mean outside (0, 1), sd non-positive, or sd² >= p(1−p)).

    Formula: kappa = p(1−p)/sd² − 1; alpha = p·kappa; beta = (1−p)·kappa.
    """
    if not (0.0 < p_mean < 1.0):
        return None
    if p_sd <= 0.0:
        return None
    var = p_sd * p_sd
    max_var = p_mean * (1.0 - p_mean)
    if var >= max_var:
        return None
    kappa = max_var / var - 1.0
    if kappa <= 0.0:
        return None
    return (p_mean * kappa, (1.0 - p_mean) * kappa)


# ── Per-regime bar computation ────────────────────────────────────────


def compute_bars_e(
    path_edges: list[dict[str, Any]],
    alpha_ci: float = 0.10,
) -> FunnelStageBars:
    """e mode: raw observed ratios k_i / n_0 with Wilson CI.

    Assumes a linear path where `path_edges[j]` is the edge from stage j
    to stage j+1. `n_0 = edges[0].evidence.n`, `k_i = edges[i-1].evidence.k`.
    For Cohort-aggregated evidence on each edge, the per-edge evidence
    already reflects Σ_c k_c and Σ_c n_c over selected Cohorts.

    Bar heights are the cumulative ratio; CI is the Wilson interval on
    (k_i, n_0).
    """
    def _evidence(edge: dict[str, Any]) -> dict[str, Any]:
        return (edge.get('p') or {}).get('evidence') or {}

    N = len(path_edges)
    bar: list[float] = [1.0]
    lo: list[Optional[float]] = [None]
    hi: list[Optional[float]] = [None]

    ev_0 = _evidence(path_edges[0])
    n_0 = ev_0.get('n')
    if not isinstance(n_0, (int, float)) or n_0 <= 0:
        # No evidence; return None for all downstream stages
        for _ in range(N):
            bar.append(0.0)
            lo.append(None)
            hi.append(None)
        return FunnelStageBars(bar=bar, lo=lo, hi=hi)

    n_0 = int(n_0)
    for i in range(1, N + 1):
        ev = _evidence(path_edges[i - 1])
        k_i = ev.get('k') or 0
        k_i = int(k_i) if isinstance(k_i, (int, float)) else 0
        bar_i = k_i / n_0
        lo_i, hi_i = wilson_ci(k_i, n_0, alpha_ci)
        bar.append(bar_i)
        lo.append(lo_i)
        hi.append(hi_i)

    return FunnelStageBars(bar=bar, lo=lo, hi=hi)


def compute_bars_f(
    path_edges: list[dict[str, Any]],
    temporal_mode: str = 'window',
    num_draws: int = 2000,
    rng: Optional[np.random.Generator] = None,
    graph_preference: Optional[str] = None,
) -> FunnelStageBars:
    """f mode: Beta draws from promoted-source α/β per edge, cumprod, quantiles.

    Per-edge α/β resolved via `resolve_model_params` — honours the
    promotion hierarchy (bayesian → analytic_be → analytic). Prefers
    `alpha_pred`/`beta_pred` (doc 49 predictive) when present, else
    falls back to epistemic `alpha`/`beta`.

    Bar = median across draws; lo/hi = 5 %/95 % quantiles.
    """
    if rng is None:
        rng = np.random.default_rng(seed=42)

    N = len(path_edges)
    p_draws = np.zeros((N, num_draws))
    for j, edge in enumerate(path_edges):
        resolved = resolve_model_params(
            edge, scope='edge', temporal_mode=temporal_mode,
            graph_preference=graph_preference,
        )
        if resolved is None:
            p_draws[j, :] = 0.0
            continue
        alpha = resolved.alpha_pred if (resolved.alpha_pred and resolved.alpha_pred > 0) else resolved.alpha
        beta = resolved.beta_pred if (resolved.beta_pred and resolved.beta_pred > 0) else resolved.beta
        if alpha > 0 and beta > 0:
            p_draws[j, :] = rng.beta(alpha, beta, size=num_draws)
        else:
            p_draws[j, :] = resolved.p_mean if resolved.p_mean else 0.0

    reach = np.cumprod(p_draws, axis=0)
    # Prepend stage 0 = 1.0
    reach = np.vstack([np.ones((1, num_draws)), reach])

    bar: list[float] = [1.0]
    lo: list[Optional[float]] = [None]
    hi: list[Optional[float]] = [None]
    for i in range(1, N + 1):
        bar.append(float(np.median(reach[i])))
        lo.append(float(np.quantile(reach[i], 0.05)))
        hi.append(float(np.quantile(reach[i], 0.95)))

    return FunnelStageBars(bar=bar, lo=lo, hi=hi)


def compute_bars_ef(
    cf_per_edge: list[dict[str, Any]],
    bar_e: list[float],
    num_draws: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> FunnelStageBars:
    """e+f mode: path product of CF-conditioned means for bars; moment-matched
    Beta draws for bands; striation decomposition (e, (e+f) − e).

    `cf_per_edge` is the per-edge output from the scoped CF response, in
    path order, with `p_mean` and `p_sd` per edge. `bar_e` is the
    pre-computed e-mode bars used for the solid component of the
    stacked bar.
    """
    if rng is None:
        rng = np.random.default_rng(seed=42)

    N = len(cf_per_edge)
    p_means = np.array([float(e.get('p_mean') or 0.0) for e in cf_per_edge])
    # Bars are deterministic path product
    bar_ef = np.concatenate([[1.0], np.cumprod(p_means)])

    # Bands via moment-matched Beta
    p_draws = np.zeros((N, num_draws))
    for j, cf_edge in enumerate(cf_per_edge):
        p_mean = float(cf_edge.get('p_mean') or 0.0)
        p_sd = float(cf_edge.get('p_sd') or 0.0)
        ab = moment_match_beta(p_mean, p_sd)
        if ab is None:
            # Degenerate posterior: deterministic draw at p_mean
            p_draws[j, :] = p_mean
        else:
            alpha, beta = ab
            p_draws[j, :] = rng.beta(alpha, beta, size=num_draws)

    reach = np.cumprod(p_draws, axis=0)
    reach = np.vstack([np.ones((1, num_draws)), reach])

    bar: list[float] = [float(bar_ef[0])]
    lo: list[Optional[float]] = [None]
    hi: list[Optional[float]] = [None]
    for i in range(1, N + 1):
        bar.append(float(bar_ef[i]))
        lo.append(float(np.quantile(reach[i], 0.05)))
        hi.append(float(np.quantile(reach[i], 0.95)))

    # Striation decomposition
    e_vals: list[float] = []
    f_residuals: list[float] = []
    for i in range(N + 1):
        e_val = float(bar_e[i]) if bar_e[i] is not None else 0.0
        ef_val = float(bar_ef[i])
        e_vals.append(e_val)
        f_residuals.append(max(0.0, ef_val - e_val))

    return FunnelStageBars(
        bar=bar,
        lo=lo,
        hi=hi,
        bar_e=e_vals,
        bar_f_residual=f_residuals,
    )
