"""
Transitional adapter: converts SpanKernel into an edge_params-compatible
dict that compute_cohort_maturity_rows can consume without refactoring.

This is the bridge between the new span kernel (Phase A) and the
existing row builder.  Once the row builder is fully refactored to
consume SpanKernel directly, this adapter is retired.

See doc 29c §11 (Appendix: Legacy Key Set) for the full key set.
"""

from typing import Dict, Any, Optional
from .span_kernel import SpanKernel


def span_kernel_to_edge_params(
    kernel: SpanKernel,
    graph: Dict[str, Any],
    target_edge_id: str,
    is_window: bool,
) -> Dict[str, float]:
    """Build an edge_params dict from a SpanKernel.

    For the single-edge case, this is equivalent to _read_edge_model_params.
    For multi-hop, it uses the kernel's span_p as the forecast rate and
    the last edge's posterior SDs for MC uncertainty.

    Args:
        kernel: The composed span kernel.
        graph: Graph dict with edges.
        target_edge_id: UUID of the last edge in the span (for
            extracting posterior SDs and alpha/beta).
        is_window: True for window mode.

    Returns:
        Dict compatible with compute_cohort_maturity_rows' edge_params.
    """
    import math

    # Find the target (last) edge to extract SDs and alpha/beta
    edges = graph.get('edges', [])
    target_edge = None
    for e in edges:
        if str(e.get('uuid', e.get('id', ''))) == str(target_edge_id):
            target_edge = e
            break

    params: Dict[str, Any] = {}

    # The span kernel provides span_p as the conditional probability
    span_p = kernel.span_p

    # For the CDF shape, we need mu/sigma/onset.  The kernel is built
    # from numerical convolution so there's no single parametric form.
    # For the row builder's _cdf() function, we still need scalar params.
    # Use the last edge's values as the best available proxy.
    if target_edge:
        p_data = target_edge.get('p', {})
        latency = p_data.get('latency', {})
        posterior = latency.get('posterior', {})
        prob_posterior = p_data.get('posterior', {})

        # Edge-level latency
        mu = posterior.get('mu_mean') or latency.get('mu') or 0.0
        sigma = posterior.get('sigma_mean') or latency.get('sigma') or 0.0
        onset = (posterior.get('onset_delta_days')
                 or latency.get('promoted_onset_delta_days')
                 or latency.get('onset_delta_days') or 0.0)

        # Path-level latency
        path_mu = posterior.get('path_mu_mean') or latency.get('path_mu')
        path_sigma = posterior.get('path_sigma_mean') or latency.get('path_sigma')
        path_onset = (posterior.get('path_onset_delta_days')
                      or latency.get('path_onset_delta_days'))

        if isinstance(mu, (int, float)):
            params['mu'] = float(mu)
        if isinstance(sigma, (int, float)):
            params['sigma'] = float(sigma)
        if isinstance(onset, (int, float)):
            params['onset_delta_days'] = float(onset)
        if isinstance(path_mu, (int, float)):
            params['path_mu'] = float(path_mu)
        if isinstance(path_sigma, (int, float)) and path_sigma > 0:
            params['path_sigma'] = float(path_sigma)
        if isinstance(path_onset, (int, float)):
            params['path_onset_delta_days'] = float(path_onset)

        # Forecast mean / posterior p — use span_p
        params['forecast_mean'] = span_p
        params['posterior_p'] = span_p
        params['posterior_p_cohort'] = span_p

        # Alpha/beta for frontier conditioning prior.
        # Use span_p as the prior mean, with concentration (kappa)
        # from the last edge's posterior.  This ensures the prior is
        # centred on the span rate, not the last edge's rate.
        post_alpha = prob_posterior.get('alpha')
        post_beta = prob_posterior.get('beta')
        path_alpha = prob_posterior.get('path_alpha')
        path_beta = prob_posterior.get('path_beta')

        # Derive kappa from last edge's posterior (how much data it saw)
        if (isinstance(path_alpha, (int, float)) and isinstance(path_beta, (int, float))
                and path_alpha > 0 and path_beta > 0):
            kappa = float(path_alpha) + float(path_beta)
        elif (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            kappa = float(post_alpha) + float(post_beta)
        else:
            kappa = 20.0  # weak default

        # Re-derive alpha/beta from span_p + kappa
        params['posterior_alpha'] = span_p * kappa
        params['posterior_beta'] = (1.0 - span_p) * kappa
        params['posterior_path_alpha'] = span_p * kappa
        params['posterior_path_beta'] = (1.0 - span_p) * kappa

        # p_stdev — derived from span_p + kappa
        span_alpha = span_p * kappa
        span_beta = (1.0 - span_p) * kappa
        if span_alpha > 0 and span_beta > 0:
            s = span_alpha + span_beta
            p_sd = math.sqrt(span_alpha * span_beta / (s * s * (s + 1)))
            params['p_stdev'] = p_sd
            params['p_stdev_cohort'] = p_sd

        # Posterior SDs for MC fan — read from promoted model fields.
        # The FE's applyPromotion writes promoted_mu_sd etc. from
        # whichever model_var won.  Fall back to posterior (Bayes).
        _sd_map = {
            'bayes_mu_sd':              ('promoted_mu_sd',              'mu_sd'),
            'bayes_sigma_sd':           ('promoted_sigma_sd',           'sigma_sd'),
            'bayes_onset_sd':           ('promoted_onset_sd',           'onset_sd'),
            'bayes_onset_mu_corr':      ('promoted_onset_mu_corr',      'onset_mu_corr'),
            'bayes_path_mu_sd':         ('promoted_path_mu_sd',         'path_mu_sd'),
            'bayes_path_sigma_sd':      ('promoted_path_sigma_sd',      'path_sigma_sd'),
            'bayes_path_onset_sd':      ('promoted_path_onset_sd',      'path_onset_sd'),
            'bayes_path_onset_mu_corr': ('promoted_path_onset_mu_corr', 'path_onset_mu_corr'),
        }
        for param_key, (promoted_key, posterior_key) in _sd_map.items():
            val = latency.get(promoted_key) or posterior.get(posterior_key)
            if isinstance(val, (int, float)):
                params[param_key] = float(val)

        # t95
        t95 = latency.get('promoted_t95') or latency.get('t95')
        path_t95 = latency.get('promoted_path_t95') or latency.get('path_t95')
        if isinstance(t95, (int, float)) and t95 > 0:
            params['t95'] = float(t95)
        if isinstance(path_t95, (int, float)) and path_t95 > 0:
            params['path_t95'] = float(path_t95)

        # evidence_retrieved_at
        evidence = p_data.get('evidence', {})
        ev_retrieved = evidence.get('retrieved_at')
        if isinstance(ev_retrieved, str) and ev_retrieved:
            params['evidence_retrieved_at'] = ev_retrieved

    return params
