"""Shared CF projection bundle and its pure projection-boundary helpers.

This module is the non-legacy home for the small, shared accessors that
both the tau reducer (``cohort_maturity``) and the date reducer
(``daily_conversions``, 73q Phase 3) read off a single projection bundle,
plus the bundle object itself (73q Phase 2).

It owns no runtime semantics: every value the helpers here produce is a
straight readout of an already-resolved runtime / projection object or a
pure function of explicit inputs. Per ``CF_ENGINE_DISCIPLINE.md`` there
are no fallbacks, clips, or case-forks — missing inputs raise or
propagate, they are not repaired.

Phase 2 populates this module incrementally:

  - the completeness → layer rule and its thresholds (lifted out of the
    legacy ``forecast_application.annotate_data_point`` surface, which
    73q Phase 7 deletes);
  - the latency-band tau accessor (lifted out of the inline
    daily-conversions derivation in ``api_handlers.py``);
  - the ``CFProjectionBundle`` dataclass and builder.
"""

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence, Tuple

from .lag_distribution_utils import log_normal_inverse_cdf

# ── Layer classification (73q §"Layer") ────────────────────────────────
# The maturity threshold and completeness floor are the existing values
# from ``forecast_application.annotate_data_point``. They live here, in
# the non-legacy projection boundary, so the date reducer and the tau
# reducer share one definition once the legacy surface is retired.

#: Completeness at or above this fraction classifies a Cohort as mature.
MATURITY_THRESHOLD = 0.95

#: Floor below which completeness carries no model information; a Cohort
#: at or below it is pure observed evidence.
COMPLETENESS_EPSILON = 1e-9


def completeness_to_layer(
    completeness: float,
    *,
    maturity_threshold: float = MATURITY_THRESHOLD,
) -> str:
    """Classify a completeness value into a daily-conversions ``layer``.

    The rule is the existing rule from
    ``forecast_application.annotate_data_point``:

        c >= maturity_threshold        -> 'mature'
        COMPLETENESS_EPSILON < c < ...  -> 'forecast'
        c <= COMPLETENESS_EPSILON       -> 'evidence'

    ``maturity_threshold`` defaults to :data:`MATURITY_THRESHOLD` (0.95)
    but stays a parameter for the legacy ``annotate_data_point`` caller,
    which exposes it.

    Branchless: the layers are ordered ``evidence < forecast < mature``
    and the thresholds are ordered (``COMPLETENESS_EPSILON`` ≪
    ``maturity_threshold``), so the rank is the count of thresholds
    crossed — no control-flow branch.
    """
    rank = (
        int(completeness > COMPLETENESS_EPSILON)
        + int(completeness >= maturity_threshold)
    )
    return ('evidence', 'forecast', 'mature')[rank]


# ── Latency-band taus (73q §"Latency-band tau accessor") ────────────────
# The inline daily-conversions derivation in api_handlers.py computes the
# band tau set from the resolved latency. This is the verbatim lift, so
# both reducers (tau / date) and any future consumer share one
# definition. No new derivation. The api_handlers inline copy is the 73q
# Phase 4 deletion target; until then it is the only remaining duplicate.

#: Latency quantiles at which a band is anchored.
LATENCY_BAND_QUANTILES = (0.25, 0.50, 0.75)


def latency_band_taus(
    mu: float,
    sigma: float,
    onset_delta_days: float,
):
    """Resolved latency → ordered, deduplicated ``(tau, label)`` bands.

    For each quantile in :data:`LATENCY_BAND_QUANTILES` the band tau is
    the inverse-CDF percentile of the resolved latency plus
    ``onset_delta_days``, discretised with ``max(1, round(raw))`` and
    deduplicated by tau (first occurrence wins). The label is the
    dynamic ``'{tau}d'`` form the legacy public shape uses.

    The tau is returned unclamped: deciding that a band beyond the
    bundle's projection horizon (``bundle.max_tau``) is unavailable
    belongs to the consuming reducer (per the field contract), not here.

    Branchless dedup: ``dict.fromkeys`` keeps first occurrence and
    preserves insertion order, so the deduplicated tau set comes out in
    quantile order without an ``in``-test branch. ``max(1, round(...))``
    is the existing discretisation floor named by the plan, not a
    residual clamp.
    """
    taus = dict.fromkeys(
        max(1, round(log_normal_inverse_cdf(q, mu, sigma) + onset_delta_days))
        for q in LATENCY_BAND_QUANTILES
    )
    return [(t, f'{t}d') for t in taus]


# ── Shared CF projection bundle (73q Phase 2) ───────────────────────────


@dataclass(frozen=True)
class CFProjectionBundle:
    """The single shared object both reducers consume.

    Built once per request by ``cohort_forecast_v3.build_cf_projection_bundle``.
    The tau reducer (``cohort_maturity``) and the date reducer
    (``daily_conversions``, 73q Phase 3) read from this — neither rebuilds
    runtime state nor scrapes runtime diagnostics for scalar metadata.

    The ``selected_projection`` is built at the bundle's projection
    horizon ``min(compute_extent, saturation_τ)`` per the policy in
    ``docs/current/cohort-maturity-render-calc-policy.md``: the engine
    composes the request CDF to ``compute_extent`` (handler-picked),
    derives ``saturation_τ`` as a latent t95 of the composed predictive
    CDF, and projects per-Cohort to the smaller of the two. Both reducers
    read at ``bundle.max_tau`` (= projection horizon). The aggregate
    ``ef_*`` on the projection is the cohort-axis sum of its per-Cohort
    arrays.

    Types are loose (``Any``) to keep this module free of import cycles
    with ``cohort_forecast_v3`` / ``model_span_spine``.
    """

    frame_evidence: Any                  # FrameEvidence (tau_solid_max, tau_future_max)
    runtime: Any                         # ResolvedCFRuntime
    selected_projection: Any             # SelectedCohortRowProjection @ projection_horizon
    selected_retrieval_frontier: Any     # SelectedRetrievalFrontier
    n_by_anchor: Mapping[str, float]
    # Per-anchor base-mass source / skip reason. Skipped active Cohorts
    # (no admissible root-window carrier evidence) stay present here with
    # reason 'no_root_window_evidence' — the date reducer emits their row
    # from snapshot output without guessing from all-zero arrays.
    a_pop_provenance: Mapping[str, str]
    cohort_eval_ages: Sequence[int]
    cohort_weights: Sequence[float]
    # Ordered per-Cohort projection status, ALIGNED 1:1 with
    # frame_evidence.cohort_list (and with cohort_eval_ages /
    # completeness_by_cohort). Each entry is
    # ``{'anchor_day', 'projection_index', 'reason'}``. The
    # selected_projection's per-Cohort arrays are indexed by the ADMITTED
    # order (Cohorts with N_pop <= 0 are excluded from projection), which
    # is shorter than cohort_list. ``projection_index`` is the row into
    # ``selected_projection.ef_*_by_cohort`` for an admitted Cohort, or
    # ``None`` for a skipped Cohort (with ``reason`` naming why). This is
    # the safe bridge the date reducer (73q Phase 3) uses to map each
    # rate_by_cohort row to a projection row or to a null projection.
    cohort_projection_status: Sequence[Mapping[str, Any]]
    # Per-Cohort completeness at each Cohort's eval_age (un-reduced view of
    # the scalar _runtime_completeness), aligned to cohort order. None when
    # the runtime has no composed CDF.
    completeness_by_cohort: Optional[Any]
    # Shared latency-band tau set (ordered, deduplicated (tau, label)).
    latency_band_taus: Sequence[Tuple[int, str]]
    row_tau_solid_max: int
    row_tau_future_max: int
    # Explicit scalar metadata sourced from the resolved model object —
    # reducers read these directly, never runtime_provenance internals.
    cf_mode: str
    cf_reason: Optional[str]
    promoted_source: Optional[str]
    # ``saturation_tau`` is the latent t95 of the composed predictive
    # request CDF (engine output), bounded by ``compute_extent``.
    # ``max_tau`` is the projection horizon = ``min(compute_extent,
    # saturation_tau)`` — past this point the math is flat by construction
    # and neither reducer emits rows. Handlers pad to a wider chart axis
    # per the policy (Manual zoom-out / multi-scenario).
    saturation_tau: int
    max_tau: int
