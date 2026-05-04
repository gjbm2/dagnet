"""
73n Stage 7 — composed-object cache integration tests.

These tests cross the cache wiring boundary on purpose. The risk this
file pins is *whether the cache hooks inside* ``compose_carrier_to_x``
*and* ``compose_primitive_span`` *are correctly registered, keyed, and
flushed by the bustcache path* — not whether the underlying
``ResultCache`` works in isolation (covered in ``test_result_cache``).

The tests therefore:

  - drive the real composer entry points end-to-end with realistic
    inputs (``compose_carrier_to_x`` over an A→X graph; ``compose_primitive_span``
    over an X→end graph with a populated registry and a primitive
    lookup that mirrors the Stage 5b/6 readout pattern),
  - prove cache hits via object-identity on a second identical call,
  - prove cache misses when load-bearing inputs change (transition
    moments; topology; primitives obtained after a primitive-cache
    flush — the §417 "composed caches must invalidate when their
    primitives invalidate" invariant),
  - prove that ``snapshot_service.cache_clear`` (called from outside
    the runner package) flushes the composer caches via the shared
    registry,
  - prove that ``snapshot_service.set_cache_bypass`` propagates
    through the same ContextVar both composer caches honour,
  - prove MC-mode calls (rng + num_draws) bypass the deterministic
    cache so a later deterministic call still computes from inputs
    rather than picking up an MC-conditioned entry.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import result_cache
import snapshot_service
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
from runner.carrier_composition import (
    TransitionPrimitive,
    compose_carrier_to_x,
)
from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.prefix_arrival import (
    PrefixArrivalIdentity,
    build_prefix_arrival_map,
)
from runner.primitive_conditioning import (
    ConditioningPolicyOptions,
    condition_primitive,
)
from runner.primitive_evidence import (
    RequestPrimitiveRegistry,
    bind_primitive_evidence,
    make_primitive_scope_from_evidence_scope,
)
from runner.primitives import TransitionIdentity
from runner.subject_span_composer import (
    ComposeOptions,
    compose_primitive_span,
)


# ---------------------------------------------------------------------------
# Carrier fixture — a 2-edge A → M → X chain with explicit transitions
# ---------------------------------------------------------------------------


def _carrier_graph():
    """A graph with two edges A→M→X. Anchor=A, denominator=X.

    Identity short-circuits avoided (A != X, not window mode), so the
    full topology + composition path runs and hits the cache.
    """
    return {
        'nodes': [
            {'uuid': 'u-a', 'id': 'A'},
            {'uuid': 'u-m', 'id': 'M'},
            {'uuid': 'u-x', 'id': 'X'},
        ],
        'edges': [
            {'uuid': 'e-am', 'from': 'u-a', 'to': 'u-m'},
            {'uuid': 'e-mx', 'from': 'u-m', 'to': 'u-x'},
        ],
    }


def _carrier_transitions(*, p_am=0.7, p_mx=0.6, sigma_am=0.0, sigma_mx=0.0):
    return {
        ('A', 'M'): TransitionPrimitive(
            p=p_am, mu=0.0, sigma=sigma_am, onset=0.0,
            p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
            source='test_synthetic',
        ),
        ('M', 'X'): TransitionPrimitive(
            p=p_mx, mu=0.0, sigma=sigma_mx, onset=0.0,
            p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
            source='test_synthetic',
        ),
    }


# ---------------------------------------------------------------------------
# Subject-span fixture — single-edge X → Z driven by a real condition_primitive
# call, registered into a real RequestPrimitiveRegistry, looked up via the
# Stage 5b/6 dict-based lookup pattern.
# ---------------------------------------------------------------------------


def _subject_graph():
    return {
        'nodes': [
            {'uuid': 'u-x', 'id': 'X'},
            {'uuid': 'u-z', 'id': 'Z'},
        ],
        'edges': [
            {'uuid': 'e-xz', 'from': 'u-x', 'to': 'u-z', 'edge_id': 'e-xz'},
        ],
    }


def _identity():
    return PrefixArrivalIdentity(
        scenario_id='scn-1',
        request_root='X',
        context_key=None,
        regime_key='default',
        as_at='2026-04-01',
        model_source_preference='best_available',
        parameter_fingerprint='fp-1',
    )


def _subject_evidence_scope():
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from='X',
        subject_to='Z',
        date_from='2026-03-01',
        date_to='2026-03-31',
        as_at='2026-04-01',
        scenario_id='scn-1',
        anchor=None,
        context_key=None,
        regime_key=None,
    )


def _subject_candidate(*, n=100, k=30):
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from='X',
            subject_to='Z',
            anchor=None,
            slice_family=SliceFamily.WINDOW,
            context_key=None,
            regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date='2026-03-15',
            retrieved_at='2026-04-01',
            temporal_basis=TemporalBasis.WINDOW_DAY,
            asat_materialised=False,
        ),
        n=n,
        k=k,
        provenance={},
    )


def _resolved_model(*, alpha=2.0, beta=3.0):
    return ResolvedModelParams(
        p_mean=alpha / (alpha + beta),
        p_sd=0.0,
        alpha=alpha, beta=beta,
        alpha_pred=alpha, beta_pred=beta,
        n_effective=None,
        edge_latency=ResolvedLatency(
            mu=0.0, sigma=0.0, onset_delta_days=0.0, t95=0.0,
            mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
        ),
        path_latency=None,
        source='analytic',
    )


def _build_subject_setup(*, alpha=2.0, beta=3.0, evidence_n=100, evidence_k=30):
    """Build the (graph, registry, lookup) bundle that
    ``compose_primitive_span`` consumes — same shape the primitive-span readout
    builds."""
    graph = _subject_graph()
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='X',
        root_day_weights={'2026-03-15': 1.0},
        transitions={('X', 'Z'): TransitionPrimitive(
            p=0.7, mu=0.0, sigma=0.0, onset=0.0,
            p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
            source='test_synthetic',
        )},
        identity=_identity(),
        max_tau=60,
    )
    ev_scope = _subject_evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    transition = TransitionIdentity('X', 'Z', 'e-xz')
    resolution = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=[_subject_candidate(n=evidence_n, k=evidence_k)],
        arrival_weights=arrival_map.get('X'),
    )
    primitive = condition_primitive(
        resolution=resolution,
        resolved_model=_resolved_model(alpha=alpha, beta=beta),
        scenario_seed=42,
    )
    registry = RequestPrimitiveRegistry(arrival_map=arrival_map)
    registry.register(resolution)

    edge_id_to_primitive = {'e-xz': primitive}
    edge_to_primitive = {('X', 'Z'): primitive}

    def lookup(from_id, to_id, edge_dict):
        eid = edge_dict.get('edge_id') or edge_dict.get('id')
        if eid and eid in edge_id_to_primitive:
            return edge_id_to_primitive[eid]
        return edge_to_primitive.get((from_id, to_id))

    return graph, registry, lookup, primitive


@pytest.fixture
def fresh_caches():
    """Flush every registered cache before and after each test so cache
    state from earlier tests cannot bleed in."""
    result_cache.clear_all()
    try:
        yield
    finally:
        result_cache.clear_all()


# ---------------------------------------------------------------------------
# Carrier composer cache wiring
# ---------------------------------------------------------------------------


class TestCarrierCacheWiring:
    def test_identical_calls_return_cached_object(self, fresh_caches):
        graph = _carrier_graph()
        transitions = _carrier_transitions()
        a = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        b = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        # Object identity proves the second call hit the cache.
        assert a is b

    def test_different_transitions_miss(self, fresh_caches):
        graph = _carrier_graph()
        a = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=_carrier_transitions(p_am=0.7),
            max_tau=60,
        )
        b = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=_carrier_transitions(p_am=0.4),
            max_tau=60,
        )
        assert a is not b
        # Reach scales with edge probabilities — different transitions
        # must produce a different topological reach.
        assert a.reach != b.reach

    def test_different_max_tau_misses(self, fresh_caches):
        graph = _carrier_graph()
        transitions = _carrier_transitions(sigma_am=0.5, sigma_mx=0.5)
        a = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        b = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=120,
        )
        assert a is not b
        assert a.max_tau != b.max_tau

    def test_mc_mode_does_not_serve_cached_deterministic_result(self, fresh_caches):
        """A deterministic call warms the cache. A subsequent MC-mode
        call must NOT pick up the deterministic entry — its `mc_cdf`
        must be populated, which the deterministic entry never has.
        Skip-on-MC is the wiring under test."""
        graph = _carrier_graph()
        transitions = _carrier_transitions(sigma_am=0.5, sigma_mx=0.5)
        deterministic = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        assert deterministic.mc_cdf is None

        rng = np.random.default_rng(seed=7)
        mc = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
            num_draws=8, rng=rng,
        )
        # Different object (cache was bypassed for MC mode).
        assert mc is not deterministic
        # MC-mode result actually has MC samples.
        assert mc.mc_cdf is not None

    def test_snapshot_cache_clear_flushes_carrier_cache(self, fresh_caches):
        """Cross-boundary: ``snapshot_service.cache_clear`` (an import
        from outside the runner package) must flush the composed-carrier
        cache via the shared registry."""
        graph = _carrier_graph()
        transitions = _carrier_transitions()
        a = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        snapshot_service.cache_clear()
        b = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        # Cache was flushed, so the second call rebuilds (different
        # object), but the result is numerically identical because the
        # composer is deterministic given inputs.
        assert a is not b
        assert a.reach == pytest.approx(b.reach)

    def test_bypass_via_snapshot_service_set_cache_bypass(self, fresh_caches):
        """Cross-boundary: setting bypass via the snapshot_service
        re-export must suppress the carrier cache (single ContextVar)."""
        graph = _carrier_graph()
        transitions = _carrier_transitions()
        token = snapshot_service.set_cache_bypass(True)
        try:
            a = compose_carrier_to_x(
                graph=graph, anchor_node_id='A', denominator_node_id='X',
                is_window=False, transitions=transitions, max_tau=60,
            )
            b = compose_carrier_to_x(
                graph=graph, anchor_node_id='A', denominator_node_id='X',
                is_window=False, transitions=transitions, max_tau=60,
            )
            # Bypass disables both get and put — different objects each
            # call.
            assert a is not b
        finally:
            snapshot_service.reset_cache_bypass(token)

    def test_cached_and_bypassed_results_are_numerically_equivalent(self, fresh_caches):
        """Plan §739 (softened): cached and uncached must agree on
        every load-bearing field. ``reach``, ``deterministic_cdf``,
        and tier diagnostics."""
        graph = _carrier_graph()
        transitions = _carrier_transitions()

        with result_cache.cache_bypass_ctx():
            uncached = compose_carrier_to_x(
                graph=graph, anchor_node_id='A', denominator_node_id='X',
                is_window=False, transitions=transitions, max_tau=60,
            )

        cached_first = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )
        cached_second = compose_carrier_to_x(
            graph=graph, anchor_node_id='A', denominator_node_id='X',
            is_window=False, transitions=transitions, max_tau=60,
        )

        assert cached_first is cached_second        # warmed → hit
        assert uncached is not cached_first         # bypassed → fresh
        assert uncached.reach == pytest.approx(cached_first.reach)
        assert uncached.diagnostics.tier == cached_first.diagnostics.tier
        np.testing.assert_array_equal(
            uncached.deterministic_cdf, cached_first.deterministic_cdf,
        )

    def test_carrier_cache_registered_under_known_name(self):
        cache = result_cache.get_cache('composed_carrier')
        assert cache.name == 'composed_carrier'


# ---------------------------------------------------------------------------
# Subject-span composer cache wiring
# ---------------------------------------------------------------------------


class TestSubjectSpanCacheWiring:
    def test_identical_calls_return_cached_object(self, fresh_caches):
        graph, registry, lookup, _prim = _build_subject_setup()
        a = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        b = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        assert a is b

    def test_different_endpoints_miss(self, fresh_caches):
        """A different end node should produce a different topology and
        therefore a cache miss. We use a 2-hop graph to allow X→M and
        X→Y as distinct subject closures."""
        graph = {
            'nodes': [
                {'uuid': 'u-x', 'id': 'X'},
                {'uuid': 'u-m', 'id': 'M'},
                {'uuid': 'u-y', 'id': 'Y'},
            ],
            'edges': [
                {'uuid': 'e-xm', 'from': 'u-x', 'to': 'u-m', 'edge_id': 'e-xm'},
                {'uuid': 'e-my', 'from': 'u-m', 'to': 'u-y', 'edge_id': 'e-my'},
            ],
        }
        # Build primitives for both edges via the real conditioning
        # path so the registry / lookup mirrors live shape.
        arrival_map = build_prefix_arrival_map(
            graph=graph, root_node_id='X',
            root_day_weights={'2026-03-15': 1.0},
            transitions={
                ('X', 'M'): TransitionPrimitive(
                    p=0.7, mu=0.0, sigma=0.0, onset=0.0,
                    p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
                    source='test',
                ),
                ('M', 'Y'): TransitionPrimitive(
                    p=0.6, mu=0.0, sigma=0.0, onset=0.0,
                    p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
                    source='test',
                ),
            },
            identity=_identity(), max_tau=60,
        )

        def _build(transition):
            ev_scope = EvidenceScope(
                role=EvidenceRole.WINDOW_SUBJECT_HELPER,
                subject_from=transition.source_node,
                subject_to=transition.destination_node,
                date_from='2026-03-01', date_to='2026-03-31',
                as_at='2026-04-01', scenario_id='scn-1',
                anchor=None, context_key=None, regime_key=None,
            )
            scope = make_primitive_scope_from_evidence_scope(
                evidence_scope=ev_scope,
                model_source_preference='best_available',
                resolved_source_identity='bayesian',
            )
            res = bind_primitive_evidence(
                transition=transition, primitive_scope=scope,
                evidence_scope=ev_scope,
                candidates=[_subject_candidate(n=80, k=20)],
                arrival_weights=arrival_map.get(transition.source_node),
            )
            return res, condition_primitive(
                resolution=res, resolved_model=_resolved_model(),
                scenario_seed=42,
            )

        res_xm, prim_xm = _build(TransitionIdentity('X', 'M', 'e-xm'))
        res_my, prim_my = _build(TransitionIdentity('M', 'Y', 'e-my'))
        registry = RequestPrimitiveRegistry(arrival_map=arrival_map)
        registry.register(res_xm)
        registry.register(res_my)
        edge_id_to = {'e-xm': prim_xm, 'e-my': prim_my}
        edge_to = {('X', 'M'): prim_xm, ('M', 'Y'): prim_my}

        def lookup(from_id, to_id, edge_dict):
            eid = edge_dict.get('edge_id') or edge_dict.get('id')
            return edge_id_to.get(eid) or edge_to.get((from_id, to_id))

        # Span X → M (single-hop, end at M).
        short = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='M',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        # Span X → Y (multi-hop, end at Y).
        long_ = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Y',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        assert short is not long_
        assert short.primitive_count == 1
        assert long_.primitive_count == 2

    def test_primitive_cache_flush_invalidates_subject_span_cache(self, fresh_caches):
        """The §417 invariant: composed caches must invalidate when
        their consumed primitives invalidate. We verify by:

          1. Building a primitive via condition_primitive (cached in
             the primitive cache).
          2. Running compose_primitive_span — composed cache hit.
          3. Flushing the primitive cache only (NOT the subject-span
             cache directly).
          4. Re-building the primitive — new object, new id().
          5. Running compose_primitive_span with the new primitive —
             must miss the composed-subject cache because the per-edge
             primitive id() in the cache key has changed.
        """
        # Step 1+2: warm both caches.
        graph, registry, lookup, _prim = _build_subject_setup()
        first = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=registry, edge_to_primitive_lookup=lookup,
        )

        # Step 3+4: flush primitive cache only, rebuild setup so the
        # primitive is freshly conditioned (new object identity).
        result_cache.get_cache('primitive').clear()
        graph2, registry2, lookup2, fresh_primitive = _build_subject_setup()
        # Confirm the rebuild produced a *new* primitive object.
        assert fresh_primitive is not _prim

        # Step 5: composed-subject cache must not return the stale
        # `first` result for this fresh primitive.
        second = compose_primitive_span(
            graph=graph2, x_node_id='X', end_node_id='Z',
            registry=registry2, edge_to_primitive_lookup=lookup2,
        )
        assert second is not first

    def test_snapshot_cache_clear_flushes_subject_span_cache(self, fresh_caches):
        """Cross-boundary: the snapshot-write bustcache hook reaches
        into the runner package and flushes the composed-subject
        cache."""
        graph, registry, lookup, _prim = _build_subject_setup()
        a = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        snapshot_service.cache_clear()
        # After bustcache, the primitive cache is also flushed; rebuild
        # the setup so we have fresh primitives for the second call.
        graph2, registry2, lookup2, _ = _build_subject_setup()
        b = compose_primitive_span(
            graph=graph2, x_node_id='X', end_node_id='Z',
            registry=registry2, edge_to_primitive_lookup=lookup2,
        )
        assert a is not b
        # Numerical equivalence still holds — the composer is
        # deterministic given inputs.
        assert a.span_p_mean == pytest.approx(b.span_p_mean)
        assert a.primitive_count == b.primitive_count

    def test_bypass_via_snapshot_service_set_cache_bypass(self, fresh_caches):
        graph, registry, lookup, _prim = _build_subject_setup()
        token = snapshot_service.set_cache_bypass(True)
        try:
            a = compose_primitive_span(
                graph=graph, x_node_id='X', end_node_id='Z',
                registry=registry, edge_to_primitive_lookup=lookup,
            )
            b = compose_primitive_span(
                graph=graph, x_node_id='X', end_node_id='Z',
                registry=registry, edge_to_primitive_lookup=lookup,
            )
            # No cache hit during bypass.
            assert a is not b
        finally:
            snapshot_service.reset_cache_bypass(token)

    def test_cached_and_bypassed_results_are_numerically_equivalent(self, fresh_caches):
        graph, registry, lookup, _prim = _build_subject_setup()
        with result_cache.cache_bypass_ctx():
            uncached = compose_primitive_span(
                graph=graph, x_node_id='X', end_node_id='Z',
                registry=registry, edge_to_primitive_lookup=lookup,
            )
        cached_first = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        cached_second = compose_primitive_span(
            graph=graph, x_node_id='X', end_node_id='Z',
            registry=registry, edge_to_primitive_lookup=lookup,
        )
        assert cached_first is cached_second
        assert uncached is not cached_first
        assert uncached.span_p_mean == pytest.approx(cached_first.span_p_mean)
        assert uncached.span_p_sd == pytest.approx(cached_first.span_p_sd)
        assert uncached.primitive_count == cached_first.primitive_count
        np.testing.assert_array_equal(
            uncached.cdf_mean, cached_first.cdf_mean,
        )

    def test_subject_span_cache_registered_under_known_name(self):
        cache = result_cache.get_cache('composed_subject_span')
        assert cache.name == 'composed_subject_span'
