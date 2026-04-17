"""
cohort_forecast_v3 — thin consumer of the generalised forecast engine.

Doc 29 Phase 5: calls compute_forecast_sweep for the per-cohort
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
from datetime import date as _date
from typing import Any, Dict, List, Optional


# ═══════════════════════════════════════════════════════════════════════
# Shared evidence builder — used by both v3 chart and topo pass p.mean
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class FrameEvidence:
    """Intermediate evidence extracted from derived maturity frames.

    Produced by build_cohort_evidence_from_frames() and consumed by
    both the v3 chart builder (compute_cohort_maturity_rows_v3) and
    the topo pass forecast sweep (handle_stats_topo_pass Phase 2).

    Design invariant: both consumers call compute_forecast_sweep with
    the SAME engine_cohorts built from the SAME snapshot DB evidence,
    so p@∞ from v3 == p.mean from the topo pass.
    """
    engine_cohorts: list           # List[CohortEvidence]
    cohort_list: List[Dict]        # sorted cohort_info dicts
    cohort_at_tau: Dict            # per-cohort tau observations
    evidence_by_tau: Dict          # aggregate evidence at each tau
    max_tau: int
    tau_solid_max: int
    tau_future_max: int
    last_frame_date: Optional[_date] = None


def build_cohort_evidence_from_frames(
    frames: List[Dict[str, Any]],
    target_edge: Dict[str, Any],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool,
    resolved: Any,
    axis_tau_max: Optional[int] = None,
) -> Optional[FrameEvidence]:
    """Build CohortEvidence from derived maturity frames.

    Shared between the v3 chart builder and the topo pass forecast
    sweep. Encapsulates: last-frame extraction, cohort_info, per-tau
    observation building, tau range computation, and CohortEvidence
    construction.

    Returns None if no usable evidence is found.
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
        return None

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

    # Aggregate evidence_by_tau from cohort_at_tau (deduplicated)
    evidence_by_tau: Dict[int, Dict] = {}
    for ad_str, tau_data in cohort_at_tau.items():
        for tau, (x, y) in tau_data.items():
            if tau not in evidence_by_tau:
                evidence_by_tau[tau] = {'sum_y': 0.0, 'sum_x': 0.0, 'n_cohorts': 0}
            evidence_by_tau[tau]['sum_y'] += y
            evidence_by_tau[tau]['sum_x'] += x
            evidence_by_tau[tau]['n_cohorts'] += 1

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

    # ── Determine tau range ────────────────────────────────────────
    max_tau = tau_future_max
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(0.95, lat.mu, lat.sigma) + lat.onset_delta_days
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass
    _max_t95 = 0.0
    _lat_block = target_edge.get('p', {}).get('latency', {})
    for _t95_key in ('promoted_path_t95', 'path_t95', 'promoted_t95', 't95'):
        _t95_v = _lat_block.get(_t95_key)
        if isinstance(_t95_v, (int, float)) and _t95_v > 0:
            _max_t95 = max(_max_t95, float(_t95_v))
    if _max_t95 > 0:
        max_tau = max(max_tau, int(math.ceil(_max_t95 * 2)))
    max_tau = max(max_tau, 100)
    max_tau = min(max_tau, 400)

    # ── Build CohortEvidence per cohort ────────────────────────────
    engine_cohorts: list = []
    for ci in cohort_list:
        N_i = ci['x_frozen']
        a_i = ci.get('tau_observed', ci['tau_max'])
        a_pop = ci.get('a_frozen', N_i) or N_i or 1.0
        ad_str = ci['anchor_day'].isoformat()
        tau_data = cohort_at_tau.get(ad_str, {})

        obs_x = [0.0] * (max_tau + 1)
        obs_y = [0.0] * (max_tau + 1)
        last_x = float(N_i) if is_window else 0.0
        last_y = 0.0
        for t in range(max_tau + 1):
            if t <= a_i:
                obs = tau_data.get(t)
                if obs:
                    last_x = obs[0]
                    last_y = obs[1]
                elif is_window:
                    last_x = float(N_i)
                obs_x[t] = last_x
                obs_y[t] = last_y
            else:
                obs_x[t] = last_x if last_x > 0 else float(N_i)
                obs_y[t] = last_y

        engine_cohorts.append(CohortEvidence(
            obs_x=obs_x,
            obs_y=obs_y,
            x_frozen=N_i,
            y_frozen=ci['y_frozen'],
            frontier_age=a_i,
            a_pop=a_pop,
        ))

    if not engine_cohorts:
        return None

    return FrameEvidence(
        engine_cohorts=engine_cohorts,
        cohort_list=cohort_list,
        cohort_at_tau=dict(cohort_at_tau),
        evidence_by_tau=evidence_by_tau,
        max_tau=max_tau,
        tau_solid_max=tau_solid_max,
        tau_future_max=tau_future_max,
        last_frame_date=last_frame_date,
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
) -> List[Dict[str, Any]]:
    """Compute per-τ rows for cohort maturity v3 chart.

    Same row schema as v2 so the FE chart builder works unchanged.
    Delegates the per-cohort population model to the engine via
    compute_forecast_sweep.
    """
    from .forecast_state import (
        compute_forecast_sweep,
        CohortEvidence,
        NodeArrivalState,
    )
    from .model_resolver import resolve_model_params
    from .cohort_forecast import find_edge_by_id, XProvider, build_x_provider_from_graph
    from .cohort_forecast_v2 import build_upstream_carrier

    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    # ── Resolve model params ────────────────────────────────────────
    # Default: edge-level. When resolved_override is provided (e.g.
    # collapsed shortcut with path latency + edge p), use it directly.
    if resolved_override is not None:
        resolved = resolved_override
    else:
        temporal = 'window' if is_window else 'cohort'
        resolved = resolve_model_params(target_edge, scope='edge', temporal_mode=temporal)
    if not resolved or resolved.latency.sigma <= 0:
        return []

    lat = resolved.latency

    # ── Build x_provider for upstream params (cohort mode) ──────────
    # Prefer handler-constructed override (v2 parity), fall back to
    # graph-derived provider.
    x_provider = x_provider_override
    if x_provider is None and not is_window and anchor_node_id:
        try:
            x_provider = build_x_provider_from_graph(
                graph, target_edge, anchor_node_id, is_window,
            )
        except Exception as e:
            print(f"[v3] WARNING: x_provider build failed: {e}")

    # ── Build evidence from frames (shared with topo pass) ─────────
    fe = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge=target_edge,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        resolved=resolved,
        axis_tau_max=axis_tau_max,
    )
    if fe is None:
        return []

    engine_cohorts = fe.engine_cohorts
    cohort_list = fe.cohort_list
    cohort_at_tau = fe.cohort_at_tau
    evidence_by_tau = fe.evidence_by_tau
    max_tau = fe.max_tau
    tau_solid_max = fe.tau_solid_max
    tau_future_max = fe.tau_future_max
    last_frame_date = fe.last_frame_date

    # ── Build upstream carrier (deferred — v2 lines 656-669) ────────
    # Now that cohort_list is populated, Tier 2 can classify donors.
    from_node_arrival = None
    upstream_path_cdf_arr = None
    _carrier_tier = 'none'
    if x_provider is not None and x_provider.reach > 0:
        upstream_params_list = (
            x_provider.ingress_carrier
            if x_provider.ingress_carrier
            else x_provider.upstream_params_list
        )
        _carrier_rng = np.random.default_rng(43)
        det_cdf, mc_cdf, _carrier_tier = build_upstream_carrier(
            upstream_params_list=upstream_params_list,
            upstream_obs=x_provider.upstream_obs,
            cohort_list=cohort_list,
            reach=x_provider.reach,
            is_window=is_window,
            max_tau=max_tau,
            num_draws=2000,
            rng=_carrier_rng,
        )
        upstream_path_cdf_arr = det_cdf
        if det_cdf is not None or mc_cdf is not None:
            from_node_arrival = NodeArrivalState(
                deterministic_cdf=det_cdf,
                mc_cdf=mc_cdf,
                reach=x_provider.reach,
                tier=_carrier_tier,
            )
    print(f"[v3] carrier: tier={_carrier_tier}")

    # ── Build per-cohort x_at_tau from carrier (v2 lines 700-708) ────
    _cohort_x_at_tau: List[List[float]] = []
    reach = x_provider.reach if x_provider else 0.0
    for ci in cohort_list:
        N_i = ci['x_frozen']
        a_pop = ci.get('a_frozen', N_i) or N_i or 1.0
        if upstream_path_cdf_arr is None:
            x_at_tau = [float(N_i)] * (max_tau + 1)
        else:
            x_at_tau = [max(a_pop * reach * upstream_path_cdf_arr[t], float(N_i))
                        for t in range(max_tau + 1)]
        _cohort_x_at_tau.append(x_at_tau)

    # ── Engine call: per-cohort population model sweep ──────────────
    # When to pass mc_cdf_arr from the span kernel:
    # - Window mode: always (edge CDF, from-node-relative ages)
    # - Cohort mode, multi-hop: always (span kernel = query path CDF)
    # - Cohort mode, single-edge, anchor == from_node: yes (path = edge)
    # - Cohort mode, single-edge, anchor != from_node: NO — edge CDF
    #   doesn't match anchor-relative ages. Use path params from resolver.
    _sweep_cdf = mc_cdf_arr
    _sweep_p = mc_p_s
    sweep = compute_forecast_sweep(
        resolved=resolved,
        cohorts=engine_cohorts,
        max_tau=max_tau,
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
    )

    print(f"[v3] Engine sweep: IS_ESS={sweep.is_ess:.0f} "
          f"cohorts_conditioned={sweep.n_cohorts_conditioned} "
          f"shape={sweep.rate_draws.shape}")


    # ── Compute evidence display from cohort data (v2 lines 990-1008) ─
    # Evidence at each τ = aggregate obs across all cohorts, using the
    # same population model as the sweep: observed values for cohorts
    # whose frontier is ≥ τ, frozen/projected values for younger cohorts.
    def _compute_evidence_at_tau(tau: int) -> Optional[Dict]:
        # v2 line 986: evidence only within future max
        if tau > tau_future_max:
            return None
        # v2 line 987-990: only mature cohorts can provide "real" observations
        has_real_obs = any(
            tau in cohort_at_tau.get(ci['anchor_day'].isoformat(), {})
            for ci in cohort_list if tau <= ci.get('tau_observed', ci['tau_max'])
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
                # v2 lines 997-1005: exclusive if/else on tau <= a_i
                if tau <= a_i:
                    ev_x += ce.obs_x[tau]
                    ev_x_pure += ce.obs_x[tau]
                    ev_y_pure += ce.obs_y[tau]
                else:
                    # Unobserved: use carrier-projected x (v2 line 1004)
                    _xat = _cohort_x_at_tau[idx]
                    ev_x += _xat[tau] if tau < len(_xat) else ce.x_frozen
                # v2 mature_count: cohort has a real observation at this τ
                # AND τ ≤ tau_max (from bucket aggregation, line 622-630)
                ad_str = ci['anchor_day'].isoformat()
                if tau <= tau_max_c and tau in cohort_at_tau.get(ad_str, {}):
                    n_mature += 1
                ev_y += ce.obs_y[tau]
                n_cohorts += 1
        if ev_x <= 0:
            return None
        return {
            'sum_y': ev_y, 'sum_x': ev_x,
            'sum_y_pure': ev_y_pure, 'sum_x_pure': ev_x_pure,
            'n_cohorts': n_cohorts,
            'n_mature': n_mature,
        }

    # ── Assemble rows from sweep result ─────────────────────────────
    # D19 fix (G.4): forecast_y/forecast_x now read from sweep.det_y_total
    # / sweep.det_x_total (median IS-conditioned Y/X across draws).
    # This replaces _compute_det_totals which used unconditioned p and
    # edge-level CDF, diverging up to 50% on multi-hop narrow queries.
    S = sweep.rate_draws.shape[0]
    T = sweep.rate_draws.shape[1]
    band_levels = [0.80, 0.90, 0.95, 0.99]
    rows = []

    for tau in range(T):
        ev = _compute_evidence_at_tau(tau)
        rate = ev['sum_y'] / ev['sum_x'] if ev and ev['sum_x'] > 0 else None
        # D19 fix: use MC median Y/X from sweep (IS-conditioned, same
        # draws as midpoint). Replaces _compute_det_totals which used
        # unconditioned p and edge-level CDF — diverging up to 50% on
        # multi-hop narrow queries.
        _det_y_tau = float(sweep.det_y_total[tau]) if sweep.det_y_total is not None and tau < len(sweep.det_y_total) else 0.0
        _det_x_tau = float(sweep.det_x_total[tau]) if sweep.det_x_total is not None and tau < len(sweep.det_x_total) else 0.0
        rate_pure = (ev['sum_y_pure'] / ev['sum_x_pure']
                     if ev and ev.get('sum_x_pure', 0) > 0 else None)

        # MC quantiles from conditioned sweep
        draws = sweep.rate_draws[:, tau]
        midpoint: Optional[float] = float(np.median(draws))
        fan_upper_val: Optional[float] = float(np.quantile(draws, (1 + band_level) / 2))
        fan_lower_val: Optional[float] = float(np.quantile(draws, (1 - band_level) / 2))
        fan_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(np.quantile(draws, (1 - bl) / 2)),
                float(np.quantile(draws, (1 + bl) / 2)),
            ] for bl in band_levels
        }

        # Epoch A: suppress midpoint + fan where evidence is complete
        # (v2 uses tau_solid_max = youngest cohort's tau_observed)
        if tau < tau_solid_max:
            midpoint = None
            fan_upper_val = None
            fan_lower_val = None
            fan_bands = None

        # Model-only quantiles from unconditioned sweep
        model_draws = sweep.model_rate_draws[:, tau]
        model_midpoint = float(np.median(model_draws))
        model_fan_upper = float(np.quantile(model_draws, (1 + band_level) / 2))
        model_fan_lower = float(np.quantile(model_draws, (1 - band_level) / 2))
        model_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(np.quantile(model_draws, (1 - bl) / 2)),
                float(np.quantile(model_draws, (1 + bl) / 2)),
            ] for bl in band_levels
        }

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate_pure,
            'evidence_y': ev['sum_y'] if ev else None,
            'evidence_x': ev['sum_x'] if ev else None,
            # G.4: projected_rate from MC draws (replaces legacy
            # annotate_rows projected_y aggregation).
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
        })

    return rows
