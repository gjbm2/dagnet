"""
Forecast runtime layer for the live forecast stack.

This module started as the neutral home for helpers previously scattered
across v1 (`cohort_forecast.py`), v2 (`cohort_forecast_v2.py`), and the
transitional `span_adapter.py`). It is now the runtime-owned assembly
layer used by the production forecast engine, the v3 row builder, and the
active conditioned-forecast handlers.

It contains:

  - Graph helpers used by production CF / v3 / engine callers:
    find_edge_by_id, get_incoming_edges, get_edge_from_node, XProvider,
    build_x_provider_from_graph, read_edge_cohort_params.

  - Span-prior construction migrated from the legacy stack:
    SpanParams, build_span_params, span_kernel_to_edge_params.

  - Upstream carrier composition:
    build_x_provider_from_graph delegates active A→X carrier timing to
    runner.timing_span's shared timing algebra.

Legacy modules remain in the repo for frozen v2 / parity-oracle paths, but
the production forecast stack should keep converging on this module rather
than reintroducing v1/v2 imports.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from datetime import date as _date
from typing import Any, Callable, Dict, List, Optional, Tuple


_COHORT_DEBUG = bool(os.environ.get('DAGNET_COHORT_DEBUG'))


# ═══════════════════════════════════════════════════════════════════════
# Prepared runtime bundle (doc 60 WP2 / doc 59 runtime roles)
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class PreparedOperatorInputs:
    """Prepared subject-side operator inputs for the engine."""
    mc_cdf_arr: Optional[Any] = None
    mc_p_s: Optional[Any] = None
    det_norm_cdf: Optional[List[float]] = None
    edge_cdf_arr: Optional[Any] = None
    span_alpha: Optional[float] = None
    span_beta: Optional[float] = None
    span_mu_sd: Optional[float] = None
    span_sigma_sd: Optional[float] = None
    span_onset_sd: Optional[float] = None
    span_onset_mu_corr: Optional[float] = None


@dataclass
class PreparedSpanExecutionInputs:
    """Prepared per-edge inputs for subject-span execution.

    Dispersions are carried in two dicts per doc 61:
      * `edge_sds` holds EPISTEMIC SDs (mu_sd) — used by reporting
        consumers such as cohort_maturity_v3 "model belief" overlap bands.
      * `edge_sds_pred` holds PREDICTIVE SDs (mu_sd_pred, kappa_lat-inflated)
        — used by forecasting consumers such as the main fan chart and the
        conditioned-forecast MC sweep.
    σ and onset SDs appear identically in both dicts (no predictive variant
    exists in the current model). When the resolver has no `mu_sd_pred`
    value (pre-doc-61 data, kappa_lat not fitted), `edge_sds_pred` carries
    the bare mu_sd as a safe fallback — correct when predictive == epistemic.
    """
    topo: Any
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]]
    edge_sds: Dict[Tuple[str, str], Tuple[float, float, float, float]]
    edge_sds_pred: Dict[Tuple[str, str], Tuple[float, float, float, float]]


@dataclass
class PreparedCarrierToX:
    """Explicit denominator-side carrier object."""
    population_root: str = ''
    anchor_node_id: Optional[str] = None
    x_node_id: str = ''
    mode: str = 'identity'  # 'identity' | 'upstream'
    reach: float = 0.0
    x_provider: Optional['XProvider'] = None
    from_node_arrival: Optional[Any] = None


@dataclass
class PreparedSubjectSpan:
    """Explicit numerator-side X→end question."""
    start_node_id: str = ''
    end_node_id: str = ''
    is_multi_hop: bool = False
    operator_source: str = 'prepared_subject_span'


@dataclass
class PreparedConditioningEvidence:
    """Compatibility metadata describing the evidence the live trajectory
    engine conditioned on (per-edge ``total_x`` / ``total_y`` totals plus
    a temporal-family label and source label).

    Plan §762 — this object is **compatibility metadata**, not a live
    evidence-ownership decider. Evidence ownership for the public
    response sits on ``ConditionedTransitionPrimitive``. The primitive
    readout consumes the request's superset-derived candidate pool and
    binds it against primitive-local runtime clocks; it does **not** read
    these totals to decide ownership.

    Why the field still exists:
      - The legacy fallback path (un-substituted CF requests) reports
        evidence_points / total_x / total_y on the response so callers
        without typed evidence dicts on the graph still see a numeric
        evidence pair.
    Retirement is tracked as a follow-up; consumers must read primitive
    provenance for ownership, not these totals."""
    temporal_family: str = 'window'
    source: str = 'none'
    evidence_points: int = 0
    total_x: Optional[float] = None
    total_y: Optional[float] = None


@dataclass
class PreparedAdmissionPolicy:
    """Current admission outputs for the live runtime."""
    numerator_representation: str = 'factorised'
    whole_query_numerator_admitted: bool = False
    subject_helper_admitted: bool = True
    helper_reason: str = 'prepared_subject_span'


@dataclass
class PreparedForecastRuntimeBundle:
    """Internal semantic bundle carried across preparation and solve."""
    mode: str = 'window'
    population_root: str = ''
    carrier_to_x: PreparedCarrierToX = field(default_factory=PreparedCarrierToX)
    subject_span: PreparedSubjectSpan = field(default_factory=PreparedSubjectSpan)
    numerator_representation: str = 'factorised'
    p_conditioning_evidence: PreparedConditioningEvidence = field(
        default_factory=PreparedConditioningEvidence
    )
    admission_policy: PreparedAdmissionPolicy = field(
        default_factory=PreparedAdmissionPolicy
    )
    operator_inputs: PreparedOperatorInputs = field(default_factory=PreparedOperatorInputs)
    resolved_params: Optional[Any] = None
    cf_mode: Optional[str] = None
    cf_reason: Optional[str] = None


def should_use_anchor_relative_subject_cdf(
    *,
    is_window: bool,
    is_multi_hop: bool,
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
) -> bool:
    """Return whether the subject CDF should start at the anchor.

    The live WP3/WP8 contract keeps the subject operator rooted at `X -> end`
    even for exact single-hop `cohort(A, X-Y)` subjects. The anchor-relative
    `A -> Y` timing effect now lives only on `carrier_to_x`; the subject span
    itself must not be retargeted. We keep this helper so older call sites can
    collapse onto the new contract without reshaping their plumbing.
    """
    return False


def resolve_subject_cdf_start_node(
    *,
    is_window: bool,
    is_multi_hop: bool,
    anchor_node_id: Optional[str],
    query_from_node: str,
) -> str:
    """Return the start node for the prepared subject CDF execution.

    Under the factorised runtime this is always the query's `from_node`; any
    upstream anchor effect is represented on the carrier instead.
    """
    return query_from_node


@dataclass(frozen=True)
class ClosedFormBetaRateSurface:
    """Closed-form Beta posterior surface for degraded/query-scoped outputs."""
    p_mean: float
    p_sd_epistemic: float
    p_sd: float
    fan_lower: float
    fan_upper: float
    band_lookup: Dict[str, List[float]] = field(default_factory=dict)


def build_prepared_runtime_bundle(
    *,
    mode: str,
    query_from_node: str,
    query_to_node: str,
    anchor_node_id: Optional[str] = None,
    is_multi_hop: bool = False,
    x_provider: Optional['XProvider'] = None,
    from_node_arrival: Optional[Any] = None,
    numerator_representation: str = 'factorised',
    p_conditioning_temporal_family: Optional[str] = None,
    p_conditioning_source: str = 'snapshot_frames',
    p_conditioning_direct_cohort: bool = False,
    p_conditioning_evidence_points: int = 0,
    p_conditioning_total_x: Optional[float] = None,
    p_conditioning_total_y: Optional[float] = None,
    resolved_params: Optional[Any] = None,
    cf_mode: Optional[str] = None,
    cf_reason: Optional[str] = None,
    mc_cdf_arr: Optional[Any] = None,
    mc_p_s: Optional[Any] = None,
    det_norm_cdf: Optional[List[float]] = None,
    edge_cdf_arr: Optional[Any] = None,
    span_alpha: Optional[float] = None,
    span_beta: Optional[float] = None,
    span_mu_sd: Optional[float] = None,
    span_sigma_sd: Optional[float] = None,
    span_onset_sd: Optional[float] = None,
    span_onset_mu_corr: Optional[float] = None,
) -> PreparedForecastRuntimeBundle:
    """Build the explicit internal runtime bundle for forecast consumers."""
    del p_conditioning_direct_cohort

    def _has_semantic_upstream_carrier() -> bool:
        if x_provider is not None:
            return bool(getattr(x_provider, 'enabled', False))
        if from_node_arrival is not None:
            tier = str(getattr(from_node_arrival, 'tier', '') or '')
            return tier not in {'', 'none', 'anchor'}
        return False

    population_root = query_from_node
    if mode == 'cohort' and anchor_node_id:
        population_root = anchor_node_id

    carrier_mode = 'identity'
    if (
        mode == 'cohort'
        and anchor_node_id
        and anchor_node_id != query_from_node
        and _has_semantic_upstream_carrier()
    ):
        carrier_mode = 'upstream'

    if x_provider is not None:
        reach = float(getattr(x_provider, 'reach', 0.0) or 0.0)
    elif from_node_arrival is not None:
        reach = float(getattr(from_node_arrival, 'reach', 0.0) or 0.0)
    else:
        reach = 1.0 if carrier_mode == 'identity' else 0.0

    carrier_x_provider = x_provider if carrier_mode == 'upstream' else None
    carrier_from_node_arrival = (
        from_node_arrival if carrier_mode == 'upstream' else None
    )

    return PreparedForecastRuntimeBundle(
        mode=mode,
        population_root=population_root,
        carrier_to_x=PreparedCarrierToX(
            population_root=population_root,
            anchor_node_id=anchor_node_id,
            x_node_id=query_from_node,
            mode=carrier_mode,
            reach=reach,
            x_provider=carrier_x_provider,
            from_node_arrival=carrier_from_node_arrival,
        ),
        subject_span=PreparedSubjectSpan(
            start_node_id=query_from_node,
            end_node_id=query_to_node,
            is_multi_hop=is_multi_hop,
        ),
        numerator_representation=numerator_representation,
        p_conditioning_evidence=PreparedConditioningEvidence(
            temporal_family=(p_conditioning_temporal_family or 'window'),
            source=p_conditioning_source,
            evidence_points=p_conditioning_evidence_points,
            total_x=p_conditioning_total_x,
            total_y=p_conditioning_total_y,
        ),
        admission_policy=PreparedAdmissionPolicy(
            numerator_representation=numerator_representation,
            whole_query_numerator_admitted=False,
            subject_helper_admitted=(numerator_representation == 'factorised'),
            helper_reason='prepared_subject_span',
        ),
        operator_inputs=PreparedOperatorInputs(
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            det_norm_cdf=det_norm_cdf,
            edge_cdf_arr=edge_cdf_arr,
            span_alpha=span_alpha,
            span_beta=span_beta,
            span_mu_sd=span_mu_sd,
            span_sigma_sd=span_sigma_sd,
            span_onset_sd=span_onset_sd,
            span_onset_mu_corr=span_onset_mu_corr,
        ),
        resolved_params=resolved_params,
        cf_mode=cf_mode,
        cf_reason=cf_reason,
    )


def build_prepared_span_execution_from_topology(
    topo,
    *,
    temporal_mode: str = 'window',
    graph_preference: Optional[str] = None,
) -> PreparedSpanExecutionInputs:
    """Resolve per-edge span execution inputs from the runtime layer.

    The span kernel consumes only prepared per-edge parameters; all source
    selection lives here via `resolve_model_params`.
    """
    from runner.model_resolver import resolve_model_params

    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    edge_sds: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    edge_sds_pred: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}

    for from_id, to_id, edge in getattr(topo, 'edge_list', []):
        resolved = resolve_model_params(
            edge,
            scope='edge',
            temporal_mode=temporal_mode,
            graph_preference=graph_preference,
        )
        lat = resolved.edge_latency if resolved is not None else None
        p_mean = float(min(max(getattr(resolved, 'p_mean', 0.0) or 0.0, 0.0), 1.0))
        p_sd = float(getattr(resolved, 'p_sd', 0.0) or 0.0)
        # Predictive p_sd — closed form from `alpha_pred`/`beta_pred`. For
        # bayes this is the kappa-inflated Beta from MCMC; for analytic
        # it is the Williams MoM Beta-Binomial concentration emitted via
        # the §6 overdispersion estimator. Falls back to the epistemic
        # p_sd when no predictive Beta is available (sources that emit
        # epistemic only). See EPISTEMIC_DISPERSION_DESIGN.md §7.
        _ap = float(getattr(resolved, 'alpha_pred', 0.0) or 0.0)
        _bp = float(getattr(resolved, 'beta_pred', 0.0) or 0.0)
        if _ap > 0 and _bp > 0:
            _s_pred = _ap + _bp
            p_sd_pred = math.sqrt(_ap * _bp / (_s_pred * _s_pred * (_s_pred + 1.0)))
        else:
            p_sd_pred = p_sd
        mu = float(getattr(lat, 'mu', 0.0) or 0.0)
        sigma = float(getattr(lat, 'sigma', 0.0) or 0.0)
        onset = float(getattr(lat, 'onset_delta_days', 0.0) or 0.0)
        # Doc 61: bare mu_sd is epistemic; mu_sd_pred is kappa_lat-inflated
        # predictive. When the resolver has no pred value (no kappa_lat, or
        # pre-migration data), fall back to the bare mu_sd — correct when
        # predictive and epistemic coincide.
        mu_sd_epist = float(getattr(lat, 'mu_sd', 0.0) or 0.0)
        mu_sd_pred_raw = getattr(lat, 'mu_sd_pred', None)
        mu_sd_pred = float(mu_sd_pred_raw) if mu_sd_pred_raw else mu_sd_epist
        sigma_sd = float(getattr(lat, 'sigma_sd', 0.0) or 0.0)
        onset_sd = float(getattr(lat, 'onset_sd', 0.0) or 0.0)

        edge_params[(from_id, to_id)] = (p_mean, mu, sigma, onset)
        edge_sds[(from_id, to_id)] = (
            p_sd if p_sd > 0 else 0.05,
            mu_sd_epist,
            sigma_sd,
            onset_sd,
        )
        edge_sds_pred[(from_id, to_id)] = (
            p_sd_pred if p_sd_pred > 0 else 0.05,
            mu_sd_pred,
            sigma_sd,
            onset_sd,
        )

    return PreparedSpanExecutionInputs(
        topo=topo,
        edge_params=edge_params,
        edge_sds=edge_sds,
        edge_sds_pred=edge_sds_pred,
    )


def build_prepared_span_execution(
    graph: Dict[str, Any],
    x_node_id: str,
    y_node_id: str,
    *,
    temporal_mode: str = 'window',
    graph_preference: Optional[str] = None,
) -> Optional[PreparedSpanExecutionInputs]:
    """Build prepared span execution inputs for an x→y subject span."""
    from runner.span_kernel import _build_span_topology

    topo = _build_span_topology(graph, x_node_id, y_node_id)
    if topo is None:
        return None
    return build_prepared_span_execution_from_topology(
        topo,
        temporal_mode=temporal_mode,
        graph_preference=graph_preference,
    )


def serialise_rate_evidence_provenance(
    bundle: Optional[PreparedForecastRuntimeBundle],
) -> Optional[Dict[str, Any]]:
    """Return a public semantic summary of the rate-evidence choice."""
    if bundle is None:
        return None

    anchor_node_id = bundle.carrier_to_x.anchor_node_id or None
    x_node_id = bundle.carrier_to_x.x_node_id or None
    selected_family = str(bundle.p_conditioning_evidence.temporal_family or 'window')

    if bundle.mode == 'window':
        return {
            'selected_family': 'window',
            'selected_anchor_node': None,
            'admission_decision': 'denied',
            'decision_reason': 'window_query_uses_window_rate_evidence',
        }

    if anchor_node_id and x_node_id and anchor_node_id == x_node_id:
        return {
            'selected_family': 'window',
            'selected_anchor_node': None,
            'admission_decision': 'identity_collapse',
            'decision_reason': 'anchor_equals_subject_start',
        }

    if selected_family == 'cohort':
        return {
            'selected_family': 'cohort',
            'selected_anchor_node': anchor_node_id,
            'admission_decision': 'admitted',
            'decision_reason': (
                'single_hop_anchor_override'
                if not bundle.subject_span.is_multi_hop
                else 'anchor_differs_from_subject_start'
            ),
        }

    return {
        'selected_family': 'window',
        'selected_anchor_node': None,
        'admission_decision': 'denied',
        'decision_reason': 'cohort_rate_evidence_not_admitted',
    }


def serialise_runtime_bundle(
    bundle: Optional[PreparedForecastRuntimeBundle],
) -> Optional[Dict[str, Any]]:
    """Return a stable diagnostic projection of a runtime bundle."""
    if bundle is None:
        return None

    def _shape(value: Any) -> Optional[List[int]]:
        shape = getattr(value, 'shape', None)
        if shape is not None:
            return [int(v) for v in shape]
        if isinstance(value, list):
            return [len(value)]
        return None

    # Expose the carrier-CDF provenance and horizon diagnostics from the
    # composed timing object (when present) so a forensic trace can
    # answer the four 73h F14 questions directly from the runtime-bundle
    # diag block. The composed object lives on
    # ``XProvider.carrier_to_x`` (timing_span output); when
    # ``mode == 'identity'`` no composed object exists and the diag block
    # reports ``cdf_source='identity'`` with reach=1.
    cx = bundle.carrier_to_x
    composed = (
        getattr(cx.x_provider, 'carrier_to_x', None) if cx.x_provider is not None else None
    )
    cdf_source: Optional[str] = None
    horizon_diag: Optional[Dict[str, Any]] = None
    if cx.mode == 'identity':
        cdf_source = 'identity'
    elif composed is not None:
        cdf_source = str(getattr(composed, 'topology_case', '') or '') or None
        horizon_diag = {
            'tier': cdf_source,
            'horizon_ratio': round(float(getattr(composed, 'horizon_ratio', 0.0) or 0.0), 6),
            'horizon_status': (
                'inadequate'
                if getattr(composed, 'is_degraded', False) else 'saturated'
            ),
            'composed_edges': int(getattr(composed, 'composed_edges', 0) or 0),
            'has_latency_edge': bool(getattr(composed, 'has_latency_edge', False)),
            'transition_source': str(getattr(composed, 'transition_source', '') or ''),
        }
    elif cx.from_node_arrival is not None:
        emp_tier = str(getattr(cx.from_node_arrival, 'tier', '') or '')
        # Empirical Tier 2 was disabled for Phase 1 carrier
        # construction. Surfacing the empirical-tier label here flags any
        # regression in that gate as a forensic artefact.
        cdf_source = f'empirical_tier_{emp_tier}' if emp_tier else 'empirical_unknown'

    return {
        'mode': bundle.mode,
        'population_root': bundle.population_root,
        # The legacy latency/non-latency router was retired (73m Stage 5)
        # and all cohort_maturity v3 rows now flow through the trajectory
        # engine. Fixed True because there is no other route post-
        # retirement; the diagnostic is preserved so forensic traces can
        # assert "no closed-form shortcut was taken" without inspecting
        # code paths. If any router fork is re-introduced, this flag
        # must become a runtime-derived source label rather than a
        # constant.
        'legacy_non_latency_router_bypassed': True,
        'carrier_to_x': {
            'population_root': cx.population_root,
            'anchor_node_id': cx.anchor_node_id,
            'x_node_id': cx.x_node_id,
            'mode': cx.mode,
            'reach': round(cx.reach, 6),
            'has_x_provider': cx.x_provider is not None,
            'has_from_node_arrival': cx.from_node_arrival is not None,
            # Carrier-CDF provenance — see preamble above.
            'cdf_source': cdf_source,
            'horizon': horizon_diag,
        },
        'subject_span': {
            'start_node_id': bundle.subject_span.start_node_id,
            'end_node_id': bundle.subject_span.end_node_id,
            'is_multi_hop': bundle.subject_span.is_multi_hop,
            'operator_source': bundle.subject_span.operator_source,
        },
        'numerator_representation': bundle.numerator_representation,
        # p_conditioning_evidence is compatibility metadata (plan §762),
        # not an evidence-ownership decider. Live evidence ownership
        # sits on ConditionedTransitionPrimitive provenance carried
        # through the row-builder runtime_provenance block. These totals
        # are retained for compatibility display only.
        'p_conditioning_evidence': {
            'temporal_family': bundle.p_conditioning_evidence.temporal_family,
            'source': bundle.p_conditioning_evidence.source,
            'evidence_points': bundle.p_conditioning_evidence.evidence_points,
            'total_x': bundle.p_conditioning_evidence.total_x,
            'total_y': bundle.p_conditioning_evidence.total_y,
            'compatibility_metadata_note': (
                "plan §762: this block is compatibility metadata; "
                "evidence ownership lives on the primitive substrate "
                "and runtime_provenance diagnostics."
            ),
        },
        'admission_policy': {
            'numerator_representation': (
                bundle.admission_policy.numerator_representation
            ),
            'whole_query_numerator_admitted': (
                bundle.admission_policy.whole_query_numerator_admitted
            ),
            'subject_helper_admitted': bundle.admission_policy.subject_helper_admitted,
            'helper_reason': bundle.admission_policy.helper_reason,
        },
        'operator_inputs': {
            'mc_cdf_shape': _shape(bundle.operator_inputs.mc_cdf_arr),
            'mc_p_s_shape': _shape(bundle.operator_inputs.mc_p_s),
            'det_norm_cdf_len': (
                len(bundle.operator_inputs.det_norm_cdf)
                if bundle.operator_inputs.det_norm_cdf is not None
                else None
            ),
            'edge_cdf_shape': _shape(bundle.operator_inputs.edge_cdf_arr),
            'span_alpha': bundle.operator_inputs.span_alpha,
            'span_beta': bundle.operator_inputs.span_beta,
            'span_mu_sd': bundle.operator_inputs.span_mu_sd,
            'span_sigma_sd': bundle.operator_inputs.span_sigma_sd,
            'span_onset_sd': bundle.operator_inputs.span_onset_sd,
            'span_onset_mu_corr': bundle.operator_inputs.span_onset_mu_corr,
        },
        'resolved_source': getattr(bundle.resolved_params, 'source', None),
        'cf_mode': bundle.cf_mode,
        'cf_reason': bundle.cf_reason,
        'rate_evidence_provenance': serialise_rate_evidence_provenance(bundle),
    }


# ═══════════════════════════════════════════════════════════════════════
# Conditioned-forecast sweep eligibility / provenance
# ═══════════════════════════════════════════════════════════════════════

def get_cf_mode_and_reason(
    resolved: Optional[Any],
) -> Tuple[str, Optional[str]]:
    """CF provenance — always sweep mode post doc 73b §3.9 / Decision 13."""
    del resolved
    return ('sweep', None)


def should_enable_direct_cohort_p_conditioning(
    *,
    is_window: bool,
    is_multi_hop: bool,
) -> bool:
    """WP8 admission hook.

    The direct exact-subject cohort evidence overlay is intentionally
    deferred for now. Keep the shared runtime on the general path and
    admit no special Y-side overlay until the explicit WP8 admission
    rules land.
    """
    del is_window, is_multi_hop
    return False


def build_closed_form_beta_rate_surface(
    *,
    alpha: float,
    beta: float,
    band_level: float = 0.90,
    band_levels: Optional[List[float]] = None,
) -> Optional[ClosedFormBetaRateSurface]:
    """Return the shared doc-57 Beta surface for degraded rate outputs."""
    from .numpy_stats import beta_ppf

    alpha_val = max(float(alpha or 0.0), 0.0)
    beta_val = max(float(beta or 0.0), 0.0)
    if alpha_val <= 0.0 or beta_val <= 0.0:
        return None

    requested_levels: List[float] = []
    for level in list(band_levels or []):
        level_f = float(level)
        if level_f not in requested_levels:
            requested_levels.append(level_f)
    if float(band_level) not in requested_levels:
        requested_levels.append(float(band_level))

    total = alpha_val + beta_val
    p_mean = alpha_val / total
    p_sd_epistemic = math.sqrt(
        alpha_val * beta_val / (total * total * (total + 1.0))
    )
    band_lookup = {
        str(int(level * 100)): [
            float(beta_ppf((1.0 - level) / 2.0, alpha_val, beta_val)),
            float(beta_ppf((1.0 + level) / 2.0, alpha_val, beta_val)),
        ]
        for level in requested_levels
    }
    fan_key = str(int(float(band_level) * 100))
    fan_lower, fan_upper = band_lookup[fan_key]
    return ClosedFormBetaRateSurface(
        p_mean=p_mean,
        p_sd_epistemic=p_sd_epistemic,
        p_sd=p_sd_epistemic,
        fan_lower=float(fan_lower),
        fan_upper=float(fan_upper),
        band_lookup=band_lookup,
    )


# ═══════════════════════════════════════════════════════════════════════
# Graph helpers (ex v1 — cohort_forecast.py)
# ═══════════════════════════════════════════════════════════════════════


def get_edge_from_node(edge: Dict[str, Any]) -> str:
    """Return the from-node ID of an edge."""
    return str(edge.get('from') or edge.get('from_node') or '')


def find_edge_by_id(
    graph: Dict[str, Any],
    edge_id: str,
) -> Optional[Dict[str, Any]]:
    """Find an edge by uuid or id."""
    edges = graph.get('edges', []) if isinstance(graph, dict) else []
    return next(
        (e for e in edges
         if str(e.get('uuid') or e.get('id') or '') == str(edge_id)),
        None,
    )


def _stable_edge_sort_key(edge: Dict[str, Any]) -> Tuple[str, str, str]:
    """Deterministic edge ordering independent of graph edge-list order."""
    return (
        str(edge.get('from') or edge.get('from_node') or ''),
        str(edge.get('to') or edge.get('to_node') or ''),
        str(edge.get('uuid') or edge.get('id') or ''),
    )


def get_incoming_edges(
    graph: Dict[str, Any],
    node_id: str,
) -> List[Dict[str, Any]]:
    """Return all edges whose 'to' field matches node_id.

    Handles UUID-vs-id mismatch: edge['to'] may store a node UUID
    while node_id may be the human-readable id.  Builds a resolution
    map from the graph's nodes array.
    """
    nodes = graph.get('nodes', []) if isinstance(graph, dict) else []
    edges = graph.get('edges', []) if isinstance(graph, dict) else []

    id_to_uuid: Dict[str, str] = {}
    uuid_to_id: Dict[str, str] = {}
    for n in nodes:
        nid = n.get('id', '')
        nuuid = n.get('uuid', nid)
        id_to_uuid[nid] = nuuid
        uuid_to_id[nuuid] = nid
        uuid_to_id[nid] = nid  # identity mapping

    target_ids = {node_id}
    if node_id in id_to_uuid:
        target_ids.add(id_to_uuid[node_id])
    if node_id in uuid_to_id:
        target_ids.add(uuid_to_id[node_id])

    return sorted(
        [e for e in edges if str(e.get('to', '')) in target_ids],
        key=_stable_edge_sort_key,
    )


def order_subjects_topologically(
    graph: Dict[str, Any],
    subjects: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Return forecast subjects in deterministic topological order.

    Whole-graph CF must prepare upstream donor edges before downstream
    consumers regardless of incidental edge-list order in the graph JSON.
    Subjects are therefore ordered by node topology first, then by stable
    semantic identifiers for same-layer ties.
    """
    if not subjects:
        return []

    nodes = graph.get('nodes', []) if isinstance(graph, dict) else []
    edges = graph.get('edges', []) if isinstance(graph, dict) else []

    uuid_to_id: Dict[str, str] = {}
    node_ids: set[str] = set()
    for node in nodes:
        node_id = str(node.get('id', '') or '')
        node_uuid = str(node.get('uuid', '') or node_id)
        canonical = node_id or node_uuid
        if not canonical:
            continue
        uuid_to_id[node_uuid] = canonical
        uuid_to_id[canonical] = canonical
        node_ids.add(canonical)

    outgoing: Dict[str, List[str]] = {}
    indegree: Dict[str, int] = {node_id: 0 for node_id in node_ids}
    for edge in edges:
        src = uuid_to_id.get(str(edge.get('from', '') or ''), str(edge.get('from', '') or ''))
        dst = uuid_to_id.get(str(edge.get('to', '') or ''), str(edge.get('to', '') or ''))
        if not src or not dst:
            continue
        indegree.setdefault(src, 0)
        indegree.setdefault(dst, 0)
        outgoing.setdefault(src, []).append(dst)
        indegree[dst] = indegree.get(dst, 0) + 1

    queue = sorted(node_id for node_id, degree in indegree.items() if degree <= 0)
    ordered_nodes: List[str] = []
    visited: set[str] = set()
    while queue:
        node_id = queue.pop(0)
        if node_id in visited:
            continue
        visited.add(node_id)
        ordered_nodes.append(node_id)
        for next_node in sorted(outgoing.get(node_id, [])):
            indegree[next_node] = indegree.get(next_node, 0) - 1
            if indegree[next_node] <= 0 and next_node not in visited and next_node not in queue:
                queue.append(next_node)
        queue.sort()

    # Degrade deterministically if the graph contains a cycle or partial
    # node metadata. CF expects DAGs, but we still make the tie-break stable.
    ordered_nodes.extend(sorted(node_id for node_id in indegree if node_id not in visited))
    rank = {node_id: index for index, node_id in enumerate(ordered_nodes)}
    fallback_rank = len(rank) + 1

    def _subject_key(subject: Dict[str, Any]) -> Tuple[int, int, str, str, str]:
        from_id = str(subject.get('from_node', '') or '')
        to_id = str(subject.get('to_node', '') or '')
        target = subject.get('target') or {}
        edge_id = str(
            target.get('targetId')
            or subject.get('edge_uuid')
            or subject.get('subject_id')
            or ''
        )
        return (
            rank.get(from_id, fallback_rank),
            rank.get(to_id, fallback_rank),
            from_id,
            to_id,
            edge_id,
        )

    return sorted(subjects, key=_subject_key)


# Canonical implementation lives in model_resolver alongside resolve_model_params.
# Re-exported here so existing
# `from .forecast_runtime import read_edge_cohort_params` imports keep working
# (and so monkeypatch.setattr(forecast_runtime, 'read_edge_cohort_params', ...)
# in test_v2_v3_parity continues to redirect the local-namespace binding for
# all internal callers).
from .model_resolver import read_edge_cohort_params  # noqa: F401, E402


def edge_has_semantic_latency(edge: Dict[str, Any]) -> bool:
    """Return whether an edge contributes real timing structure."""
    p_obj = edge.get('p') or {}
    latency = p_obj.get('latency') or {}
    posterior = latency.get('posterior') or {}

    for value in (
        latency.get('promoted_sigma'),
        latency.get('sigma'),
        latency.get('promoted_path_sigma'),
        latency.get('path_sigma'),
        posterior.get('sigma_mean'),
        posterior.get('path_sigma_mean'),
        latency.get('promoted_onset_delta_days'),
        latency.get('onset_delta_days'),
        latency.get('path_onset_delta_days'),
        posterior.get('onset_delta_days'),
        posterior.get('path_onset_delta_days'),
    ):
        if isinstance(value, (int, float)) and value > 0:
            return True

    params = read_edge_cohort_params(edge)
    if params is None:
        return False
    return bool((params.get('sigma', 0.0) > 0) or (params.get('onset', 0.0) > 0))


def has_semantic_upstream_latency(
    graph: Dict[str, Any],
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
) -> bool:
    """Return whether the selected `A -> X` segment has timing structure."""
    if not anchor_node_id or not query_from_node:
        return False

    ref_to_id: Dict[str, str] = {}
    for node in graph.get('nodes', []):
        node_id = str(node.get('id') or node.get('uuid') or '')
        node_uuid = str(node.get('uuid') or node_id)
        if not node_id and not node_uuid:
            continue
        canonical = node_id or node_uuid
        ref_to_id[node_id] = canonical
        ref_to_id[node_uuid] = canonical

    anchor = ref_to_id.get(str(anchor_node_id), str(anchor_node_id))
    target = ref_to_id.get(str(query_from_node), str(query_from_node))
    if not anchor or not target or anchor == target:
        return False

    incoming_by_id: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
    for edge in graph.get('edges', []):
        src = ref_to_id.get(
            str(edge.get('from') or edge.get('from_node') or ''),
            str(edge.get('from') or edge.get('from_node') or ''),
        )
        dst = ref_to_id.get(
            str(edge.get('to') or edge.get('to_node') or ''),
            str(edge.get('to') or edge.get('to_node') or ''),
        )
        incoming_by_id.setdefault(dst, []).append((src, edge))

    cache: Dict[str, Tuple[bool, bool]] = {}

    def _state(node_id: str) -> Tuple[bool, bool]:
        if node_id in cache:
            return cache[node_id]
        if node_id == anchor:
            cache[node_id] = (True, False)
            return cache[node_id]

        reachable = False
        latent = False
        for src, edge in incoming_by_id.get(node_id, []):
            src_reachable, src_latent = _state(src)
            if not src_reachable:
                continue
            reachable = True
            if src_latent or edge_has_semantic_latency(edge):
                latent = True
        cache[node_id] = (reachable, latent)
        return cache[node_id]

    reachable, latent = _state(target)
    return reachable and latent


@dataclass
class XProvider:
    """Upstream arrival state for the cohort maturity row builder.

    Attributes:
        reach: scalar reach probability from anchor to x.
        upstream_params_list: per-edge upstream params for MC draws.
            Each dict has: p, mu, sigma, onset, and optionally
            mu_sd, sigma_sd, onset_sd, alpha, beta, p_sd.
        enabled: if False, the row builder treats this as "no upstream"
            (equivalent to window mode for the denominator). Stage 3
            redefined this to ``carrier.is_active`` from the new
            composition primitive — true when the carrier composes a
            valid A → X chain with positive reach (window short-circuit
            and A = X identity both leave it False). Latency presence
            on the upstream chain is no longer a precondition.
        ingress_carrier: path-level latency params from edges entering x.
        upstream_obs: observed arrivals at x from upstream evidence.
            Dict mapping anchor_day (str) to a list of (tau, x_obs) tuples.
        carrier_to_x: shared timing object for A → X. Populated when the
            carrier is active; ``None`` for window mode / A = X / no-path
            / horizon-inadequate cases. Downstream consumers prefer this
            when present because the legacy ``upstream_params_list`` only
            carries edges immediately incoming to X.
    """
    reach: float = 0.0
    upstream_params_list: List[Dict[str, float]] = field(default_factory=list)
    enabled: bool = False
    ingress_carrier: Optional[List[Dict[str, float]]] = None
    upstream_obs: Optional[Dict[str, List[Tuple[int, float]]]] = None
    carrier_to_x: Optional[Any] = None


def build_x_provider_from_graph(
    graph: Dict[str, Any],
    target_edge: Optional[Dict[str, Any]],
    anchor_node_id: Optional[str],
    is_window: bool,
    use_epistemic_mu_sd: bool = False,
) -> XProvider:
    """Build the runtime-owned x_provider from graph data.

    Routes through the shared timing algebra. The composer owns reach
    (sum over A → X paths), the conditional A → X CDF (saturating to
    1.0, Dirac-at-zero for non-latency chains), and horizon diagnostics.
    The ``enabled`` gate is the timing object's ``is_composed`` property:
    ``reach > 0`` and ``A != X``, independent of whether any upstream
    edge is latency-bearing. The legacy
    ``has_semantic_upstream_latency`` gate is retired here.

    Output preserves the existing ``XProvider`` shape for callers that
    still display immediate-ingress diagnostics, while ``carrier_to_x``
    exposes the canonical multi-hop composition.
    """
    from .timing_span import compose_timing_span_from_graph

    if is_window or target_edge is None:
        return XProvider(reach=0.0, upstream_params_list=[], enabled=False)

    from_node_id = get_edge_from_node(target_edge)
    if not from_node_id:
        return XProvider(reach=0.0, upstream_params_list=[], enabled=False)

    carrier = compose_timing_span_from_graph(
        graph=graph,
        root_node_id=str(anchor_node_id or ''),
        end_node_id=str(from_node_id),
        max_tau=400,
    )

    if _COHORT_DEBUG:
        print(
            f"[REACH] from_node={from_node_id} anchor={anchor_node_id} "
            f"reach={carrier.reach:.6f} tier={carrier.topology_case}"
        )

    # Diagnostic upstream_params_list: edges immediately incoming to X.
    # The composer's transitions cover the full A → X topology; this
    # flattened list is kept only for existing diagnostics/UI surfaces.
    upstream_params_list: List[Dict[str, float]] = []
    if carrier.is_composed and carrier.horizon_ratio >= 0.95:
        incoming = get_incoming_edges(graph, from_node_id)
        for inc_edge in incoming:
            params = read_edge_cohort_params(inc_edge)
            if params:
                params_local = dict(params)
                if use_epistemic_mu_sd:
                    latency_posterior = (
                        ((inc_edge.get('p') or {}).get('latency') or {}).get('posterior')
                        or {}
                    )
                    for mu_sd_key in ('path_mu_sd', 'mu_sd'):
                        mu_sd_value = latency_posterior.get(mu_sd_key)
                        if (
                            isinstance(mu_sd_value, (int, float))
                            and math.isfinite(mu_sd_value)
                            and mu_sd_value > 0
                        ):
                            params_local['mu_sd'] = float(mu_sd_value)
                            break
                upstream_params_list.append(params_local)

    return XProvider(
        reach=carrier.reach if carrier.is_composed else 0.0,
        upstream_params_list=upstream_params_list,
        enabled=carrier.is_composed,
        ingress_carrier=upstream_params_list if upstream_params_list else None,
        carrier_to_x=carrier if carrier.is_composed else None,
    )


# ═══════════════════════════════════════════════════════════════════════
# Span kernel → edge params adapter (ex span_adapter.py)
# ═══════════════════════════════════════════════════════════════════════


def span_kernel_to_edge_params(
    kernel,  # SpanKernel (avoid top-level import; resolved lazily by callers)
    graph: Dict[str, Any],
    target_edge_id: str,
    is_window: bool,
) -> Dict[str, float]:
    """Build an edge_params dict from a SpanKernel.

    For the single-edge case, this is equivalent to _read_edge_model_params.
    For multi-hop, it uses the kernel's span_p as the forecast rate and
    the last edge's posterior SDs for MC uncertainty.
    """
    edges = graph.get('edges', [])
    target_edge = None
    for e in edges:
        if str(e.get('uuid', e.get('id', ''))) == str(target_edge_id):
            target_edge = e
            break

    params: Dict[str, Any] = {}

    span_p = kernel.span_p

    if target_edge:
        p_data = target_edge.get('p', {})
        latency = p_data.get('latency', {})
        posterior = latency.get('posterior', {})
        prob_posterior = p_data.get('posterior', {})

        mu = posterior.get('mu_mean') or latency.get('mu') or 0.0
        sigma = posterior.get('sigma_mean') or latency.get('sigma') or 0.0
        onset = (posterior.get('onset_delta_days')
                 or latency.get('promoted_onset_delta_days')
                 or latency.get('onset_delta_days') or 0.0)

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

        params['forecast_mean'] = span_p
        params['posterior_p'] = span_p
        params['posterior_p_cohort'] = span_p

        post_alpha = prob_posterior.get('alpha')
        post_beta = prob_posterior.get('beta')
        post_alpha_pred = prob_posterior.get('alpha_pred')
        post_beta_pred = prob_posterior.get('beta_pred')
        cohort_alpha = prob_posterior.get('cohort_alpha')
        cohort_beta = prob_posterior.get('cohort_beta')
        cohort_alpha_pred = prob_posterior.get('cohort_alpha_pred')
        cohort_beta_pred = prob_posterior.get('cohort_beta_pred')

        # Doc 49 / EPISTEMIC_DISPERSION_DESIGN.md §6: prefer kappa-inflated
        # predictive Beta over epistemic for the IS proposal width. When no
        # predictive is fitted on either source, fall back to epistemic.
        # When neither source provides anything, the κ=20 default is the
        # last-resort weak-prior backstop.
        if (isinstance(cohort_alpha_pred, (int, float)) and isinstance(cohort_beta_pred, (int, float))
                and cohort_alpha_pred > 0 and cohort_beta_pred > 0):
            kappa = float(cohort_alpha_pred) + float(cohort_beta_pred)
        elif (isinstance(post_alpha_pred, (int, float)) and isinstance(post_beta_pred, (int, float))
                and post_alpha_pred > 0 and post_beta_pred > 0):
            kappa = float(post_alpha_pred) + float(post_beta_pred)
        elif (isinstance(cohort_alpha, (int, float)) and isinstance(cohort_beta, (int, float))
                and cohort_alpha > 0 and cohort_beta > 0):
            kappa = float(cohort_alpha) + float(cohort_beta)
        elif (isinstance(post_alpha, (int, float)) and isinstance(post_beta, (int, float))
                and post_alpha > 0 and post_beta > 0):
            kappa = float(post_alpha) + float(post_beta)
        else:
            # Try analytic source's model_vars predictive Beta from the
            # Pearson chi-squared overdispersion estimator (FE topo).
            kappa = None
            for _mv in p_data.get('model_vars', []):
                if _mv.get('source') != 'analytic':
                    continue
                _mv_prob = _mv.get('probability', {})
                _ap = _mv_prob.get('alpha_pred')
                _bp = _mv_prob.get('beta_pred')
                if (isinstance(_ap, (int, float)) and isinstance(_bp, (int, float))
                        and _ap > 0 and _bp > 0):
                    kappa = float(_ap) + float(_bp)
                    break
                _ae = _mv_prob.get('alpha')
                _be = _mv_prob.get('beta')
                if (isinstance(_ae, (int, float)) and isinstance(_be, (int, float))
                        and _ae > 0 and _be > 0):
                    kappa = float(_ae) + float(_be)
                    break
            if kappa is None:
                kappa = 20.0  # weak default backstop

        params['posterior_alpha'] = span_p * kappa
        params['posterior_beta'] = (1.0 - span_p) * kappa
        params['posterior_cohort_alpha'] = span_p * kappa
        params['posterior_cohort_beta'] = (1.0 - span_p) * kappa

        span_alpha = span_p * kappa
        span_beta = (1.0 - span_p) * kappa
        if span_alpha > 0 and span_beta > 0:
            s = span_alpha + span_beta
            p_sd = math.sqrt(span_alpha * span_beta / (s * s * (s + 1)))
            params['p_stdev'] = p_sd
            params['p_stdev_cohort'] = p_sd

        _winning_mv_lat = {}
        for _mv in p_data.get('model_vars', []):
            if _mv.get('source') == 'bayesian':
                _winning_mv_lat = _mv.get('latency', {})
                break
        # Doc 61: bare mu_sd is epistemic; bayes_mu_sd_pred is predictive.
        # Forecast consumers read the _pred variant; reporting/overlay
        # consumers read the bare variant.
        _sd_map = {
            'bayes_mu_sd':              ('promoted_mu_sd',              'mu_sd'),           # epistemic
            'bayes_mu_sd_pred':         ('promoted_mu_sd_pred',         'mu_sd_pred'),      # predictive (kappa_lat)
            'bayes_sigma_sd':           ('promoted_sigma_sd',           'sigma_sd'),
            'bayes_onset_sd':           ('promoted_onset_sd',           'onset_sd'),
            'bayes_onset_mu_corr':      ('promoted_onset_mu_corr',      'onset_mu_corr'),
            'bayes_path_mu_sd':         ('promoted_path_mu_sd',         'path_mu_sd'),      # epistemic
            'bayes_path_mu_sd_pred':    ('promoted_path_mu_sd_pred',    'path_mu_sd_pred'),
            'bayes_path_sigma_sd':      ('promoted_path_sigma_sd',      'path_sigma_sd'),
            'bayes_path_onset_sd':      ('promoted_path_onset_sd',      'path_onset_sd'),
            'bayes_path_onset_mu_corr': ('promoted_path_onset_mu_corr', 'path_onset_mu_corr'),
        }
        for param_key, (promoted_key, posterior_key) in _sd_map.items():
            val = (latency.get(promoted_key)
                   or posterior.get(posterior_key)
                   or _winning_mv_lat.get(posterior_key))
            if isinstance(val, (int, float)):
                params[param_key] = float(val)

        t95 = latency.get('promoted_t95') or latency.get('t95')
        path_t95 = latency.get('promoted_path_t95') or latency.get('path_t95')
        if isinstance(t95, (int, float)) and t95 > 0:
            params['t95'] = float(t95)
        if isinstance(path_t95, (int, float)) and path_t95 > 0:
            params['path_t95'] = float(path_t95)

        evidence = p_data.get('evidence', {})
        ev_retrieved = evidence.get('retrieved_at')
        if isinstance(ev_retrieved, str) and ev_retrieved:
            params['evidence_retrieved_at'] = ev_retrieved

    return params


# ═══════════════════════════════════════════════════════════════════════
# Span prior (ex v2 — cohort_forecast_v2.py)
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class SpanParams:
    """Resolved span parameters for the v2 row builder.

    All quantities are in x→y coordinates, not anchor→y.
    """
    span_p: float               # K(∞) — asymptotic conversion probability x→y
    C: List[float]              # normalised completeness C(τ) = K(τ)/span_p
    max_tau: int
    # Prior for IS conditioning
    alpha_0: float              # Beta prior α centred on span_p
    beta_0: float               # Beta prior β
    # Posterior SDs for MC drift (from last edge)
    mu_sd: float
    sigma_sd: float
    onset_sd: float
    onset_mu_corr: float
    # Point-estimate latency (for deterministic fallback)
    mu: float
    sigma: float
    onset: float


def build_span_params(
    kernel_cdf: Callable[[float], float],
    span_p: float,
    max_tau: int,
    edge_params: Dict[str, Any],
    is_window: bool,
) -> SpanParams:
    """Build SpanParams from a span kernel and edge_params.

    The kernel_cdf should already be normalised: K(τ)/span_p.
    edge_params provides posterior SDs and alpha/beta for the prior.
    """
    C = [0.0] * (max_tau + 1)
    for t in range(max_tau + 1):
        C[t] = min(max(kernel_cdf(float(t)), 0.0), 1.0)

    alpha_0 = 0.0
    beta_0 = 0.0
    if not is_window:
        _raw_a = edge_params.get('posterior_cohort_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_cohort_beta', 0.0) or 0.0
    else:
        _raw_a = edge_params.get('posterior_alpha', 0.0) or 0.0
        _raw_b = edge_params.get('posterior_beta', 0.0) or 0.0
    if _raw_a > 0 and _raw_b > 0:
        kappa = _raw_a + _raw_b
        alpha_0 = span_p * kappa
        beta_0 = (1.0 - span_p) * kappa
    if alpha_0 <= 0 or beta_0 <= 0:
        _KAPPA_DEFAULT = 20.0
        alpha_0 = span_p * _KAPPA_DEFAULT
        beta_0 = (1.0 - span_p) * _KAPPA_DEFAULT

    # Doc 61: this is a forecasting consumer (span prior + carrier MC),
    # so it reads the predictive mu_sd. Fallback to the bare (epistemic)
    # name when `_pred` is absent — covers pre-migration graphs where
    # kappa_lat was not fitted (epistemic == predictive in that case).
    mu_sd = (edge_params.get('bayes_mu_sd_pred')
             or edge_params.get('bayes_path_mu_sd_pred')
             or edge_params.get('bayes_mu_sd')
             or edge_params.get('bayes_path_mu_sd')
             or 0.0)
    sigma_sd = edge_params.get('bayes_sigma_sd', edge_params.get('bayes_path_sigma_sd', 0.0)) or 0.0
    onset_sd = edge_params.get('bayes_onset_sd', edge_params.get('bayes_path_onset_sd', 0.0)) or 0.0
    onset_mu_corr = edge_params.get('bayes_onset_mu_corr', edge_params.get('bayes_path_onset_mu_corr', 0.0)) or 0.0

    mu = edge_params.get('mu', 0.0)
    sigma = edge_params.get('sigma', 0.0)
    onset = edge_params.get('onset_delta_days', 0.0)

    return SpanParams(
        span_p=span_p, C=C, max_tau=max_tau,
        alpha_0=alpha_0, beta_0=beta_0,
        mu_sd=mu_sd, sigma_sd=sigma_sd,
        onset_sd=onset_sd, onset_mu_corr=onset_mu_corr,
        mu=mu, sigma=sigma, onset=onset,
    )


@dataclass
class PreparedForecastSolveInputs:
    """Shared prepared solve inputs for chart and CF callers."""
    subject_temporal_mode: str = 'window'
    is_multi_hop: bool = False
    anchor_relative_subject_cdf: bool = False
    span_x_node_id: Optional[str] = None
    edge_kernel: Optional[Any] = None
    det_norm_cdf: Optional[List[float]] = None
    det_span_p: Optional[float] = None
    span_alpha: Optional[float] = None
    span_beta: Optional[float] = None
    span_params: Optional[SpanParams] = None
    span_params_epi: Optional[SpanParams] = None
    mc_cdf_arr: Optional[Any] = None
    mc_p_s: Optional[Any] = None
    mc_cdf_arr_epi: Optional[Any] = None
    mc_p_s_epi: Optional[Any] = None
    edge_cdf_arr: Optional[Any] = None
    x_provider: Optional[XProvider] = None
    x_provider_overlay: Optional[XProvider] = None
    resolved_override: Optional[Any] = None
    runtime_bundle: Optional[PreparedForecastRuntimeBundle] = None


def _resolve_subject_temporal_mode(
    *,
    is_window: bool,
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
) -> str:
    """Choose the rate-family used by the prepared subject solve.

    This does not retarget the subject span away from `X -> end`; it only
    selects which posterior family resolves the edge/span probability inputs.
    Cohort queries with `A != X` should read the cohort-family rate surface,
    while `window()` and the `A = X` identity case remain window-rooted.
    """
    if is_window:
        return 'window'
    if anchor_node_id and query_from_node and anchor_node_id != query_from_node:
        return 'cohort'
    return 'window'


def parse_asat_from_dsl(dsl: Optional[str]) -> Optional[str]:
    """Extract the ISO date from an `asat(...)` or `at(...)` DSL clause.

    Returns None when the DSL is empty or has no asat clause; returns
    None for unparseable date tokens. Mirrors the parse used inside
    `api_handlers.handle_conditioned_forecast` so both surfaces produce
    the same as-at boundary.
    """
    if not dsl:
        return None
    import re as _re

    match = _re.search(r"(?:asat|at)\(([^)]*)\)", str(dsl))
    if not match or not match.group(1).strip():
        return None
    raw = match.group(1).strip()
    try:
        from analysis_subject_resolution import _resolve_date
        resolved = _resolve_date(raw)
    except Exception:
        return None
    return resolved or None


def _resolve_evidence_role(
    *,
    is_window: bool,
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
    is_multi_hop: bool,
    direct_cohort_enabled: bool = False,
):
    """Single decision point for the typed-merge `EvidenceRole`.

    Pre-WP8 (`direct_cohort_enabled=False`) every CF subject reads file
    evidence under `WINDOW_SUBJECT_HELPER` — direct-cohort rate evidence
    is reserved per 73h §`direct_cohort_exact_subject` and doc 60 §A.2,
    which require an explicit flag/admission-policy decision before
    `DIRECT_COHORT_EXACT_SUBJECT` can be selected.

    Post-WP8 the same helper flips to `DIRECT_COHORT_EXACT_SUBJECT` for
    exact single-hop cohort subjects with `A != X`. The runtime bundle's
    `p_conditioning_source` and the typed merge's `EvidenceRole` MUST
    stay in lockstep — they are one decision, not two forks.
    """
    from evidence_merge import EvidenceRole

    if (
        direct_cohort_enabled
        and not is_window
        and not is_multi_hop
        and anchor_node_id
        and query_from_node
        and anchor_node_id != query_from_node
    ):
        return EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT
    return EvidenceRole.WINDOW_SUBJECT_HELPER


def prepare_forecast_runtime_inputs(
    *,
    graph_data: Dict[str, Any],
    query_from_node: Optional[str],
    query_to_node: Optional[str],
    anchor_node_id: Optional[str],
    last_edge_id: Optional[str],
    is_window: bool,
    is_multi_hop: bool,
    composed_frames: List[Dict[str, Any]],
    path_per_edge_results: Optional[List[Dict[str, Any]]] = None,
    upstream_per_edge_results: Optional[List[Dict[str, Any]]] = None,
    axis_tau_max: Optional[int] = None,
    upstream_anchor_from: Optional[str] = None,
    upstream_anchor_to: Optional[str] = None,
    upstream_sweep_from: Optional[str] = None,
    upstream_sweep_to: Optional[str] = None,
    candidate_regimes_by_edge: Optional[Dict[str, Any]] = None,
    upstream_observation_fetcher: Optional[Callable[..., Any]] = None,
    upstream_log_prefix: str = '[forecast] upstream:',
    p_conditioning_source: str = 'snapshot_frames',
    p_conditioning_evidence_points: Optional[int] = None,
    # Retired post-73n: the epistemic-overlay second MC pass has been
    # superseded by the runtime's ``unconditioned_overlays['epistemic']``
    # composition. Kept as a no-op kwarg so existing callers still load
    # without raising; consumers that pass True simply get a (now
    # ignored) flag. Will be removed once all callers stop passing it.
    include_epistemic_overlay: bool = False,
    as_at: Optional[str] = None,
    scenario_id: Optional[str] = None,
    direct_cohort_enabled: bool = False,
) -> PreparedForecastSolveInputs:
    """Build the shared prepared runtime inputs for one forecast subject.

    `as_at` is the optional ISO date the merge enforces against raw
    file `retrieved_at`. FE-asat-tier-1 reconstructed entries
    (marked `_asat_retrieved_at`) bypass this check via the merge's
    `asat_materialised` mechanism; raw file entries do not. `scenario_id`
    is carried into `EvidenceScope` so multi-scenario CF requests do not
    accidentally share E. `direct_cohort_enabled` is the WP8 admission
    flag — when False (current default), the typed-merge role is forced
    to `WINDOW_SUBJECT_HELPER` regardless of the resolved temporal mode.
    """
    from runner.model_resolver import resolve_model_params
    from runner.span_kernel import compose_span_kernel, mc_span_cdfs
    result = PreparedForecastSolveInputs(
        is_multi_hop=is_multi_hop,
    )

    if not (composed_frames and last_edge_id and query_from_node and query_to_node):
        return result

    graph_preference = graph_data.get('model_source_preference')
    result.subject_temporal_mode = _resolve_subject_temporal_mode(
        is_window=is_window,
        anchor_node_id=anchor_node_id,
        query_from_node=query_from_node,
    )
    result.anchor_relative_subject_cdf = should_use_anchor_relative_subject_cdf(
        is_window=is_window,
        is_multi_hop=is_multi_hop,
        anchor_node_id=anchor_node_id,
        query_from_node=query_from_node,
    )
    result.span_x_node_id = resolve_subject_cdf_start_node(
        is_window=is_window,
        is_multi_hop=is_multi_hop,
        anchor_node_id=anchor_node_id,
        query_from_node=query_from_node,
    )

    edge_execution = build_prepared_span_execution(
        graph_data,
        query_from_node,
        query_to_node,
        temporal_mode=result.subject_temporal_mode,
        graph_preference=graph_preference,
    )
    if edge_execution is not None:
        result.edge_kernel = compose_span_kernel(
            topo=edge_execution.topo,
            edge_params=edge_execution.edge_params,
            max_tau=400,
        )

    kernel = result.edge_kernel
    if kernel is not None and kernel.span_p > 0:
        result.det_span_p = float(kernel.span_p)
        result.det_norm_cdf = [
            min(max(kernel.cdf_at(t) / kernel.span_p, 0.0), 1.0)
            for t in range(401)
        ]
        span_edge_params = span_kernel_to_edge_params(
            kernel,
            graph_data,
            last_edge_id,
            is_window=is_window,
        )

        def _norm_cdf(tau: float) -> float:
            return kernel.cdf_at(int(round(tau))) / kernel.span_p

        result.span_params = build_span_params(
            _norm_cdf,
            kernel.span_p,
            400,
            span_edge_params,
            is_window=is_window,
        )
        result.span_alpha = result.span_params.alpha_0
        result.span_beta = result.span_params.beta_0

        # Epistemic-overlay span_params clone retired post-73n —
        # ResolvedCFRuntime.unconditioned_overlays['epistemic'] now owns
        # the tight-band model curve. The flag is preserved as a no-op
        # for caller compatibility but produces no parallel SpanParams.

    span_execution = build_prepared_span_execution(
        graph_data,
        result.span_x_node_id,
        query_to_node,
        temporal_mode=result.subject_temporal_mode,
        graph_preference=graph_preference,
    )
    if span_execution is not None:
        import numpy as np
        # Fixed-seed retirement: all five mc_span_cdfs RNG seeds in
        # this function are keyed off the request scope rather than the
        # legacy ``seed=42`` constant. Each derivation gets an
        # independent stream so downstream consumers can recover either
        # side without rebuilding the other.
        from .primitives import (
            DrawFamilyKey as _DFK,
            PrimitiveScope as _PS,
            TransitionIdentity as _TI,
            current_mc_draws as _current_mc_draws,
            make_rng as _make_rng,
        )
        _S = _current_mc_draws()

        def _request_scoped_key(_label: str) -> _DFK:
            # Atom 2 v2: scenario_id is a caller-context label, not part
            # of the conditioned posterior's mathematical identity. Do
            # NOT bake it into the synthetic edge_id — DrawFamilyKey's
            # canonical_string includes edge_id, so leaking scenario_id
            # via that field would re-introduce the divergence the v2
            # serialisation was designed to eliminate. Two requests with
            # the same math but different scenario labels must seed the
            # same RNG. The (src, dst, label) triple is sufficient for
            # request-scoped derivations.
            _ti = _TI(
                source_node=str(result.span_x_node_id or ''),
                destination_node=str(query_to_node or ''),
                edge_id=f'__request_scoped::{_label}',
            )
            _scope = _PS(
                scenario_id='',
                evidence_role='WINDOW_SUBJECT_HELPER',
                date_from=str(upstream_anchor_from or ''),
                date_to=str(upstream_sweep_to or ''),
                as_at=as_at,
                context_key=None,
                regime_key=None,
                model_source_preference='best_available',
                resolved_source_identity=None,
                selected_anchor_days=(),
            )
            return _DFK(
                transition_identity=_ti,
                scope=_scope,
                draw_count=_S,
                scenario_seed=0,
            )

        rng = _make_rng(_request_scoped_key('subject_span_full_path_mc'),
                        'subject_span_full_path_mc')
        result.mc_cdf_arr, result.mc_p_s = mc_span_cdfs(
            topo=span_execution.topo,
            edge_params=span_execution.edge_params,
            edge_sds=span_execution.edge_sds_pred,
            max_tau=400,
            num_draws=_S,
            rng=rng,
        )
        # Epistemic-overlay second MC pass retired post-73n.
        # ResolvedCFRuntime.unconditioned_overlays['epistemic'] owns the
        # tight-band model curve.
        if result.anchor_relative_subject_cdf:
            edge_execution_p = build_prepared_span_execution(
                graph_data,
                query_from_node,
                query_to_node,
                temporal_mode=result.subject_temporal_mode,
                graph_preference=graph_preference,
            )
            if edge_execution_p is not None:
                rng_edge = _make_rng(
                    _request_scoped_key('anchor_relative_edge_p_mc'),
                    'anchor_relative_edge_p_mc',
                )
                _, result.mc_p_s = mc_span_cdfs(
                    topo=edge_execution_p.topo,
                    edge_params=edge_execution_p.edge_params,
                    edge_sds=edge_execution_p.edge_sds_pred,
                    max_tau=400,
                    num_draws=_S,
                    rng=rng_edge,
                )
                # Epistemic anchor-relative second MC pass retired
                # post-73n. unconditioned_overlays['epistemic'] owns it.
                if False:
                    rng_edge_epi = _make_rng(
                        _request_scoped_key('anchor_relative_edge_epistemic'),
                        'anchor_relative_edge_epistemic',
                    )
                    _, result.mc_p_s_epi = mc_span_cdfs(
                        topo=edge_execution_p.topo,
                        edge_params=edge_execution_p.edge_params,
                        edge_sds=edge_execution_p.edge_sds,
                        max_tau=400,
                        num_draws=_S,
                        rng=rng_edge_epi,
                    )

    edge_results = path_per_edge_results or []
    if (
        is_multi_hop
        and result.edge_cdf_arr is None
        and result.mc_cdf_arr is not None
    ):
        last_entry = next(
            (entry for entry in edge_results if entry.get('path_role') in ('last', 'only')),
            None,
        )
        if last_entry is not None:
            import numpy as np

            last_execution = build_prepared_span_execution(
                graph_data,
                last_entry.get('from_node', ''),
                last_entry.get('to_node', ''),
                temporal_mode='window',
                graph_preference=graph_preference,
            )
            if last_execution is not None:
                # Last-edge frontier CDF RNG also keyed off the request
                # scope (fixed-seed retirement).
                from .primitives import (
                    DrawFamilyKey as _DFK2,
                    PrimitiveScope as _PS2,
                    TransitionIdentity as _TI2,
                    current_mc_draws as _current_mc_draws2,
                    make_rng as _make_rng2,
                )
                _S2 = _current_mc_draws2()
                # Atom 2 v2: same as above — keep scenario_id out of
                # both the synthetic edge_id and the scope.scenario_id so
                # canonical_string is independent of caller-context labels.
                _ti = _TI2(
                    source_node=str(last_entry.get('from_node', '')),
                    destination_node=str(last_entry.get('to_node', '')),
                    edge_id='__request_scoped::last_edge_frontier_cdf',
                )
                _scope = _PS2(
                    scenario_id='',
                    evidence_role='WINDOW_SUBJECT_HELPER',
                    date_from=str(upstream_anchor_from or ''),
                    date_to=str(upstream_sweep_to or ''),
                    as_at=as_at,
                    context_key=None,
                    regime_key=None,
                    model_source_preference='best_available',
                    resolved_source_identity=None,
                    selected_anchor_days=(),
                )
                rng_last = _make_rng2(
                    _DFK2(
                        transition_identity=_ti,
                        scope=_scope,
                        draw_count=_S2,
                        scenario_seed=0,
                    ),
                    'last_edge_frontier_cdf',
                )
                result.edge_cdf_arr, _ = mc_span_cdfs(
                    topo=last_execution.topo,
                    edge_params=last_execution.edge_params,
                    edge_sds=last_execution.edge_sds_pred,
                    max_tau=400,
                    num_draws=_S2,
                    rng=rng_last,
                )

    def _build_runtime_x_provider(*, use_epistemic_mu_sd: bool) -> Optional[XProvider]:
        if (
            is_window
            or not query_from_node
            or not anchor_node_id
            or query_from_node == anchor_node_id
        ):
            return None

        target_edge = find_edge_by_id(graph_data, last_edge_id)
        if target_edge is None:
            return None

        provider = build_x_provider_from_graph(
            graph_data,
            target_edge,
            anchor_node_id,
            is_window,
            use_epistemic_mu_sd=use_epistemic_mu_sd,
        )
        upstream_obs = None
        if (
            provider.enabled
            and upstream_observation_fetcher is not None
            and upstream_anchor_from
            and upstream_anchor_to
        ):
            upstream_obs = upstream_observation_fetcher(
                graph_data=graph_data,
                anchor_node=anchor_node_id,
                query_from_node=query_from_node,
                per_edge_results=upstream_per_edge_results or edge_results,
                candidate_regimes_by_edge=candidate_regimes_by_edge or {},
                anchor_from=upstream_anchor_from,
                anchor_to=upstream_anchor_to,
                sweep_from=upstream_sweep_from or upstream_anchor_from,
                sweep_to=upstream_sweep_to or upstream_anchor_to,
                axis_tau_max=axis_tau_max,
                log_prefix=upstream_log_prefix,
            )

        provider.upstream_obs = upstream_obs
        return provider

    result.x_provider = _build_runtime_x_provider(use_epistemic_mu_sd=False)
    # x_provider_overlay retired post-73n — the runtime's
    # unconditioned_overlays['epistemic'] carrier composition owns the
    # tight-band carrier surface for active cohort.

    # 73h Stage 3 + reviewer-H1: resolve the typed-merge evidence role
    # once, before either the merge or the runtime-bundle build. Both
    # sites must agree on what family of E is admitted — pre-WP8 every
    # CF subject (window or cohort) reads E under WINDOW_SUBJECT_HELPER,
    # so a cohort query that pairs with `subject_temporal_mode='cohort'`
    # still has window-family conditioning. The bundle's
    # `p_conditioning_temporal_family` must reflect the merge's role
    # family, not the query's temporal mode, otherwise diagnostics
    # report "cohort" while the merge admitted window-helper E.
    from evidence_merge import _role_family
    evidence_role = _resolve_evidence_role(
        is_window=is_window,
        anchor_node_id=anchor_node_id,
        query_from_node=query_from_node,
        is_multi_hop=is_multi_hop,
        direct_cohort_enabled=direct_cohort_enabled,
    )
    _conditioning_role_family = _role_family(evidence_role)
    # Map SliceFamily → bundle's temporal-family string convention.
    from evidence_merge import SliceFamily as _SF
    conditioning_temporal_family = (
        'cohort' if _conditioning_role_family == _SF.COHORT else 'window'
    )

    target_edge = find_edge_by_id(graph_data, last_edge_id)
    if target_edge is not None:
        result.resolved_override = resolve_model_params(
            target_edge,
            scope='edge',
            temporal_mode=result.subject_temporal_mode,
            graph_preference=graph_preference,
        )

        # Evidence is supplied downstream exclusively through the
        # evidence-superset interface and translated into request-pool
        # candidates by the row/runtime caller. This preparation layer
        # resolves model/span metadata only; it does not build target-edge
        # candidates, merge an EvidenceSet, or read graph-side evidence.

    result.runtime_bundle = build_prepared_runtime_bundle(
        mode='window' if is_window else 'cohort',
        query_from_node=query_from_node,
        query_to_node=query_to_node,
        anchor_node_id=anchor_node_id,
        is_multi_hop=is_multi_hop,
        x_provider=result.x_provider,
        numerator_representation='factorised',
        # Reviewer-H1: temporal family is derived from the resolved
        # evidence_role, not from `subject_temporal_mode`. They differ
        # pre-WP8 for cohort queries (mode=cohort, role=window-helper).
        p_conditioning_temporal_family=conditioning_temporal_family,
        p_conditioning_source=p_conditioning_source,
        p_conditioning_evidence_points=(
            len(composed_frames)
            if p_conditioning_evidence_points is None
            else p_conditioning_evidence_points
        ),
        resolved_params=result.resolved_override,
        mc_cdf_arr=result.mc_cdf_arr,
        mc_p_s=result.mc_p_s,
        det_norm_cdf=result.det_norm_cdf,
        edge_cdf_arr=None,
        span_alpha=result.span_alpha,
        span_beta=result.span_beta,
        span_mu_sd=result.span_params.mu_sd if result.span_params else None,
        span_sigma_sd=result.span_params.sigma_sd if result.span_params else None,
        span_onset_sd=result.span_params.onset_sd if result.span_params else None,
        span_onset_mu_corr=(
            result.span_params.onset_mu_corr if result.span_params else None
        ),
    )
    return result
