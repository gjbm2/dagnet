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
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date as _date
from pathlib import Path as _Path
from typing import Dict, List, Optional, Tuple

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

    # ── Plan stage ──
    plan = _build_cohort_likelihood_plan(
        weighted_view=weighted_view,
        timing_family=timing_family,
        timing_max_tau=options.timing_cdf_max_tau,
    )

    # ── Evaluate stage ──
    outcome = _evaluate_likelihood_plan(
        plan,
        resolved_latency=resolved_model.latency,
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
        draw_count=options.draw_count,
        draw_family_key=draw_family_key,
    )

    # ── Materialise stage ──
    if outcome.status == 'prior_only':
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
            prior_only_reason=outcome.reason,
            plan_provenance=plan.provenance,
        )

    # CONDITIONED branch: doc-52 subset policy + blend, then build the
    # primitive with cohort-aggregate-driven effective totals.
    subset_policy = _compute_subset_policy(
        m_S=plan.m_S_doc52,
        n_effective=resolved_model.n_effective,
    )

    posterior_p_draws, posterior_cdf_draws, n_cond, blend_applied = (
        _apply_doc52_blend(
            cond_p_draws=outcome.cond_p_draws,
            prior_p_draws=outcome.prior_p_draws,
            cond_cdf_draws=outcome.cond_cdf_draws,
            prior_cdf_draws=outcome.prior_cdf_draws,
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

    # ``effective_evidence_totals`` is post-blend: cohort-aggregate
    # weighted totals scaled by (1 − r). The (1 − r) factor preserves
    # the doc-52 compatibility blend; the substitution from row-level
    # totals to cohort-aggregate totals is operand-only and removes the
    # per-retrieval over-count that fell out of the per-retrieval merge
    # rekey.
    n_cohort, k_cohort = outcome.cohort_aggregate
    if subset_policy.r is None:
        eff_n = n_cohort
        eff_k = k_cohort
    else:
        eff_factor = max(0.0, 1.0 - float(subset_policy.r))
        eff_n = n_cohort * eff_factor
        eff_k = k_cohort * eff_factor

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
            **(
                {'plan_provenance': list(plan.provenance)}
                if plan.provenance else {}
            ),
        },
        notes=(
            f'topology_case={resolution.diagnostics.topology_case}',
            # ``n_eff_posterior`` is the posterior informational mass —
            # the conjugate equivalent of an ESS health diagnostic
            # (plan §648). After the per-retrieval merge rekey and the
            # plan/evaluate/materialise refactor, the cohort-aggregate
            # weighted total is what drove the posterior; the row-level
            # admitted total is preserved on the next line as a
            # diagnostic.
            f'n_eff_posterior={prior_alpha + prior_beta + n_cohort:.4f}',
            f'cohort_aggregate_pre_blend=({n_cohort:.4f},{k_cohort:.4f})',
            (
                f'row_level_admitted_total='
                f'({plan.row_level_n_weighted_total:.4f},'
                f'{plan.row_level_k_weighted_total:.4f})'
            ),
            (
                f'maturity_aware_mode={outcome.provenance["mode"]} '
                f'cohorts_used={outcome.provenance["cohorts_used"]} '
                f'tempering_lambda={outcome.provenance["tempering_lambda"]:.4f} '
                f'ess={outcome.provenance["ess"]:.2f}'
            ),
            *(f'plan_provenance: {entry}' for entry in plan.provenance),
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


# ─── Cohort likelihood plan + outcome (plan → evaluate → materialise) ──
#
# One resolution path; cases differ by degeneration, not branching
# (Implementation Invariant 1 of COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_
# SEMANTICS §"Implementation invariants", AP58). Non-latent is a
# degeneration of latent; "no evidence", "no timing grid", "no latent
# rows", and "IS failed" are all reasons-as-data on a prior-only
# outcome rather than separate code paths.


@dataclass(frozen=True)
class _CohortLatest:
    """Latest retrieval per (observed_date) within a primitive's evidence view."""

    observed_date: str
    retrieved_at: Optional[str]
    n_raw: int
    k_raw: int
    n_weighted: float
    k_weighted: float


@dataclass(frozen=True)
class _CohortBucket:
    """Multinomial cell decomposition for one cohort under latent timing.

    ``increments`` carries one entry per retrieval after Pass-2 dedup
    (zero-increment cells preserved so the cell decomposition advances
    the CDF lower bound through plateau intervals as the multinomial
    requires). Sorted by τ ascending.

    ``last_observed_tau_idx`` is the τ at the trajectory's actual
    final retrieval — used as the residual cell's upper bound so a
    plateau at the trajectory tail does not evaluate residual survival
    too early.

    ``last_k_weighted`` is the cumulative weighted observed count at
    the trajectory's final retrieval; residual count is
    ``n_weighted − last_k_weighted`` (clamped at 0).
    """

    observed_date: str
    n_weighted: float
    increments: Tuple[Tuple[int, float], ...]
    last_observed_tau_idx: int
    last_k_weighted: float


@dataclass(frozen=True)
class _CohortLikelihoodPlan:
    """Single canonical description of the evidence consumed by the
    evaluator and the materialise stages.

    Two passes feed it: (1) timing-family-independent aggregation by
    full-timestamp ordering, producing ``cohort_latest`` /
    ``cohort_*_weighted_total`` / ``m_S_doc52``; (2) latent-only τ-bucket
    construction, producing ``cohort_buckets``.

    ``evaluable`` is the load-bearing semantic flag — true iff this
    plan has evidence capable of moving the posterior. When false,
    ``unevaluable_reason`` names the degeneration; the evaluator will
    return prior-only with that reason.
    """

    cohort_latest: Tuple[_CohortLatest, ...]
    cohort_buckets: Tuple[_CohortBucket, ...]
    cohort_n_weighted_total: float
    cohort_k_weighted_total: float
    m_S_doc52: float
    row_level_n_weighted_total: float
    row_level_k_weighted_total: float
    timing_family: TimingFamily
    timing_max_tau: int
    evaluable: bool
    unevaluable_reason: Optional[str]
    provenance: Tuple[str, ...]


@dataclass(frozen=True)
class _ConditioningOutcome:
    """Result of evaluating a likelihood plan.

    ``status`` is the load-bearing field. ``'prior_only'`` outcomes
    carry a ``reason`` that names the degeneration; ``'conditioned'``
    outcomes carry the conditioned and prior draw families plus the
    cohort aggregate that drove the posterior.
    """

    status: str
    reason: Optional[str] = None
    cond_p_draws: Optional[np.ndarray] = None
    cond_cdf_draws: Optional[np.ndarray] = None
    prior_p_draws: Optional[np.ndarray] = None
    prior_cdf_draws: Optional[np.ndarray] = None
    cohort_aggregate: Optional[Tuple[float, float]] = None
    provenance: Optional[Dict[str, object]] = None


def _build_cohort_likelihood_plan(
    weighted_view: WeightedPrimitiveEvidenceView,
    timing_family: TimingFamily,
    timing_max_tau: int,
) -> _CohortLikelihoodPlan:
    """Read evidence once and produce the canonical plan.

    Pass 1 is timing-family-independent: requires only
    ``(observed_date, retrieved_at)`` parseable. Resolves
    same-retrieval conflicts and selects the latest retrieval per
    ``observed_date``. Drives ``cohort_aggregate`` and ``m_S_doc52``.

    Pass 2 is latent-only: requires ``τ = retrieved_at − observed_date
    > 0``. Builds the multinomial τ-cell decomposition per cohort.

    Same-retrieval conflict rule (applied in Pass 1 *before* monotone-k
    clamping so the clamp cannot mask the diagnostic values):

    1. Identical (n_weighted, k_weighted) under exact float equality →
       coalesce silently.
    2. Distinct full timestamps → keep the row with the later
       full-timestamp ``retrieved_at``; record dropped row's timestamp.
    3. Same full timestamp, non-identical (n_weighted, k_weighted) →
       skip the entire cohort group (do not partially admit) and
       record provenance.
    """
    rows = list(weighted_view.rows)

    row_level_n_total = float(sum(float(r.n_weighted) for r in rows))
    row_level_k_total = float(sum(float(r.k_weighted) for r in rows))

    provenance: list[str] = []

    # ── Pass 1: aggregation (timing-family-independent) ──
    #
    # Group by observed_date; drop rows with unparseable dates or
    # zero/negative cohort weight; resolve same-retrieval conflicts;
    # pick the latest retrieval per observed_date.
    by_obs: Dict[str, list] = defaultdict(list)
    parse_failed = 0
    zero_weight = 0
    for row in rows:
        if not row.retrieved_at or not row.observed_date:
            parse_failed += 1
            continue
        try:
            _date.fromisoformat(str(row.retrieved_at)[:10])
            _date.fromisoformat(str(row.observed_date)[:10])
        except (TypeError, ValueError):
            parse_failed += 1
            continue
        if float(row.n_weighted) <= 0.0:
            zero_weight += 1
            continue
        by_obs[row.observed_date].append(row)

    if parse_failed:
        provenance.append(f'rows_with_unparseable_dates={parse_failed}')
    if zero_weight:
        provenance.append(f'rows_with_zero_weight={zero_weight}')

    # Per-trajectory same-timestamp dedup (§5 rules across the whole
    # trajectory): for every retrieved_at within each cohort group,
    # apply the §5 collision rules. Identical-value collisions coalesce
    # silently; non-identical-value collisions skip the entire cohort.
    # The result is ``by_obs_deduped`` — at most one row per
    # (od, retrieved_at) — which both Pass 1 and Pass 2 consume.
    by_obs_deduped: Dict[str, list] = {}
    cohort_skipped_obs: set[str] = set()
    skipped_groups = 0
    for od, group in by_obs.items():
        by_retrieved: Dict[str, list] = defaultdict(list)
        for row in group:
            by_retrieved[str(row.retrieved_at)].append(row)

        cohort_must_skip = False
        deduped_rows: list = []
        for retrieved_ts, rows_at_ts in by_retrieved.items():
            if len(rows_at_ts) > 1:
                ref_n = float(rows_at_ts[0].n_weighted)
                ref_k = float(rows_at_ts[0].k_weighted)
                all_equal = all(
                    float(r.n_weighted) == ref_n
                    and float(r.k_weighted) == ref_k
                    for r in rows_at_ts
                )
                if not all_equal:
                    provenance.append(
                        f'same_retrieval_conflict_skipped['
                        f'od={od},retrieved_at={retrieved_ts},'
                        f'pairs={[(float(r.n_weighted), float(r.k_weighted)) for r in rows_at_ts]}]'
                    )
                    cohort_must_skip = True
                    break
            deduped_rows.append(rows_at_ts[0])

        if cohort_must_skip:
            cohort_skipped_obs.add(od)
            skipped_groups += 1
            continue
        by_obs_deduped[od] = deduped_rows

    if skipped_groups:
        provenance.append(f'cohort_groups_skipped_by_conflict={skipped_groups}')

    # Pass 1 proper: pick latest retrieved_at per cohort from the
    # deduped trajectory. Multiple retrievals per cohort is the normal
    # case under the per-retrieval merge — not flagged as a "conflict".
    cohort_latest_list: list[_CohortLatest] = []
    for od, deduped_rows in by_obs_deduped.items():
        sorted_rows = sorted(
            deduped_rows,
            key=lambda r: str(r.retrieved_at),
            reverse=True,
        )
        latest = sorted_rows[0]
        cohort_latest_list.append(_CohortLatest(
            observed_date=latest.observed_date,
            retrieved_at=latest.retrieved_at,
            n_raw=int(latest.n),
            k_raw=int(latest.k),
            n_weighted=float(latest.n_weighted),
            k_weighted=float(latest.k_weighted),
        ))

    cohort_n_total = float(sum(c.n_weighted for c in cohort_latest_list))
    cohort_k_total = float(sum(c.k_weighted for c in cohort_latest_list))
    m_S_doc52 = float(sum(c.n_raw for c in cohort_latest_list))

    # ── Pass 2: τ-bucket construction (latent only) ──
    #
    # Iterates ``by_obs_deduped`` so the trajectory passed to bucket
    # construction is already conflict-free at full-timestamp
    # granularity. Emits one entry per dedup'd retrieval — including
    # zero-count plateau cells — so the multinomial loop can advance
    # the CDF lower bound through plateaus per §3:
    #
    #   log_lik_d = Σᵢ (kᵢ − kᵢ₋₁) · log(p · (F(τᵢ) − F(τᵢ₋₁)))
    #             + (n_d − kₘ) · log(1 − p · F(τₘ))
    #
    # where i ranges over **all** retrievals (k₀ ≡ 0, F(τ₀) ≡ 0). The
    # residual cell uses ``last_observed_tau_idx`` — the trajectory's
    # actual final τ — so plateau-tail cohorts evaluate survival at the
    # correct upper bound rather than at an earlier last-positive cell.
    cohort_buckets_list: list[_CohortBucket] = []
    if timing_family == TimingFamily.LATENT and timing_max_tau >= 1:
        T = int(timing_max_tau) + 1
        for od, deduped_rows in by_obs_deduped.items():
            tau_rows: list[tuple[int, object]] = []
            for row in deduped_rows:
                tau = _row_age_days(row)
                if tau is None or tau <= 0:
                    continue
                tau_rows.append((min(int(tau), T - 1), row))
            if not tau_rows:
                continue
            tau_rows.sort(key=lambda x: (x[0], str(x[1].retrieved_at)))
            # Collapse rows that share an integer τ but have distinct
            # sub-day full timestamps. ``by_obs_deduped`` already
            # enforced full-timestamp uniqueness, so this only fires
            # when distinct timestamps round to the same τ_int.
            deduped: list[tuple[int, object]] = []
            i = 0
            while i < len(tau_rows):
                j = i + 1
                while j < len(tau_rows) and tau_rows[j][0] == tau_rows[i][0]:
                    j += 1
                same_tau = tau_rows[i:j]
                if len(same_tau) == 1:
                    deduped.append(same_tau[0])
                else:
                    same_tau_latest = max(
                        same_tau,
                        key=lambda x: str(x[1].retrieved_at),
                    )
                    deduped.append(same_tau_latest)
                i = j
            n_d = float(deduped[-1][1].n_weighted)
            last_observed_tau_idx = int(deduped[-1][0])
            increments: list[tuple[int, float]] = []
            prev_k = 0.0
            for tau_idx, row in deduped:
                k = float(row.k_weighted)
                if k < prev_k:
                    provenance.append(
                        f'monotone_k_clamp_fired['
                        f'od={od},tau={tau_idx},'
                        f'k_observed={k:.6f},k_clamped_to={prev_k:.6f}]'
                    )
                    k = prev_k
                inc = k - prev_k
                # Append every retrieval (positive AND zero increments).
                # Zero cells contribute 0·log(p·ΔF) = 0 to the
                # likelihood but must remain in the trajectory so the
                # next positive cell uses the correct ΔF lower bound.
                increments.append((tau_idx, inc))
                prev_k = k
            if not increments:
                continue
            last_k = min(prev_k, n_d)
            cohort_buckets_list.append(_CohortBucket(
                observed_date=od,
                n_weighted=n_d,
                increments=tuple(increments),
                last_observed_tau_idx=last_observed_tau_idx,
                last_k_weighted=last_k,
            ))

    # ── Reason precedence: no_evidence wins regardless of family ──
    evaluable = False
    unevaluable_reason: Optional[str] = None
    if cohort_n_total <= 0.0:
        unevaluable_reason = 'no_evidence'
    elif timing_family == TimingFamily.LATENT and timing_max_tau < 1:
        unevaluable_reason = 'no_timing_grid'
    elif timing_family == TimingFamily.LATENT and not cohort_buckets_list:
        unevaluable_reason = 'no_latent_rows'
    else:
        evaluable = True

    return _CohortLikelihoodPlan(
        cohort_latest=tuple(cohort_latest_list),
        cohort_buckets=tuple(cohort_buckets_list),
        cohort_n_weighted_total=cohort_n_total,
        cohort_k_weighted_total=cohort_k_total,
        m_S_doc52=m_S_doc52,
        row_level_n_weighted_total=row_level_n_total,
        row_level_k_weighted_total=row_level_k_total,
        timing_family=timing_family,
        timing_max_tau=int(timing_max_tau),
        evaluable=evaluable,
        unevaluable_reason=unevaluable_reason,
        provenance=tuple(provenance),
    )


def _evaluate_likelihood_plan(
    plan: _CohortLikelihoodPlan,
    *,
    resolved_latency: ResolvedLatency,
    prior_alpha: float,
    prior_beta: float,
    prior_alpha_pred: Optional[float],
    prior_beta_pred: Optional[float],
    draw_count: int,
    draw_family_key: DrawFamilyKey,
) -> _ConditioningOutcome:
    """Evaluate the plan and emit one ``_ConditioningOutcome``.

    Cases on plan data, not on incidental row presence:

    - ``not plan.evaluable`` → prior_only(reason=plan.unevaluable_reason).
      Covers ``no_evidence``, ``no_timing_grid``, ``no_latent_rows``.
    - non-latent timing → cohort-level Beta-Binomial conjugate update on
      ``plan.cohort_*_weighted_total``. The F ≡ 1 degeneration of the
      multinomial.
    - latent timing → multinomial IS over ``plan.cohort_buckets``.
      If IS cannot find an ESS-feasible λ → prior_only(reason='is_failed').

    The non-latent path is the only remaining caller of
    ``_conjugate_p_only`` after this refactor (AP53: dead-caller residue
    on the latent side has been removed).
    """
    p_rng = make_rng(draw_family_key, 'primitive_p_draws')
    prior_alpha_safe = max(prior_alpha, 1e-12)
    prior_beta_safe = max(prior_beta, 1e-12)
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

    cohort_aggregate = (
        plan.cohort_n_weighted_total,
        plan.cohort_k_weighted_total,
    )

    if plan.timing_family == TimingFamily.NON_LATENT:
        # F ≡ 1 degeneration: cohort-level Beta-Binomial conjugate on
        # cohort-distinct totals (Σ n_weighted_d, Σ kₘ_weighted).
        n_w = plan.cohort_n_weighted_total
        k_w = plan.cohort_k_weighted_total
        cond_alpha = max(prior_alpha + k_w, 1e-12)
        cond_beta = max(prior_beta + (n_w - k_w), 1e-12)
        cond_p = p_rng.beta(cond_alpha, cond_beta, size=draw_count)
        prior_p = p_rng.beta(prior_alpha_safe, prior_beta_safe, size=draw_count)
        # When the plan is unevaluable (empty evidence, no timing grid,
        # no latent rows) the conjugate update is a numerical no-op and
        # the posterior equals the prior. Label this for downstream
        # consumers without forking the maths (I-47 / AP58).
        degenerate = not plan.evaluable
        status = 'prior_only' if degenerate else 'conditioned'
        reason = plan.unevaluable_reason if degenerate else None
        mode = (
            f'prior_only_{reason}' if degenerate else 'conjugate_non_latent'
        )
        return _ConditioningOutcome(
            status=status,
            reason=reason,
            cond_p_draws=cond_p,
            cond_cdf_draws=None,
            prior_p_draws=prior_p,
            prior_cdf_draws=None,
            cohort_aggregate=cohort_aggregate,
            provenance={
                'mode': mode,
                'cohorts_used': len(plan.cohort_latest),
                'tempering_lambda': 1.0,
                'ess': float(draw_count),
            },
        )

    # ── Latent path: multinomial IS over τ-cells per cohort ──
    T = int(plan.timing_max_tau) + 1
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

    # Per-cohort multinomial likelihood over τ-cells (proposal §3):
    # For one cohort with size n_d and retrievals (τ₁ < … < τₘ) with
    # cumulative counts (k₁, …, kₘ),
    #   log_lik_d = Σᵢ (kᵢ − kᵢ₋₁) · log(p · (F(τᵢ) − F(τᵢ₋₁)))
    #             + (n_d − kₘ) · log(1 − p · F(τₘ))
    # with k₀ ≡ 0, F(τ₀) ≡ 0. Sum is over **all** retrievals; residual
    # at τₘ (the trajectory's actual final retrieval).
    #
    # ``bucket.increments`` carries one entry per retrieval after Pass-2
    # dedup (zero-count plateau cells included). The loop walks through
    # every retrieval so ``prev_F`` advances correctly through plateaus
    # — that is the §3-required ΔF lower bound. Zero-increment cells
    # are skipped via the ``inc_k > 0`` guard since their contribution
    # is 0·log(p·ΔF) = 0; ``prev_F`` still advances to ``cur_F`` so the
    # next positive cell uses the correct neighbour-cell boundary.
    #
    # The residual cell uses ``bucket.last_observed_tau_idx`` —
    # equivalently ``bucket.increments[-1][0]`` once zero cells are
    # preserved. Named explicitly here to make the §3 mapping obvious.
    log_lik = np.zeros(draw_count, dtype=np.float64)
    for bucket in plan.cohort_buckets:
        prev_F = np.zeros(draw_count, dtype=np.float64)
        for tau_idx, inc_k in bucket.increments:
            cur_F = proposal_cdf_draws[:, tau_idx]
            if inc_k > 0.0:
                cell_prob = np.clip(
                    proposal_p_draws * (cur_F - prev_F),
                    1e-15, 1.0 - 1e-15,
                )
                log_lik += inc_k * np.log(cell_prob)
            prev_F = cur_F
        p_arrived_total = np.clip(
            proposal_p_draws * proposal_cdf_draws[:, bucket.last_observed_tau_idx],
            1e-15, 1.0 - 1e-15,
        )
        residual = bucket.n_weighted - bucket.last_k_weighted
        if residual > 0.0:
            log_lik += residual * np.log1p(-p_arrived_total)

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
        return _ConditioningOutcome(
            status='conditioned',
            cond_p_draws=cond_p_draws,
            cond_cdf_draws=cond_cdf_draws,
            prior_p_draws=prior_p_draws,
            prior_cdf_draws=proposal_cdf_draws,
            cohort_aggregate=cohort_aggregate,
            provenance={
                'mode': 'maturity_aware_is_joint',
                'cohorts_used': len(plan.cohort_buckets),
                'tempering_lambda': float(best_lam),
                'ess': float(best_ess),
            },
        )

    # IS could not find an ESS-feasible λ. The only safe answer is
    # prior-only — kₘ alone does not marginalise the latent likelihood
    # to a Bin(kₘ | n_d, p) form unless τₘ is mature, and we cannot
    # determine maturity here without re-introducing F=1 substitution.
    return _ConditioningOutcome(
        status='prior_only',
        reason='is_failed',
        provenance={
            'mode': 'prior_only_is_failed',
            'cohorts_used': len(plan.cohort_buckets),
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
    prior_only_reason: Optional[str] = None,
    plan_provenance: Tuple[str, ...] = (),
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
        skipped_evidence_summary=(
            {
                **(
                    {'prior_only_reason': prior_only_reason}
                    if prior_only_reason else {}
                ),
                **(
                    {'plan_provenance': list(plan_provenance)}
                    if plan_provenance else {}
                ),
            }
        ),
        notes=(
            'status=prior_only',
            *(
                (f'prior_only_reason={prior_only_reason}',)
                if prior_only_reason
                else ()
            ),
            *(f'plan_provenance: {entry}' for entry in plan_provenance),
        ),
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

    raw_alpha = float(resolved_model.alpha or 0.0)
    raw_beta = float(resolved_model.beta or 0.0)
    prior_alpha = max(raw_alpha, 1e-12)
    prior_beta = max(raw_beta, 1e-12)
    pred_alpha = float(resolved_model.alpha_pred or 0.0)
    pred_beta = float(resolved_model.beta_pred or 0.0)

    # Phase 6b defence-in-depth (asat-bayes-vars-fix plan): if the
    # resolver returned an effectively-zero (α, β), the 1e-12 floor
    # above silently produces a degenerate Beta(1e-12, 1e-12). Drawing
    # from that returns bimodal {≈0, ≈1} particles — the median is 0.5
    # regardless of the underlying truth. Pre-Phase-3, this happened
    # whenever asat tier-1 wholesale-replaced file rows with one or
    # two snapshot rows: `momentMatchAnalyticBeta` returned `{}`, the
    # graph edge had no Beta block, the resolver returned (0, 0), and
    # the chart's model curve tracked subject_cdf instead of p × CDF.
    # The 1e-6 sum threshold has 5 orders of magnitude margin against
    # any legitimate prior (uninformative Beta(1,1) sums to 2). The
    # warning is observational — the math (the floor) is preserved.
    degenerate_prior_note: Optional[str] = None
    if raw_alpha + raw_beta < 1e-6:
        degenerate_prior_note = (
            f'WARNING degenerate_prior_beta '
            f'source={resolved_model.source or "?"} '
            f'alpha={raw_alpha:.3e} beta={raw_beta:.3e} '
            f'(floored to Beta(1e-12, 1e-12); draws are bimodal — '
            f'check asat tier-1 file-row truncation and analytic Beta '
            f'projection upstream)'
        )

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
            notes=tuple(
                n for n in (
                    f'status=unconditioned_overlay '
                    f'dispersion_basis={dispersion_basis} '
                    f'timing_family=non_latent',
                    degenerate_prior_note,
                ) if n is not None
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
        notes=tuple(
            n for n in (
                f'status=unconditioned_overlay '
                f'dispersion_basis={dispersion_basis} '
                f'timing_family=latent',
                degenerate_prior_note,
            ) if n is not None
        ),
    )


__all__ = [
    'ConditioningPolicyOptions',
    'condition_primitive',
    'make_unconditioned_primitive',
]
