"""
cohort_forecast_v3 — clean-room cohort maturity consuming the forecast engine.

Doc 29 Phase 5, doc 29g: uses compute_conditioned_forecast for IS-conditioned
draws, then evaluates the sweep and extracts quantiles. No reimplementation
of CDF, carrier, model resolution, or IS conditioning.

Target: ~150 lines (v2 is 1154).
"""

import math
import numpy as np
from collections import defaultdict
from datetime import date as _date
from typing import Any, Dict, List, Optional


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
) -> List[Dict[str, Any]]:
    """Compute per-τ rows for cohort maturity v3 chart.

    Same row schema as v2 so the FE chart builder works unchanged.
    Delegates all MC + IS conditioning to the engine via
    compute_conditioned_forecast (doc 29g).
    """
    from .forecast_state import (
        build_node_arrival_cache,
        compute_conditioned_forecast,
        _compute_completeness_at_age,
    )
    from .model_resolver import resolve_model_params
    from .cohort_forecast import find_edge_by_id

    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return []

    # ── Resolve model params via engine ──────────────────────────────
    # Always edge-level params — carrier convolution handles upstream
    # lag. Path-level would double-apply it (review finding #8).
    temporal = 'window' if is_window else 'cohort'
    resolved = resolve_model_params(target_edge, scope='edge', temporal_mode=temporal)
    if not resolved or resolved.latency.sigma <= 0:
        return []

    lat = resolved.latency

    # ── Build carrier (cohort mode only) ─────────────────────────────
    from_node_arrival = None
    if not is_window and anchor_node_id:
        try:
            cache = build_node_arrival_cache(graph, anchor_id=anchor_node_id, max_tau=400)
            from_node_arrival = cache.get(target_edge.get('from', ''))
        except Exception as e:
            print(f"[v3] WARNING: carrier cache failed: {e}")

    # ── Find last frame ──────────────────────────────────────────────
    last_frame = None
    for f in frames:
        if f.get('snapshot_date') and str(f['snapshot_date'])[:10] <= str(sweep_to)[:10]:
            last_frame = f

    # ── Extract evidence from all frames (review finding #10) ─────────
    # Build per-τ evidence by iterating all frames, not just the last.
    # Each frame is a snapshot at a different date. For each data_point,
    # τ = (snapshot_date - anchor_day).days gives the cohort's age at
    # that snapshot. Per (cohort, τ) we keep the latest observation.
    # Then sum across cohorts at each τ for the display evidence line.
    #
    # IS conditioning uses the last frame only (frontier observations).

    # Step 1: per-cohort trajectory from all frames
    # Key: (anchor_day_str, τ) → (x, y, snapshot_date)
    _cohort_obs: Dict[tuple, tuple] = {}
    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        if not sd_str:
            continue
        try:
            sd = _date.fromisoformat(sd_str)
        except (ValueError, TypeError):
            continue
        if sd > sweep_to_d:
            continue
        for dp in (f.get('data_points') or []):
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            tau = (sd - ad).days
            if tau < 0:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if not isinstance(y_val, (int, float)):
                y_val = 0
            key = (ad_str, tau)
            existing = _cohort_obs.get(key)
            # Keep latest snapshot for each (cohort, τ)
            if existing is None or sd_str >= existing[2]:
                _cohort_obs[key] = (float(x_val), float(y_val), sd_str)

    # Step 2: aggregate across cohorts at each τ
    evidence_by_tau: Dict[int, Dict] = {}
    for (ad_str, tau), (x, y, _) in _cohort_obs.items():
        if tau not in evidence_by_tau:
            evidence_by_tau[tau] = {'sum_y': 0.0, 'sum_x': 0.0, 'n_cohorts': 0}
        ev = evidence_by_tau[tau]
        ev['sum_y'] += y
        ev['sum_x'] += x
        ev['n_cohorts'] += 1

    # Step 3: IS conditioning evidence from last frame (frontier only)
    #
    # Rationale for terminal-only conditioning:
    #
    # x_i and k_i are cumulative. For a fixed CDF shape, the Fisher
    # information about p from the full trajectory equals the endpoint
    # Fisher information — intermediate observations add information
    # about CDF shape only, not about p (doc 18 compiler-journal
    # lines 2434-2444: "p and CDF shape are informationally orthogonal").
    #
    # The IS resampling is already joint over (p, mu, sigma, onset):
    # E_s = n × CDF(τ, mu_s, sigma_s, onset_s) varies per latency
    # draw, so a cohort with high frontier k already favours faster
    # latency draws. This is not p-only conditioning.
    #
    # What frontier-only IS does NOT capture is within-trajectory
    # shape information between age 0 and the frontier. This would
    # require a shape-only weight (e.g. Multinomial on interval
    # increments Δk_j with π_j = ΔF_j/F(T)) applied to latency
    # draws only, keeping the Bin(E_eff, p) update for p. This is
    # tractable but not implemented — the Bayesian fit already
    # conditions latency on the full trajectory via the posterior
    # SDs, so the marginal gain is small when the selected source
    # is bayesian with a fresh fit.
    #
    # References:
    # - v2 IS conditioning: cohort_forecast_v2.py lines 840-861
    #   (frontier-only, same approach)
    # - Effective exposure: doc 29d §Frontier Exposure,
    #   parameterisation B: Bin(E_eff, p) where E_eff = n × CDF(τ)
    # - Fisher information argument: doc 18 compiler-journal §2434
    # - Shape-only extension: doc 29g §future (not blocking)
    cohort_evidence: List[tuple] = []
    if last_frame and last_frame.get('data_points'):
        for dp in last_frame['data_points']:
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            tau = (sweep_to_d - ad).days
            if tau < 0:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if not isinstance(y_val, (int, float)):
                y_val = 0
            cohort_evidence.append((float(tau), int(x_val), int(y_val)))

    # ── Epoch boundaries from cohort data ────────────────────────────
    tau_solid_max = 0
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)
    cohort_ages = [int(t) for t, _, _ in cohort_evidence]
    if cohort_ages:
        tau_solid_max = min(cohort_ages)
        tau_future_max = max(cohort_ages)

    # ── Determine tau range ──────────────────────────────────────────
    max_tau = tau_future_max
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    elif lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(0.95, lat.mu, lat.sigma) + lat.onset_delta_days
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass
    max_tau = min(max_tau, 400)

    # ── Engine call: IS-conditioned forecast (doc 29g) ───────────────
    cohort_ages_weights = [(float(t), n) for t, n, _ in cohort_evidence]
    if not cohort_ages_weights:
        cohort_ages_weights = [(float(tau_future_max), 1)]

    forecast = compute_conditioned_forecast(
        edge_id=target_edge_id,
        resolved=resolved,
        cohort_ages_and_weights=cohort_ages_weights,
        evidence=cohort_evidence,
        from_node_arrival=from_node_arrival,
    )

    print(f"[v3] Engine: source={forecast.source} mode={forecast.mode} "
          f"IS_lambda={forecast.is_tempering_lambda:.3f} "
          f"IS_ESS={forecast.is_ess:.0f} completeness={forecast.completeness:.3f}")

    # ── Sweep: evaluate CDF at display τ range with conditioned draws ─
    S = len(forecast.p_draws)
    tau_range = list(range(max_tau + 1))
    band_levels = [0.80, 0.90, 0.95, 0.99]

    # Per-τ rate draws from conditioned params (for fan bands)
    rate_draws = np.zeros((S, len(tau_range)))
    for i, tau in enumerate(tau_range):
        for s in range(S):
            c = _compute_completeness_at_age(
                float(tau), float(forecast.mu_draws[s]),
                float(forecast.sigma_draws[s]),
                float(forecast.onset_draws[s]))
            rate_draws[s, i] = forecast.p_draws[s] * c

    # Per-τ rate draws from UNconditioned params (for model_bands)
    S_uncond = len(forecast.p_draws_unconditioned)
    model_rate_draws = np.zeros((S_uncond, len(tau_range)))
    if S_uncond > 0:
        for i, tau in enumerate(tau_range):
            for s in range(S_uncond):
                c = _compute_completeness_at_age(
                    float(tau), float(forecast.mu_draws_unconditioned[s]),
                    float(forecast.sigma_draws_unconditioned[s]),
                    float(forecast.onset_draws_unconditioned[s]))
                model_rate_draws[s, i] = forecast.p_draws_unconditioned[s] * c

    # ── Assemble rows ────────────────────────────────────────────────
    rows = []
    for i, tau in enumerate(tau_range):
        ev = evidence_by_tau.get(tau)
        rate = ev['sum_y'] / ev['sum_x'] if ev and ev['sum_x'] > 0 else None
        rate_pure = rate

        # MC quantiles (conditioned)
        draws = rate_draws[:, i]
        midpoint: Optional[float] = float(np.median(draws))
        fan_upper_val: Optional[float] = float(np.quantile(draws, (1 + band_level) / 2))
        fan_lower_val: Optional[float] = float(np.quantile(draws, (1 - band_level) / 2))
        fan_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(np.quantile(draws, (1 - bl) / 2)),
                float(np.quantile(draws, (1 + bl) / 2)),
            ] for bl in band_levels
        }

        # Epoch A: suppress midpoint + fan (evidence is complete)
        if tau < tau_solid_max:
            midpoint = None
            fan_upper_val = None
            fan_lower_val = None
            fan_bands = None

        # Model-only quantiles (unconditioned draws, pre-IS)
        if S_uncond > 0:
            model_draws = model_rate_draws[:, i]
            model_midpoint = float(np.median(model_draws))
            model_fan_upper = float(np.quantile(model_draws, (1 + band_level) / 2))
            model_fan_lower = float(np.quantile(model_draws, (1 - band_level) / 2))
            model_bands: Optional[Dict] = {
                str(int(bl * 100)): [
                    float(np.quantile(model_draws, (1 - bl) / 2)),
                    float(np.quantile(model_draws, (1 + bl) / 2)),
                ] for bl in band_levels
            }
        else:
            p_prior = resolved.p_mean
            model_rate = p_prior * _compute_completeness_at_age(
                float(tau), lat.mu, lat.sigma, lat.onset_delta_days)
            model_midpoint = model_rate
            model_fan_upper = model_rate
            model_fan_lower = model_rate
            model_bands = {str(int(bl * 100)): [model_rate, model_rate] for bl in band_levels}

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate_pure,
            'evidence_y': ev['sum_y'] if ev else None,
            'evidence_x': ev['sum_x'] if ev else None,
            'projected_rate': float(np.mean(draws)),
            'forecast_y': round(float(np.mean(draws)) * ev['sum_x']) if ev and ev['sum_x'] > 0 else None,
            'forecast_x': round(ev['sum_x']) if ev else None,
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
            'cohorts_covered_base': ev['n_cohorts'] if ev else 0,
            'cohorts_covered_projected': ev['n_cohorts'] if ev else 0,
        })

    return rows
