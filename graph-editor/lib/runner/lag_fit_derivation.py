"""
Lag Fit Derivation from Snapshot Sweep Data

Fits a log-normal lag distribution to cohort evidence rows and returns
per-cohort scatter points alongside the fitted CDF/PMF curves.

Uses the same sweep rows as cohort_maturity and the same fitting pipeline
(lag_model_fitter.fit_model_from_evidence) — no duplicate logic.

Output shape:
    {
        "analysis_type": "lag_fit",
        "data": [
            {"row_type": "meta", "mu", "sigma", "t95", "median", "p_infinity", ...},
            {"row_type": "curve", "t", "pdf", "cdf"},       # one per lag day
            {"row_type": "cohort", "age", "observed_cdf", "n", "k", "date"},
        ],
        "metadata": { ... },
    }
"""

import math
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from .lag_distribution_utils import log_normal_cdf, log_normal_inverse_cdf
from .lag_model_fitter import fit_model_from_evidence, select_latest_evidence
from .forecasting_settings import ForecastingSettings


def derive_lag_fit(
    rows: List[Dict[str, Any]],
    *,
    t95_constraint: Optional[float] = None,
    onset_override: Optional[float] = None,
    from_node: str = '',
    to_node: str = '',
    edge_label: str = '',
) -> Dict[str, Any]:
    """
    Derive a lag fit analysis from snapshot sweep rows.

    Args:
        rows: Raw snapshot rows (from query_snapshots_for_sweep) with
              anchor_day, retrieved_at, x, y, median_lag_days, etc.
        t95_constraint: Authoritative t95 from graph edge (one-way sigma constraint).
        onset_override: Authoritative onset_delta_days from graph edge.
        from_node: Human-readable source node ID (for labelling).
        to_node: Human-readable target node ID (for labelling).
        edge_label: Display label for the edge.

    Returns:
        Result dict with curve, cohort scatter, and fit metadata.
    """
    if not rows:
        return _empty_result(from_node, to_node, edge_label, 'No snapshot rows returned from sweep query')

    # Lag fit is a diagnostic visualisation, not a production forecast.
    # Use relaxed quality thresholds so we show the fit even with sparse data.
    settings = ForecastingSettings()
    settings.min_fit_converters = 5

    # 1. Fit the lag model using the standard pipeline
    fit = fit_model_from_evidence(
        rows, settings,
        t95_constraint=t95_constraint,
        onset_override=onset_override,
    )

    if fit.mu <= 0 or fit.sigma <= 0:
        reason = f'Fit produced invalid parameters (mu={fit.mu:.4f}, sigma={fit.sigma:.4f})'
        if fit.quality_failure_reason:
            reason += f': {fit.quality_failure_reason}'
        return _empty_result(from_node, to_node, edge_label, reason)

    mu = fit.mu
    sigma = fit.sigma
    t95 = fit.t95_days
    onset = fit.onset_delta_days
    median = math.exp(mu)

    # 2. Estimate p_infinity from mature cohorts (age > t95)
    evidence = select_latest_evidence(rows)
    today = date.today()

    mature_rates: List[float] = []
    cohort_points: List[Dict[str, Any]] = []

    for ev in evidence:
        anchor = _parse_date(ev.anchor_day)
        if anchor is None:
            continue
        age = (today - anchor).days
        if age <= 0:
            continue
        n = ev.x
        k = ev.y
        if n <= 0:
            continue
        rate = k / n
        if age >= t95:
            mature_rates.append(rate)
        cohort_points.append({
            'anchor_day': anchor,
            'age': age,
            'n': n,
            'k': k,
            'rate': rate,
        })

    if not cohort_points:
        return _empty_result(from_node, to_node, edge_label,
            f'No usable cohort points from {len(evidence)} evidence rows (all n=0 or age<=0)')

    # p_infinity: average rate of mature cohorts, or max observed rate as fallback
    if mature_rates:
        p_infinity = sum(mature_rates) / len(mature_rates)
    else:
        p_infinity = max(cp['rate'] for cp in cohort_points)

    if p_infinity <= 0:
        return _empty_result(from_node, to_node, edge_label,
            f'Estimated p_infinity={p_infinity:.6f} is zero or negative — no mature cohorts with conversions')

    # 3. Build fitted CDF/PMF curve
    t_max = max(int(math.ceil(t95 * 1.5)), 30)
    curve_rows: List[Dict[str, Any]] = []
    for t in range(t_max + 1):
        cdf = log_normal_cdf(max(0, t - onset), mu, sigma)
        cdf_prev = log_normal_cdf(max(0, t - 1 - onset), mu, sigma) if t > 0 else 0.0
        pdf = cdf - cdf_prev
        curve_rows.append({
            'row_type': 'curve',
            't': t,
            'pdf': round(pdf, 8),
            'cdf': round(cdf, 8),
        })

    # 4. Build per-cohort observed completeness scatter
    cohort_rows: List[Dict[str, Any]] = []
    for cp in cohort_points:
        observed_cdf = min(1.0, cp['k'] / (cp['n'] * p_infinity))
        cohort_rows.append({
            'row_type': 'cohort',
            'age': cp['age'],
            'observed_cdf': round(observed_cdf, 6),
            'n': cp['n'],
            'k': cp['k'],
            'date': cp['anchor_day'].isoformat(),
        })

    # 5. Build metadata row
    meta_row = {
        'row_type': 'meta',
        'mu': round(mu, 6),
        'sigma': round(sigma, 6),
        't95': round(t95, 2),
        'median': round(median, 2),
        'p_infinity': round(p_infinity, 6),
        'onset_delta_days': round(onset, 2),
        'from_node': from_node,
        'to_node': to_node,
        'edge_label': edge_label or f'{from_node} → {to_node}',
        'quality_ok': fit.quality_ok,
        'total_k': int(fit.total_k),
        'evidence_anchor_days': fit.evidence_anchor_days,
    }

    data = [meta_row] + curve_rows + cohort_rows

    return {
        'analysis_type': 'lag_fit',
        'analysis_name': 'Lag Fit',
        'data': data,
        'metadata': {
            'mu': meta_row['mu'],
            'sigma': meta_row['sigma'],
            't95': meta_row['t95'],
            'median': meta_row['median'],
            'p_infinity': meta_row['p_infinity'],
            'from_node': from_node,
            'to_node': to_node,
            'edge_label': meta_row['edge_label'],
        },
        'cohorts_analysed': len(cohort_points),
    }


def _empty_result(from_node: str, to_node: str, edge_label: str, reason: str = '') -> Dict[str, Any]:
    return {
        'analysis_type': 'lag_fit',
        'analysis_name': 'Lag Fit',
        'data': [],
        'metadata': {
            'from_node': from_node,
            'to_node': to_node,
            'edge_label': edge_label or f'{from_node} → {to_node}',
            'empty_reason': reason,
        },
        'cohorts_analysed': 0,
    }


def _parse_date(val: Any) -> Optional[date]:
    if isinstance(val, date):
        return val
    if isinstance(val, str):
        try:
            return date.fromisoformat(val)
        except ValueError:
            return None
    return None
