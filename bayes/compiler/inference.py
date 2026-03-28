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
            )

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


def summarise_posteriors(
    trace,
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
    metadata: dict,
    quality: QualityMetrics,
    phase1_kappa: dict[str, "np.ndarray"] | None = None,
) -> InferenceResult:
    """Extract posterior summaries from the MCMC trace.

    Produces PosteriorSummary per edge and LatencyPosteriorSummary
    for edges with latency (Phase A: echoes the fixed point estimate).
    """
    import arviz as az
    import numpy as np

    edge_var_names = metadata.get("edge_var_names", {})
    rhat_ds = az.rhat(trace)
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

        # Posterior predictive: if hierarchical Beta (kappa_p or
        # kappa_cohort) exists, generate predictive samples that include
        # between-cohort variation. This gives alpha/beta that reflect
        # real-world uncertainty (both estimation + cohort variation),
        # not just estimation precision.
        # See journal 27-Mar-26 "hierarchical Beta on p".
        kappa_p_name = f"kappa_p_{safe_eid}"
        if kappa_p_name in trace.posterior:
            mu_p_samples = samples  # these are mu_p posterior samples
            kappa_p_samples = trace.posterior[kappa_p_name].values.flatten()
            # Draw one p_new per MCMC sample from Beta(mu_p * kappa_p, (1-mu_p) * kappa_p)
            a_samples = np.maximum(mu_p_samples * kappa_p_samples, 0.01)
            b_samples = np.maximum((1.0 - mu_p_samples) * kappa_p_samples, 0.01)
            predictive_samples = np.random.beta(a_samples, b_samples)
            alpha, beta_val = _fit_beta_to_samples(predictive_samples)
            # HDI from predictive samples
            pred_hdi = az.hdi(predictive_samples, hdi_prob=HDI_PROB)
            hdi_lower = float(pred_hdi[0])
            hdi_upper = float(pred_hdi[1])
            diagnostics.append(
                f"  predictive_p {edge_id[:8]}…: mu_p={float(np.mean(mu_p_samples)):.4f}, "
                f"kappa_p={float(np.mean(kappa_p_samples)):.1f}, "
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
        # When hierarchical Beta exists (kappa_p), use posterior predictive samples
        # so alpha/beta reflect between-cohort variation, not just estimation precision.
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
        kappa_p_name = f"kappa_p_{safe_eid}"
        has_kappa_p = kappa_p_name in trace.posterior

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

        # Resolve kappa_p samples — from this trace (Phase 1) or from
        # phase1_kappa (passed through for Phase 2 Option C).
        kp_samples = None
        if has_kappa_p:
            kp_samples = trace.posterior[kappa_p_name].values.flatten()
        elif phase1_kappa and safe_eid in phase1_kappa:
            kp_samples = phase1_kappa[safe_eid]

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
            # Option C: use Phase 1's kappa_p for cohort predictive.
            # kp_samples comes from Phase 1 trace (via phase1_kappa dict).
            # See journal 28-Mar-26.
            cohort_alpha_val, cohort_beta_val, cohort_hdi_lo, cohort_hdi_hi = _predictive_alpha_beta(
                c_samples, kappa_samples=kp_samples)

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
                )
                diagnostics.append(
                    f"  latency {edge_id[:8]}…: mu={mu_mean:.3f}±{mu_sd:.3f} "
                    f"(prior={lp.mu:.3f}), sigma={sigma_mean:.3f}±{sigma_sd:.3f} "
                    f"(prior={lp.sigma:.3f}), rhat={lat_rhat:.3f}, ess={lat_ess:.0f}"
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
                    lat.path_provenance = path_provenance

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
        # kappa
        kappa_name = f"kappa_{safe_eid}"
        if kappa_name in trace.posterior:
            model_state[kappa_name] = round(float(np.mean(trace.posterior[kappa_name].values.flatten())), 2)
    # Graph-level onset hyperpriors
    for vname in ("onset_hyper_mu", "tau_onset"):
        if vname in trace.posterior:
            model_state[vname] = round(float(np.mean(trace.posterior[vname].values.flatten())), 4)

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

    compiled_model = nutpie.compile_pymc_model(model)
    t_sampling_start = time.time()

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
        settings = nutpie_lib.PyNutsSettings.Diag(config.random_seed)
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
              f"chains={config.chains}, draws={config.draws}, tune={config.tune}, "
              f"compile={compile_ms}ms", flush=True)

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
