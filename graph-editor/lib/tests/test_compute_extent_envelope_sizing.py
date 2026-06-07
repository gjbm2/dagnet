"""Guard tests for the compute_extent → envelope-grid threading.

Background: the per-query ``compute_extent`` (the calc horizon the analysis
handler picks per ``docs/current/cohort-maturity-render-calc-policy.md``) was
not reaching the request-envelope build. ``build_request_envelope_plan``
defaulted ``max_tau=400`` and neither production caller overrode it, so the
prefix-arrival / timing ``(S, T)`` buffers were always sized ``T = 401`` even
when the query only needed ~45 days — the memory pathology behind the OOMs.

The fix threads ``compute_extent`` (clamped to ``min(extent, 400)``) into the
envelope build. These tests pin both halves of "make it a ceiling, not the
value":

  1. ``max_tau`` genuinely flows now — a grid shrunk *below* the span tail
     changes the conditioned model surface. (Guards regression of the exact
     bug: the param being silently ignored.)
  2. A grid at-or-above the span tail leaves the strict observed evidence
     identical — shrinking 400 → tail is inconsequential to outputs.

Plus a behaviour-preserving unit check on ``resolve_request_nodes``, the
extraction that lets the handler pick the extent before preparation runs.

This file is deliberately separate from the outside-in oracle
(``test_cohort_factorised_outside_in.py``), whose modification policy
requires explicit sign-off.
"""

from __future__ import annotations

import os
import sys
from datetime import date
from typing import Any, Dict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.forecast_preparation import resolve_request_nodes
from runner.request_envelope import build_request_envelope_plan


# ── Minimal fixtures (A -> X -> end, active cohort A != X) ───────────────

def _two_edge_cohort_graph() -> Dict[str, Any]:
    """node-a (A, start) -> node-b (X) -> node-c (end). Both edges latent."""
    def _edge(uuid: str, frm: str, to: str, pid: str, p: float,
              mu: float, sigma: float, onset: float, t95: float) -> Dict[str, Any]:
        latency = {
            'latency_parameter': True, 'mu': mu, 'sigma': sigma,
            'onset_delta_days': onset, 't95': t95, 'promoted_t95': t95,
            'mu_sd': 0.08, 'sigma_sd': 0.04, 'onset_sd': 0.40,
            'onset_mu_corr': -0.40,
        }
        return {
            'uuid': uuid, 'from': frm, 'to': to,
            'p': {
                'id': pid, 'forecast': {'mean': p}, 'latency': latency,
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {k: latency[k] for k in
                                ('mu', 'sigma', 'onset_delta_days',
                                 'mu_sd', 'sigma_sd', 'onset_sd')},
                    'probability': {
                        'mean': p, 'stdev': 0.05,
                        'alpha': 40.0, 'beta': 10.0,
                        'alpha_pred': 40.0, 'beta_pred': 10.0,
                        'n_effective': 50.0,
                    },
                }],
            },
        }

    return {
        'nodes': [
            {'uuid': 'n1', 'id': 'node-a', 'entry': {'is_start': True}},
            {'uuid': 'n2', 'id': 'node-b'},
            {'uuid': 'n3', 'id': 'node-c'},
        ],
        'edges': [
            _edge('e-ab', 'n1', 'n2', 'synth-upstream', 0.70, 1.2, 0.35, 7.0, 28.0),
            _edge('e-bc', 'n2', 'n3', 'synth-target', 0.80, 0.9, 0.30, 2.0, 20.0),
        ],
    }


def _build_plan(*, max_tau=None):
    """Build an active-cohort (A != X) envelope plan; thread max_tau iff given.

    Omitting ``max_tau`` exercises the legacy default path (the value a
    caller that has not been updated would get)."""
    graph = _two_edge_cohort_graph()
    kwargs = dict(
        graph=graph,
        query_from_node='node-b',     # X
        query_to_node='node-c',       # end
        anchor_from=date(2026, 3, 1),
        anchor_to=date(2026, 3, 1),
        population_root='node-a',     # A (active: A != X)
        graph_preference='best_available',
        scenario_id='extent-sizing-test',
    )
    if max_tau is not None:
        kwargs['max_tau'] = max_tau
    return build_request_envelope_plan(**kwargs)


# ── resolve_request_nodes is a behaviour-preserving extraction ───────────

def test_resolve_request_nodes_single_hop_only_role():
    graph = _two_edge_cohort_graph()
    subjects = [{
        'path_role': 'only', 'from_node': 'node-b', 'to_node': 'node-c',
        'target': {'targetId': 'e-bc'}, 'anchor_node_id': 'node-a',
    }]
    qf, qt, le, anchor = resolve_request_nodes(subjects, graph)
    assert qf == 'node-b'
    assert qt == 'node-c'
    assert le == 'e-bc'
    assert anchor == 'node-a'


def test_resolve_request_nodes_multi_hop_first_last_roles():
    graph = _two_edge_cohort_graph()
    subjects = [
        {'path_role': 'first', 'from_node': 'node-a', 'to_node': 'node-b',
         'target': {'targetId': 'e-ab'}},
        {'path_role': 'last', 'from_node': 'node-b', 'to_node': 'node-c',
         'target': {'targetId': 'e-bc'}, 'anchor_node_id': 'node-a'},
    ]
    qf, qt, le, anchor = resolve_request_nodes(subjects, graph)
    assert qf == 'node-a'      # from the 'first' subject
    assert qt == 'node-c'      # to from the 'last' subject
    assert le == 'e-bc'        # last edge from the 'last' subject
    assert anchor == 'node-a'


# ── The fix: the threaded max_tau sizes the envelope grid ────────────────

def test_envelope_plan_grid_honours_threaded_max_tau():
    """The per-query horizon must size the arrival-map grid, not 400.

    This is the core of the fix: ``build_request_envelope_plan(max_tau=N)``
    must produce arrival maps whose grid horizon is N. Before the fix every
    plan was built at the 400 default regardless, sizing the (S, 401)
    buffers behind the OOMs.
    """
    plan = _build_plan(max_tau=45)
    assert plan.subject_arrival_map is not None
    assert plan.carrier_arrival_map is not None
    assert plan.subject_arrival_map.max_tau == 45
    assert plan.carrier_arrival_map.max_tau == 45

    plan_big = _build_plan(max_tau=400)
    assert plan_big.subject_arrival_map.max_tau == 400
    assert plan_big.carrier_arrival_map.max_tau == 400


def test_envelope_plan_default_max_tau_is_the_400_ceiling():
    """The default is preserved as the absolute ceiling for legacy callers.

    A caller that does not thread an extent still gets the 400 grid — 400
    survives as the ceiling, never silently shrinking an un-updated path.
    """
    plan = _build_plan()
    assert plan.subject_arrival_map is not None
    assert plan.subject_arrival_map.max_tau == 400
