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
    """Resolved latency parameters for one scope (edge or path).

    Naming (doc 61): bare `mu_sd` is epistemic (posterior SD of μ);
    `mu_sd_pred` is predictive (kappa_lat-inflated). When `mu_sd_pred`
    is not available (no kappa_lat, or pre-migration data) it falls
    back to the epistemic value via the `mu_sd_predictive` property
    so forecasting callers can read one field without special-casing.
    σ and onset dispersions have no predictive mechanism in the current
    model and are always epistemic.
    """
    mu: float = 0.0
    sigma: float = 0.0
    onset_delta_days: float = 0.0
    t95: float = 0.0
    # Dispersions (from posterior SDs or heuristic)
    mu_sd: float = 0.0                     # epistemic (doc 61)
    mu_sd_pred: Optional[float] = None     # predictive (kappa_lat); None when absent
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    onset_mu_corr: float = 0.0

    @property
    def mu_sd_predictive(self) -> float:
        """Predictive μ-SD with safe fallback: bare mu_sd when no kappa_lat.

        Correct by construction — without kappa_lat the predictive and
        epistemic dispersions coincide, so reading bare mu_sd is exact.
        """
        return self.mu_sd_pred if self.mu_sd_pred is not None else self.mu_sd


@dataclass
class ResolvedModelParams:
    """Complete resolved model parameters for an edge.

    This is the output of the promoted model resolver. Consumers read
    from this rather than fishing through raw edge.p fields.
    """
    # Probability — epistemic (posterior on the true rate, doc 49)
    p_mean: float = 0.0
    p_sd: float = 0.0
    alpha: float = 0.0
    beta: float = 0.0
    # Probability — predictive (kappa-inflated, doc 49). Falls back to
    # epistemic when kappa absent (identical in that case).
    alpha_pred: float = 0.0
    beta_pred: float = 0.0
    # Subset-conditioning mass (doc 52) — total raw observation count
    # used to fit the promoted source's posterior for the resolved
    # temporal_mode. Consumers compute r = m_S / m_G when blending
    # aggregate against query-conditioned output. None when not known
    # (engine skips the blend — see doc 52 §14.5).
    n_effective: Optional[float] = None

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

    # Semantic property: does `alpha, beta` already incorporate the
    # user's query-window evidence? See STATS_SUBSYSTEMS.md §5
    # Confusion 8. Consumers doing prior+evidence conjugate updates
    # (e.g. doc 50 Class B Beta-Binomial) must branch on this, not on
    # `source`, so the conjugate-update logic remains correct if new
    # sources are introduced.
    #
    #   False → aggregate prior (bayesian fit / manual override).
    #           Safe to update with query-scoped Σk, Σn.
    #   True  → already a query-scoped posterior (analytic / analytic_be
    #           Jeffreys). Read directly; updating again double-counts.
    @property
    def alpha_beta_query_scoped(self) -> bool:
        return self.source in ('analytic', 'analytic_be')

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
            'mu_sd': mv_lat.get('mu_sd'),                 # epistemic (doc 61)
            'mu_sd_pred': mv_lat.get('mu_sd_pred'),       # predictive (kappa_lat)
            'sigma_sd': mv_lat.get('sigma_sd'),
            'onset_sd': mv_lat.get('onset_sd'),
            'path_mu_sd': mv_lat.get('path_mu_sd'),
            'path_mu_sd_pred': mv_lat.get('path_mu_sd_pred'),
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
            resolution (prefer cohort_alpha/cohort_beta in cohort mode).
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
        edge_mu_sd = float(_src.get('mu_sd') or 0.0)                          # epistemic (doc 61)
        _src_mu_sd_pred = _src.get('mu_sd_pred')
        edge_mu_sd_pred = float(_src_mu_sd_pred) if _src_mu_sd_pred else None
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
        edge_mu_sd = (                                                        # epistemic (doc 61)
            latency_block.get('promoted_mu_sd')
            or lat_posterior.get('mu_sd')
            or 0.0
        )
        _lat_pred = (
            latency_block.get('promoted_mu_sd_pred')
            or lat_posterior.get('mu_sd_pred')
        )
        edge_mu_sd_pred = float(_lat_pred) if _lat_pred else None
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
        mu_sd_pred=edge_mu_sd_pred,
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
            path_mu_sd = (                                                    # epistemic (doc 61)
                latency_block.get('promoted_path_mu_sd')
                or lat_posterior.get('path_mu_sd')
                or 0.0
            )
            _path_pred = (
                latency_block.get('promoted_path_mu_sd_pred')
                or lat_posterior.get('path_mu_sd_pred')
            )
            path_mu_sd_pred = float(_path_pred) if _path_pred else None
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
                mu_sd_pred=path_mu_sd_pred,
                sigma_sd=float(path_sigma_sd),
                onset_sd=float(path_onset_sd),
                onset_mu_corr=float(path_onset_mu_corr),
            )

    # ── Probability ────────────────────────────────────────────────
    # In cohort mode, prefer cohort_alpha/cohort_beta — these are the
    # posterior on this edge's rate estimated from cohort-mode evidence
    # (anchor-anchored, path latency). In window mode, use alpha/beta
    # (fitted from window-mode evidence). Both target the same rate
    # (Y/X at this edge) but from different evidence sets.
    alpha = 0.0
    beta = 0.0
    p_mean = 0.0

    # Cohort mode: prefer cohort-mode posterior when available
    if temporal_mode == 'cohort':
        cohort_alpha = posterior_block.get('cohort_alpha', 0) or 0
        cohort_beta = posterior_block.get('cohort_beta', 0) or 0
        if cohort_alpha > 0 and cohort_beta > 0:
            alpha = float(cohort_alpha)
            beta = float(cohort_beta)
            p_mean = alpha / (alpha + beta)

    # Fall back to edge-level posterior
    if alpha <= 0 or beta <= 0:
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

    # D20 FIX: when no posterior alpha/beta, derive from evidence n/k
    # or construct a prior whose concentration reflects the evidence
    # base. Without this, the sweep falls back to Beta(1,1) and IS
    # conditioning overwhelms the prior for per-cohort evaluation.
    if alpha <= 0 or beta <= 0:
        ev_n = evidence_block.get('n')
        ev_k = evidence_block.get('k')
        if (isinstance(ev_n, (int, float)) and ev_n > 0
                and isinstance(ev_k, (int, float)) and ev_k >= 0):
            # Use evidence counts directly as the Beta prior.
            # This gives a prior whose concentration reflects all
            # observed evidence for this edge — typically hundreds
            # to thousands of trials. IS conditioning then updates
            # this with per-cohort evidence, producing a sensible
            # posterior. Add 1 to both for Bayesian smoothing.
            alpha = float(ev_k) + 1.0
            beta = float(ev_n - ev_k) + 1.0
            if p_mean <= 0:
                p_mean = alpha / (alpha + beta)
        elif p_mean > 0:
            # No evidence counts available — use p_mean with moderate
            # concentration. kappa=200 gives a prior equivalent to
            # ~200 trials, which resists single-cohort IS better than
            # kappa=20 while still allowing aggregate evidence to move
            # the posterior.
            _KAPPA_FALLBACK = 200.0
            _p = max(min(p_mean, 0.99), 0.01)
            alpha = _p * _KAPPA_FALLBACK
            beta = (1.0 - _p) * _KAPPA_FALLBACK

    # Subset-conditioning mass (doc 52 §14.3). Pick the mode-appropriate
    # n_effective from the posterior projection; fall back to ev_n when
    # D20 synthesised α, β directly from evidence counts (in which case
    # m_G = ev_n by construction).
    n_effective: Optional[float] = None
    if promoted_source == 'bayesian':
        if temporal_mode == 'cohort':
            n_effective = posterior_block.get('cohort_n_effective')
            if n_effective is None:
                n_effective = posterior_block.get('window_n_effective')
        else:
            n_effective = posterior_block.get('window_n_effective')
        if n_effective is not None:
            n_effective = float(n_effective)
    # D20-synthesised α, β (posterior α, β missing but evidence n, k present):
    # the evidence n IS the training mass by construction, so export it.
    if n_effective is None:
        _ev_n = evidence_block.get('n')
        if isinstance(_ev_n, (int, float)) and _ev_n > 0 and alpha > 0 and beta > 0:
            # Only when we actually used D20 — heuristic check: α+β ≈ ev_n+2.
            if abs((alpha + beta) - (float(_ev_n) + 2.0)) < 0.1:
                n_effective = float(_ev_n)

    # Predictive alpha/beta (doc 49): prefer *_pred fields from posterior,
    # fall back to epistemic (when kappa absent, they are identical).
    alpha_pred = alpha
    beta_pred = beta
    if temporal_mode == 'cohort':
        _cp_a = posterior_block.get('cohort_alpha_pred', 0) or 0
        _cp_b = posterior_block.get('cohort_beta_pred', 0) or 0
        if _cp_a > 0 and _cp_b > 0:
            alpha_pred = float(_cp_a)
            beta_pred = float(_cp_b)
    if alpha_pred == alpha and beta_pred == beta:
        # No cohort predictive or window mode — try edge-level predictive
        _wp_a = posterior_block.get('alpha_pred', 0) or 0
        _wp_b = posterior_block.get('beta_pred', 0) or 0
        if _wp_a > 0 and _wp_b > 0:
            alpha_pred = float(_wp_a)
            beta_pred = float(_wp_b)

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
        alpha_pred=alpha_pred,
        beta_pred=beta_pred,
        n_effective=n_effective,
        edge_latency=edge_latency,
        path_latency=path_latency,
        source=promoted_source or '',
        fitted_at=fitted_at,
        gate_passed=gate_passed,
        evidence_retrieved_at=evidence_retrieved_at,
        source_curves=source_curves,
    )
