"""
Inference runner and posterior summarisation.

run_inference: pm.Model → InferenceData + QualityMetrics
summarise_posteriors: InferenceData + topology/evidence → InferenceResult
"""

from __future__ import annotations

import math
import threading
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
):
    """Run NUTS sampling. Returns (InferenceData, QualityMetrics)."""
    import pymc as pm
    import arviz as az

    if config is None:
        config = SamplingConfig()

    # Sampling is ~90% of wall time. The percentage reported here is
    # actual progress through the MCMC draws (0–100%), not a fake layout.
    # Pre/post-sampling stages report stage labels without fake percentages.
    use_callback = report_progress is not None
    total_steps = config.chains * (config.tune + config.draws)
    steps_done = [0]  # mutable for closure
    last_pct = [-1]

    def _sampling_callback(trace, draw):
        steps_done[0] += 1
        pct = int(100 * steps_done[0] / total_steps)
        if pct > last_pct[0]:
            last_pct[0] = pct
            phase = "tuning" if draw.tuning else "sampling"
            report_progress(
                "sampling", pct,
                f"{config.chains} chains {phase}",
            )

    # Select the fastest available sampler backend.
    # nutpie (Rust) is ~5-10x faster than PyMC default on CPU.
    # numpyro (JAX) enables GPU — even faster when available.
    nuts_sampler = "pymc"  # default fallback
    try:
        import nutpie  # noqa: F401
        nuts_sampler = "nutpie"
    except ImportError:
        pass
    # numpyro/JAX GPU is available but currently slower for this model
    # geometry due to aggressive tree depth (1023 steps/iteration).
    # Revisit when model reparameterisation improves JAX performance.
    # try:
    #     import numpyro  # noqa: F401
    #     nuts_sampler = "numpyro"
    # except ImportError:
    #     pass

    sampler_kwargs = dict(
        draws=config.draws,
        tune=config.tune,
        chains=config.chains,
        cores=config.cores,
        target_accept=config.target_accept,
        return_inferencedata=True,
        random_seed=config.random_seed,
    )

    if nuts_sampler == "pymc":
        sampler_kwargs["progressbar"] = not use_callback
        sampler_kwargs["callback"] = _sampling_callback if use_callback else None
    else:
        # nutpie/numpyro don't support PyMC's callback mechanism.
        # Run a heartbeat thread that reports elapsed time so the
        # FE poll endpoint shows the job is alive.
        sampler_kwargs["nuts_sampler"] = nuts_sampler
        sampler_kwargs["progressbar"] = False  # suppress terminal bar

    if report_progress:
        report_progress("sampling", 0, f"Starting MCMC ({nuts_sampler})…")

    # For non-pymc backends: heartbeat thread reports elapsed time
    heartbeat_stop = threading.Event()
    if nuts_sampler != "pymc" and report_progress:
        total_iters = config.chains * (config.tune + config.draws)
        t_sample_start = time.time()

        def _heartbeat():
            while not heartbeat_stop.is_set():
                heartbeat_stop.wait(5.0)
                if heartbeat_stop.is_set():
                    break
                elapsed = time.time() - t_sample_start
                report_progress(
                    "sampling", -1,
                    f"{nuts_sampler} — {elapsed:.0f}s elapsed",
                )

        hb_thread = threading.Thread(target=_heartbeat, daemon=True)
        hb_thread.start()

    with model:
        trace = pm.sample(**sampler_kwargs)

    heartbeat_stop.set()

    if report_progress:
        report_progress("summarising", 100, "Computing diagnostics…")

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

        # Moment-match Beta
        alpha, beta_val = _fit_beta_to_samples(samples)

        # HDI (handle both scalar and multi-dimensional variables)
        hdi = az.hdi(trace, var_names=[p_var_name], hdi_prob=HDI_PROB)
        hdi_vals = hdi[p_var_name].values
        if hdi_vals.ndim == 1:
            hdi_lower = float(hdi_vals[0])
            hdi_upper = float(hdi_vals[1])
        else:
            # Multi-dimensional — take first component
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

        posteriors.append(PosteriorSummary(
            edge_id=edge_id,
            param_id=ev.param_id,
            alpha=alpha,
            beta=beta_val,
            mean=float(np.mean(samples)),
            stdev=float(np.std(samples)),
            hdi_lower=hdi_lower,
            hdi_upper=hdi_upper,
            hdi_level=HDI_PROB,
            ess=edge_ess,
            rhat=edge_rhat,
            divergences=quality.total_divergences,
            provenance=provenance,
            prior_tier=ev.prob_prior.source,
        ))

        # Latency posterior: extract from MCMC trace if latent, else echo prior
        if et.has_latency and ev.latency_prior:
            lp = ev.latency_prior
            onset = lp.onset_delta_days
            safe_eid = _safe_var_name(edge_id)
            mu_var_name = f"mu_lat_{safe_eid}"
            sigma_var_name = f"sigma_lat_{safe_eid}"

            latent_edges = metadata.get("latent_latency_edges", set())
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

                # t95 HDI from posterior samples of the latency distribution
                t95_samples = np.exp(mu_samples + 1.645 * sigma_samples) + onset
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

                lat_provenance = "bayesian" if (lat_rhat < RHAT_THRESHOLD and lat_ess >= ESS_THRESHOLD) else "pooled-fallback"

                latency_posteriors[edge_id] = LatencyPosteriorSummary(
                    mu_mean=mu_mean,
                    mu_sd=mu_sd,
                    sigma_mean=sigma_mean,
                    sigma_sd=sigma_sd,
                    onset_delta_days=onset,
                    hdi_t95_lower=t95_lower,
                    hdi_t95_upper=t95_upper,
                    ess=lat_ess,
                    rhat=lat_rhat,
                    provenance=lat_provenance,
                )
                diagnostics.append(
                    f"  latency {edge_id[:8]}…: mu={mu_mean:.3f}±{mu_sd:.3f} "
                    f"(prior={lp.mu:.3f}), sigma={sigma_mean:.3f}±{sigma_sd:.3f} "
                    f"(prior={lp.sigma:.3f}), rhat={lat_rhat:.3f}, ess={lat_ess:.0f}"
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

                path_provenance = "bayesian"

                # Attach to existing latency posterior (or create one)
                if edge_id in latency_posteriors:
                    lat = latency_posteriors[edge_id]
                    lat.path_onset_delta_days = path_onset
                    lat.path_mu_mean = path_mu
                    lat.path_mu_sd = path_mu_sd
                    lat.path_sigma_mean = path_sigma
                    lat.path_sigma_sd = path_sigma_sd
                    lat.path_provenance = path_provenance

                diagnostics.append(
                    f"  cohort_latency {edge_id[:8]}…: onset={path_onset:.1f}, "
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

    return InferenceResult(
        posteriors=posteriors,
        latency_posteriors=latency_posteriors,
        quality=quality,
        skipped=skipped,
        diagnostics=diagnostics,
    )


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
