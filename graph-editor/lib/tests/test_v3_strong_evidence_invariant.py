"""v3 IS-tempering strong-evidence invariant.

Under strong evidence, the v3 conditioned posterior should track the
evidence rate and not stay anchored to the prior. The test sets up a
synthetic Beta(40, 10) prior (mean 0.80) and 18 cohorts × 300 exposures
of rate 0.50, then asserts that the v3 midpoint at maturity is within
0.10 of the evidence rate.

The synthetic frames place cohort anchors at
`[anchor_to, anchor_to - 2d, …, anchor_to - 34d]`, so the call must
pass `anchor_from = earliest cohort anchor` and `anchor_to = latest
cohort anchor` for the runtime to admit all 18 cohorts. Earlier
fixture revisions used `anchor_from == anchor_to`, which silently
admitted only one cohort and made the midpoint hover near the prior;
that regression is documented in
[`cohort-outside-in-post-73n-regression-tracker.md`](../../../docs/current/cohort-outside-in-post-73n-regression-tracker.md)
§"IS-tempering — strong-evidence over-influence (synthetic witness)".
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3


def _build_synth_graph():
    """Build a single-edge graph with strong model params."""
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
                'id': 'synth-strong-evidence',
                'forecast': {'mean': 0.80},
                'latency': {
                    'mu': 2.0,
                    'sigma': 0.6,
                    'onset_delta_days': 3.0,
                    't95': 30.0,
                    'promoted_t95': 30.0,
                    'mu_sd': 0.1,
                    'sigma_sd': 0.05,
                    'onset_sd': 1.0,
                    'onset_mu_corr': -0.5,
                },
                'posterior': {
                    'alpha': 40.0,
                    'beta': 10.0,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {
                        'mu': 2.0, 'sigma': 0.6,
                        'onset_delta_days': 3.0,
                        'mu_sd': 0.1, 'sigma_sd': 0.05,
                        'onset_sd': 1.0,
                    },
                    'probability': {'mean': 0.80},
                }],
            },
        }],
    }


def _build_synth_frames(n_cohorts=18, n_per_cohort=300, true_rate=0.50, sweep_days=38):
    """Build synthetic frames mimicking strong evidence.

    Each frame is a snapshot at a different date. Each cohort starts on a
    different anchor_day and is observed at sweep_to. The observed rate
    (y/x) is ~true_rate, much lower than the prior (0.80). This forces IS
    conditioning to pull the midpoint down.
    """
    import random
    random.seed(42)

    anchor_to = date(2026, 3, 1)
    anchor_from = anchor_to - timedelta(days=(n_cohorts - 1) * 2)
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

    return frames, anchor_from.isoformat(), anchor_to.isoformat(), sweep_to.isoformat()


def test_strong_evidence_midpoint_near_observed_rate():
    """v3 midpoint at maturity must reflect the evidence, not the prior.

    Under strong evidence (18 cohorts × 300 exposures, observed rate 50%
    vs prior 80%), the IS-conditioned midpoint at large τ (where CDF≈1)
    should be near the observed rate (~50%), not the prior (~80%).

    This test catches weak IS tempering: if λ is too low, the posterior
    stays near the prior and the midpoint line visibly diverges from the
    evidence in the chart.
    """
    graph = _build_synth_graph()
    frames, anchor_from, anchor_to, sweep_to = _build_synth_frames()

    v3_rows = compute_cohort_maturity_rows_v3(
        scenario_id='strong-evidence-test',
        frames=frames,
        graph=graph,
        target_edge_id='e1',
        query_from_node='node-a',
        query_to_node='node-b',
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=True,
        band_level=0.90,
    )

    assert len(v3_rows) > 0, 'v3 returned no rows'

    # At maturity (large τ, CDF≈1), midpoint ≈ conditioned p.
    # With strong evidence (rate=0.50), the conditioned p should
    # be pulled toward 0.50, not stay at prior 0.80.
    mature_rows = [r for r in v3_rows
                   if r.get('midpoint') is not None
                   and r['tau_days'] >= 30]
    assert len(mature_rows) > 0, 'No mature rows with midpoint'

    mature_midpoints = [r['midpoint'] for r in mature_rows]
    avg_midpoint = sum(mature_midpoints) / len(mature_midpoints)

    mature_evidence = [r for r in v3_rows
                       if r.get('rate') is not None
                       and r['tau_days'] >= 30]
    if mature_evidence:
        avg_evidence = sum(r['rate'] for r in mature_evidence) / len(mature_evidence)
    else:
        avg_evidence = 0.50

    print(f"\nStrong evidence conditioning test:")
    print(f"  Prior p:          0.80")
    print(f"  True rate:        0.50")
    print(f"  Avg evidence:     {avg_evidence:.4f}")
    print(f"  Avg v3 midpoint:  {avg_midpoint:.4f}")
    print(f"  Gap from evidence:{abs(avg_midpoint - avg_evidence):.4f}")

    assert abs(avg_midpoint - avg_evidence) < 0.10, (
        f"v3 midpoint at maturity ({avg_midpoint:.4f}) is too far "
        f"from evidence ({avg_evidence:.4f}). Gap={abs(avg_midpoint - avg_evidence):.4f}. "
        f"IS tempering is likely too weak — the posterior is stuck "
        f"near the prior (0.80) instead of being pulled toward the "
        f"evidence (0.50)."
    )
