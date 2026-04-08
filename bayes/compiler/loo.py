"""
LOO-ELPD posterior predictive scoring (doc 32).

Computes per-edge model adequacy scores via PSIS-LOO-CV, benchmarked
against the BE analytic stats pass as null model.  ΔELPD per edge
answers: "does the Bayesian model improve on the analytic stats pass?"

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
# Types
# ---------------------------------------------------------------------------

@dataclass
class EdgeLooMetrics:
    """LOO-ELPD metrics for a single edge."""
    elpd: float = 0.0         # LOO-ELPD (sum of per-obs ELPD_i)
    elpd_null: float = 0.0    # plug-in log-likelihood under analytic null
    delta_elpd: float = 0.0   # elpd - elpd_null (positive = Bayesian better)
    pareto_k_max: float = 0.0 # worst Pareto k across this edge's data points
    n_loo_obs: int = 0        # number of data points contributing


@dataclass
class AnalyticBaseline:
    """Analytic stats pass values for one edge — the LOO null model.

    Extracted from the graph snapshot's analytic_be (or analytic)
    model_vars entry. These are the BE topo pass point estimates that
    the user already sees before a Bayes fit.
    """
    p: float                   # p_evidence (maturity-corrected rate)
    p_sd: float                # heuristic dispersion SD
    onset: float = 0.0        # onset_delta_days
    mu: float = 0.0           # log-latency location
    sigma: float = 0.5        # log-latency scale
    has_latency: bool = False

    @property
    def kappa(self) -> float | None:
        """Beta concentration implied by p and p_sd."""
        if self.p_sd <= 0 or self.p <= 0 or self.p >= 1:
            return None
        v = self.p_sd ** 2
        common = self.p * (1 - self.p) / v - 1
        return (self.p + (1 - self.p)) * common if common > 0 else None


def extract_analytic_baselines(
    graph_snapshot: dict,
    topology: TopologyAnalysis,
) -> dict[str, AnalyticBaseline]:
    """Extract analytic_be (or analytic) model_vars from graph edges.

    Returns {edge_id: AnalyticBaseline} for edges that have analytic
    model_vars. Prefers analytic_be; falls back to analytic.
    """
    edge_lookup: dict[str, dict] = {}
    for edge in graph_snapshot.get("edges", []):
        eid = edge.get("uuid") or edge.get("id")
        if eid:
            edge_lookup[eid] = edge

    result: dict[str, AnalyticBaseline] = {}
    for edge_id, et in topology.edges.items():
        ge = edge_lookup.get(edge_id)
        if not ge:
            continue
        p_block = ge.get("p", {})
        mvs = p_block.get("model_vars", [])

        # Prefer analytic (FE, currently authoritative) then analytic_be.
        # Phase C: this becomes per-slice, keyed by context_key.
        mv = None
        for entry in mvs:
            if entry.get("source") == "analytic":
                mv = entry
                break
        if mv is None:
            for entry in mvs:
                if entry.get("source") == "analytic_be":
                    mv = entry
                    break
        if mv is None:
            continue

        prob = mv.get("probability", {})
        lat = mv.get("latency", {})
        p_mean = prob.get("mean")
        p_sd = prob.get("stdev") or prob.get("p_stdev") or 0.0
        if p_mean is None:
            continue

        result[edge_id] = AnalyticBaseline(
            p=float(p_mean),
            p_sd=float(p_sd),
            onset=float(lat.get("onset_delta_days", 0) or 0),
            mu=float(lat.get("mu", 0) or 0),
            sigma=float(lat.get("sigma", 0.5) or 0.5),
            has_latency=et.has_latency,
        )

    return result


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

def _null_ll_edge_var(
    var_name: str, ev, baseline: AnalyticBaseline,
) -> float:
    """Null log-likelihood for one edge-level observation variable."""
    p = baseline.p
    kappa = baseline.kappa

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
                # Analytic completeness from the stats pass latency
                if baseline.has_latency:
                    f = shifted_lognormal_cdf(
                        age, baseline.onset, baseline.mu, baseline.sigma,
                    )
                else:
                    f = 1.0
                p_eff = min(max(p * f, 1e-6), 1 - 1e-6)
                if kappa is not None:
                    total += sp_betabinom.logpmf(k, traj.n, p_eff * kappa, (1 - p_eff) * kappa)
                else:
                    total += sp_binom.logpmf(k, traj.n, p_eff)
        return total

    return 0.0


def _null_ll_bg_var(
    var_name: str, sibling_ids: list[str],
    baselines: dict[str, AnalyticBaseline], trace,
) -> float:
    """Null log-likelihood for one branch-group observation variable."""
    alpha_vec = []
    for eid in sibling_ids:
        bl = baselines.get(eid)
        if bl:
            alpha_vec.append(max(bl.p, 0.01))
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
    analytic_baselines: dict[str, AnalyticBaseline] | None = None,
    diagnostics: list[str] | None = None,
) -> dict[str, EdgeLooMetrics]:
    """Compute per-edge LOO-ELPD scores with analytic null comparison.

    analytic_baselines: {edge_id: AnalyticBaseline} from
        extract_analytic_baselines(). If None, null log-likelihoods
        are not computed (ΔELPD will be 0).

    Returns {edge_id: EdgeLooMetrics}.
    """
    import arviz as az

    if diagnostics is None:
        diagnostics = []
    if analytic_baselines is None:
        analytic_baselines = {}

    if not hasattr(trace, "log_likelihood") or len(trace.log_likelihood.data_vars) == 0:
        diagnostics.append("LOO: no log_likelihood group in trace, skipping")
        return {}

    safe_to_edge, bg_to_siblings = _build_lookups(topology)
    var_names = list(trace.log_likelihood.data_vars)
    edge_metrics: dict[str, EdgeLooMetrics] = {}

    # Filter to scoreable variables (our observation nodes only, not
    # soft-constraint nodes like t95_obs_, onset_obs_, path_t95_obs_)
    scoreable = [v for v in var_names if _var_to_edge_ids(v, safe_to_edge, bg_to_siblings)]

    # Run PSIS-LOO per variable — az.loo requires var_name when
    # multiple log-likelihood arrays exist in the trace.
    for var_name in scoreable:
        try:
            loo_result = az.loo(trace, var_name=var_name, pointwise=True)
        except Exception as e:
            diagnostics.append(f"LOO: az.loo({var_name}) failed: {e}")
            continue

        loo_i = np.asarray(loo_result.loo_i)
        pk = np.asarray(loo_result.pareto_k)
        n_obs = len(loo_i)

        var_elpd = float(loo_i.sum())
        var_pk_max = float(pk.max()) if len(pk) > 0 else 0.0

        # Null log-likelihood for this variable
        edge_ids = _var_to_edge_ids(var_name, safe_to_edge, bg_to_siblings)
        is_bg = _BG_RE.match(var_name) is not None

        if is_bg:
            var_null = _null_ll_bg_var(var_name, edge_ids, analytic_baselines, trace)
        elif edge_ids:
            eid = edge_ids[0]
            ev = evidence.edges.get(eid)
            bl = analytic_baselines.get(eid)
            if ev and bl:
                var_null = _null_ll_edge_var(var_name, ev, bl)
            else:
                var_null = 0.0
        else:
            var_null = 0.0

        # Guard: if null ll is non-finite (numerical overflow with
        # extreme kappa or degenerate data), skip this variable's
        # null contribution so it doesn't poison ΔELPD.
        if not np.isfinite(var_null):
            diagnostics.append(
                f"LOO: null ll for {var_name} is {var_null}, skipping null for this variable"
            )
            var_null = 0.0

        # Attribute to edge(s)
        n_recipients = max(len(edge_ids), 1)
        for eid in edge_ids:
            m = edge_metrics.setdefault(eid, EdgeLooMetrics())
            m.elpd += var_elpd / n_recipients
            m.elpd_null += var_null / n_recipients
            m.n_loo_obs += max(n_obs // n_recipients, 1)
            m.pareto_k_max = max(m.pareto_k_max, var_pk_max)

    # Compute ΔELPD
    for m in edge_metrics.values():
        m.delta_elpd = m.elpd - m.elpd_null

    diagnostics.append(
        f"LOO: {len(edge_metrics)} edges scored, "
        f"total ΔELPD={sum(m.delta_elpd for m in edge_metrics.values()):.1f}, "
        f"worst pareto_k={max((m.pareto_k_max for m in edge_metrics.values()), default=0.0):.2f}"
    )

    return edge_metrics
