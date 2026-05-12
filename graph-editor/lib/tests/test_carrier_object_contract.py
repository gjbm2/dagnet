"""Carrier-object contract tests against the post-73n runtime factory.

Pins the live runtime-factory contract for the carrier object returned by
``forecast_runtime.build_x_provider_from_graph``:

- window mode short-circuits to an inactive carrier;
- cohort mode with anchor == target.from (A = X) short-circuits identically;
- A != X chains compute reach as the topological product of upstream edge
  probabilities;
- all-non-latency A != X chains enable the carrier (post-Stage-3 gate:
  ``reach > 0 and A != X``, independent of whether any upstream edge is
  latency-bearing).

Scope: v3 runtime factory only.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest


def _make_carrier_graph(edges):
    """Build a minimal graph for carrier-contract testing.

    Each ``spec`` is a tuple
        (uuid, from_uuid, to_uuid, from_id, to_id, p_mean, mu, sigma, onset)

    A ``sigma`` of 0 marks an edge as structurally non-latency (no timing
    shape). The synth fixture populates both the legacy ``p.mean`` /
    ``p.latency.{mu,sigma,onset_delta_days}`` and the analytic
    ``model_vars`` block so ``resolve_model_params`` succeeds.
    """
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id, p_mean, mu, sigma, onset in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        is_latency = sigma > 0
        edge_list.append({
            'uuid': uuid,
            'from': from_u,
            'to': to_u,
            'p': {
                'id': f'param-{uuid}',
                'mean': p_mean,
                'stdev': 0.05,
                'forecast': {'mean': p_mean},
                'latency': {
                    'latency_parameter': is_latency,
                    'mu': mu,
                    'sigma': sigma,
                    'onset_delta_days': onset,
                    'promoted_mu': mu,
                    'promoted_sigma': sigma,
                    'promoted_onset_delta_days': onset,
                    'promoted_mu_sd': 0.1 if is_latency else 0.0,
                    'promoted_sigma_sd': 0.05 if is_latency else 0.0,
                    'promoted_onset_sd': 0.2 if is_latency else 0.0,
                    'promoted_onset_mu_corr': -0.3 if is_latency else 0.0,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': p_mean, 'stdev': 0.05},
                    'latency': {'mu': mu, 'sigma': sigma, 'onset_delta_days': onset},
                }],
            },
        })
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _build_provider(graph, target_edge_uuid, anchor_id, *, is_window):
    from runner.forecast_runtime import (
        build_x_provider_from_graph,
        find_edge_by_id,
    )

    target_edge = find_edge_by_id(graph, target_edge_uuid)
    assert target_edge is not None, f"target edge {target_edge_uuid!r} not found"
    return build_x_provider_from_graph(
        graph,
        target_edge,
        anchor_node_id=anchor_id,
        is_window=is_window,
    )


def test_window_mode_returns_inactive_carrier():
    """Window mode must short-circuit the carrier regardless of upstream shape.

    The factory's first guard (``if is_window or target_edge is None``)
    returns an XProvider with ``reach=0`` and ``enabled=False``. This is
    the identity-carrier degeneration for window mode (carrier collapses
    to no-op; row builder treats X as the population root).
    """
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 2.0, 0.5, 0.0),
    ])
    provider = _build_provider(graph, 'e-b-c', anchor_id='A', is_window=True)

    assert provider.enabled is False
    assert provider.reach == 0.0
    assert provider.upstream_params_list == []
    assert provider.ingress_carrier is None


def test_a_equals_x_cohort_returns_inactive_carrier():
    """cohort() with A=X must produce identity carrier semantics.

    The semantic gate ``has_semantic_upstream_latency`` returns False
    when ``anchor == target`` (forecast_runtime.py:799-800), so the
    factory disables the carrier. The row builder then runs without an
    upstream dependency — equivalent to window for the denominator.
    """
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 2.0, 0.5, 0.0),
    ])
    # cohort(B, …) on edge B→C: anchor == target_edge.from_node.
    provider = _build_provider(graph, 'e-b-c', anchor_id='B', is_window=False)

    assert provider.enabled is False, (
        "A=X cohort must produce identity carrier (enabled=False); "
        f"got enabled={provider.enabled!r}"
    )


def test_a_not_x_topological_reach_is_product_of_upstream_probabilities():
    """Multi-edge upstream path must compute reach topologically.

    A multi-edge upstream path computes reach as the topological product
    of edge probabilities along A → … → X. The factory does this via a
    topo walk using ``_resolve_edge_p`` — independent of whether the
    chain is latency-bearing.
    """
    # A → B (p=0.6, latent) → C (p=0.5, latent) → D (target.from = C)
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 2.0, 0.5, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.7, 2.2, 0.6, 0.0),
    ])
    provider = _build_provider(graph, 'e-c-d', anchor_id='A', is_window=False)

    expected_reach = 0.6 * 0.5
    assert provider.reach == pytest.approx(expected_reach, abs=1e-9), (
        f"expected topological reach A→C = 0.6 × 0.5 = {expected_reach}, "
        f"got {provider.reach}"
    )
    assert provider.enabled is True, (
        "all-latent A!=X chain should enable the carrier under any "
        "post-Stage-3 gate (reach > 0 and A != X)"
    )


def test_a_not_x_all_non_latency_chain_must_enable_carrier():
    """Post-Stage-3 gate: all-non-latency A != X chain must enable the carrier.

    The gate is ``reach > 0 and A != X``, independent of whether any
    upstream edge is latency-bearing.
    """
    # All edges non-latency (sigma = 0). Topological reach A → C is
    # 0.8 × 0.7 = 0.56, which is positive. Plan-mandated post-Stage-3 result:
    # carrier is enabled because A != X and reach > 0.
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.8, 0.0, 0.0, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.7, 0.0, 0.0, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.5, 1.5, 0.4, 0.0),
    ])
    provider = _build_provider(graph, 'e-c-d', anchor_id='A', is_window=False)

    assert provider.reach == pytest.approx(0.8 * 0.7, abs=1e-9)
    assert provider.enabled is True, (
        "all-non-latency A != X chain must enable the carrier "
        "(post-Stage-3 gate); reach > 0 and A != X is the only requirement"
    )
