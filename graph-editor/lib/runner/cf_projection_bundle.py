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

Contents:

  - the completeness → layer rule and its thresholds (canonical home,
    73q Phase 2);
  - the latency-band tau accessor (lifted out of the inline
    daily-conversions derivation in ``api_handlers.py``);
  - the ``CFProjectionBundle`` dataclass and builder.
"""

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence, Tuple

from .lag_distribution_utils import log_normal_inverse_cdf

# ── Layer classification (73q §"Layer") ────────────────────────────────
# Canonical home for the maturity threshold and completeness floor.
# The date reducer and the tau reducer share these definitions.

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

        c >= maturity_threshold        -> 'mature'
        COMPLETENESS_EPSILON < c < ...  -> 'forecast'
        c <= COMPLETENESS_EPSILON       -> 'evidence'

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
# Both reducers (tau / date) and any future consumer share one latency-band
# tau definition. The accessor is algebraic over the resolved latency:
# instant timing degenerates to tau 0 rather than being forced to a
# positive-day display bucket.

#: Latency quantiles at which a band is anchored.
LATENCY_BAND_QUANTILES = (0.25, 0.50, 0.75)


def latency_band_taus(
    mu: float,
    sigma: float,
    onset_delta_days: float,
    *,
    latency_parameter: bool = True,
):
    """Resolved latency → ordered, deduplicated ``(tau, label)`` bands.

    For each quantile in :data:`LATENCY_BAND_QUANTILES` the band tau is
    the inverse-CDF percentile of the resolved latency plus
    ``onset_delta_days``, discretised with ``round(raw)`` and deduplicated
    by tau (first occurrence wins). Structurally non-latency timing
    (``latency_parameter=False``) is Dirac-at-zero, so the band tau is
    zero regardless of compatibility ``mu`` / ``sigma`` / ``onset``
    provenance.
    The label is the dynamic ``'{tau}d'`` form the legacy public shape
    uses.

    The tau is returned unclamped: deciding that a band beyond the
    bundle's projection horizon (``bundle.max_tau``) is unavailable
    belongs to the consuming reducer (per the field contract), not here.

    ``dict.fromkeys`` keeps first occurrence and preserves insertion
    order, so the deduplicated tau set comes out in quantile order
    without an ``in``-test branch. Instant latency degenerates to ``0d``;
    the accessor must not manufacture a positive-day coordinate when the
    projection surface has correctly collapsed to tau 0.
    """
    taus = dict.fromkeys(
        round(
            0.0 if not latency_parameter
            else log_normal_inverse_cdf(q, mu, sigma) + onset_delta_days
        )
        for q in LATENCY_BAND_QUANTILES
    )
    return [(t, f'{t}d') for t in taus]


# ── Date-axis projection view (73q Phase 4R Atom 4R.1) ──────────────────


@dataclass(frozen=True)
class DateAxisProjection:
    """Cohort-list-aligned FC projection arrays for the date reducer.

    Axis 0 of every array is 1:1 with ``frame_evidence.cohort_list`` (the
    query-scoped Cohort date set), so the date reducer indexes by Cohort
    position alone. Skipped Cohorts (no admissible root-window carrier
    evidence, ``N_pop <= 0``) are all-NaN slices: the reducer reads them as
    ``None`` through the NaN-aware draw-slice helpers, never through an
    admission branch. This is the date reducer's public projection surface
    and replaces the ``cohort_projection_status`` / ``projection_index``
    bridge, which survives only as diagnostic provenance.

    The arrays are the per-Cohort strict empirical and FC continuation
    surfaces scattered from ``selected_projection.*_by_cohort`` (admitted
    order) into cohort_list order. ``reason`` carries the per-Cohort
    base-mass provenance (``root_window_carrier_n`` /
    ``empty_frames_prior`` / ``no_root_window_evidence``) as aligned
    metadata. Types are loose (``Any``) to keep this module free of a
    numpy import.
    """

    anchor_days: Sequence[str]
    f_x_draws: Any           # (C, S, T) — conditioned model surface
    f_y_draws: Any           # (C, S, T)
    f_rate_draws: Any        # (C, S, T)
    ef_x_draws: Any          # (C, S, T) — cohort_list order, NaN for skipped
    ef_y_draws: Any          # (C, S, T)
    ef_rate_draws: Any       # (C, S, T)
    ef_forecast_x: Any       # (C, S, T)
    ef_forecast_y: Any       # (C, S, T)
    evidence_x_strict: Any   # (C, T) — re-clocked strict empirical X
    evidence_y_strict: Any   # (C, T) — re-clocked strict empirical Y
    reason: Sequence[Optional[str]]


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
    # Cohort-list-aligned FC projection view consumed by the date reducer
    # (73q Phase 4R Atom 4R.1). One row per ``frame_evidence.cohort_list``
    # entry; skipped Cohorts are all-NaN slices. This is the date reducer's
    # public bridge; ``cohort_projection_status`` below is demoted to
    # diagnostic provenance.
    date_axis_projection: 'DateAxisProjection'
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
    # Shared FC contour tau set (ordered, deduplicated (tau, label)).
    latency_band_taus: Sequence[Tuple[int, str]]
    # Strict-evidence contour tau set for E-mode daily-conversions display.
    evidence_latency_band_taus: Sequence[Tuple[int, str]]
    # Conditioned-model contour tau set for F-mode daily-conversions display.
    model_latency_band_taus: Sequence[Tuple[int, str]]
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
