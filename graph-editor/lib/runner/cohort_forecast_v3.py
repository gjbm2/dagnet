"""
cohort_forecast_v3 — thin consumer of the generalised forecast engine.

Doc 29 Phase 5: calls compute_forecast_trajectory for the per-cohort
population model (IS-conditioned, evidence-spliced), then takes
quantiles for chart rows. No reimplementation of CDF, carrier,
model resolution, IS conditioning, or population model.

The sweep function in forecast_state.py reproduces v2's per-cohort
loop (lines 796-912 in cohort_forecast_v2.py). v3 builds
CohortEvidence from frames and assembles rows from the sweep result.
"""

import math
import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date as _date, timedelta as _timedelta
from typing import Any, Dict, List, Optional


# ═══════════════════════════════════════════════════════════════════════
# Class B — non-latency edge (Beta-Binomial closed form)
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class NonLatencyResult:
    """Return carrier for `_non_latency_rows` with doc 52 provenance.

    `rows` has the same shape as before. The blend fields carry
    engine-level subset-conditioning provenance (doc 52 §14.6) — a
    parallel to `ForecastTrajectory`'s fields. `conditioned` reports
    whether observed evidence was actually applied to the prior (True)
    or the result is just the prior unchanged because no evidence was
    present in scope (False).
    """
    rows: List[Dict[str, Any]] = field(default_factory=list)
    r: Optional[float] = None
    m_S: Optional[float] = None
    m_G: Optional[float] = None
    blend_applied: bool = False
    blend_skip_reason: Optional[str] = None
    conditioned: bool = False


def _beta_sd(alpha: float, beta: float) -> float:
    s = alpha + beta
    return math.sqrt(alpha * beta / (s * s * (s + 1.0)))


def _attach_cf_row_metadata(
    rows: List[Dict[str, Any]],
    *,
    conditioning: Dict[str, Any],
    conditioned: bool,
    cf_mode: str,
    cf_reason: Optional[str],
) -> List[Dict[str, Any]]:
    """Stash per-call CF metadata on the first row sentinel."""
    if rows:
        rows[0]['_conditioning'] = conditioning
        rows[0]['_conditioned'] = conditioned
        rows[0]['_cf_mode'] = cf_mode
        rows[0]['_cf_reason'] = cf_reason
    return rows


def _non_latency_rows(
    fe: Optional['FrameEvidence'],
    resolved: Any,
    sweep_to: str,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
) -> NonLatencyResult:
    """Row builder for non-latency edges — doc 50 Class B, doc 52 blend.

    Routed by the authoritative `latency_parameter` flag on the edge
    (not by σ ≤ 0, which was an anti-pattern — see doc 49).

    Branches on the resolver's semantic property
    `alpha_beta_query_scoped`, not on source name, to decide whether
    the resolver's α, β already incorporates query-window evidence:

    - **Already query-scoped** (analytic / analytic_be Jeffreys
      posteriors via D20 fallback): read α, β directly. Updating again
      would double-count. Blend is skipped with reason
      ``source_query_scoped``.
    - **Aggregate prior** (bayesian fit / manual override): conjugate
      Beta-Binomial update α' = α + Σk, β' = β + Σ(n − k); doc 52
      engine-level blend then mixes the updated (α', β') with the
      unupdated aggregate (α, β) at ratio (1 − r) : r, where
      r = m_S / m_G.

    Class C (no evidence in the window) falls out naturally: Σn = 0 →
    aggregate-prior update by zero = prior; query-scoped path returns
    the already-scoped prior unchanged; blend trivially returns the
    aggregate in either case.

    Returns a NonLatencyResult with ``rows=[]`` only for Class D (no
    usable α, β at all — the resolver failed to populate a prior and
    there's no evidence either).
    """
    from scipy.stats import beta as _beta_dist
    # Import the shared blend helper from the engine module.
    from runner.forecast_state import _compute_blend_params

    # ── Aggregate query-scoped evidence across cohorts ──────────────
    if fe is not None:
        sum_y = float(sum(c.get('y_frozen', 0.0) for c in fe.cohort_list))
        sum_x = float(sum(c.get('x_frozen', 0.0) for c in fe.cohort_list))
        sum_n_cohorts = len(fe.cohort_list)
        max_tau = fe.max_tau
        tau_solid_max = fe.tau_solid_max
        tau_future_max = fe.tau_future_max
    else:
        sum_y = 0.0
        sum_x = 0.0
        sum_n_cohorts = 0
        max_tau = axis_tau_max if axis_tau_max else 30
        tau_solid_max = 0
        tau_future_max = 0

    # ── Sub-path selection by prior-vs-posterior semantics ─────────
    # Branch on the resolver's semantic property, NOT on source name.
    # The question is whether the resolver's α/β already includes the
    # query window's evidence (→ read directly) or is an aggregate
    # prior (→ conjugate update with query Σk, Σn). See
    # STATS_SUBSYSTEMS.md §5 Confusion 8 and ResolvedModelParams.alpha_beta_query_scoped.
    alpha_prior = max(float(getattr(resolved, 'alpha', 0.0) or 0.0), 0.0)
    beta_prior = max(float(getattr(resolved, 'beta', 0.0) or 0.0), 0.0)
    already_query_scoped = bool(getattr(resolved, 'alpha_beta_query_scoped', False))

    # Doc 52 §14.5: determine blend applicability. `m_S = sum_x` mirrors
    # the IS-path convention (sum of per-Cohort x_frozen).
    _blend_info = _compute_blend_params(resolved, sum_x)
    if already_query_scoped:
        _blend_info = {
            'r': None,
            'm_S': None,
            'm_G': None,
            'applied': False,
            'skip_reason': 'source_query_scoped',
        }

    if already_query_scoped:
        # Resolver's α, β already incorporates query-window evidence
        # (analytic / analytic_be Jeffreys posterior). Read directly —
        # updating again double-counts.
        alpha_post = alpha_prior
        beta_post = beta_prior
    else:
        # Resolver's α, β is an aggregate prior (bayesian / manual).
        # Conjugate update with query-scoped Σk, Σn.
        alpha_post_conditioned = alpha_prior + sum_y
        beta_post_conditioned = beta_prior + (sum_x - sum_y)

        if _blend_info['applied']:
            # Doc 52 §14.4.3: closed-form Beta blend at moment level.
            r_val = float(_blend_info['r'])
            s_cond = alpha_post_conditioned + beta_post_conditioned
            s_prior = alpha_prior + beta_prior
            if s_cond > 0 and s_prior > 0:
                mu_cond = alpha_post_conditioned / s_cond
                mu_prior = alpha_prior / s_prior
                var_cond = (alpha_post_conditioned * beta_post_conditioned
                            / (s_cond * s_cond * (s_cond + 1)))
                var_prior = (alpha_prior * beta_prior
                             / (s_prior * s_prior * (s_prior + 1)))
                mu_b = (1.0 - r_val) * mu_cond + r_val * mu_prior
                var_b = ((1.0 - r_val) * var_cond + r_val * var_prior
                         + (1.0 - r_val) * r_val * (mu_cond - mu_prior) ** 2)
                # Moment-match back to a display Beta.
                if 0.0 < mu_b < 1.0 and var_b > 0:
                    common = mu_b * (1.0 - mu_b) / var_b - 1.0
                    if common > 0:
                        alpha_post = mu_b * common
                        beta_post = (1.0 - mu_b) * common
                    else:
                        # Variance too large to form a proper Beta — fall
                        # back to the conditioned update.
                        alpha_post = alpha_post_conditioned
                        beta_post = beta_post_conditioned
                else:
                    alpha_post = alpha_post_conditioned
                    beta_post = beta_post_conditioned
            else:
                alpha_post = alpha_post_conditioned
                beta_post = beta_post_conditioned
        else:
            alpha_post = alpha_post_conditioned
            beta_post = beta_post_conditioned

    # Class D guard: no usable prior and no evidence.
    if alpha_post <= 0 or beta_post <= 0:
        return NonLatencyResult(
            rows=[],
            r=_blend_info.get('r'),
            m_S=_blend_info.get('m_S'),
            m_G=_blend_info.get('m_G'),
            blend_applied=bool(_blend_info.get('applied')),
            blend_skip_reason=_blend_info.get('skip_reason'),
            conditioned=False,
        )

    # Whether the returned posterior incorporates observed evidence.
    # False when `fe` is empty or all cohorts have zero totals — the
    # result then equals the prior (either α/β directly, or after a
    # trivial no-op conjugate update α+0, β+0). Consumers that need
    # to distinguish real conditioned output from untouched-prior
    # output read this field from the edge response.
    conditioned = (fe is not None and sum_x > 0)

    # ── Posterior scalars (Beta closed form) ────────────────────────
    s = alpha_post + beta_post
    p_mean = alpha_post / s
    # Epistemic σ — Beta posterior after conjugate update with query
    # evidence. Tight when evidence is abundant.
    p_sd_epistemic = math.sqrt(alpha_post * beta_post / (s * s * (s + 1)))
    # Predictive σ — resolved.alpha_pred/beta_pred from doc 49 carry
    # kappa-inflated between-cohort dispersion. We do NOT conjugate-
    # update these with query Σk, Σn (that would collapse the kappa
    # spread to the epistemic width). Fall back to epistemic when the
    # resolver did not supply predictive params (e.g. kappa absent).
    if already_query_scoped:
        p_sd = p_sd_epistemic
    else:
        _alpha_p = getattr(resolved, 'alpha_pred', 0.0) or 0.0
        _beta_p = getattr(resolved, 'beta_pred', 0.0) or 0.0
        if _alpha_p > 0 and _beta_p > 0 and (_alpha_p, _beta_p) != (alpha_prior, beta_prior):
            _sp = _alpha_p + _beta_p
            p_sd = math.sqrt(_alpha_p * _beta_p / (_sp * _sp * (_sp + 1)))
        else:
            p_sd = p_sd_epistemic

    # ── Quantile bands from Beta closed form ────────────────────────
    # Match the v3 chart's default band set: [band_level, 0.5].
    band_levels = [band_level, 0.5]
    fan_lower_val = float(_beta_dist.ppf((1 - band_level) / 2, alpha_post, beta_post))
    fan_upper_val = float(_beta_dist.ppf((1 + band_level) / 2, alpha_post, beta_post))
    fan_bands: Optional[Dict] = {
        str(int(bl * 100)): [
            float(_beta_dist.ppf((1 - bl) / 2, alpha_post, beta_post)),
            float(_beta_dist.ppf((1 + bl) / 2, alpha_post, beta_post)),
        ] for bl in band_levels
    }

    # ── Prior (unconditioned) bands for model_* fields ──────────────
    # When the resolver's α, β was updated (aggregate-prior case), the
    # model_* bands show the pre-update prior distribution. When the
    # resolver's α, β was already query-scoped (no update performed),
    # model_* coincides with the posterior.
    if (not already_query_scoped) and alpha_prior > 0 and beta_prior > 0:
        _sp = alpha_prior + beta_prior
        model_midpoint = alpha_prior / _sp
        model_fan_lower = float(_beta_dist.ppf((1 - band_level) / 2, alpha_prior, beta_prior))
        model_fan_upper = float(_beta_dist.ppf((1 + band_level) / 2, alpha_prior, beta_prior))
        model_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(_beta_dist.ppf((1 - bl) / 2, alpha_prior, beta_prior)),
                float(_beta_dist.ppf((1 + bl) / 2, alpha_prior, beta_prior)),
            ] for bl in band_levels
        }
    else:
        model_midpoint = p_mean
        model_fan_lower = fan_lower_val
        model_fan_upper = fan_upper_val
        model_bands = fan_bands

    # Completeness for this fallback row set:
    #  - Non-latency edge (latency_parameter=false): everything materialises instantly
    #    once arriver count is known → completeness = 1.0.
    #  - Lagful edge (σ > 0) routed here because fe is None (cohort frames
    #    didn't compose for the per-scenario effective DSL): nothing has
    #    matured for this scope yet → completeness = 0.0. Drives the
    #    band-mixture variance to the predictive σ regime, which is the
    #    correct treatment for "no observed maturity yet".
    _lat_sigma = getattr(getattr(resolved, 'latency', None), 'sigma', 0.0) or 0.0
    _is_lagful_fallback = (fe is None and _lat_sigma > 0)
    _completeness_for_rows = 0.0 if _is_lagful_fallback else 1.0

    # ── Build rows (same schema as Class A, flat in τ) ──────────────
    rows: List[Dict[str, Any]] = []
    for tau in range(max_tau + 1):
        rows.append({
            'tau_days': tau,
            'rate': p_mean,
            'rate_pure': p_mean,
            'evidence_y': sum_y if fe is not None else None,
            'evidence_x': sum_x if fe is not None else None,
            'projected_rate': p_mean,
            'forecast_y': None,
            'forecast_x': None,
            'midpoint': p_mean,
            'fan_upper': fan_upper_val,
            'fan_lower': fan_lower_val,
            'fan_bands': fan_bands,
            'model_midpoint': model_midpoint,
            'model_fan_upper': model_fan_upper,
            'model_fan_lower': model_fan_lower,
            'model_bands': model_bands,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': sum_n_cohorts,
            'cohorts_covered_projected': sum_n_cohorts,
            'completeness': _completeness_for_rows,
            'completeness_sd': 0.0,
            'p_infinity_mean': p_mean,
            'p_infinity_sd': p_sd,
            'p_infinity_sd_epistemic': p_sd_epistemic,
        })

    return NonLatencyResult(
        rows=rows,
        r=_blend_info.get('r'),
        m_S=_blend_info.get('m_S'),
        m_G=_blend_info.get('m_G'),
        blend_applied=bool(_blend_info.get('applied')),
        blend_skip_reason=_blend_info.get('skip_reason'),
        conditioned=conditioned,
    )


# ═══════════════════════════════════════════════════════════════════════
# Shared evidence builder — used by both v3 chart and conditioned forecast
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class FrameEvidence:
    """Intermediate evidence extracted from derived maturity frames.

    Produced by build_cohort_evidence_from_frames() and consumed by
    both the v3 chart builder (compute_cohort_maturity_rows_v3) and
    the conditioned forecast path.

    Design invariant: both consumers call compute_forecast_trajectory with
    the SAME engine_cohorts built from the SAME snapshot DB evidence,
    so trajectory rows and conditioned scalar extraction stay aligned.
    """
    engine_cohorts: list           # List[CohortEvidence]
    cohort_list: List[Dict]        # sorted cohort_info dicts
    cohort_at_tau: Dict            # per-cohort tau observations
    evidence_by_tau: Dict          # aggregate evidence at each tau
    max_tau: int                   # display range (rows, chart x-axis)
    saturation_tau: int            # sweep horizon (for p.infinity evaluation)
    tau_solid_max: int
    tau_future_max: int
    last_frame_date: Optional[_date] = None
    x_provider: Optional[Any] = None
    from_node_arrival: Optional[Any] = None
    upstream_path_cdf_arr: Optional[List[float]] = None
    carrier_tier: str = 'none'


def _resolve_frame_carrier_state(
    *,
    graph: Optional[Dict[str, Any]],
    target_edge: Dict[str, Any],
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
    is_window: bool,
    x_provider_override,
    cohort_list: List[Dict[str, Any]],
    saturation_tau: int,
    det_norm_cdf=None,
):
    from .forecast_state import NodeArrivalState
    from .forecast_runtime import (
        build_upstream_carrier,
        build_x_provider_from_graph,
    )

    x_provider_local = x_provider_override
    from_node_arrival_local = None
    upstream_path_cdf_arr_local = None
    carrier_tier = 'none'

    if (
        x_provider_local is None
        and graph is not None
        and not is_window
        and anchor_node_id
        and query_from_node
        and query_from_node != anchor_node_id
    ):
        try:
            x_provider_local = build_x_provider_from_graph(
                graph,
                target_edge,
                anchor_node_id,
                is_window,
            )
        except Exception as e:
            print(f"[v3] WARNING: x_provider build failed: {e}")

    if (
        x_provider_local is not None
        and bool(getattr(x_provider_local, 'enabled', False))
        and float(getattr(x_provider_local, 'reach', 0.0) or 0.0) > 0
    ):
        upstream_params_list = (
            x_provider_local.ingress_carrier
            if x_provider_local.ingress_carrier
            else x_provider_local.upstream_params_list
        )
        # [v3-debug] dump the params used to build the parametric carrier
        for _i, _up in enumerate(upstream_params_list or []):
            print(f"[v3-debug] upstream_params[{_i}]: p={_up.get('p')} mu={_up.get('mu')} sigma={_up.get('sigma')} onset={_up.get('onset')} mu_sd={_up.get('mu_sd')} sigma_sd={_up.get('sigma_sd')}")
        _carrier_rng = np.random.default_rng(43)
        _carrier_max_tau = saturation_tau
        if _carrier_max_tau is None and det_norm_cdf is not None:
            try:
                _carrier_max_tau = max(len(det_norm_cdf) - 1, 0)
            except TypeError:
                _carrier_max_tau = None
        if _carrier_max_tau is None:
            _carrier_max_tau = 30
        det_cdf, mc_cdf, carrier_tier = build_upstream_carrier(
            upstream_params_list=upstream_params_list,
            upstream_obs=x_provider_local.upstream_obs,
            cohort_list=cohort_list,
            reach=x_provider_local.reach,
            is_window=is_window,
            max_tau=_carrier_max_tau,
            num_draws=2000,
            rng=_carrier_rng,
        )
        upstream_path_cdf_arr_local = det_cdf
        if det_cdf is not None or mc_cdf is not None:
            from_node_arrival_local = NodeArrivalState(
                deterministic_cdf=det_cdf,
                mc_cdf=mc_cdf,
                reach=x_provider_local.reach,
                tier=carrier_tier,
            )

    return (
        x_provider_local,
        from_node_arrival_local,
        upstream_path_cdf_arr_local,
        carrier_tier,
    )

def _query_scoped_latency_rows(
    fe: Optional['FrameEvidence'],
    resolved: Any,
    sweep_to: str,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
    is_window: bool = False,
    runtime_bundle: Optional[Any] = None,
) -> NonLatencyResult:
    """Deterministic rows for degraded or zero-evidence latency edges.

    The rate-side uncertainty is the closed-form Beta posterior already
    resolved on the edge; the timing side is the deterministic latency
    CDF from the resolved latency block. No sweep, no IS, no MC drift.
    Window-mode rows must still preserve the fixed X-rooted denominator
    even when some cohorts are too young to have an explicit tau snapshot.
    """
    from .forecast_application import compute_completeness
    from .forecast_state import _convolve_completeness_at_age
    from .forecast_runtime import build_closed_form_beta_rate_surface

    alpha_post = max(float(getattr(resolved, 'alpha', 0.0) or 0.0), 0.0)
    beta_post = max(float(getattr(resolved, 'beta', 0.0) or 0.0), 0.0)
    rate_surface = build_closed_form_beta_rate_surface(
        alpha=alpha_post,
        beta=beta_post,
        band_level=band_level,
        band_levels=[0.80, 0.90, 0.95, 0.99],
    )
    if rate_surface is None:
        return NonLatencyResult(
            rows=[],
            r=None,
            m_S=None,
            m_G=None,
            blend_applied=False,
            blend_skip_reason='source_query_scoped',
            conditioned=False,
        )

    if fe is not None:
        sum_y = float(sum(c.get('y_frozen', 0.0) for c in fe.cohort_list))
        sum_x = float(sum(c.get('x_frozen', 0.0) for c in fe.cohort_list))
        max_tau = fe.max_tau
        tau_solid_max = fe.tau_solid_max
        tau_future_max = fe.tau_future_max
        evidence_by_tau = fe.evidence_by_tau
        sum_n_cohorts = len(fe.cohort_list)
    else:
        sum_y = 0.0
        sum_x = 0.0
        max_tau = axis_tau_max if axis_tau_max else 30
        tau_solid_max = 0
        tau_future_max = 0
        evidence_by_tau = {}
        sum_n_cohorts = 0

    conditioned = fe is not None and sum_x > 0
    p_mean = rate_surface.p_mean
    p_sd_epistemic = rate_surface.p_sd_epistemic
    p_sd = rate_surface.p_sd

    lat = resolved.latency
    _subject_det_cdf: Optional[List[float]] = None
    _from_node_arrival = None
    if runtime_bundle is not None:
        _op_inputs = getattr(runtime_bundle, 'operator_inputs', None)
        _det_norm_cdf = (
            getattr(_op_inputs, 'det_norm_cdf', None)
            if _op_inputs is not None
            else None
        )
        if _det_norm_cdf is not None:
            _subject_det_cdf = [
                max(0.0, min(1.0, float(val or 0.0)))
                for val in list(_det_norm_cdf)
            ]
        _carrier = getattr(runtime_bundle, 'carrier_to_x', None)
        if _carrier is not None:
            _from_node_arrival = getattr(_carrier, 'from_node_arrival', None)

    def _subject_completion_at_tau(tau: int) -> float:
        if _subject_det_cdf:
            idx = min(max(int(tau), 0), len(_subject_det_cdf) - 1)
            return _subject_det_cdf[idx]
        return max(
            0.0,
            min(
                1.0,
                compute_completeness(
                    tau,
                    lat.mu,
                    lat.sigma,
                    lat.onset_delta_days,
                ),
            ),
        )

    def _projection_completion_at_tau(tau: int) -> float:
        if _from_node_arrival is not None:
            _upstream_cdf = getattr(_from_node_arrival, 'deterministic_cdf', None)
            _reach = float(getattr(_from_node_arrival, 'reach', 0.0) or 0.0)
            if _upstream_cdf is not None and _reach > 0:
                if _subject_det_cdf:
                    max_idx = min(int(tau) + 1, len(_upstream_cdf))
                    conv = 0.0
                    for u in range(max_idx):
                        if u == 0:
                            f_up = float(_upstream_cdf[0] or 0.0)
                        else:
                            f_up = (
                                float(_upstream_cdf[u] or 0.0)
                                - float(_upstream_cdf[u - 1] or 0.0)
                            )
                        if f_up <= 0:
                            continue
                        conv += f_up * _subject_completion_at_tau(tau - u)
                    return max(0.0, min(1.0, conv))
                return max(
                    0.0,
                    min(
                        1.0,
                        _convolve_completeness_at_age(
                            tau,
                            _upstream_cdf,
                            _reach,
                            lat.mu,
                            lat.sigma,
                            lat.onset_delta_days,
                        ),
                    ),
                )
        return _subject_completion_at_tau(tau)

    if fe is not None and sum_x > 0:
        det_complete_num = 0.0
        det_complete_den = 0.0
        for cohort in fe.cohort_list:
            weight = float(cohort.get('x_frozen', 0.0) or 0.0)
            if weight <= 0:
                continue
            frontier_age = float(
                cohort.get('tau_observed', cohort.get('tau_max', 0)) or 0.0
            )
            det_complete_num += weight * _projection_completion_at_tau(
                int(frontier_age)
            )
            det_complete_den += weight
        completeness = (
            max(0.0, min(1.0, det_complete_num / det_complete_den))
            if det_complete_den > 0
            else 0.0
        )
    else:
        completeness = 0.0

    p_band_lookup = rate_surface.band_lookup
    p_fan_lower = rate_surface.fan_lower
    p_fan_upper = rate_surface.fan_upper

    rows: List[Dict[str, Any]] = []
    total_projection_x = round(sum_x, 1) if sum_x > 0 else None

    def _window_evidence_at_tau(
        tau: int,
    ) -> tuple[Optional[float], Optional[float], int]:
        if fe is None or tau > tau_future_max:
            return (None, None, 0)

        has_real_obs = any(
            tau in fe.cohort_at_tau.get(cohort['anchor_day'].isoformat(), {})
            for cohort in fe.cohort_list
            if tau <= int(cohort.get('tau_observed', cohort.get('tau_max', 0)) or 0)
        )
        if not has_real_obs:
            return (None, None, 0)

        ev_x_total = 0.0
        ev_y_total = 0.0
        for _, engine_cohort in zip(fe.cohort_list, fe.engine_cohorts):
            if tau < len(engine_cohort.obs_x):
                ev_x_total += float(engine_cohort.obs_x[tau] or 0.0)
            else:
                ev_x_total += float(engine_cohort.x_frozen or 0.0)
            if tau < len(engine_cohort.obs_y):
                ev_y_total += float(engine_cohort.obs_y[tau] or 0.0)
            else:
                ev_y_total += float(engine_cohort.y_frozen or 0.0)
        return (ev_x_total, ev_y_total, sum_n_cohorts)

    def _collapsed_cohort_evidence_at_tau(
        tau: int,
    ) -> tuple[Optional[float], Optional[float], int]:
        if fe is None or tau > tau_future_max:
            return (None, None, 0)

        has_real_obs = any(
            tau in fe.cohort_at_tau.get(cohort['anchor_day'].isoformat(), {})
            for cohort in fe.cohort_list
            if tau <= int(cohort.get('tau_observed', cohort.get('tau_max', 0)) or 0)
        )
        if not has_real_obs:
            return (None, None, 0)

        ev_x_total = 0.0
        ev_y_total = 0.0
        n_mature = 0
        for cohort, engine_cohort in zip(fe.cohort_list, fe.engine_cohorts):
            frontier_age = int(
                cohort.get('tau_observed', cohort.get('tau_max', 0)) or 0
            )
            tau_max_c = int(cohort.get('tau_max', frontier_age) or 0)
            ad_str = cohort['anchor_day'].isoformat()

            if tau < len(engine_cohort.obs_x):
                if tau <= frontier_age:
                    ev_x_total += float(engine_cohort.obs_x[tau] or 0.0)
                else:
                    ev_x_total += float(engine_cohort.x_frozen or 0.0)
            else:
                ev_x_total += float(engine_cohort.x_frozen or 0.0)

            if tau < len(engine_cohort.obs_y):
                ev_y_total += float(engine_cohort.obs_y[tau] or 0.0)
            else:
                ev_y_total += float(engine_cohort.y_frozen or 0.0)

            if tau <= tau_max_c and tau in fe.cohort_at_tau.get(ad_str, {}):
                n_mature += 1

        return (ev_x_total, ev_y_total, n_mature)

    for tau in range(max_tau + 1):
        det_cdf_tau = _projection_completion_at_tau(tau)
        projected_rate = p_mean * det_cdf_tau
        model_bands = {
            level: [bounds[0] * det_cdf_tau, bounds[1] * det_cdf_tau]
            for level, bounds in p_band_lookup.items()
        }
        midpoint: Optional[float] = projected_rate
        fan_lower_val: Optional[float] = p_fan_lower * det_cdf_tau
        fan_upper_val: Optional[float] = p_fan_upper * det_cdf_tau
        fan_bands: Optional[Dict[str, List[float]]] = model_bands
        if tau < tau_solid_max:
            midpoint = None
            fan_lower_val = None
            fan_upper_val = None
            fan_bands = None

        if is_window:
            ev_x, ev_y, cohorts_covered = _window_evidence_at_tau(tau)
        elif (
            runtime_bundle is not None
            and getattr(runtime_bundle.carrier_to_x, 'mode', '') == 'identity'
        ):
            ev_x, ev_y, cohorts_covered = _collapsed_cohort_evidence_at_tau(tau)
        else:
            ev = evidence_by_tau.get(tau) if tau <= tau_future_max else None
            ev_x = ev.get('sum_x') if ev else None
            ev_y = ev.get('sum_y') if ev else None
            cohorts_covered = int(ev.get('n_cohorts', 0)) if ev else 0
        rate = (
            ev_y / ev_x
            if ev_x is not None and ev_x > 0 and ev_y is not None
            else None
        )

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate,
            'evidence_y': ev_y,
            'evidence_x': ev_x,
            'projected_rate': projected_rate,
            'forecast_y': (
                round(sum_x * projected_rate, 1)
                if midpoint is not None and sum_x > 0
                else None
            ),
            'forecast_x': total_projection_x if midpoint is not None else None,
            'midpoint': midpoint,
            'fan_upper': fan_upper_val,
            'fan_lower': fan_lower_val,
            'fan_bands': fan_bands,
            'model_midpoint': projected_rate,
            'model_fan_upper': p_fan_upper * det_cdf_tau,
            'model_fan_lower': p_fan_lower * det_cdf_tau,
            'model_bands': model_bands,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': cohorts_covered,
            'cohorts_covered_projected': cohorts_covered,
            'completeness': completeness,
            'completeness_sd': 0.0,
            'p_infinity_mean': p_mean,
            'p_infinity_sd': p_sd,
            'p_infinity_sd_epistemic': p_sd_epistemic,
        })

    return NonLatencyResult(
        rows=rows,
        r=None,
        m_S=None,
        m_G=None,
        blend_applied=False,
        blend_skip_reason='source_query_scoped',
        conditioned=conditioned,
    )


def build_cohort_evidence_from_frames(
    frames: List[Dict[str, Any]],
    target_edge: Dict[str, Any],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool,
    resolved: Any,
    axis_tau_max: Optional[int] = None,
    *,
    graph: Optional[Dict[str, Any]] = None,
    anchor_node_id: Optional[str] = None,
    query_from_node: Optional[str] = None,
    x_provider_override: Optional[Any] = None,
    det_norm_cdf: Optional[List[float]] = None,
) -> Optional[FrameEvidence]:
    """Build CohortEvidence from derived maturity frames.

    Shared between the v3 chart builder and the topo pass forecast
    sweep. Encapsulates: last-frame extraction, cohort_info, per-tau
    observation building, tau range computation, carrier-to-X resolution,
    and materialisation of the observed prefix consumed by the shared
    sweep.

    When cohort mode has a real A→X carrier (graph + anchor_node_id +
    query_from_node supplied, anchor != X), the builder re-roots the
    observed prefix onto that carrier: obs_x / x_frozen / evidence_by_tau.sum_x
    come from the carrier-to-X arrival curve, while obs_y / y_frozen /
    evidence_by_tau.sum_y are recovered by convolving those carrier arrivals
    with the observed subject-side y/x progression implied by the raw
    frames. Window mode and carrier-free solves keep the raw frame
    observations unchanged.

    Returns None only when the request dates are malformed. If no
    observations bind to the selected semantic question, the builder still
    returns zero-observation cohorts so the general carrier/subject solve
    owns the no-evidence limit.
    """
    from .forecast_state import CohortEvidence

    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return None

    lat = resolved.latency

    # ── Find last frame ────────────────────────────────────────────
    last_frame = None
    last_frame_date: Optional[_date] = None
    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        if sd_str and sd_str <= str(sweep_to)[:10]:
            last_frame = f
            try:
                last_frame_date = _date.fromisoformat(sd_str)
            except (ValueError, TypeError):
                pass

    # ── Build per-cohort info from last frame ──────────────────────
    cohort_info: Dict[str, Dict[str, Any]] = {}
    if last_frame and last_frame.get('data_points'):
        for dp in last_frame['data_points']:
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            a_val = dp.get('a', 0)
            if not isinstance(x_val, (int, float)):
                x_val = 0
            if not isinstance(a_val, (int, float)) or a_val <= 0:
                a_val = max(x_val, 1)
            tau_max_c = (last_frame_date - ad).days if last_frame_date else 0
            cohort_info[ad_str] = {
                'x_frozen': float(x_val),
                'y_frozen': float(y_val) if isinstance(y_val, (int, float)) else 0.0,
                'a_frozen': float(a_val),
                'tau_max': max(tau_max_c, 0),
                'anchor_day': ad,
            }

    if not cohort_info:
        if anchor_from_d > anchor_to_d:
            return None
        ad = anchor_from_d
        while ad <= anchor_to_d:
            cohort_info[ad.isoformat()] = {
                'x_frozen': 0.0,
                'y_frozen': 0.0,
                'a_frozen': 1.0,
                'tau_max': 0,
                'anchor_day': ad,
            }
            ad += _timedelta(days=1)

    # ── Build per-(cohort, τ) observations from all frames ─────────
    cohort_at_tau: Dict[str, Dict[int, tuple]] = defaultdict(dict)

    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        for dp in (f.get('data_points') or []):
            ad_str = str(dp.get('anchor_day', ''))[:10]
            ci = cohort_info.get(ad_str)
            if ci is None:
                continue
            try:
                sd_d = _date.fromisoformat(sd_str)
                ad_d = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            tau = (sd_d - ad_d).days
            if tau < 0:
                continue
            x_val = dp.get('x')
            y_val = dp.get('y')
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if not isinstance(y_val, (int, float)) or y_val is None:
                continue
            cohort_at_tau[ad_str][tau] = (float(x_val), float(y_val))

    # evidence_by_tau is built after engine_cohorts so sum_x can draw from
    # the carrier-owned obs_x rather than the raw per-frame observations.

    # ── tau_observed per cohort ────────────────────────────────────
    for ad_str, ci in cohort_info.items():
        tau_obs = 0
        if last_frame_date:
            try:
                ad_d = _date.fromisoformat(ad_str)
                tau_obs = (last_frame_date - ad_d).days
            except (ValueError, TypeError):
                pass
        ci['tau_observed'] = min(tau_obs, ci['tau_max'])

    # ── Build cohort_list and epoch boundaries ─────────────────────
    cohort_list = sorted(cohort_info.values(), key=lambda c: c['anchor_day'])
    tau_solid_max = 0
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)
    if cohort_list:
        youngest = cohort_list[-1]
        tau_solid_max = youngest.get('tau_observed', youngest['tau_max'])
        oldest = cohort_list[0]
        tau_future_max = oldest['tau_max']

    # ── Determine tau ranges ───────────────────────────────────────
    # max_tau         : display/row range — drives chart x-axis (unchanged).
    # saturation_tau  : internal sweep horizon — extends to 2*t95 (window)
    #                   or 2*path_t95 (cohort) so median(rate_draws[:, sat])
    #                   is p@∞. May exceed max_tau when path-level latency
    #                   dominates A→Y timing (cohort mode, multi-hop).
    max_tau = tau_future_max
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(
                0.95,
                lat.mu,
                lat.sigma,
            ) + lat.onset_delta_days
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass
    max_tau = min(max_tau, 400)

    saturation_tau = max_tau
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            mu_s, sigma_s, onset_s = lat.mu, lat.sigma, lat.onset_delta_days
            if not is_window:
                # Cohort mode: the relevant lag for evaluating p@∞ is the
                # path-level A→Y CDF, not the edge-local one. Re-resolve
                # with scope='path' because build_cohort_evidence receives
                # `resolved` from an earlier scope='edge' call (so
                # resolved.path_latency is None on this side).
                from .model_resolver import resolve_model_params
                try:
                    path_resolved = resolve_model_params(
                        target_edge,
                        scope='path',
                        temporal_mode='cohort',
                    )
                    pl = (
                        getattr(path_resolved, 'path_latency', None)
                        if path_resolved
                        else None
                    )
                    if pl is not None and pl.sigma > 0:
                        mu_s, sigma_s, onset_s = (
                            pl.mu,
                            pl.sigma,
                            pl.onset_delta_days,
                        )
                except Exception:
                    pass
            t95_sat = log_normal_inverse_cdf(0.95, mu_s, sigma_s) + onset_s
            saturation_tau = max(saturation_tau, int(math.ceil(2.0 * t95_sat)))
        except Exception:
            pass
    saturation_tau = min(saturation_tau, 400)

    # ── Resolve carrier-to-X (cohort mode with a real A→X carrier) ──
    # Resolution happens here so one canonical builder both materialises the
    # observed prefix and attaches the carrier state read later by the
    # shared sweep. Window mode, missing graph, and A==X all produce
    # x_provider=None here.
    (
        x_provider,
        from_node_arrival,
        upstream_path_cdf_arr,
        carrier_tier,
    ) = _resolve_frame_carrier_state(
        graph=graph,
        target_edge=target_edge,
        anchor_node_id=anchor_node_id,
        query_from_node=query_from_node,
        is_window=is_window,
        x_provider_override=x_provider_override,
        cohort_list=cohort_list,
        saturation_tau=saturation_tau,
        det_norm_cdf=det_norm_cdf,
    )

    use_factorised_carrier = (
        not is_window
        and x_provider is not None
        and bool(getattr(x_provider, 'enabled', False))
        and float(getattr(x_provider, 'reach', 0.0) or 0.0) > 0.0
        and upstream_path_cdf_arr is not None
    )
    carrier_reach = (
        float(getattr(x_provider, 'reach', 0.0) or 0.0)
        if x_provider is not None
        else 0.0
    )
    carrier_cdf: Optional[List[float]] = None
    if use_factorised_carrier:
        carrier_cdf = [
            max(0.0, min(1.0, float(v or 0.0)))
            for v in list(upstream_path_cdf_arr or [])
        ]
        if not carrier_cdf:
            use_factorised_carrier = False
            carrier_cdf = None

    def _carrier_cdf_at_tau(tau: int) -> float:
        if not carrier_cdf:
            return 0.0
        idx = min(max(int(tau), 0), len(carrier_cdf) - 1)
        return carrier_cdf[idx]

    # ── Build CohortEvidence per cohort ────────────────────────────
    # Default path keeps the raw frame observations. When a real A→X
    # carrier exists, materialise the observed prefix directly on that
    # carrier and recover the numerator by convolving carrier arrivals
    # against the raw subject-side progression curve.
    engine_cohorts: list = []
    materialised_cohort_list: List[Dict[str, Any]] = []
    for ci in cohort_list:
        raw_n_i = float(ci.get('x_frozen', 0.0) or 0.0)
        a_i = int(ci.get('tau_observed', ci['tau_max']) or 0)
        a_i = min(max(a_i, 0), saturation_tau)
        a_pop = float(ci.get('a_frozen', raw_n_i) or raw_n_i or 1.0)
        ad_str = ci['anchor_day'].isoformat()
        tau_data = cohort_at_tau.get(ad_str, {})

        raw_obs_x = [0.0] * (saturation_tau + 1)
        raw_obs_y = [0.0] * (saturation_tau + 1)
        last_x = raw_n_i if is_window else 0.0
        last_y = 0.0
        for t in range(saturation_tau + 1):
            if t <= a_i:
                obs = tau_data.get(t)
                if obs:
                    last_x = float(obs[0])
                    last_y = float(obs[1])
                elif is_window:
                    last_x = raw_n_i
                raw_obs_x[t] = last_x
                raw_obs_y[t] = last_y
            else:
                raw_obs_x[t] = last_x if last_x > 0 else raw_n_i
                raw_obs_y[t] = last_y

        obs_x = raw_obs_x
        obs_y = raw_obs_y
        x_frozen = float(obs_x[a_i]) if a_i < len(obs_x) else raw_n_i
        y_frozen = float(obs_y[a_i]) if a_i < len(obs_y) else float(ci.get('y_frozen', 0.0) or 0.0)

        if use_factorised_carrier:
            subject_curve: List[float] = []
            last_ratio = 0.0
            for t in range(saturation_tau + 1):
                fx = float(raw_obs_x[t] or 0.0)
                fy = float(raw_obs_y[t] or 0.0)
                if fx > 1e-9:
                    last_ratio = max(0.0, min(1.0, fy / fx))
                subject_curve.append(last_ratio)

            obs_x = [0.0] * (saturation_tau + 1)
            obs_y = [0.0] * (saturation_tau + 1)
            prefix_x: List[float] = []
            last_projected_x = 0.0
            for t in range(a_i + 1):
                projected_x = a_pop * carrier_reach * _carrier_cdf_at_tau(t)
                projected_x = max(0.0, max(projected_x, last_projected_x))
                prefix_x.append(projected_x)
                last_projected_x = projected_x

            if prefix_x:
                arrival_increments = np.diff(
                    np.concatenate(([0.0], np.asarray(prefix_x, dtype=np.float64)))
                )
                arrival_increments = np.maximum(arrival_increments, 0.0)
                for t in range(a_i + 1):
                    obs_x[t] = float(prefix_x[t])
                    y_t = 0.0
                    for u in range(t + 1):
                        y_t += float(arrival_increments[u]) * float(subject_curve[t - u])
                    obs_y[t] = max(0.0, min(float(obs_x[t]), y_t))
                x_frozen = float(obs_x[a_i])
                y_frozen = float(obs_y[a_i])
            else:
                x_frozen = 0.0
                y_frozen = 0.0
            for t in range(a_i + 1, saturation_tau + 1):
                obs_x[t] = x_frozen
                obs_y[t] = y_frozen

        ci_materialised = dict(ci)
        ci_materialised['x_frozen'] = x_frozen
        ci_materialised['y_frozen'] = y_frozen
        materialised_cohort_list.append(ci_materialised)

        engine_cohorts.append(CohortEvidence(
            obs_x=obs_x,
            obs_y=obs_y,
            x_frozen=x_frozen,
            y_frozen=y_frozen,
            frontier_age=a_i,
            a_pop=a_pop,
            # Doc 45 §Response contract: the CF endpoint and the
            # cohort maturity chart share this engine. Setting
            # eval_age = frontier_age tells compute_forecast_trajectory to
            # populate `sweep.completeness_mean` / `completeness_sd`
            # (n-weighted CDF across cohorts at their own frontiers).
            # Without this, the sweep leaves those fields None and
            # downstream consumers (the CF endpoint, maturity rows)
            # have nothing to report — the exact gap that let
            # completeness go AWOL end-to-end.
            eval_age=a_i,
        ))

    if not engine_cohorts:
        return None

    # ── Aggregate evidence_by_tau from engine_cohorts ──────────────
    # Both sum_x and sum_y are observed values drawn from the engine
    # cohorts' obs_x / frame y at each recorded tau. n_cohorts counts
    # cohorts that reported a real observation at this tau.
    evidence_by_tau: Dict[int, Dict] = {}
    for ci, engine_cohort in zip(materialised_cohort_list, engine_cohorts):
        ad_str = ci['anchor_day'].isoformat()
        for tau in cohort_at_tau.get(ad_str, {}):
            if tau < 0 or tau > saturation_tau:
                continue
            bucket = evidence_by_tau.setdefault(
                int(tau),
                {'sum_y': 0.0, 'sum_x': 0.0, 'n_cohorts': 0},
            )
            if tau < len(engine_cohort.obs_x):
                bucket['sum_x'] += float(engine_cohort.obs_x[tau])
            else:
                bucket['sum_x'] += float(engine_cohort.x_frozen)
            if tau < len(engine_cohort.obs_y):
                bucket['sum_y'] += float(engine_cohort.obs_y[tau])
            else:
                bucket['sum_y'] += float(engine_cohort.y_frozen)
            bucket['n_cohorts'] += 1

    return FrameEvidence(
        engine_cohorts=engine_cohorts,
        cohort_list=materialised_cohort_list,
        cohort_at_tau=dict(cohort_at_tau),
        evidence_by_tau=evidence_by_tau,
        max_tau=max_tau,
        saturation_tau=saturation_tau,
        tau_solid_max=tau_solid_max,
        tau_future_max=tau_future_max,
        last_frame_date=last_frame_date,
        x_provider=x_provider,
        from_node_arrival=from_node_arrival,
        upstream_path_cdf_arr=upstream_path_cdf_arr,
        carrier_tier=carrier_tier,
    )


def compute_cohort_maturity_rows_v3(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    query_from_node: str,
    query_to_node: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool = True,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
    anchor_node_id: Optional[str] = None,
    display_settings: Optional[Dict[str, Any]] = None,
    mc_cdf_arr=None,
    mc_p_s=None,
    det_norm_cdf=None,
    det_span_p=None,
    x_provider_override=None,
    span_alpha=None,
    span_beta=None,
    span_mu_sd=None,
    span_sigma_sd=None,
    span_onset_sd=None,
    span_onset_mu_corr=None,
    is_multi_hop=False,
    resolved_override=None,
    edge_cdf_arr=None,
    runtime_bundle=None,
) -> List[Dict[str, Any]]:
    """Compute per-tau rows for cohort maturity v3 chart.

    Same row schema as v2 so the FE chart builder works unchanged.
    Delegates the per-cohort population model to the engine via
    compute_forecast_trajectory.
    """
    from .forecast_state import compute_forecast_trajectory
    from .model_resolver import resolve_model_params
    from .forecast_runtime import (
        PreparedForecastRuntimeBundle,
        build_prepared_runtime_bundle,
        find_edge_by_id,
        get_cf_mode_and_reason,
        is_cf_sweep_eligible,
    )

    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    # ── Resolve model params ────────────────────────────────────────
    # Default: edge-level. When resolved_override is provided (e.g.
    # collapsed shortcut with path latency + edge p), use it directly.
    if resolved_override is not None:
        resolved = resolved_override
    elif runtime_bundle is not None and runtime_bundle.resolved_params is not None:
        resolved = runtime_bundle.resolved_params
    else:
        temporal = 'window' if is_window else 'cohort'
        resolved = resolve_model_params(
            target_edge,
            scope='edge',
            temporal_mode=temporal,
        )
    if not resolved:
        return []
    _sweep_eligible = is_cf_sweep_eligible(resolved)
    _cf_mode, _cf_reason = get_cf_mode_and_reason(resolved)

    def _prepare_runtime_bundle(
        *,
        fe_local,
        resolved_local,
        cf_mode_local: str,
        cf_reason_local: Optional[str],
        x_provider_local=None,
        from_node_arrival_local=None,
    ) -> PreparedForecastRuntimeBundle:
        bundle = runtime_bundle
        if bundle is None:
            _direct_cohort_p_conditioning = False
            bundle = build_prepared_runtime_bundle(
                mode='window' if is_window else 'cohort',
                query_from_node=query_from_node,
                query_to_node=query_to_node,
                anchor_node_id=anchor_node_id,
                is_multi_hop=is_multi_hop,
                x_provider=x_provider_local,
                from_node_arrival=from_node_arrival_local,
                numerator_representation='factorised',
                p_conditioning_temporal_family=(
                    'cohort' if _direct_cohort_p_conditioning else 'window'
                ),
                p_conditioning_source=(
                    'direct_cohort_exact_subject'
                    if _direct_cohort_p_conditioning
                    else 'frame_evidence'
                ),
                p_conditioning_direct_cohort=_direct_cohort_p_conditioning,
                resolved_params=resolved_local,
                sweep_eligible=is_cf_sweep_eligible(resolved_local),
                cf_mode=cf_mode_local,
                cf_reason=cf_reason_local,
                mc_cdf_arr=mc_cdf_arr,
                mc_p_s=mc_p_s,
                det_norm_cdf=det_norm_cdf,
                edge_cdf_arr=None,
                span_alpha=span_alpha,
                span_beta=span_beta,
                span_mu_sd=span_mu_sd,
                span_sigma_sd=span_sigma_sd,
                span_onset_sd=span_onset_sd,
                span_onset_mu_corr=span_onset_mu_corr,
            )
        else:
            bundle.resolved_params = resolved_local
            bundle.sweep_eligible = is_cf_sweep_eligible(resolved_local)
            bundle.cf_mode = cf_mode_local
            bundle.cf_reason = cf_reason_local
            if bundle.carrier_to_x.mode == 'upstream':
                bundle.carrier_to_x.x_provider = x_provider_local
                bundle.carrier_to_x.from_node_arrival = from_node_arrival_local
            else:
                bundle.carrier_to_x.x_provider = None
                bundle.carrier_to_x.from_node_arrival = None
            if x_provider_local is not None:
                bundle.carrier_to_x.reach = float(
                    getattr(x_provider_local, 'reach', 0.0) or 0.0
                )
            elif from_node_arrival_local is not None:
                bundle.carrier_to_x.reach = float(
                    getattr(from_node_arrival_local, 'reach', 0.0) or 0.0
                )
            if bundle.operator_inputs.mc_cdf_arr is None:
                bundle.operator_inputs.mc_cdf_arr = mc_cdf_arr
            if bundle.operator_inputs.mc_p_s is None:
                bundle.operator_inputs.mc_p_s = mc_p_s
            if bundle.operator_inputs.det_norm_cdf is None:
                bundle.operator_inputs.det_norm_cdf = det_norm_cdf
            bundle.operator_inputs.edge_cdf_arr = None
            if bundle.operator_inputs.span_alpha is None:
                bundle.operator_inputs.span_alpha = span_alpha
            if bundle.operator_inputs.span_beta is None:
                bundle.operator_inputs.span_beta = span_beta
            if bundle.operator_inputs.span_mu_sd is None:
                bundle.operator_inputs.span_mu_sd = span_mu_sd
            if bundle.operator_inputs.span_sigma_sd is None:
                bundle.operator_inputs.span_sigma_sd = span_sigma_sd
            if bundle.operator_inputs.span_onset_sd is None:
                bundle.operator_inputs.span_onset_sd = span_onset_sd
            if bundle.operator_inputs.span_onset_mu_corr is None:
                bundle.operator_inputs.span_onset_mu_corr = span_onset_mu_corr

        if fe_local is not None:
            bundle.p_conditioning_evidence.evidence_points = len(
                fe_local.cohort_list or []
            )
            bundle.p_conditioning_evidence.total_x = float(
                sum(c.get('x_frozen', 0.0) for c in fe_local.cohort_list)
            )
            bundle.p_conditioning_evidence.total_y = float(
                sum(c.get('y_frozen', 0.0) for c in fe_local.cohort_list)
            )
        else:
            bundle.p_conditioning_evidence.evidence_points = 0
            bundle.p_conditioning_evidence.total_x = None
            bundle.p_conditioning_evidence.total_y = None
        return bundle

    # ── Non-latency edge: closed-form shortcut ─────────────────────
    # Authoritative signal is the edge's latency_parameter flag, not
    # resolved.latency.sigma. See ANALYSIS_TYPES_CATALOGUE.md §284,
    # adding-analysis-types.md §235, and KNOWN_ANTI_PATTERNS.md —
    # promoted sigma/mu appears on non-latency edges too, so sigma
    # is not a reliable signal.
    _lat_meta = (target_edge.get('p') or {}).get('latency') or {}
    _is_latency_edge = _lat_meta.get('latency_parameter') is True
    if not _is_latency_edge:
        fe_closed_form = build_cohort_evidence_from_frames(
            frames=frames,
            target_edge=target_edge,
            anchor_from=anchor_from,
            anchor_to=anchor_to,
            sweep_to=sweep_to,
            is_window=is_window,
            resolved=resolved,
            axis_tau_max=axis_tau_max,
        )
        _res = _non_latency_rows(
            fe=fe_closed_form,
            resolved=resolved,
            sweep_to=sweep_to,
            axis_tau_max=axis_tau_max,
            band_level=band_level,
        )
        _prepare_runtime_bundle(
            fe_local=fe_closed_form,
            resolved_local=resolved,
            cf_mode_local=_cf_mode,
            cf_reason_local=_cf_reason,
        )
        return _attach_cf_row_metadata(
            _res.rows,
            conditioning={
                'r': _res.r,
                'm_S': _res.m_S,
                'm_G': _res.m_G,
                'applied': _res.blend_applied,
                'skip_reason': _res.blend_skip_reason,
            },
            conditioned=_res.conditioned,
            cf_mode=_cf_mode,
            cf_reason=_cf_reason,
        )

    lat = resolved.latency

    # ── Build evidence from frames (shared with topo pass) ─────────
    # The builder owns carrier resolution and observed-prefix materialisation.
    # When cohort mode has a real A→X carrier, both denominator and
    # numerator prefixes are rebuilt there using the same raw subject-side
    # progression curve the sweep later conditions against. No post-build
    # rewrite.
    fe = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge=target_edge,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        resolved=resolved,
        axis_tau_max=axis_tau_max,
        graph=graph,
        anchor_node_id=anchor_node_id,
        query_from_node=query_from_node,
        x_provider_override=x_provider_override,
        det_norm_cdf=det_norm_cdf,
    )
    x_provider = fe.x_provider if fe is not None else None
    from_node_arrival = fe.from_node_arrival if fe is not None else None
    upstream_path_cdf_arr = fe.upstream_path_cdf_arr if fe is not None else None
    _carrier_tier = fe.carrier_tier if fe is not None else 'none'
    print(f"[v3] carrier: tier={_carrier_tier}")
    if not _sweep_eligible:
        resolved_degraded = resolved
        _cf_mode, _cf_reason = get_cf_mode_and_reason(resolved_degraded)
        degraded_runtime_bundle = _prepare_runtime_bundle(
            fe_local=fe,
            resolved_local=resolved_degraded,
            cf_mode_local=_cf_mode,
            cf_reason_local=_cf_reason,
            x_provider_local=x_provider,
            from_node_arrival_local=from_node_arrival,
        )
        _res = _query_scoped_latency_rows(
            fe=fe,
            resolved=resolved_degraded,
            sweep_to=sweep_to,
            axis_tau_max=axis_tau_max,
            band_level=band_level,
            is_window=is_window,
            runtime_bundle=degraded_runtime_bundle,
        )
        return _attach_cf_row_metadata(
            _res.rows,
            conditioning={
                'r': _res.r,
                'm_S': _res.m_S,
                'm_G': _res.m_G,
                'applied': _res.blend_applied,
                'skip_reason': _res.blend_skip_reason,
            },
            conditioned=_res.conditioned,
            cf_mode=_cf_mode,
            cf_reason=_cf_reason,
        )

    if fe is None:
        return []

    engine_cohorts = fe.engine_cohorts
    cohort_list = fe.cohort_list
    cohort_at_tau = fe.cohort_at_tau
    evidence_by_tau = fe.evidence_by_tau
    max_tau = fe.max_tau
    saturation_tau = fe.saturation_tau
    tau_solid_max = fe.tau_solid_max
    tau_future_max = fe.tau_future_max
    last_frame_date = fe.last_frame_date

    active_runtime_bundle = _prepare_runtime_bundle(
        fe_local=fe,
        resolved_local=resolved,
        cf_mode_local=_cf_mode,
        cf_reason_local=_cf_reason,
        x_provider_local=x_provider,
        from_node_arrival_local=from_node_arrival,
    )

    # ── Build per-cohort x_at_tau from carrier (v2 lines 700-708) ────
    _cohort_x_at_tau: List[List[float]] = []
    reach = x_provider.reach if x_provider else 0.0
    for ci in cohort_list:
        n_i = ci['x_frozen']
        a_pop = ci.get('a_frozen', n_i) or n_i or 1.0
        if upstream_path_cdf_arr is None:
            x_at_tau = [float(n_i)] * (saturation_tau + 1)
        else:
            x_at_tau = [
                max(a_pop * reach * upstream_path_cdf_arr[t], float(n_i))
                for t in range(saturation_tau + 1)
            ]
        _cohort_x_at_tau.append(x_at_tau)

    # ── Engine call: per-cohort population model sweep ──────────────
    # The handler prepares `mc_cdf_arr` on the factorised subject span
    # before we get here:
    # - window(): edge/rooted X->end
    # - cohort() single-hop: edge/rooted X->Y
    # - cohort() multi-hop: query path X->end
    #
    # Any anchor-relative behaviour belongs on `carrier_to_x` or the
    # rate-conditioning evidence seam, not by retargeting the subject span.
    # `det_norm_cdf` therefore remains the subject-side X->end kernel used for
    # E_i / IS conditioning.
    _sweep_cdf = mc_cdf_arr
    _sweep_p = mc_p_s
    sweep = compute_forecast_trajectory(
        resolved=resolved,
        cohorts=engine_cohorts,
        max_tau=saturation_tau,
        from_node_arrival=from_node_arrival,
        mc_cdf_arr=_sweep_cdf,
        mc_p_s=_sweep_p,
        span_alpha=span_alpha,
        span_beta=span_beta,
        span_mu_sd=span_mu_sd,
        span_sigma_sd=span_sigma_sd,
        span_onset_sd=span_onset_sd,
        span_onset_mu_corr=span_onset_mu_corr,
        det_norm_cdf=det_norm_cdf,
        edge_cdf_arr=None,
        runtime_bundle=active_runtime_bundle,
    )

    print(
        f"[v3] Engine sweep: IS_ESS={sweep.is_ess:.0f} "
        f"cohorts_conditioned={sweep.n_cohorts_conditioned} "
        f"shape={sweep.rate_draws.shape}"
    )

    # ── Compute evidence display from cohort data (v2 lines 990-1008) ─
    # Evidence at each tau = aggregate obs across all cohorts, using the
    # same population model as the sweep: observed values for cohorts
    # whose frontier is >= tau, frozen/projected values for younger cohorts.
    def _compute_evidence_at_tau(tau: int) -> Optional[Dict]:
        if tau > tau_future_max:
            return None
        has_real_obs = any(
            tau in cohort_at_tau.get(ci['anchor_day'].isoformat(), {})
            for ci in cohort_list
            if tau <= ci.get('tau_observed', ci['tau_max'])
        )
        if not has_real_obs:
            return None
        ev_y = 0.0
        ev_x = 0.0
        ev_y_pure = 0.0
        ev_x_pure = 0.0
        n_cohorts = 0
        n_mature = 0
        for idx, (ci, ce) in enumerate(zip(cohort_list, engine_cohorts)):
            a_i = ci.get('tau_observed', ci['tau_max'])
            tau_max_c = ci['tau_max']
            if tau < len(ce.obs_x):
                if tau <= a_i:
                    ev_x += ce.obs_x[tau]
                    ev_x_pure += ce.obs_x[tau]
                    ev_y_pure += ce.obs_y[tau]
                else:
                    _xat = _cohort_x_at_tau[idx]
                    ev_x += _xat[tau] if tau < len(_xat) else ce.x_frozen
                ad_str = ci['anchor_day'].isoformat()
                if tau <= tau_max_c and tau in cohort_at_tau.get(ad_str, {}):
                    n_mature += 1
                ev_y += ce.obs_y[tau]
                n_cohorts += 1
        if ev_x <= 0:
            return None
        return {
            'sum_y': ev_y,
            'sum_x': ev_x,
            'sum_y_pure': ev_y_pure,
            'sum_x_pure': ev_x_pure,
            'n_cohorts': n_cohorts,
            'n_mature': n_mature,
        }

    # ── Assemble rows from sweep result ─────────────────────────────
    # D19 fix (G.4): forecast_y/forecast_x now read from sweep.det_y_total
    # / sweep.det_x_total (median IS-conditioned Y/X across draws).
    # This replaces _compute_det_totals which used unconditioned p and
    # edge-level CDF, diverging up to 50% on multi-hop narrow queries.
    t = sweep.rate_draws.shape[1]
    band_levels = [0.80, 0.90, 0.95, 0.99]
    rows = []

    # p@∞: median of IS-conditioned rate draws at saturation tau. Sweep
    # ran out to saturation_tau (2*t95 window / 2*path_t95 cohort); rows
    # stay clipped to max_tau so the chart axis is unchanged. Exposed on
    # every row so consumers (CF endpoint) read one scalar off last_row
    # without a separate channel — see handle_conditioned_forecast.
    _sat_tau = min(saturation_tau, t - 1)
    _asymp_draws = sweep.rate_draws[:, _sat_tau]
    _p_infinity_mean = float(np.median(_asymp_draws))
    # Per doc 49: two dispersion regimes.
    #   _p_infinity_sd_epistemic — closed-form sigma from Beta(alpha, beta): how
    #     confident we are about the rate parameter after all observed
    #     evidence.
    #   _p_infinity_sd (predictive, kappa-inflated) — closed-form sigma from
    #     Beta(alpha_pred, beta_pred): dispersion of a fresh-cohort rate draw
    #     accounting for between-cohort variability (kappa).
    # Both are closed form. Historically _p_infinity_sd used
    # np.std(IS-conditioned draws), but IS-conditioning on O(n) evidence
    # collapses the MC spread back to sigma_epi regardless of how diffuse
    # the predictive prior was, so the two quantities came out equal.
    # Contract corrected: docs 45b §Phase C and 47 §3 updated alongside.
    def _local_beta_sd(a: float, b: float) -> float:
        s = a + b
        return math.sqrt(a * b / (s * s * (s + 1.0)))
    _alpha_e = resolved.alpha if (resolved.alpha and resolved.alpha > 0) else None
    _beta_e = resolved.beta if (resolved.beta and resolved.beta > 0) else None
    if _alpha_e is not None and _beta_e is not None:
        _p_infinity_sd_epistemic = _local_beta_sd(_alpha_e, _beta_e)
    else:
        _p_infinity_sd_epistemic = float(np.std(_asymp_draws))
    _alpha_p = (
        resolved.alpha_pred
        if (resolved.alpha_pred and resolved.alpha_pred > 0)
        else None
    )
    _beta_p = (
        resolved.beta_pred
        if (resolved.beta_pred and resolved.beta_pred > 0)
        else None
    )
    if _alpha_p is not None and _beta_p is not None:
        _p_infinity_sd = _local_beta_sd(_alpha_p, _beta_p)
    else:
        _p_infinity_sd = _p_infinity_sd_epistemic

    for tau in range(max_tau + 1):
        ev = _compute_evidence_at_tau(tau)
        rate = ev['sum_y'] / ev['sum_x'] if ev and ev['sum_x'] > 0 else None
        _det_y_tau = (
            float(sweep.det_y_total[tau])
            if sweep.det_y_total is not None and tau < len(sweep.det_y_total)
            else 0.0
        )
        _det_x_tau = (
            float(sweep.det_x_total[tau])
            if sweep.det_x_total is not None and tau < len(sweep.det_x_total)
            else 0.0
        )
        rate_pure = (
            ev['sum_y_pure'] / ev['sum_x_pure']
            if ev and ev.get('sum_x_pure', 0) > 0
            else None
        )

        draws = sweep.rate_draws[:, tau]
        midpoint: Optional[float] = float(np.median(draws))
        fan_upper_val: Optional[float] = float(
            np.quantile(draws, (1 + band_level) / 2)
        )
        fan_lower_val: Optional[float] = float(
            np.quantile(draws, (1 - band_level) / 2)
        )
        fan_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(np.quantile(draws, (1 - bl) / 2)),
                float(np.quantile(draws, (1 + bl) / 2)),
            ]
            for bl in band_levels
        }

        if tau < tau_solid_max:
            midpoint = None
            fan_upper_val = None
            fan_lower_val = None
            fan_bands = None

        model_draws = sweep.model_rate_draws[:, tau]
        model_midpoint = float(np.median(model_draws))
        model_fan_upper = float(np.quantile(model_draws, (1 + band_level) / 2))
        model_fan_lower = float(np.quantile(model_draws, (1 - band_level) / 2))
        model_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(np.quantile(model_draws, (1 - bl) / 2)),
                float(np.quantile(model_draws, (1 + bl) / 2)),
            ]
            for bl in band_levels
        }

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate_pure,
            'evidence_y': ev['sum_y'] if ev else None,
            'evidence_x': ev['sum_x'] if ev else None,
            'projected_rate': float(np.mean(draws)),
            'forecast_y': round(_det_y_tau, 1) if midpoint is not None else None,
            'forecast_x': round(_det_x_tau, 1) if midpoint is not None else None,
            'midpoint': midpoint,
            'fan_upper': fan_upper_val,
            'fan_lower': fan_lower_val,
            'fan_bands': fan_bands,
            'model_midpoint': model_midpoint,
            'model_fan_upper': model_fan_upper,
            'model_fan_lower': model_fan_lower,
            'model_bands': model_bands,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': ev['n_mature'] if ev else 0,
            'cohorts_covered_projected': ev['n_mature'] if ev else 0,
            'completeness': sweep.completeness_mean,
            'completeness_sd': sweep.completeness_sd,
            'p_infinity_mean': _p_infinity_mean,
            'p_infinity_sd': _p_infinity_sd,
            'p_infinity_sd_epistemic': _p_infinity_sd_epistemic,
        })

    return _attach_cf_row_metadata(
        rows,
        conditioning={
            'r': sweep.r,
            'm_S': sweep.m_S,
            'm_G': sweep.m_G,
            'applied': sweep.blend_applied,
            'skip_reason': sweep.blend_skip_reason,
        },
        conditioned=bool(sweep.n_cohorts_conditioned),
        cf_mode=_cf_mode,
        cf_reason=_cf_reason,
    )
