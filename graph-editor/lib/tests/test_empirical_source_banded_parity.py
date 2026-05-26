"""Atom 4d empirical-specific parity matrix.

These tests prove the source-indexed banded fast path (the FC plan
§1083-1144 SOURCE_BANDED policy applied through the real
``EmpiricalEvidencePrimitive``-backed provider) produces numerically
identical traces to the scalar source-bucket application on the real
empirical operator surfaces named in the plan acceptance §1127-1134:

  - single-hop source-day-varying evidence
  - multi-hop evidence with draw-varying arrival weights
  - mixed-basis carrier-to-subject handoff
  - branch / merge topology with coincident sibling edges

Atom 4c.B established SCALAR ≡ TOEPLITZ_APPLY on synthetic providers;
atom 4d.B added SOURCE_BANDED to the same applier-level parity matrix
on a synthetic source-indexed provider. This file pins the same matrix
on the production empirical provider — the §6 acceptance carried
forward from atom 4c's deferred fixture.

Per CF_ENGINE_DISCIPLINE I-47 / plan §1195 the parity is enforced by
EXECUTION on the same fixture (atom 4a §974-979 Refactor-equivalence:
self-comparison is worthless). Each test runs the same fixture through
the SCALAR floor and the SOURCE_BANDED fast path and asserts numerical
identity of all four canonical trace surfaces — ``node_density``,
``edge_contribution_by_edge_source``, ``node_basis_by_node_bucket``,
``node_mass_by_provenance`` — which is the seed for the §1136
"frontier occupancy built from fast-path empirical traces matches
frontier occupancy built from scalar traces exactly" acceptance.
"""

from __future__ import annotations

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
    build_empirical_evidence_primitive,
    compose_empirical_span,
)
from runner.empirical_evidence_operator import (
    _build_empirical_flat_kernel_provider,
)
from runner.model_span_spine import (
    FrontierOccupancyLedger,
    build_frontier_occupancy,
)
from runner.prefix_arrival import NodeArrivalProvenance, NodeArrivalWeights
from runner.primitives import PrimitiveScope, TimingFamily, TransitionIdentity
from runner.subject_span_composer import EvidenceReadoutBinding
from runner.timing_span import (
    DPExecutionPolicy,
    SpanDPTrace,
    _run_dp_density_trace_from_seed,
)


# ─── Fixture helpers (mirrors test_empirical_evidence_operator.py) ──────


def _scope(scenario_id: str = 'scn-source-banded') -> PrimitiveScope:
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
    draw_count: int,
    per_draw_jitter: float = 0.0,
) -> NodeArrivalWeights:
    """Arrival weights with optional per-draw jitter.

    ``per_draw_jitter > 0.0`` produces draw-varying weights — the per-
    draw arrays differ across the S axis so the empirical kernel's
    per-draw cumulative is no longer S-degenerate. This activates the
    ``s_eff = S`` branch of ``_empirical_cumulative_s_axis_width`` and
    therefore exercises the source-banded chunking on the worst-case
    memory layout (per plan §1117 — "no collapse of the draw axis as
    a primary strategy"). When ``per_draw_jitter == 0.0`` the weights
    degenerate to the s_eff=1 fast path.
    """
    weights = dict(weights_by_day)
    rng = np.random.default_rng(20260524)
    weights_draws = {}
    for day, w in weights.items():
        base = float(w)
        if per_draw_jitter <= 0.0:
            arr = np.full(int(draw_count), base, dtype=np.float64)
        else:
            noise = rng.normal(0.0, per_draw_jitter, size=int(draw_count))
            arr = np.clip(base + noise, 1e-6, None)
        weights_draws[day] = arr
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
            note='source-banded parity fixture',
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
        provenance={'source': 'source_banded_parity_fixture'},
    )


def _run_empirical_dp_each_policy(
    *,
    span,
    primitive_by_edge,
    root_seed: np.ndarray,
    origin_days,
    binding,
    S: int,
    T: int,
    cohort_count: int,
    policies,
) -> dict:
    """Run the empirical-provider DP under each requested policy.

    Each call uses a fresh provider closure so any in-closure mutation
    cannot leak across policies. Returns ``{policy: SpanDPTrace}``.
    """
    results = {}
    for policy in policies:
        provider = _build_empirical_flat_kernel_provider(
            primitive_by_edge=primitive_by_edge,
            origin_days=origin_days,
            evidence_readout_binding=binding,
            S=S,
            T=T,
        )
        results[policy] = _run_dp_density_trace_from_seed(
            span.topology,
            provider,
            root_seed.copy(),
            root_seed.shape[0],
            T,
            execution_policy=policy,
            cohort_count=cohort_count,
        )
    return results


def _assert_traces_identical(
    trace_a: SpanDPTrace,
    trace_b: SpanDPTrace,
    *,
    label_a: str,
    label_b: str,
    on_path,
    edge_keys,
) -> None:
    """Assert all four canonical trace surfaces agree exactly."""
    for node in on_path:
        np.testing.assert_allclose(
            trace_a.node_density(node),
            trace_b.node_density(node),
            atol=1e-12,
            err_msg=f'{label_a} vs {label_b} node_density mismatch @ {node}',
        )
        # Per-bucket node_density_by_node_bucket agreement (the canonical
        # source-bucket surface, sum-projected by node_density).
        bucket_a = trace_a.node_density_by_node_bucket.get(node, {})
        bucket_b = trace_b.node_density_by_node_bucket.get(node, {})
        assert set(bucket_a.keys()) == set(bucket_b.keys()), (
            f'{label_a} vs {label_b} bucket-key mismatch @ {node}: '
            f'{label_a}={sorted(bucket_a.keys())} '
            f'{label_b}={sorted(bucket_b.keys())}'
        )
        for col in bucket_a:
            np.testing.assert_allclose(
                bucket_a[col], bucket_b[col], atol=1e-12,
                err_msg=(
                    f'{label_a} vs {label_b} bucket mass mismatch '
                    f'@ {node}[{col}]'
                ),
            )
    for edge_key in edge_keys:
        np.testing.assert_allclose(
            trace_a.edge_contribution(edge_key),
            trace_b.edge_contribution(edge_key),
            atol=1e-12,
            err_msg=(
                f'{label_a} vs {label_b} edge_contribution mismatch '
                f'@ {edge_key}'
            ),
        )
        smear_a = trace_a.edge_contribution_by_edge_source.get(edge_key, {})
        smear_b = trace_b.edge_contribution_by_edge_source.get(edge_key, {})
        assert set(smear_a.keys()) == set(smear_b.keys()), (
            f'{label_a} vs {label_b} edge_contribution_by_edge_source '
            f'source-bucket-key mismatch @ {edge_key}'
        )
        for u in smear_a:
            np.testing.assert_allclose(
                smear_a[u], smear_b[u], atol=1e-12,
                err_msg=(
                    f'{label_a} vs {label_b} per-source smear mismatch '
                    f'@ {edge_key}[u={u}]'
                ),
            )
    # node_basis / node_mass per provenance — the basis ledger surfaces
    # downstream chained DPs (FC continuation, carrier→subject handoff)
    # read. Same keys, same values bucket-by-bucket per provenance.
    for node in on_path:
        basis_a = trace_a.node_basis_by_node_bucket.get(node, {})
        basis_b = trace_b.node_basis_by_node_bucket.get(node, {})
        assert set(basis_a.keys()) == set(basis_b.keys()), (
            f'{label_a} vs {label_b} node_basis bucket-key mismatch '
            f'@ {node}'
        )
        for col in basis_a:
            assert dict(basis_a[col]) == dict(basis_b[col]), (
                f'{label_a} vs {label_b} node_basis provenance mismatch '
                f'@ {node}[{col}]'
            )
        mass_a = trace_a.node_mass_by_provenance.get(node, {})
        mass_b = trace_b.node_mass_by_provenance.get(node, {})
        assert set(mass_a.keys()) == set(mass_b.keys()), (
            f'{label_a} vs {label_b} node_mass_by_provenance bucket-key '
            f'mismatch @ {node}'
        )
        for col in mass_a:
            assert set(mass_a[col].keys()) == set(mass_b[col].keys()), (
                f'{label_a} vs {label_b} node_mass_by_provenance '
                f'provenance-key mismatch @ {node}[{col}]'
            )
            for prov_key in mass_a[col]:
                np.testing.assert_allclose(
                    mass_a[col][prov_key], mass_b[col][prov_key],
                    atol=1e-12,
                    err_msg=(
                        f'{label_a} vs {label_b} node_mass_by_provenance '
                        f'mass mismatch @ {node}[{col}][{prov_key}]'
                    ),
                )


# ─── F-emp-1: single-hop, source-day-varying evidence ──────────────────


def test_single_hop_source_day_varying_scalar_vs_source_banded():
    """Plan §1131 — single-hop empirical evidence varying by source day.

    The fixture admits two distinct source days with different k/n
    profiles so the per-source-bucket kernel inflects per u. SCALAR
    and SOURCE_BANDED must produce identical traces; SOURCE_BANDED
    also preserves per-source smears, which the per-bucket assertion
    checks bucket-by-bucket (plan §1107).
    """
    draw_count = 4
    horizon_len = 16
    scope = _scope()
    arrival = _arrival_weights(
        {'2026-03-15': 1.0, '2026-03-16': 1.0},
        draw_count=draw_count,
    )
    primitive = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv',
        ),
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=[
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-18',
                n=20, k=8,
            ),
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-22',
                n=20, k=12,
            ),
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-16', retrieved_at='2026-03-19',
                n=15, k=4,
            ),
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-16', retrieved_at='2026-03-22',
                n=15, k=7,
            ),
        ],
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
    origin_days = [date(2026, 3, 15), date(2026, 3, 16)]
    binding = EvidenceReadoutBinding.window()
    cohort_count = len(origin_days)
    S_flat = cohort_count * draw_count
    root_seed = np.zeros((S_flat, horizon_len), dtype=np.float64)
    root_seed[:, 0] = 1.0

    results = _run_empirical_dp_each_policy(
        span=span, primitive_by_edge=primitive_by_edge,
        root_seed=root_seed, origin_days=origin_days, binding=binding,
        S=draw_count, T=horizon_len, cohort_count=cohort_count,
        policies=(
            DPExecutionPolicy.SCALAR,
            DPExecutionPolicy.SOURCE_BANDED,
        ),
    )

    edge_keys = [ce.edge_key for ce in span.topology.concrete_edges]
    _assert_traces_identical(
        results[DPExecutionPolicy.SCALAR],
        results[DPExecutionPolicy.SOURCE_BANDED],
        label_a='SCALAR', label_b='SOURCE_BANDED',
        on_path=span.topology.on_path, edge_keys=edge_keys,
    )


# ─── F-emp-2: multi-hop with draw-varying arrival weights ──────────────


def test_multi_hop_draw_varying_weights_scalar_vs_source_banded():
    """Plan §1132 — multi-hop empirical evidence with draw-varying
    arrival weights.

    Per-draw arrival weights jitter activates ``s_eff = S`` (the
    non-degenerate cubic-spline path), exercising the source-banded
    fast path's chunked memory budget. The two-edge chain composes
    per-edge empirical kernels through the shared DP — SCALAR floor
    and SOURCE_BANDED fast path must agree on every trace surface
    including the intermediate node's basis ledger.
    """
    draw_count = 5
    horizon_len = 14
    scope = _scope()
    arrival_u = _arrival_weights(
        {'2026-03-15': 1.0}, draw_count=draw_count,
        per_draw_jitter=0.05,
    )
    arrival_v = _arrival_weights(
        {'2026-03-15': 1.0}, draw_count=draw_count,
        per_draw_jitter=0.08,
    )

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
                observed_date='2026-03-15', retrieved_at='2026-03-18',
                n=20, k=6,
            ),
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-22',
                n=20, k=10,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
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
                observed_date='2026-03-15', retrieved_at='2026-03-19',
                n=12, k=4,
            ),
            _candidate(
                from_id='V', to_id='W',
                observed_date='2026-03-15', retrieved_at='2026-03-23',
                n=12, k=7,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}, {'id': 'W'}],
        'edges': [
            {'edge_id': 'e-uv', 'from': 'U', 'to': 'V'},
            {'edge_id': 'e-vw', 'from': 'V', 'to': 'W'},
        ],
    }

    primitives_by_pair = {('U', 'V'): e_uv, ('V', 'W'): e_vw}

    def lookup(from_id, to_id, edge_data):
        return primitives_by_pair[(from_id, to_id)]

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='W',
        edge_to_empirical_primitive_lookup=lookup,
        draw_count=draw_count,
        horizon_len=horizon_len,
    )

    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    origin_days = [date(2026, 3, 15), date(2026, 3, 16), date(2026, 3, 17)]
    binding = EvidenceReadoutBinding.window()
    cohort_count = len(origin_days)
    S_flat = cohort_count * draw_count
    root_seed = np.zeros((S_flat, horizon_len), dtype=np.float64)
    root_seed[:, 0] = 1.0

    results = _run_empirical_dp_each_policy(
        span=span, primitive_by_edge=primitive_by_edge,
        root_seed=root_seed, origin_days=origin_days, binding=binding,
        S=draw_count, T=horizon_len, cohort_count=cohort_count,
        policies=(
            DPExecutionPolicy.SCALAR,
            DPExecutionPolicy.SOURCE_BANDED,
        ),
    )

    edge_keys = [ce.edge_key for ce in span.topology.concrete_edges]
    _assert_traces_identical(
        results[DPExecutionPolicy.SCALAR],
        results[DPExecutionPolicy.SOURCE_BANDED],
        label_a='SCALAR', label_b='SOURCE_BANDED',
        on_path=span.topology.on_path, edge_keys=edge_keys,
    )


# ─── F-emp-3: mixed-basis non-latent → latent handoff ──────────────────


def test_mixed_basis_handoff_scalar_vs_source_banded():
    """Plan §1133 — mixed-basis carrier-to-subject handoff.

    A non-latent first hop (``timing_family=NON_LATENT``,
    ``use_source_basis=True``) passes its source basis through, while
    the latent second hop (``LATENT``) emits BUCKET_DISTRIBUTED. The
    intermediate node ledger therefore carries the non-latent's
    out_basis; the next hop dispatches under its own basis. Both
    SCALAR and SOURCE_BANDED must reproduce this dispatch identically.
    """
    draw_count = 3
    horizon_len = 12
    scope = _scope()
    arrival_u = _arrival_weights({'2026-03-15': 1.0}, draw_count=draw_count)
    arrival_v = _arrival_weights({'2026-03-15': 1.0}, draw_count=draw_count)

    e_uv = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv-nl',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_u,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=[
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-18',
                n=10, k=6,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
        timing_family=TimingFamily.NON_LATENT,
        use_source_basis=True,
    )
    e_vw = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='V', destination_node='W', edge_id='e-vw-lat',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_v,
        evidence_scope=_evidence_scope('V', 'W', scope),
        candidates=[
            _candidate(
                from_id='V', to_id='W',
                observed_date='2026-03-15', retrieved_at='2026-03-20',
                n=8, k=3,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
        timing_family=TimingFamily.LATENT,
        use_source_basis=False,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}, {'id': 'W'}],
        'edges': [
            {'edge_id': 'e-uv-nl', 'from': 'U', 'to': 'V'},
            {'edge_id': 'e-vw-lat', 'from': 'V', 'to': 'W'},
        ],
    }

    primitives_by_pair = {('U', 'V'): e_uv, ('V', 'W'): e_vw}

    def lookup(from_id, to_id, edge_data):
        return primitives_by_pair[(from_id, to_id)]

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='W',
        edge_to_empirical_primitive_lookup=lookup,
        draw_count=draw_count,
        horizon_len=horizon_len,
    )

    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    origin_days = [date(2026, 3, 15)]
    binding = EvidenceReadoutBinding.window()
    cohort_count = len(origin_days)
    S_flat = cohort_count * draw_count
    root_seed = np.zeros((S_flat, horizon_len), dtype=np.float64)
    root_seed[:, 0] = 1.0

    results = _run_empirical_dp_each_policy(
        span=span, primitive_by_edge=primitive_by_edge,
        root_seed=root_seed, origin_days=origin_days, binding=binding,
        S=draw_count, T=horizon_len, cohort_count=cohort_count,
        policies=(
            DPExecutionPolicy.SCALAR,
            DPExecutionPolicy.SOURCE_BANDED,
        ),
    )

    edge_keys = [ce.edge_key for ce in span.topology.concrete_edges]
    _assert_traces_identical(
        results[DPExecutionPolicy.SCALAR],
        results[DPExecutionPolicy.SOURCE_BANDED],
        label_a='SCALAR', label_b='SOURCE_BANDED',
        on_path=span.topology.on_path, edge_keys=edge_keys,
    )


# ─── F-emp-4: branch / merge with coincident sibling edges ─────────────


def test_branch_merge_coincident_siblings_scalar_vs_source_banded():
    """Plan §1134 — branch / merge topology with coincident sibling edges.

    Two parallel edges ``U → V`` (``e-uv#0`` and ``e-uv#1`` per the
    topology builder's per-(from, to) numbering) carry different
    empirical kernels; both contribute mass to node V, and the per-
    sibling smear must be preserved bucket-by-bucket so frontier
    occupancy and downstream consumers see each sibling's per-source
    contribution.
    """
    draw_count = 3
    horizon_len = 12
    scope = _scope()
    arrival_a = _arrival_weights({'2026-03-15': 1.0}, draw_count=draw_count)
    arrival_b = _arrival_weights({'2026-03-15': 1.0}, draw_count=draw_count)

    e_uv_a = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv-a',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_a,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=[
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-18',
                n=12, k=7,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
    )
    e_uv_b = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv-b',
        ),
        primitive_scope=scope,
        arrival_weights=arrival_b,
        evidence_scope=_evidence_scope('U', 'V', scope),
        candidates=[
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-22',
                n=14, k=5,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}],
        'edges': [
            {'edge_id': 'e-uv-a', 'from': 'U', 'to': 'V'},
            {'edge_id': 'e-uv-b', 'from': 'U', 'to': 'V'},
        ],
    }

    # The composer lookup is keyed on (from_id, to_id, edge_data); each
    # sibling carries its own ``edge_id`` in edge_data so the lookup
    # dispatches per sibling.
    edge_id_to_primitive = {
        'e-uv-a': e_uv_a,
        'e-uv-b': e_uv_b,
    }

    def lookup(from_id, to_id, edge_data):
        return edge_id_to_primitive[edge_data['edge_id']]

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
    origin_days = [date(2026, 3, 15), date(2026, 3, 16)]
    binding = EvidenceReadoutBinding.window()
    cohort_count = len(origin_days)
    S_flat = cohort_count * draw_count
    root_seed = np.zeros((S_flat, horizon_len), dtype=np.float64)
    root_seed[:, 0] = 1.0

    results = _run_empirical_dp_each_policy(
        span=span, primitive_by_edge=primitive_by_edge,
        root_seed=root_seed, origin_days=origin_days, binding=binding,
        S=draw_count, T=horizon_len, cohort_count=cohort_count,
        policies=(
            DPExecutionPolicy.SCALAR,
            DPExecutionPolicy.SOURCE_BANDED,
        ),
    )

    edge_keys = [ce.edge_key for ce in span.topology.concrete_edges]
    _assert_traces_identical(
        results[DPExecutionPolicy.SCALAR],
        results[DPExecutionPolicy.SOURCE_BANDED],
        label_a='SCALAR', label_b='SOURCE_BANDED',
        on_path=span.topology.on_path, edge_keys=edge_keys,
    )


# ─── F-emp-5: frontier occupancy parity (plan §1135-1137) ──────────────


def _assert_frontier_occupancies_identical(
    ledger_a: FrontierOccupancyLedger,
    ledger_b: FrontierOccupancyLedger,
    *,
    label_a: str,
    label_b: str,
) -> None:
    """Walk every public surface of the dataclass so any divergence in
    the DP trace surfaces feeding ``build_frontier_occupancy``
    propagates here.
    """
    assert ledger_a.terminal_node_id == ledger_b.terminal_node_id
    assert ledger_a.cohort_count == ledger_b.cohort_count
    assert ledger_a.draw_count == ledger_b.draw_count
    assert ledger_a.horizon_len == ledger_b.horizon_len

    occ_a = ledger_a.occupancy_by_node_bucket
    occ_b = ledger_b.occupancy_by_node_bucket
    assert set(occ_a.keys()) == set(occ_b.keys()), (
        f'{label_a} vs {label_b} occupancy node-key mismatch'
    )
    for node in occ_a:
        bucket_a = occ_a[node]
        bucket_b = occ_b[node]
        assert set(bucket_a.keys()) == set(bucket_b.keys()), (
            f'{label_a} vs {label_b} occupancy bucket-key mismatch @ {node}'
        )
        for u in bucket_a:
            basis_a = bucket_a[u]
            basis_b = bucket_b[u]
            assert set(basis_a.keys()) == set(basis_b.keys()), (
                f'{label_a} vs {label_b} occupancy basis-key mismatch '
                f'@ {node}[u={u}]'
            )
            for basis_int in basis_a:
                np.testing.assert_allclose(
                    basis_a[basis_int], basis_b[basis_int], atol=1e-12,
                    err_msg=(
                        f'{label_a} vs {label_b} occupancy mass mismatch '
                        f'@ {node}[u={u}][basis={basis_int}]'
                    ),
                )

    np.testing.assert_allclose(
        ledger_a.terminal_arrivals_cumulative,
        ledger_b.terminal_arrivals_cumulative,
        atol=1e-12,
        err_msg=f'{label_a} vs {label_b} terminal_arrivals_cumulative',
    )
    np.testing.assert_allclose(
        ledger_a.terminal_at_f, ledger_b.terminal_at_f,
        atol=1e-12,
        err_msg=f'{label_a} vs {label_b} terminal_at_f',
    )
    np.testing.assert_allclose(
        ledger_a.root_total, ledger_b.root_total,
        atol=1e-12,
        err_msg=f'{label_a} vs {label_b} root_total',
    )


def test_frontier_occupancy_scalar_vs_source_banded():
    """Plan §1135-1137 — frontier occupancy from fast-path empirical
    traces matches scalar traces exactly.

    Multi-hop chain U→V→W with per-draw arrival jitter so the
    intermediate node V carries non-trivial occupancy at each cohort's
    own ``f_c``. ``build_frontier_occupancy`` consumes the four
    canonical trace surfaces; any disagreement between SCALAR and
    SOURCE_BANDED on those surfaces surfaces here as a divergence in
    the derived ledger.
    """
    draw_count = 4
    horizon_len = 14
    scope = _scope()
    arrival_u = _arrival_weights(
        {'2026-03-15': 1.0}, draw_count=draw_count,
        per_draw_jitter=0.05,
    )
    arrival_v = _arrival_weights(
        {'2026-03-15': 1.0}, draw_count=draw_count,
        per_draw_jitter=0.08,
    )

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
                observed_date='2026-03-15', retrieved_at='2026-03-18',
                n=20, k=6,
            ),
            _candidate(
                from_id='U', to_id='V',
                observed_date='2026-03-15', retrieved_at='2026-03-22',
                n=20, k=10,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
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
                observed_date='2026-03-15', retrieved_at='2026-03-19',
                n=12, k=4,
            ),
            _candidate(
                from_id='V', to_id='W',
                observed_date='2026-03-15', retrieved_at='2026-03-23',
                n=12, k=7,
            ),
        ],
        draw_count=draw_count,
        horizon_len=horizon_len,
    )

    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}, {'id': 'W'}],
        'edges': [
            {'edge_id': 'e-uv', 'from': 'U', 'to': 'V'},
            {'edge_id': 'e-vw', 'from': 'V', 'to': 'W'},
        ],
    }
    primitives_by_pair = {('U', 'V'): e_uv, ('V', 'W'): e_vw}

    def lookup(from_id, to_id, edge_data):
        return primitives_by_pair[(from_id, to_id)]

    span = compose_empirical_span(
        graph=graph,
        x_node_id='U',
        end_node_id='W',
        edge_to_empirical_primitive_lookup=lookup,
        draw_count=draw_count,
        horizon_len=horizon_len,
    )

    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    origin_days = [date(2026, 3, 15), date(2026, 3, 16), date(2026, 3, 17)]
    binding = EvidenceReadoutBinding.window()
    cohort_count = len(origin_days)
    S_flat = cohort_count * draw_count
    root_seed = np.zeros((S_flat, horizon_len), dtype=np.float64)
    root_seed[:, 0] = 1.0

    results = _run_empirical_dp_each_policy(
        span=span, primitive_by_edge=primitive_by_edge,
        root_seed=root_seed, origin_days=origin_days, binding=binding,
        S=draw_count, T=horizon_len, cohort_count=cohort_count,
        policies=(
            DPExecutionPolicy.SCALAR,
            DPExecutionPolicy.SOURCE_BANDED,
        ),
    )

    # Per-cohort frontiers staggered across cohorts so the bucket-
    # visibility gate (u <= f_c) bites at different (cohort, bucket)
    # combinations. Any per-source smear disagreement between policies
    # would manifest as different per-cohort cumulative departures.
    frontier_by_cohort = np.array([5, 8, 11], dtype=np.int64)

    ledger_scalar = build_frontier_occupancy(
        trace=results[DPExecutionPolicy.SCALAR],
        topology=span.topology,
        terminal_node_id='W',
        frontier_by_cohort=frontier_by_cohort,
        cohort_count=cohort_count,
        draw_count=draw_count,
    )
    ledger_banded = build_frontier_occupancy(
        trace=results[DPExecutionPolicy.SOURCE_BANDED],
        topology=span.topology,
        terminal_node_id='W',
        frontier_by_cohort=frontier_by_cohort,
        cohort_count=cohort_count,
        draw_count=draw_count,
    )

    # Intermediate node V must carry occupancy under this fixture;
    # otherwise the parity assertion would be vacuous.
    assert 'V' in ledger_scalar.occupancy_by_node_bucket, (
        'fixture invariant: intermediate node V should carry occupancy '
        'at the chosen frontiers'
    )

    _assert_frontier_occupancies_identical(
        ledger_scalar, ledger_banded,
        label_a='SCALAR', label_b='SOURCE_BANDED',
    )
