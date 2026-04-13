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
class SliceLooMetrics:
    """LOO-ELPD metrics for a single context slice of an edge (doc 35)."""
    edge_id: str = ""
    ctx_safe: str = ""
    elpd: float = 0.0
    elpd_null: float = 0.0
    delta_elpd: float = 0.0
    pareto_k_max: float = 0.0
    n_loo_obs: int = 0


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
    evidence=None,
) -> dict[str, AnalyticBaseline]:
    """Extract analytic_be (or analytic) model_vars from graph edges.

    Returns {edge_id: AnalyticBaseline} for edges that have analytic
    model_vars. Prefers analytic_be; falls back to analytic.

    When model_vars are absent (e.g. synth graphs that haven't been
    through the FE stats pass), falls back to evidence priors from
    param files — these are the best available point estimates and
    serve as the LOO null model.
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

        if mv is not None:
            prob = mv.get("probability", {})
            lat = mv.get("latency", {})
            p_mean = prob.get("mean")
            p_sd = prob.get("stdev") or prob.get("p_stdev") or 0.0
            if p_mean is not None:
                result[edge_id] = AnalyticBaseline(
                    p=float(p_mean),
                    p_sd=float(p_sd),
                    onset=float(lat.get("onset_delta_days", 0) or 0),
                    mu=float(lat.get("mu", 0) or 0),
                    sigma=float(lat.get("sigma", 0.5) or 0.5),
                    has_latency=et.has_latency,
                )
                continue

        # Fallback: build baseline from evidence priors (param files)
        # and topology priors. This covers synth graphs and any graph
        # without model_vars. The prior p is derived from the Beta
        # prior's mean (alpha / (alpha + beta)).
        if evidence is not None:
            ev = evidence.edges.get(edge_id)
            if ev and not ev.skipped:
                pp = ev.prob_prior
                alpha, beta = pp.alpha, pp.beta
                p_val = alpha / (alpha + beta) if (alpha + beta) > 0 else 0.0
                # SD from Beta distribution: sqrt(alpha*beta / ((a+b)^2 * (a+b+1)))
                ab = alpha + beta
                p_sd = (alpha * beta / (ab * ab * (ab + 1))) ** 0.5 if ab > 1 else 0.1

                lp = ev.latency_prior
                onset = float(lp.onset_delta_days) if lp else 0.0
                mu = float(lp.mu) if lp else et.mu_prior
                sigma = float(lp.sigma) if lp else et.sigma_prior

                if p_val > 0:
                    result[edge_id] = AnalyticBaseline(
                        p=p_val,
                        p_sd=p_sd,
                        onset=onset,
                        mu=mu,
                        sigma=sigma,
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
    r'^(?:obs_w|obs_daily|endpoint_bb|cohort_endpoint_bb|traj_window|traj_cohort)_(.+?)(?:_\d+)?$'
)
_BG_RE = re.compile(r'^obs_bg_(.+)$')

# Per-slice observation variables: {prefix}_{edge_safe}__{ctx_safe}
# Double-underscore separates the edge from the context key.
_SLICE_RE = re.compile(
    r'^(?:obs_w|obs_daily|endpoint_bb|cohort_endpoint_bb|traj_window|traj_cohort)_'
    r'(.+?)__(.+?)(?:_\d+)?$'
)


def _build_lookups(topology: TopologyAnalysis):
    """Build reverse-lookup tables used by both LOO and null computation."""
    safe_to_edge = {_safe(eid): eid for eid in topology.edges}
    bg_to_siblings: dict[str, list[str]] = {}
    for bg in topology.branch_groups.values():
        bg_to_siblings[_safe(bg.group_id)] = list(bg.sibling_edge_ids)
    return safe_to_edge, bg_to_siblings


def _var_to_edge_ids(var_name: str, safe_to_edge, bg_to_siblings) -> list[str]:
    """Map an observation variable name to edge ID(s)."""
    # Try per-slice pattern first (has __ separator)
    m = _SLICE_RE.match(var_name)
    if m:
        eid = safe_to_edge.get(m.group(1))
        return [eid] if eid else []
    m = _EDGE_RE.match(var_name)
    if m:
        eid = safe_to_edge.get(m.group(1))
        return [eid] if eid else []
    m = _BG_RE.match(var_name)
    if m:
        return bg_to_siblings.get(m.group(1), [])
    return []


def _var_to_ctx_safe(var_name: str) -> str | None:
    """Extract per-slice context key from a variable name.

    Returns the ctx_safe portion if this is a per-slice variable,
    or None if it's an aggregate variable.
    """
    m = _SLICE_RE.match(var_name)
    return m.group(2) if m else None


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

    if var_name.startswith(("traj_window_", "traj_cohort_")):
        # Trajectory log-likelihood under the analytic null: product-of-
        # conditional-Binomials with analytic p, mu, sigma, onset.
        is_cohort = var_name.startswith("traj_cohort_")
        total = 0.0
        for c in ev.cohort_obs:
            for traj in c.trajectories:
                if is_cohort and traj.obs_type != "cohort":
                    continue
                if not is_cohort and traj.obs_type != "window":
                    continue
                cum_y = traj.cumulative_y
                if not cum_y or not traj.retrieval_ages:
                    continue
                # CDF at each retrieval age under the analytic latency
                if baseline.has_latency:
                    cdf_vals = [shifted_lognormal_cdf(
                        age, baseline.onset, baseline.mu, baseline.sigma,
                    ) for age in traj.retrieval_ages]
                else:
                    cdf_vals = [1.0] * len(traj.retrieval_ages)

                for j in range(len(cum_y)):
                    d_j = float(cum_y[0]) if j == 0 else float(max(0, cum_y[j] - cum_y[j-1]))
                    n_j = float(traj.n) if j == 0 else float(max(0, traj.n - cum_y[j-1]))
                    if n_j <= 0:
                        continue
                    cdf_curr = cdf_vals[j]
                    cdf_prev = cdf_vals[j-1] if j > 0 else 0.0
                    delta_f = max(cdf_curr - cdf_prev, 1e-9)
                    surv = max(1.0 - p * cdf_prev, 1e-9)
                    q_j = min(max(p * delta_f / surv, 1e-9), 1 - 1e-9)
                    w = getattr(traj, 'recency_weight', 1.0)
                    total += w * sp_binom.logpmf(min(int(d_j), int(n_j)), int(n_j), q_j)
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


def _null_ll_slice_var(
    var_name: str, ev, ctx_safe: str, baseline: AnalyticBaseline,
) -> float:
    """Null log-likelihood for one per-slice observation variable.

    Uses the edge-level AnalyticBaseline (best available aggregate null)
    applied to per-slice observations from the matching SliceObservations.
    """
    # Find the SliceObservations matching ctx_safe
    s_obs = None
    for sg in ev.slice_groups.values():
        for ctx_key, sobs in sg.slices.items():
            if _safe(ctx_key) == ctx_safe:
                s_obs = sobs
                break
        if s_obs is not None:
            break

    if s_obs is None:
        return 0.0

    p = baseline.p
    kappa = baseline.kappa

    if var_name.startswith("obs_w_"):
        total = 0.0
        for w in s_obs.window_obs:
            if w.n <= 0:
                continue
            p_eff = min(max(p * w.completeness, 1e-6), 1 - 1e-6)
            total += sp_binom.logpmf(min(w.k, w.n), w.n, p_eff)
        return total

    if var_name.startswith("obs_daily_"):
        daily = [d for c in s_obs.cohort_obs for d in c.daily if d.n > 0]
        total = 0.0
        for d in daily:
            p_eff = min(max(p * d.completeness, 1e-6), 1 - 1e-6)
            k = min(d.k, d.n)
            if kappa is not None:
                total += sp_betabinom.logpmf(k, d.n, p_eff * kappa, (1 - p_eff) * kappa)
            else:
                total += sp_binom.logpmf(k, d.n, p_eff)
        return total

    if var_name.startswith(("traj_window_", "traj_cohort_")):
        is_cohort = var_name.startswith("traj_cohort_")
        total = 0.0
        for c in s_obs.cohort_obs:
            for traj in c.trajectories:
                if is_cohort and traj.obs_type != "cohort":
                    continue
                if not is_cohort and traj.obs_type != "window":
                    continue
                cum_y = traj.cumulative_y
                if not cum_y or not traj.retrieval_ages:
                    continue
                if baseline.has_latency:
                    cdf_vals = [shifted_lognormal_cdf(
                        age, baseline.onset, baseline.mu, baseline.sigma,
                    ) for age in traj.retrieval_ages]
                else:
                    cdf_vals = [1.0] * len(traj.retrieval_ages)

                for j in range(len(cum_y)):
                    d_j = float(cum_y[0]) if j == 0 else float(max(0, cum_y[j] - cum_y[j-1]))
                    n_j = float(traj.n) if j == 0 else float(max(0, traj.n - cum_y[j-1]))
                    if n_j <= 0:
                        continue
                    cdf_curr = cdf_vals[j]
                    cdf_prev = cdf_vals[j-1] if j > 0 else 0.0
                    delta_f = max(cdf_curr - cdf_prev, 1e-9)
                    surv = max(1.0 - p * cdf_prev, 1e-9)
                    q_j = min(max(p * delta_f / surv, 1e-9), 1 - 1e-9)
                    w = getattr(traj, 'recency_weight', 1.0)
                    total += w * sp_binom.logpmf(min(int(d_j), int(n_j)), int(n_j), q_j)
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
    slice_baselines: dict[str, dict[str, AnalyticBaseline]] | None = None,
    diagnostics: list[str] | None = None,
) -> dict[str, EdgeLooMetrics]:
    """Compute per-edge LOO-ELPD scores with analytic null comparison.

    analytic_baselines: {edge_id: AnalyticBaseline} from
        extract_analytic_baselines(). If None, null log-likelihoods
        are not computed (ΔELPD will be 0).

    slice_baselines: {edge_id: {ctx_key: AnalyticBaseline}} — per-slice
        truth baselines for LOO null model (doc 35). When provided, per-slice
        null log-likelihoods use these instead of the edge-level baseline.
        Built from truth file context_dimensions during regression.

    Returns (edge_metrics, slice_metrics) tuple.
    """
    import arviz as az

    if diagnostics is None:
        diagnostics = []
    if analytic_baselines is None:
        analytic_baselines = {}

    if not hasattr(trace, "log_likelihood") or len(trace.log_likelihood.data_vars) == 0:
        diagnostics.append("LOO: no log_likelihood group in trace, skipping")
        return {}, {}

    safe_to_edge, bg_to_siblings = _build_lookups(topology)
    var_names = list(trace.log_likelihood.data_vars)
    edge_metrics: dict[str, EdgeLooMetrics] = {}
    # Per-slice metrics: (edge_id, ctx_safe) → SliceLooMetrics
    slice_metrics: dict[tuple[str, str], SliceLooMetrics] = {}

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

        loo_i = np.atleast_1d(np.asarray(loo_result.loo_i)).flatten()
        pk = np.atleast_1d(np.asarray(loo_result.pareto_k)).flatten()
        n_obs = loo_i.size

        var_elpd = float(loo_i.sum())
        var_pk_max = float(pk.max()) if pk.size > 0 else 0.0

        # Determine if this is a per-slice variable
        ctx_safe = _var_to_ctx_safe(var_name)

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
                if ctx_safe is not None:
                    # Per-slice null: prefer per-slice truth baseline (doc 35)
                    # Look up by matching ctx_safe against ctx_keys in slice_baselines
                    slice_bl = None
                    if slice_baselines and eid in slice_baselines:
                        for ctx_key, sbl in slice_baselines[eid].items():
                            if _safe(ctx_key) == ctx_safe:
                                slice_bl = sbl
                                break
                    var_null = _null_ll_slice_var(
                        var_name, ev, ctx_safe, slice_bl or bl)
                else:
                    var_null = _null_ll_edge_var(var_name, ev, bl)
            else:
                # No analytic baseline → ΔELPD is meaningless. Set null = elpd
                # so ΔELPD = 0 (no comparison) rather than a spurious large negative.
                var_null = var_elpd
                diagnostics.append(
                    f"LOO: {var_name}: no analytic baseline, ΔELPD set to 0"
                )
        else:
            var_null = var_elpd

        # Guard: if null ll is non-finite (numerical overflow with
        # extreme kappa or degenerate data), skip this variable's
        # null contribution so it doesn't poison ΔELPD.
        if not np.isfinite(var_null):
            diagnostics.append(
                f"LOO: null ll for {var_name} is {var_null}, skipping null for this variable"
            )
            var_null = 0.0

        # Attribute to edge(s) — aggregate metrics
        n_recipients = max(len(edge_ids), 1)
        for eid in edge_ids:
            m = edge_metrics.setdefault(eid, EdgeLooMetrics())
            m.elpd += var_elpd / n_recipients
            m.elpd_null += var_null / n_recipients
            m.n_loo_obs += max(n_obs // n_recipients, 1)
            m.pareto_k_max = max(m.pareto_k_max, var_pk_max)

            # Per-slice attribution (doc 35)
            if ctx_safe is not None:
                sk = (eid, ctx_safe)
                sm = slice_metrics.setdefault(
                    sk, SliceLooMetrics(edge_id=eid, ctx_safe=ctx_safe))
                sm.elpd += var_elpd / n_recipients
                sm.elpd_null += var_null / n_recipients
                sm.n_loo_obs += max(n_obs // n_recipients, 1)
                sm.pareto_k_max = max(sm.pareto_k_max, var_pk_max)

    # Compute ΔELPD
    for m in edge_metrics.values():
        m.delta_elpd = m.elpd - m.elpd_null
    for sm in slice_metrics.values():
        sm.delta_elpd = sm.elpd - sm.elpd_null

    # Aggregate diagnostic line
    diagnostics.append(
        f"LOO: {len(edge_metrics)} edges scored, "
        f"total ΔELPD={sum(m.delta_elpd for m in edge_metrics.values()):.1f}, "
        f"worst pareto_k={max((m.pareto_k_max for m in edge_metrics.values()), default=0.0):.2f}"
    )

    # Per-slice diagnostic lines (doc 35)
    if slice_metrics:
        # Group by ctx_safe for summary
        ctx_safes = sorted(set(cs for _, cs in slice_metrics))
        for cs in ctx_safes:
            cs_entries = [sm for (_, c), sm in slice_metrics.items() if c == cs]
            n_edges = len(cs_entries)
            total_d = sum(sm.delta_elpd for sm in cs_entries)
            worst_pk = max(sm.pareto_k_max for sm in cs_entries)
            diagnostics.append(
                f"LOO: slice {cs}: {n_edges} edges, "
                f"ΔELPD={total_d:.1f}, worst_pareto_k={worst_pk:.2f}"
            )

    return edge_metrics, slice_metrics
