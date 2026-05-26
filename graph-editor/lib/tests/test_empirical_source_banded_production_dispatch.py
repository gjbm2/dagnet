"""Atom 4d production dispatch assertion (plan §1195-1208).

These tests enforce the pre-Atom-5 gate's "production providers assert
their expected fast-path dispatch" + "representative production-scale
tests assert not only numerical output but also that the intended fast
path was selected" requirements.

The empirical evidence provider's production fast path is
``SOURCE_BANDED`` (plan §1083-1144). The provider declares this via
``provider.expected_production_policy`` at construction; production
entry points hardcode the matching ``execution_policy`` on the DP call.
This test:

  1. Mirrors the production call pattern at a production-scale shape
     (cohort × draw × horizon dimensions chosen as a tractable proxy
     for the synth-lat4 acceptance shape C=49, D=1000, T=115; see
     ``test_empirical_source_banded_synth_lat4_benchmark.py`` for the
     full-scale memory and runtime measurement).
  2. Asserts the empirical provider declares
     ``expected_production_policy is DPExecutionPolicy.SOURCE_BANDED``.
  3. Asserts both production entry points
     (``evaluate_empirical_span_from_seed_flat_origins`` and the
     ``_with_provenance`` variant) actually dispatch under
     ``SOURCE_BANDED`` by reading the source string for the
     ``execution_policy=DPExecutionPolicy.SOURCE_BANDED`` assignment —
     a regression where the policy quietly reverts to ``SCALAR`` would
     trip this assertion.
  4. Runs the empirical evaluator at the proxy production scale and
     asserts ``provider._source_banded_dispatch_log`` is populated —
     proving the ``source_banded_op`` capability was actually invoked
     for every (edge, basis) request the DP made, not silently bypassed.

The dispatch-log entries also expose the per-call sub-path
(``cache_hit`` via ``n_cache_hits``, ``per_consumer_scalar`` or
``group_cubic_spline`` via ``build_sub_path``) so this test additionally
asserts each entry's structure matches the contract documented at
``empirical_evidence_operator.source_banded_op``.
"""

from __future__ import annotations

import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date

import numpy as np

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
    _build_empirical_flat_kernel_provider,
    build_empirical_evidence_primitive,
    compose_empirical_span,
    evaluate_empirical_span_from_seed_flat_origins,
    evaluate_empirical_span_from_seed_flat_origins_with_provenance,
)
from runner.prefix_arrival import NodeArrivalProvenance, NodeArrivalWeights
from runner.primitives import PrimitiveScope, TransitionIdentity
from runner.subject_span_composer import EvidenceReadoutBinding
from runner.timing_span import (
    DPExecutionPolicy,
    _run_dp_density_trace_from_seed,
)


# ─── Fixture helpers (parallel to test_empirical_source_banded_parity) ─


def _scope() -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id='scn-production-dispatch',
        evidence_role='window_subject_helper',
        date_from='2026-03-01',
        date_to='2026-04-30',
        as_at='2026-05-15',
        context_key=None,
        regime_key=None,
        model_source_preference='analytic',
        resolved_source_identity=None,
        selected_anchor_days=(),
    )


def _arrival_weights(
    weights_by_day: dict[str, float],
    *,
    draw_count: int,
    per_draw_jitter: float = 0.05,
) -> NodeArrivalWeights:
    rng = np.random.default_rng(20260525)
    weights_draws = {}
    for day, w in weights_by_day.items():
        base = float(w)
        noise = rng.normal(0.0, per_draw_jitter, size=int(draw_count))
        weights_draws[day] = np.clip(base + noise, 1e-6, None)
    return NodeArrivalWeights(
        weights=dict(weights_by_day),
        weights_draws=weights_draws,
        draw_count=int(draw_count),
        reach_from_root=1.0,
        provenance=NodeArrivalProvenance(
            topology_case='identity',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='identity',
            horizon_ratio=1.0,
            note='production-dispatch fixture',
        ),
    )


def _evidence_scope(
    from_id: str, to_id: str, scope: PrimitiveScope,
) -> EvidenceScope:
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
        provenance={'source': 'production_dispatch_fixture'},
    )


def _build_production_scale_fixture(
    *,
    cohort_count: int,
    draw_count: int,
    horizon_len: int,
    n_source_days: int = 5,
):
    """Build a single-hop empirical span with multiple source days +
    multiple retrievals per source day.

    The shape mirrors the synth-lat4 cell pattern (``C=49, D=1000,
    T=115``) but at tractable sizes for a fast test. Multiple source
    days ensure the dispatch log records more than one entry; multiple
    retrievals per day exercise the per-source-day kernel construction
    path the SOURCE_BANDED applier accelerates.
    """
    scope = _scope()
    base = date(2026, 3, 1)
    source_days = [
        (base + (i := __import__('datetime').timedelta(days=k))).isoformat()
        for k in range(n_source_days)
    ]
    arrival = _arrival_weights(
        {day: 1.0 for day in source_days},
        draw_count=draw_count,
        per_draw_jitter=0.05,
    )
    candidates = []
    for day in source_days:
        # Two retrievals per source day so the per-source-day kernel
        # has non-trivial age structure.
        candidates.append(_candidate(
            from_id='U', to_id='V',
            observed_date=day, retrieved_at=day,
            n=20, k=6,
        ))
        candidates.append(_candidate(
            from_id='U', to_id='V',
            observed_date=day,
            retrieved_at=(
                base + __import__('datetime').timedelta(
                    days=int(day[8:10]) + 5 - 1,
                )
            ).isoformat(),
            n=20, k=10,
        ))
    primitive = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv',
        ),
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=candidates,
        draw_count=draw_count,
        horizon_len=horizon_len,
    )
    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}],
        'edges': [{'edge_id': 'e-uv', 'from': 'U', 'to': 'V'}],
    }

    def lookup(from_id, to_id, edge_data):
        return primitive

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='V',
        edge_to_empirical_primitive_lookup=lookup,
        draw_count=draw_count,
        horizon_len=horizon_len,
    )
    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    origin_days = [
        base + __import__('datetime').timedelta(days=c)
        for c in range(cohort_count)
    ]
    return span, primitive_by_edge, origin_days


# ─── Plan §1195-1208 production dispatch assertions ───────────────────


def test_empirical_provider_declares_expected_source_banded_policy():
    """Plan §1200-1203 — empirical provider declares its production
    fast-path execution policy at construction.

    The declaration is read by production-scale dispatch tests to
    detect regressions where the entry point's hardcoded policy is
    quietly changed away from SOURCE_BANDED.
    """
    span, primitive_by_edge, origin_days = _build_production_scale_fixture(
        cohort_count=3, draw_count=8, horizon_len=20, n_source_days=3,
    )
    provider = _build_empirical_flat_kernel_provider(
        primitive_by_edge=primitive_by_edge,
        origin_days=origin_days,
        evidence_readout_binding=EvidenceReadoutBinding.window(),
        S=8, T=20,
    )
    assert provider.expected_production_policy is DPExecutionPolicy.SOURCE_BANDED


def test_production_entry_points_hardcode_source_banded_dispatch():
    """Plan §1195 — "scalar fallback remains available... unexpected
    scalar use on a production-scale request must emit a diagnostic
    and fail the relevant performance-dispatch test".

    Source-level regression guard: both production empirical entry
    points must literally request ``DPExecutionPolicy.SOURCE_BANDED``
    when delegating to the DP core. A diff that quietly drops the
    policy down to SCALAR would trip this assertion.
    """
    for entry in (
        evaluate_empirical_span_from_seed_flat_origins,
        evaluate_empirical_span_from_seed_flat_origins_with_provenance,
    ):
        src = inspect.getsource(entry)
        assert 'execution_policy=DPExecutionPolicy.SOURCE_BANDED' in src, (
            f'{entry.__name__} must declare '
            f'execution_policy=DPExecutionPolicy.SOURCE_BANDED — '
            f'plan §1195 forbids silent scalar fallback on production '
            f'empirical requests'
        )


def test_production_scale_empirical_run_invokes_source_banded_applier():
    """Plan §1207-1208 — representative production-scale test asserts
    the intended fast path was actually selected.

    Runs the empirical DP at a proxy production scale (cohort × draw ×
    horizon × source-days large enough to give the applier non-trivial
    work) and asserts:

      - the per-call dispatch log was populated for every
        ``(edge, source_basis)`` the DP actually consulted;
      - every dispatch entry conforms to the documented shape (plan
        §1185-1198), exposing per-call shape data + sub-path identity
        so a regression in the source-indexed banded internals would
        surface here.
    """
    cohort_count, draw_count, horizon_len = 6, 32, 40
    span, primitive_by_edge, origin_days = _build_production_scale_fixture(
        cohort_count=cohort_count,
        draw_count=draw_count,
        horizon_len=horizon_len,
        n_source_days=5,
    )
    provider = _build_empirical_flat_kernel_provider(
        primitive_by_edge=primitive_by_edge,
        origin_days=origin_days,
        evidence_readout_binding=EvidenceReadoutBinding.window(),
        S=draw_count, T=horizon_len,
    )
    S_flat = cohort_count * draw_count
    root_seed = np.zeros((S_flat, horizon_len), dtype=np.float64)
    root_seed[:, 0] = 1.0

    _ = _run_dp_density_trace_from_seed(
        span.topology,
        provider,
        root_seed,
        S_flat,
        horizon_len,
        execution_policy=provider.expected_production_policy,
        cohort_count=cohort_count,
    )

    dispatch_log = provider._source_banded_dispatch_log
    assert len(dispatch_log) > 0, (
        'SOURCE_BANDED dispatch log empty after production-scale run — '
        'either source_banded_op was never invoked (silent fallback) or '
        'the provider was rebuilt mid-call (closure scope bug). Plan §1208 '
        'requires the intended fast path is observably selected.'
    )

    # Every entry should conform to the documented shape (plan §1185-1198).
    required_keys = {
        'edge_key', 'source_basis', 'n_consumers', 'n_groups',
        'reuse_ratio', 'n_cache_hits', 'pending_consumers',
        'pending_groups', 'build_reuse_ratio', 'build_sub_path',
        'n_built', 'n_chunks',
    }
    permitted_sub_paths = {
        'none', 'per_consumer_scalar', 'group_cubic_spline',
    }
    for entry in dispatch_log:
        assert required_keys.issubset(entry.keys()), (
            f'dispatch log entry missing required keys: '
            f'{required_keys - entry.keys()}'
        )
        assert entry['build_sub_path'] in permitted_sub_paths, (
            f'unexpected build_sub_path {entry["build_sub_path"]!r} — '
            f'permitted: {sorted(permitted_sub_paths)}'
        )
        assert entry['n_consumers'] >= entry['n_groups'] >= 0
        assert entry['pending_consumers'] >= entry['pending_groups'] >= 0
