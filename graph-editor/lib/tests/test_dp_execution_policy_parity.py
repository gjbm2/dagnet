"""Atom 4c.B parity matrix for the DPExecutionPolicy appliers.

Each test runs the same input through the SCALAR / TOEPLITZ_APPLY /
SOURCE_BANDED appliers and asserts numerical identity of the
destination contribution. This is the acceptance bar per FC plan
§1042-1044: accelerators are proven against the SCALAR floor by
EXECUTION on the same inputs, not by algebraic reasoning. Atom 4a's
Refactor-equivalence rule (§974-979) is binding: self-comparison
(new-vs-new) is worthless; the matrix proves each accelerator
matches the per-bucket scalar fallback on real fixtures.

Per the no-fallback rule (semantics §12; CF_ENGINE_DISCIPLINE I-47),
each applier requires the provider to expose its capability
(``.batched_op`` for TOEPLITZ_APPLY, ``.source_banded_op`` for
SOURCE_BANDED). Missing capability raises ``AttributeError`` at
applier construction.

This module covers the applier level (F1, F4, F6). DP-level
integration tests (F2, F3, F7) land alongside the
``_run_dp_density_trace_from_ledger`` policy-threading refactor.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.bucket_transition import BucketSourceBasis
from runner.span_kernel import ConcreteEdge
from runner.span_kernel import _build_span_topology
from runner.timing_span import (
    DPExecutionPolicy,
    SEED_ORIGIN_KEY,
    _make_operator_applier,
    _run_dp_density_trace_from_ledger,
)


# ─── Fixture helpers ────────────────────────────────────────────────────────


def _make_edge(
    from_id: str,
    to_id: str,
    edge_key: str,
    *,
    latency_parameter: bool = True,
) -> ConcreteEdge:
    """Synthetic ``ConcreteEdge`` with the minimal ``p.latency`` block the
    appliers' ``_edge_default_out_basis`` reads. ``latency_parameter=False``
    flips the edge's default out_basis to ``POINT_AT_ENDPOINT``; absent
    or ``True`` keeps the LATENT default (``BUCKET_DISTRIBUTED``) per the
    documented schema convention.
    """
    latency = {'mu': 0.0, 'sigma': 0.001, 'onset_delta_days': 0.0}
    if latency_parameter is False:
        latency['latency_parameter'] = False
    elif latency_parameter is True:
        latency['latency_parameter'] = True
    return ConcreteEdge(
        edge_key=edge_key,
        from_id=from_id,
        to_id=to_id,
        edge_data={'p': {'latency': latency}},
    )


def _shift_invariant_provider(K: np.ndarray, *, T: int):
    """Provider exposing all four policy capabilities for a cohort-
    invariant shift-invariant kernel ``K`` of shape ``(draw_count, T)``.

    ``K[d, k]`` is the kernel value at relative destination offset ``k``
    from the source bucket (the DP's convention). The same ``K`` is
    returned for every cohort — the cohort axis is introduced by
    broadcasting against the source mass tensor.

    Shift-invariance is a degenerate special case of source-banded
    (where ``K[c, d, u, k]`` is the same for every ``u``), so both
    TOEPLITZ_APPLY and SOURCE_BANDED can be exercised on the same
    fixture; the parity matrix requires their outputs to agree.
    """

    def scalar(ce, source_index, cohort_index, source_basis):
        u = int(source_index)
        return K[:, : T - u].copy(), source_basis

    def batched_op(ce, source_basis, source_mass_3d):
        # Toeplitz contraction: out[c, d, v] = Σ_u M[c, d, u] · K[d, v − u].
        K_padded = np.zeros((K.shape[0], T), dtype=np.float64)
        cut = min(K.shape[1], T)
        K_padded[:, :cut] = K[:, :cut]
        v_idx = np.arange(T)
        u_idx = np.arange(T)
        offset = v_idx[:, None] - u_idx[None, :]
        valid = offset >= 0
        T_mat = np.where(
            valid[None, :, :],
            K_padded[:, np.clip(offset, 0, T - 1)],
            0.0,
        )
        out = np.einsum('cdu,dvu->cdv', source_mass_3d, T_mat, optimize=True)
        return out, source_basis

    def source_banded_op(ce, source_basis, source_mass_3d):
        # Source-indexed banded contraction:
        #   out[c, d, v] = Σ_u M[c, d, u] · K[d, v − u]
        # Equivalent algebra to Toeplitz on this fixture (shift-invariant K
        # is the degenerate where K[u, d, k] is u-independent) but goes
        # through the source-indexed path and produces per-source smears.
        C, D, _ = source_mass_3d.shape
        out = np.zeros_like(source_mass_3d)
        smear_map = {}
        active = np.flatnonzero(
            np.any(source_mass_3d != 0.0, axis=(0, 1))
        )
        for u_np in active:
            u = int(u_np)
            remaining = T - u
            kernel_remaining = K[:, :remaining]
            smear_u_3d = np.zeros((C, D, T), dtype=np.float64)
            smear_u_3d[:, :, u:] = (
                source_mass_3d[:, :, u, None] * kernel_remaining[None, :, :]
            )
            out += smear_u_3d
            smear_map[u] = smear_u_3d.reshape(C * D, T)
        return out, source_basis, smear_map

    scalar.batched_op = batched_op
    scalar.source_banded_op = source_banded_op
    return scalar


def _cohort_dependent_provider(K_per_cohort: np.ndarray, *, T: int):
    """Provider for a per-cohort kernel ``K_per_cohort`` of shape
    ``(cohort_count, draw_count, T)``. Used to exercise the residual-
    style cohort-dependent path: each cohort applies its own kernel.

    All four capabilities return the same algebra; the test asserts
    numerical identity between policies.
    """
    cohort_count = int(K_per_cohort.shape[0])

    def scalar(ce, source_index, cohort_index, source_basis):
        u = int(source_index)
        return K_per_cohort[int(cohort_index), :, : T - u].copy(), source_basis

    def batched_op(ce, source_basis, source_mass_3d):
        # Per-cohort Toeplitz contraction.
        out = np.zeros_like(source_mass_3d)
        for c in range(cohort_count):
            K = K_per_cohort[c]
            K_padded = np.zeros((K.shape[0], T), dtype=np.float64)
            cut = min(K.shape[1], T)
            K_padded[:, :cut] = K[:, :cut]
            v_idx = np.arange(T)
            u_idx = np.arange(T)
            offset = v_idx[:, None] - u_idx[None, :]
            valid = offset >= 0
            T_mat = np.where(
                valid[None, :, :],
                K_padded[:, np.clip(offset, 0, T - 1)],
                0.0,
            )
            out[c] = np.einsum(
                'du,dvu->dv', source_mass_3d[c], T_mat, optimize=True,
            )
        return out, source_basis

    def source_banded_op(ce, source_basis, source_mass_3d):
        # Source-indexed banded contraction for the cohort-dependent
        # (still shift-invariant per cohort) kernel — degenerates to
        # per-cohort Toeplitz but goes through the source-indexed path
        # and produces per-source smears.
        C, D, _ = source_mass_3d.shape
        out = np.zeros_like(source_mass_3d)
        smear_map = {}
        active = np.flatnonzero(
            np.any(source_mass_3d != 0.0, axis=(0, 1))
        )
        for u_np in active:
            u = int(u_np)
            remaining = T - u
            kernel_remaining = K_per_cohort[:, :, :remaining]
            smear_u_3d = np.zeros((C, D, T), dtype=np.float64)
            smear_u_3d[:, :, u:] = (
                source_mass_3d[:, :, u, None] * kernel_remaining
            )
            out += smear_u_3d
            smear_map[u] = smear_u_3d.reshape(C * D, T)
        return out, source_basis, smear_map

    scalar.batched_op = batched_op
    scalar.source_banded_op = source_banded_op
    return scalar


def _run_each_policy(provider, ce, source_basis, source_mass_3d, *,
                     cohort_count: int, S_per_cohort: int, T: int):
    """Run all three policies on the same inputs and collect their
    returns. Each applier sees a fresh copy of ``source_mass_3d`` so
    in-place mutation cannot leak across policies.
    """
    results = {}
    for policy in DPExecutionPolicy:
        applier = _make_operator_applier(
            policy, provider,
            cohort_count=cohort_count,
            S_per_cohort=S_per_cohort,
            T=T,
        )
        results[policy] = applier(
            ce, source_basis, source_mass_3d.copy(),
        )
    return results


# ─── F1: shift-invariant Dirac, single hop ──────────────────────────────────


def test_F1_shift_invariant_dirac_three_policies_identical():
    """F1: cohort-invariant Dirac kernel ``K[:, lag] = p``. Mass seeded
    at multiple source buckets across cohorts. SCALAR, TOEPLITZ_APPLY,
    and SOURCE_BANDED appliers must produce numerically identical
    destination contribution; SCALAR and SOURCE_BANDED must produce
    identical per-source-bucket smears; TOEPLITZ_APPLY's smear map is
    empty by design (the per-bucket smear is not extracted under
    operator-apply).
    """
    cohort_count = 2
    S_per_cohort = 4
    T = 10
    lag = 3
    p = 0.6
    K = np.zeros((S_per_cohort, T), dtype=np.float64)
    K[:, lag] = p

    ce = _make_edge('a', 'b', 'a->b#0')
    provider = _shift_invariant_provider(K, T=T)

    source_mass_3d = np.zeros(
        (cohort_count, S_per_cohort, T), dtype=np.float64,
    )
    source_mass_3d[0, :, 0] = 1.0
    source_mass_3d[0, :, 2] = 0.5
    source_mass_3d[1, :, 5] = 0.7

    results = _run_each_policy(
        provider, ce, BucketSourceBasis.BUCKET_DISTRIBUTED,
        source_mass_3d,
        cohort_count=cohort_count,
        S_per_cohort=S_per_cohort,
        T=T,
    )

    out_scalar, basis_scalar, smear_scalar = results[DPExecutionPolicy.SCALAR]
    out_toeplitz, basis_toeplitz, smear_toeplitz = results[DPExecutionPolicy.TOEPLITZ_APPLY]
    out_banded, basis_banded, smear_banded = results[DPExecutionPolicy.SOURCE_BANDED]

    np.testing.assert_allclose(out_scalar, out_toeplitz, atol=1e-12)
    np.testing.assert_allclose(out_scalar, out_banded, atol=1e-12)

    assert basis_scalar == basis_toeplitz == basis_banded == BucketSourceBasis.BUCKET_DISTRIBUTED

    assert set(smear_scalar.keys()) == {0, 2, 5}
    # SOURCE_BANDED preserves per-source smears (plan §1107); they must
    # match SCALAR bucket-by-bucket.
    assert set(smear_banded.keys()) == {0, 2, 5}
    for u in smear_scalar:
        np.testing.assert_allclose(
            smear_scalar[u], smear_banded[u], atol=1e-12,
            err_msg=f'SCALAR vs SOURCE_BANDED smear disagreement at source bucket {u}',
        )

    assert smear_toeplitz == {}


# ─── F4: cohort-dependent kernel ────────────────────────────────────────────


def test_F4_cohort_dependent_kernel_three_policies_identical():
    """F4: per-cohort kernel where each cohort applies a different
    shift-invariant Dirac (a different lag). This proves the canonical
    algebra holds even when the kernel inflects per cohort — the case
    that motivates the residual-kernel provider (whose kernel depends
    on each cohort's frontier ``f_c``).

    SCALAR iterates per (bucket, cohort) and calls the per-cohort
    kernel slice. TOEPLITZ_APPLY does per-cohort Toeplitz contraction.
    SOURCE_BANDED does the source-indexed banded contraction. All
    three must agree on out_3d.
    """
    cohort_count = 3
    S_per_cohort = 2
    T = 8
    lags = [1, 2, 3]
    p = 0.5
    K_per_cohort = np.zeros(
        (cohort_count, S_per_cohort, T), dtype=np.float64,
    )
    for c, lag in enumerate(lags):
        K_per_cohort[c, :, lag] = p

    ce = _make_edge('a', 'b', 'a->b#0')
    provider = _cohort_dependent_provider(K_per_cohort, T=T)

    source_mass_3d = np.zeros(
        (cohort_count, S_per_cohort, T), dtype=np.float64,
    )
    source_mass_3d[0, :, 0] = 1.0
    source_mass_3d[1, :, 1] = 0.8
    source_mass_3d[2, :, 2] = 0.6

    results = _run_each_policy(
        provider, ce, BucketSourceBasis.BUCKET_DISTRIBUTED,
        source_mass_3d,
        cohort_count=cohort_count,
        S_per_cohort=S_per_cohort,
        T=T,
    )

    out_scalar, _, _ = results[DPExecutionPolicy.SCALAR]
    out_toeplitz, _, _ = results[DPExecutionPolicy.TOEPLITZ_APPLY]
    out_banded, _, _ = results[DPExecutionPolicy.SOURCE_BANDED]

    np.testing.assert_allclose(out_scalar, out_toeplitz, atol=1e-12)
    np.testing.assert_allclose(out_scalar, out_banded, atol=1e-12)


# ─── F6: per-basis dispatch (basis-aware applier identity) ──────────────────


def test_F6_provider_echoed_basis_matches_under_each_policy():
    """F6: the applier receives one ``source_basis`` per call (the DP
    body groups source-node provenance by basis before dispatch).
    This test runs the same fixture under each
    ``BucketSourceBasis`` value and asserts that all three policies
    produce identical (out_3d, out_basis) for each — the provider
    echoes ``source_basis`` as ``out_basis``, so per-basis dispatch
    must propagate the basis cleanly through every policy.
    """
    cohort_count = 1
    S_per_cohort = 2
    T = 6
    K = np.zeros((S_per_cohort, T), dtype=np.float64)
    K[:, 1] = 1.0

    ce = _make_edge('a', 'b', 'a->b#0', latency_parameter=False)
    provider = _shift_invariant_provider(K, T=T)

    source_mass_3d = np.zeros(
        (cohort_count, S_per_cohort, T), dtype=np.float64,
    )
    source_mass_3d[0, :, 0] = 1.0

    for source_basis in (
        BucketSourceBasis.POINT_AT_ENDPOINT,
        BucketSourceBasis.BUCKET_DISTRIBUTED,
    ):
        results = _run_each_policy(
            provider, ce, source_basis, source_mass_3d,
            cohort_count=cohort_count,
            S_per_cohort=S_per_cohort,
            T=T,
        )
        out_scalar, basis_scalar, _ = results[DPExecutionPolicy.SCALAR]
        out_toeplitz, basis_toeplitz, _ = results[DPExecutionPolicy.TOEPLITZ_APPLY]
        out_banded, basis_banded, _ = results[DPExecutionPolicy.SOURCE_BANDED]

        np.testing.assert_allclose(
            out_scalar, out_toeplitz, atol=1e-12,
            err_msg=f'SCALAR/TOEPLITZ disagreement at source_basis={source_basis}',
        )
        np.testing.assert_allclose(
            out_scalar, out_banded, atol=1e-12,
            err_msg=f'SCALAR/SOURCE_BANDED disagreement at source_basis={source_basis}',
        )
        assert basis_scalar == basis_toeplitz == basis_banded == source_basis


# ─── No-fallback acceptance ─────────────────────────────────────────────────


def test_toeplitz_apply_missing_batched_op_attribute_raises():
    """Acceptance: no silent fallback. A provider without
    ``.batched_op`` cannot satisfy ``TOEPLITZ_APPLY``; applier
    construction raises ``AttributeError`` immediately.
    """

    def scalar_only(ce, source_index, cohort_index, source_basis):
        return np.zeros((1, 4)), source_basis

    with pytest.raises(AttributeError):
        _make_operator_applier(
            DPExecutionPolicy.TOEPLITZ_APPLY,
            scalar_only,
            cohort_count=1, S_per_cohort=1, T=4,
        )


def test_source_banded_missing_source_banded_op_attribute_raises():
    """Acceptance: no silent fallback. A provider without
    ``.source_banded_op`` cannot satisfy ``SOURCE_BANDED``; applier
    construction raises ``AttributeError`` immediately. There is no
    demotion to a different policy (semantics §12 — failures degrade
    visibly; plan §1195).
    """

    def scalar_only(ce, source_index, cohort_index, source_basis):
        return np.zeros((1, 4)), source_basis

    with pytest.raises(AttributeError):
        _make_operator_applier(
            DPExecutionPolicy.SOURCE_BANDED,
            scalar_only,
            cohort_count=1, S_per_cohort=1, T=4,
        )


# ─── DP-level fixture helpers ───────────────────────────────────────────────


def _make_graph(nodes, edges):
    """Minimal graph dict with parameterised edges (carries the p.latency
    block ``_edge_default_out_basis`` reads).
    """
    return {
        'nodes': [{'id': n, 'uuid': n} for n in nodes],
        'edges': [
            {
                'from_node': f,
                'to': t,
                'uuid': f'{f}_{t}_{idx}',
                'p': {
                    'value': 1.0,
                    'forecast': {'mean': 1.0},
                    'posterior': {'alpha': 20.0, 'beta': 0.0},
                    'latency': {
                        'mu': 0.0, 'sigma': 0.001, 'onset_delta_days': 0.0,
                        'latency_parameter': True,
                    },
                },
            }
            for idx, (f, t) in enumerate(edges)
        ],
    }


def _build_ledger_at(node: str, bucket: int, mass: np.ndarray,
                     basis: BucketSourceBasis):
    """Wrap a single per-node seed in the canonical core's
    ``[node][bucket][prov_key] -> mass`` / ``[basis_int]`` shape.
    """
    basis_int = int(basis)
    mass_map = {node: {int(bucket): {SEED_ORIGIN_KEY: mass.copy()}}}
    basis_map = {node: {int(bucket): {SEED_ORIGIN_KEY: basis_int}}}
    return mass_map, basis_map


def _run_dp_each_policy(topo, provider, *, ledger_mass, ledger_basis,
                        cohort_count, S_per_cohort, T):
    """Run the canonical DP with each ``DPExecutionPolicy`` and return
    the resulting ``SpanDPTrace`` per policy. Each run sees fresh
    ledger copies so in-place mutation cannot leak across policies.
    """
    results = {}
    S = cohort_count * S_per_cohort
    for policy in DPExecutionPolicy:
        # Deep-copy the ledger maps so the DP's in-place seed copies
        # cannot affect later runs.
        mass_copy = {
            n: {
                int(b): {k: v.copy() for k, v in prov.items()}
                for b, prov in cols.items()
            }
            for n, cols in ledger_mass.items()
        }
        basis_copy = {
            n: {int(b): dict(prov) for b, prov in cols.items()}
            for n, cols in ledger_basis.items()
        }
        results[policy] = _run_dp_density_trace_from_ledger(
            topo,
            provider,
            initial_node_provenance_mass=mass_copy,
            initial_node_provenance_basis=basis_copy,
            S=S,
            T=T,
            execution_policy=policy,
            cohort_count=cohort_count,
        )
    return results


# ─── F2: shift-invariant multi-hop chain ────────────────────────────────────


def test_F2_shift_invariant_lognormal_multi_hop_three_policies_identical():
    """F2: multi-hop chain ``a → b → c → d`` with cohort-invariant
    shift-invariant kernels per edge. Run the canonical DP through
    SCALAR, TOEPLITZ_APPLY, and SOURCE_BANDED and assert numerically
    identical ``node_density`` at every on-path node.

    Each edge has a different Dirac lag, so the destination density at
    ``d`` is the convolution of three Diracs — the DP's per-edge
    contribution surfaces are the test surface for shift-invariance
    propagation.
    """
    cohort_count = 2
    S_per_cohort = 3
    T = 12
    graph = _make_graph(
        ['a', 'b', 'c', 'd'],
        [('a', 'b'), ('b', 'c'), ('c', 'd')],
    )
    topo = _build_span_topology(graph, 'a', 'd')
    assert topo is not None

    # Different per-edge Diracs (different lags) so each hop's
    # contribution is distinguishable in the destination ledger.
    lags_by_edge = {
        'a->b#0': 1,
        'b->c#0': 2,
        'c->d#0': 3,
    }
    p = 0.7

    def make_provider():
        # All edges share the same DRAW shape (S_per_cohort, T) so the
        # provider can be one closure; lag varies by edge_key.
        def scalar(ce, source_index, cohort_index, source_basis):
            K = np.zeros((S_per_cohort, T), dtype=np.float64)
            K[:, lags_by_edge[ce.edge_key]] = p
            u = int(source_index)
            return K[:, : T - u].copy(), source_basis

        def batched_op(ce, source_basis, source_mass_3d):
            K = np.zeros((S_per_cohort, T), dtype=np.float64)
            K[:, lags_by_edge[ce.edge_key]] = p
            K_padded = np.zeros((S_per_cohort, T), dtype=np.float64)
            K_padded[:, : K.shape[1]] = K
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

        def source_banded_op(ce, source_basis, source_mass_3d):
            K = np.zeros((S_per_cohort, T), dtype=np.float64)
            K[:, lags_by_edge[ce.edge_key]] = p
            C, D, _ = source_mass_3d.shape
            out = np.zeros_like(source_mass_3d)
            smear_map = {}
            active = np.flatnonzero(
                np.any(source_mass_3d != 0.0, axis=(0, 1))
            )
            for u_np in active:
                u = int(u_np)
                remaining = T - u
                smear_u_3d = np.zeros((C, D, T), dtype=np.float64)
                smear_u_3d[:, :, u:] = (
                    source_mass_3d[:, :, u, None]
                    * K[None, :, :remaining]
                )
                out += smear_u_3d
                smear_map[u] = smear_u_3d.reshape(C * D, T)
            return out, source_basis, smear_map

        scalar.batched_op = batched_op
        scalar.source_banded_op = source_banded_op
        return scalar

    # Seed at the topology root, both cohorts, all draws.
    root_mass = np.ones((cohort_count * S_per_cohort,), dtype=np.float64)
    ledger_mass, ledger_basis = _build_ledger_at(
        topo.x_node_id, 0, root_mass, BucketSourceBasis.POINT_AT_ENDPOINT,
    )

    results = _run_dp_each_policy(
        topo, make_provider(),
        ledger_mass=ledger_mass, ledger_basis=ledger_basis,
        cohort_count=cohort_count,
        S_per_cohort=S_per_cohort, T=T,
    )

    trace_scalar = results[DPExecutionPolicy.SCALAR]
    trace_toeplitz = results[DPExecutionPolicy.TOEPLITZ_APPLY]
    trace_banded = results[DPExecutionPolicy.SOURCE_BANDED]

    for node in topo.on_path:
        np.testing.assert_allclose(
            trace_scalar.node_density(node),
            trace_toeplitz.node_density(node),
            atol=1e-12,
            err_msg=f'SCALAR vs TOEPLITZ_APPLY disagreement at {node}',
        )
        np.testing.assert_allclose(
            trace_scalar.node_density(node),
            trace_banded.node_density(node),
            atol=1e-12,
            err_msg=f'SCALAR vs SOURCE_BANDED disagreement at {node}',
        )


# ─── F3: branch/sibling diamond ─────────────────────────────────────────────


def test_F3_branch_sibling_diamond_three_policies_identical():
    """F3: diamond topology ``a → {b, c} → d`` — mass at ``a`` fans out
    through two parallel branches and re-joins at ``d``. Each branch
    edge carries a different per-edge shift-invariant kernel. The
    destination at ``d`` is the sum of contributions from both
    branches; per-policy identity is asserted at every on-path node
    including the fan-in.
    """
    cohort_count = 1
    S_per_cohort = 2
    T = 10
    graph = _make_graph(
        ['a', 'b', 'c', 'd'],
        [('a', 'b'), ('a', 'c'), ('b', 'd'), ('c', 'd')],
    )
    topo = _build_span_topology(graph, 'a', 'd')
    assert topo is not None

    # Different per-edge kernels. Edge keys are
    # ``{from}->{to}#{sibling_idx}`` where sibling_idx is counted only
    # within the (from, to) pair, not across the whole graph.
    edge_kernels = {
        'a->b#0': (1, 0.6),
        'a->c#0': (2, 0.4),
        'b->d#0': (1, 0.8),
        'c->d#0': (3, 0.5),
    }

    def make_provider():
        def kernel_for(edge_key):
            lag, p = edge_kernels[edge_key]
            K = np.zeros((S_per_cohort, T), dtype=np.float64)
            K[:, lag] = p
            return K

        def scalar(ce, source_index, cohort_index, source_basis):
            K = kernel_for(ce.edge_key)
            u = int(source_index)
            return K[:, : T - u].copy(), source_basis

        def batched_op(ce, source_basis, source_mass_3d):
            K = kernel_for(ce.edge_key)
            K_padded = np.zeros((S_per_cohort, T), dtype=np.float64)
            K_padded[:, : K.shape[1]] = K
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

        def source_banded_op(ce, source_basis, source_mass_3d):
            K = kernel_for(ce.edge_key)
            C, D, _ = source_mass_3d.shape
            out = np.zeros_like(source_mass_3d)
            smear_map = {}
            active = np.flatnonzero(
                np.any(source_mass_3d != 0.0, axis=(0, 1))
            )
            for u_np in active:
                u = int(u_np)
                remaining = T - u
                smear_u_3d = np.zeros((C, D, T), dtype=np.float64)
                smear_u_3d[:, :, u:] = (
                    source_mass_3d[:, :, u, None]
                    * K[None, :, :remaining]
                )
                out += smear_u_3d
                smear_map[u] = smear_u_3d.reshape(C * D, T)
            return out, source_basis, smear_map

        scalar.batched_op = batched_op
        scalar.source_banded_op = source_banded_op
        return scalar

    root_mass = np.ones((cohort_count * S_per_cohort,), dtype=np.float64)
    ledger_mass, ledger_basis = _build_ledger_at(
        topo.x_node_id, 0, root_mass, BucketSourceBasis.POINT_AT_ENDPOINT,
    )

    results = _run_dp_each_policy(
        topo, make_provider(),
        ledger_mass=ledger_mass, ledger_basis=ledger_basis,
        cohort_count=cohort_count,
        S_per_cohort=S_per_cohort, T=T,
    )

    trace_scalar = results[DPExecutionPolicy.SCALAR]
    trace_toeplitz = results[DPExecutionPolicy.TOEPLITZ_APPLY]
    trace_banded = results[DPExecutionPolicy.SOURCE_BANDED]

    for node in topo.on_path:
        np.testing.assert_allclose(
            trace_scalar.node_density(node),
            trace_toeplitz.node_density(node),
            atol=1e-12,
            err_msg=f'SCALAR vs TOEPLITZ_APPLY disagreement at {node}',
        )
        np.testing.assert_allclose(
            trace_scalar.node_density(node),
            trace_banded.node_density(node),
            atol=1e-12,
            err_msg=f'SCALAR vs SOURCE_BANDED disagreement at {node}',
        )


# ─── F8: source-indexed banded (u-varying kernel) ──────────────────────────


def _source_indexed_provider(K_per_u: np.ndarray, *, T: int):
    """Provider for a per-source-bucket kernel ``K_per_u`` of shape
    ``(T, draw_count, T)``.

    ``K_per_u[u, d, k]`` is the kernel value at relative offset ``k``
    from source bucket ``u``, on draw ``d``. Cohort-invariant (the same
    ``K_per_u`` is used for every cohort), draw-indexed, source-bucket-
    indexed. The kernel VARIES in ``u`` — TOEPLITZ_APPLY's shift-
    invariance assumption does not hold, so ``.batched_op`` is
    intentionally NOT exposed. SCALAR / SOURCE_BANDED both apply the
    general source-indexed contraction
    ``out[c, d, v] = Σ_u M[c, d, u] · K[u, d, v − u]`` and must agree.
    """

    def scalar(ce, source_index, cohort_index, source_basis):
        u = int(source_index)
        return K_per_u[u, :, : T - u].copy(), source_basis

    def source_banded_op(ce, source_basis, source_mass_3d):
        C, D, _ = source_mass_3d.shape
        out = np.zeros_like(source_mass_3d)
        smear_map = {}
        active = np.flatnonzero(
            np.any(source_mass_3d != 0.0, axis=(0, 1))
        )
        for u_np in active:
            u = int(u_np)
            remaining = T - u
            smear_u_3d = np.zeros((C, D, T), dtype=np.float64)
            smear_u_3d[:, :, u:] = (
                source_mass_3d[:, :, u, None]
                * K_per_u[u, None, :, :remaining]
            )
            out += smear_u_3d
            smear_map[u] = smear_u_3d.reshape(C * D, T)
        return out, source_basis, smear_map

    scalar.source_banded_op = source_banded_op
    # No .batched_op — u-varying kernel violates Toeplitz shift-invariance.
    return scalar


def test_F8_source_indexed_banded_u_varying_kernel():
    """F8: source-indexed banded fast path on a kernel that VARIES in ``u``.

    Each source bucket carries a different Dirac kernel (different lag
    and amplitude). SCALAR and SOURCE_BANDED both apply the general
    source-indexed contraction
    ``out[c, d, v] = Σ_u M[c, d, u] · K[u, d, v − u]`` and must agree
    bucket-by-bucket on out_3d AND smear_map.

    TOEPLITZ_APPLY's shift-invariance assumption does not hold for this
    kernel family (per FC plan §1093 / §1180); the provider deliberately
    omits ``.batched_op`` so that policy raises ``AttributeError`` at
    applier construction — this is the empirical evidence regime.
    """
    cohort_count = 2
    S_per_cohort = 3
    T = 10

    # Build a u-varying kernel: each source bucket u places mass at lag
    # (u % 3) + 1 with amplitude 1.0 / (u + 1). Different per u; no
    # shift-invariance.
    K_per_u = np.zeros((T, S_per_cohort, T), dtype=np.float64)
    for u in range(T):
        lag = (u % 3) + 1
        if u + lag < T:
            K_per_u[u, :, lag] = 1.0 / float(u + 1)

    ce = _make_edge('a', 'b', 'a->b#0')
    provider = _source_indexed_provider(K_per_u, T=T)

    source_mass_3d = np.zeros(
        (cohort_count, S_per_cohort, T), dtype=np.float64,
    )
    source_mass_3d[0, :, 0] = 1.0
    source_mass_3d[0, :, 3] = 0.4
    source_mass_3d[1, :, 1] = 0.7
    source_mass_3d[1, :, 5] = 0.2

    # Run only the three policies the provider supports (TOEPLITZ_APPLY
    # is asserted to refuse construction below).
    results = {}
    for policy in (
        DPExecutionPolicy.SCALAR,
        DPExecutionPolicy.SOURCE_BANDED,
    ):
        applier = _make_operator_applier(
            policy, provider,
            cohort_count=cohort_count,
            S_per_cohort=S_per_cohort,
            T=T,
        )
        results[policy] = applier(
            ce, BucketSourceBasis.BUCKET_DISTRIBUTED,
            source_mass_3d.copy(),
        )

    out_scalar, basis_scalar, smear_scalar = results[DPExecutionPolicy.SCALAR]
    out_banded, basis_banded, smear_banded = results[DPExecutionPolicy.SOURCE_BANDED]

    np.testing.assert_allclose(out_scalar, out_banded, atol=1e-12)
    assert basis_scalar == basis_banded == BucketSourceBasis.BUCKET_DISTRIBUTED

    # Smear-map identity bucket-by-bucket. SOURCE_BANDED must preserve
    # the per-edge per-source smear that frontier occupancy consumes
    # (plan §1107).
    assert set(smear_scalar.keys()) == {0, 1, 3, 5}
    assert set(smear_banded.keys()) == {0, 1, 3, 5}
    for u in smear_scalar:
        np.testing.assert_allclose(
            smear_scalar[u], smear_banded[u], atol=1e-12,
            err_msg=f'SCALAR vs SOURCE_BANDED smear disagreement at u={u}',
        )

    # TOEPLITZ_APPLY cannot be applied to a u-varying kernel; per the
    # no-fallback rule the missing capability raises at construction.
    with pytest.raises(AttributeError):
        _make_operator_applier(
            DPExecutionPolicy.TOEPLITZ_APPLY,
            provider,
            cohort_count=cohort_count,
            S_per_cohort=S_per_cohort,
            T=T,
        )


# ─── F7: non-root ledger seed (FC frontier-occupancy shape) ────────────────


def test_F7_non_root_ledger_seed_three_policies_identical():
    """F7: seed at an intermediate node only (root left empty) — the
    frontier-occupancy seed shape FC continuation uses. The canonical
    DP must propagate the seed forward from the intermediate node
    under every compatible policy. SCALAR, TOEPLITZ_APPLY, and
    SOURCE_BANDED all run the same single algebra; outputs must agree.
    """
    cohort_count = 1
    S_per_cohort = 2
    T = 8
    graph = _make_graph(
        ['a', 'b', 'c'],
        [('a', 'b'), ('b', 'c')],
    )
    topo = _build_span_topology(graph, 'a', 'c')
    assert topo is not None

    K_static = np.zeros((S_per_cohort, T), dtype=np.float64)
    K_static[:, 1] = 0.8

    def make_provider():
        def scalar(ce, source_index, cohort_index, source_basis):
            u = int(source_index)
            return K_static[:, : T - u].copy(), source_basis

        def batched_op(ce, source_basis, source_mass_3d):
            K_padded = np.zeros((S_per_cohort, T), dtype=np.float64)
            K_padded[:, : K_static.shape[1]] = K_static
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

        def source_banded_op(ce, source_basis, source_mass_3d):
            C, D, _ = source_mass_3d.shape
            out = np.zeros_like(source_mass_3d)
            smear_map = {}
            active = np.flatnonzero(
                np.any(source_mass_3d != 0.0, axis=(0, 1))
            )
            for u_np in active:
                u = int(u_np)
                remaining = T - u
                smear_u_3d = np.zeros((C, D, T), dtype=np.float64)
                smear_u_3d[:, :, u:] = (
                    source_mass_3d[:, :, u, None]
                    * K_static[None, :, :remaining]
                )
                out += smear_u_3d
                smear_map[u] = smear_u_3d.reshape(C * D, T)
            return out, source_basis, smear_map

        scalar.batched_op = batched_op
        scalar.source_banded_op = source_banded_op
        return scalar

    # Seed only at the intermediate node ``b`` bucket 2; ``a`` is empty.
    seed_mass = np.ones((cohort_count * S_per_cohort,), dtype=np.float64) * 0.3
    ledger_mass, ledger_basis = _build_ledger_at(
        'b', 2, seed_mass, BucketSourceBasis.POINT_AT_ENDPOINT,
    )

    results = _run_dp_each_policy(
        topo, make_provider(),
        ledger_mass=ledger_mass, ledger_basis=ledger_basis,
        cohort_count=cohort_count,
        S_per_cohort=S_per_cohort, T=T,
    )

    trace_scalar = results[DPExecutionPolicy.SCALAR]
    trace_toeplitz = results[DPExecutionPolicy.TOEPLITZ_APPLY]
    trace_banded = results[DPExecutionPolicy.SOURCE_BANDED]

    for node in topo.on_path:
        np.testing.assert_allclose(
            trace_scalar.node_density(node),
            trace_toeplitz.node_density(node),
            atol=1e-12,
            err_msg=f'SCALAR vs TOEPLITZ_APPLY disagreement at {node} (non-root seed)',
        )
        np.testing.assert_allclose(
            trace_scalar.node_density(node),
            trace_banded.node_density(node),
            atol=1e-12,
            err_msg=f'SCALAR vs SOURCE_BANDED disagreement at {node} (non-root seed)',
        )

    # And the non-root semantic: a's density is all-zero because the
    # seed is at b, not a.
    np.testing.assert_array_equal(
        trace_scalar.node_density('a'),
        np.zeros((cohort_count * S_per_cohort, T), dtype=np.float64),
    )
