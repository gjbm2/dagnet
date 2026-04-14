"""
Promoted model resolver — unified best-available model parameter resolution.

Replaces scattered resolution logic across:
- _read_edge_model_params() in api_handlers.py
- _resolve_promoted_source() in api_handlers.py
- read_edge_cohort_params() in cohort_forecast.py
- _resolve_completeness_params() in api_handlers.py

Single entry point: resolve_model_params(edge, scope, temporal_mode)

See doc 29 §Promoted Model Resolver.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ResolvedLatency:
    """Resolved latency parameters for one scope (edge or path)."""
    mu: float = 0.0
    sigma: float = 0.0
    onset_delta_days: float = 0.0
    t95: float = 0.0
    # Dispersions (from posterior SDs or heuristic)
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    onset_mu_corr: float = 0.0


@dataclass
class ResolvedModelParams:
    """Complete resolved model parameters for an edge.

    This is the output of the promoted model resolver. Consumers read
    from this rather than fishing through raw edge.p fields.
    """
    # Probability
    p_mean: float = 0.0
    p_sd: float = 0.0
    # Posterior alpha/beta (for MC consumers)
    alpha: float = 0.0
    beta: float = 0.0

    # Latency — edge-level (always populated)
    edge_latency: ResolvedLatency = field(default_factory=ResolvedLatency)
    # Latency — path-level (populated when scope=path and available)
    path_latency: Optional[ResolvedLatency] = None

    # Active latency: points to edge_latency or path_latency depending
    # on scope resolution. Consumers that just need "the" latency read
    # this.
    @property
    def latency(self) -> ResolvedLatency:
        return self.path_latency if self.path_latency is not None else self.edge_latency

    # Provenance
    source: str = ''          # 'analytic' | 'analytic_be' | 'bayesian' | 'manual'
    fitted_at: Optional[str] = None
    gate_passed: Optional[bool] = None  # Bayesian quality gate

    # Evidence
    evidence_retrieved_at: Optional[str] = None

    # Per-source curves (for model curve rendering)
    source_curves: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    # Per-cohort frontier info (for v3 MC consumers)
    # Populated by the forecast engine, not by the resolver itself.
    per_cohort_frontiers: Optional[Dict[str, int]] = None


def _extract_source_curves(model_vars: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Extract per-source model curves from model_vars array."""
    curves: Dict[str, Dict[str, Any]] = {}
    for mv in model_vars:
        src = mv.get('source', '')
        if src not in ('analytic', 'analytic_be', 'bayesian', 'manual'):
            continue
        mv_lat = mv.get('latency') or {}
        mv_prob = mv.get('probability') or {}
        entry: Dict[str, Any] = {
            'mu': mv_lat.get('mu'),
            'sigma': mv_lat.get('sigma'),
            'onset_delta_days': mv_lat.get('onset_delta_days'),
            'path_mu': mv_lat.get('path_mu'),
            'path_sigma': mv_lat.get('path_sigma'),
            'path_onset_delta_days': mv_lat.get('path_onset_delta_days'),
            'forecast_mean': mv_prob.get('mean'),
            'p_stdev': mv_prob.get('stdev'),
            'mu_sd': mv_lat.get('mu_sd'),
            'sigma_sd': mv_lat.get('sigma_sd'),
            'onset_sd': mv_lat.get('onset_sd'),
            'path_mu_sd': mv_lat.get('path_mu_sd'),
            'path_sigma_sd': mv_lat.get('path_sigma_sd'),
            'path_onset_sd': mv_lat.get('path_onset_sd'),
        }
        curves[src] = entry
    return curves


def _resolve_promoted_source(
    preference: str,
    source_curves: Dict[str, Dict[str, Any]],
    model_vars: List[Dict[str, Any]],
) -> Optional[str]:
    """Determine which model source to use.

    Priority: explicit preference → bayesian (if quality-gated) →
    analytic_be → analytic.
    """
    if preference and preference != 'best_available' and preference in source_curves:
        return preference

    # best_available cascade
    # Check bayesian quality gate
    for mv in model_vars:
        if mv.get('source') == 'bayesian':
            quality = mv.get('quality') or {}
            if quality.get('gate_passed'):
                return 'bayesian'
            break  # bayesian exists but didn't pass gate

    for candidate in ('analytic_be', 'analytic'):
        if candidate in source_curves:
            return candidate

    if 'manual' in source_curves:
        return 'manual'

    return None


def resolve_model_params(
    edge: Dict[str, Any],
    scope: str = 'edge',
    temporal_mode: str = 'window',
    graph_preference: Optional[str] = None,
) -> Optional[ResolvedModelParams]:
    """Resolve best-available model params for an edge.

    Args:
        edge: graph edge dict (with 'p' block).
        scope: 'edge' (window-mode, edge-level latency) or
               'path' (cohort-mode, prefer path-level latency).
        temporal_mode: 'window' or 'cohort'. Affects probability
            resolution (prefer path_alpha/path_beta in cohort mode).
        graph_preference: graph-level model_source_preference (overrides
            edge-level when set). Matches TS applyPromotion behaviour.

    Returns:
        ResolvedModelParams with all fields populated from the
        best-available source, or None if the edge has no usable model.
    """
    p = edge.get('p') or {}
    if not p:
        return ResolvedModelParams()

    latency_block = p.get('latency') or {}
    posterior_block = p.get('posterior') or {}
    lat_posterior = latency_block.get('posterior') or {}
    forecast_block = p.get('forecast') or {}
    evidence_block = p.get('evidence') or {}
    model_vars = p.get('model_vars') or []
    # Edge-level preference, overridden by graph-level (review finding #6)
    edge_pref = p.get('model_source_preference', '') or ''
    preference = graph_preference or edge_pref or 'best_available'

    # ── Per-source curves ──────────────────────────────────────────
    source_curves = _extract_source_curves(model_vars)
    promoted_source = _resolve_promoted_source(preference, source_curves, model_vars)

    # ── Edge-level latency ─────────────────────────────────────────
    # Read from the selected source's ModelVarsEntry when available.
    # Fall back to posterior → flat fields only when no source selected
    # or the source lacks latency data. (Review finding #6.)
    _src = source_curves.get(promoted_source, {}) if promoted_source else {}
    _src_mu = _src.get('mu')
    _src_sigma = _src.get('sigma')

    if _src_mu is not None and _src_sigma is not None and float(_src_sigma) > 0:
        # Selected source has latency — use it
        edge_mu = float(_src_mu)
        edge_sigma = float(_src_sigma)
        edge_onset = float(_src.get('onset_delta_days') or latency_block.get('onset_delta_days') or 0.0)
        edge_t95 = float(_src.get('t95') or latency_block.get('promoted_t95') or latency_block.get('t95') or 0.0)
        edge_mu_sd = float(_src.get('mu_sd') or 0.0)
        edge_sigma_sd = float(_src.get('sigma_sd') or 0.0)
        edge_onset_sd = float(_src.get('onset_sd') or 0.0)
        edge_onset_mu_corr = float(_src.get('onset_mu_corr') or 0.0)
    else:
        # Fallback: posterior → flat promoted fields
        edge_mu = lat_posterior.get('mu_mean') or latency_block.get('mu') or 0.0
        edge_sigma = lat_posterior.get('sigma_mean') or latency_block.get('sigma') or 0.0
        edge_onset = (
            lat_posterior.get('onset_delta_days')
            or latency_block.get('promoted_onset_delta_days')
            or latency_block.get('onset_delta_days')
            or 0.0
        )
        edge_t95 = latency_block.get('promoted_t95') or latency_block.get('t95') or 0.0
        edge_mu_sd = (
            latency_block.get('promoted_mu_sd')
            or lat_posterior.get('mu_sd')
            or 0.0
        )
        edge_sigma_sd = (
            latency_block.get('promoted_sigma_sd')
            or lat_posterior.get('sigma_sd')
            or 0.0
        )
        edge_onset_sd = (
            latency_block.get('promoted_onset_sd')
            or lat_posterior.get('onset_sd')
            or 0.0
        )
        edge_onset_mu_corr = (
            latency_block.get('promoted_onset_mu_corr')
            or lat_posterior.get('onset_mu_corr')
            or 0.0
        )

    edge_latency = ResolvedLatency(
        mu=float(edge_mu),
        sigma=float(edge_sigma),
        onset_delta_days=float(edge_onset),
        t95=float(edge_t95),
        mu_sd=float(edge_mu_sd),
        sigma_sd=float(edge_sigma_sd),
        onset_sd=float(edge_onset_sd),
        onset_mu_corr=float(edge_onset_mu_corr),
    )

    # ── Path-level latency (cohort mode) ───────────────────────────
    path_latency: Optional[ResolvedLatency] = None
    if scope == 'path':
        path_mu = (
            lat_posterior.get('path_mu_mean')
            or latency_block.get('path_mu')
        )
        path_sigma = (
            lat_posterior.get('path_sigma_mean')
            or latency_block.get('path_sigma')
        )
        if path_mu is not None and path_sigma is not None and float(path_sigma) > 0:
            path_onset = (
                lat_posterior.get('path_onset_delta_days')
                or latency_block.get('path_onset_delta_days')
                or edge_onset
            )
            path_t95 = latency_block.get('promoted_path_t95') or latency_block.get('path_t95') or 0.0
            path_mu_sd = (
                latency_block.get('promoted_path_mu_sd')
                or lat_posterior.get('path_mu_sd')
                or 0.0
            )
            path_sigma_sd = (
                latency_block.get('promoted_path_sigma_sd')
                or lat_posterior.get('path_sigma_sd')
                or 0.0
            )
            path_onset_sd = (
                latency_block.get('promoted_path_onset_sd')
                or lat_posterior.get('path_onset_sd')
                or 0.0
            )
            path_onset_mu_corr = (
                latency_block.get('promoted_path_onset_mu_corr')
                or lat_posterior.get('path_onset_mu_corr')
                or 0.0
            )
            path_latency = ResolvedLatency(
                mu=float(path_mu),
                sigma=float(path_sigma),
                onset_delta_days=float(path_onset),
                t95=float(path_t95),
                mu_sd=float(path_mu_sd),
                sigma_sd=float(path_sigma_sd),
                onset_sd=float(path_onset_sd),
                onset_mu_corr=float(path_onset_mu_corr),
            )

    # ── Probability ────────────────────────────────────────────────
    # In cohort mode, prefer path-level alpha/beta.
    # In window mode, use edge-level alpha/beta.
    alpha = 0.0
    beta = 0.0
    p_mean = 0.0

    if temporal_mode == 'cohort':
        path_alpha = posterior_block.get('path_alpha', 0) or 0
        path_beta = posterior_block.get('path_beta', 0) or 0
        if path_alpha > 0 and path_beta > 0:
            alpha = float(path_alpha)
            beta = float(path_beta)
            p_mean = alpha / (alpha + beta)

    if p_mean == 0:
        # Fall back to edge-level posterior
        post_alpha = posterior_block.get('alpha', 0) or 0
        post_beta = posterior_block.get('beta', 0) or 0
        if post_alpha > 0 and post_beta > 0:
            alpha = float(post_alpha)
            beta = float(post_beta)
            p_mean = alpha / (alpha + beta)

    if p_mean == 0:
        # Fall back to forecast mean
        fm = forecast_block.get('mean', 0) or 0
        p_mean = float(fm)

    # p_sd from alpha/beta or from model_vars
    p_sd = 0.0
    if alpha > 0 and beta > 0:
        s = alpha + beta
        p_sd = math.sqrt(alpha * beta / (s * s * (s + 1)))
    else:
        p_sd = float(p.get('stdev', 0) or 0)

    # ── Provenance ─────────────────────────────────────────────────
    fitted_at: Optional[str] = None
    gate_passed: Optional[bool] = None
    for mv in model_vars:
        if mv.get('source') == promoted_source:
            fitted_at = mv.get('source_at')
            quality = mv.get('quality')
            if quality:
                gate_passed = quality.get('gate_passed')
            break

    evidence_retrieved_at = evidence_block.get('retrieved_at')

    return ResolvedModelParams(
        p_mean=p_mean,
        p_sd=p_sd,
        alpha=alpha,
        beta=beta,
        edge_latency=edge_latency,
        path_latency=path_latency,
        source=promoted_source or '',
        fitted_at=fitted_at,
        gate_passed=gate_passed,
        evidence_retrieved_at=evidence_retrieved_at,
        source_curves=source_curves,
    )
