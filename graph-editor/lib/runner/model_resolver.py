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
    source: str = ''          # 'analytic' | 'bayesian' (doc 73b §3.1 — 'manual' retired)
    fitted_at: Optional[str] = None
    gate_passed: Optional[bool] = None  # Bayesian quality gate

    # Semantic property: does `alpha, beta` already incorporate the
    # user's query-window evidence? Always False post doc 73b §3.9 / Decision 13.
    # The resolver reads aggregate α/β from
    # `model_vars[analytic].probability` on the same footing as the
    # bayesian source, so analytic α/β is an aggregate prior — never a
    # query-scoped posterior. CF runs uniformly; the conjugate-update
    # branch is the only branch.
    @property
    def alpha_beta_query_scoped(self) -> bool:
        return False

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
        if src not in ('analytic', 'bayesian'):
            continue
        mv_lat = mv.get('latency') or {}
        mv_prob = mv.get('probability') or {}
        entry: Dict[str, Any] = {
            'mu': mv_lat.get('mu'),
            'sigma': mv_lat.get('sigma'),
            't95': mv_lat.get('t95'),
            'onset_delta_days': mv_lat.get('onset_delta_days'),
            'path_mu': mv_lat.get('path_mu'),
            'path_sigma': mv_lat.get('path_sigma'),
            'path_t95': mv_lat.get('path_t95'),
            'path_onset_delta_days': mv_lat.get('path_onset_delta_days'),
            'forecast_mean': mv_prob.get('mean'),
            'p_stdev': mv_prob.get('stdev'),
            # Doc 73b §3.9 mirror contract — aggregate Beta-shape on source layer.
            'prob_alpha': mv_prob.get('alpha'),
            'prob_beta': mv_prob.get('beta'),
            'prob_n_effective': mv_prob.get('n_effective'),
            'prob_provenance': mv_prob.get('provenance'),
            'prob_cohort_alpha': mv_prob.get('cohort_alpha'),
            'prob_cohort_beta': mv_prob.get('cohort_beta'),
            'prob_cohort_n_effective': mv_prob.get('cohort_n_effective'),
            'prob_cohort_provenance': mv_prob.get('cohort_provenance'),
            'mu_sd': mv_lat.get('mu_sd'),                 # epistemic (doc 61)
            'mu_sd_pred': mv_lat.get('mu_sd_pred'),       # predictive (kappa_lat)
            'sigma_sd': mv_lat.get('sigma_sd'),
            'onset_sd': mv_lat.get('onset_sd'),
            'onset_mu_corr': mv_lat.get('onset_mu_corr'),
            'path_mu_sd': mv_lat.get('path_mu_sd'),
            'path_mu_sd_pred': mv_lat.get('path_mu_sd_pred'),
            'path_sigma_sd': mv_lat.get('path_sigma_sd'),
            'path_onset_sd': mv_lat.get('path_onset_sd'),
            'path_onset_mu_corr': mv_lat.get('path_onset_mu_corr'),
        }
        curves[src] = entry
    return curves


def _resolve_promoted_source(
    preference: str,
    source_curves: Dict[str, Dict[str, Any]],
    model_vars: List[Dict[str, Any]],
) -> Optional[str]:
    """Determine which model source to use.

    Mirrors `src/services/modelVarsResolution.ts` exactly (doc 73b §3.1 / OP3):
      bayesian       -> bayesian, else analyticBest
      analytic       -> analytic only
      best_available -> gated bayesian, else analyticBest

    Doc 73b §6.7 / OP1 graceful-degrade: stale `'manual'` selector preferences
    are normalised to the unpinned default (best_available).
    """
    def _find(source: str) -> Optional[str]:
        return source if source in source_curves else None

    def _bayesian_if_gated() -> Optional[str]:
        for mv in model_vars:
            if mv.get('source') == 'bayesian':
                quality = mv.get('quality') or {}
                return 'bayesian' if quality.get('gate_passed') else None
        return None

    def _analytic_best() -> Optional[str]:
        return _find('analytic')

    def _best_available() -> Optional[str]:
        return _bayesian_if_gated() or _analytic_best()

    if preference == 'bayesian':
        return _find('bayesian') or _analytic_best()
    if preference == 'analytic':
        return _find('analytic')
    return _best_available()


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
        graph_preference: graph-level default model_source_preference.
            Edge-level preference wins when present, matching the FE's
            effectivePreference() resolution.

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
    # Match FE effectivePreference(): edge override, else graph default.
    edge_pref = p.get('model_source_preference', '') or ''
    preference = edge_pref or graph_preference or 'best_available'

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
        # Doc 73b §3.9 (analytic dispersion discipline): until a
        # principled analytic correlation model is designed and tested,
        # treat analytic latency as having independent (mu, onset) — the
        # same discipline §3.9 applies to predictive probability
        # dispersion (no `alpha_pred` / `beta_pred` from analytic until
        # an overdispersion model lands). Synth/generator-emitted
        # `onset_mu_corr` values on analytic source are placeholders, not
        # fitted from a joint distribution; propagating them produces
        # spec-unjustified MC-vs-deterministic drift in cohort midpoints.
        # Bayesian source carries kappa-aware joint posterior — its
        # `onset_mu_corr` is principled and unaffected here.
        if promoted_source == 'analytic':
            edge_onset_mu_corr = 0.0
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
            # Doc 73b §3.9 (analytic dispersion discipline) — see
            # edge-level branch above for rationale. Same discipline
            # applies at path level.
            if promoted_source == 'analytic':
                path_onset_mu_corr = 0.0
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

    # Doc 73b Stage 2 (§3.9 mirror contract): aggregate analytic source
    # α/β. When the promoted source is `analytic`, read aggregate Beta
    # shape from `model_vars[analytic].probability` rather than from
    # the bayesian posterior (which is empty for analytic-only edges)
    # or from scoped `p.evidence.{n, k}` (the §3.3.3 layer-isolation
    # invariant: scoped current-answer fields must never seed an
    # aggregate model prior). Cohort mode prefers cohort_*; window
    # mode and cohort fallback prefer the window-family α/β.
    analytic_provenance: Optional[str] = None
    if (alpha <= 0 or beta <= 0) and promoted_source == 'analytic':
        if temporal_mode == 'cohort':
            ca = _src.get('prob_cohort_alpha')
            cb = _src.get('prob_cohort_beta')
            if (isinstance(ca, (int, float)) and isinstance(cb, (int, float))
                    and float(ca) > 0 and float(cb) > 0):
                alpha = float(ca)
                beta = float(cb)
                p_mean = alpha / (alpha + beta)
                analytic_provenance = (
                    _src.get('prob_cohort_provenance')
                    or 'analytic_cohort_baseline'
                )
        if alpha <= 0 or beta <= 0:
            wa = _src.get('prob_alpha')
            wb = _src.get('prob_beta')
            if (isinstance(wa, (int, float)) and isinstance(wb, (int, float))
                    and float(wa) > 0 and float(wb) > 0):
                alpha = float(wa)
                beta = float(wb)
                p_mean = alpha / (alpha + beta)
                analytic_provenance = (
                    _src.get('prob_provenance')
                    or 'analytic_window_baseline'
                )

    if p_mean == 0:
        # Doc 73b §3.9 mirror contract: the analytic source's
        # `probability.mean` is the canonical baseline when neither
        # posterior nor source-layer Beta is set. Prefer it over the
        # promoted `forecast.mean` because applyPromotion writes
        # `forecast.mean` from this same source-layer field — they
        # agree on enriched graphs, but on test fixtures /
        # pre-Stage-4 graphs the source field is populated and
        # `forecast.mean` may not be.
        fm = (_src.get('forecast_mean') if promoted_source else None)
        if fm is None:
            fm = forecast_block.get('mean', 0) or 0
        p_mean = float(fm or 0)

    # Doc 73f F15 (28-Apr-26): no synthetic-prior fallback.
    #
    # When `alpha` or `beta` could not be resolved from any source
    # (no Bayes posterior, no `model_vars[analytic].probability` Beta
    # shape because FE-topo Step 1 had no usable window-aggregate
    # stdev), leave them at 0. Consumers must tolerate a missing
    # aggregate dispersion: midlines (`p_mean`) still resolve from
    # the forecast scalar at line 445; only the dispersion bands
    # are skipped. Fabricating a prior (the previous κ=200 or κ=2
    # fallback) was rejected as it manufactures uncertainty out of
    # nothing. The right place to compute aggregate dispersion is
    # FE-topo Step 1 over the same weighted window-aggregate
    # evidence that yields `forecast.mean`, paired into
    # `addEvidenceAndForecastScalars` as `forecast_stdev` and
    # consumed by `buildAnalyticProbabilityBlock` upstream.

    # Subset-conditioning mass (doc 52 §14.3). Pick the mode-appropriate
    # n_effective from the source layer: bayesian posterior projection,
    # or analytic source-layer mirror (doc 73b §3.9). The historical
    # D20-detection heuristic that inferred n_effective from
    # `p.evidence.n` is removed by Stage 2 — n_effective is now a
    # source-layer field, never inferred from scoped current-answer
    # evidence.
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
    elif promoted_source == 'analytic':
        if temporal_mode == 'cohort':
            n_effective = _src.get('prob_cohort_n_effective')
            if n_effective is None:
                n_effective = _src.get('prob_n_effective')
        else:
            n_effective = _src.get('prob_n_effective')
        if isinstance(n_effective, (int, float)):
            n_effective = float(n_effective)
        else:
            n_effective = None

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
