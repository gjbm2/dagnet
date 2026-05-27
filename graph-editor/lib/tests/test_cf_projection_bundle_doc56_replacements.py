"""Phase 2 (73q) — projection-bundle replacements for doc56 claims.

The doc56 reassignment ledger (73q plan §"Doc56 Reassignment Ledger")
assigns three of the seven doc-56 claims to Phase 2 projection-bundle
integration tests, which assert the same properties at bundle level
(cheaper, sharper) than the original chart-row / two-pipeline tests:

  - ``test_query_scoped_identity_carrier_collapses_public_evidence_basis``
    → identity-carrier degeneracy at bundle level;
  - ``test_whole_graph_cf_is_invariant_under_edge_reorder``
    → bundle determinism under graph edge permutation;
  - ``test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split``
    → multi-hop subject-span preservation (the upstream edge is composed
    in, not collapsed to the terminal edge).

These author the replacement coverage so the doc-56 file can be deleted
once Phase 5a's surprise-gauge replacement also exists (deletion is a
later, cross-phase step — not Phase 2 closure).
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import build_cf_projection_bundle

from test_cohort_maturity_v3_contract import (  # noqa: E402
    _build_single_edge_graph,
    _build_two_edge_latency_graph,
)


class TestIdentityCarrierDegeneracyAtBundleLevel:
    """Replaces test_query_scoped_identity_carrier_collapses_public_evidence_basis.

    ``window()`` has the selected population already rooted at X, so the
    carrier degenerates to the identity data case: ``population_root ==
    denominator_node`` and the composed carrier is a zero-edge identity
    span (``x_node == end_node``, reach 1.0, no primitives) — the
    carrier convolution is a pass-through, not a separate route
    (I-45/I-46; FORECAST_RUNTIME_ARCHITECTURE §4).
    """

    def test_window_bundle_has_identity_carrier(self):
        graph = _build_single_edge_graph(latency_parameter=True)
        bundle = build_cf_projection_bundle(
            frames=[],
            graph=graph,
            target_edge_id='e1',
            query_from_node='node-a',
            query_to_node='node-b',
            anchor_from='2026-03-01',
            anchor_to='2026-03-01',
            sweep_to='2026-03-01',
            is_window=True,
            scenario_id='doc56-identity',
        )
        assert bundle is not None
        assert str(bundle.runtime.population_root) == str(
            bundle.runtime.denominator_node,
        )
        carrier = bundle.runtime.composed_carrier
        # Identity degeneracy: a zero-edge pass-through span at X.
        assert carrier.x_node_id == carrier.end_node_id
        assert carrier.primitive_count == 0
        assert carrier.span_p_mean == pytest.approx(1.0)


class TestBundleInvariantUnderEdgeReorder:
    """Replaces test_whole_graph_cf_is_invariant_under_edge_reorder.

    The bundle builder is deterministic under graph edge-list permutation:
    composition order is topological and draw families are scope-keyed, so
    reordering the ``edges`` list must not change the projection."""

    def _bundle_for(self, graph):
        return build_cf_projection_bundle(
            frames=[],
            graph=graph,
            target_edge_id='e-bc',
            query_from_node='node-a',
            query_to_node='node-c',
            anchor_from='2026-03-01',
            anchor_to='2026-03-01',
            sweep_to='2026-03-01',
            is_window=True,
            is_multi_hop=True,
            axis_tau_max=40,
            scenario_id='doc56-reorder',
        )

    def test_projection_identical_under_edge_reorder(self):
        graph = _build_two_edge_latency_graph()
        reordered = {
            'nodes': list(graph['nodes']),
            'edges': list(reversed(graph['edges'])),
        }
        b1 = self._bundle_for(graph)
        b2 = self._bundle_for(reordered)
        assert b1 is not None and b2 is not None
        np.testing.assert_array_equal(
            b1.selected_projection.ef_x_draws,
            b2.selected_projection.ef_x_draws,
        )
        np.testing.assert_array_equal(
            b1.selected_projection.ef_y_draws,
            b2.selected_projection.ef_y_draws,
        )
        np.testing.assert_array_equal(
            b1.selected_projection.f_rate_draws,
            b2.selected_projection.f_rate_draws,
        )


class TestMultiHopSubjectSpanPreservation:
    """Replaces test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split.

    A multi-hop subject span ``X → … → Z`` must compose the intermediate
    edge, not collapse to the terminal edge. With a non-trivial upstream
    ``p`` the composed subject reach for ``window(a → c)`` is the compound
    ``p_ab · p_bc``, materially below the terminal-only ``window(b → c)``
    reach ``p_bc``."""

    def _subject_reach(self, *, query_from, query_to, is_multi_hop):
        graph = _build_two_edge_latency_graph(
            upstream_p=0.70, target_p=0.80,
        )
        bundle = build_cf_projection_bundle(
            frames=[],
            graph=graph,
            target_edge_id='e-bc',
            query_from_node=query_from,
            query_to_node=query_to,
            anchor_from='2026-03-01',
            anchor_to='2026-03-01',
            sweep_to='2026-03-01',
            is_window=True,
            is_multi_hop=is_multi_hop,
            axis_tau_max=40,
            scenario_id='doc56-multihop',
        )
        assert bundle is not None
        return float(np.mean(bundle.runtime.composed_subject.span_p_draws))

    def test_multihop_reach_is_compound_not_terminal(self):
        multihop = self._subject_reach(
            query_from='node-a', query_to='node-c', is_multi_hop=True,
        )
        terminal = self._subject_reach(
            query_from='node-b', query_to='node-c', is_multi_hop=False,
        )
        # Terminal-only reaches ≈ p_bc = 0.80; multi-hop composes the
        # upstream edge so reach ≈ p_ab · p_bc = 0.56 — materially lower.
        assert multihop < terminal - 0.05
        assert multihop == pytest.approx(0.70 * 0.80, abs=0.12)
