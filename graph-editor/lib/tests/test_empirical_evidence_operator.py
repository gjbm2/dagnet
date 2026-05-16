"""Empirical evidence operator — Atom 2.2 focused tests.

Plan: docs/current/project-generalise/selected-cohort-projection-cutover-plan.md
§"Atom 2.2 — Write the new empirical evidence operator".

These tests pin the operator's per-edge kernel construction and the
two-operator separation contract. The broader algebraic invariants
(Phase 6 §6.1 / §6.2 / §5.6 decompositions) are tested in
``test_model_span_spine_selected_cohort.py`` (Atom 2.4).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, timedelta

import numpy as np
import pytest

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
)
from runner.empirical_evidence_operator import (
    EmpiricalEvidencePrimitive,
    build_empirical_evidence_primitive,
    compose_empirical_span,
)
from runner.prefix_arrival import NodeArrivalProvenance, NodeArrivalWeights
from runner.primitives import PrimitiveScope, TransitionIdentity


# ─── Fixtures ──────────────────────────────────────────────────────────


def _scope(scenario_id: str = 'scn-empirical') -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id=scenario_id,
        evidence_role='window_subject_helper',
        date_from='2026-03-01',
        date_to='2026-04-01',
        as_at='2026-04-30',
        context_key=None,
        regime_key=None,
        model_source_preference='analytic',
        resolved_source_identity=None,
        selected_anchor_days=(),
    )


def _arrival_weights(
    weights_by_day: dict[str, float],
    *,
    draw_count: int = 2,
) -> NodeArrivalWeights:
    weights = dict(weights_by_day)
    weights_draws = {
        day: np.full(int(draw_count), float(w), dtype=np.float64)
        for day, w in weights.items()
    }
    return NodeArrivalWeights(
        weights=weights,
        weights_draws=weights_draws,
        draw_count=int(draw_count),
        reach_from_root=1.0,
        provenance=NodeArrivalProvenance(
            topology_case='identity',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='identity',
            horizon_ratio=1.0,
            note='test fixture',
        ),
    )


def _evidence_scope(from_id: str, to_id: str, scope: PrimitiveScope) -> EvidenceScope:
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=from_id,
        subject_to=to_id,
        date_from=scope.date_from,
        date_to=scope.date_to,
        as_at=scope.as_at,
        scenario_id=scope.scenario_id,
    )


def _candidate(
    *,
    from_id: str,
    to_id: str,
    observed_date: str,
    retrieved_at: str,
    n: int,
    k: int,
) -> EvidenceCandidate:
    """Build a minimal admissible candidate for the merge layer."""
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=from_id,
            subject_to=to_id,
            anchor=None,
            slice_family=SliceFamily.WINDOW,
            context_key=None,
            regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.UNKNOWN,
            asat_materialised=False,
        ),
        n=n,
        k=k,
        provenance={'source': 'test_fixture'},
    )


# ─── Per-edge primitive: kernel construction ──────────────────────────


def test_empirical_primitive_single_source_day_recovers_observed_curve():
    """One source day with rows at ages 0, 5, 10 → forward-filled
    cumulative k/n, differenced into the per-τ rate kernel. Saturation
    at τ = horizon-1 equals the latest observed k/n."""
    transition = TransitionIdentity(
        source_node='U', destination_node='V', edge_id='e-uv',
    )
    scope = _scope()
    arrival = _arrival_weights({'2026-03-15': 1.0}, draw_count=4)

    # k grows 0 → 2 → 5 → 8 over ages 0, 5, 10. n = 10 throughout.
    candidates = [
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-15', n=10, k=0,
        ),
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-20', n=10, k=2,
        ),
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-25', n=10, k=5,
        ),
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-31', n=10, k=8,  # age 16
        ),
    ]

    primitive = build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=candidates,
        draw_count=4,
        horizon_len=20,
    )

    assert primitive.value_kernel_draws.shape == (4, 20)
    assert primitive.observation_mask_draws.shape == (4, 20)
    assert primitive.saturation_per_draw.shape == (4,)

    # All draws share the same kernel under the deterministic
    # arrival-weight assumption — broadcast preserves shape symmetry
    # with the conditioned operator without injecting noise.
    np.testing.assert_array_equal(
        primitive.value_kernel_draws[0], primitive.value_kernel_draws[1],
    )

    # Cumulative kernel = cumulative observed k/n at each τ, with
    # forward-fill at absent ages. arrival_weight = 1.0 means
    # n_weighted = n; k_weighted/n_weighted = k/n. Latest at age 16 is
    # k=8 → cumulative rate = 0.8 at τ ≥ 16.
    cumulative_rate = np.cumsum(primitive.value_kernel_draws[0])
    assert cumulative_rate[0] == pytest.approx(0.0)
    assert cumulative_rate[4] == pytest.approx(0.0, abs=1e-12)  # τ < 5, no row yet
    assert cumulative_rate[5] == pytest.approx(0.2)  # k=2 / n=10
    assert cumulative_rate[9] == pytest.approx(0.2)  # forward-filled
    assert cumulative_rate[10] == pytest.approx(0.5)  # k=5
    assert cumulative_rate[15] == pytest.approx(0.5)  # forward-filled
    assert cumulative_rate[16] == pytest.approx(0.8)  # k=8
    assert cumulative_rate[19] == pytest.approx(0.8)
    assert primitive.saturation_per_draw[0] == pytest.approx(0.8)

    # Mask is 1 exactly at observed ages (0, 5, 10, 16).
    mask_row = primitive.observation_mask_draws[0]
    expected_mask = np.zeros(20, dtype=np.float64)
    for age in (0, 5, 10, 16):
        expected_mask[age] = 1.0
    np.testing.assert_array_equal(mask_row, expected_mask)


def test_empirical_primitive_value_kernel_zero_at_absent_cells():
    """§4.9: the empirical value kernel is already zero at absent
    cells, so value × mask = value identically. The support stream
    (value × mask) equals the value stream."""
    transition = TransitionIdentity(
        source_node='U', destination_node='V', edge_id='e-uv',
    )
    scope = _scope()
    arrival = _arrival_weights({'2026-03-15': 1.0})

    candidates = [
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-18', n=20, k=3,  # age 3
        ),
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-22', n=20, k=7,  # age 7
        ),
    ]

    primitive = build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=candidates,
        draw_count=2,
        horizon_len=15,
    )

    np.testing.assert_array_equal(
        primitive.support_kernel_draws,
        primitive.value_kernel_draws,
    )


def test_empirical_primitive_empty_candidates_yields_zero_kernel():
    """No admitted rows → zero kernel, zero saturation, zero mask.
    Mirrors the conditioned operator's PRIOR_ONLY mask-is-all-zeros
    contract (Atom 2.1)."""
    transition = TransitionIdentity(
        source_node='U', destination_node='V', edge_id='e-uv',
    )
    scope = _scope()
    arrival = _arrival_weights({'2026-03-15': 1.0}, draw_count=3)

    primitive = build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=(),
        draw_count=3,
        horizon_len=10,
    )

    np.testing.assert_array_equal(
        primitive.value_kernel_draws, np.zeros((3, 10)),
    )
    np.testing.assert_array_equal(
        primitive.observation_mask_draws, np.zeros((3, 10)),
    )
    np.testing.assert_array_equal(
        primitive.saturation_per_draw, np.zeros(3),
    )


def test_empirical_primitive_multiple_source_days_pool_n_and_k():
    """Cross-source-day aggregation: pool numerator and denominator
    separately under arrival weighting, then differentiate.

    Two source days, each with k=5/n=10 observed at age 8. With equal
    arrival weights (0.5 each), saturation = (0.5*5 + 0.5*5) /
    (0.5*10 + 0.5*10) = 5/10 = 0.5.
    """
    transition = TransitionIdentity(
        source_node='U', destination_node='V', edge_id='e-uv',
    )
    scope = _scope()
    arrival = _arrival_weights({
        '2026-03-10': 0.5,
        '2026-03-12': 0.5,
    })

    candidates = [
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-10',
            retrieved_at='2026-03-18', n=10, k=5,
        ),
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-12',
            retrieved_at='2026-03-20', n=10, k=5,
        ),
    ]

    primitive = build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=candidates,
        draw_count=2,
        horizon_len=15,
    )

    cumulative_rate = np.cumsum(primitive.value_kernel_draws[0])
    # Saturation across horizon equals (Σ w·k) / (Σ w·n) = 0.5
    assert cumulative_rate[-1] == pytest.approx(0.5)
    assert primitive.saturation_per_draw[0] == pytest.approx(0.5)


# ─── Identity span ────────────────────────────────────────────────────


def test_compose_empirical_span_identity_returns_delta_at_root():
    """x_node_id == end_node_id is the algebraic identity of the
    operator-chain monoid: δ(0) at the root in all three streams,
    reach=1, terminal cumulative=1. Matches the conditioned composer's
    identity behaviour for AP58 / I-45 (identity is data, not a route).
    """
    graph = {
        'nodes': [{'id': 'X'}, {'id': 'Y'}],
        'edges': [{'edge_id': 'unused', 'from': 'X', 'to': 'Y'}],
    }

    def _no_lookup(from_id, to_id, edge_data):
        raise AssertionError('identity span should not look up edges')

    span = compose_empirical_span(
        graph=graph,
        x_node_id='X',
        end_node_id='X',
        edge_to_empirical_primitive_lookup=_no_lookup,
        draw_count=4,
        horizon_len=10,
    )

    assert span.primitive_count == 0
    assert span.concrete_edges == ()
    assert span.span_p_mean == pytest.approx(1.0)
    np.testing.assert_array_equal(
        span.span_p_draws, np.ones(4),
    )

    expected_delta = np.zeros((4, 10))
    expected_delta[:, 0] = 1.0
    np.testing.assert_array_equal(
        span.node_density_draws['X'], expected_delta,
    )
    np.testing.assert_array_equal(
        span.node_support_draws['X'], expected_delta,
    )
    np.testing.assert_array_equal(
        span.node_exposure_draws['X'], expected_delta,
    )

    np.testing.assert_array_equal(
        span.cdf_draws, np.ones((4, 10)),
    )


# ─── Single-hop saturation ────────────────────────────────────────────


def test_compose_empirical_span_single_hop_saturation_matches_observed_rate():
    """Single-hop saturation collapses to the per-edge empirical
    saturation rate. With one upstream cohort of n=10 producing k=4
    at the terminal, the asymptotic span reach is 4/10 = 0.4.

    Plan: "single-hop saturation degenerates to raw `Σ k_observed`."
    In the single-hop case the DP propagates the root impulse δ(0)
    through the per-edge Δk/n kernel, so the terminal cumulative is
    exactly the per-edge cumulative rate.
    """
    transition = TransitionIdentity(
        source_node='U', destination_node='V', edge_id='e-uv',
    )
    scope = _scope()
    arrival = _arrival_weights({'2026-03-15': 1.0})

    candidates = [
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-22', n=10, k=4,
        ),
    ]

    primitive = build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=candidates,
        draw_count=2,
        horizon_len=20,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}],
        'edges': [{'edge_id': 'e-uv', 'from': 'U', 'to': 'V'}],
    }

    def _lookup(from_id, to_id, edge_data):
        if (from_id, to_id) == ('U', 'V'):
            return primitive
        return None

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='V',
        edge_to_empirical_primitive_lookup=_lookup,
        draw_count=2,
        horizon_len=20,
    )

    # Single-hop reach = primitive saturation = 0.4.
    np.testing.assert_allclose(span.span_p_draws, 0.4)
    # Terminal cumulative at the horizon end = cumulative kernel
    # (renormalised by reach in the composer). Within the horizon the
    # observation appears at age 7 (2026-03-15 → 2026-03-22), so the
    # cumulative is 1.0 at τ ≥ 7 after the reach-normalisation.
    terminal_cumulative = np.cumsum(span.node_density_draws['V'][0])
    assert terminal_cumulative[-1] == pytest.approx(0.4)


# ─── Two-hop chain saturation ────────────────────────────────────────


def test_compose_empirical_span_two_hop_saturation_equals_product_of_rates():
    """Multi-hop saturation: for two serial edges with rates p1, p2
    on the empirical kernel, the span reach is p1 × p2 (Σ_s
    m_U(s) × k(s,∞) / n(s) propagated through the chain).

    The DP convolves the per-edge kernels; the asymptotic terminal
    cumulative — after reach normalisation in the composer — saturates
    at exactly the chain reach.
    """
    scope = _scope()
    arrival_u = _arrival_weights({'2026-03-15': 1.0})
    arrival_v = _arrival_weights({'2026-03-15': 1.0})

    e_uv = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_u,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=[
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15',
                retrieved_at='2026-03-22',
                n=10, k=6,
            ),
        ],
        draw_count=2,
        horizon_len=30,
    )
    e_vw = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='V', destination_node='W', edge_id='e-vw',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_v,
        evidence_scope=_evidence_scope('V', 'W', scope),
        candidates=[
            _candidate(
                from_id='V', to_id='W',
                observed_date='2026-03-15',
                retrieved_at='2026-03-22',
                n=20, k=10,
            ),
        ],
        draw_count=2,
        horizon_len=30,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}, {'id': 'W'}],
        'edges': [
            {'edge_id': 'e-uv', 'from': 'U', 'to': 'V'},
            {'edge_id': 'e-vw', 'from': 'V', 'to': 'W'},
        ],
    }

    primitives_by_edge = {
        ('U', 'V'): e_uv,
        ('V', 'W'): e_vw,
    }

    def _lookup(from_id, to_id, edge_data):
        return primitives_by_edge.get((from_id, to_id))

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='W',
        edge_to_empirical_primitive_lookup=_lookup,
        draw_count=2,
        horizon_len=30,
    )

    expected_reach = 0.6 * 0.5  # 6/10 × 10/20
    np.testing.assert_allclose(span.span_p_draws, expected_reach)
    # Terminal node's cumulative density at the horizon's tail equals
    # exactly the chain reach (no renormalisation applied here — it's
    # the raw mass that traversed both edges).
    terminal_cumulative = np.cumsum(span.node_density_draws['W'][0])
    assert terminal_cumulative[-1] == pytest.approx(expected_reach)


def test_compose_empirical_span_preserves_downstream_source_day_rates():
    """Regression for Phase 6 §4.3/§4.9 source-day preservation.

    U→V sends all selected mass to V on source day 2026-03-16. The V→W
    empirical rows have different source-day rates: 0.1 on 2026-03-15
    and 0.9 on 2026-03-16. The correct terminal saturation is therefore
    0.9. The old age-only pooled kernel would average the two V→W
    source days and return 0.5.
    """
    scope = _scope()
    arrival_u = _arrival_weights({'2026-03-15': 1.0})
    arrival_v = _arrival_weights({
        '2026-03-15': 1.0,
        '2026-03-16': 1.0,
    })

    e_uv = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_u,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=[
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15',
                retrieved_at='2026-03-16',
                n=10, k=10,
            ),
        ],
        draw_count=2,
        horizon_len=10,
    )
    e_vw = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='V', destination_node='W', edge_id='e-vw',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_v,
        evidence_scope=_evidence_scope('V', 'W', scope),
        candidates=[
            _candidate(
                from_id='V', to_id='W',
                observed_date='2026-03-15',
                retrieved_at='2026-03-15',
                n=10, k=1,
            ),
            _candidate(
                from_id='V', to_id='W',
                observed_date='2026-03-16',
                retrieved_at='2026-03-16',
                n=10, k=9,
            ),
        ],
        draw_count=2,
        horizon_len=10,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}, {'id': 'W'}],
        'edges': [
            {'edge_id': 'e-uv', 'from': 'U', 'to': 'V'},
            {'edge_id': 'e-vw', 'from': 'V', 'to': 'W'},
        ],
    }
    primitives_by_edge = {('U', 'V'): e_uv, ('V', 'W'): e_vw}

    def _lookup(from_id, to_id, edge_data):
        return primitives_by_edge.get((from_id, to_id))

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='W',
        edge_to_empirical_primitive_lookup=_lookup,
        draw_count=2,
        horizon_len=10,
    )

    terminal_cumulative = np.cumsum(span.node_density_draws['W'][0])
    assert terminal_cumulative[-1] == pytest.approx(0.9)
    np.testing.assert_allclose(span.span_p_draws, 0.9)


# ─── Composition error surfaces ──────────────────────────────────────


def test_compose_empirical_span_missing_edge_primitive_raises():
    """A concrete edge with no empirical primitive surfaces as a natural
    AttributeError downstream when the engine accesses primitive fields.
    The engine carries no defensive raise — the lookup contract is a
    perimeter invariant (I-47 / I-48)."""
    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}],
        'edges': [{'edge_id': 'e-uv', 'from': 'U', 'to': 'V'}],
    }

    def _empty_lookup(from_id, to_id, edge_data):
        return None

    with pytest.raises(AttributeError):
        compose_empirical_span(
            graph=graph,
            x_node_id='U',
            end_node_id='V',
            edge_to_empirical_primitive_lookup=_empty_lookup,
            draw_count=2,
            horizon_len=10,
        )


def test_compose_empirical_span_no_path_raises():
    """No topological path from x to end → ``_build_span_topology``
    returns None, and the engine surfaces an AttributeError on the first
    topology-attribute access. The engine carries no defensive raise."""
    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}, {'id': 'W'}],
        'edges': [{'edge_id': 'e-uv', 'from': 'U', 'to': 'V'}],
    }

    def _unused_lookup(from_id, to_id, edge_data):
        raise AssertionError('lookup must not be called when path is absent')

    with pytest.raises(AttributeError):
        compose_empirical_span(
            graph=graph,
            x_node_id='U',
            end_node_id='W',
            edge_to_empirical_primitive_lookup=_unused_lookup,
            draw_count=2,
            horizon_len=10,
        )


# ─── Two-operator separation: conditioned vs empirical may differ ────


def test_empirical_saturation_independent_of_parametric_model():
    """Two-operator separation: the empirical kernel reads observed
    snapshot rows directly; it does NOT consult the parametric Beta
    posterior. So the empirical saturation depends only on the
    observed k/n, regardless of what the parametric fit would say.

    This is the load-bearing separation the cutover preserves — if
    the empirical operator ever silently consulted the parametric
    fit, this test would couple to the model's α/β. It must not.
    """
    transition = TransitionIdentity(
        source_node='U', destination_node='V', edge_id='e-uv',
    )
    scope = _scope()
    arrival = _arrival_weights({'2026-03-15': 1.0}, draw_count=4)

    # Observed rate is 3/10 = 0.3 — fixed by the rows, not by any prior.
    candidates = [
        _candidate(
            from_id='U', to_id='V', observed_date='2026-03-15',
            retrieved_at='2026-03-22', n=10, k=3,
        ),
    ]

    primitive = build_empirical_evidence_primitive(
        transition=transition,
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=candidates,
        draw_count=4,
        horizon_len=15,
    )

    # Saturation is the observed rate, not any parametric posterior.
    # A parametric fit Beta(α, β) with α + k=3+α, β + n-k=7+β would
    # give a posterior mean (α+3)/(α+β+10), which generally differs.
    assert primitive.saturation_per_draw[0] == pytest.approx(0.3)
    # All draws share this — no draw-by-draw posterior variability,
    # by design (the empirical kernel reads rows, not draws).
    np.testing.assert_allclose(primitive.saturation_per_draw, 0.3)
