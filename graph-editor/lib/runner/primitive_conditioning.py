"""
Primitive conditioning policy.

Takes a `PrimitiveEvidenceResolution`, the resolved model parameters
for the primitive's source/destination edge, and a
scenario-level RNG seed, and emits a `ConditionedTransitionPrimitive`
(Stage 1 contract).

Policy summary (plan §"Stage 3" lines 631-652, §"Subset and Effective
Evidence Policy" lines 216-251):

  - Reuse the existing CF maturity-aware likelihood discipline rather
    than inventing a new estimator. For a primitive whose evidence has
    already been clock-aligned and weighted upstream by Stage 2, the
    likelihood degenerates to a Binomial conjugate update on the
    floating-point ``n_weighted``/``k_weighted`` totals against the
    resolved Beta prior.
  - Apply the doc-52 mass-ratio policy at the primitive layer using
    raw admitted row mass (``m_S = sum(row.n)``) and
    ``m_G = resolved_model.n_effective``.
    ``r = min(m_S/m_G, 1.0)`` when both are set; otherwise the policy
    is skipped with a recorded reason. The blend mixes ``(1−r)·S``
    conditioned draws with ``r·S`` prior draws via a
    ``DrawFamilyKey``-derived permutation.
  - Composed consumers (`window()`, `subject_span`, `carrier_to_x`,
    projection) MUST NOT re-apply subset logic or compatibility
    blending (plan §245). The conditioned primitive carries the
    posterior outright.
  - Full-subset limit: when ``r → 1`` the primitive is numerically
    equal to its model-var input. As ``m_S/m_G → 0`` full conditioning
    pressure applies (plan §224, §240–244).
  - Structurally non-latency primitives keep probability and timing
    separate (plan §83-87, §583): probability ``p`` may be conditioned
    while ``TimingPosterior.family = NON_LATENT`` carries a Dirac-at-
    zero CDF and ``mu``/``sigma``/``onset``/``completeness`` compatibility
    fields are provenance only.
  - Draw-family coherence is correctness, not performance (plan §141,
    §585-591). All RNG seeds derive from a request-scoped
    ``DrawFamilyKey`` via ``make_rng(key, derivation)`` from
    ``runner.primitives``. No ``np.random.default_rng(seed=<int>)`` calls.

This module imports:

  - ``runner.primitives`` for the contract types and keyed-RNG seam
  - ``runner.primitive_evidence`` for the binding-step input contract
  - ``runner.model_resolver`` for ``ResolvedModelParams``/``ResolvedLatency``
  - stdlib + numpy for the conjugate update and CDF construction

It does NOT import from ``forecast_runtime``, ``forecast_state``,
``cohort_forecast_v3``, or ``span_kernel`` — Stage 3 produces a
self-contained primitive object that future stages will integrate
with composition (Stage 5/6).
"""

from __future__ import annotations

import math
import sys as _sys
from dataclasses import dataclass
from datetime import date as _date
from pathlib import Path as _Path
from typing import List, Optional, Tuple

import numpy as np

# result_cache lives in graph-editor/lib (not under runner/). Add lib/ to the
# path on first import so the runner cluster can reach the shared utility
# without restructuring the package layout.
_lib_dir = str(_Path(__file__).resolve().parents[1])
if _lib_dir not in _sys.path:
    _sys.path.insert(0, _lib_dir)
import result_cache  # noqa: E402

from .model_resolver import ResolvedLatency, ResolvedModelParams
from .primitive_evidence import PrimitiveEvidenceResolution
from .primitives import (
    CompatibilityBlendProvenance,
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    DrawFamilyKey,
    DrawFamilyMode,
    PrimitiveScope,
    ProbabilityPosterior,
    SubsetPolicyProvenance,
    TimingFamily,
    TimingPosterior,
    TransitionIdentity,
    WeightedPrimitiveEvidenceView,
    make_rng,
)


# ─── Process-memory cache ──────────────────────────────────────────────

# Registered under the shared result_cache registry so snapshot-write
# bustcache (snapshot_service.cache_clear → result_cache.clear_all)
# flushes us in lockstep, and the request-body no_cache:true bypass
# (via the shared ContextVar) suppresses caching for one request
# without per-call plumbing.
_primitive_cache = result_cache.make_cache(
    'primitive',
    ttl_s=15 * 60,
    max_entries=1024,
)


def _primitive_cache_key(
    *,
    resolution: PrimitiveEvidenceResolution,
    resolved_model: ResolvedModelParams,
    scenario_seed: int,
    options: 'ConditioningPolicyOptions',
    prior_source: Optional[str],
) -> str:
    """Cache key for ``condition_primitive``.

    Captures every input that can change the conditioned posterior:
    transition + scope (via DrawFamilyKey canonical string), evidence
    identity (raw scope_key + weighted totals + binding policy),
    resolved model priors (alpha/beta + alpha_pred/beta_pred + mass +
    edge/path latency moments), conditioning options, and prior_source.

    Two calls that differ in any of these produce a distinct key; two
    calls that match in all of them are guaranteed to produce the same
    posterior (the function is deterministic given these inputs).
    """
    weighted = resolution.weighted_view
    if weighted is None:
        weighted_summary = None
    else:
        # Per-row tuple captured because the maturity-aware likelihood
        # depends on per-row (observed_date, retrieved_at, n_weighted,
        # k_weighted) and the doc-52 blend depends on raw n/k mass. Two
        # scopes with identical weighted totals but different raw rows
        # can produce different posteriors. Cache invalidation is
        # coarse-grained (result_cache.clear_all()), so the key has to
        # discriminate.
        row_summary = tuple(
            (
                row.observed_date,
                row.retrieved_at,
                int(row.n),
                int(row.k),
                float(row.n_weighted),
                float(row.k_weighted),
            )
            for row in weighted.rows
        )
        weighted_summary = (
            weighted.evidence_scope_key,
            weighted.binding_policy,
            float(weighted.n_weighted_total),
            float(weighted.k_weighted_total),
            row_summary,
        )
    edge_lat = resolved_model.edge_latency
    edge_lat_summary = (
        edge_lat.mu, edge_lat.sigma, edge_lat.onset_delta_days, edge_lat.t95,
        edge_lat.mu_sd, edge_lat.mu_sd_pred, edge_lat.sigma_sd,
        edge_lat.onset_sd, edge_lat.onset_mu_corr,
    )
    path_lat = resolved_model.path_latency
    path_lat_summary = (
        None if path_lat is None
        else (
            path_lat.mu, path_lat.sigma, path_lat.onset_delta_days, path_lat.t95,
            path_lat.mu_sd, path_lat.mu_sd_pred, path_lat.sigma_sd,
            path_lat.onset_sd, path_lat.onset_mu_corr,
        )
    )
    draw_family_key = DrawFamilyKey(
        transition_identity=resolution.transition,
        scope=resolution.primitive_scope,
        draw_count=options.draw_count,
        scenario_seed=scenario_seed,
    )
    return result_cache.make_key(
        'condition_primitive',
        draw_family=draw_family_key.canonical_string(),
        raw_scope_key=resolution.raw_evidence_set.provenance.scope_key,
        weighted=weighted_summary,
        prior_alpha=resolved_model.alpha,
        prior_beta=resolved_model.beta,
        prior_alpha_pred=resolved_model.alpha_pred,
        prior_beta_pred=resolved_model.beta_pred,
        n_effective=resolved_model.n_effective,
        edge_latency=edge_lat_summary,
        path_latency=path_lat_summary,
        timing_cdf_max_tau=options.timing_cdf_max_tau,
        prior_source=prior_source,
        resolved_source=resolved_model.source,
    )


# ─── Public API ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ConditioningPolicyOptions:
    """Knobs for the Stage 3 conditioning pass.

    ``draw_count`` is the request-scope ``S`` from plan §587. Two
    consumers presenting the same ``DrawFamilyKey`` under the same scope
    MUST present the same ``draw_count`` to receive coherent draws.
    """
    draw_count: int = 2000
    timing_cdf_max_tau: int = 90


def condition_primitive(
    *,
    resolution: PrimitiveEvidenceResolution,
    resolved_model: ResolvedModelParams,
    scenario_seed: int,
    options: ConditioningPolicyOptions = ConditioningPolicyOptions(),
    prior_source: Optional[str] = None,
) -> ConditionedTransitionPrimitive:
    cache_key = _primitive_cache_key(
        resolution=resolution,
        resolved_model=resolved_model,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
    )
    hit, cached = _primitive_cache.get(cache_key)
    if hit:
        return cached

    primitive = _condition_primitive_uncached(
        resolution=resolution,
        resolved_model=resolved_model,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
    )
    _primitive_cache.put(cache_key, primitive)
    return primitive


def _condition_primitive_uncached(
    *,
    resolution: PrimitiveEvidenceResolution,
    resolved_model: ResolvedModelParams,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
) -> ConditionedTransitionPrimitive:
    """Build a `ConditionedTransitionPrimitive` from a Stage 2 resolution.

    Plan §"Stage 3" stop condition (line 652): simple ``window(U-V)``
    output can be produced by reading the conditioned primitive rather
    than by a separate conditioning path; composed consumers do not
    re-run subset logic or compatibility blending; and a known-subset
    fixture proves the raw-nonempty/full-subset-limit case leaves the
    primitive equal to its model-var input.

    The function returns a fully-populated primitive in one of three
    states:

      - ``CONDITIONED``: live evidence available, posterior conjugate-
        updated and (optionally) doc-52 blended. ``probability_posterior``
        is non-prior; ``effective_evidence_totals`` records the evidence
        pressure actually applied.
      - ``PRIOR_ONLY``: ``E`` is empty (no rows admitted), so the
        posterior equals the prior. ``effective_evidence_totals = (0,0)``;
        ``equality_explicit=True`` (trivial equality).
      - ``DEGRADED``: arrival weights were degraded so every raw row
        was rejected as off-clock; the binder produced a zero-row
        weighted view. The primitive still carries the prior posterior
        so composers can fall back, but ``is_draw_coherent`` is False.

    The function never returns ``UNSUPPORTED_RESIDUAL`` or
    ``STRUCTURALLY_DETERMINISTIC`` — those statuses are emitted by
    Stage 4's residual/complement guard, not by primitive
    conditioning.
    """
    transition = resolution.transition
    primitive_scope = resolution.primitive_scope
    timing_family = _classify_timing(resolved_model.latency)

    draw_family_key = DrawFamilyKey(
        transition_identity=transition,
        scope=primitive_scope,
        draw_count=options.draw_count,
        scenario_seed=scenario_seed,
    )

    prior_alpha = max(float(resolved_model.alpha), 0.0)
    prior_beta = max(float(resolved_model.beta), 0.0)
    prior_posterior = _beta_summary(prior_alpha, prior_beta)
    timing_obj = _timing_posterior(
        latency=resolved_model.latency,
        family=timing_family,
        max_tau=options.timing_cdf_max_tau,
    )

    weighted_view = resolution.weighted_view
    n_w = float(weighted_view.n_weighted_total)
    k_w = float(weighted_view.k_weighted_total)
    # Doc-52 overlap accounting is raw/raw: the selected-set numerator is
    # the admitted raw row mass, while n_w/k_w remain the arrival-weighted
    # likelihood totals used by the conditioning update.
    m_S_doc52 = float(sum(float(row.n) for row in weighted_view.rows))
    raw_scope_key = weighted_view.evidence_scope_key

    # Degraded topology: raw points existed but every one was rejected
    # off-clock because arrival_weights[U] is degraded (no path from
    # root, horizon inadequate, etc.). The binder still produced a
    # zero-row weighted view; we surface the topology distinction here
    # so composers can refuse to draw from the primitive.
    is_degraded_topology = (
        weighted_view.arrival_weight_summary.get('topology_case') == 'degraded'
        and resolution.diagnostics.raw_point_count > 0
    )
    if is_degraded_topology:
        return _make_degraded_primitive(
            transition=transition,
            scope=primitive_scope,
            draw_count=options.draw_count,
            timing_family=timing_family,
            prior_posterior=prior_posterior,
            timing_obj=timing_obj,
            prior_source=prior_source,
            raw_evidence_scope_key=resolution.raw_evidence_set.provenance.scope_key,
            note=(
                f'arrival_weight[{transition.source_node}] degraded; '
                f'primitive falls back to prior'
            ),
        )

    if n_w <= 0.0:
        return _make_prior_only_primitive(
            transition=transition,
            scope=primitive_scope,
            draw_count=options.draw_count,
            timing_family=timing_family,
            prior_posterior=prior_posterior,
            prior_alpha=prior_alpha,
            prior_beta=prior_beta,
            timing_obj=timing_obj,
            prior_source=prior_source,
            raw_evidence_scope_key=raw_scope_key,
            weighted_view=weighted_view,
            draw_family_key=draw_family_key,
        )

    subset_policy = _compute_subset_policy(
        m_S=m_S_doc52,
        n_effective=resolved_model.n_effective,
    )

    (
        cond_p_draws,
        cond_cdf_draws,
        prior_p_draws,
        prior_cdf_draws,
        maturity_provenance,
    ) = _maturity_aware_conditioned_draws(
        weighted_view=weighted_view,
        resolved_latency=resolved_model.latency,
        timing_family=timing_family,
        timing_max_tau=options.timing_cdf_max_tau,
        prior_alpha=prior_alpha,
        prior_beta=prior_beta,
        prior_alpha_pred=(
            float(resolved_model.alpha_pred)
            if resolved_model.alpha_pred and resolved_model.alpha_pred > 0
            else None
        ),
        prior_beta_pred=(
            float(resolved_model.beta_pred)
            if resolved_model.beta_pred and resolved_model.beta_pred > 0
            else None
        ),
        n_w_total=n_w,
        k_w_total=k_w,
        draw_count=options.draw_count,
        draw_family_key=draw_family_key,
    )

    posterior_p_draws, posterior_cdf_draws, n_cond, blend_applied = (
        _apply_doc52_blend(
            cond_p_draws=cond_p_draws,
            prior_p_draws=prior_p_draws,
            cond_cdf_draws=cond_cdf_draws,
            prior_cdf_draws=prior_cdf_draws,
            subset_policy=subset_policy,
            draw_family_key=draw_family_key,
        )
    )

    posterior_mean = float(np.mean(posterior_p_draws))
    posterior_sd = float(np.std(posterior_p_draws))
    probability_posterior = ProbabilityPosterior(
        mean=posterior_mean,
        sd=posterior_sd,
        draws=posterior_p_draws,
    )

    # Joint-conditioning: when the IS pass produced per-draw CDF
    # particles, store them on the timing posterior alongside the
    # mean. The composer will resample these as one row family
    # (matching p index for index) — see plan §583, §591.
    if posterior_cdf_draws is not None:
        cdf_mean_post = tuple(float(v) for v in posterior_cdf_draws.mean(axis=0))
        timing_obj_posterior = TimingPosterior(
            family=timing_obj.family,
            cdf_mean=cdf_mean_post,
            cdf_draws=posterior_cdf_draws,
            deterministic_shift_days=timing_obj.deterministic_shift_days,
            structural_identity_compat=timing_obj.structural_identity_compat,
        )
    else:
        timing_obj_posterior = timing_obj

    if subset_policy.r is None:
        # Subset skipped — full E pressure applied; e == E by construction.
        eff_n = n_w
        eff_k = k_w
    else:
        # Effective evidence pressure: the conditioned-portion contribution
        # to the mixed posterior. (1 - r) of the draws are conditioned.
        eff_factor = max(0.0, 1.0 - float(subset_policy.r))
        eff_n = n_w * eff_factor
        eff_k = k_w * eff_factor

    compatibility_blend = CompatibilityBlendProvenance(
        applied=blend_applied,
        r=subset_policy.r,
        permutation_seed_derivation=(
            'doc52_blend_permutation' if blend_applied else None
        ),
        notes=(
            f'doc-52 row-mix at (1-r):r = ({1.0 - float(subset_policy.r):.4f}):'
            f'{float(subset_policy.r):.4f}, n_cond={n_cond}/{options.draw_count}'
            if blend_applied else None
        ),
    )

    return ConditionedTransitionPrimitive(
        transition=transition,
        scope=primitive_scope,
        draw_count=options.draw_count,
        status=ConditioningStatus.CONDITIONED,
        timing_family=timing_family,
        raw_evidence_scope_key=raw_scope_key,
        weighted_evidence=weighted_view,
        effective_evidence_totals=(eff_n, eff_k),
        subset_policy=subset_policy,
        compatibility_blend=compatibility_blend,
        residual_policy=None,
        probability_posterior=probability_posterior,
        timing_posterior=timing_obj_posterior,
        probability_prior=prior_posterior,
        timing_prior=timing_obj,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=draw_family_key,
        prior_source=prior_source,
        skipped_evidence_summary={
            'raw_point_count': resolution.diagnostics.raw_point_count,
            'bound_point_count': resolution.diagnostics.bound_point_count,
            'off_clock_rejection_count':
                resolution.diagnostics.off_clock_rejection_count,
        },
        notes=(
            f'topology_case={resolution.diagnostics.topology_case}',
            # ``n_eff_posterior`` is the posterior informational mass —
            # the conjugate equivalent of an ESS health diagnostic
            # (plan §648). For both the conjugate non-latent path and
            # the maturity-aware IS path the total weighted evidence
            # mass plus the prior mass is the right summary; IS-based
            # closure ESS is reported separately in the next note.
            f'n_eff_posterior={prior_alpha + prior_beta + n_w:.4f}',
            (
                f'maturity_aware_mode={maturity_provenance["mode"]} '
                f'rows_used={maturity_provenance["rows_used"]} '
                f'tempering_lambda={maturity_provenance["tempering_lambda"]:.4f} '
                f'ess={maturity_provenance["ess"]:.2f}'
            ),
        ),
    )


# ─── Internal helpers ──────────────────────────────────────────────────


def _classify_timing(latency: ResolvedLatency) -> TimingFamily:
    """Map a ResolvedLatency onto the Stage 1 TimingFamily enum.

    Plan §83-87, §583: ``sigma <= 0`` is a structural identity (the
    primitive's transition is non-latency). Otherwise the timing is
    latent and conditioned through composition.
    """
    if latency.sigma <= 0:
        return TimingFamily.NON_LATENT
    return TimingFamily.LATENT


def _beta_summary(alpha: float, beta: float) -> ProbabilityPosterior:
    """Mean and SD of Beta(alpha, beta) without sampling."""
    a = max(alpha, 1e-12)
    b = max(beta, 1e-12)
    total = a + b
    mean = a / total
    var = (a * b) / ((total ** 2) * (total + 1.0))
    sd = math.sqrt(max(var, 0.0))
    return ProbabilityPosterior(mean=mean, sd=sd, draws=None)


def _timing_posterior(
    *,
    latency: ResolvedLatency,
    family: TimingFamily,
    max_tau: int,
) -> TimingPosterior:
    """Build a TimingPosterior from a resolved latency block.

    Plan §83-87: NON_LATENT primitives carry Dirac-at-zero CDF.
    ``mu``/``sigma``/``onset``/``completeness`` compatibility fields go
    on ``structural_identity_compat`` for consumers that still expect
    those slots, but they are provenance only — never evidence-
    conditioned timing parameters.
    """
    compat = {
        'mu': float(latency.mu),
        'sigma': float(latency.sigma),
        'onset_delta_days': float(latency.onset_delta_days),
        't95': float(latency.t95),
    }
    if family == TimingFamily.NON_LATENT:
        cdf_mean = tuple(1.0 for _ in range(max_tau + 1))
        return TimingPosterior(
            family=family,
            cdf_mean=cdf_mean,
            cdf_draws=None,
            deterministic_shift_days=0,
            structural_identity_compat=compat,
        )
    cdf = []
    for tau in range(max_tau + 1):
        cdf.append(_lognormal_cdf(
            age_days=float(tau),
            mu=float(latency.mu),
            sigma=float(latency.sigma),
            onset=float(latency.onset_delta_days),
        ))
    return TimingPosterior(
        family=family,
        cdf_mean=tuple(cdf),
        cdf_draws=None,
        deterministic_shift_days=None,
        structural_identity_compat=compat,
    )


def _lognormal_cdf(
    *,
    age_days: float,
    mu: float,
    sigma: float,
    onset: float,
) -> float:
    """Shifted log-normal CDF at ``age_days``.

    Mirrors ``forecast_state._compute_completeness_at_age`` without the
    seed=71 SD draws (those are for completeness uncertainty bands;
    the primitive's timing posterior carries the mean curve).
    """
    model_age = age_days - onset
    if sigma <= 0:
        return 1.0 if model_age >= math.exp(mu) else 0.0
    if model_age <= 0:
        return 0.0
    z = (math.log(model_age) - mu) / sigma
    return 0.5 * math.erfc(-z / math.sqrt(2))


def _compute_subset_policy(
    *,
    m_S: float,
    n_effective: Optional[float],
) -> SubsetPolicyProvenance:
    """Doc-52 mass-ratio policy applied at primitive scope.

    Mirrors `forecast_state._compute_blend_params` but emits a
    ``SubsetPolicyProvenance`` (Stage 1 contract) rather than a dict.
    The contract distinguishes ``equality_explicit`` (no transformation
    applied — e == E by construction) from a numerical coincidence.
    """
    if n_effective is None:
        return SubsetPolicyProvenance(
            m_S=m_S,
            m_G=None,
            r=None,
            skip_reason='n_effective_missing',
            equality_explicit=True,
        )
    n_eff = float(n_effective)
    if n_eff <= 0.0:
        return SubsetPolicyProvenance(
            m_S=m_S,
            m_G=n_eff,
            r=None,
            skip_reason='n_effective_zero',
            equality_explicit=True,
        )
    if m_S <= 0.0:
        return SubsetPolicyProvenance(
            m_S=m_S,
            m_G=n_eff,
            r=None,
            skip_reason='no_cohorts',
            equality_explicit=True,
        )
    r = min(m_S / n_eff, 1.0)
    return SubsetPolicyProvenance(
        m_S=m_S,
        m_G=n_eff,
        r=r,
        skip_reason=None,
        equality_explicit=False,
    )


def _apply_doc52_blend(
    *,
    cond_p_draws: np.ndarray,
    prior_p_draws: np.ndarray,
    cond_cdf_draws: Optional[np.ndarray],
    prior_cdf_draws: Optional[np.ndarray],
    subset_policy: SubsetPolicyProvenance,
    draw_family_key: DrawFamilyKey,
) -> Tuple[np.ndarray, Optional[np.ndarray], int, bool]:
    """Mix conditioned and prior particles per doc-52 §14.5 (1−r):r ratio.

    Both probability and timing-CDF particles are mixed under one
    permutation: a draw slot ``i`` either receives the conditioned
    particle ``(p_cond[k], cdf_cond[k, :])`` or the prior particle
    ``(p_prior[k], cdf_prior[k, :])`` — never a mixed pair. This
    preserves the joint-conditioning invariant the IS pass establishes
    (plan §583, §591).

    When ``subset_policy.r`` is None (skip), no blend is applied —
    returns the conditioned arrays unchanged.
    """
    S = cond_p_draws.shape[0]
    if subset_policy.r is None:
        return cond_p_draws, cond_cdf_draws, S, False

    r = float(subset_policy.r)
    n_cond = int(round((1.0 - r) * S))
    n_cond = max(0, min(S, n_cond))
    blend_rng = make_rng(draw_family_key, 'doc52_blend_permutation')
    permutation = blend_rng.permutation(S)
    mixed_p = np.empty(S, dtype=cond_p_draws.dtype)
    if n_cond > 0:
        mixed_p[permutation[:n_cond]] = cond_p_draws[:n_cond]
    if n_cond < S:
        mixed_p[permutation[n_cond:]] = prior_p_draws[: S - n_cond]

    mixed_cdf: Optional[np.ndarray] = None
    if cond_cdf_draws is not None and prior_cdf_draws is not None:
        mixed_cdf = np.empty_like(cond_cdf_draws)
        if n_cond > 0:
            mixed_cdf[permutation[:n_cond], :] = cond_cdf_draws[:n_cond, :]
        if n_cond < S:
            mixed_cdf[permutation[n_cond:], :] = prior_cdf_draws[: S - n_cond, :]
    return mixed_p, mixed_cdf, n_cond, True


def _normalise_log_weights(log_weights: np.ndarray) -> Optional[np.ndarray]:
    """Convert log-weights to normalised weights with overflow shielding.

    Mirrors `forecast_state._normalise_log_weights` (this module
    intentionally does not import from forecast_state — see module
    docstring §52). Returns None when the input is empty or numerically
    degenerate.
    """
    if log_weights.size == 0:
        return None
    max_log_weight = float(np.max(log_weights))
    if not math.isfinite(max_log_weight):
        return None
    shifted = np.clip(log_weights - max_log_weight, -745.0, 0.0)
    weights = np.exp(shifted)
    weight_sum = float(np.sum(weights))
    if not math.isfinite(weight_sum) or weight_sum <= 0:
        return None
    return weights / weight_sum


def _weights_and_ess(
    log_likelihood: np.ndarray,
    tempering_lambda: float,
) -> Tuple[Optional[np.ndarray], float]:
    """Tempered weights and ESS for a given log-likelihood vector.

    Mirrors `forecast_state._weights_and_ess` (kept private here so
    primitive_conditioning stays import-free of forecast_state).
    """
    weights = _normalise_log_weights(log_likelihood * tempering_lambda)
    if weights is None:
        return (None, 0.0)
    ess = float(1.0 / np.sum(np.square(weights)))
    return (weights, ess)


def _row_age_days(row: 'WeightedEvidenceRow') -> Optional[int]:
    """Days between the row's observation date and its snapshot timestamp.

    The row's `observed_date` is the U-arrival anchor day after Stage 2
    clock-alignment via the prefix-arrival map; `retrieved_at` is the
    snapshot timestamp. The difference is the age at which the cohort
    was observed — the τ used by the maturity-aware Binomial likelihood
    `Bin(k | n, p · CDF(τ))`.

    Returns None when either date is missing or unparseable. The caller
    must discard rows for which τ cannot be derived.
    """
    if not row.observed_date or not row.retrieved_at:
        return None
    try:
        # retrieved_at may be a full ISO timestamp (YYYY-MM-DDTHH:MM:SS);
        # observed_date is YYYY-MM-DD. Slice to the date portion before
        # parsing to avoid hour/minute-zone fragility.
        retrieved = _date.fromisoformat(str(row.retrieved_at)[:10])
        observed = _date.fromisoformat(str(row.observed_date)[:10])
    except (TypeError, ValueError):
        return None
    return (retrieved - observed).days


def _maturity_aware_conditioned_draws(
    *,
    weighted_view: WeightedPrimitiveEvidenceView,
    resolved_latency: ResolvedLatency,
    timing_family: TimingFamily,
    timing_max_tau: int,
    prior_alpha: float,
    prior_beta: float,
    prior_alpha_pred: Optional[float],
    prior_beta_pred: Optional[float],
    n_w_total: float,
    k_w_total: float,
    draw_count: int,
    draw_family_key: DrawFamilyKey,
) -> Tuple[np.ndarray, Optional[np.ndarray], np.ndarray, Optional[np.ndarray], dict]:
    """Per-cohort maturity-aware likelihood pass with joint conditioning.

    For latent timing the proposal samples joint particles
    ``(p_s, μ_s, σ_s, onset_s)`` — ``p_s`` from the κ-inflated
    predictive Beta(α_pred, β_pred), and the timing parameters jointly
    from a multivariate normal at the resolved latency moments with
    onset/μ correlation per ``onset_mu_corr``. From those particles a
    per-draw shifted-lognormal CDF array ``cdf_arr[s, t]`` is built on
    the timing grid. The per-row likelihood evaluates
    ``Bin(k_w | n_w, p_s · cdf_arr[s, τ_row])`` so timing dispersion
    informs the posterior alongside the rate. Tempered IS finds the
    highest λ ∈ [0, 1] with ESS ≥ target, then a single index vector
    is drawn from the importance weights and applied to **both** the
    probability draws and the per-particle CDF rows. Plan §583, §591
    require draw-family coherence: the same row index must select a
    matching ``(p, cdf_curve)`` particle.

    For non-latent timing CDF ≡ 1.0, so the maturity-aware kernel
    degenerates to Bin(k|n, p) and the closed-form Beta-Binomial
    conjugate update on summed totals is exact at finite S. That fast
    path absorbs all dispersion into ``p`` and emits no per-draw CDF.

    Returns ``(cond_p_draws, cond_cdf_draws_or_None, prior_p_draws,
    prior_cdf_draws_or_None, provenance)``. The prior arrays are the
    unconditioned proposal samples used by the doc-52 blend.
    """
    p_rng = make_rng(draw_family_key, 'primitive_p_draws')
    prior_alpha_safe = max(prior_alpha, 1e-12)
    prior_beta_safe = max(prior_beta, 1e-12)
    # κ-inflated predictive proposal for IS. Falls back to epistemic
    # Beta if predictive moments are absent (analytic source without a
    # predictive surface, or zero/negative input).
    proposal_alpha = (
        float(prior_alpha_pred)
        if prior_alpha_pred and prior_alpha_pred > 0
        else prior_alpha_safe
    )
    proposal_beta = (
        float(prior_beta_pred)
        if prior_beta_pred and prior_beta_pred > 0
        else prior_beta_safe
    )
    proposal_alpha = max(proposal_alpha, 1e-12)
    proposal_beta = max(proposal_beta, 1e-12)

    def _conjugate_p_only(mode: str) -> Tuple[
        np.ndarray, None, np.ndarray, None, dict,
    ]:
        cond_alpha = max(prior_alpha + k_w_total, 1e-12)
        cond_beta = max(prior_beta + (n_w_total - k_w_total), 1e-12)
        cond_p = p_rng.beta(cond_alpha, cond_beta, size=draw_count)
        prior_p = p_rng.beta(prior_alpha_safe, prior_beta_safe, size=draw_count)
        return (cond_p, None, prior_p, None, {
            'mode': mode,
            'rows_used': 0,
            'tempering_lambda': 1.0,
            'ess': float(draw_count),
        })

    if timing_family == TimingFamily.NON_LATENT:
        # All dispersion in p; no per-particle CDF particle family.
        return _conjugate_p_only('conjugate_non_latent')

    T = int(timing_max_tau) + 1
    if T <= 1:
        return _conjugate_p_only('conjugate_no_timing_grid')

    row_evidence: List[Tuple[int, float, float]] = []
    for row in weighted_view.rows:
        tau = _row_age_days(row)
        if tau is None or tau <= 0:
            # τ=0 latent cohorts have c=0 and cannot inform p
            # (log(0) divergence). Skip.
            continue
        n_row = float(row.n_weighted)
        k_row = float(row.k_weighted)
        if n_row <= 0.0 or k_row < 0.0:
            continue
        row_evidence.append((min(int(tau), T - 1), n_row, k_row))

    if not row_evidence:
        return _conjugate_p_only('conjugate_no_usable_rows')

    # Joint proposal: p ~ Beta(α_pred, β_pred), (μ, σ, onset) ~
    # multivariate normal at the resolved moments with onset/μ
    # correlation. When all latency dispersions are zero the timing
    # particles collapse to a deterministic curve; we still build the
    # per-draw CDF array (every row identical) so the IS pass and the
    # downstream composer share one code path.
    proposal_p_draws = p_rng.beta(proposal_alpha, proposal_beta, size=draw_count)
    prior_p_draws = p_rng.beta(prior_alpha_safe, prior_beta_safe, size=draw_count)

    timing_rng = make_rng(draw_family_key, 'primitive_timing_draws')
    mu = float(resolved_latency.mu)
    sigma = float(resolved_latency.sigma)
    onset = float(resolved_latency.onset_delta_days)
    mu_sd = float(resolved_latency.mu_sd or 0.0)
    sigma_sd = float(resolved_latency.sigma_sd or 0.0)
    onset_sd = float(resolved_latency.onset_sd or 0.0)
    onset_mu_corr = float(resolved_latency.onset_mu_corr or 0.0)

    has_dispersions = (mu_sd > 0.0 or sigma_sd > 0.0 or onset_sd > 0.0)
    if has_dispersions:
        means = np.array([mu, sigma, onset], dtype=np.float64)
        sds = np.array([
            max(mu_sd, 1e-10),
            max(sigma_sd, 1e-10),
            max(onset_sd, 1e-10),
        ], dtype=np.float64)
        cov = np.diag(sds ** 2)
        # onset/μ correlation off-diagonal (mirrors
        # forecast_state.compute_forecast_trajectory's covariance build).
        cov[2, 0] = cov[0, 2] = onset_mu_corr * sds[2] * sds[0]
        timing_particles = timing_rng.multivariate_normal(
            means, cov, size=draw_count,
        )
        mu_draws = timing_particles[:, 0]
        sigma_draws = np.clip(timing_particles[:, 1], 0.01, 20.0)
        onset_draws = np.maximum(timing_particles[:, 2], 0.0)
    else:
        mu_draws = np.full(draw_count, mu)
        sigma_draws = np.full(draw_count, max(sigma, 0.01))
        onset_draws = np.full(draw_count, max(onset, 0.0))

    proposal_cdf_draws = _build_per_draw_cdf(
        mu_draws=mu_draws,
        sigma_draws=sigma_draws,
        onset_draws=onset_draws,
        T=T,
    )

    # Per-row joint likelihood: Bin(k_w | n_w, p_s · cdf_arr[s, τ_row]).
    log_lik = np.zeros(draw_count, dtype=np.float64)
    for tau_idx, n_row, k_row in row_evidence:
        c_per_draw = proposal_cdf_draws[:, tau_idx]
        p_eff = np.clip(proposal_p_draws * c_per_draw, 1e-15, 1.0 - 1e-15)
        log_lik += k_row * np.log(p_eff) + (n_row - k_row) * np.log1p(-p_eff)

    is_target_ess = 20.0
    best_w: Optional[np.ndarray] = None
    best_lam = 0.0
    best_ess = 0.0
    lo, hi = 0.0, 1.0
    for _ in range(20):
        mid = (lo + hi) / 2.0
        w, ess = _weights_and_ess(log_lik, mid)
        if w is not None and ess >= is_target_ess:
            best_w, best_lam, best_ess = w, mid, ess
            lo = mid
        else:
            hi = mid
    w_full, ess_full = _weights_and_ess(log_lik, 1.0)
    if w_full is not None and ess_full >= is_target_ess:
        best_w, best_lam, best_ess = w_full, 1.0, ess_full

    if best_w is not None:
        is_rng = make_rng(draw_family_key, 'primitive_is_resampling')
        indices = is_rng.choice(
            draw_count, size=draw_count, replace=True, p=best_w,
        )
        cond_p_draws = proposal_p_draws[indices]
        cond_cdf_draws = proposal_cdf_draws[indices, :]
        return (
            cond_p_draws,
            cond_cdf_draws,
            prior_p_draws,
            proposal_cdf_draws,
            {
                'mode': 'maturity_aware_is_joint',
                'rows_used': len(row_evidence),
                'tempering_lambda': float(best_lam),
                'ess': float(best_ess),
            },
        )

    # IS failed to reach target ESS at any λ — fall back to the
    # conjugate result on totals. p still gets a posterior; timing
    # collapses back to the unconditioned proposal CDF.
    cond_alpha = max(prior_alpha + k_w_total, 1e-12)
    cond_beta = max(prior_beta + (n_w_total - k_w_total), 1e-12)
    cond_p_draws = p_rng.beta(cond_alpha, cond_beta, size=draw_count)
    return (
        cond_p_draws,
        proposal_cdf_draws,
        prior_p_draws,
        proposal_cdf_draws,
        {
            'mode': 'conjugate_is_failed',
            'rows_used': len(row_evidence),
            'tempering_lambda': 0.0,
            'ess': 0.0,
        },
    )


def _build_per_draw_cdf(
    *,
    mu_draws: np.ndarray,
    sigma_draws: np.ndarray,
    onset_draws: np.ndarray,
    T: int,
) -> np.ndarray:
    """Shifted log-normal CDF on a (S, T) grid for the joint particles.

    ``cdf[s, t] = Φ((log(t - onset_s) - μ_s) / σ_s)`` for ``t > onset_s``,
    zero otherwise. Vectorised across draws and tau via
    ``scipy.special.erfc``."""
    from scipy.special import erfc as _erfc
    tau_grid = np.arange(T, dtype=np.float64)[None, :]  # (1, T)
    onset = onset_draws[:, None]  # (S, 1)
    model_age = tau_grid - onset
    safe_age = np.where(model_age > 0.0, model_age, 1.0)
    log_age = np.log(safe_age)
    sigma = np.where(sigma_draws[:, None] > 0.0, sigma_draws[:, None], 1.0)
    z = (log_age - mu_draws[:, None]) / sigma
    cdf = 0.5 * _erfc(-z / math.sqrt(2.0))
    cdf = np.where(model_age > 0.0, cdf, 0.0)
    return np.clip(cdf, 0.0, 1.0)


def _make_prior_only_primitive(
    *,
    transition: TransitionIdentity,
    scope: PrimitiveScope,
    draw_count: int,
    timing_family: TimingFamily,
    prior_posterior: ProbabilityPosterior,
    prior_alpha: float,
    prior_beta: float,
    timing_obj: TimingPosterior,
    prior_source: Optional[str],
    raw_evidence_scope_key: Optional[str],
    weighted_view: WeightedPrimitiveEvidenceView,
    draw_family_key: DrawFamilyKey,
) -> ConditionedTransitionPrimitive:
    """Build a PRIOR_ONLY primitive (n_weighted_total == 0).

    ``equality_explicit`` is True because no transformation is applied
    between empty E and empty e (trivial equality).

    Plan §95 / §570 require that prior-only primitives remain usable by
    composition; the Stage 1 contract test
    (``test_prior_only_primitive_has_empty_evidence_and_is_not_misreported``)
    asserts ``is_draw_coherent`` and that ``probability_draws()`` returns
    a populated array. We sample ``draw_count`` draws from
    ``Beta(prior_alpha, prior_beta)`` via the keyed-RNG seam so two
    consumers reading the same prior-only primitive under the same
    scope receive identical draws (plan §141, §585-589).
    """
    subset_policy = SubsetPolicyProvenance(
        m_S=0.0,
        m_G=None,
        r=None,
        skip_reason='no_evidence',
        equality_explicit=True,
    )
    p_rng = make_rng(draw_family_key, 'primitive_p_draws')
    prior_draws = p_rng.beta(
        max(prior_alpha, 1e-12),
        max(prior_beta, 1e-12),
        size=draw_count,
    )
    posterior = ProbabilityPosterior(
        mean=float(prior_posterior.mean),
        sd=float(prior_posterior.sd) if prior_posterior.sd is not None else 0.0,
        draws=prior_draws,
    )
    return ConditionedTransitionPrimitive(
        transition=transition,
        scope=scope,
        draw_count=draw_count,
        status=ConditioningStatus.PRIOR_ONLY,
        timing_family=timing_family,
        raw_evidence_scope_key=raw_evidence_scope_key,
        weighted_evidence=weighted_view,
        effective_evidence_totals=(0.0, 0.0),
        subset_policy=subset_policy,
        compatibility_blend=CompatibilityBlendProvenance(
            applied=False,
            r=None,
            permutation_seed_derivation=None,
            notes=None,
        ),
        residual_policy=None,
        probability_posterior=posterior,
        timing_posterior=timing_obj,
        probability_prior=prior_posterior,
        timing_prior=timing_obj,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=draw_family_key,
        prior_source=prior_source,
        skipped_evidence_summary={},
        notes=('status=prior_only',),
    )


def _make_degraded_primitive(
    *,
    transition: TransitionIdentity,
    scope: PrimitiveScope,
    draw_count: int,
    timing_family: TimingFamily,
    prior_posterior: ProbabilityPosterior,
    timing_obj: TimingPosterior,
    prior_source: Optional[str],
    raw_evidence_scope_key: Optional[str],
    note: str,
) -> ConditionedTransitionPrimitive:
    """Build a DEGRADED primitive when Stage 2 produced no weighted view.

    A degraded primitive carries the prior so composers can read a
    fallback summary, but ``is_draw_coherent`` is False — Stage 1's
    contract refuses ``probability_draws()`` for this status.
    """
    return ConditionedTransitionPrimitive(
        transition=transition,
        scope=scope,
        draw_count=draw_count,
        status=ConditioningStatus.DEGRADED,
        timing_family=timing_family,
        raw_evidence_scope_key=raw_evidence_scope_key,
        weighted_evidence=None,
        effective_evidence_totals=None,
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=prior_posterior,
        timing_posterior=timing_obj,
        probability_prior=prior_posterior,
        timing_prior=timing_obj,
        draw_family_mode=DrawFamilyMode.MOMENTS_ONLY,
        draw_family_key=None,
        prior_source=prior_source,
        skipped_evidence_summary={},
        notes=(note,),
    )


# ─── Unconditioned primitives (model-curve overlays) ───────────────────


def make_unconditioned_primitive(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    resolved_model: ResolvedModelParams,
    scenario_seed: int,
    options: ConditioningPolicyOptions = ConditioningPolicyOptions(),
    dispersion_basis: str = 'epistemic',
    prior_source: Optional[str] = None,
) -> ConditionedTransitionPrimitive:
    """Build an unconditioned primitive carrying joint prior draws.

    No evidence binding, no IS resample, no doc-52 blend — the draws are
    the prior model's belief about ``(p, μ, σ, onset)`` and the per-draw
    CDF derived from those particles. This is the surface the
    cohort_maturity chart's F mode (predictive bands) and the optional
    epistemic model curve project against.

    ``dispersion_basis`` selects which moment family the proposal uses:

      - ``'predictive'`` (F mode): ``p ~ Beta(α_pred, β_pred)``,
        ``μ ~ N(μ, mu_sd_pred or mu_sd)`` — the κ-inflated predictive
        envelope. Used to populate the ``model_*`` row fields the chart
        renders as the "wide" model fan.
      - ``'epistemic'`` (model curve): ``p ~ Beta(α, β)``,
        ``μ ~ N(μ, mu_sd)`` — the tight posterior surface. Used to
        populate the optional ``model_curve_*`` row fields.

    Both bases share ``sigma_sd`` and ``onset_sd`` (epistemic only — the
    resolver does not carry predictive variants of those).
    """
    timing_family = _classify_timing(resolved_model.latency)
    draw_family_key = DrawFamilyKey(
        transition_identity=transition,
        scope=primitive_scope,
        draw_count=options.draw_count,
        scenario_seed=scenario_seed,
    )

    prior_alpha = max(float(resolved_model.alpha or 0.0), 1e-12)
    prior_beta = max(float(resolved_model.beta or 0.0), 1e-12)
    pred_alpha = float(resolved_model.alpha_pred or 0.0)
    pred_beta = float(resolved_model.beta_pred or 0.0)

    if dispersion_basis == 'predictive':
        sample_alpha = pred_alpha if pred_alpha > 0 else prior_alpha
        sample_beta = pred_beta if pred_beta > 0 else prior_beta
    else:
        sample_alpha = prior_alpha
        sample_beta = prior_beta

    p_rng = make_rng(draw_family_key, 'primitive_p_draws')
    p_draws = p_rng.beta(
        max(sample_alpha, 1e-12),
        max(sample_beta, 1e-12),
        size=options.draw_count,
    )

    prior_posterior = _beta_summary(prior_alpha, prior_beta)
    timing_obj_prior = _timing_posterior(
        latency=resolved_model.latency,
        family=timing_family,
        max_tau=options.timing_cdf_max_tau,
    )

    if timing_family == TimingFamily.NON_LATENT:
        # All dispersion in p; structural identity timing.
        posterior_summary = ProbabilityPosterior(
            mean=float(np.mean(p_draws)),
            sd=float(np.std(p_draws)),
            draws=p_draws,
        )
        return ConditionedTransitionPrimitive(
            transition=transition,
            scope=primitive_scope,
            draw_count=options.draw_count,
            status=ConditioningStatus.PRIOR_ONLY,
            timing_family=timing_family,
            raw_evidence_scope_key=None,
            weighted_evidence=None,
            effective_evidence_totals=(0.0, 0.0),
            subset_policy=SubsetPolicyProvenance(
                m_S=0.0, m_G=None, r=None,
                skip_reason=f'unconditioned_overlay:{dispersion_basis}',
                equality_explicit=True,
            ),
            compatibility_blend=CompatibilityBlendProvenance(
                applied=False, r=None,
                permutation_seed_derivation=None, notes=None,
            ),
            residual_policy=None,
            probability_posterior=posterior_summary,
            timing_posterior=timing_obj_prior,
            probability_prior=prior_posterior,
            timing_prior=timing_obj_prior,
            draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
            draw_family_key=draw_family_key,
            prior_source=prior_source,
            skipped_evidence_summary={},
            notes=(
                f'status=unconditioned_overlay '
                f'dispersion_basis={dispersion_basis} '
                f'timing_family=non_latent',
            ),
        )

    # Latent: sample joint timing particles at the requested basis.
    lat = resolved_model.latency
    mu = float(lat.mu)
    sigma = float(lat.sigma)
    onset = float(lat.onset_delta_days)
    if dispersion_basis == 'predictive':
        mu_sd = float(lat.mu_sd_pred or lat.mu_sd or 0.0)
    else:
        mu_sd = float(lat.mu_sd or 0.0)
    sigma_sd = float(lat.sigma_sd or 0.0)
    onset_sd = float(lat.onset_sd or 0.0)
    onset_mu_corr = float(lat.onset_mu_corr or 0.0)

    timing_rng = make_rng(draw_family_key, 'primitive_timing_draws')
    has_dispersions = (mu_sd > 0.0 or sigma_sd > 0.0 or onset_sd > 0.0)
    if has_dispersions:
        means = np.array([mu, sigma, onset], dtype=np.float64)
        sds = np.array([
            max(mu_sd, 1e-10),
            max(sigma_sd, 1e-10),
            max(onset_sd, 1e-10),
        ], dtype=np.float64)
        cov = np.diag(sds ** 2)
        cov[2, 0] = cov[0, 2] = onset_mu_corr * sds[2] * sds[0]
        timing_particles = timing_rng.multivariate_normal(
            means, cov, size=options.draw_count,
        )
        mu_draws = timing_particles[:, 0]
        sigma_draws = np.clip(timing_particles[:, 1], 0.01, 20.0)
        onset_draws = np.maximum(timing_particles[:, 2], 0.0)
    else:
        mu_draws = np.full(options.draw_count, mu)
        sigma_draws = np.full(options.draw_count, max(sigma, 0.01))
        onset_draws = np.full(options.draw_count, max(onset, 0.0))

    cdf_draws = _build_per_draw_cdf(
        mu_draws=mu_draws,
        sigma_draws=sigma_draws,
        onset_draws=onset_draws,
        T=int(options.timing_cdf_max_tau) + 1,
    )

    posterior_summary = ProbabilityPosterior(
        mean=float(np.mean(p_draws)),
        sd=float(np.std(p_draws)),
        draws=p_draws,
    )
    cdf_mean_curve = tuple(float(v) for v in cdf_draws.mean(axis=0))
    timing_obj_overlay = TimingPosterior(
        family=timing_family,
        cdf_mean=cdf_mean_curve,
        cdf_draws=cdf_draws,
        deterministic_shift_days=timing_obj_prior.deterministic_shift_days,
        structural_identity_compat=timing_obj_prior.structural_identity_compat,
    )

    return ConditionedTransitionPrimitive(
        transition=transition,
        scope=primitive_scope,
        draw_count=options.draw_count,
        status=ConditioningStatus.PRIOR_ONLY,
        timing_family=timing_family,
        raw_evidence_scope_key=None,
        weighted_evidence=None,
        effective_evidence_totals=(0.0, 0.0),
        subset_policy=SubsetPolicyProvenance(
            m_S=0.0, m_G=None, r=None,
            skip_reason=f'unconditioned_overlay:{dispersion_basis}',
            equality_explicit=True,
        ),
        compatibility_blend=CompatibilityBlendProvenance(
            applied=False, r=None,
            permutation_seed_derivation=None, notes=None,
        ),
        residual_policy=None,
        probability_posterior=posterior_summary,
        timing_posterior=timing_obj_overlay,
        probability_prior=prior_posterior,
        timing_prior=timing_obj_prior,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=draw_family_key,
        prior_source=prior_source,
        skipped_evidence_summary={},
        notes=(
            f'status=unconditioned_overlay '
            f'dispersion_basis={dispersion_basis} '
            f'timing_family=latent',
        ),
    )


__all__ = [
    'ConditioningPolicyOptions',
    'condition_primitive',
    'make_unconditioned_primitive',
]
