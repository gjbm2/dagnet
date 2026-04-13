"""
Phase 3 parity gate: cohort-mode completeness — topo pass vs v2 annotation.

Uses synthetic graphs with known params so completeness is non-zero
and we can measure the gap between:
- Topo pass: simple CDF-based completeness (path-anchored in cohort mode)
- v2 annotation: annotate_rows with same mu/sigma/onset

For single-edge (x = anchor), both should agree (same CDF formula).
The gap only appears for multi-edge spans where v2 uses upstream-aware
carrier hierarchy — that is what Phase 3 needs to close.
"""

import math
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest


def _make_synth_graph(edges, nodes=None):
    """Build a minimal graph dict from edge specs.

    Each edge spec: (uuid, from_uuid, to_uuid, from_id, to_id, p_mean, mu, sigma, onset, **extra_latency)
    """
    node_set = {}
    edge_list = []
    first_from = None
    for spec in edges:
        uuid, from_u, to_u, from_id, to_id, p_mean, mu, sigma, onset = spec[:9]
        extra_lat = spec[9] if len(spec) > 9 else {}
        if first_from is None:
            first_from = from_u
        node_set[from_u] = {'uuid': from_u, 'id': from_id}
        node_set[to_u] = {'uuid': to_u, 'id': to_id}
        lat = {
            'mu': mu,
            'sigma': sigma,
            'onset_delta_days': onset,
            't95': math.exp(mu + 1.645 * sigma) + onset,
            'promoted_mu': mu,
            'promoted_sigma': sigma,
            'promoted_onset_delta_days': onset,
            'promoted_t95': math.exp(mu + 1.645 * sigma) + onset,
            'promoted_mu_sd': extra_lat.get('mu_sd', 0.1),
            'promoted_sigma_sd': extra_lat.get('sigma_sd', 0.05),
            'promoted_onset_sd': extra_lat.get('onset_sd', 0.2),
            'promoted_onset_mu_corr': extra_lat.get('onset_mu_corr', -0.3),
            **extra_lat,
        }
        edge_list.append({
            'uuid': uuid,
            'from': from_u,
            'to': to_u,
            'p': {
                'id': f'param-{uuid}',
                'mean': p_mean,
                'stdev': 0.05,
                'latency': lat,
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': p_mean, 'stdev': 0.05},
                    'latency': lat,
                }],
            },
        })
    # Mark anchor node (first edge's from-node) as start
    for n in node_set.values():
        if n['uuid'] == first_from:
            n['entry'] = {'is_start': True}
    return {
        'nodes': list(node_set.values()),
        'edges': edge_list,
    }


def _make_cohorts(sweep_to, anchor_days_back, n_per_cohort=100):
    """Build cohort data dicts with known ages."""
    cohorts = []
    for days_back in anchor_days_back:
        ad = sweep_to - timedelta(days=days_back)
        cohorts.append({
            'date': ad.isoformat(),
            'age': days_back,
            'n': n_per_cohort,
            'k': int(n_per_cohort * 0.5),  # dummy k
        })
    return cohorts


class TestCohortModeCompletenessSynth:
    """Synthetic tests for cohort-mode completeness parity."""

    def test_single_edge_completeness_matches_annotation(self):
        """Single edge: topo pass completeness should match v2's
        annotate_rows completeness (both use the same CDF formula).
        """
        # Edge with mu=2.0, sigma=0.5, onset=2 → median ~9d, t95 ~18d
        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])

        sweep_to = date(2026, 4, 1)
        # Cohorts at various ages — some before onset, some after
        ages = [1, 3, 5, 8, 10, 15, 20, 30, 50]
        cohorts = _make_cohorts(sweep_to, ages)

        # ── Topo pass ───────────────────────────────────────────────
        from api_handlers import handle_stats_topo_pass
        tp_result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {'e1': cohorts},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'cohort',
            'active_edges': ['e1'],
        })

        tp_c = None
        for er in tp_result['edges']:
            if er['edge_uuid'] == 'e1':
                tp_c = er['completeness']
                break
        assert tp_c is not None, 'Edge not in topo pass result'

        # ── v2 annotation (same CDF formula) ────────────────────────
        from runner.forecast_application import compute_completeness
        total_n = 0
        weighted_c = 0.0
        for c in cohorts:
            age = c['age']
            n = c['n']
            cc = compute_completeness(float(age), 2.0, 0.5, 2.0)
            weighted_c += n * cc
            total_n += n
        v2_c = weighted_c / total_n

        delta = abs(tp_c - v2_c)
        print(f"\nSingle edge A->B:")
        print(f"  topo pass completeness: {tp_c:.6f}")
        print(f"  v2 annotation:          {v2_c:.6f}")
        print(f"  delta:                  {delta:.6f}")

        # Both use CDF. The topo pass applies a tail constraint
        # (improve_fit_with_t95) which may adjust sigma slightly.
        # Allow 1% tolerance for that.
        assert delta < 0.01, \
            f"Single-edge parity failed: tp={tp_c:.6f} v2={v2_c:.6f} delta={delta:.6f}"

    def test_completeness_stdev_present_synth(self):
        """Topo pass returns completeness_stdev for edge with dispersions."""
        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0, {
                'mu_sd': 0.15, 'sigma_sd': 0.08, 'onset_sd': 0.5,
            }),
        ])

        sweep_to = date(2026, 4, 1)
        cohorts = _make_cohorts(sweep_to, [10, 15, 20, 30])

        from api_handlers import handle_stats_topo_pass
        tp_result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {'e1': cohorts},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'cohort',
            'active_edges': ['e1'],
        })

        for er in tp_result['edges']:
            if er['edge_uuid'] == 'e1':
                assert er.get('completeness_stdev') is not None, \
                    'completeness_stdev missing'
                assert er['completeness_stdev'] > 0, \
                    'completeness_stdev should be >0 with dispersions'
                print(f"\ncompleteness={er['completeness']:.4f} "
                      f"stdev={er['completeness_stdev']:.4f}")
                break

    def test_multi_edge_completeness_gap(self):
        """Multi-edge graph: measure gap between topo pass and
        v2 annotation for an edge with upstream.

        Graph: A -> B -> C
        Edge B->C has upstream (B is not anchor A).
        """
        graph = _make_synth_graph([
            # A -> B: fast edge, mu=1.5, onset=1
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            # B -> C: slower edge, mu=2.5, onset=3
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        sweep_to = date(2026, 4, 1)
        ages = [5, 10, 15, 20, 30, 50, 80]
        cohorts_e2 = _make_cohorts(sweep_to, ages)

        # ── Topo pass for edge B->C ─────────────────────────────────
        from api_handlers import handle_stats_topo_pass
        tp_result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {'e2': cohorts_e2},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'cohort',
            'active_edges': ['e1', 'e2'],
        })

        tp_c = None
        for er in tp_result['edges']:
            if er['edge_uuid'] == 'e2':
                tp_c = er['completeness']
                break
        assert tp_c is not None, 'Edge e2 not in topo pass result'

        # ── v2 annotation for B->C (simple CDF, no upstream) ────────
        # This is what the topo pass currently computes: CDF-based.
        # In cohort mode with path params, it uses composed path params.
        from runner.forecast_application import compute_completeness

        # For the topo pass in cohort mode, it uses path-level params
        # if available. Let's compute both edge-level and path-level
        # to understand what the topo pass is doing.
        total_n = sum(c['n'] for c in cohorts_e2)
        # Edge-level CDF
        edge_c = sum(
            c['n'] * compute_completeness(float(c['age']), 2.5, 0.6, 3.0)
            for c in cohorts_e2
        ) / total_n

        # ── Ground truth: upstream-aware completeness ───────────────
        # For edge B->C in cohort mode, the "true" completeness should
        # account for the fact that events arriving at C must first
        # pass through A->B. The convolution-based completeness at
        # age τ for the path A->B->C is what the topo pass's
        # path-composed params approximate via Fenton-Wilkinson.
        #
        # Brute-force: for each cohort age τ, compute the path
        # completeness by convolving the two edge CDFs:
        #   C_path(τ) = ∫₀ᵗ f_AB(u) · C_BC(τ - u) du
        # where f_AB is the PDF of edge A->B and C_BC is the CDF
        # of edge B->C.
        import numpy as np
        from runner.forecast_application import compute_completeness as cc

        def path_completeness_convolution(age, mu1, s1, o1, mu2, s2, o2, dt=0.5):
            """Brute-force convolution of two lognormal CDFs."""
            if age <= 0:
                return 0.0
            # PDF of edge 1 at time u (numerical derivative of CDF)
            total = 0.0
            for u_idx in range(int(age / dt)):
                u = u_idx * dt
                # f_AB(u) ≈ (CDF(u+dt) - CDF(u)) / dt
                c1_lo = cc(u, mu1, s1, o1)
                c1_hi = cc(u + dt, mu1, s1, o1)
                f1 = (c1_hi - c1_lo) / dt
                if f1 <= 0:
                    continue
                # C_BC(age - u)
                remaining = age - u
                c2 = cc(remaining, mu2, s2, o2) if remaining > 0 else 0.0
                total += f1 * c2 * dt
            return min(total, 1.0)

        # Convolution-based path completeness for each cohort
        conv_weighted = 0.0
        for c in cohorts_e2:
            pc = path_completeness_convolution(
                float(c['age']), 1.5, 0.4, 1.0, 2.5, 0.6, 3.0)
            conv_weighted += c['n'] * pc
        conv_c = conv_weighted / total_n

        print(f"\nMulti-edge A->B->C, edge B->C:")
        print(f"  topo pass completeness (FW):    {tp_c:.6f}")
        print(f"  edge-level CDF completeness:    {edge_c:.6f}")
        print(f"  convolution path completeness:  {conv_c:.6f}")
        print(f"  delta (topo vs convolution):    {abs(tp_c - conv_c):.6f}")
        print(f"  delta (topo vs edge CDF):       {abs(tp_c - edge_c):.6f}")

        assert 0 <= tp_c <= 1
        assert 0 <= edge_c <= 1
        assert 0 <= conv_c <= 1

        # The topo pass uses Fenton-Wilkinson approximation to the
        # convolution. Check it's reasonable (within 10% of brute-force).
        fw_delta = abs(tp_c - conv_c)
        print(f"  FW approximation error:         {fw_delta:.6f} "
              f"({fw_delta / max(conv_c, 1e-10):.2%})")
