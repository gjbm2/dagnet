"""
Inference runner and posterior summarisation.

run_inference: pm.Model → InferenceData + QualityMetrics
summarise_posteriors: InferenceData + topology/evidence → InferenceResult
"""

from __future__ import annotations

import math

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

    if report_progress:
        report_progress("sampling", 0, "Starting MCMC…")

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

        # Latency posterior (Phase A: echo the fixed point estimate)
        if et.has_latency and ev.latency_prior:
            lp = ev.latency_prior
            onset = lp.onset_delta_days
            mu = lp.mu
            sigma = lp.sigma

            # Compute t95 HDI from fixed latency
            t95_lower = math.exp(mu + 1.28 * sigma) + onset
            t95_upper = math.exp(mu + 2.0 * sigma) + onset

            latency_posteriors[edge_id] = LatencyPosteriorSummary(
                mu_mean=mu,
                mu_sd=abs(mu) * 0.03,  # small uncertainty echo
                sigma_mean=sigma,
                sigma_sd=sigma * 0.05,
                onset_delta_days=onset,
                hdi_t95_lower=t95_lower,
                hdi_t95_upper=t95_upper,
                provenance="point-estimate",  # Phase A: not latent
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
