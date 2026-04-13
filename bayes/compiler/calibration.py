"""
Posterior predictive calibration (doc 36, doc 38).

Computes PIT (probability integral transform) values and coverage
curves for two observation categories:

1. **Endpoint/daily BetaBinomial** — tests kappa (rate overdispersion)
2. **Trajectory intervals** — tests kappa_lat (latency overdispersion)

On synth graphs, when ground-truth parameters are provided, computes
BOTH the true PIT (from the known DGP) and the model PIT (from
posterior draws).  The true PIT validates the machinery; the comparison
between true and model PIT isolates model error from code bugs.

Called from worker.py between run_inference() and summarise_posteriors().
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import numpy as np
from scipy.special import erf as sp_erf
from scipy.stats import betabinom as sp_betabinom, kstest

from .types import (
    BoundEvidence,
    TopologyAnalysis,
)

log = logging.getLogger(__name__)

MAX_DRAWS = 200

COVERAGE_LEVELS = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95]

WARN_LO, WARN_HI = 0.82, 0.97
FAIL_LO, FAIL_HI = 0.75, 0.99


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class CategoryCalibration:
    """Calibration results for one observation category of one edge."""
    category: str = ""
    n_obs: int = 0
    pit_values: list[float] = field(default_factory=list)
    coverage: dict[float, float] = field(default_factory=dict)
    coverage_90: float = 0.0
    ks_stat: float = 0.0
    ks_pvalue: float = 0.0
    # True-DGP PIT (only when truth is provided)
    true_pit_values: list[float] = field(default_factory=list)
    true_coverage: dict[float, float] = field(default_factory=dict)
    true_coverage_90: float = 0.0
    true_ks_stat: float = 0.0
    true_ks_pvalue: float = 0.0


@dataclass
class EdgeCalibration:
    """Calibration results for one edge, both categories."""
    edge_id: str = ""
    endpoint_daily: CategoryCalibration | None = None
    trajectory: CategoryCalibration | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_var_name(edge_id: str) -> str:
    return edge_id.replace("-", "_")


def _subsample_draws(draws: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    if len(draws) <= MAX_DRAWS:
        return draws
    idx = rng.choice(len(draws), MAX_DRAWS, replace=False)
    return draws[idx]


def _shifted_lognormal_cdf_vec(ages: np.ndarray, onset: np.ndarray,
                                mu: np.ndarray, sigma: np.ndarray) -> np.ndarray:
    """Vectorised shifted-lognormal CDF.  ages (N,), params (S,) → (N, S)."""
    eff = ages[:, None] - onset[None, :]
    mask = eff > 0
    result = np.zeros_like(eff)
    safe_eff = np.where(mask, eff, 1.0)
    z = (np.log(safe_eff) - mu[None, :]) / (sigma[None, :] * math.sqrt(2.0))
    result[mask] = 0.5 * (1.0 + sp_erf(z[mask]))
    return result


def _shifted_lognormal_cdf_scalar(age: float, onset: float,
                                   mu: float, sigma: float) -> float:
    eff = age - onset
    if eff <= 0 or sigma <= 0:
        return 0.0
    return 0.5 * (1.0 + math.erf((math.log(eff) - mu) / (sigma * math.sqrt(2.0))))


def _coverage_from_pit(pit_values: np.ndarray) -> dict[float, float]:
    n = len(pit_values)
    if n == 0:
        return {level: 0.0 for level in COVERAGE_LEVELS}
    coverage = {}
    for level in COVERAGE_LEVELS:
        lo = (1.0 - level) / 2.0
        hi = 1.0 - lo
        coverage[level] = float(np.mean((pit_values >= lo) & (pit_values <= hi)))
    return coverage


def _pit_one_obs(k: int, n: int, alpha: float, beta: float,
                 rng: np.random.Generator) -> float:
    """Randomised PIT for a single BetaBinomial observation."""
    f_k = sp_betabinom.cdf(k, n, alpha, beta)
    f_km1 = sp_betabinom.cdf(k - 1, n, alpha, beta) if k > 0 else 0.0
    v = rng.uniform()
    return f_km1 + v * (f_k - f_km1)


def _pit_one_obs_vec(k: int, n: int, alphas: np.ndarray, betas: np.ndarray,
                     rng: np.random.Generator) -> float:
    """Randomised PIT averaged across posterior draws (vectorised)."""
    f_k = float(np.mean(sp_betabinom.cdf(k, n, alphas, betas)))
    f_km1 = float(np.mean(sp_betabinom.cdf(k - 1, n, alphas, betas))) if k > 0 else 0.0
    v = rng.uniform()
    return f_km1 + v * (f_k - f_km1)


def _finish_category(category: str, model_pits: list[float],
                     true_pits: list[float] | None) -> CategoryCalibration:
    """Build CategoryCalibration from PIT value lists."""
    pit_arr = np.array(model_pits)
    coverage = _coverage_from_pit(pit_arr)
    ks = kstest(pit_arr, "uniform")
    cal = CategoryCalibration(
        category=category,
        n_obs=len(model_pits),
        pit_values=model_pits,
        coverage=coverage,
        coverage_90=coverage.get(0.90, 0.0),
        ks_stat=float(ks.statistic),
        ks_pvalue=float(ks.pvalue),
    )
    if true_pits:
        t_arr = np.array(true_pits)
        t_cov = _coverage_from_pit(t_arr)
        t_ks = kstest(t_arr, "uniform")
        cal.true_pit_values = true_pits
        cal.true_coverage = t_cov
        cal.true_coverage_90 = t_cov.get(0.90, 0.0)
        cal.true_ks_stat = float(t_ks.statistic)
        cal.true_ks_pvalue = float(t_ks.pvalue)
    return cal


# ---------------------------------------------------------------------------
# Category 1: Endpoint / daily BetaBinomial — tests kappa
# ---------------------------------------------------------------------------

def _calibrate_endpoint_daily(
    edge_id: str,
    p_draws: np.ndarray,
    kappa_draws: np.ndarray,
    evidence,
    rng: np.random.Generator,
    truth: dict | None = None,
) -> CategoryCalibration | None:
    observations: list[tuple[int, int, float]] = []  # (n, k, completeness)

    if evidence.cohort_obs:
        onset = evidence.latency_prior.onset_delta_days if evidence.latency_prior else 0.0
        mu = evidence.latency_prior.mu if evidence.latency_prior else 0.0
        sigma = evidence.latency_prior.sigma if evidence.latency_prior else 0.01
        for c_obs in evidence.cohort_obs:
            for traj in (c_obs.trajectories or []):
                if traj.obs_type != "window" or len(traj.retrieval_ages) < 2 or traj.n <= 0:
                    continue
                f = _shifted_lognormal_cdf_scalar(
                    traj.retrieval_ages[-1], onset, mu, sigma)
                if f < 0.9:
                    continue
                k = min(traj.cumulative_y[-1], traj.n) if traj.cumulative_y else 0
                observations.append((traj.n, k, f))

    if evidence.cohort_obs:
        for c_obs in evidence.cohort_obs:
            for d in (c_obs.daily or []):
                if d.n > 0:
                    observations.append((d.n, d.k, d.completeness))

    for w in (evidence.window_obs or []):
        if w.n > 0:
            observations.append((w.n, w.k, w.completeness))

    if len(observations) < 5:
        return None

    has_truth = truth is not None
    p_true = truth["p"] if has_truth else None
    kappa_true = truth.get("kappa_endpoint", truth.get("kappa")) if has_truth else None

    model_pits: list[float] = []
    true_pits: list[float] = [] if has_truth else None

    for n_obs, k_obs, compl in observations:
        k_obs = min(k_obs, n_obs)

        # Model PIT: average predictive CDF over posterior draws
        p_eff = np.clip(p_draws * compl, 1e-6, 1.0 - 1e-6)
        model_pits.append(_pit_one_obs_vec(
            k_obs, n_obs, p_eff * kappa_draws, (1.0 - p_eff) * kappa_draws, rng))

        # True PIT: single point from known DGP
        if has_truth and kappa_true:
            p_t = min(max(p_true * compl, 1e-6), 1.0 - 1e-6)
            true_pits.append(_pit_one_obs(
                k_obs, n_obs, p_t * kappa_true, (1.0 - p_t) * kappa_true, rng))

    return _finish_category("endpoint_daily", model_pits, true_pits)


# ---------------------------------------------------------------------------
# Category 2: Trajectory intervals — tests kappa_lat
# ---------------------------------------------------------------------------

def _calibrate_trajectory(
    edge_id: str,
    p_draws: np.ndarray,
    kappa_lat_draws: np.ndarray,
    mu_draws: np.ndarray,
    sigma_draws: np.ndarray,
    onset_draws: np.ndarray,
    evidence,
    rng: np.random.Generator,
    truth: dict | None = None,
) -> CategoryCalibration | None:
    if not evidence.cohort_obs:
        return None

    intervals: list[tuple[int, int, float, float]] = []
    for c_obs in evidence.cohort_obs:
        for traj in (c_obs.trajectories or []):
            if traj.obs_type != "window":
                continue
            if len(traj.retrieval_ages) < 2 or traj.n <= 0:
                continue
            ages = traj.retrieval_ages
            cum_y = traj.cumulative_y
            if not cum_y or len(cum_y) != len(ages):
                continue
            for j in range(len(ages)):
                age_curr = ages[j]
                age_prev = ages[j - 1] if j > 0 else 0.0
                d_j = cum_y[j] - (cum_y[j - 1] if j > 0 else 0)
                n_at_risk = traj.n - (cum_y[j - 1] if j > 0 else 0)
                if n_at_risk <= 0 or d_j < 0:
                    continue
                d_j = min(d_j, n_at_risk)
                intervals.append((n_at_risk, d_j, age_prev, age_curr))

    if len(intervals) < 10:
        return None

    has_truth = truth is not None
    p_true = truth["p"] if has_truth else None
    kappa_true = truth.get("kappa_trajectory", truth.get("kappa")) if has_truth else None
    # kappa_trajectory=0 means single-source mode (no step-day dispersion);
    # trajectory intervals are plain Binomial — skip true PIT.
    if kappa_true is not None and kappa_true <= 0:
        kappa_true = None
    mu_true = truth["mu"] if has_truth else None
    sigma_true = truth["sigma"] if has_truth else None
    onset_true = truth["onset"] if has_truth else None

    # Vectorised model CDF matrices
    age_prev_arr = np.array([iv[2] for iv in intervals])
    age_curr_arr = np.array([iv[3] for iv in intervals])

    f_prev_mat = _shifted_lognormal_cdf_vec(age_prev_arr, onset_draws, mu_draws, sigma_draws)
    f_curr_mat = _shifted_lognormal_cdf_vec(age_curr_arr, onset_draws, mu_draws, sigma_draws)
    delta_f_mat = np.maximum(f_curr_mat - f_prev_mat, 1e-12)
    surv_mat = np.maximum(1.0 - p_draws[None, :] * f_prev_mat, 1e-6)
    q_mat = np.clip(p_draws[None, :] * delta_f_mat / surv_mat, 1e-6, 1.0 - 1e-6)

    alpha_mat = q_mat * kappa_lat_draws[None, :]
    beta_mat = (1.0 - q_mat) * kappa_lat_draws[None, :]

    _has_traj_truth = has_truth and kappa_true is not None
    model_pits: list[float] = []
    true_pits: list[float] = [] if _has_traj_truth else None

    for i, (n_at_risk, d_j, age_prev, age_curr) in enumerate(intervals):
        # Model PIT
        model_pits.append(_pit_one_obs_vec(
            d_j, n_at_risk, alpha_mat[i], beta_mat[i], rng))

        # True PIT
        if _has_traj_truth:
            f_prev_t = _shifted_lognormal_cdf_scalar(age_prev, onset_true, mu_true, sigma_true)
            f_curr_t = _shifted_lognormal_cdf_scalar(age_curr, onset_true, mu_true, sigma_true)
            delta_f_t = max(f_curr_t - f_prev_t, 1e-12)
            surv_t = max(1.0 - p_true * f_prev_t, 1e-6)
            q_t = min(max(p_true * delta_f_t / surv_t, 1e-6), 1.0 - 1e-6)
            # For true PIT, kappa_lat truth = kappa truth (same sim param)
            true_pits.append(_pit_one_obs(
                d_j, n_at_risk, q_t * kappa_true, (1.0 - q_t) * kappa_true, rng))

    return _finish_category("trajectory", model_pits, true_pits)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def compute_calibration(
    trace,
    evidence: BoundEvidence,
    topology: TopologyAnalysis,
    metadata: dict,
    diagnostics: list[str] | None = None,
    seed: int = 2026,
    calibration_truth: dict | None = None,
) -> dict[str, EdgeCalibration]:
    """Compute PPC calibration for all fitted edges.

    Parameters
    ----------
    calibration_truth : dict, optional
        Ground-truth parameters keyed by param_id (from truth file).
        Each entry: {p, kappa, mu, sigma, onset}.  When provided,
        computes true PIT alongside model PIT for machinery validation.
    """
    if diagnostics is None:
        diagnostics = []

    rng = np.random.default_rng(seed)
    results: dict[str, EdgeCalibration] = {}

    edge_var_names = metadata.get("edge_var_names", {})
    latent_latency_edges = metadata.get("latent_latency_edges", set())
    latent_onset_edges = metadata.get("latent_onset_edges", set())
    features = metadata.get("features", {})
    feat_ld = features.get("latency_dispersion", False)

    # Map param_id → truth for this edge
    def _get_truth(et):
        if not calibration_truth or not et.param_id:
            return None
        # Try param_id directly, then short name
        t = calibration_truth.get(et.param_id)
        if t:
            return t
        # param_id might be a full path; truth keys are short names
        for tkey, tval in calibration_truth.items():
            if et.param_id.endswith(tkey) or tkey.endswith(et.param_id):
                return tval
        return None

    n_edges = sum(1 for ev in evidence.edges.values()
                  if not ev.skipped and ev.total_n > 0)
    diagnostics.append(
        f"calibration: {n_edges} edges"
        + (" (with ground truth)" if calibration_truth else ""))

    for edge_id, ev in evidence.edges.items():
        if ev.skipped or ev.total_n == 0:
            continue

        et = topology.edges.get(edge_id)
        if et is None:
            continue

        safe_id = _safe_var_name(edge_id)
        ecal = EdgeCalibration(edge_id=edge_id)
        edge_truth = _get_truth(et)

        # --- Extract posterior draws ---
        p_var = edge_var_names.get(edge_id, f"p_{safe_id}")
        try:
            p_draws = _subsample_draws(
                trace.posterior[p_var].values.flatten(), rng)
        except (KeyError, AttributeError):
            diagnostics.append(
                f"calibration: {edge_id[:8]}… skipped (no p variable)")
            continue

        kappa_var = f"kappa_{safe_id}"
        try:
            kappa_draws = _subsample_draws(
                trace.posterior[kappa_var].values.flatten(), rng)
        except (KeyError, AttributeError):
            kappa_draws = None

        # --- Category 1: endpoint/daily ---
        if kappa_draws is not None:
            ecal.endpoint_daily = _calibrate_endpoint_daily(
                edge_id, p_draws, kappa_draws, ev, rng, truth=edge_truth)
            if ecal.endpoint_daily:
                c = ecal.endpoint_daily
                line = (
                    f"calibration: {edge_id[:8]}… endpoint_daily "
                    f"coverage@90%={c.coverage_90:.2f} "
                    f"n_obs={c.n_obs} PIT_ks={c.ks_stat:.3f} (p={c.ks_pvalue:.2f})")
                if c.true_pit_values:
                    line += (
                        f" | TRUE coverage@90%={c.true_coverage_90:.2f} "
                        f"PIT_ks={c.true_ks_stat:.3f} (p={c.true_ks_pvalue:.2f})")
                diagnostics.append(line)

        # --- Category 2: trajectory intervals ---
        if edge_id in latent_latency_edges and feat_ld:
            mu_var = f"mu_lat_{safe_id}"
            sigma_var = f"sigma_lat_{safe_id}"
            try:
                mu_draws = _subsample_draws(
                    trace.posterior[mu_var].values.flatten(), rng)
                sigma_draws = _subsample_draws(
                    trace.posterior[sigma_var].values.flatten(), rng)
            except (KeyError, AttributeError):
                mu_draws = sigma_draws = None

            if edge_id in latent_onset_edges:
                try:
                    onset_draws = _subsample_draws(
                        trace.posterior[f"onset_{safe_id}"].values.flatten(), rng)
                except (KeyError, AttributeError):
                    onset_draws = None
            else:
                onset_val = (ev.latency_prior.onset_delta_days
                             if ev.latency_prior else 0.0)
                onset_draws = np.full(len(p_draws), onset_val)

            kl_var = f"kappa_lat_{safe_id}_window"
            try:
                kl_draws = _subsample_draws(
                    trace.posterior[kl_var].values.flatten(), rng)
            except (KeyError, AttributeError):
                kl_draws = None

            if (mu_draws is not None and sigma_draws is not None
                    and kl_draws is not None):
                ecal.trajectory = _calibrate_trajectory(
                    edge_id, p_draws, kl_draws, mu_draws, sigma_draws,
                    onset_draws, ev, rng, truth=edge_truth)
                if ecal.trajectory:
                    c = ecal.trajectory
                    line = (
                        f"calibration: {edge_id[:8]}… trajectory "
                        f"coverage@90%={c.coverage_90:.2f} "
                        f"n_obs={c.n_obs} PIT_ks={c.ks_stat:.3f} (p={c.ks_pvalue:.2f})")
                    if c.true_pit_values:
                        line += (
                            f" | TRUE coverage@90%={c.true_coverage_90:.2f} "
                            f"PIT_ks={c.true_ks_stat:.3f} (p={c.true_ks_pvalue:.2f})")
                    diagnostics.append(line)

        if ecal.endpoint_daily or ecal.trajectory:
            results[edge_id] = ecal

    if not results:
        diagnostics.append("calibration: no edges had sufficient data")

    return results
