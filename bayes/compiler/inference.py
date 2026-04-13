"""
Inference runner and posterior summarisation.

run_inference: pm.Model → InferenceData + QualityMetrics
summarise_posteriors: InferenceData + topology/evidence → InferenceResult
"""

from __future__ import annotations

import math
import time

from .types import (
    TopologyAnalysis,
    BoundEvidence,
    SamplingConfig,
    PosteriorSummary,
    LatencyPosteriorSummary,
    QualityMetrics,
    InferenceResult,
    HDI_PROB,
    RHAT_THRESHOLD,
    ESS_THRESHOLD,
)


def run_inference(
    model,
    config: SamplingConfig | None = None,
    report_progress=None,
    phase_label: str = "",
):
    """Run NUTS sampling via nutpie. Returns (InferenceData, QualityMetrics).

    phase_label: e.g. "Phase 1" or "Phase 2", prefixed to progress messages.
    """
    import pymc as pm
    import arviz as az

    if config is None:
        config = SamplingConfig()

    prefix = f"{phase_label}: " if phase_label else ""

    if report_progress:
        report_progress("sampling", 0, f"{prefix}Starting MCMC (nutpie)…")

    try:
        import nutpie  # noqa: F401
        trace = _sample_nutpie(model, config, report_progress, phase_label=phase_label)
    except ImportError:
        # Fallback: PyMC native NUTS (no nutpie installed)
        use_callback = report_progress is not None
        total_steps = config.chains * (config.tune + config.draws)
        steps_done = [0]
        last_pct = [-1]

        def _sampling_callback(trace, draw):
            steps_done[0] += 1
            pct = int(100 * steps_done[0] / total_steps)
            if pct > last_pct[0]:
                last_pct[0] = pct
                phase = "tuning" if draw.tuning else "sampling"
                report_progress(
                    "sampling", pct,
                    f"{prefix}{config.chains} chains {phase}",
                )

        with model:
            trace = pm.sample(
                draws=config.draws,
                tune=config.tune,
                chains=config.chains,
                cores=config.cores,
                target_accept=config.target_accept,
                return_inferencedata=True,
                random_seed=config.random_seed,
                progressbar=not use_callback,
                callback=_sampling_callback if use_callback else None,
                idata_kwargs={"log_likelihood": True},
            )

    # Move pointwise trajectory log-likelihood Deterministics from
    # posterior to log_likelihood so LOO-ELPD can score them.
    # pm.Potential doesn't produce log_likelihood entries; the model
    # stores them as ll_traj_* Deterministics instead (see model.py).
    _ll_vars = [v for v in trace.posterior.data_vars if v.startswith("ll_traj_")]
    if _ll_vars:
        _ll_dict = {}
        for v in _ll_vars:
            var_name = v[3:]  # strip "ll_" prefix → "traj_window_..." or "traj_cohort_..."
            _ll_dict[var_name] = trace.posterior[v]
        if hasattr(trace, "log_likelihood") and trace.log_likelihood is not None:
            import xarray as xr
            existing = {k: trace.log_likelihood[k] for k in trace.log_likelihood.data_vars}
            existing.update(_ll_dict)
            trace.log_likelihood = xr.Dataset(existing)
        else:
            trace.add_groups({"log_likelihood": _ll_dict})
        # Remove from posterior to avoid inflating rhat/ess computation
        trace.posterior = trace.posterior.drop_vars(_ll_vars)

    if report_progress:
        report_progress("summarising", 100, f"{prefix}Computing diagnostics…")

    # Convergence diagnostics
    rhat_ds = az.rhat(trace)
    ess_ds = az.ess(trace)

    rhat_values = []
    ess_values = []
    for var_name in rhat_ds.data_vars:
        arr = rhat_ds[var_name].values
        # Dirichlet and other multi-dimensional variables produce arrays
        for val in arr.flat:
            val = float(val)
            if not math.isnan(val):
                rhat_values.append(val)
    for var_name in ess_ds.data_vars:
        arr = ess_ds[var_name].values
        for val in arr.flat:
            val = float(val)
            if not math.isnan(val):
                ess_values.append(val)

    max_rhat = max(rhat_values) if rhat_values else 0.0
    min_ess = min(ess_values) if ess_values else 0.0

    n_divergences = 0
    if hasattr(trace, "sample_stats") and "diverging" in trace.sample_stats:
        n_divergences = int(trace.sample_stats["diverging"].values.sum())

    converged = max_rhat < RHAT_THRESHOLD and min_ess >= ESS_THRESHOLD
    n_vars = len(rhat_values) if rhat_values else 1
    n_converged = sum(
        1 for r, e in zip(rhat_values, ess_values)
        if r < RHAT_THRESHOLD and e >= ESS_THRESHOLD
    )

    quality = QualityMetrics(
        max_rhat=max_rhat,
        min_ess=min_ess,
        converged=converged,
        total_divergences=n_divergences,
        converged_pct=round(n_converged / max(n_vars, 1) * 100, 1),
    )

    return trace, quality



# Maturity threshold for dispersion estimation.  Observations with
# F below this are excluded — the CDF adjustment amplifies noise
# too much.  Survivors are used in BetaBinomial MLE with recency
# weighting.
DISPERSION_F_THRESHOLD = 0.90


def _estimate_cohort_kappa(
    ev,
    et,
    topology,
    p_cohort_mean: float,
    diagnostics: list[str],
    obs_type_filter: str = "cohort",
    phase2_frozen: dict | None = None,
    recency_half_life: float = 30.0,
    today_date=None,
) -> float | None:
    """Estimate between-cohort dispersion via BetaBinomial MLE.

    For each anchor day, collects (k, n) — conversions and denominator.
    Fits BetaBinomial(n, α, β) by maximum likelihood to estimate the
    concentration κ = α + β.  More efficient than Williams moment
    estimation when per-observation n is small (the Binomial noise is
    large relative to the between-cohort signal).

    Observations are weighted by recency (halflife decay) for
    consistency with the model.  Maturity-gated by DISPERSION_F_THRESHOLD.

    Returns kappa (Beta concentration) or None if insufficient data.
    """
    from .completeness import shifted_lognormal_cdf

    if not ev.cohort_obs:
        return None

    # Resolve the CDF parameters from Phase 1 POSTERIOR (not prior).
    # The posterior is more accurate — the prior CDF can overestimate
    # maturity at early ages, biasing p_implied low and inflating
    # variance. See journal 29-Mar-26.
    # Window obs: edge-level CDF (age from edge entry).
    # Cohort obs: path-level CDF (age from anchor entry).
    onset = 0.0
    mu = 0.0
    sigma = 0.01
    if et.has_latency:
        # Try Phase 1 posterior first (from latency_posteriors if available,
        # or from the trace via phase2_frozen which carries posterior means)
        safe_eid = ev.edge_id.replace("-", "_")
        if obs_type_filter == "window":
            # Window: edge CDF from posterior
            if phase2_frozen and ev.edge_id in phase2_frozen:
                pf = phase2_frozen[ev.edge_id]
                onset = pf.get("onset", ev.latency_prior.onset_delta_days if ev.latency_prior else 0.0)
                mu = pf.get("mu", ev.latency_prior.mu if ev.latency_prior else 0.0)
                sigma = pf.get("sigma", ev.latency_prior.sigma if ev.latency_prior else 0.01)
            elif ev.latency_prior:
                onset = ev.latency_prior.onset_delta_days or 0.0
                mu = ev.latency_prior.mu
                sigma = ev.latency_prior.sigma
        else:
            # Cohort: path CDF = FW composition of all edges along the
            # path from anchor to this edge's target node.
            # Use posterior per-edge latency (from phase2_frozen) when
            # available; fall back to topology path_latency.
            path_composed = False
            if phase2_frozen and hasattr(et, 'path_edge_ids') and et.path_edge_ids:
                from .completeness import fw_chain
                components = []
                path_onset = 0.0
                for pid in et.path_edge_ids:
                    pf = phase2_frozen.get(pid, {})
                    e_onset = pf.get("onset", 0.0)
                    e_mu = pf.get("mu", 0.0)
                    e_sigma = pf.get("sigma", 0.01)
                    path_onset += e_onset
                    if e_sigma > 0.001:
                        components.append((e_mu, e_sigma))
                if components:
                    fw = fw_chain(components)
                    onset = path_onset
                    mu = fw.mu
                    sigma = fw.sigma
                    path_composed = True
            if not path_composed:
                if hasattr(et, 'path_latency') and et.path_latency:
                    onset = et.path_latency.path_delta
                    mu = et.path_latency.path_mu
                    sigma = et.path_latency.path_sigma
                elif ev.latency_prior:
                    onset = ev.latency_prior.onset_delta_days or 0.0
                    mu = ev.latency_prior.mu
                    sigma = ev.latency_prior.sigma

    # Collect one (k, n) per anchor day — the MOST MATURE observation.
    #
    # For dispersion estimation we want the final rate per anchor day,
    # not the growth trajectory.  Trajectories show how k/n evolves
    # with retrieval age (useful for CDF fitting), but for kappa we
    # only need one settled rate per day.
    #
    # Strategy: for each anchor day, keep the observation with the
    # highest F (most mature).  Daily obs and trajectory endpoints
    # are both candidates.  Prefer the more mature one.
    #
    # Filters:
    #   - denominator >= 3
    #   - F >= DISPERSION_F_THRESHOLD
    # Weighting:
    #   - recency (halflife decay — consistent with model)
    import math as _math
    _ln2 = _math.log(2)
    # best_by_day: date → (k, n, f, age)
    best_by_day: dict[str, tuple] = {}
    n_skipped_x = 0
    n_skipped_f = 0

    def _recency_weight(date_str):
        if not date_str or not today_date:
            return 1.0
        try:
            from datetime import datetime
            if isinstance(today_date, datetime):
                td = today_date
            else:
                td = datetime.fromisoformat(str(today_date))
            dt = datetime.fromisoformat(str(date_str)[:10])
            age_days = (td - dt).days
            if age_days < 0:
                return 1.0
            return _math.exp(-_ln2 * age_days / recency_half_life)
        except (ValueError, TypeError):
            return 1.0

    def _consider(date_key, k_val, n_val, age_val, f_val):
        """Keep the most mature observation per anchor day."""
        if date_key is None:
            return
        prev = best_by_day.get(date_key)
        if prev is None or f_val > prev[2]:
            best_by_day[date_key] = (k_val, n_val, f_val, age_val)

    for c_obs in ev.cohort_obs:
        # Daily obs: one per anchor day at a single retrieval age
        if c_obs.daily and obs_type_filter in getattr(c_obs, 'slice_dsl', ''):
            for d_obs in c_obs.daily:
                d_key = getattr(d_obs, 'date', None)
                if d_obs.n < 3:
                    n_skipped_x += 1
                    continue
                age = getattr(d_obs, 'age_days', 0) or 0
                if not et.has_latency:
                    f_age = 1.0  # no-latency edge: instant conversion, always mature
                else:
                    f_age = shifted_lognormal_cdf(age, onset, mu, sigma)
                _consider(d_key, min(d_obs.k, d_obs.n), d_obs.n, age, f_age)

        # Trajectory endpoints: use the LAST retrieval point.
        # For F calculation, use max_retrieval_age (the true latest
        # observation age before zero-count filtering collapsed
        # post-maturation points).  The (k, n) values are correct
        # at the filtered endpoint — y stopped changing — but the
        # filtered age underestimates maturity.
        for traj in c_obs.trajectories:
            if traj.obs_type != obs_type_filter:
                continue
            if len(traj.retrieval_ages) < 2 or traj.n <= 0:
                continue
            cx = getattr(traj, 'cumulative_x', None)
            if not cx or len(cx) == 0 or cx[-1] < 3:
                n_skipped_x += 1
                continue
            # Use unfiltered max age for maturity; fall back to
            # filtered endpoint age if not available.
            age_for_f = getattr(traj, 'max_retrieval_age', None) or traj.retrieval_ages[-1]
            if not et.has_latency:
                f_age = 1.0  # no-latency edge: instant conversion, always mature
            else:
                f_age = shifted_lognormal_cdf(age_for_f, onset, mu, sigma)
            y_final = min(traj.cumulative_y[-1] if traj.cumulative_y else 0, cx[-1])
            _consider(getattr(traj, 'date', None), y_final, cx[-1], age_for_f, f_age)

    # Apply F threshold and collect survivors
    k_values = []
    n_values = []
    f_values = []
    recency_weights = []
    for date_key, (k_val, n_val, f_val, age_val) in best_by_day.items():
        if f_val < DISPERSION_F_THRESHOLD:
            n_skipped_f += 1
            continue
        k_values.append(k_val)
        n_values.append(n_val)
        f_values.append(f_val)
        recency_weights.append(_recency_weight(date_key))

    if len(k_values) < 5:
        diagnostics.append(
            f"  empirical_kappa {ev.edge_id[:8]}…: insufficient data "
            f"({len(k_values)} cohorts after filtering, "
            f"skipped {n_skipped_x} low-x, {n_skipped_f} immature)"
        )
        return None

    import numpy as _np
    from scipy.special import betaln as _betaln
    from scipy.optimize import minimize as _minimize

    k_arr = _np.array(k_values, dtype=_np.float64)
    n_arr = _np.array(n_values, dtype=_np.float64)
    f_arr = _np.array(f_values)
    w_arr = _np.array(recency_weights)

    # (Phase B diagnostic removed)

    eff_n = float(_np.sum(w_arr) ** 2 / _np.sum(w_arr ** 2)) if _np.sum(w_arr) > 0 else 0
    p_implied = k_arr / (n_arr * f_arr)
    p_implied = _np.clip(p_implied, 0.001, 0.999)

    diagnostics.append(
        f"  kappa_debug {ev.edge_id[:8]}…: "
        f"n_obs={len(k_arr)}, n_eff={eff_n:.0f}, "
        f"p_implied=[{_np.min(p_implied):.4f}..{_np.max(p_implied):.4f}] "
        f"std={_np.std(p_implied):.6f}, "
        f"n_denom=[{_np.min(n_arr):.0f}..{_np.max(n_arr):.0f}] "
        f"median={_np.median(n_arr):.0f}, "
        f"F=[{_np.min(f_arr):.3f}..{_np.max(f_arr):.3f}], "
        f"obs_type={obs_type_filter}"
    )

    # BetaBinomial MLE with exact CDF-adjusted likelihood.
    #
    # Generative model:
    #   p_day ~ Beta(α, β)              [between-day rate variation]
    #   k ~ Binomial(n, p_day × F)      [observed conversions, F = maturity]
    #
    # Parameterised as (μ, log ρ) where μ = α/(α+β), ρ = 1/(κ+1).
    # The ρ parameterisation has better numerical conditioning than
    # (α, β) or (μ, κ) — Fisher information for κ scales as 1/κ⁴,
    # making the likelihood surface flat for large κ.  In contrast,
    # the likelihood has meaningful curvature in log(ρ) even when ρ
    # is small.  See Crowder (1978), Ridout et al (1999).
    #
    # For F=1: standard BetaBinomial (closed form via betaln).
    # For F<1: numerical quadrature (scipy.integrate.quad).
    from scipy.integrate import quad as _quad
    from scipy.special import gammaln as _gammaln

    def _log_lik_one(k_i, n_i, f_i, a, b):
        """Log P(k|n,F,α,β) for a single observation."""
        if abs(f_i - 1.0) < 1e-8:
            return float(
                _gammaln(n_i + 1) - _gammaln(k_i + 1) - _gammaln(n_i - k_i + 1)
                + _betaln(k_i + a, n_i - k_i + b) - _betaln(a, b)
            )
        log_binom_coeff = (
            _gammaln(n_i + 1) - _gammaln(k_i + 1) - _gammaln(n_i - k_i + 1)
        )
        log_beta_norm = _betaln(a, b)

        def integrand(p):
            pf = p * f_i
            if pf <= 0 or pf >= 1:
                if k_i == 0 and pf <= 0:
                    return (1.0 - p) ** (b - 1) * p ** (a - 1)
                return 0.0
            return pf ** k_i * (1.0 - pf) ** (n_i - k_i) * p ** (a - 1) * (1.0 - p) ** (b - 1)

        val, _ = _quad(integrand, 0, 1, limit=50)
        if val <= 0:
            return -1e10
        return float(log_binom_coeff - log_beta_norm + _np.log(val))

    _is_mature = _np.abs(f_arr - 1.0) < 1e-8
    _n_quad = int(_np.sum(~_is_mature))

    def _neg_loglik(params):
        """Negative log-likelihood in (μ, log ρ) parameterisation."""
        mu_p = params[0]
        rho = _np.exp(params[1])
        # Convert to (α, β): κ = (1-ρ)/ρ, α = μκ, β = (1-μ)κ
        kap = (1.0 - rho) / rho
        a = mu_p * kap
        b = (1.0 - mu_p) * kap
        if a <= 0 or b <= 0:
            return 1e10

        # Mature observations: vectorised BetaBinomial (fast)
        ll_mature = _np.where(
            _is_mature,
            w_arr * (_betaln(k_arr + a, n_arr - k_arr + b) - _betaln(a, b)),
            0.0,
        )
        total = float(_np.sum(ll_mature))
        # Semi-mature observations: per-observation quadrature
        for i in range(len(k_arr)):
            if not _is_mature[i]:
                total += float(w_arr[i]) * _log_lik_one(
                    k_arr[i], n_arr[i], f_arr[i], a, b)
        return -total

    # Starting values
    p_bar = float(_np.average(p_implied, weights=w_arr))
    p_bar = max(min(p_bar, 0.999), 0.001)
    rho_init = 0.02  # corresponds to kappa ≈ 50

    try:
        result = _minimize(
            _neg_loglik,
            x0=[p_bar, _np.log(rho_init)],
            method='L-BFGS-B',
            bounds=[(0.001, 0.999), (-10, -0.001)],  # ρ in [~0.00005, ~0.999]
        )
        if result.success:
            mu_hat = float(result.x[0])
            rho_hat = float(_np.exp(result.x[1]))
            kappa = (1.0 - rho_hat) / rho_hat
            kappa = max(kappa, 1.0)
            kappa = min(kappa, 5000.0)
            sd_hat = _np.sqrt(mu_hat * (1 - mu_hat) * rho_hat)
            diagnostics.append(
                f"  empirical_kappa {ev.edge_id[:8]}…: kappa={kappa:.1f} "
                f"(BB-MLE, mu={mu_hat:.4f}, rho={rho_hat:.5f}, sd={sd_hat:.4f}, "
                f"n_cohorts={len(k_arr)}, n_eff={eff_n:.0f}, n_quad={_n_quad}, "
                f"cdf=[{onset:.1f},{mu:.3f},{sigma:.3f}])"
            )
            return kappa
        else:
            diagnostics.append(
                f"  empirical_kappa {ev.edge_id[:8]}…: MLE failed to converge "
                f"({result.message}), n_cohorts={len(k_arr)}"
            )
            return None
    except Exception as e:
        diagnostics.append(
            f"  empirical_kappa {ev.edge_id[:8]}…: MLE error ({e}), "
            f"n_cohorts={len(k_arr)}"
        )
        return None


def _predictive_mu_sd(
    mu_samples: "np.ndarray",
    sigma_samples: "np.ndarray",
    onset_samples: "np.ndarray | None",
    p_samples: "np.ndarray",
    kl_samples: "np.ndarray",
    trajectories: list,
    diagnostics: list[str],
    edge_id: str,
) -> float | None:
    """Compute predictive mu_sd from kappa_lat via MC simulation.

    For each MCMC draw × each valid trajectory, simulate a BetaBinomial
    maturation curve and fit mu* via weighted least-squares across all
    intervals. The SD of mu* across (draw, trajectory) pairs is the
    predictive mu_sd.

    Fixes over the original implementation:
      #1 Uses ALL valid trajectories, not one representative
      #2 Sequential n_at_risk from realised BetaBinomial draws
      #3 Multi-point WLS fit across all intervals, not single-point inversion
      #5 Floor derived from quadrature: sqrt(posterior² + aleatoric²)

    Returns None if insufficient trajectory data or if the MC fails.
    """
    import numpy as np
    from scipy.special import ndtr, ndtri

    valid_trajs = [t for t in trajectories
                   if len(t.retrieval_ages) >= 3 and t.n >= 10]
    if not valid_trajs:
        return None

    # Cap trajectories to avoid excessive computation
    max_trajs = 20
    if len(valid_trajs) > max_trajs:
        # Prefer trajectories with more intervals (richer signal)
        valid_trajs = sorted(valid_trajs, key=lambda t: len(t.retrieval_ages),
                             reverse=True)[:max_trajs]

    # Subsample MCMC draws for speed.
    N = len(mu_samples)
    max_draws = 1000
    rng = np.random.default_rng(42)
    if N > max_draws:
        idx = rng.choice(N, max_draws, replace=False)
        mu_s = mu_samples[idx]
        sigma_s = sigma_samples[idx]
        onset_s = onset_samples[idx] if onset_samples is not None else np.zeros(max_draws)
        p_s = p_samples[idx]
        kl_s = kl_samples[idx]
    else:
        mu_s = mu_samples
        sigma_s = sigma_samples
        onset_s = onset_samples if onset_samples is not None else np.zeros(N)
        p_s = p_samples
        kl_s = kl_samples

    S = len(mu_s)
    all_mu_star = []

    for traj in valid_trajs:
        ages = np.array(traj.retrieval_ages, dtype=np.float64)
        n_pop = float(traj.n)
        J = len(ages)
        if J < 3 or n_pop < 10:
            continue

        # Vectorised CDF: shape (S, J)
        ages_2d = ages[np.newaxis, :]
        onset_2d = onset_s[:, np.newaxis]
        mu_2d = mu_s[:, np.newaxis]
        sigma_2d = np.maximum(sigma_s[:, np.newaxis], 0.01)

        effective_age = np.maximum(ages_2d - onset_2d, 1e-12)
        z = (np.log(effective_age) - mu_2d) / sigma_2d
        cdf_all = np.where(ages_2d > onset_2d, ndtr(z), 0.0)
        cdf_all = np.clip(cdf_all, 0.0, 1.0)

        # Conditional hazards q_j
        p_2d = p_s[:, np.newaxis]
        cdf_prev = np.zeros_like(cdf_all)
        cdf_prev[:, 1:] = cdf_all[:, :-1]
        delta_F = np.maximum(cdf_all - cdf_prev, 1e-12)
        surv = np.maximum(1.0 - p_2d * cdf_prev, 1e-12)
        q_j = np.clip(p_2d * delta_F / surv, 1e-12, 1.0 - 1e-12)

        # Fix #2: sequential n_at_risk from realised BetaBinomial draws.
        # Draw d_j, update n_at_risk for the next interval.
        kl_2d = kl_s[:, np.newaxis]
        alpha_bb = np.maximum(q_j * kl_2d, 0.01)
        beta_bb = np.maximum((1.0 - q_j) * kl_2d, 0.01)

        n_at_risk = np.full((S, J), n_pop)
        d_sim = np.zeros((S, J), dtype=int)
        for j in range(J):
            p_j = rng.beta(alpha_bb[:, j], beta_bb[:, j])
            p_j = np.clip(p_j, 1e-12, 1.0 - 1e-12)
            n_j = np.maximum(n_at_risk[:, j].astype(int), 0)
            d_sim[:, j] = rng.binomial(n_j, p_j)
            if j < J - 1:
                n_at_risk[:, j + 1] = np.maximum(n_at_risk[:, j] - d_sim[:, j], 0)

        # Realised cumulative fraction
        cum_d = np.cumsum(d_sim, axis=1)
        realised_frac = cum_d / n_pop  # (S, J)

        # Fix #3: multi-point WLS fit for mu* per draw.
        # For each draw, fit mu* to the simulated curve using
        # weighted least-squares on the inverse-CDF transform:
        #   Φ⁻¹(realised_frac / p) ≈ (log(t - onset) - mu*) / sigma
        # Rearranging: mu* = log(t - onset) - sigma × Φ⁻¹(realised_frac / p)
        # Use all intervals where 0.01 < realised_frac/p < 0.99.
        # Weight by CDF gradient (most informative near CDF = 0.5).
        eff_age_2d = np.maximum(ages_2d - onset_2d, 1e-12)
        log_eff_age = np.log(eff_age_2d)  # (S, J)

        # target CDF per interval: realised_frac / p
        target = realised_frac / np.maximum(p_2d, 1e-6)
        target = np.clip(target, 0.001, 0.999)

        # Inverse normal of target: Φ⁻¹(target)
        phi_inv = ndtri(target)  # (S, J)

        # mu* per interval: log(t-onset) - sigma × Φ⁻¹(target)
        mu_star_all = log_eff_age - sigma_2d * phi_inv  # (S, J)

        # Weight: CDF gradient φ(z) — intervals near CDF=0.5 are most informative
        from scipy.stats import norm as _norm
        weight = _norm.pdf(phi_inv)  # (S, J)

        # Mask degenerate intervals
        usable = (target > 0.01) & (target < 0.99) & np.isfinite(mu_star_all) & (weight > 1e-6)
        n_usable = usable.sum(axis=1)  # (S,)

        # Weighted mean mu* per draw
        weight_masked = np.where(usable, weight, 0.0)
        w_sum = weight_masked.sum(axis=1)
        mu_star_draw = np.where(
            w_sum > 0,
            (weight_masked * mu_star_all).sum(axis=1) / w_sum,
            np.nan,
        )

        # Keep draws with at least 2 usable intervals
        good = (n_usable >= 2) & np.isfinite(mu_star_draw) & (np.abs(mu_star_draw - mu_s) < 5.0)
        all_mu_star.append(mu_star_draw[good])

    if not all_mu_star:
        diagnostics.append(
            f"  predictive_mu {edge_id[:8]}…: no valid trajectories for MC"
        )
        return None

    mu_star_pooled = np.concatenate(all_mu_star)
    if len(mu_star_pooled) < 50:
        diagnostics.append(
            f"  predictive_mu {edge_id[:8]}…: too few valid MC fits "
            f"({len(mu_star_pooled)}), falling back to posterior SD"
        )
        return None

    aleatoric_sd = float(np.std(mu_star_pooled))
    posterior_sd = float(np.std(mu_s))

    # Fix #5: principled floor via quadrature.
    # predictive_sd² = posterior_sd² + aleatoric_sd²
    # The posterior SD is irreducible epistemic uncertainty; aleatoric_sd
    # is the timing noise from kappa_lat. The predictive SD combines both.
    predictive_sd = float(np.sqrt(posterior_sd ** 2 + aleatoric_sd ** 2))

    diagnostics.append(
        f"  predictive_mu {edge_id[:8]}…: sd={predictive_sd:.4f} "
        f"(posterior={posterior_sd:.4f}, aleatoric={aleatoric_sd:.4f}, "
        f"n_trajs={len(valid_trajs)}, n_fits={len(mu_star_pooled)}/{S * len(valid_trajs)})"
    )

    return predictive_sd


def summarise_posteriors(
    trace,
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
    metadata: dict,
    quality: QualityMetrics,
    phase1_kappa: dict[str, "np.ndarray"] | None = None,
    settings: dict | None = None,
    loo_scores: dict | None = None,
    calibration_scores: dict | None = None,
) -> InferenceResult:
    """Extract posterior summaries from the MCMC trace.

    Produces PosteriorSummary per edge and LatencyPosteriorSummary
    for edges with latency (Phase A: echoes the fixed point estimate).

    loo_scores: optional {edge_id: EdgeLooMetrics} from compute_loo_scores().
    """
    import arviz as az
    import numpy as np
    from datetime import datetime

    _settings = settings or {}
    _recency_hl = float(_settings.get("RECENCY_HALF_LIFE_DAYS", 30))
    _today = datetime.now()

    edge_var_names = metadata.get("edge_var_names", {})
    rhat_ds = az.rhat(trace)

    # Build posterior latency dict for ALL edges — used by both
    # window and cohort kappa estimation (CDF adjustment).
    _all_post_latency: dict[str, dict] = {}
    for _eid in topology.edges:
        _seid = _safe_var_name(_eid)
        _mu_name = f"mu_lat_{_seid}"
        _sigma_name = f"sigma_lat_{_seid}"
        _onset_name = f"onset_{_seid}"
        if _mu_name in trace.posterior:
            _all_post_latency[_eid] = {
                "mu": float(trace.posterior[_mu_name].values.mean()),
                "sigma": float(trace.posterior[_sigma_name].values.mean()) if _sigma_name in trace.posterior else 0.5,
                "onset": float(trace.posterior[_onset_name].values.mean()) if _onset_name in trace.posterior else 0.0,
            }
        else:
            # No latent latency for this edge — use evidence prior if available
            _ev = evidence.edges.get(_eid)
            if _ev and _ev.latency_prior:
                _all_post_latency[_eid] = {
                    "mu": _ev.latency_prior.mu,
                    "sigma": _ev.latency_prior.sigma,
                    "onset": _ev.latency_prior.onset_delta_days or 0.0,
                }
    ess_ds = az.ess(trace)

    posteriors: list[PosteriorSummary] = []
    latency_posteriors: dict[str, LatencyPosteriorSummary] = {}
    skipped: list[dict[str, str]] = []
    diagnostics: list[str] = list(metadata.get("diagnostics", []))

    for edge_id, et in topology.edges.items():
        ev = evidence.edges.get(edge_id)
        if ev is None:
            continue

        if ev.skipped:
            skipped.append({"param_id": ev.param_id, "reason": ev.skip_reason})
            continue

        var_name = edge_var_names.get(edge_id)
        if var_name is None:
            diagnostics.append(f"SKIP {edge_id[:8]}…: no variable in model")
            skipped.append({"param_id": ev.param_id, "reason": "not in model"})
            continue

        # Find the primary p variable to summarise
        # For hierarchical edges: use p_base (the anchor parameter)
        # The consumer gets the base rate; window/cohort deviations are diagnostics
        p_var_name = var_name

        if p_var_name not in trace.posterior:
            diagnostics.append(f"SKIP {edge_id[:8]}…: {p_var_name} not in trace")
            skipped.append({"param_id": ev.param_id, "reason": f"{p_var_name} not in trace"})
            continue

        # Use recent p if drift is active (current-regime estimate).
        # p_window_recent includes both the drift delta AND the window
        # offset — it's the full current-regime window estimate.
        safe_eid = _safe_var_name(edge_id)
        recent_p_name = f"p_window_recent_{safe_eid}"
        window_p_name = f"p_window_{safe_eid}"
        if recent_p_name in trace.posterior:
            samples = trace.posterior[recent_p_name].values.flatten()
            # Compare against p_window (historic) for the drift diagnostic
            if window_p_name in trace.posterior:
                p_historic = float(np.mean(trace.posterior[window_p_name].values.flatten()))
            else:
                p_historic = float(np.mean(trace.posterior[p_var_name].values.flatten()))
            diagnostics.append(
                f"  p_drift {edge_id[:8]}…: recent={float(np.mean(samples)):.4f} "
                f"vs historic={p_historic:.4f}"
            )
        else:
            samples = trace.posterior[p_var_name].values.flatten()

        # MCMC kappa: the unified per-edge κ from Phase 1, constrained
        # by daily BetaBinomial + endpoint BB (journal 30-Mar-26).
        kappa_name = f"kappa_{safe_eid}"
        mcmc_kappa = float(np.mean(trace.posterior[kappa_name].values.flatten())) if kappa_name in trace.posterior else None

        # Post-MCMC MLE on window data for diagnostic comparison.
        post_latency = {}
        mu_lat_name = f"mu_lat_{safe_eid}"
        sigma_lat_name = f"sigma_lat_{safe_eid}"
        onset_lat_name = f"onset_{safe_eid}"
        if mu_lat_name in trace.posterior:
            post_latency[edge_id] = {
                "mu": float(trace.posterior[mu_lat_name].values.mean()),
                "sigma": float(trace.posterior[sigma_lat_name].values.mean()) if sigma_lat_name in trace.posterior else (ev.latency_prior.sigma if ev.latency_prior else 0.5),
                "onset": float(trace.posterior[onset_lat_name].values.mean()) if onset_lat_name in trace.posterior else (ev.latency_prior.onset_delta_days if ev.latency_prior else 0.0),
            }
        mle_kappa = _estimate_cohort_kappa(
            ev, et, topology, float(np.mean(samples)), diagnostics,
            obs_type_filter="window",
            phase2_frozen=post_latency,
            recency_half_life=_recency_hl,
            today_date=_today,
        )

        # MCMC kappa is the source of truth. MLE is diagnostic only.
        # See journal 30-Mar-26 "abandon external MLE".
        effective_kappa = mcmc_kappa

        if effective_kappa is not None:
            mu_p_samples = samples
            # Use MCMC kappa samples for the predictive (full posterior)
            kappa_samples = trace.posterior[kappa_name].values.flatten() if kappa_name in trace.posterior else np.full_like(samples, effective_kappa)
            kappa_arr = kappa_samples[:len(mu_p_samples)]
            a_samples = np.maximum(mu_p_samples * kappa_arr, 0.01)
            b_samples = np.maximum((1.0 - mu_p_samples) * kappa_arr, 0.01)
            predictive_samples = np.random.beta(a_samples, b_samples)
            alpha, beta_val = _fit_beta_to_samples(predictive_samples)
            pred_hdi = az.hdi(predictive_samples, hdi_prob=HDI_PROB)
            hdi_lower = float(pred_hdi[0])
            hdi_upper = float(pred_hdi[1])
            diagnostics.append(
                f"  predictive_p {edge_id[:8]}…: mu_p={float(np.mean(mu_p_samples)):.4f}, "
                f"kappa_mcmc={mcmc_kappa or 0:.1f}, "
                f"kappa_mle={mle_kappa or 0:.1f}, "
                f"kappa_used={effective_kappa:.1f}, "
                f"pred_alpha={alpha:.1f}, pred_beta={beta_val:.1f}"
            )
        else:
            # No hierarchical Beta — moment-match directly from p samples
            alpha, beta_val = _fit_beta_to_samples(samples)
            # HDI (handle both scalar and multi-dimensional variables)
            hdi = az.hdi(trace, var_names=[p_var_name], hdi_prob=HDI_PROB)
            hdi_vals = hdi[p_var_name].values
            if hdi_vals.ndim == 1:
                hdi_lower = float(hdi_vals[0])
                hdi_upper = float(hdi_vals[1])
            else:
                hdi_lower = float(hdi_vals.flat[0])
                hdi_upper = float(hdi_vals.flat[1])

        # Per-variable diagnostics (handle multi-dimensional Dirichlet components)
        edge_rhat = 0.0
        if p_var_name in rhat_ds:
            rhat_arr = rhat_ds[p_var_name].values
            edge_rhat = float(rhat_arr.flat[0]) if rhat_arr.size > 0 else 0.0
        edge_ess = 0.0
        if p_var_name in ess_ds:
            ess_arr = ess_ds[p_var_name].values
            edge_ess = float(ess_arr.flat[0]) if ess_arr.size > 0 else 0.0

        edge_converged = edge_rhat < RHAT_THRESHOLD and edge_ess >= ESS_THRESHOLD
        if ev.total_n == 0:
            provenance = "point-estimate"
        elif edge_converged:
            provenance = "bayesian"
        else:
            provenance = "pooled-fallback"
            diagnostics.append(
                f"WARN {edge_id[:8]}…: rhat={edge_rhat:.3f} ess={edge_ess:.0f}"
            )

        # Doc 21: extract p_window and p_cohort separately for per-slice posteriors.
        # When kappa exists, use posterior predictive samples so alpha/beta
        # reflect between-day variation, not just estimation precision.
        window_alpha_val = None
        window_beta_val = None
        window_hdi_lo = None
        window_hdi_hi = None
        cohort_alpha_val = None
        cohort_beta_val = None
        cohort_hdi_lo = None
        cohort_hdi_hi = None

        safe_eid = _safe_var_name(edge_id)
        p_window_name = f"p_window_{safe_eid}"
        p_cohort_name = f"p_cohort_{safe_eid}"
        p_single_name = f"p_{safe_eid}"
        kappa_name_local = f"kappa_{safe_eid}"
        has_kappa = kappa_name_local in trace.posterior

        def _predictive_alpha_beta(p_samples, kappa_samples=None):
            """Generate predictive samples using kappa if available; else moment-match."""
            if kappa_samples is not None:
                n_use = min(len(p_samples), len(kappa_samples))
                a_s = np.maximum(p_samples[:n_use] * kappa_samples[:n_use], 0.01)
                b_s = np.maximum((1.0 - p_samples[:n_use]) * kappa_samples[:n_use], 0.01)
                pred = np.random.beta(a_s, b_s)
                ab = _fit_beta_to_samples(pred)
                hdi_vals = az.hdi(pred, hdi_prob=HDI_PROB)
                return ab[0], ab[1], float(hdi_vals[0]), float(hdi_vals[1])
            else:
                ab = _fit_beta_to_samples(p_samples)
                hdi_vals = az.hdi(p_samples, hdi_prob=HDI_PROB)
                return ab[0], ab[1], float(hdi_vals[0]), float(hdi_vals[1])

        # Resolve kappa samples for window predictive.
        kp_samples = None
        if has_kappa:
            kp_samples = trace.posterior[kappa_name_local].values.flatten()

        # For window: prefer p_window_recent (drift-adjusted) if available,
        # then p_window, then p (Phase 1: single p, no hierarchy).
        p_window_recent_name = f"p_window_recent_{safe_eid}"
        w_name = (p_window_recent_name if p_window_recent_name in trace.posterior
                  else p_window_name if p_window_name in trace.posterior
                  else p_single_name)

        if w_name in trace.posterior:
            w_samples = trace.posterior[w_name].values.flatten()
            window_alpha_val, window_beta_val, window_hdi_lo, window_hdi_hi = _predictive_alpha_beta(
                w_samples, kappa_samples=kp_samples)

        if p_cohort_name in trace.posterior:
            c_samples = trace.posterior[p_cohort_name].values.flatten()
            # Empirical kappa from Williams method on cohort trajectory
            # residuals. Measures actual between-cohort variation from
            # data, not proxied from window kappa. See journal 28-Mar-26.
            cohort_kappa_empirical = _estimate_cohort_kappa(
                ev, et, topology, float(np.mean(c_samples)), diagnostics,
                phase2_frozen=_all_post_latency,
                recency_half_life=_recency_hl,
                today_date=_today,
            )
            if cohort_kappa_empirical is not None:
                # Convert scalar kappa to array matching p_cohort samples
                kappa_arr = np.full_like(c_samples, cohort_kappa_empirical)
                cohort_alpha_val, cohort_beta_val, cohort_hdi_lo, cohort_hdi_hi = _predictive_alpha_beta(
                    c_samples, kappa_samples=kappa_arr)
            else:
                # Insufficient cohort data — fall back to moment-matching
                cohort_alpha_val, cohort_beta_val, cohort_hdi_lo, cohort_hdi_hi = _predictive_alpha_beta(
                    c_samples)

        # Derive mean/stdev from alpha/beta for consistency.
        # When predictive (hierarchical Beta), alpha/beta encode the
        # generative distribution — mean and stdev must match.
        p_mean = float(alpha / (alpha + beta_val)) if (alpha + beta_val) > 0 else float(np.mean(samples))
        p_stdev = float(np.sqrt(alpha * beta_val / ((alpha + beta_val) ** 2 * (alpha + beta_val + 1)))) if (alpha + beta_val) > 0 else float(np.std(samples))

        posteriors.append(PosteriorSummary(
            edge_id=edge_id,
            param_id=ev.param_id,
            alpha=alpha,
            beta=beta_val,
            mean=p_mean,
            stdev=p_stdev,
            hdi_lower=hdi_lower,
            hdi_upper=hdi_upper,
            hdi_level=HDI_PROB,
            ess=edge_ess,
            rhat=edge_rhat,
            divergences=quality.total_divergences,
            provenance=provenance,
            prior_tier=ev.prob_prior.source,
            window_alpha=window_alpha_val,
            window_beta=window_beta_val,
            window_hdi_lower=window_hdi_lo,
            window_hdi_upper=window_hdi_hi,
            cohort_alpha=cohort_alpha_val,
            cohort_beta=cohort_beta_val,
            cohort_hdi_lower=cohort_hdi_lo,
            cohort_hdi_upper=cohort_hdi_hi,
        ))

        # Phase C: extract per-slice posteriors from trace (doc 14 §5.2)
        if ev.has_slices:
            post = posteriors[-1]  # the PosteriorSummary we just appended
            tau_name = f"tau_slice_{safe_eid}"
            if tau_name in trace.posterior:
                tau_samples = trace.posterior[tau_name].values.flatten()
                post.tau_slice_mean = float(np.mean(tau_samples))
                post.tau_slice_sd = float(np.std(tau_samples))

            # Unpack per-slice posteriors from vector RVs using
            # slice_axes metadata (doc 38 §Native Vector Batching).
            _sa = metadata.get("slice_axes", {}).get(edge_id)
            _p_vec_name = f"p_slice_vec_{safe_eid}"
            _k_vec_name = f"kappa_slice_vec_{safe_eid}"
            _mu_vec_name = f"mu_slice_vec_{safe_eid}"

            for _dim_key, _group in ev.slice_groups.items():
                for _ctx_key, _s_obs in _group.slices.items():
                    _ctx_safe = _safe_var_name(_ctx_key)
                    # Look up slice index from metadata
                    _si = _sa["ctx_to_idx"][_ctx_key] if _sa else None

                    # --- p samples: vector path (preferred) or scalar fallback ---
                    if _si is not None and _p_vec_name in trace.posterior:
                        _ps_samples = trace.posterior[_p_vec_name].values[:, :, _si].flatten()
                    else:
                        _ps_scalar = f"p_slice_{safe_eid}_{_ctx_safe}"
                        if _ps_scalar not in trace.posterior:
                            continue
                        _ps_samples = trace.posterior[_ps_scalar].values.flatten()

                    _ps_mean = float(np.mean(_ps_samples))
                    _ps_std = float(np.std(_ps_samples))
                    _ps_hdi = az.hdi(_ps_samples, hdi_prob=HDI_PROB)
                    _ps_ab = _fit_beta_to_samples(_ps_samples)

                    # --- kappa samples: vector path or scalar fallback ---
                    _ks_samples = None
                    if _si is not None and _k_vec_name in trace.posterior:
                        _ks_samples = trace.posterior[_k_vec_name].values[:, :, _si].flatten()
                    else:
                        _ks_scalar = f"kappa_slice_{safe_eid}_{_ctx_safe}"
                        if _ks_scalar in trace.posterior:
                            _ks_samples = trace.posterior[_ks_scalar].values.flatten()

                    if _ks_samples is not None:
                        # Predictive distribution: Beta(p*kappa, (1-p)*kappa)
                        _n_use = min(len(_ps_samples), len(_ks_samples))
                        _pred_alpha, _pred_beta, _pred_hdi_lo, _pred_hdi_hi = _predictive_alpha_beta(
                            _ps_samples[:_n_use], kappa_samples=_ks_samples[:_n_use])
                        _pred_mean = float(_pred_alpha / (_pred_alpha + _pred_beta))
                        _pred_std = float(np.sqrt(
                            _pred_alpha * _pred_beta /
                            ((_pred_alpha + _pred_beta) ** 2 * (_pred_alpha + _pred_beta + 1))
                        ))
                    else:
                        _pred_alpha, _pred_beta = _ps_ab
                        _pred_hdi_lo, _pred_hdi_hi = float(_ps_hdi[0]), float(_ps_hdi[1])
                        _pred_mean, _pred_std = _ps_mean, _ps_std

                    _slice_entry = {
                        "mean": _pred_mean,
                        "stdev": _pred_std,
                        "alpha": _pred_alpha,
                        "beta": _pred_beta,
                        "hdi_lower": _pred_hdi_lo,
                        "hdi_upper": _pred_hdi_hi,
                    }
                    if _ks_samples is not None:
                        _slice_entry["kappa_mean"] = float(np.mean(_ks_samples))
                        _slice_entry["kappa_sd"] = float(np.std(_ks_samples))

                    # --- Per-slice latency: vector path or scalar fallback ---
                    if _si is not None and _mu_vec_name in trace.posterior:
                        _mu_s = trace.posterior[_mu_vec_name].values[:, :, _si].flatten()
                        _slice_entry["mu_mean"] = float(np.mean(_mu_s))
                        _slice_entry["mu_sd"] = float(np.std(_mu_s))
                        # Latency dispersion (doc 34): per-slice kappa_lat
                        for _sot in ("cohort", "window"):
                            _sc = f"kappa_lat_{safe_eid}__{_ctx_safe}_{_sot}"
                            if _sc in trace.posterior:
                                _skl = trace.posterior[_sc].values.flatten()
                                _slice_entry["kappa_lat_mean"] = float(np.mean(_skl))
                                _slice_entry["kappa_lat_sd"] = float(np.std(_skl))
                                break
                    else:
                        _mu_s_name = f"mu_slice_{safe_eid}_{_ctx_safe}"
                        if _mu_s_name in trace.posterior:
                            _slice_entry["mu_mean"] = float(trace.posterior[_mu_s_name].values.mean())
                            _slice_entry["mu_sd"] = float(trace.posterior[_mu_s_name].values.std())
                    # sigma and onset are edge-level (doc 38) — inherit from
                    # edge-level latency so per-slice summary isn't blank.
                    _sigma_var = f"sigma_lat_{safe_eid}"
                    if _sigma_var in trace.posterior:
                        _slice_entry["sigma_mean"] = float(np.mean(trace.posterior[_sigma_var].values.flatten()))
                        _slice_entry["sigma_sd"] = float(np.std(trace.posterior[_sigma_var].values.flatten()))
                    _onset_var = f"onset_{safe_eid}"
                    if _onset_var in trace.posterior:
                        _slice_entry["onset_mean"] = float(np.mean(trace.posterior[_onset_var].values.flatten()))
                        _slice_entry["onset_sd"] = float(np.std(trace.posterior[_onset_var].values.flatten()))
                    elif et and hasattr(et, 'onset_delta_days'):
                        _slice_entry["onset_mean"] = float(et.onset_delta_days)

                    post.slice_posteriors[_ctx_key] = _slice_entry

                    _kappa_str = ""
                    if "kappa_mean" in _slice_entry:
                        _kappa_str = f" kappa={_slice_entry['kappa_mean']:.1f}±{_slice_entry['kappa_sd']:.1f}"
                    _lat_str = ""
                    if "mu_mean" in _slice_entry:
                        _lat_str = f" mu={_slice_entry['mu_mean']:.3f}±{_slice_entry['mu_sd']:.3f}"
                        if "sigma_mean" in _slice_entry:
                            _lat_str += f" sigma={_slice_entry['sigma_mean']:.3f}±{_slice_entry['sigma_sd']:.3f}"
                        if "onset_mean" in _slice_entry:
                            _lat_str += f" onset={_slice_entry['onset_mean']:.2f}±{_slice_entry['onset_sd']:.2f}"
                    diagnostics.append(
                        f"  p_slice {edge_id[:8]}… {_ctx_key}: "
                        f"{_pred_mean:.4f}±{_pred_std:.4f} "
                        f"HDI=[{_pred_hdi_lo:.4f}, {_pred_hdi_hi:.4f}]"
                        f"{_kappa_str}{_lat_str}"
                    )

            if post.tau_slice_mean is not None:
                diagnostics.append(
                    f"  tau_slice {edge_id[:8]}…: {post.tau_slice_mean:.3f}±{post.tau_slice_sd:.3f}"
                )

        # Latency posterior: extract from MCMC trace if latent, else echo prior
        if et.has_latency and ev.latency_prior:
            lp = ev.latency_prior
            onset = lp.onset_delta_days
            safe_eid = _safe_var_name(edge_id)
            mu_var_name = f"mu_lat_{safe_eid}"
            sigma_var_name = f"sigma_lat_{safe_eid}"

            latent_edges = metadata.get("latent_latency_edges", set())
            latent_onset_edges = metadata.get("latent_onset_edges", set())
            is_latent = (
                edge_id in latent_edges
                and mu_var_name in trace.posterior
                and sigma_var_name in trace.posterior
            )

            if is_latent:
                # Use recent mu if drift is active
                mu_recent_name = f"mu_recent_{safe_eid}"
                if mu_recent_name in trace.posterior:
                    mu_samples = trace.posterior[mu_recent_name].values.flatten()
                    mu_base_val = float(np.mean(trace.posterior[mu_var_name].values.flatten()))
                    diagnostics.append(
                        f"  mu_drift {edge_id[:8]}…: using recent mu "
                        f"(base={mu_base_val:.3f}, recent={float(np.mean(mu_samples)):.3f})"
                    )
                else:
                    mu_samples = trace.posterior[mu_var_name].values.flatten()
                sigma_samples = trace.posterior[sigma_var_name].values.flatten()

                mu_mean = float(np.mean(mu_samples))
                mu_sd = float(np.std(mu_samples))
                sigma_mean = float(np.mean(sigma_samples))
                sigma_sd = float(np.std(sigma_samples))

                # Onset: latent posterior or fixed
                onset_var_name = f"onset_{safe_eid}"
                has_latent_onset = (
                    edge_id in latent_onset_edges
                    and onset_var_name in trace.posterior
                )
                if has_latent_onset:
                    onset_samples = trace.posterior[onset_var_name].values.flatten()
                    onset_post_mean = float(np.mean(onset_samples))
                    onset_post_sd = float(np.std(onset_samples))
                    onset_hdi = az.hdi(onset_samples, hdi_prob=HDI_PROB)
                    onset_hdi_lower = float(onset_hdi[0])
                    onset_hdi_upper = float(onset_hdi[1])
                    # Correlation between onset and mu (identifiability diagnostic)
                    onset_mu_corr = float(np.corrcoef(onset_samples, mu_samples)[0, 1])
                    # Use posterior onset mean for t95
                    onset_for_t95 = onset_samples  # vectorised
                else:
                    onset_post_mean = None
                    onset_post_sd = None
                    onset_hdi_lower = None
                    onset_hdi_upper = None
                    onset_mu_corr = None
                    onset_for_t95 = onset  # fixed scalar

                # t95 HDI from posterior samples of the latency distribution
                t95_samples = np.exp(mu_samples + 1.645 * sigma_samples) + onset_for_t95
                t95_hdi = az.hdi(t95_samples, hdi_prob=HDI_PROB)
                t95_lower = float(t95_hdi[0])
                t95_upper = float(t95_hdi[1])

                # Per-variable convergence
                lat_rhat = 0.0
                lat_ess = 0.0
                if mu_var_name in rhat_ds:
                    lat_rhat = max(lat_rhat, float(rhat_ds[mu_var_name].values.flat[0]))
                if sigma_var_name in rhat_ds:
                    lat_rhat = max(lat_rhat, float(rhat_ds[sigma_var_name].values.flat[0]))
                if mu_var_name in ess_ds:
                    lat_ess = float(ess_ds[mu_var_name].values.flat[0])
                if sigma_var_name in ess_ds:
                    lat_ess = min(lat_ess, float(ess_ds[sigma_var_name].values.flat[0]))
                if has_latent_onset and onset_var_name in rhat_ds:
                    lat_rhat = max(lat_rhat, float(rhat_ds[onset_var_name].values.flat[0]))
                if has_latent_onset and onset_var_name in ess_ds:
                    lat_ess = min(lat_ess, float(ess_ds[onset_var_name].values.flat[0]))

                lat_provenance = "bayesian" if (lat_rhat < RHAT_THRESHOLD and lat_ess >= ESS_THRESHOLD) else "pooled-fallback"

                # Use posterior onset mean as canonical onset_delta_days when latent
                canonical_onset = onset_post_mean if has_latent_onset else onset

                # Latency dispersion (doc 34): extract kappa_lat if present.
                # kappa_lat is the timing analogue of kappa for p — it
                # captures per-interval overdispersion in the discrete-time
                # hazard via BetaBinomial. Variable name includes obs_type.
                kappa_lat_name = None
                for _ot in ("cohort", "window"):
                    _candidate = f"kappa_lat_{safe_eid}_{_ot}"
                    if _candidate in trace.posterior:
                        kappa_lat_name = _candidate
                        break
                kappa_lat_mean_val = None
                kappa_lat_sd_val = None
                if kappa_lat_name is not None:
                    _kl_samples = trace.posterior[kappa_lat_name].values.flatten()
                    kappa_lat_mean_val = float(np.mean(_kl_samples))
                    kappa_lat_sd_val = float(np.std(_kl_samples))

                # Predictive mu_sd from kappa_lat MC (doc 34).
                # When kappa_lat is available, simulate BetaBinomial
                # maturation curves and measure how much mu varies across
                # realisations. This replaces the epistemic posterior SD
                # with a proper predictive SD.
                if kappa_lat_name is not None:
                    _all_trajs = []
                    for _co in ev.cohort_obs:
                        _all_trajs.extend(_co.trajectories)
                    _onset_s_arr = (onset_samples if has_latent_onset
                                    else np.full_like(mu_samples, onset))
                    # Fix #6: match p_samples to kappa_lat obs_type.
                    # kappa_lat_name is e.g. "kappa_lat_{edge}_window" — the
                    # obs_type suffix tells us which p to use.
                    _kl_obs_type = kappa_lat_name.rsplit("_", 1)[-1]  # "window" or "cohort"
                    _p_for_kl_name = f"p_{_kl_obs_type}_{safe_eid}"
                    if _p_for_kl_name in trace.posterior:
                        _p_for_kl = trace.posterior[_p_for_kl_name].values.flatten()
                    else:
                        _p_for_kl = samples  # fallback to the main p samples
                    _pred_mu_sd = _predictive_mu_sd(
                        mu_samples, sigma_samples, _onset_s_arr,
                        _p_for_kl, _kl_samples, _all_trajs,
                        diagnostics, edge_id,
                    )
                    if _pred_mu_sd is not None:
                        mu_sd = _pred_mu_sd

                latency_posteriors[edge_id] = LatencyPosteriorSummary(
                    mu_mean=mu_mean,
                    mu_sd=mu_sd,
                    sigma_mean=sigma_mean,
                    sigma_sd=sigma_sd,
                    onset_delta_days=canonical_onset,
                    hdi_t95_lower=t95_lower,
                    hdi_t95_upper=t95_upper,
                    ess=lat_ess,
                    rhat=lat_rhat,
                    provenance=lat_provenance,
                    onset_mean=onset_post_mean,
                    onset_sd=onset_post_sd,
                    onset_hdi_lower=onset_hdi_lower,
                    onset_hdi_upper=onset_hdi_upper,
                    onset_mu_corr=onset_mu_corr,
                    kappa_lat_mean=kappa_lat_mean_val,
                    kappa_lat_sd=kappa_lat_sd_val,
                )
                diagnostics.append(
                    f"  latency {edge_id[:8]}…: mu={mu_mean:.3f}±{mu_sd:.3f} "
                    f"(prior={lp.mu:.3f}), sigma={sigma_mean:.3f}±{sigma_sd:.3f} "
                    f"(prior={lp.sigma:.3f}), rhat={lat_rhat:.3f}, ess={lat_ess:.0f}"
                    + (f", kappa_lat={kappa_lat_mean_val:.1f}±{kappa_lat_sd_val:.1f}"
                       if kappa_lat_mean_val is not None else "")
                )
                if has_latent_onset:
                    diagnostics.append(
                        f"  onset {edge_id[:8]}…: {onset_post_mean:.2f}±{onset_post_sd:.2f} "
                        f"(prior={onset:.2f}), corr(onset,mu)={onset_mu_corr:.3f}"
                    )
            else:
                # Phase S fallback: echo fixed point estimate
                mu = lp.mu
                sigma = lp.sigma
                t95_lower = math.exp(mu + 1.28 * sigma) + onset
                t95_upper = math.exp(mu + 2.0 * sigma) + onset

                latency_posteriors[edge_id] = LatencyPosteriorSummary(
                    mu_mean=mu,
                    mu_sd=abs(mu) * 0.03,
                    sigma_mean=sigma,
                    sigma_sd=sigma * 0.05,
                    onset_delta_days=onset,
                    hdi_t95_lower=t95_lower,
                    hdi_t95_upper=t95_upper,
                    provenance="point-estimate",
                )

        # Cohort-level (path) latency posterior
        cohort_edges = metadata.get("cohort_latency_edges", set())
        if edge_id in cohort_edges:
            safe_eid = _safe_var_name(edge_id)
            onset_name = f"onset_cohort_{safe_eid}"
            mu_name = f"mu_cohort_{safe_eid}"
            sigma_name = f"sigma_cohort_{safe_eid}"

            if mu_name in trace.posterior and sigma_name in trace.posterior:
                mu_c_samples = trace.posterior[mu_name].values.flatten()
                sigma_c_samples = trace.posterior[sigma_name].values.flatten()
                onset_c_samples = (
                    trace.posterior[onset_name].values.flatten()
                    if onset_name in trace.posterior else None
                )

                path_mu = float(np.mean(mu_c_samples))
                path_mu_sd = float(np.std(mu_c_samples))
                path_sigma = float(np.mean(sigma_c_samples))
                path_sigma_sd = float(np.std(sigma_c_samples))
                path_onset = float(np.mean(onset_c_samples)) if onset_c_samples is not None else 0.0
                path_onset_sd = float(np.std(onset_c_samples)) if onset_c_samples is not None else None
                if onset_c_samples is not None:
                    path_onset_hdi = az.hdi(onset_c_samples, hdi_prob=HDI_PROB)
                    path_onset_hdi_lower = float(path_onset_hdi[0])
                    path_onset_hdi_upper = float(path_onset_hdi[1])
                else:
                    path_onset_hdi_lower = None
                    path_onset_hdi_upper = None

                path_provenance = "bayesian"

                # Path-level t95 HDI from posterior samples
                onset_for_path_t95 = onset_c_samples if onset_c_samples is not None else np.full_like(mu_c_samples, path_onset)
                path_t95_samples = np.exp(mu_c_samples + 1.645 * sigma_c_samples) + onset_for_path_t95
                path_t95_hdi = az.hdi(path_t95_samples, hdi_prob=HDI_PROB)
                path_hdi_t95_lower = float(path_t95_hdi[0])
                path_hdi_t95_upper = float(path_t95_hdi[1])

                # Attach to existing latency posterior (or create one)
                if edge_id in latency_posteriors:
                    lat = latency_posteriors[edge_id]
                    lat.path_onset_delta_days = path_onset
                    lat.path_onset_sd = path_onset_sd
                    lat.path_onset_hdi_lower = path_onset_hdi_lower
                    lat.path_onset_hdi_upper = path_onset_hdi_upper
                    lat.path_mu_mean = path_mu
                    lat.path_mu_sd = path_mu_sd
                    lat.path_sigma_mean = path_sigma
                    lat.path_sigma_sd = path_sigma_sd
                    lat.path_hdi_t95_lower = path_hdi_t95_lower
                    lat.path_hdi_t95_upper = path_hdi_t95_upper
                    lat.path_provenance = path_provenance
                    # DIAGNOSTIC
                    print(f"[DIAG inference] {edge_id[:20]}: path_hdi_t95={path_hdi_t95_lower:.1f}—{path_hdi_t95_upper:.1f} "
                          f"(mu={path_mu:.3f}, sigma={path_sigma:.3f}, onset={path_onset:.1f})", flush=True)

                diagnostics.append(
                    f"  cohort_latency {edge_id[:8]}…: onset={path_onset:.1f}"
                    f"{'±' + f'{path_onset_sd:.1f}' if path_onset_sd else ''}, "
                    f"mu={path_mu:.3f}±{path_mu_sd:.3f}, "
                    f"sigma={path_sigma:.3f}±{path_sigma_sd:.3f}"
                )

    # Per-edge overdispersion concentration κ
    for edge_id in topology.edges:
        safe_eid = _safe_var_name(edge_id)
        kappa_name = f"kappa_{safe_eid}"
        if kappa_name in trace.posterior:
            kappa_samples = trace.posterior[kappa_name].values.flatten()
            kappa_mean = float(np.mean(kappa_samples))
            kappa_sd = float(np.std(kappa_samples))
            diagnostics.append(
                f"  kappa {edge_id[:8]}…: {kappa_mean:.1f}±{kappa_sd:.1f} "
                f"(large=Binomial, small=overdispersed)"
            )

    # Doc 21: collect model_state — hierarchy/shared params for warm-start.
    # These are posterior means of model internals, persisted for subsequent
    # runs but never consumed by the FE.
    model_state: dict[str, float] = {}
    for edge_id in topology.edges:
        safe_eid = _safe_var_name(edge_id)
        # p_base (legacy hierarchy) or p (Phase 1: single variable)
        for p_prefix in ("p_base", "p"):
            p_name = f"{p_prefix}_{safe_eid}"
            if p_name in trace.posterior:
                p_samples = trace.posterior[p_name].values.flatten()
                p_a, p_b = _fit_beta_to_samples(p_samples)
                model_state[f"p_base_alpha_{safe_eid}"] = round(p_a, 4)
                model_state[f"p_base_beta_{safe_eid}"] = round(p_b, 4)
                break
        # tau_window / tau_cohort
        for prefix in ("tau_window", "tau_cohort"):
            vname = f"{prefix}_{safe_eid}"
            if vname in trace.posterior:
                model_state[vname] = round(float(np.mean(trace.posterior[vname].values.flatten())), 4)
        # kappa (unified per-edge overdispersion, journal 30-Mar-26)
        kappa_name = f"kappa_{safe_eid}"
        if kappa_name in trace.posterior:
            model_state[kappa_name] = round(float(np.mean(trace.posterior[kappa_name].values.flatten())), 2)
    # Graph-level onset hyperpriors
    for vname in ("onset_hyper_mu", "tau_onset"):
        if vname in trace.posterior:
            model_state[vname] = round(float(np.mean(trace.posterior[vname].values.flatten())), 4)

    # Attach LOO-ELPD scores (doc 32) if available
    if loo_scores:
        for ps in posteriors:
            loo = loo_scores.get(ps.edge_id)
            if loo:
                ps.elpd = loo.elpd
                ps.elpd_null = loo.elpd_null
                ps.delta_elpd = loo.delta_elpd
                ps.pareto_k_max = loo.pareto_k_max
                ps.n_loo_obs = loo.n_loo_obs
        for edge_id, lps in latency_posteriors.items():
            loo = loo_scores.get(edge_id)
            if loo:
                lps.elpd = loo.elpd
                lps.elpd_null = loo.elpd_null
                lps.delta_elpd = loo.delta_elpd
                lps.pareto_k_max = loo.pareto_k_max
                lps.n_loo_obs = loo.n_loo_obs
        # Graph-level LOO summary
        all_loo = list(loo_scores.values())
        if all_loo:
            quality.total_delta_elpd = sum(m.delta_elpd for m in all_loo)
            quality.worst_pareto_k = max(m.pareto_k_max for m in all_loo)
            quality.n_high_k = sum(1 for m in all_loo if m.pareto_k_max > 0.7)

    # Attach PPC calibration scores (doc 38) if available
    if calibration_scores:
        for ps in posteriors:
            cal = calibration_scores.get(ps.edge_id)
            if cal:
                if cal.endpoint_daily:
                    ps.ppc_coverage_90 = cal.endpoint_daily.coverage_90
                    ps.ppc_n_obs = cal.endpoint_daily.n_obs
                if cal.trajectory:
                    ps.ppc_traj_coverage_90 = cal.trajectory.coverage_90
                    ps.ppc_traj_n_obs = cal.trajectory.n_obs
        for edge_id, lps in latency_posteriors.items():
            cal = calibration_scores.get(edge_id)
            if cal and cal.trajectory:
                lps.ppc_traj_coverage_90 = cal.trajectory.coverage_90
                lps.ppc_traj_n_obs = cal.trajectory.n_obs

    return InferenceResult(
        posteriors=posteriors,
        latency_posteriors=latency_posteriors,
        quality=quality,
        model_state=model_state,
        skipped=skipped,
        diagnostics=diagnostics,
    )


# ---------------------------------------------------------------------------
# nutpie direct sampling (bypass pm.sample for progress callback access)
# ---------------------------------------------------------------------------

# Plain-text template — nutpie renders this via Jinja2 on the Rust side
# and passes the result to our callback every `progress_rate` ms.
_NUTPIE_PROGRESS_TEMPLATE = (
    "{{ total_finished_draws }}|{{ total_draws }}"
    "|{{ time_remaining_estimate }}"
    "|{{ finished_chains }}|{{ num_chains }}"
)


def _sample_nutpie(model, config: SamplingConfig, report_progress=None,
                   phase_label: str = ""):
    """Sample via nutpie directly, with real progress reporting.

    Calls nutpie.compile_pymc_model + nutpie.sample instead of going through
    pm.sample(nuts_sampler="nutpie").  This gives us access to nutpie's
    template_callback progress mechanism — real draw counts and ETA — which
    PyMC's wrapper doesn't expose.

    The ~15 lines of post-sampling InferenceData enrichment are replicated
    from PyMC's _sample_external_nuts (observed_data, constant_data, attrs).
    """
    import nutpie
    import pymc as pm
    from pymc.backends.arviz import (
        coords_and_dims_for_inferencedata,
        find_constants,
        find_observations,
    )
    from arviz import dict_to_dataset

    import threading

    prefix = f"{phase_label}: " if phase_label else ""

    # Heartbeat thread: reports elapsed time during both compilation and
    # sampling.  Once the Rust template_callback starts firing with real
    # draw counts, the heartbeat goes quiet.
    heartbeat_stop = threading.Event()
    sampling_started = threading.Event()
    t_phase_start = time.time()

    if report_progress:
        def _heartbeat():
            while not heartbeat_stop.is_set():
                heartbeat_stop.wait(3.0)
                if heartbeat_stop.is_set():
                    break
                elapsed = time.time() - t_phase_start
                if not sampling_started.is_set():
                    report_progress(
                        "compiling", 0,
                        f"{prefix}Compiling model… {elapsed:.0f}s",
                    )
                # Once sampling_started is set, the Rust callback handles it.

        hb_thread = threading.Thread(target=_heartbeat, daemon=True)
        hb_thread.start()
        report_progress("compiling", 0, f"{prefix}Compiling model…")

    t_compile_start = time.time()
    n_free = len(model.free_RVs)
    n_obs = len(model.observed_RVs)
    n_pot = len(model.potentials)
    n_det = len(model.deterministics)
    _backend = "jax" if config.jax_backend else "numba"
    _grad_backend = "jax" if config.jax_backend else "pytensor"
    _device_info = ""
    if config.jax_backend:
        try:
            import jax
            _devices = jax.devices()
            _device_info = f", jax_devices={[str(d) for d in _devices]}"
        except Exception:
            _device_info = ", jax_devices=unknown"
    print(f"[nutpie-compile] starting: {n_free} free, {n_obs} observed, "
          f"{n_pot} potentials, {n_det} deterministics, "
          f"backend={_backend}{_device_info}", flush=True)
    compiled_model = nutpie.compile_pymc_model(
        model, backend=_backend, gradient_backend=_grad_backend)
    t_sampling_start = time.time()
    print(f"[nutpie-compile] done: {int((t_sampling_start - t_compile_start) * 1000)}ms, "
          f"n_dim={compiled_model.n_dim}", flush=True)

    if report_progress:
        report_progress("sampling", 0, f"{prefix}Starting sampler…")

    sample_kwargs = dict(
        draws=config.draws,
        tune=config.tune,
        chains=config.chains,
        cores=config.cores,
        target_accept=config.target_accept,
        seed=config.random_seed,
        save_warmup=True,
        progress_bar=True,  # show nutpie's built-in terminal bar
    )

    if report_progress:
        # Use nutpie's template_callback: the Rust sampler renders our
        # template with live stats and calls _on_progress every 200ms.
        from nutpie import _lib as nutpie_lib

        def _on_nutpie_progress(formatted: str):
            try:
                sampling_started.set()
                parts = formatted.split("|")
                done = int(parts[0])
                total = int(parts[1])
                nutpie_eta = parts[2].strip()  # e.g. "2 minutes", "now"
                chains_done = int(parts[3])
                n_chains = int(parts[4])

                pct = int(100 * done / total) if total > 0 else 0

                if pct >= 100:
                    detail = f"{prefix}Finalising…"
                elif nutpie_eta and nutpie_eta != "now":
                    detail = f"{prefix}Sampling — {nutpie_eta} remaining"
                else:
                    detail = f"{prefix}Sampling…"

                report_progress("sampling", pct, detail)
            except Exception as exc:
                report_progress("sampling", 0, f"progress error: {exc}")

        # nutpie fires the callback every `progress_rate` ms from Rust.
        # We throttle on the Python side: only forward to report_progress
        # if ≥2s have elapsed or pct changed by ≥5pp.  This avoids spamming
        # the log / poll store while still giving responsive updates.
        _last_report = [0.0, -1]  # [timestamp, last_pct]

        _orig_on_progress = _on_nutpie_progress

        def _throttled_on_progress(formatted: str):
            now = time.time()
            # Always parse to get pct for throttle decision
            try:
                parts = formatted.split("|")
                done = int(parts[0])
                total = int(parts[1])
                pct = int(100 * done / total) if total > 0 else 0
            except (ValueError, IndexError):
                pct = -1

            elapsed_since_last = now - _last_report[0]
            pct_delta = abs(pct - _last_report[1])

            # Report if: first call, ≥2s elapsed, ≥5pp change, or done
            if (_last_report[0] == 0.0
                    or elapsed_since_last >= 2.0
                    or pct_delta >= 5
                    or pct >= 100):
                _last_report[0] = now
                _last_report[1] = pct
                _orig_on_progress(formatted)
                # Also print to stdout so it appears in Modal logs
                elapsed_total = time.time() - t_phase_start
                phase_tag = f" {phase_label}" if phase_label else ""
                print(f"[nutpie{phase_tag}] {pct}% ({done}/{total}) "
                      f"elapsed={elapsed_total:.0f}s eta={parts[2].strip()}",
                      flush=True)

        progress_type = nutpie_lib.ProgressType.template_callback(
            500,  # ms between Rust-side renders
            _NUTPIE_PROGRESS_TEMPLATE,
            config.cores or config.chains,
            _throttled_on_progress,
        )

        # Build the sampler manually so we can inject our ProgressType.
        # This mirrors what nutpie.sample() does internally.
        # Low-rank mass matrix captures parameter correlations (e.g.
        # tau-eps funnels, onset-mu ridges) that diagonal cannot.
        # Always on — the warmup overhead is negligible for small models
        # and the geometry benefit is significant for all but trivial ones.
        # See doc 38 §Low-rank mass matrix experiment.
        settings = nutpie_lib.PyNutsSettings.LowRank(config.random_seed)
        settings.num_tune = config.tune
        settings.num_draws = config.draws
        settings.num_chains = config.chains
        if config.target_accept is not None:
            settings.target_accept = config.target_accept

        import numpy as np
        init_mean = np.zeros(compiled_model.n_dim)
        store = nutpie_lib.PyStorage.arrow()

        import os
        cores = config.cores
        if cores is None:
            try:
                cores = os.process_cpu_count()
            except AttributeError:
                cores = os.cpu_count()
            cores = min(config.chains, cores)

        compile_ms = int((time.time() - t_phase_start) * 1000)
        phase_tag = f" {phase_label}" if phase_label else ""
        print(f"[nutpie{phase_tag}] cores={cores}, os.cpu_count={os.cpu_count()}, "
              f"chains={config.chains}, draws={config.draws}, tune={config.tune}, mass=lowrank, "
              f"compile={compile_ms}ms, n_dim={compiled_model.n_dim}", flush=True)

        sampler = compiled_model._make_sampler(
            settings, init_mean, cores, progress_type, store,
        )
        try:
            sampler.wait()
        except KeyboardInterrupt:
            sampler.abort()

        heartbeat_stop.set()
        results = sampler.take_results()

        # Release Rust sampler + progress callback before processing results.
        # Without this, Python shutdown can segfault when the Rust callback
        # closure outlives the Python objects it references.
        del sampler
        del progress_type

        # Convert raw arrow trace to arviz InferenceData
        from nutpie.sample import _arrow_to_arviz
        import pandas as pd

        draw_batches, stat_batches = results.get_arrow_trace()
        trace = _arrow_to_arviz(
            draw_batches,
            stat_batches,
            coords={
                name: pd.Index(vals)
                for name, vals in compiled_model.coords.items()
            },
            save_warmup=True,
        )
        del results
    else:
        # No progress callback — use nutpie.sample() directly (simpler)
        trace = nutpie.sample(compiled_model, **sample_kwargs)
        heartbeat_stop.set()

    # --- NUTS geometry diagnostics ---
    sampling_ms = int((time.time() - t_phase_start) * 1000) - compile_ms if 'compile_ms' in dir() else None
    _nuts_tag = f" {phase_label}" if phase_label else ""
    if hasattr(trace, "sample_stats"):
        _ss = trace.sample_stats
        _diag_parts = []
        if "depth" in _ss:
            import numpy as _np
            _depths = _ss["depth"].values.flatten()
            _diag_parts.append(
                f"tree_depth: mean={_np.mean(_depths):.1f}, "
                f"max={int(_np.max(_depths))}, "
                f"pct_at_max={100*_np.mean(_depths == _np.max(_depths)):.0f}%"
            )
        if "step_size" in _ss:
            import numpy as _np
            _steps = _ss["step_size"].values.flatten()
            _diag_parts.append(f"step_size: mean={_np.mean(_steps):.4f}")
        if "n_steps" in _ss:
            import numpy as _np
            _nsteps = _ss["n_steps"].values.flatten()
            _diag_parts.append(
                f"n_steps: mean={_np.mean(_nsteps):.0f}, "
                f"median={_np.median(_nsteps):.0f}, "
                f"max={int(_np.max(_nsteps))}"
            )
        if "energy" in _ss:
            import numpy as _np
            _energy = _ss["energy"].values.flatten()
            _diag_parts.append(f"energy: mean={_np.mean(_energy):.1f}, sd={_np.std(_energy):.1f}")
        if sampling_ms is not None:
            _diag_parts.append(f"sampling_ms={sampling_ms}")
        if _diag_parts:
            print(f"[nutpie{_nuts_tag}] NUTS diagnostics: {'; '.join(_diag_parts)}", flush=True)
        else:
            # List available keys so we can find the right names
            print(f"[nutpie{_nuts_tag}] sample_stats keys: {list(_ss.data_vars)}", flush=True)

    # Enrich InferenceData with observed/constant data and attrs,
    # same as PyMC's _sample_external_nuts does.
    coords, dims = coords_and_dims_for_inferencedata(model)
    constant_data = dict_to_dataset(
        find_constants(model),
        library=pm,
        coords=coords,
        dims=dims,
        default_dims=[],
    )
    observed_data = dict_to_dataset(
        find_observations(model),
        library=pm,
        coords=coords,
        dims=dims,
        default_dims=[],
    )
    from arviz.data.base import make_attrs
    attrs = make_attrs(
        {"tuning_steps": config.tune},
        library=nutpie,
    )
    for k, v in attrs.items():
        trace.posterior.attrs[k] = v
    trace.add_groups(
        {"constant_data": constant_data, "observed_data": observed_data},
        coords=coords,
        dims=dims,
    )

    # Compute per-observation log-likelihoods for LOO-ELPD scoring.
    # nutpie does not populate log_likelihood during sampling (nutpie#150);
    # pm.compute_log_likelihood evaluates log p(y_i|θ) for each posterior
    # draw and each named observation node, populating trace.log_likelihood.
    pm.compute_log_likelihood(trace, model=model, progressbar=False)

    return trace


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_var_name(edge_id: str) -> str:
    """Convert edge UUID to a safe PyMC variable name."""
    return edge_id.replace("-", "_")


def _fit_beta_to_samples(samples) -> tuple[float, float]:
    """Moment-match a Beta distribution to posterior samples."""
    import numpy as np

    mean = float(np.mean(samples))
    var = float(np.var(samples))

    if var <= 0 or mean <= 0 or mean >= 1:
        return 1.0, 1.0

    common = (mean * (1 - mean) / var) - 1
    if common <= 0:
        return 1.0, 1.0

    alpha = mean * common
    beta = (1 - mean) * common
    return float(alpha), float(beta)
