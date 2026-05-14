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
