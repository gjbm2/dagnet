"""Tests for the FC continuation DP (§5.4 / §9.6).

Atom 4 of the frontier-conditioned chart-surface proposal. Pins:

- empty ledger degenerates to no future mass (identity case);
- single-hop residual continuation: post-frontier fan opens, terminal
  arrivals saturate at the surviving fraction;
- multi-hop chain: residual at hop 1 from frontier bucket flows
  through hop 2 via ordinary predictive kernel;
- future-X handoff: carrier continuation's terminal arrivals fed into
  ordinary predictive subject kernels seed the subject DP at their
  future arrival bucket (§5.4 — Pop-C member's subject clock starts
  when it reaches X, NOT residual subject kernels conditioned on the
  original frontier);
- per-cohort frontier independence.
"""

from __future__ import annotations

import os
import sys
from typing import Dict, Tuple

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.bucket_transition import BucketSourceBasis
from runner.frontier_continuation_dp import (
    ContinuationDPResult,
    run_dp_from_node_source_ledgers,
)
from runner.frontier_residual_kernel import (
    make_frontier_residual_kernel_provider,
)
from runner.span_kernel import ConcreteEdge, _build_span_topology
from runner.timing_span import DPExecutionPolicy


# ─── Fixture helpers ─────────────────────────────────────────────────────


def _make_graph(nodes, edges):
    return {
        'nodes': [{'id': n, 'uuid': n} for n in nodes],
        'edges': [
            {'from_node': f, 'to': t, 'uuid': f'{f}_{t}_{idx}'}
            for idx, (f, t) in enumerate(edges)
        ],
    }


def _base_provider_from_kernels(
    kernels: Dict[Tuple[str, str, int], np.ndarray],
    *,
    draw_count: int,
    horizon: int,
):
    """Return a kernel-provider exposing ``batched_op`` so the test can
    declare ``DPExecutionPolicy.TOEPLITZ_APPLY`` — the production
    strategy ``model_span_spine._project_frontier_shadow_surfaces``
    uses. The provider also exposes the FC scalar contract
    ``(ce, source_index, source_basis) -> (kernel, out_basis)`` for
    legacy direct calls (the canonical core's SCALAR path is not used
    here; production goes through TOEPLITZ_APPLY).

    ``kernels`` values are ``(draw_count, T)`` arrays interpreted as
    offset-from-source (the DP's convention): index ``k`` is the kernel
    value at destination column ``source_index + k``.
    """
    T = horizon + 1

    def provider(ce, source_index, source_basis):
        sibling_idx = int(ce.edge_key.rsplit('#', 1)[-1])
        full = kernels.get((ce.from_id, ce.to_id, sibling_idx))
        s = int(source_index)
        out_len = T - s
        if full is None:
            return np.zeros((draw_count, out_len)), source_basis
        if full.shape != (draw_count, T):
            raise AssertionError(
                f"test fixture kernel shape {full.shape} != ({draw_count}, {T})"
            )
        return full[:, :out_len].copy(), source_basis

    def batched_op(ce, source_basis, source_mass_3d):
        """Toeplitz operator-apply matching the production
        ``batched_op`` contract: ``(C, D, T) source mass -> (C, D, T)
        output``. Used by the canonical TOEPLITZ_APPLY applier; the
        FC test provider always returns a finite per-edge kernel so
        the Toeplitz contraction is well-defined for every edge in
        the fixture.
        """
        sibling_idx = int(ce.edge_key.rsplit('#', 1)[-1])
        full = kernels.get((ce.from_id, ce.to_id, sibling_idx))
        if full is None:
            return np.zeros_like(source_mass_3d), source_basis
        K_padded = np.zeros((draw_count, T), dtype=np.float64)
        cut = min(full.shape[1], T)
        K_padded[:, :cut] = full[:, :cut]
        v_idx = np.arange(T)
        u_idx = np.arange(T)
        offset = v_idx[:, None] - u_idx[None, :]
        valid = offset >= 0
        T_mat = np.where(
            valid[None, :, :],
            K_padded[:, np.clip(offset, 0, T - 1)],
            0.0,
        )
        out = np.einsum(
            'cdu,dvu->cdv', source_mass_3d, T_mat, optimize=True,
        )
        return out, source_basis

    provider.batched_op = batched_op
    return provider


def _dirac_p(p: float, lag: int, draw_count: int, T: int) -> np.ndarray:
    kernel = np.zeros((draw_count, T), dtype=np.float64)
    if 0 <= lag < T:
        kernel[:, lag] = float(p)
    return kernel


def _seed_with_basis(
    flat_ledger: Dict[str, Dict[int, np.ndarray]],
    *,
    basis: BucketSourceBasis = BucketSourceBasis.POINT_AT_ENDPOINT,
) -> Dict[str, Dict[int, Dict[int, np.ndarray]]]:
    """Wrap a flat ``{node: {bucket: mass}}`` ledger in the
    ``[node][bucket][basis_int] -> ndarray`` shape the DP consumes.
    """
    basis_int = int(basis)
    return {
        node: {
            int(bucket): {
                basis_int: np.asarray(arr, dtype=np.float64).copy(),
            }
            for bucket, arr in bucket_map.items()
        }
        for node, bucket_map in flat_ledger.items()
    }


# ─── Empty ledger (identity case) ────────────────────────────────────────


def test_empty_ledger_produces_no_arrivals():
    """Identity-carrier degeneracy: no frontier occupancy means no
    continuation, so the result has no contributions anywhere."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(1.0, 1, 1, 4)},
        draw_count=1, horizon=3,
    )

    seed_mass = _seed_with_basis({})
    result = run_dp_from_node_source_ledgers(
        topology=topology,
        initial_ledger_mass=seed_mass,
        kernel_provider=base,
        cohort_count=1, draw_count=1, horizon=3,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    # Every on-path node ledger is empty.
    assert all(
        not v for v in result.node_density_by_node_bucket.values()
    )


# ─── Single-hop residual continuation ─────────────────────────────────────


def test_single_hop_residual_continuation_seeds_at_frontier_bucket():
    """Run a single-hop X→Y residual continuation from L_carrier_f at
    X bucket 0. The result should land mass at Y in the post-frontier
    columns, matching the residual cumulative B."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 6
    T = horizon + 1
    # p=0.5 Dirac@4. Frontier f=2 — survivor = 1.0, residual saturates
    # at 0.5.
    base_kernel = _dirac_p(0.5, 4, 1, T)
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): base_kernel},
        draw_count=1, horizon=horizon,
    )

    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2],
        cohort_count=1, draw_count=1, horizon=T,
    )

    # Ledger: 10 units of unresolved mass at X bucket 0 (everything,
    # since by f=2 the lag-4 Dirac hasn't fired).
    seed_mass = _seed_with_basis({'X': {0: np.array([10.0])}})

    result = run_dp_from_node_source_ledgers(
        topology=topology,
        initial_ledger_mass=seed_mass,
        kernel_provider=residual,
        cohort_count=1, draw_count=1, horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    # Y receives 10 * 0.5 = 5.0 mass at column 4 (the Dirac lag).
    y_density = result.node_density('Y')
    np.testing.assert_allclose(y_density[0, 4], 5.0, atol=1e-12)
    np.testing.assert_allclose(y_density[0, :3], 0.0, atol=1e-12)
    # No mass before lag (residual is zero at and before frontier).
    assert (y_density[0, :3] == 0.0).all()


# ─── Multi-hop continuation ──────────────────────────────────────────────


def test_multi_hop_residual_at_intermediate_bucket_flows_to_terminal():
    """Ledger has mass at M bucket 2 (intermediate node, post-frontier
    arrival point for a hypothetical X→M crossing at lag 2). Apply
    residual kernel at M→Y and expect mass to land at Y at column 2+lag.

    This exercises §9.6's "DP from frontier ledgers" with mass injected
    at an intermediate node.
    """
    graph = _make_graph(['X', 'M', 'Y'], [('X', 'M'), ('M', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 8
    T = horizon + 1
    base = _base_provider_from_kernels(
        {
            ('X', 'M', 0): _dirac_p(1.0, 2, 1, T),
            ('M', 'Y', 0): _dirac_p(0.5, 3, 1, T),
        },
        draw_count=1, horizon=horizon,
    )

    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2],
        cohort_count=1, draw_count=1, horizon=T,
    )

    # Ledger: 4 units of mass at M bucket 2 (the result of an X→M
    # crossing at exactly the frontier).
    seed_mass = _seed_with_basis({'M': {2: np.array([4.0])}})

    result = run_dp_from_node_source_ledgers(
        topology=topology,
        initial_ledger_mass=seed_mass,
        kernel_provider=residual,
        cohort_count=1, draw_count=1, horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    # M→Y kernel at source_index=2 with f=2: residual offset = f - u
    # = 0; mass at offsets > 0 is the post-frontier B. With p=0.5
    # Dirac@3, by f=2 H_M(2, 2) = 0 (mass arrives at M at bucket 2
    # exactly so hasn't departed yet). Survivor = 1. Residual at
    # offset 3 (col 5) is the Dirac mass 0.5.
    y_density = result.node_density('Y')
    np.testing.assert_allclose(y_density[0, 5], 4.0 * 0.5, atol=1e-12)


# ─── Future-X handoff: ordinary subject kernels, not residual ───────────


def test_future_x_handoff_uses_ordinary_subject_kernel_from_arrival_bucket():
    """§5.4 / §9.6 step 3-4: future X arrivals from carrier continuation
    feed ordinary (non-residual) predictive subject operators, seeded at
    their future arrival bucket. They are NOT frontier survivors on the
    subject side.

    Here we simulate by directly running ordinary subject kernels
    against a synthetic "future-X arrival" ledger.
    """
    # Subject topology: X→Y (one edge).
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 8
    T = horizon + 1
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(0.7, 3, 1, T)},
        draw_count=1, horizon=horizon,
    )

    # Future-X arrivals: 2.0 units of mass arrives at X at bucket 4
    # (post the original carrier frontier). The subject DP runs
    # ORDINARY predictive subject kernels from that future bucket —
    # the residual machinery is NOT involved on this side because the
    # mass was not at X at the original frontier.
    seed_mass = _seed_with_basis({'X': {4: np.array([2.0])}})

    result = run_dp_from_node_source_ledgers(
        topology=topology,
        initial_ledger_mass=seed_mass,
        kernel_provider=base,  # NOT wrapped — ordinary base provider.
        cohort_count=1, draw_count=1, horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    # Subject kernel fires Dirac@3 from source bucket 4 → mass arrives
    # at Y at column 4 + 3 = 7 with amplitude 2.0 * 0.7 = 1.4.
    y_density = result.node_density('Y')
    np.testing.assert_allclose(y_density[0, 7], 1.4, atol=1e-12)
    np.testing.assert_allclose(y_density[0, :7], 0.0, atol=1e-12)


# ─── Per-cohort frontier independence under residual provider ───────────


def test_per_cohort_residual_runs_with_independent_frontiers():
    """Two cohorts with different frontiers run through one residual
    kernel provider. Each cohort's continuation reflects its own f_c."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 6
    T = horizon + 1
    # p=1.0 Dirac@4 — by f=2 nothing fired; by f=5 all fired.
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(1.0, 4, 1, T)},
        draw_count=1, horizon=horizon,
    )

    cohort_count = 2
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2, 5],
        cohort_count=cohort_count, draw_count=1, horizon=T,
    )

    # Ledger: cohort 0 has 3.0 mass at X bucket 0 (occupied by f=2);
    # cohort 1 has 0.0 mass (everything fired by f=5).
    seed_mass = _seed_with_basis({'X': {0: np.array([3.0, 0.0])}})

    result = run_dp_from_node_source_ledgers(
        topology=topology,
        initial_ledger_mass=seed_mass,
        kernel_provider=residual,
        cohort_count=cohort_count, draw_count=1, horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    y_density = result.node_density('Y')
    # Cohort 0 (S row 0): mass 3.0 * residual(p=1) → 3.0 at column 4.
    np.testing.assert_allclose(y_density[0, 4], 3.0, atol=1e-12)
    # Cohort 1 (S row 1): zero source mass — but the residual kernel
    # for that cohort emits NaN at offsets where survivor = 0
    # (visible degradation per §5.3, since H_X(0, f=5) = 1 for the
    # fully-departed Dirac). The natural product 0 * NaN = NaN is the
    # algebraic signal. The FC continuation pass should drive the DP
    # only with non-zero ledger entries; here we permit either a clean
    # zero or a NaN signal, but not a finite non-zero value.
    cohort_1 = y_density[1, :]
    assert (np.nan_to_num(cohort_1, nan=0.0) == 0.0).all(), (
        f"cohort 1 row should be zero/NaN; got {cohort_1}"
    )


