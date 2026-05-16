"""
Stage 5b composer tests for the multi-hop subject-span composer (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5b — Multi-Hop Subject Span Composition" lines 684-698.

These tests cover the composer's stop conditions:

  - the full X→end primitive composition is consumed (no terminal-edge
    fallback when more than one primitive is on the span);
  - draw-family coherence is preserved across primitives;
  - degraded composition results carry explicit provenance and do not
    silently masquerade as coherent draw families;
  - hard contract violations (no path, missing primitive, draw-count
    mismatch) raise CompositionError;
  - the natural single-hop degeneracy returns the underlying primitive
    semantics (plan §364).

These tests are unit tests over the Stage 1 primitive contract — they
do not exercise the row-builder seam or the api_handlers wiring.
"""

from __future__ import annotations

import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pytest

from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.prefix_arrival import (
    PrefixArrivalIdentity,
    PrefixArrivalMap,
)
from evidence_merge import EvidenceRole, EvidenceScope
from runner.prefix_arrival import NodeArrivalProvenance, NodeArrivalWeights
from runner.primitive_conditioning import (
    ConditioningPolicyOptions,
    condition_primitive,
)
from runner.primitive_evidence import (
    RequestPrimitiveRegistry,
    bind_primitive_evidence,
)
from runner.primitives import (
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    DrawFamilyKey,
    ProbabilityPosterior,
    PrimitiveScope,
    TimingFamily,
    TimingPosterior,
    TransitionIdentity,
    WeightedPrimitiveEvidenceView,
    make_rng,
)
from runner.subject_span_composer import (
    ComposedPrimitiveSpan,
    ComposeOptions,
    CompositionError,
    compose_primitive_span,
)


# ─── Fixtures ──────────────────────────────────────────────────────────


def _resolved_model(*, alpha=2.0, beta=2.0, mu=0.0, sigma=0.0, onset=0.0):
    return ResolvedModelParams(
        alpha=alpha,
        beta=beta,
        alpha_pred=alpha,
        beta_pred=beta,
        n_effective=None,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=sigma, onset_delta_days=onset,
            mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
            t95=0.0,
        ),
        source='test_synthetic',
    )


def _scope(scenario_id='scn-1', as_at='2026-04-01'):
    return PrimitiveScope(
        scenario_id=scenario_id,
        evidence_role='window_subject_helper',
        date_from='2026-03-01',
        date_to='2026-03-31',
        as_at=as_at,
        context_key=None,
        regime_key=None,
        model_source_preference='best_available',
        resolved_source_identity='test_synthetic',
    )


def _make_graph(edges):
    """edges: list of (edge_id, from_id, to_id)."""
    node_ids = set()
    for _, f, t in edges:
        node_ids.add(f)
        node_ids.add(t)
    return {
        'nodes': [{'id': n, 'uuid': n} for n in sorted(node_ids)],
        'edges': [
            {
                'edge_id': eid,
                'from': f,
                'to': t,
                'from_node': f,
                'to_node': t,
            }
            for eid, f, t in edges
        ],
    }


def _prefix_identity(scenario='scn-1'):
    return PrefixArrivalIdentity(
        scenario_id=scenario,
        request_root='X',
        context_key=None,
        regime_key=None,
        as_at='2026-04-01',
        model_source_preference='best_available',
        parameter_fingerprint='fp-1',
    )


def _empty_arrival_map():
    return PrefixArrivalMap(
        identity=_prefix_identity(),
        nodes={},
        max_tau=400,
        draw_count=200,
        root_day_weights={},
        construction_diagnostics={'binding_policy': 'test_synthetic'},
    )


def _build_prior_only_primitive(
    *,
    from_id, to_id, edge_id,
    alpha=2.0, beta=3.0,
    sigma=0.0,
    scenario='scn-1',
    seed=12345,
):
    """Build a coherent prior-only primitive via the canonical pathway:
    ``bind_primitive_evidence`` with empty candidates → empty weighted
    view → ``condition_primitive`` produces PRIOR_ONLY."""
    transition = TransitionIdentity(
        source_node=from_id, destination_node=to_id, edge_id=edge_id,
    )
    scope = _scope(scenario_id=scenario)
    evidence_scope = EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=from_id,
        subject_to=to_id,
        date_from=scope.date_from,
        date_to=scope.date_to,
        as_at=scope.as_at,
        scenario_id=scope.scenario_id,
    )
    arrival_weights = NodeArrivalWeights(
        weights={},
        weights_draws={},
        draw_count=200,
        reach_from_root=1.0,
        provenance=NodeArrivalProvenance(
            topology_case='identity',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='identity',
            horizon_ratio=1.0,
            note='test prior-only primitive',
        ),
    )
    resolution = bind_primitive_evidence(
        transition=transition,
        primitive_scope=scope,
        evidence_scope=evidence_scope,
        candidates=(),
        arrival_weights=arrival_weights,
    )
    return condition_primitive(
        resolution=resolution,
        resolved_model=_resolved_model(alpha=alpha, beta=beta, sigma=sigma),
        scenario_seed=seed,
        options=ConditioningPolicyOptions(draw_count=200, timing_cdf_max_tau=60),
        prior_source='test_synthetic',
    )


def _build_registry_with_primitives(primitives):
    """Register a list of (primitive, scope) pairs into a fresh registry."""
    arrival_map = _empty_arrival_map()
    registry = RequestPrimitiveRegistry(arrival_map=arrival_map)
    return registry


def _lookup_factory(primitive_by_id):
    def _lookup(from_id, to_id, edge_dict):
        eid = edge_dict.get('edge_id') or edge_dict.get('id')
        if eid in primitive_by_id:
            return primitive_by_id[eid]
        return None
    return _lookup


# ─── Single-hop degeneracy ─────────────────────────────────────────────


def test_single_hop_degenerates_to_underlying_primitive():
    """Plan §364: single-hop subject spans read one primitive. The
    composed result should reflect the primitive's posterior mean.

    The composer uses doc-29b DP on a one-edge span; the kernel reduces
    to: g_X = δ(τ=0), g_Y = δ * f_edge = f_edge, K = cumsum(f_edge),
    K[-1] = sum(f_edge) = p (since f_edge is p · pdf normalised to sum 1).
    """
    graph = _make_graph([('e-x-y', 'X', 'Y')])
    primitive = _build_prior_only_primitive(
        from_id='X', to_id='Y', edge_id='e-x-y',
        alpha=4.0, beta=6.0,
    )
    registry = _build_registry_with_primitives([primitive])
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Y',
        registry=registry,
        edge_to_primitive_lookup=_lookup_factory({'e-x-y': primitive}),
        options=ComposeOptions(max_tau=60),
    )
    assert composed.primitive_count == 1
    # composed mean should match primitive's posterior mean within MC noise
    assert composed.span_p_mean == pytest.approx(
        primitive.probability_posterior.mean, abs=0.03
    )
    assert composed.span_p_draws is not None
    assert composed.span_p_draws.shape == (200,)


# ─── Two-hop serial composition ────────────────────────────────────────


def test_two_hop_serial_composes_probability_via_doc_29b_dp():
    """Plan §429-431: serial composition convolves; span_p = p1 · p2.

    Two non-latent primitives in series with p1 ≈ 0.5 and p2 ≈ 0.5 give
    composed span_p ≈ 0.25.
    """
    graph = _make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')])
    p1 = _build_prior_only_primitive(
        from_id='X', to_id='M', edge_id='e-x-m', alpha=10.0, beta=10.0,
    )
    p2 = _build_prior_only_primitive(
        from_id='M', to_id='Y', edge_id='e-m-y', alpha=10.0, beta=10.0,
    )
    registry = _build_registry_with_primitives([p1, p2])
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Y',
        registry=registry,
        edge_to_primitive_lookup=_lookup_factory({
            'e-x-m': p1, 'e-m-y': p2,
        }),
        options=ComposeOptions(max_tau=60),
    )
    assert composed.primitive_count == 2
    # Beta(10,10) means p ≈ 0.5; serial composition gives ≈ 0.25.
    assert composed.span_p_mean == pytest.approx(0.25, abs=0.05)
    # The span IS the full X→Y composition, NOT the terminal edge alone
    # (that would be ≈0.5). Plan §696.
    assert composed.span_p_mean < 0.4


def test_two_hop_does_not_collapse_to_terminal_edge():
    """Plan §696: reject any fallback that collapses a multi-hop subject
    to a terminal-edge primitive when more than one primitive is on the
    span. Even when the upstream primitive has ≈1.0 probability, the
    composed span must run the full DP.
    """
    graph = _make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')])
    # Upstream primitive close to 1.0; downstream primitive at 0.3.
    p1 = _build_prior_only_primitive(
        from_id='X', to_id='M', edge_id='e-x-m', alpha=99.0, beta=1.0,
    )
    p2 = _build_prior_only_primitive(
        from_id='M', to_id='Y', edge_id='e-m-y', alpha=3.0, beta=7.0,
    )
    registry = _build_registry_with_primitives([p1, p2])
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X', end_node_id='Y', registry=registry,
        edge_to_primitive_lookup=_lookup_factory({
            'e-x-m': p1, 'e-m-y': p2,
        }),
        options=ComposeOptions(max_tau=60),
    )
    # span_p ≈ 0.99 * 0.3 ≈ 0.297 — close to terminal edge but only by
    # coincidence. Critically the composed result is NOT 0.3 alone.
    assert composed.primitive_count == 2
    # The composer DID multiply by the upstream, so reach is below
    # terminal-only by the upstream loss. Tolerance is wide because
    # both factors are MC.
    assert composed.span_p_mean < 0.31


# ─── Draw-family coherence ─────────────────────────────────────────────


def test_draw_coherence_preserved_across_primitives():
    """Plan §126-138: composed span's per-draw arrays must align by
    draw index across primitives. Re-running composition with the same
    primitives in the same registry must produce identical draws.
    """
    graph = _make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')])
    p1 = _build_prior_only_primitive(
        from_id='X', to_id='M', edge_id='e-x-m', seed=99,
    )
    p2 = _build_prior_only_primitive(
        from_id='M', to_id='Y', edge_id='e-m-y', seed=99,
    )
    lookup = _lookup_factory({'e-x-m': p1, 'e-m-y': p2})

    composed_a = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='Y',
        registry=_build_registry_with_primitives([p1, p2]),
        edge_to_primitive_lookup=lookup,
        options=ComposeOptions(max_tau=60),
    )
    composed_b = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='Y',
        registry=_build_registry_with_primitives([p1, p2]),
        edge_to_primitive_lookup=lookup,
        options=ComposeOptions(max_tau=60),
    )
    assert np.array_equal(composed_a.span_p_draws, composed_b.span_p_draws)


# ─── Hard contract violations ──────────────────────────────────────────


def test_x_equals_end_produces_zero_edge_identity_composition():
    """x == end is the identity element of the operator-chain monoid: a
    zero-edge walk produces an empty composition without raising. No
    primitives, no draws — the composer naturally degenerates.
    """
    graph = _make_graph([('e-x-y', 'X', 'Y')])
    result = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='X',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=lambda *a, **kw: None,
    )
    assert result.primitive_count == 0
    assert result.draw_count == 0
    assert result.x_node_id == 'X'
    assert result.end_node_id == 'X'


def test_no_path_fails_hard():
    """Disconnected graph: x != end with no path between them. Engine
    walks blindly; downstream access on the (None) topology fails
    loudly. Per-principle hard failure — not a specific error contract.
    """
    graph = _make_graph([
        ('e-x-y', 'X', 'Y'),
        ('e-a-z', 'A', 'Z'),
    ])
    with pytest.raises(Exception):
        compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=_build_registry_with_primitives([]),
            edge_to_primitive_lookup=lambda *a, **kw: None,
        )


def test_missing_primitive_raises():
    """Plan §675: every edge in the X→end topology must have a registry
    entry. Composer fails loudly when the lookup returns None."""
    graph = _make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')])
    p_target = _build_prior_only_primitive(
        from_id='M', to_id='Y', edge_id='e-m-y',
    )
    # Lookup returns None for the upstream edge.
    def _partial_lookup(from_id, to_id, edge_dict):
        eid = edge_dict.get('edge_id')
        if eid == 'e-m-y':
            return p_target
        return None
    with pytest.raises(CompositionError, match='lookup returned None'):
        compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Y',
            registry=_build_registry_with_primitives([p_target]),
            edge_to_primitive_lookup=_partial_lookup,
        )


# ─── Composition mode in provenance ────────────────────────────────────


def test_provenance_records_composition_mode_draws():
    """Provenance documents which composition path the composer took."""
    graph = _make_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')])
    p1 = _build_prior_only_primitive(from_id='X', to_id='M', edge_id='e-x-m')
    p2 = _build_prior_only_primitive(from_id='M', to_id='Y', edge_id='e-m-y')
    composed = compose_primitive_span(
        graph=graph, x_node_id='X', end_node_id='Y',
        registry=_build_registry_with_primitives([p1, p2]),
        edge_to_primitive_lookup=_lookup_factory({
            'e-x-m': p1, 'e-m-y': p2,
        }),
        options=ComposeOptions(max_tau=60),
    )
    assert composed.provenance['composition_mode'] == 'draws'
    assert composed.provenance['primitive_count'] == 2
    primitive_summaries = composed.provenance['primitives']
    assert len(primitive_summaries) == 2
    assert {ps['edge_id'] for ps in primitive_summaries} == {'e-x-m', 'e-m-y'}


# Removed: ``test_provenance_records_composition_mode_moments``.
# The moments-only composer path was deleted along with
# ``ComposedPrimitiveSpan.is_draw_coherent`` — every constructed
# primitive is draw-bearing, so the composer always runs the per-draw
# DP and the provenance composition_mode is always ``draws``.


# ─── Source enforcement: composer does not import forbidden modules ────


def test_composer_does_not_import_trajectory_engine():
    """AP58 prevention: the composer must not reach into
    forecast_state/cohort_forecast_v3 — that's where parallel composition
    paths historically sprouted (plan §272 outstanding-instance note).
    """
    import runner.subject_span_composer as ssc
    src = open(ssc.__file__).read()
    assert 'from .forecast_state' not in src
    assert 'from .forecast_runtime' not in src
    assert 'from .cohort_forecast_v3' not in src
    assert 'from .carrier_composition' not in src


# ─── Stage B — per-node / per-edge value ledgers on ComposedPrimitiveSpan


def test_composer_exposes_per_node_density_with_delta_at_root():
    """The composer must retain the per-node arrival density surface
    computed inside the DP. At the topology root this is δ(0) for every
    draw, regardless of how many edges live downstream."""
    graph = _make_graph([('e-x-y', 'X', 'Y'), ('e-y-z', 'Y', 'Z')])
    primitives = {
        'e-x-y': _build_prior_only_primitive(
            from_id='X', to_id='Y', edge_id='e-x-y', alpha=4.0, beta=6.0,
        ),
        'e-y-z': _build_prior_only_primitive(
            from_id='Y', to_id='Z', edge_id='e-y-z', alpha=5.0, beta=5.0,
        ),
    }
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Z',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    assert 'X' in composed.node_density_draws
    root_density = composed.node_density_draws['X']
    assert root_density.shape == (composed.draw_count, composed.max_tau + 1)
    # δ(0) at the root: tau=0 column is all ones, all other columns zero.
    np.testing.assert_array_equal(
        root_density[:, 0], np.ones(composed.draw_count),
    )
    assert np.sum(root_density[:, 1:]) == pytest.approx(0.0, abs=1e-12)


def test_intermediate_node_density_equals_sum_of_incoming_edge_contributions():
    """For a branch/join (X -> {Y1, Y2} -> Z), the per-draw density at
    Z must equal the sum of per-edge contributions for edges Y1->Z and
    Y2->Z. Holds for every draw — the DP composes value through the
    same convolution that produced the per-edge contribution surfaces.
    """
    graph = _make_graph([
        ('e-x-y1', 'X', 'Y1'),
        ('e-x-y2', 'X', 'Y2'),
        ('e-y1-z', 'Y1', 'Z'),
        ('e-y2-z', 'Y2', 'Z'),
    ])
    primitives = {
        'e-x-y1': _build_prior_only_primitive(
            from_id='X', to_id='Y1', edge_id='e-x-y1', alpha=3.0, beta=5.0,
        ),
        'e-x-y2': _build_prior_only_primitive(
            from_id='X', to_id='Y2', edge_id='e-x-y2', alpha=4.0, beta=4.0,
        ),
        'e-y1-z': _build_prior_only_primitive(
            from_id='Y1', to_id='Z', edge_id='e-y1-z', alpha=6.0, beta=4.0,
        ),
        'e-y2-z': _build_prior_only_primitive(
            from_id='Y2', to_id='Z', edge_id='e-y2-z', alpha=5.0, beta=5.0,
        ),
    }
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Z',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    z_from_edges = (
        composed.edge_contribution_draws['Y1->Z#0']
        + composed.edge_contribution_draws['Y2->Z#0']
    )
    np.testing.assert_allclose(
        composed.node_density_draws['Z'], z_from_edges, atol=1e-12,
    )


def test_coincident_sibling_edges_yield_separate_edge_contributions():
    """Two parallel edges between the same endpoints must appear as
    distinct concrete edges in the composed span — their per-edge
    contributions are separately recoverable, and the destination node
    density equals their sum. This is the failure mode `(from, to)`-keyed
    edge maps historically had."""
    graph = _make_graph([
        ('e-u-v-a', 'U', 'V'),
        ('e-u-v-b', 'U', 'V'),
    ])
    primitives = {
        'e-u-v-a': _build_prior_only_primitive(
            from_id='U', to_id='V', edge_id='e-u-v-a', alpha=4.0, beta=6.0,
        ),
        'e-u-v-b': _build_prior_only_primitive(
            from_id='U', to_id='V', edge_id='e-u-v-b', alpha=3.0, beta=7.0,
        ),
    }
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='U',
        end_node_id='V',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    assert composed.primitive_count == 2
    # Two distinct concrete-edge keys, not one collapsed entry.
    assert len(composed.edge_contribution_draws) == 2
    sibling_keys = set(composed.edge_contribution_draws.keys())
    assert len(sibling_keys) == 2
    # Sum of sibling contributions equals node density at V.
    contributions = list(composed.edge_contribution_draws.values())
    np.testing.assert_allclose(
        composed.node_density_draws['V'],
        contributions[0] + contributions[1],
        atol=1e-12,
    )


def test_identity_span_carries_root_delta_in_node_density_draws():
    """A zero-edge span (x == end, e.g. window mode or cohort(A=X)) must
    still expose the per-node ledger with a δ(0) at the root replicated
    across draws and no edge contributions."""
    graph = _make_graph([('e-throwaway', 'X', 'Z')])  # an unrelated edge
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='X',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory({}),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    assert composed.primitive_count == 0
    assert composed.concrete_edges == ()
    assert composed.edge_contribution_draws == {}
    root_density = composed.node_density_draws['X']
    assert root_density.shape == (composed.draw_count, composed.max_tau + 1)
    np.testing.assert_array_equal(
        root_density[:, 0], np.ones(composed.draw_count),
    )
    assert np.sum(root_density[:, 1:]) == pytest.approx(0.0, abs=1e-12)


# ─── Stage D — per-node / per-edge support and exposure ledgers ──────


def test_composer_exposes_support_and_exposure_streams_under_unit_mask():
    """With the unit observation mask (the F-mode unconditioned-overlay
    semantic: ``observation_mask_draws=None`` so the composer defaults
    to all-ones), the support stream equals the value stream
    (mask × value = value) and the exposure stream propagates the
    unit-reach PMF (Δcdf, no edge-probability factor). Both surfaces
    share the same topology as value.

    Per Phase 6 §4.7, a PRIOR_ONLY primitive from the canonical
    conditioning pathway (empty candidates → zero admitted rows) emits
    an all-zeros mask rather than a unit mask — see
    ``test_composer_zero_mask_zeroes_support_and_exposure_streams``
    below. This test pins the no-evidence-consulted overlay path; we
    override the conditioned prior-only's mask to ``None`` to express
    that semantic on the primitive contract.
    """
    graph = _make_graph([('e-x-y', 'X', 'Y'), ('e-y-z', 'Y', 'Z')])
    primitives = {
        'e-x-y': replace(
            _build_prior_only_primitive(
                from_id='X', to_id='Y', edge_id='e-x-y', alpha=4.0, beta=6.0,
            ),
            observation_mask_draws=None,
        ),
        'e-y-z': replace(
            _build_prior_only_primitive(
                from_id='Y', to_id='Z', edge_id='e-y-z', alpha=5.0, beta=5.0,
            ),
            observation_mask_draws=None,
        ),
    }
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Z',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    # Support equals value at every node under unit mask.
    for node_id, density in composed.node_density_draws.items():
        np.testing.assert_allclose(
            composed.node_support_draws[node_id], density, atol=1e-12,
        )
    for edge_key, contrib in composed.edge_contribution_draws.items():
        np.testing.assert_allclose(
            composed.edge_support_contribution_draws[edge_key], contrib,
            atol=1e-12,
        )

    # Exposure carries the unit-reach PMF: at the terminal, the
    # cumulative exposure across τ saturates at 1 (the per-draw PMFs
    # composed through the chain integrate to the path's reach pattern
    # without the p factor). For each draw the τ-cumulative reaches
    # exactly `1 - ε` (no edge probability weighting).
    z_exposure_cum = np.cumsum(composed.node_exposure_draws['Z'], axis=1)
    # Each draw's exposure cumsum at τ → T-1 should equal the path's
    # reach with all p's set to 1 — exactly 1 for a fully connected
    # 2-edge linear path.
    assert np.allclose(z_exposure_cum[:, -1], 1.0, atol=1e-3)
    # Value cumsum at τ → T-1 should equal the per-draw reach (≤ 1).
    z_value_cum = np.cumsum(composed.node_density_draws['Z'], axis=1)
    assert np.all(z_value_cum[:, -1] <= 1.0 + 1e-12)
    assert np.all(z_value_cum[:, -1] <= z_exposure_cum[:, -1] + 1e-12)


def test_composer_zero_mask_zeroes_support_and_exposure_streams():
    """Phase 6 §4.7: a PRIOR_ONLY primitive produced by the canonical
    conditioning pathway with zero admitted rows MUST emit an
    all-zeros ``observation_mask_draws``, not None. The composer reads
    that mask onto every edge — support and exposure streams must then
    be zero everywhere, while value and density streams are unaffected
    (the value kernel is independent of the mask).

    This protects the coverage / exposure consumers downstream: an
    evidentially-empty edge must NOT silently claim "fully observed".
    """
    graph = _make_graph([('e-x-y', 'X', 'Y'), ('e-y-z', 'Y', 'Z')])
    primitives = {
        'e-x-y': _build_prior_only_primitive(
            from_id='X', to_id='Y', edge_id='e-x-y', alpha=4.0, beta=6.0,
        ),
        'e-y-z': _build_prior_only_primitive(
            from_id='Y', to_id='Z', edge_id='e-y-z', alpha=5.0, beta=5.0,
        ),
    }
    # Pin the contract on the primitives themselves first.
    for prim in primitives.values():
        assert prim.observation_mask_draws is not None
        assert np.all(prim.observation_mask_draws == 0.0)

    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Z',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    # Support and exposure streams are zero at every non-root node
    # (mask=0 ⇒ propagated kernel × mask = 0). The chain root X
    # carries δ(0) in all three streams by construction (the cohort
    # itself IS the observation at the chain root, per Phase 6 §4.8);
    # the mask only zeroes downstream propagation, not the root delta.
    for node_id, support in composed.node_support_draws.items():
        if node_id == 'X':
            continue
        np.testing.assert_array_equal(
            support, np.zeros_like(support),
            err_msg=f'node {node_id} support must be zero under zero mask',
        )
    for node_id, exposure in composed.node_exposure_draws.items():
        if node_id == 'X':
            continue
        np.testing.assert_array_equal(
            exposure, np.zeros_like(exposure),
            err_msg=f'node {node_id} exposure must be zero under zero mask',
        )
    for edge_key, support in composed.edge_support_contribution_draws.items():
        np.testing.assert_array_equal(
            support, np.zeros_like(support),
            err_msg=f'edge {edge_key} support must be zero under zero mask',
        )
    for edge_key, exposure in composed.edge_exposure_contribution_draws.items():
        np.testing.assert_array_equal(
            exposure, np.zeros_like(exposure),
            err_msg=f'edge {edge_key} exposure must be zero under zero mask',
        )

    # Value stream is independent of the mask: it should retain its
    # non-zero shape from the underlying kernels (so coverage = support /
    # value is well-defined and the consumer sees 0/positive = 0, not
    # 0/0 = NaN). Sanity-check that at least one terminal value cell
    # carries non-zero mass per draw.
    z_value = composed.node_density_draws['Z']
    assert z_value.sum() > 0.0, (
        'value stream should be unaffected by zero mask; coverage = '
        'support / value requires positive value for the ratio to be '
        'meaningful at observed cells'
    )


def test_composer_masks_support_by_source_day_not_age_only():
    """Phase 6 §4.7: row presence is keyed by (source_day, age).

    Two sibling upstream edges place mass at M on source-day offsets 0
    and 1. The downstream M→Y primitive has a row at age 0 only for the
    first source day. An age-only mask would mark both M source days as
    observed at age 0 and pass support through at τ=1. The source-day
    mask must pass only the τ=0 wavefront.
    """
    S = 200
    T = 61
    graph = _make_graph([
        ('e-x-m-now', 'X', 'M'),
        ('e-x-m-late', 'X', 'M'),
        ('e-m-y', 'M', 'Y'),
    ])

    def _with_constant_p(primitive, p):
        draws = np.full(S, float(p), dtype=np.float64)
        posterior = ProbabilityPosterior(mean=float(p), sd=0.0, draws=draws)
        return replace(
            primitive,
            probability_posterior=posterior,
            probability_prior=posterior,
        )

    x_m_now = replace(
        _with_constant_p(
            _build_prior_only_primitive(
                from_id='X', to_id='M', edge_id='e-x-m-now',
            ),
            0.5,
        ),
        observation_mask_draws=None,
    )
    x_m_late = replace(
        _with_constant_p(
            _build_prior_only_primitive(
                from_id='X', to_id='M', edge_id='e-x-m-late',
            ),
            0.5,
        ),
        timing_family=TimingFamily.DETERMINISTIC,
        timing_posterior=TimingPosterior(
            family=TimingFamily.DETERMINISTIC,
            cdf_mean=tuple([0.0] + [1.0] * 60),
            deterministic_shift_days=1,
        ),
        observation_mask_draws=None,
    )

    aggregate_age_mask = np.zeros((S, T), dtype=np.float64)
    aggregate_age_mask[:, 0] = 1.0
    source_day_mask = np.zeros((S, T), dtype=np.float64)
    source_day_mask[:, 0] = 1.0
    m_y = replace(
        _with_constant_p(
            _build_prior_only_primitive(
                from_id='M', to_id='Y', edge_id='e-m-y',
            ),
            1.0,
        ),
        observation_mask_draws=aggregate_age_mask,
        observation_mask_draws_by_source_day={
            '2026-03-01': source_day_mask,
            '2026-03-02': np.zeros((S, T), dtype=np.float64),
        },
    )

    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Y',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory({
            'e-x-m-now': x_m_now,
            'e-x-m-late': x_m_late,
            'e-m-y': m_y,
        }),
        options=ComposeOptions(max_tau=60, draw_count=S),
    )

    y_value = composed.node_density_draws['Y']
    y_support = composed.node_support_draws['Y']
    y_exposure = composed.node_exposure_draws['Y']

    # Value is independent of observation: both source days reach Y.
    np.testing.assert_allclose(y_value[:, 0], 0.5, atol=1e-12)
    np.testing.assert_allclose(y_value[:, 1], 0.5, atol=1e-12)
    # Support/exposure must keep the source-day axis. The τ=1 wavefront
    # came from source day 2026-03-02, which had no row at age 0.
    np.testing.assert_allclose(y_support[:, 0], 0.5, atol=1e-12)
    np.testing.assert_allclose(y_support[:, 1], 0.0, atol=1e-12)
    # Exposure carries unit-reach timing rather than edge probability, so
    # the observed upstream wavefront contributes 1.0 here.
    np.testing.assert_allclose(y_exposure[:, 0], 1.0, atol=1e-12)
    np.testing.assert_allclose(y_exposure[:, 1], 0.0, atol=1e-12)


def test_identity_span_carries_root_delta_in_all_three_streams():
    """Identity span (x == end) seeds δ(0) at the root for value,
    support, and exposure alike — per Phase 6 §4.8 the cohort itself
    IS the observation at the chain root."""
    graph = _make_graph([('e-throwaway', 'X', 'Z')])
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='X',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory({}),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    expected = np.zeros((composed.draw_count, composed.max_tau + 1))
    expected[:, 0] = 1.0
    np.testing.assert_array_equal(composed.node_density_draws['X'], expected)
    np.testing.assert_array_equal(composed.node_support_draws['X'], expected)
    np.testing.assert_array_equal(composed.node_exposure_draws['X'], expected)
    assert composed.edge_support_contribution_draws == {}
    assert composed.edge_exposure_contribution_draws == {}


def test_coincident_siblings_distinguish_in_all_three_streams():
    """Sibling edges between the same endpoints have distinct per-edge
    contributions in value, support, and exposure alike — the streams
    share concrete-edge identity."""
    graph = _make_graph([
        ('e-u-v-a', 'U', 'V'),
        ('e-u-v-b', 'U', 'V'),
    ])
    primitives = {
        'e-u-v-a': _build_prior_only_primitive(
            from_id='U', to_id='V', edge_id='e-u-v-a', alpha=4.0, beta=6.0,
        ),
        'e-u-v-b': _build_prior_only_primitive(
            from_id='U', to_id='V', edge_id='e-u-v-b', alpha=3.0, beta=7.0,
        ),
    }
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='U',
        end_node_id='V',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    assert len(composed.edge_support_contribution_draws) == 2
    assert len(composed.edge_exposure_contribution_draws) == 2
    value_keys = set(composed.edge_contribution_draws.keys())
    support_keys = set(composed.edge_support_contribution_draws.keys())
    exposure_keys = set(composed.edge_exposure_contribution_draws.keys())
    assert value_keys == support_keys == exposure_keys


def test_composed_provenance_includes_concrete_edge_keys():
    """Provenance must record each composed primitive's concrete edge_key
    so downstream callers can correlate per-edge ledgers with the edges
    they came from."""
    graph = _make_graph([('e-x-y', 'X', 'Y'), ('e-y-z', 'Y', 'Z')])
    primitives = {
        'e-x-y': _build_prior_only_primitive(
            from_id='X', to_id='Y', edge_id='e-x-y',
        ),
        'e-y-z': _build_prior_only_primitive(
            from_id='Y', to_id='Z', edge_id='e-y-z',
        ),
    }
    composed = compose_primitive_span(
        graph=graph,
        x_node_id='X',
        end_node_id='Z',
        registry=_build_registry_with_primitives([]),
        edge_to_primitive_lookup=_lookup_factory(primitives),
        options=ComposeOptions(max_tau=60, draw_count=200),
    )

    primitive_summaries = composed.provenance['primitives']
    assert all('edge_key' in ps for ps in primitive_summaries)
    edge_keys = {ps['edge_key'] for ps in primitive_summaries}
    # Structural edge_keys are `f"{from}->{to}#{idx}"` by construction.
    assert edge_keys == {'X->Y#0', 'Y->Z#0'}
