"""Atom 4d synth-lat4 scale benchmark.

Measures wall-clock + peak working memory of the empirical DP across
SCALAR / BATCHED_KERNEL / SOURCE_BANDED policies on the synth-lat4
target scale per FC plan §1141 (49 Cohorts × 1000 draws × horizon 115,
representative source-day-varying evidence). Output:

  - per-policy median wall-clock over N runs;
  - per-policy peak working memory (tracemalloc snapshot delta);
  - speedup vs SCALAR / vs BATCHED_KERNEL.

Plan §1141 acceptance: "If the improvement is not material, the atom
records the profile and does not keep extra machinery just for
architectural symmetry." This script is the record.
"""

from __future__ import annotations

import os
import sys
import time
import tracemalloc
from datetime import date, timedelta
from statistics import median

sys.path.insert(0, '/home/reg/dev/dagnet/graph-editor/lib')

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
    _empirical_cumulative_s_axis_width,
    _source_banded_chunk_size,
    build_empirical_evidence_primitive,
    compose_empirical_span,
)
from runner.prefix_arrival import NodeArrivalProvenance, NodeArrivalWeights
from runner.primitives import PrimitiveScope, TimingFamily, TransitionIdentity
from runner.subject_span_composer import EvidenceReadoutBinding
from runner.timing_span import (
    DPExecutionPolicy,
    _run_dp_density_trace_from_seed,
)


# Synth-lat4 scale per plan §1139.
COHORT_COUNT = 49
DRAW_COUNT = 1000
HORIZON = 115
ACTIVE_SOURCE_DAYS = 60   # representative number of distinct admitted source days
RUNS_PER_POLICY = 1       # one run per policy — we're looking for big changes


def _scope() -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id='scn-synth-lat4',
        evidence_role='window_subject_helper',
        date_from='2026-01-01',
        date_to='2026-12-31',
        as_at='2026-12-31',
        context_key=None,
        regime_key=None,
        model_source_preference='analytic',
        resolved_source_identity=None,
        selected_anchor_days=(),
    )


def _arrival_weights(weights_by_day, *, draw_count, jitter):
    rng = np.random.default_rng(42)
    weights_draws = {}
    for day, w in weights_by_day.items():
        noise = rng.normal(0.0, jitter, size=int(draw_count))
        weights_draws[day] = np.clip(float(w) + noise, 1e-6, None)
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
            note='synth-lat4 benchmark',
        ),
    )


def _candidate(*, from_id, to_id, observed_date, retrieved_at, n, k):
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=from_id, subject_to=to_id, anchor=None,
            slice_family=SliceFamily.WINDOW,
            context_key=None, regime_key=None, population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.UNKNOWN,
            asat_materialised=False,
        ),
        n=n, k=k,
        provenance={'source': 'synth-lat4-benchmark'},
    )


def _build_benchmark_span():
    scope = _scope()
    base = date(2026, 1, 1)
    weights_by_day = {
        (base + timedelta(days=i)).isoformat(): 1.0
        for i in range(ACTIVE_SOURCE_DAYS)
    }
    arrival = _arrival_weights(
        weights_by_day, draw_count=DRAW_COUNT, jitter=0.1,
    )
    # Per source day, generate 3 retrievals (sparse evidence panel).
    candidates = []
    rng = np.random.default_rng(20260524)
    for i in range(ACTIVE_SOURCE_DAYS):
        observed = (base + timedelta(days=i)).isoformat()
        for retrieval_delta in (3, 10, 30):
            retrieved = (base + timedelta(days=i + retrieval_delta)).isoformat()
            n = int(rng.integers(15, 30))
            k = int(rng.integers(2, n // 2 + 1))
            candidates.append(_candidate(
                from_id='U', to_id='V',
                observed_date=observed, retrieved_at=retrieved,
                n=n, k=k,
            ))
    primitive = build_empirical_evidence_primitive(
        transition=TransitionIdentity(
            source_node='U', destination_node='V', edge_id='e-uv',
        ),
        primitive_scope=scope,
        arrival_weights=arrival,
        evidence_scope=EvidenceScope(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from='U', subject_to='V',
            date_from=scope.date_from, date_to=scope.date_to,
            as_at=scope.as_at, scenario_id=scope.scenario_id,
        ),
        candidates=candidates,
        draw_count=DRAW_COUNT,
        horizon_len=HORIZON,
    )
    graph = {
        'nodes': [{'id': 'U'}, {'id': 'V'}],
        'edges': [{'edge_id': 'e-uv', 'from': 'U', 'to': 'V'}],
    }

    def lookup(from_id, to_id, edge_data):
        return primitive

    return compose_empirical_span(
        graph=graph, x_node_id='U', end_node_id='V',
        edge_to_empirical_primitive_lookup=lookup,
        draw_count=DRAW_COUNT, horizon_len=HORIZON,
    )


def _time_and_measure(span, *, policy, origin_days, root_seed, binding):
    """Run the DP under ``policy`` and return (wall_seconds, peak_bytes, dispatch_log)."""
    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    cohort_count = len(origin_days)
    # Fresh provider per run so any closure state is reset.
    provider = _build_empirical_flat_kernel_provider(
        primitive_by_edge=primitive_by_edge,
        origin_days=origin_days,
        evidence_readout_binding=binding,
        S=DRAW_COUNT,
        T=HORIZON,
    )
    tracemalloc.start()
    snapshot_before = tracemalloc.take_snapshot()
    t0 = time.perf_counter()
    _trace = _run_dp_density_trace_from_seed(
        span.topology,
        provider,
        root_seed.copy(),
        root_seed.shape[0],
        HORIZON,
        execution_policy=policy,
        cohort_count=cohort_count,
    )
    elapsed = time.perf_counter() - t0
    snapshot_after = tracemalloc.take_snapshot()
    tracemalloc.stop()
    # Peak working memory: sum of size_diff over all positive deltas.
    diffs = snapshot_after.compare_to(snapshot_before, 'lineno')
    peak_alloc = sum(max(0, d.size_diff) for d in diffs)
    dispatch_log = getattr(provider, '_source_banded_dispatch_log', None)
    return elapsed, peak_alloc, dispatch_log


def main():
    print(f"Building synth-lat4 span (C={COHORT_COUNT}, D={DRAW_COUNT}, "
          f"T={HORIZON}, ~active_u={ACTIVE_SOURCE_DAYS})...")
    span = _build_benchmark_span()
    primitive = span.empirical_edge_primitives[0][1]
    print(f"  active source-day kernels: "
          f"{len(primitive.value_kernel_draws_by_source_day)}")
    s_eff = _empirical_cumulative_s_axis_width(primitive)
    derived_chunk = _source_banded_chunk_size(
        C=COHORT_COUNT, s_eff=s_eff, T=HORIZON,
    )
    print(f"  s_eff (effective S-axis width): {s_eff}")
    print(f"  SOURCE_BANDED chunk_size_u (derived from budget): "
          f"{derived_chunk}")

    base = date(2026, 1, 1)
    origin_days = [base + timedelta(days=i) for i in range(COHORT_COUNT)]
    binding_name = os.environ.get('BINDING', 'window')
    binding = (
        EvidenceReadoutBinding.cohort()
        if binding_name == 'cohort'
        else EvidenceReadoutBinding.window()
    )
    print(f"  binding: {binding.mode}")
    S_flat = COHORT_COUNT * DRAW_COUNT
    # Seed mass across the first ACTIVE_SOURCE_DAYS columns of the root
    # to simulate post-carrier-handoff multi-bucket smear (the realistic
    # subject-DP entry point in the spine row pipeline). δ(0)-only seed
    # collapses ``active_u = 1`` and degenerates the SOURCE_BANDED loop
    # to a one-iteration trivial — that's the identity-carrier case the
    # carrier-DP already handles efficiently; the source-banded fast
    # path's amortisation matters when the subject root carries dozens
    # of distinct active source buckets, which is the active-carrier /
    # cohort()-mode profile.
    root_seed = np.zeros((S_flat, HORIZON), dtype=np.float64)
    rng_seed = np.random.default_rng(20260524)
    for col in range(ACTIVE_SOURCE_DAYS):
        # Decreasing-mass profile across columns — typical of a
        # latency-smeared carrier terminal.
        root_seed[:, col] = (
            np.exp(-col / 20.0) * (1.0 + 0.05 * rng_seed.standard_normal(S_flat))
        )

    print(f"\nRunning {RUNS_PER_POLICY} runs per policy:\n")
    results = {}
    # NOTE: TOEPLITZ_APPLY (formerly BATCHED_KERNEL) is excluded —
    # empirical kernels are not shift-invariant in `u` (the per-source-
    # day kernel depends on the source day), so the empirical provider
    # does not expose ``.batched_op``. SCALAR ↔ SOURCE_BANDED is the
    # full comparable axis for this provider.
    for policy in (
        DPExecutionPolicy.SCALAR,
        DPExecutionPolicy.SOURCE_BANDED,
    ):
        wall_times = []
        peak_mems = []
        for run_idx in range(RUNS_PER_POLICY):
            elapsed, peak, dlog = _time_and_measure(
                span,
                policy=policy,
                origin_days=origin_days,
                root_seed=root_seed,
                binding=binding,
            )
            wall_times.append(elapsed)
            peak_mems.append(peak)
            extras = ""
            if dlog and policy == DPExecutionPolicy.SOURCE_BANDED:
                e = dlog[-1]
                extras = (
                    f"  [reuse={e.get('reuse_ratio', 0):.1f} "
                    f"cache_hits={e.get('n_cache_hits', 0)}/{e.get('n_groups', 0)} "
                    f"build={e.get('build_sub_path', '?')} "
                    f"n_built={e.get('n_built', 0)} n_chunks={e.get('n_chunks', 0)}]"
                )
            print(f"  {policy.value:15s} run {run_idx + 1}: "
                  f"wall={elapsed:.3f}s peak_alloc={peak / 1024**2:7.2f} MiB{extras}")
        results[policy] = {
            'median_wall_s': median(wall_times),
            'peak_alloc_bytes': max(peak_mems),
        }

    print("\nSummary (median wall-clock, max peak alloc):")
    print(f"  {'policy':15s} {'wall (s)':>10s} {'peak alloc (MiB)':>20s}")
    for policy, stats in results.items():
        print(f"  {policy.value:15s} {stats['median_wall_s']:>10.3f} "
              f"{stats['peak_alloc_bytes'] / 1024**2:>20.2f}")

    scalar_wall = results[DPExecutionPolicy.SCALAR]['median_wall_s']
    banded_wall = results[DPExecutionPolicy.SOURCE_BANDED]['median_wall_s']
    scalar_peak = results[DPExecutionPolicy.SCALAR]['peak_alloc_bytes']
    banded_peak = results[DPExecutionPolicy.SOURCE_BANDED]['peak_alloc_bytes']
    print(f"\nSpeedups + memory ratio (median wall-clock):")
    print(f"  SOURCE_BANDED vs SCALAR runtime:  {scalar_wall / banded_wall:.2f}×")
    print(f"  SOURCE_BANDED vs SCALAR peak:     "
          f"{scalar_peak / max(banded_peak, 1):.2f}×")


if __name__ == '__main__':
    main()
