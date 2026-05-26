"""Tests for ``build_frontier_occupancy`` (FC proposal §5.2 / §9.3).

Atom 4 of the frontier-conditioned chart-surface proposal. The helper
turns a source-aware ``SpanDPTrace`` into per-cohort per-(node,
source_bucket) unresolved-occupancy ledgers plus terminal-prefix data.
The tests pin:

- conservation (terminal cumsum at f + Σ occupancy == root total),
- terminal exclusion (the role's end node carries the prefix, not the
  occupancy ledger),
- per-cohort frontier independence (each Cohort uses its own ``f_c``),
- node-level vs edge-local departures at branching nodes,
- algebraic degeneracies (identity span, multi-hop subject).
"""

from __future__ import annotations

import os
import sys
from typing import Dict, List, Tuple

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.bucket_transition import BucketSourceBasis
from runner.model_span_spine import (
    FrontierOccupancyLedger,
    build_frontier_occupancy,
)
from runner.span_kernel import ConcreteEdge, _build_span_topology
from runner.timing_span import (
    SpanDPTrace,
    _run_dp_density_trace,
    _run_dp_density_trace_from_seed,
)


# ─── Fixture helpers ──────────────────────────────────────────────────────


def _make_graph(nodes: List[str], edges: List[Tuple[str, str]]) -> dict:
    return {
        'nodes': [{'id': n, 'uuid': n} for n in nodes],
        'edges': [
            {'from_node': f, 'to': t, 'uuid': f'{f}_{t}_{idx}'}
            for idx, (f, t) in enumerate(edges)
        ],
    }


def _dirac_kernel(lag: int, T: int, S: int = 1) -> np.ndarray:
    """Per-draw Dirac kernel of shape ``(S, T)`` at ``lag``."""
    kernel = np.zeros((S, T), dtype=np.float64)
    if 0 <= lag < T:
        kernel[:, lag] = 1.0
    return kernel


def _bernoulli_dirac_kernel(p: float, lag: int, T: int, S: int = 1) -> np.ndarray:
    """Probability-``p`` mass at ``lag`` and zero elsewhere."""
    kernel = np.zeros((S, T), dtype=np.float64)
    if 0 <= lag < T:
        kernel[:, lag] = float(p)
    return kernel


def _trace_with_kernels(
    *,
    graph: dict,
    x_id: str,
    y_id: str,
    kernels_by_edge: Dict[Tuple[str, str, int], np.ndarray],
    T: int,
    S: int = 1,
) -> Tuple[SpanDPTrace, "SpanTopology"]:  # noqa: F821 — imported lazily
    """Run the source-aware DP over a graph with per-edge kernels.

    ``kernels_by_edge`` is keyed by ``(from_id, to_id, sibling_idx)`` so
    parallel siblings can carry distinct kernels.
    """
    topology = _build_span_topology(graph, x_id, y_id)
    assert topology is not None, f"failed to build topology for {x_id}→{y_id}"
    sibling_seen: Dict[Tuple[str, str], int] = {}

    def edge_kernel_provider(ce: ConcreteEdge, source_index: int) -> np.ndarray:
        pair = (ce.from_id, ce.to_id)
        # Determine which sibling this concrete edge is by parsing the
        # edge_key built by _build_span_topology: "<from>-><to>#<idx>".
        sibling_idx = int(ce.edge_key.rsplit('#', 1)[-1])
        key = (ce.from_id, ce.to_id, sibling_idx)
        kernel = kernels_by_edge.get(key)
        if kernel is None:
            # Default to identity (everything sits at source_index)
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
        # Trim/pad to the requested S and starting at source_index = 0;
        # the DP shifts the kernel inside its source-bucket loop.
        return kernel.copy()

    trace = _run_dp_density_trace(topology, edge_kernel_provider, S, T)
    return trace, topology


# ─── Identity span ────────────────────────────────────────────────────────


def test_identity_span_has_empty_occupancy_and_terminal_carries_all_mass():
    """When x == y, no non-terminal nodes exist; conservation holds trivially."""
    graph = _make_graph(['X'], [])
    topology = _build_span_topology(graph, 'X', 'X')
    assert topology is not None
    assert topology.on_path == {'X'}

    # Identity DP: seed δ(0) at root which is also terminal.
    S, T = 1, 4
    trace = _run_dp_density_trace(
        topology, lambda ce, src: np.zeros((S, T)), S, T
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='X',
        frontier_by_cohort=[2],
        cohort_count=1,
        draw_count=1,
    )

    assert ledger.is_empty_occupancy
    assert ledger.occupancy_by_node_bucket == {}
    # Terminal cumsum has the full seed at every τ.
    np.testing.assert_allclose(
        ledger.terminal_arrivals_cumulative[0, 0, :],
        np.array([1.0, 1.0, 1.0, 1.0]),
    )
    np.testing.assert_allclose(ledger.terminal_at_f[0, 0], 1.0)
    np.testing.assert_allclose(ledger.root_total[0, 0], 1.0)


# ─── Single-hop ──────────────────────────────────────────────────────────


def test_single_hop_pre_frontier_keeps_all_mass_at_root():
    """X→Y with Dirac lag 3. At f=2, no departures yet; occupancy=N at X[0]."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    S, T = 1, 6
    trace, topology = _trace_with_kernels(
        graph=graph,
        x_id='X',
        y_id='Y',
        kernels_by_edge={('X', 'Y', 0): _dirac_kernel(3, T)},
        T=T,
        S=S,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[2],
        cohort_count=1,
        draw_count=1,
    )

    # Y is excluded.
    assert 'Y' not in ledger.occupancy_by_node_bucket
    assert 'X' in ledger.occupancy_by_node_bucket
    # All seed mass still at X bucket 0.
    np.testing.assert_allclose(
        ledger.occupancy_by_node_bucket['X'][0][0][0, 0], 1.0
    )
    # No terminal arrivals before lag.
    np.testing.assert_allclose(ledger.terminal_at_f[0, 0], 0.0)


def test_single_hop_post_frontier_drains_to_terminal():
    """X→Y with Dirac lag 3. At f=5 mass has fully departed X."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    S, T = 1, 6
    kernels = {('X', 'Y', 0): _dirac_kernel(3, T)}
    trace, topology = _trace_with_kernels(
        graph=graph,
        x_id='X',
        y_id='Y',
        kernels_by_edge=kernels,
        T=T,
        S=S,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[5],
        cohort_count=1,
        draw_count=1,
    )

    np.testing.assert_allclose(
        ledger.occupancy_by_node_bucket['X'][0][0][0, 0], 0.0, atol=1e-12
    )
    np.testing.assert_allclose(ledger.terminal_at_f[0, 0], 1.0)


def test_single_hop_partial_probability_conserves_at_frontier():
    """Edge with p=0.4 Dirac@2. At f=3, terminal+occupancy == root=1."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    S, T = 1, 4
    kernels = {('X', 'Y', 0): _bernoulli_dirac_kernel(0.4, 2, T)}
    trace, topology = _trace_with_kernels(
        graph=graph,
        x_id='X',
        y_id='Y',
        kernels_by_edge=kernels,
        T=T,
        S=S,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[3],
        cohort_count=1,
        draw_count=1,
    )

    occ = ledger.occupancy_by_node_bucket['X'][0][0][0, 0]
    terminal = ledger.terminal_at_f[0, 0]
    np.testing.assert_allclose(occ, 0.6)
    np.testing.assert_allclose(terminal, 0.4)
    np.testing.assert_allclose(occ + terminal, ledger.root_total[0, 0])


# ─── Branch / sibling: node-level vs edge-local denominator ──────────────


def test_branching_node_uses_node_level_survivor_not_edge_local():
    """Two sibling edges X→Y, each p=0.3 Dirac@1. At f=1, both have fired.

    Departures from X bucket 0 = 0.3 (via sibling 0) + 0.3 (via sibling 1)
    = 0.6, so occupancy at X[0] = 1 - 0.6 = 0.4. The edge-local view
    would say occupancy = 1 - 0.3 = 0.7 per edge, which over-counts
    survivor mass and would let each residual operator allocate more
    future mass than physically remains at the node.
    """
    graph = _make_graph(['X', 'Y'], [('X', 'Y'), ('X', 'Y')])
    S, T = 1, 4
    kernels = {
        ('X', 'Y', 0): _bernoulli_dirac_kernel(0.3, 1, T),
        ('X', 'Y', 1): _bernoulli_dirac_kernel(0.3, 1, T),
    }
    trace, topology = _trace_with_kernels(
        graph=graph,
        x_id='X',
        y_id='Y',
        kernels_by_edge=kernels,
        T=T,
        S=S,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[1],
        cohort_count=1,
        draw_count=1,
    )

    occ = ledger.occupancy_by_node_bucket['X'][0][0][0, 0]
    terminal = ledger.terminal_at_f[0, 0]
    np.testing.assert_allclose(occ, 0.4)
    np.testing.assert_allclose(terminal, 0.6)
    np.testing.assert_allclose(occ + terminal, ledger.root_total[0, 0])


# ─── Multi-hop subject ───────────────────────────────────────────────────


def test_multi_hop_intermediate_node_accumulates_occupancy_then_drains():
    """X→M (lag 2) → Y (lag 3). M's occupancy is non-zero between hops."""
    graph = _make_graph(['X', 'M', 'Y'], [('X', 'M'), ('M', 'Y')])
    S, T = 1, 10
    kernels = {
        ('X', 'M', 0): _dirac_kernel(2, T),
        ('M', 'Y', 0): _dirac_kernel(3, T),
    }
    trace, topology = _trace_with_kernels(
        graph=graph,
        x_id='X',
        y_id='Y',
        kernels_by_edge=kernels,
        T=T,
        S=S,
    )

    # f=3: mass has arrived at M at bucket 2 but hasn't departed yet
    # (M→Y has lag 3, so departure lands at column 5).
    ledger_mid = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[3],
        cohort_count=1,
        draw_count=1,
    )
    assert 'M' in ledger_mid.occupancy_by_node_bucket
    # M bucket 2 holds the full unit of mass.
    np.testing.assert_allclose(
        ledger_mid.occupancy_by_node_bucket['M'][2][1][0, 0], 1.0
    )
    # X bucket 0 has departed (lag-2 hop completed by f=3).
    np.testing.assert_allclose(
        ledger_mid.occupancy_by_node_bucket['X'][0][0][0, 0], 0.0, atol=1e-12
    )
    np.testing.assert_allclose(ledger_mid.terminal_at_f[0, 0], 0.0)

    # f=7: mass has reached Y, both non-terminals are empty.
    ledger_late = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[7],
        cohort_count=1,
        draw_count=1,
    )
    np.testing.assert_allclose(
        ledger_late.occupancy_by_node_bucket['X'][0][0][0, 0], 0.0, atol=1e-12
    )
    np.testing.assert_allclose(
        ledger_late.occupancy_by_node_bucket['M'][2][1][0, 0], 0.0, atol=1e-12
    )
    np.testing.assert_allclose(ledger_late.terminal_at_f[0, 0], 1.0)


# ─── Per-Cohort frontier independence ────────────────────────────────────


def test_per_cohort_frontier_uses_each_cohorts_own_f():
    """Two cohorts at frontiers 1 and 5 over the same Dirac@3 edge.

    Cohort 0 (f=1): no mass at Y yet, occupancy at X[0] = N_0 = 2.0.
    Cohort 1 (f=5): all mass at Y, occupancy at X[0] = 0.
    Group-level ``max(f_c)`` or ``min(f_c)`` substitution would corrupt
    one or both cohorts.
    """
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    assert topology is not None

    cohort_count = 2
    draw_count = 1
    T = 6
    S = cohort_count * draw_count
    root_seed = np.zeros((S, T), dtype=np.float64)
    root_seed[0, 0] = 2.0  # cohort 0 root mass
    root_seed[1, 0] = 3.0  # cohort 1 root mass

    def edge_kernel_provider(ce, source_index, cohort_idx, source_basis):
        # Cohort-invariant Dirac lag 3. Tuple-form return per the
        # provider contract; out_basis mirrors source for this fixture.
        return (
            _dirac_kernel(3, T - source_index, S=draw_count),
            source_basis,
        )

    from runner.timing_span import DPExecutionPolicy
    trace = _run_dp_density_trace_from_seed(
        topology, edge_kernel_provider, root_seed, S, T,
        cohort_count=cohort_count,
        execution_policy=DPExecutionPolicy.SCALAR,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[1, 5],
        cohort_count=cohort_count,
        draw_count=draw_count,
    )

    # Cohort 0 at f=1: mass still entirely at X bucket 0.
    np.testing.assert_allclose(
        ledger.occupancy_by_node_bucket['X'][0][0][0, 0], 2.0
    )
    np.testing.assert_allclose(ledger.terminal_at_f[0, 0], 0.0)
    # Cohort 1 at f=5: mass drained to Y.
    np.testing.assert_allclose(
        ledger.occupancy_by_node_bucket['X'][0][0][1, 0], 0.0, atol=1e-12
    )
    np.testing.assert_allclose(ledger.terminal_at_f[1, 0], 3.0)
    # Per-cohort conservation.
    np.testing.assert_allclose(
        ledger.root_total, np.array([[2.0], [3.0]])
    )


# ─── Multi-draw smoke ────────────────────────────────────────────────────


def test_multi_draw_per_cohort_keeps_draw_axis_separate():
    """Per-draw kernel with two different lags across the draw axis.

    Draw 0: Dirac@1, draw 1: Dirac@3, same Cohort, f=2. Draw 0 has
    fully departed; draw 1 hasn't. Per-draw occupancy must reflect this.
    """
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    assert topology is not None
    cohort_count = 1
    draw_count = 2
    S = cohort_count * draw_count
    T = 5

    def edge_kernel_provider(ce, source_index, cohort_idx, source_basis):
        kernel = np.zeros((draw_count, T - source_index), dtype=np.float64)
        # Lag depends on the draw index.
        for s in range(draw_count):
            lag = 1 + 2 * s  # draw 0 → lag 1, draw 1 → lag 3
            shift = lag
            if 0 <= shift < kernel.shape[1]:
                kernel[s, shift] = 1.0
        return kernel, source_basis

    root_seed = np.zeros((S, T), dtype=np.float64)
    root_seed[:, 0] = 1.0
    from runner.timing_span import DPExecutionPolicy
    trace = _run_dp_density_trace_from_seed(
        topology, edge_kernel_provider, root_seed, S, T,
        cohort_count=cohort_count,
        execution_policy=DPExecutionPolicy.SCALAR,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[2],
        cohort_count=cohort_count,
        draw_count=draw_count,
    )

    # Draw 0: arrived at Y by f=2, occupancy at X is 0.
    np.testing.assert_allclose(
        ledger.occupancy_by_node_bucket['X'][0][0][0, 0], 0.0, atol=1e-12
    )
    np.testing.assert_allclose(ledger.terminal_at_f[0, 0], 1.0)
    # Draw 1: still at X bucket 0.
    np.testing.assert_allclose(
        ledger.occupancy_by_node_bucket['X'][0][0][0, 1], 1.0
    )
    np.testing.assert_allclose(ledger.terminal_at_f[0, 1], 0.0)


# ─── Blind §9.3 spec tests ────────────────────────────────────────────────
#
# Tests below this line are written blind from the FC plan §5.2 / §9.3
# spec, not from the implementation. They were added during the Atom 4
# re-open after the engine-discipline review found a defect where the
# occupancy survivor was computed from a predictive model kernel instead
# of from the empirical trace's own per-edge per-source-bucket smear. The
# spec sentence each test pins is quoted in its docstring; the assertion
# is justified by that quote alone.


def test_occupancy_equals_arrivals_minus_empirical_departures_not_model_survivor():
    """FC plan §9.3: ``occupancy_f(node, source_bucket) = cumulative
    arrivals at node/source_bucket by f − cumulative departures from
    node/source_bucket by f``. Arrivals come from
    ``trace.node_density_by_node_bucket``; departures from
    ``trace.edge_contribution_by_edge_source`` summed over on-path
    outgoing edges. The spec is explicit: the survivor MUST come from
    the trace, never from a model kernel.

    Fixture: one cohort, one draw, X→Y with empirical transition
    probability p_emp = 0.2 Dirac@1. At frontier f = 5 (well after the
    transition fires) the trace records:

      - arrivals at X bucket 0 = 1.0 (root seed)
      - departures from X via X→Y by f = 5 = 0.2 (kernel mass at τ=1)

    Per the spec: occupancy at X[0] = 1.0 − 0.2 = 0.8.

    A regression that substitutes any model-prior-derived survivor
    (the historical defect, where a `base_kernel_provider` supplied a
    predictive kernel with a different `p_model`) would produce a
    different number — typically 1 − p_model (e.g. 0.2 when p_model =
    0.8). This test fails on any such substitution: the only way the
    occupancy can be 0.8 is if departures are read from the trace's
    own empirical-edge smear with the empirical probability 0.2.
    """
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    S, T = 1, 8
    p_emp = 0.2
    kernels = {('X', 'Y', 0): _bernoulli_dirac_kernel(p_emp, 1, T)}
    trace, topology = _trace_with_kernels(
        graph=graph,
        x_id='X',
        y_id='Y',
        kernels_by_edge=kernels,
        T=T,
        S=S,
    )

    ledger = build_frontier_occupancy(
        trace=trace,
        topology=topology,
        terminal_node_id='Y',
        frontier_by_cohort=[5],
        cohort_count=1,
        draw_count=1,
    )

    # The exact spec equation: 1.0 − (empirical departures from X
    # bucket 0 by τ ≤ 5) = 1.0 − 0.2 = 0.8.
    occ_at_x = ledger.occupancy_by_node_bucket['X'][0][0][0, 0]
    np.testing.assert_allclose(occ_at_x, 1.0 - p_emp, atol=1e-12)
    # And conservation: 0.8 unresolved + 0.2 terminal = 1.0 root.
    terminal = ledger.terminal_at_f[0, 0]
    np.testing.assert_allclose(terminal, p_emp, atol=1e-12)
    np.testing.assert_allclose(
        occ_at_x + terminal, ledger.root_total[0, 0], atol=1e-12,
    )


def test_multi_hop_state_distinguishes_mass_at_x_vs_mass_at_intermediate():
    """FC plan §5.2: ``L_subject_f`` may contain mass at X or at
    intermediate subject nodes. "This is why a scalar remainder such
    as ``X_obs(f) - Y_obs(f)`` is not enough for multi-hop subjects."

    Fixture: two single-cohort multi-hop runs X→M→Y over the SAME
    topology, with the same root mass = 1.0 and the same scalar
    "unresolved subject mass" at the frontier (X_obs(f) − Y_obs(f) =
    1.0 in both cases). They differ only in WHERE that unresolved mass
    sits.

      Case A: X→M lag 1, M→Y lag 99. At f=5 mass has already crossed
              into M and is sitting at M.
      Case B: X→M lag 99, M→Y lag 1.  At f=5 mass is still sitting at X
              (M→Y will fire on arrival but nothing has reached M yet).

    Per §5.2 the occupancy ledgers must distinguish these cases — case
    A places 1.0 at M bucket 1, case B places 1.0 at X bucket 0. A
    scalar-only reducer that collapsed the ledger to ``X_obs(f) −
    Y_obs(f)`` would treat both cases identically. The continuation
    DP later applies M→Y to case A's M-occupancy and X→M then M→Y to
    case B's X-occupancy, producing different future-Y; that
    downstream consequence is tested at the spine integration level.
    Here we pin the necessary precondition: the ledger itself records
    distinct (node, bucket) locations for the two cases.
    """
    graph = _make_graph(['X', 'M', 'Y'], [('X', 'M'), ('M', 'Y')])
    T = 8

    def _build(lag_xm: int, lag_my: int):
        kernels = {
            ('X', 'M', 0): _dirac_kernel(lag_xm, T),
            ('M', 'Y', 0): _dirac_kernel(lag_my, T),
        }
        trace, topology = _trace_with_kernels(
            graph=graph, x_id='X', y_id='Y',
            kernels_by_edge=kernels, T=T, S=1,
        )
        return build_frontier_occupancy(
            trace=trace, topology=topology, terminal_node_id='Y',
            frontier_by_cohort=[5], cohort_count=1, draw_count=1,
        )

    # Case A: X→M completes by f, mass sits at M.
    ledger_a = _build(lag_xm=1, lag_my=99)
    # Case B: X→M does not fire by f, mass sits at X.
    ledger_b = _build(lag_xm=99, lag_my=1)

    # Both cases conserve: 1.0 at root, 0.0 at terminal by f=5.
    np.testing.assert_allclose(ledger_a.terminal_at_f[0, 0], 0.0, atol=1e-12)
    np.testing.assert_allclose(ledger_b.terminal_at_f[0, 0], 0.0, atol=1e-12)
    np.testing.assert_allclose(ledger_a.root_total[0, 0], 1.0)
    np.testing.assert_allclose(ledger_b.root_total[0, 0], 1.0)

    # Case A: mass at M, none left at X.
    np.testing.assert_allclose(
        ledger_a.occupancy_by_node_bucket['X'][0][0][0, 0], 0.0, atol=1e-12,
    )
    np.testing.assert_allclose(
        ledger_a.occupancy_by_node_bucket['M'][1][1][0, 0], 1.0, atol=1e-12,
    )

    # Case B: mass still at X, nothing at M yet.
    np.testing.assert_allclose(
        ledger_b.occupancy_by_node_bucket['X'][0][0][0, 0], 1.0, atol=1e-12,
    )
    # M is on-path and pre-allocated; absent arrivals materialise as
    # an empty inner mapping (no buckets), which is the spec-faithful
    # "no occupancy at M" expression.
    assert 'M' in ledger_b.occupancy_by_node_bucket
    assert ledger_b.occupancy_by_node_bucket['M'] == {}

    # Cross-case asymmetry — the load-bearing assertion. Whichever node
    # carries the mass is different, even though the scalar "unresolved
    # subject mass at frontier" is identical.
    assert (
        ledger_a.occupancy_by_node_bucket['M'][1][1][0, 0]
        != ledger_b.occupancy_by_node_bucket['X'][0][0][0, 0] * 0.0  # i.e. 1.0 vs 0.0
    )
