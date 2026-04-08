"""
LOO-ELPD posterior predictive scoring (doc 32).

Computes per-edge model adequacy scores via PSIS-LOO-CV, benchmarked
against the analytic stats pass as null model.  ΔELPD per edge answers:
"does the Bayesian model improve on the analytic point estimates?"

Called from worker.py between run_inference() and summarise_posteriors().
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import numpy as np
from scipy.special import gammaln
from scipy.stats import binom as sp_binom, betabinom as sp_betabinom

from .completeness import shifted_lognormal_cdf
from .types import (
    BoundEvidence,
    TopologyAnalysis,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Output type
# ---------------------------------------------------------------------------

@dataclass
class EdgeLooMetrics:
    """LOO-ELPD metrics for a single edge."""
    elpd: float = 0.0         # LOO-ELPD (sum of per-obs ELPD_i)
    elpd_null: float = 0.0    # plug-in log-likelihood under analytic null
    delta_elpd: float = 0.0   # elpd - elpd_null (positive = Bayesian better)
    pareto_k_max: float = 0.0 # worst Pareto k across this edge's data points
    n_loo_obs: int = 0        # number of data points contributing


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _safe(edge_id: str) -> str:
    return edge_id.replace("-", "_")


def dirichlet_multinomial_logpmf(x: np.ndarray, alpha: np.ndarray) -> float:
    """Log-PMF of the Dirichlet-Multinomial distribution."""
    x = np.asarray(x, dtype=float)
    alpha = np.asarray(alpha, dtype=float)
    n = x.sum()
    A = alpha.sum()
    return float(
        gammaln(n + 1) - gammaln(x + 1).sum()
        + gammaln(A) - gammaln(n + A)
        + (gammaln(x + alpha) - gammaln(alpha)).sum()
    )


# ---------------------------------------------------------------------------
# Node name → edge mapping
# ---------------------------------------------------------------------------

_EDGE_RE = re.compile(
    r'^(?:obs_w|obs_daily|endpoint_bb|cohort_endpoint_bb)_(.+?)(?:_\d+)?$'
)
_BG_RE = re.compile(r'^obs_bg_(.+)$')


def _build_lookups(topology: TopologyAnalysis):
    """Build reverse-lookup tables used by both LOO and null computation."""
    safe_to_edge = {_safe(eid): eid for eid in topology.edges}
    bg_to_siblings: dict[str, list[str]] = {}
    for bg in topology.branch_groups.values():
        bg_to_siblings[_safe(bg.group_id)] = list(bg.sibling_edge_ids)
    return safe_to_edge, bg_to_siblings


def _var_to_edge_ids(var_name: str, safe_to_edge, bg_to_siblings) -> list[str]:
    """Map an observation variable name to edge ID(s)."""
    m = _EDGE_RE.match(var_name)
    if m:
        eid = safe_to_edge.get(m.group(1))
        return [eid] if eid else []
    m = _BG_RE.match(var_name)
    if m:
        return bg_to_siblings.get(m.group(1), [])
    return []


# ---------------------------------------------------------------------------
# Null log-likelihood
# ---------------------------------------------------------------------------

def _analytic_p_and_kappa(ev) -> tuple[float, float | None]:
    """Derive analytic p and κ from the evidence's probability prior."""
    alpha = ev.prob_prior.alpha
    beta = ev.prob_prior.beta
    p = alpha / (alpha + beta) if (alpha + beta) > 0 else 0.5
    kappa = alpha + beta if (alpha + beta) > 2.0 else None
    return p, kappa


def _null_ll_edge_var(
    var_name: str, ev, et,
) -> float:
    """Null log-likelihood for one edge-level observation variable."""
    p, kappa = _analytic_p_and_kappa(ev)

    if var_name.startswith("obs_w_"):
        total = 0.0
        for w in ev.window_obs:
            if w.n <= 0:
                continue
            p_eff = min(max(p * w.completeness, 1e-6), 1 - 1e-6)
            total += sp_binom.logpmf(min(w.k, w.n), w.n, p_eff)
        return total

    if var_name.startswith("obs_daily_"):
        daily = [d for c in ev.cohort_obs for d in c.daily if d.n > 0]
        total = 0.0
        for d in daily:
            p_eff = min(max(p * d.completeness, 1e-6), 1 - 1e-6)
            k = min(d.k, d.n)
            if kappa is not None:
                total += sp_betabinom.logpmf(k, d.n, p_eff * kappa, (1 - p_eff) * kappa)
            else:
                total += sp_binom.logpmf(k, d.n, p_eff)
        return total

    if var_name.startswith(("endpoint_bb_", "cohort_endpoint_bb_")):
        is_cohort = var_name.startswith("cohort_endpoint_bb_")
        total = 0.0
        for c in ev.cohort_obs:
            for traj in c.trajectories:
                if is_cohort and traj.obs_type != "cohort":
                    continue
                if not is_cohort and traj.obs_type != "window":
                    continue
                if not traj.retrieval_ages or not traj.cumulative_y:
                    continue
                age = traj.max_retrieval_age or traj.retrieval_ages[-1]
                k = min(traj.cumulative_y[-1], traj.n)
                if is_cohort:
                    f = shifted_lognormal_cdf(
                        age, et.path_latency.path_delta,
                        et.path_latency.path_mu, et.path_latency.path_sigma,
                    ) if et.has_latency else 1.0
                else:
                    f = shifted_lognormal_cdf(
                        age, et.onset_delta_days, et.mu_prior, et.sigma_prior,
                    ) if et.has_latency else 1.0
                p_eff = min(max(p * f, 1e-6), 1 - 1e-6)
                if kappa is not None:
                    total += sp_betabinom.logpmf(k, traj.n, p_eff * kappa, (1 - p_eff) * kappa)
                else:
                    total += sp_binom.logpmf(k, traj.n, p_eff)
        return total

    return 0.0


def _null_ll_bg_var(
    var_name: str, sibling_ids: list[str], evidence: BoundEvidence, trace,
) -> float:
    """Null log-likelihood for one branch-group observation variable."""
    alpha_vec = []
    for eid in sibling_ids:
        ev = evidence.edges.get(eid)
        if ev:
            p_sib, _ = _analytic_p_and_kappa(ev)
            alpha_vec.append(max(p_sib, 0.01))
        else:
            alpha_vec.append(0.01)
    alpha_arr = np.array(alpha_vec)

    obs = trace.observed_data[var_name].values
    if obs.ndim == 1:
        return dirichlet_multinomial_logpmf(obs, alpha_arr)
    return sum(
        dirichlet_multinomial_logpmf(obs[i], alpha_arr)
        for i in range(obs.shape[0])
    )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def compute_loo_scores(
    trace,
    evidence: BoundEvidence,
    topology: TopologyAnalysis,
    diagnostics: list[str] | None = None,
) -> dict[str, EdgeLooMetrics]:
    """Compute per-edge LOO-ELPD scores with analytic null comparison.

    Returns {edge_id: EdgeLooMetrics}.
    """
    import arviz as az

    if diagnostics is None:
        diagnostics = []

    if not hasattr(trace, "log_likelihood") or len(trace.log_likelihood.data_vars) == 0:
        diagnostics.append("LOO: no log_likelihood group in trace, skipping")
        return {}

    # Run PSIS-LOO — gives pointwise ELPD and Pareto k as flat arrays
    try:
        loo_result = az.loo(trace, pointwise=True)
    except Exception as e:
        diagnostics.append(f"LOO: az.loo() failed: {e}")
        return {}

    loo_i = np.asarray(loo_result.loo_i)     # flat per-observation ELPD
    pk = np.asarray(loo_result.pareto_k)      # flat per-observation Pareto k

    safe_to_edge, bg_to_siblings = _build_lookups(topology)
    var_names = list(trace.log_likelihood.data_vars)
    edge_metrics: dict[str, EdgeLooMetrics] = {}

    # Walk variables in order, slicing the flat loo_i/pk arrays
    offset = 0
    for var_name in var_names:
        ll_shape = trace.log_likelihood[var_name].values.shape  # (chains, draws, *obs)
        n_obs = int(np.prod(ll_shape[2:])) if len(ll_shape) > 2 else 1

        if offset + n_obs > len(loo_i):
            diagnostics.append(f"LOO: offset mismatch at {var_name}, stopping")
            break

        var_elpd = float(loo_i[offset:offset + n_obs].sum())
        var_pk_max = float(pk[offset:offset + n_obs].max())

        # Null log-likelihood for this variable
        edge_ids = _var_to_edge_ids(var_name, safe_to_edge, bg_to_siblings)
        is_bg = _BG_RE.match(var_name) is not None

        if is_bg:
            var_null = _null_ll_bg_var(var_name, edge_ids, evidence, trace)
        elif edge_ids:
            ev = evidence.edges.get(edge_ids[0])
            et = topology.edges.get(edge_ids[0])
            var_null = _null_ll_edge_var(var_name, ev, et) if ev and et else 0.0
        else:
            var_null = 0.0

        # Attribute to edge(s)
        n_recipients = max(len(edge_ids), 1)
        for eid in edge_ids:
            m = edge_metrics.setdefault(eid, EdgeLooMetrics())
            m.elpd += var_elpd / n_recipients
            m.elpd_null += var_null / n_recipients
            m.n_loo_obs += max(n_obs // n_recipients, 1)
            m.pareto_k_max = max(m.pareto_k_max, var_pk_max)

        offset += n_obs

    # Compute ΔELPD
    for m in edge_metrics.values():
        m.delta_elpd = m.elpd - m.elpd_null

    diagnostics.append(
        f"LOO: {len(edge_metrics)} edges scored, "
        f"total ΔELPD={sum(m.delta_elpd for m in edge_metrics.values()):.1f}, "
        f"worst pareto_k={max((m.pareto_k_max for m in edge_metrics.values()), default=0.0):.2f}"
    )

    return edge_metrics
