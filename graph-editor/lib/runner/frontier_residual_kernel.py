"""Residual predictive kernel provider for frontier-conditioned continuation.

Atom 4 of the frontier-conditioned chart-surface proposal (§5.3 / §9.5).
Wraps a base predictive kernel provider so the FC continuation DP from
frontier ledgers (§9.6) consumes residual-only mass. The wrapper is
vectorised across the cohort axis: one call returns a kernel batch of
shape ``(C, D, T_offset)`` for all cohorts at the given source bucket.

For each on-path non-terminal node U, source bucket u, predictive draw
s, and Cohort frontier ``f_c``, the residual increment kernel through
outgoing edge e is

    B_inc(τ) = q_e(τ) · I[τ_offset > f_c − u] / (1 − H_s,U(u, f_c))

where ``q_e(τ)`` is the base predictive increment kernel and

    H_s,U(u, f_c) = Σ_{e' on-path outgoing from U} Q_s,e'(u, f_c)

is the NODE-level cumulative survivor — the cumulative fraction of
bucket-u mass that has departed U through any on-path outgoing edge by
the frontier. The denominator is node-level, not edge-local: using
``1 - Q_s,e(u, f_c)`` per outgoing edge would over-normalise individual
edge residuals at branching nodes and let them allocate more future
mass than physically remains at the node (§5.3, §9.9 test 3).

Algebraic degeneracies (§5.3 / I-47):

- Single-outgoing node — Σ collapses to one edge, ``H = Q_e``.
- Source bucket above frontier (``u > f_c``) — ``ks = f_c − u < 0``,
  so the survivor lookup gates contributions to zero, ``H = 0`` and
  ``survivor = 1``; the destination-side ``post_mask`` keeps only
  ``dest > f_c`` columns, which is automatically satisfied since the
  kernel only emits at ``dest ≥ u > f_c``. The residual kernel
  therefore equals the base predictive kernel for post-frontier
  source buckets — supported algebra, not a forbidden caller case.
  This is what makes the §9.4 branchless root-seed injection work:
  future-of-frontier root mass at the carrier root rides the same
  residual DP as physical frontier residuals.
- Node-level survivor ``H = 1`` — survivor is 0; division emits Inf/NaN
  per IEEE 754. Visible degradation. The matching occupancy is zero,
  so downstream ``0 × NaN = NaN`` propagates.
"""

from __future__ import annotations

from typing import Callable, Dict, Sequence, Tuple

import numpy as np

from .bucket_transition import BucketSourceBasis
from .span_kernel import ConcreteEdge, SpanTopology


__all__ = [
    "make_frontier_residual_kernel_provider",
]


# Providers return ``(kernel, out_basis)`` uniformly. The residual
# wrapper preserves whatever ``out_basis`` the wrapped base provider
# emits — the residual operation is a per-(u, f_c) scaling of the
# kernel, not a basis change. Provider signature drops ``cohort_idx``
# from the legacy form: cohorts are dispatched inside the wrapper by
# broadcasting over the frontier-by-cohort vector.
KernelReturn = Tuple[np.ndarray, BucketSourceBasis]
BaseKernelProvider = Callable[
    [ConcreteEdge, int, BucketSourceBasis], KernelReturn,
]


def _outgoing_on_path(
    topology: SpanTopology, node: str
) -> Tuple[ConcreteEdge, ...]:
    return tuple(
        ce for ce in topology.concrete_edges
        if ce.from_id == node and ce.to_id in topology.on_path
    )


def make_frontier_residual_kernel_provider(
    *,
    topology: SpanTopology,
    base_kernel_provider: BaseKernelProvider,
    frontier_by_cohort: Sequence[int],
    cohort_count: int,
    draw_count: int,
    horizon: int,
) -> BaseKernelProvider:
    f_arr = np.asarray(frontier_by_cohort, dtype=np.int64)
    H = int(horizon)

    def residual_provider(
        ce: ConcreteEdge,
        source_index: int,
        source_basis: BucketSourceBasis,
    ) -> KernelReturn:
        u = int(source_index)
        T_offset = H - u
        col_idx = np.arange(T_offset)
        # Per-cohort frontier offset broadcast. ``offset[c] = f_c - u``;
        # ``prefix_mask[c, τ] = (τ ≤ offset[c])``.
        offset_per_c = f_arr - u  # (C,)
        prefix_mask = col_idx[None, :] <= offset_per_c[:, None]  # (C, T_offset)
        post_mask = ~prefix_mask  # (C, T_offset)

        # Base kernel for this edge: (D, T_offset). Cohort-invariant
        # under the predictive base provider (the conditioned kernel
        # maps do not vary by cohort); the cohort axis is introduced
        # below by broadcasting against the per-cohort masks.
        base_kernel_arr, out_basis = base_kernel_provider(
            ce, u, source_basis,
        )
        base_kernel = np.asarray(base_kernel_arr, dtype=np.float32)

        # Node-level survivor ``h[c, s] = Σ_e Σ_{τ ≤ f_c-u} q_e(τ)``.
        # Each outgoing edge's base kernel (D, T_offset) broadcasts
        # against prefix_mask (C, T_offset) → (C, D, T_offset); sum
        # along τ; sum across siblings. Cohort-vectorised.
        h = sum(
            (np.asarray(
                base_kernel_provider(outce, u, source_basis)[0],
                dtype=np.float32,
            )[None, :, :] * prefix_mask[:, None, :]).sum(axis=-1)
            for outce in _outgoing_on_path(topology, ce.from_id)
        )  # (C, D)
        survivor = 1.0 - h  # (C, D)

        # Residual = base_kernel * post_mask / survivor, broadcast to
        # (C, D, T_offset). base_kernel[None, :, :] is (1, D, T_offset);
        # post_mask[:, None, :] is (C, 1, T_offset);
        # survivor[:, :, None] is (C, D, 1). Product/quotient over
        # broadcasting yields (C, D, T_offset).
        with np.errstate(divide='ignore', invalid='ignore'):
            return (
                base_kernel[None, :, :]
                * post_mask[:, None, :]
                / survivor[:, :, None]
            ), out_basis

    # ── Batched code path (Atom 4b) ─────────────────────────────────
    #
    # Apply the residual operator to a full per-(node, basis) source
    # mass tensor ``(C, D, T)`` in one BLAS-backed contraction. The
    # algebra exploits two structural facts:
    #
    #   1. In DEST-column coordinates, ``post_mask(c, dest) = (dest >
    #      f_c[c])`` is independent of the source bucket ``u`` —
    #      derivation: ``offset = dest - u`` and ``post = offset >
    #      f_c - u``, so ``post(c, dest, u) = dest > f_c[c]``. The
    #      mask becomes a single ``(C, T)`` multiplicand on the
    #      output, applied after the convolution.
    #   2. The base kernel ``K[d, k]`` is cohort-invariant, so a
    #      shared per-(edge, basis) Toeplitz matrix
    #      ``T_mat[d, dest, u] = K[d, dest-u]`` drives the
    #      convolution for every source bucket at once.
    #
    # The per-source-bucket survivor ``1 - H(c, d, u)`` becomes a
    # multiplicative scaler on source mass before convolution: define
    # ``M' = M / survivor``, then
    #     out[c, d, dest] = (dest > f_c[c])
    #                       × sum_u M'[c, d, u] × T_mat[d, dest, u].
    #
    # Outgoing-edges Toeplitz/kernel caches survive across calls so
    # the second carrier/subject pass is essentially free.
    base_batched_op = getattr(base_kernel_provider, 'batched_op', None)
    base_toeplitz_cache: Dict[Tuple[str, int], np.ndarray] = {}
    base_kernel_cache: Dict[Tuple[str, int], np.ndarray] = {}
    survivor_cache: Dict[Tuple[str, int], np.ndarray] = {}

    def _get_base_kernel(
        ce: ConcreteEdge, source_basis: BucketSourceBasis,
    ) -> np.ndarray:
        key = (ce.edge_key, int(source_basis))
        K = base_kernel_cache.get(key)
        if K is None:
            K_arr, _ = base_kernel_provider(ce, 0, source_basis)
            K = np.asarray(K_arr, dtype=np.float32)
            base_kernel_cache[key] = K
        return K

    def _get_base_toeplitz(
        ce: ConcreteEdge, source_basis: BucketSourceBasis,
    ) -> np.ndarray:
        key = (ce.edge_key, int(source_basis))
        T_mat = base_toeplitz_cache.get(key)
        if T_mat is None:
            K = _get_base_kernel(ce, source_basis)
            from .model_span_spine import _build_kernel_toeplitz
            T_mat = _build_kernel_toeplitz(K, H)
            base_toeplitz_cache[key] = T_mat
        return T_mat

    def _get_survivor(
        from_node: str, source_basis: BucketSourceBasis,
    ) -> np.ndarray:
        """Per-(cohort, draw, source_bucket) survivor ``1 - H_U(u, f_c)``.

        ``H_U(u, f_c) = Σ_e Σ_{k=0}^{f_c-u} K_e[d, k]`` over the
        on-path outgoing edges of ``U``. Vectorised by precomputing
        each edge's cumulative kernel ``cum_e[d, k]`` and indexing at
        ``f_c[c] - u`` with a negative-index guard (mass that hasn't
        arrived yet has zero cumulative departure).
        """
        key = (from_node, int(source_basis))
        cached = survivor_cache.get(key)
        if cached is not None:
            return cached
        u_idx = np.arange(H)
        # ks[c, u] = f_c[c] - u; negative means u > f_c (no
        # departures possible — survivor stays at 1).
        ks = f_arr[:, None] - u_idx[None, :]  # (C, H)
        ks_safe = np.maximum(ks, 0)  # (C, H)
        H_sum = np.zeros((int(f_arr.size), 1, int(H)), dtype=np.float32)
        # Accumulator shape (C, D, H). Start by summing per-edge contributions.
        h_total = None
        outgoing = _outgoing_on_path(topology, from_node)
        for outce in outgoing:
            K_e = _get_base_kernel(outce, source_basis)  # (D, H)
            cum_e = np.cumsum(K_e, axis=-1)  # (D, H)
            # Lookup cum_e at ks[c, u] → (C, D, H). Negative ks rows
            # contribute zero — gated by ``ks_valid``.
            looked = cum_e[:, ks_safe]  # (D, C, H)
            looked = np.moveaxis(looked, 0, 1)  # (C, D, H)
            ks_valid = (ks >= 0).astype(np.float32)[:, None, :]
            contribution = looked * ks_valid
            h_total = contribution if h_total is None else h_total + contribution
        if h_total is None:
            # No outgoing edges → survivor is 1 everywhere. (Shouldn't
            # be reached in practice — caller only invokes the
            # residual provider for nodes with on-path outgoings.)
            h_total = np.zeros(
                (int(f_arr.size), 1, int(H)), dtype=np.float32,
            )
        survivor = 1.0 - h_total  # (C, D, H)
        survivor_cache[key] = survivor
        return survivor

    # Per-cohort post_mask in dest-column coordinates is independent
    # of source bucket: ``(dest > f_c[c])`` shape ``(C, H)``.
    dest_idx = np.arange(H)
    post_mask_full = (dest_idx[None, :] > f_arr[:, None]).astype(np.float32)

    def batched_op(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ) -> KernelReturn:
        """Apply the residual operator to source mass ``(C, D, T)``
        in one matmul plus a per-cohort mask. Bypasses the per-
        source-bucket Python loop.
        """
        if source_mass_3d.shape[-1] != H:
            raise AssertionError(
                f"residual batched_op expects source mass shape "
                f"(C, D, {H}); got {source_mass_3d.shape}.",
            )
        T_mat = _get_base_toeplitz(ce, source_basis)  # (D, H, H)
        survivor = _get_survivor(ce.from_id, source_basis)  # (C, D, H)
        with np.errstate(divide='ignore', invalid='ignore'):
            M_scaled = source_mass_3d / survivor  # (C, D, H)
        # Where source mass is zero, ``0/0`` becomes NaN. Replace with
        # zero so the convolution does not propagate NaN through
        # buckets that have no mass to forecast. (Buckets with mass
        # AND zero survivor — i.e. node fully departed by frontier —
        # still emit NaN, which is the spec-required visible
        # degradation per §5.3 / I-47.)
        M_scaled = np.where(source_mass_3d == 0.0, 0.0, M_scaled)
        raw = np.einsum('cdu,dvu->cdv', M_scaled, T_mat, optimize=True)
        out = raw * post_mask_full[:, None, :]
        _, out_basis = base_kernel_provider(ce, 0, source_basis)
        return out, out_basis

    residual_provider.batched_op = batched_op  # type: ignore[attr-defined]
    return residual_provider
