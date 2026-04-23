"""
Blind contract suite for cohort_maturity v3 row output.

§3.6 receipt
  Family:    B (runtime semantic contract) and E (invariance) and
             F (projection/authority row-schema)
  Invariant: given a well-formed inline graph and synthetic frames,
             `compute_cohort_maturity_rows_v3` must return rows that
             obey the canonical row schema, the epoch null rules, fan
             ordering and bounds, row ordering, and the zero-evidence
             degeneration contract. These invariants hold regardless of
             the underlying MC or IS implementation — they are the
             "what a cohort maturity row *is*" contract.
  Oracle:    static canonical spec (no v2 reference)
  Apparatus: Python unit tests against `compute_cohort_maturity_rows_v3`
             with inline synthetic graphs and synthesised frames
  Fixtures:  single-edge linear graph with bayesian model params; no
             DB or data repo dependency
  Reality:   catches regressions where the row schema loses fields, an
             epoch null rule is violated, fan bounds go out of [0,1],
             the row order is corrupted, or zero-evidence output drifts
             away from the unconditional model curve.
  False-pass: mocking compute_cohort_maturity_rows_v3 itself — these
             tests require the real function.
  Retires:   the row-schema check in
             `test_v2_v3_parity.py::test_v3_row_schema_complete`, the
             shape-invariant tests in
             `test_cohort_fan_harness.py::{TestMidpointInvariants,TestFanInvariants,TestEvidenceRate}`,
             and `test_cohort_forecast.py::TestWindowZeroMaturityDegeneration`
             insofar as those tests cover v3 behaviour.

This file is the primary replacement for deletion Phase A in
`docs/current/project-bayes/64-retirement-audit.md`.
"""

import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest
import yaml

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3


# ── Helpers: inline synthetic graph + frames (no DB) ──────────────────


def _build_single_edge_graph(
    *,
    p_mean: float = 0.80,
    alpha: float = 40.0,
    beta: float = 10.0,
    mu: float = 2.0,
    sigma: float = 0.6,
    onset: float = 3.0,
    p_sd: float = 0.05,
    mu_sd: float = 0.10,
    sigma_sd: float = 0.05,
    onset_sd: float = 0.50,
    onset_mu_corr: float = -0.50,
    t95: float = 30.0,
    latency_parameter: bool = False,
) -> Dict[str, Any]:
    return {
        'nodes': [
            {'uuid': 'n1', 'id': 'node-a', 'entry': {'is_start': True}},
            {'uuid': 'n2', 'id': 'node-b'},
        ],
        'edges': [{
            'uuid': 'e1',
            'from': 'n1',
            'to': 'n2',
            'p': {
                'id': 'synth-contract',
                'forecast': {'mean': p_mean},
                'latency': {
                    'latency_parameter': latency_parameter,
                    'mu': mu,
                    'sigma': sigma,
                    'onset_delta_days': onset,
                    't95': t95,
                    'promoted_t95': t95,
                    'mu_sd': mu_sd,
                    'sigma_sd': sigma_sd,
                    'onset_sd': onset_sd,
                    'onset_mu_corr': onset_mu_corr,
                },
                'posterior': {'alpha': alpha, 'beta': beta},
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {
                        'mu': mu, 'sigma': sigma,
                        'onset_delta_days': onset,
                        'mu_sd': mu_sd, 'sigma_sd': sigma_sd,
                        'onset_sd': onset_sd,
                    },
                    'probability': {'mean': p_mean},
                }],
            },
        }],
    }


def _build_two_edge_latency_graph(
    *,
    upstream_p: float = 0.70,
    upstream_alpha: float = 28.0,
    upstream_beta: float = 12.0,
    upstream_mu: float = 1.2,
    upstream_sigma: float = 0.35,
    upstream_onset: float = 7.0,
    target_p: float = 0.80,
    target_alpha: float = 40.0,
    target_beta: float = 10.0,
    target_mu: float = 0.9,
    target_sigma: float = 0.3,
    target_onset: float = 2.0,
) -> Dict[str, Any]:
    return {
        'nodes': [
            {'uuid': 'n1', 'id': 'node-a', 'entry': {'is_start': True}},
            {'uuid': 'n2', 'id': 'node-b'},
            {'uuid': 'n3', 'id': 'node-c'},
        ],
        'edges': [
            {
                'uuid': 'e-ab',
                'from': 'n1',
                'to': 'n2',
                'p': {
                    'id': 'synth-upstream',
                    'forecast': {'mean': upstream_p},
                    'latency': {
                        'latency_parameter': True,
                        'mu': upstream_mu,
                        'sigma': upstream_sigma,
                        'onset_delta_days': upstream_onset,
                        't95': 28.0,
                        'promoted_t95': 28.0,
                        'mu_sd': 0.08,
                        'sigma_sd': 0.04,
                        'onset_sd': 0.40,
                        'onset_mu_corr': -0.40,
                    },
                    'posterior': {
                        'alpha': upstream_alpha,
                        'beta': upstream_beta,
                        'cohort_alpha': upstream_alpha,
                        'cohort_beta': upstream_beta,
                    },
                    'model_vars': [{
                        'source': 'analytic',
                        'latency': {
                            'mu': upstream_mu,
                            'sigma': upstream_sigma,
                            'onset_delta_days': upstream_onset,
                            'mu_sd': 0.08,
                            'sigma_sd': 0.04,
                            'onset_sd': 0.40,
                        },
                        'probability': {'mean': upstream_p},
                    }],
                },
            },
            {
                'uuid': 'e-bc',
                'from': 'n2',
                'to': 'n3',
                'p': {
                    'id': 'synth-target',
                    'forecast': {'mean': target_p},
                    'latency': {
                        'latency_parameter': True,
                        'mu': target_mu,
                        'sigma': target_sigma,
                        'onset_delta_days': target_onset,
                        't95': 20.0,
                        'promoted_t95': 20.0,
                        'mu_sd': 0.08,
                        'sigma_sd': 0.04,
                        'onset_sd': 0.40,
                        'onset_mu_corr': -0.40,
                    },
                    'posterior': {
                        'alpha': target_alpha,
                        'beta': target_beta,
                        'cohort_alpha': target_alpha,
                        'cohort_beta': target_beta,
                    },
                    'model_vars': [{
                        'source': 'analytic',
                        'latency': {
                            'mu': target_mu,
                            'sigma': target_sigma,
                            'onset_delta_days': target_onset,
                            'mu_sd': 0.08,
                            'sigma_sd': 0.04,
                            'onset_sd': 0.40,
                        },
                        'probability': {'mean': target_p},
                    }],
                },
            },
        ],
    }


def _build_synth_frames(
    *,
    anchor_to: date = date(2026, 3, 1),
    sweep_days: int = 38,
    n_cohorts: int = 18,
    n_per_cohort: int = 300,
    true_rate: float = 0.50,
) -> Tuple[List[Dict[str, Any]], str, str]:
    sweep_to = anchor_to + timedelta(days=sweep_days)
    frames = []
    for day_offset in range(sweep_days + 1):
        snapshot_date = anchor_to + timedelta(days=day_offset)
        data_points = []
        for c in range(n_cohorts):
            anchor_day = anchor_to - timedelta(days=c * 2)
            age = (snapshot_date - anchor_day).days
            x = n_per_cohort
            y = int(true_rate * x * min(1.0, age / 20.0))
            y = min(y, x)
            data_points.append({
                'anchor_day': anchor_day.isoformat(),
                'x': x,
                'y': y,
                'a': x * 2,
                'median_lag_days': 8.0,
                'mean_lag_days': 10.0,
            })
        frames.append({
            'snapshot_date': snapshot_date.isoformat(),
            'data_points': data_points,
        })
    return frames, anchor_to.isoformat(), sweep_to.isoformat()


def _build_zero_evidence_frames(
    *,
    anchor_from: str,
    sweep_to: str,
    x: int = 500,
) -> List[Dict[str, Any]]:
    """Single-cohort frames with y=0 across the sweep — the zero-evidence fixture."""
    start = date.fromisoformat(anchor_from)
    end = date.fromisoformat(sweep_to)
    frames = []
    d = start
    while d <= end:
        frames.append({
            'snapshot_date': d.isoformat(),
            'data_points': [{
                'anchor_day': anchor_from,
                'x': x,
                'y': 0,
                'a': x * 2,
            }],
        })
        d += timedelta(days=1)
    return frames


def _run_v3(
    *,
    graph: Dict[str, Any],
    frames: List[Dict[str, Any]],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool = True,
    axis_tau_max: int = None,
    target_edge_id: str = 'e1',
    query_from_node: str = 'node-a',
    query_to_node: str = 'node-b',
    anchor_node_id: str | None = None,
    is_multi_hop: bool = False,
) -> List[Dict[str, Any]]:
    return compute_cohort_maturity_rows_v3(
        frames=frames,
        graph=graph,
        target_edge_id=target_edge_id,
        query_from_node=query_from_node,
        query_to_node=query_to_node,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        axis_tau_max=axis_tau_max,
        anchor_node_id=anchor_node_id,
        is_multi_hop=is_multi_hop,
        band_level=0.90,
    )


def _shifted_lognormal_cdf(tau: int, *, onset: float, mu: float, sigma: float) -> float:
    from math import erf, log, sqrt

    model_age = float(tau) - float(onset)
    if model_age <= 0 or sigma <= 0:
        return 0.0
    z = (log(model_age) - float(mu)) / float(sigma)
    return 0.5 * (1.0 + erf(z / sqrt(2.0)))


_LOGNORMAL_Z95 = 1.6448536269514722


def _approx_shifted_lognormal_t95(*, onset: float, mu: float, sigma: float) -> float:
    from math import exp

    return float(onset) + exp(float(mu) + (_LOGNORMAL_Z95 * float(sigma)))


def _load_truth_edge_params(
    *,
    graph_name: str,
    edge_name: str,
) -> Dict[str, float]:
    repo_root = Path(__file__).resolve().parents[3]
    truth_path = repo_root / 'bayes' / 'truth' / f'{graph_name}.truth.yaml'
    truth = yaml.safe_load(truth_path.read_text())
    edge = (truth.get('edges') or {}).get(edge_name)
    assert edge is not None, f'missing truth edge {edge_name} in {truth_path}'
    return {
        'p': float(edge['p']),
        'mu': float(edge['mu']),
        'sigma': float(edge['sigma']),
        'onset': float(edge['onset']),
    }


def _fw_truth_curve_from_edges(
    *,
    upstream: Dict[str, float],
    target: Dict[str, float],
    tau_max: int,
) -> Dict[int, float]:
    from runner.stats_engine import LagDistributionFit, fw_compose_pair

    fw = fw_compose_pair(
        LagDistributionFit(
            mu=float(upstream['mu']),
            sigma=float(upstream['sigma']),
            empirical_quality_ok=True,
            total_k=100,
        ),
        LagDistributionFit(
            mu=float(target['mu']),
            sigma=float(target['sigma']),
            empirical_quality_ok=True,
            total_k=100,
        ),
    )
    assert fw is not None, 'FW composition failed for truth-backed edge pair'
    mu_fw, sigma_fw = fw
    path_onset = float(upstream['onset']) + float(target['onset'])
    return {
        tau: float(target['p']) * _shifted_lognormal_cdf(
            tau,
            onset=path_onset,
            mu=mu_fw,
            sigma=sigma_fw,
        )
        for tau in range(tau_max + 1)
    }


# ── Shared baseline rows: reused across every shape invariant ─────────


@pytest.fixture(scope='module')
def baseline_rows() -> List[Dict[str, Any]]:
    """Window-mode rows on a well-formed synthetic fixture.

    Reused across the row-schema, monotonicity, fan, epoch, and
    ordering tests. The fixture forces a forecast zone: anchor_to is 10
    days before sweep_to, and axis_tau_max is pushed past tau_future_max
    so forecast-zone rows exist alongside evidence-zone rows.
    """
    graph = _build_single_edge_graph()
    # anchor_to 2026-03-10 (cohort 10 at the newest), sweep_to 2026-04-15.
    # tau_solid_max = 2026-04-15 − 2026-03-10 = 36.
    # tau_future_max = 2026-04-15 − 2026-03-01 = 45.
    frames, anchor_from, sweep_to = _build_synth_frames(
        anchor_to=date(2026, 3, 10),
        sweep_days=36,
        n_cohorts=10,
    )
    rows = _run_v3(
        graph=graph,
        frames=frames,
        anchor_from='2026-03-01',
        anchor_to=anchor_from,
        sweep_to=sweep_to,
        is_window=True,
        axis_tau_max=60,
    )
    assert rows, 'v3 returned no rows for the baseline fixture — suite cannot run'
    return rows


# ── R1 — schema completeness (Family F) ───────────────────────────────


CANONICAL_ROW_FIELDS = (
    'tau_days',
    'rate',
    'rate_pure',
    'evidence_y',
    'evidence_x',
    'projected_rate',
    'forecast_y',
    'forecast_x',
    'midpoint',
    'fan_upper',
    'fan_lower',
    'fan_bands',
    'model_midpoint',
    'model_fan_upper',
    'model_fan_lower',
    'model_bands',
    'tau_solid_max',
    'tau_future_max',
    'boundary_date',
    'cohorts_covered_base',
    'cohorts_covered_projected',
)


def test_v3_row_schema_has_canonical_fields(baseline_rows):
    """Every v3 maturity row (chosen in the forecast zone) must carry the
    canonical field set the FE chart builder depends on."""
    tau_solid = baseline_rows[0].get('tau_solid_max', 0)
    forecast_rows = [r for r in baseline_rows if r['tau_days'] > tau_solid]
    assert forecast_rows, 'baseline fixture produced no forecast-zone rows'
    sample = forecast_rows[len(forecast_rows) // 2]
    missing = [f for f in CANONICAL_ROW_FIELDS if f not in sample]
    assert not missing, f'v3 row missing canonical fields: {missing}'


def test_v3_fan_bands_carry_band_level_and_median(baseline_rows):
    """fan_bands must carry the configured band_level envelope (default
    90) plus the 50-percentile median envelope, each with lo ≤ hi.

    v3's canonical band set is {band_level, 50} — v1/v2 emitted
    {80, 90, 95, 99}, which the chart no longer uses. See
    `cohort_forecast_v3.py:238` — band_levels = [band_level, 0.5].
    """
    rows_with_bands = [r for r in baseline_rows
                       if isinstance(r.get('fan_bands'), dict)
                       and r['fan_bands']]
    assert rows_with_bands, 'no rows carry a fan_bands dict'
    sample = rows_with_bands[len(rows_with_bands) // 2]
    fb = sample['fan_bands']
    for level in ('90', '50'):
        assert level in fb, f'fan_bands missing canonical level {level}'
        lo, hi = fb[level]
        assert lo <= hi, f'fan_bands[{level}] lo={lo} > hi={hi}'


# ── R2 — midpoint monotonically increasing (Family E) ─────────────────


def test_v3_midpoint_monotonic_across_tau(baseline_rows):
    """On a single fixture, the midpoint must not decrease across τ.
    Tolerance 0.005 accommodates binomial quantisation noise."""
    midpoints = [(r['tau_days'], r['midpoint'])
                 for r in baseline_rows
                 if r.get('midpoint') is not None]
    failures = []
    for i in range(1, len(midpoints)):
        tau_prev, mp_prev = midpoints[i - 1]
        tau_curr, mp_curr = midpoints[i]
        if mp_curr < mp_prev - 0.005:
            failures.append(
                f'midpoint decreased at tau={tau_curr}: {mp_curr:.6f} < {mp_prev:.6f} (prev tau={tau_prev})'
            )
    assert not failures, 'midpoint monotonicity violations:\n' + '\n'.join(failures[:10])


# ── R3 — fan contains midpoint (Family E) ─────────────────────────────


def test_v3_fan_contains_midpoint(baseline_rows):
    for r in baseline_rows:
        mid = r.get('midpoint')
        fu = r.get('fan_upper')
        fl = r.get('fan_lower')
        if mid is None or fu is None or fl is None:
            continue
        assert fl - 1e-9 <= mid <= fu + 1e-9, (
            f'fan does not contain midpoint at tau={r["tau_days"]}: '
            f'lower={fl:.6f} midpoint={mid:.6f} upper={fu:.6f}'
        )


# ── R4 — fan bounded in [0, 1] (Family E) ─────────────────────────────


def test_v3_fan_bounded_01(baseline_rows):
    for r in baseline_rows:
        fu = r.get('fan_upper')
        fl = r.get('fan_lower')
        if fu is not None:
            assert fu <= 1.0 + 1e-9, f'fan_upper > 1 at tau={r["tau_days"]}: {fu}'
        if fl is not None:
            assert fl >= -1e-9, f'fan_lower < 0 at tau={r["tau_days"]}: {fl}'


# ── R5 — REMOVED: v3 legitimately returns prior-mean in epoch A.
#
# v1 emitted midpoint=None for τ < tau_solid_max, treating epoch A as
# "no posterior forecast". v3 emits midpoint = prior mean there, which
# is more informative (the unconditioned model belief before the cohort
# has entered the observable window). The FE chart handles the visual
# distinction via epoch-aware rendering, not by relying on null rows.
#
# This is a design divergence, not a contract violation. The test is
# intentionally not written — see 64-retirement-audit.md §R5.


# ── R6 — REMOVED: v3's `rate` is defined past tau_future_max.
#
# v1 emitted rate=None for τ > tau_future_max, treating `rate` as
# "observed evidence only". v3 fills the field in all branches — in
# the non-latency / fallback branch the field carries the prior mean;
# in the main branch it is derived from frames evidence and may
# persist past the evidence frontier. v3 distinguishes observed from
# projected via the separate `projected_rate` and `forecast_y/x`
# fields, not via nulling `rate`.
#
# This is a design divergence, not a contract violation. The test is
# intentionally not written — see 64-retirement-audit.md §R6.


# ── R7 — rows sorted by τ (Family E) ──────────────────────────────────


def test_v3_rows_sorted_by_tau(baseline_rows):
    taus = [r['tau_days'] for r in baseline_rows]
    assert taus == sorted(taus), f'rows not sorted by tau_days: {taus}'


# ── R8 — REMOVED: v3 fan at solid boundary carries posterior width.
#
# v1 produced a zero-width fan at the solid boundary — the design
# treated the boundary as "evidence-exact". v3 emits full posterior
# uncertainty there (conditioned on all cohorts at that τ), which is
# the honest representation: even at the boundary the rate is not
# known exactly.
#
# This is a design divergence, not a contract violation. The test is
# intentionally not written — see 64-retirement-audit.md §R8.


# ── R9 — REMOVED: v3 fan in forecast zone is flat under flat posterior.
#
# v1 opened the fan as τ moved into the forecast zone because the fan
# combined parameter uncertainty with CDF-compounded forward propagation.
# v3's fan on the conditioned Beta posterior is flat across τ when the
# posterior applies uniformly to all future τ — the rate has a fixed
# posterior distribution, not a τ-growing one. Fan opening in v3
# appears in MC-draw branches where draws accumulate binomial noise,
# but it is not a universal contract.
#
# This is a design divergence, not a contract violation. The test is
# intentionally not written — see 64-retirement-audit.md §R9.


# ── R10 — window-mode midpoint ≥ evidence (Family B) ──────────────────


def test_v3_midpoint_ge_evidence_window_mode(baseline_rows):
    """Window-mode invariant: projected conversions never shrink versus
    the already-observed evidence rate."""
    violations = []
    for r in baseline_rows:
        mid = r.get('midpoint')
        rate = r.get('rate')
        if mid is None or rate is None:
            continue
        if mid < rate - 1e-9:
            violations.append((r['tau_days'], mid, rate))
    assert not violations, (
        'midpoint < evidence rate in window mode: ' + str(violations[:5])
    )


# ── R11 — zero-evidence degenerates to model curve (Family B) ─────────


def test_v3_zero_evidence_degenerates_to_model_curve():
    """Contract: with zero observed conversions on a realistic anchor
    population, the v3 output must degenerate to the unconditioned
    model curve — midpoint ≈ model_midpoint across the forecast zone,
    fan_upper/fan_lower tracking model_fan_upper/model_fan_lower."""
    graph = _build_single_edge_graph()
    anchor_from = '2026-03-01'
    sweep_to = '2026-04-15'
    frames = _build_zero_evidence_frames(
        anchor_from=anchor_from,
        sweep_to=sweep_to,
    )

    rows = _run_v3(
        graph=graph,
        frames=frames,
        anchor_from=anchor_from,
        anchor_to=anchor_from,
        sweep_to=sweep_to,
        is_window=True,
        axis_tau_max=40,
    )
    assert rows, 'v3 returned no rows for zero-evidence fixture'

    TOL = 0.06
    checked = 0
    midpoint_failures: List[Tuple[int, float, float]] = []
    upper_failures: List[Tuple[int, float, float]] = []
    lower_failures: List[Tuple[int, float, float]] = []

    for r in rows:
        mid = r.get('midpoint')
        model_mid = r.get('model_midpoint')
        if mid is None or model_mid is None:
            continue
        if model_mid < 0.01:
            continue
        checked += 1
        if abs(mid - model_mid) > TOL:
            midpoint_failures.append((r['tau_days'], mid, model_mid))

        fu = r.get('fan_upper')
        mfu = r.get('model_fan_upper')
        if fu is not None and mfu is not None and abs(fu - mfu) > TOL:
            upper_failures.append((r['tau_days'], fu, mfu))

        fl = r.get('fan_lower')
        mfl = r.get('model_fan_lower')
        if fl is not None and mfl is not None and abs(fl - mfl) > TOL:
            lower_failures.append((r['tau_days'], fl, mfl))

    assert checked >= 5, f'checked only {checked} rows with model midpoint'
    assert not midpoint_failures, (
        'zero-evidence midpoint drifted from model_midpoint:\n'
        + '\n'.join(f'tau={t}: mid={m:.4f} model={mm:.4f}' for t, m, mm in midpoint_failures[:5])
    )
    assert not upper_failures, (
        'zero-evidence fan_upper drifted from model_fan_upper:\n'
        + '\n'.join(f'tau={t}: fan={f:.4f} model={mf:.4f}' for t, f, mf in upper_failures[:5])
    )
    assert not lower_failures, (
        'zero-evidence fan_lower drifted from model_fan_lower:\n'
        + '\n'.join(f'tau={t}: fan={f:.4f} model={mf:.4f}' for t, f, mf in lower_failures[:5])
    )


def test_v3_empty_frames_window_mode_uses_latency_curve():
    """D2: empty-frame fallback must still follow the subject CDF.

    If the `fe is None` latency branch collapses to bare `p.mean`, this
    test fails because the midpoint becomes flat in τ instead of tracing
    `p × CDF_X→Y(τ)`.
    """
    graph = _build_single_edge_graph(latency_parameter=True)
    anchor_day = '2026-03-01'
    rows = _run_v3(
        graph=graph,
        frames=[],
        anchor_from=anchor_day,
        anchor_to=anchor_day,
        sweep_to=anchor_day,
        is_window=True,
        axis_tau_max=40,
    )

    assert rows, 'v3 returned no rows for empty-frame window fallback'
    by_tau = {row['tau_days']: row for row in rows}
    assert by_tau[0]['midpoint'] == pytest.approx(0.0, abs=1e-6)
    assert by_tau[10]['midpoint'] > by_tau[6]['midpoint'] > by_tau[0]['midpoint']
    assert by_tau[20]['midpoint'] > by_tau[10]['midpoint']

    checked = 0
    failures: List[Tuple[int, float, float]] = []
    for tau in (6, 8, 10, 15, 20, 30):
        row = by_tau[tau]
        midpoint = row.get('midpoint')
        if midpoint is None:
            continue
        expected = 0.80 * _shifted_lognormal_cdf(
            tau,
            onset=3.0,
            mu=2.0,
            sigma=0.6,
        )
        if expected < 0.01:
            continue
        checked += 1
        if abs(midpoint - expected) > 0.05:
            failures.append((tau, midpoint, expected))

    assert checked >= 4, f'checked only {checked} tau points'
    assert not failures, (
        'empty-frame window fallback drifted from p × CDF_X→Y(τ):\n'
        + '\n'.join(
            f'tau={tau}: midpoint={mid:.4f} expected={exp:.4f}'
            for tau, mid, exp in failures[:5]
        )
    )


def test_v3_empty_frames_window_mode_matches_truth_lognormal_curve():
    """D2 hardening: the zero-evidence window path should match truth-CDF.

    Use the single-edge `m4-delegated -> m4-registered` truth from
    `synth-mirror-4step` as a fixed analytic oracle, but drive the v3
    zero-evidence branch through an inline graph so the assertion is
    about the runner contract, not about snapshot/CLI plumbing.
    """
    truth = _load_truth_edge_params(
        graph_name='synth-mirror-4step',
        edge_name='m4-delegated-to-registered',
    )
    graph = _build_single_edge_graph(
        p_mean=truth['p'],
        alpha=truth['p'] * 1000.0,
        beta=(1.0 - truth['p']) * 1000.0,
        mu=truth['mu'],
        sigma=truth['sigma'],
        onset=truth['onset'],
        t95=_approx_shifted_lognormal_t95(
            onset=truth['onset'],
            mu=truth['mu'],
            sigma=truth['sigma'],
        ),
        latency_parameter=True,
    )
    anchor_day = '2026-03-01'
    rows = _run_v3(
        graph=graph,
        frames=[],
        anchor_from=anchor_day,
        anchor_to=anchor_day,
        sweep_to=anchor_day,
        is_window=True,
        axis_tau_max=35,
    )

    assert rows, 'v3 returned no rows for truth-backed zero-evidence fixture'
    by_tau = {row['tau_days']: row for row in rows}

    midpoint_failures: List[Tuple[int, float, float]] = []
    model_failures: List[Tuple[int, float, float]] = []
    checked = 0
    for tau in range(36):
        row = by_tau[tau]
        midpoint = row.get('midpoint')
        model_midpoint = row.get('model_midpoint')
        if midpoint is None or model_midpoint is None:
            continue
        expected = truth['p'] * _shifted_lognormal_cdf(
            tau,
            onset=truth['onset'],
            mu=truth['mu'],
            sigma=truth['sigma'],
        )
        checked += 1
        if abs(midpoint - expected) > 0.001:
            midpoint_failures.append((tau, midpoint, expected))
        if abs(model_midpoint - expected) > 0.001:
            model_failures.append((tau, model_midpoint, expected))

    assert checked >= 30, f'checked only {checked} tau points'
    assert not midpoint_failures, (
        'truth-backed zero-evidence midpoint drifted from analytic p × CDF:\n'
        + '\n'.join(
            f'tau={tau}: midpoint={mid:.6f} expected={exp:.6f}'
            for tau, mid, exp in midpoint_failures[:5]
        )
    )
    assert not model_failures, (
        'truth-backed zero-evidence model_midpoint drifted from analytic p × CDF:\n'
        + '\n'.join(
            f'tau={tau}: model_midpoint={mid:.6f} expected={exp:.6f}'
            for tau, mid, exp in model_failures[:5]
        )
    )


def test_v3_empty_frames_cohort_mode_preserves_upstream_carrier():
    """D2: empty-frame cohort fallback must stay slower than window.

    With upstream latency on A→X, `cohort(A, X-Y)` should not collapse
    onto `window(X-Y)` when there is no frame evidence at all. The
    zero-evidence fallback still has to respect the factorised
    `carrier_to_x` role.
    """
    graph = _build_two_edge_latency_graph()
    anchor_day = '2026-03-01'

    window_rows = _run_v3(
        graph=graph,
        frames=[],
        anchor_from=anchor_day,
        anchor_to=anchor_day,
        sweep_to=anchor_day,
        is_window=True,
        axis_tau_max=40,
        target_edge_id='e-bc',
        query_from_node='node-b',
        query_to_node='node-c',
    )
    cohort_rows = _run_v3(
        graph=graph,
        frames=[],
        anchor_from=anchor_day,
        anchor_to=anchor_day,
        sweep_to=anchor_day,
        is_window=False,
        axis_tau_max=40,
        target_edge_id='e-bc',
        query_from_node='node-b',
        query_to_node='node-c',
        anchor_node_id='node-a',
    )

    assert window_rows, 'window fallback returned no rows'
    assert cohort_rows, 'cohort fallback returned no rows'

    window_by_tau = {row['tau_days']: row for row in window_rows}
    cohort_by_tau = {row['tau_days']: row for row in cohort_rows}

    strong_gaps: List[Tuple[int, float, float]] = []
    for tau in range(8, 21, 2):
        window_mid = window_by_tau[tau].get('midpoint')
        cohort_mid = cohort_by_tau[tau].get('midpoint')
        if window_mid is None or cohort_mid is None:
            continue
        if window_mid > 0.10 and cohort_mid < window_mid - 0.05:
            strong_gaps.append((tau, window_mid, cohort_mid))

    assert len(strong_gaps) >= 3, (
        'cohort empty-frame fallback lost the upstream-carrier lag:\n'
        + '\n'.join(
            f'tau={tau}: window={w:.4f} cohort={c:.4f}'
            for tau, w, c in strong_gaps[:5]
        )
    )

    cohort_progression = [
        cohort_by_tau[tau]['midpoint']
        for tau in (8, 12, 16, 20)
        if cohort_by_tau[tau].get('midpoint') is not None
    ]
    assert cohort_progression == sorted(cohort_progression), (
        'cohort empty-frame fallback should still rise with tau'
    )


def test_v3_empty_frames_cohort_mode_matches_truth_fw_curve():
    """Hard invariant: simple-chain cohort should track FW path truth.

    On a two-edge A→B→C chain with no evidence at all, the cohort
    `model_midpoint`/`midpoint` for `from(B).to(C)` should approximate
    the truth-backed FW-composed A→C latency curve times the target
    edge's `p`.
    """
    upstream_truth = _load_truth_edge_params(
        graph_name='synth-simple-abc',
        edge_name='simple-a-to-b',
    )
    target_truth = _load_truth_edge_params(
        graph_name='synth-simple-abc',
        edge_name='simple-b-to-c',
    )
    graph = _build_two_edge_latency_graph(
        upstream_p=upstream_truth['p'],
        upstream_mu=upstream_truth['mu'],
        upstream_sigma=upstream_truth['sigma'],
        upstream_onset=upstream_truth['onset'],
        target_p=target_truth['p'],
        target_mu=target_truth['mu'],
        target_sigma=target_truth['sigma'],
        target_onset=target_truth['onset'],
    )
    anchor_day = '2026-03-01'
    rows = _run_v3(
        graph=graph,
        frames=[],
        anchor_from=anchor_day,
        anchor_to=anchor_day,
        sweep_to=anchor_day,
        is_window=False,
        axis_tau_max=25,
        target_edge_id='e-bc',
        query_from_node='node-b',
        query_to_node='node-c',
        anchor_node_id='node-a',
    )

    assert rows, 'v3 returned no rows for empty-frame truth-backed cohort fixture'
    by_tau = {row['tau_days']: row for row in rows}
    expected_curve = _fw_truth_curve_from_edges(
        upstream=upstream_truth,
        target=target_truth,
        tau_max=25,
    )

    midpoint_failures: List[Tuple[int, float, float]] = []
    model_failures: List[Tuple[int, float, float]] = []
    checked = 0
    for tau in range(12, 21):
        expected = expected_curve[tau]
        row = by_tau[tau]
        midpoint = row.get('midpoint')
        model_midpoint = row.get('model_midpoint')
        if midpoint is None or model_midpoint is None or expected < 0.005:
            continue
        checked += 1
        if abs(midpoint - expected) > 0.025:
            midpoint_failures.append((tau, midpoint, expected))
        if abs(model_midpoint - expected) > 0.025:
            model_failures.append((tau, model_midpoint, expected))

    assert checked >= 7, f'checked only {checked} FW-backed tau points'
    assert not midpoint_failures, (
        'truth-backed empty-frame cohort midpoint drifted from FW path oracle:\n'
        + '\n'.join(
            f'tau={tau}: midpoint={mid:.6f} expected={exp:.6f}'
            for tau, mid, exp in midpoint_failures[:5]
        )
    )
    assert not model_failures, (
        'truth-backed empty-frame cohort model_midpoint drifted from FW path oracle:\n'
        + '\n'.join(
            f'tau={tau}: model_midpoint={mid:.6f} expected={exp:.6f}'
            for tau, mid, exp in model_failures[:5]
        )
    )
