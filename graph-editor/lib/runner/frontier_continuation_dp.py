"""Frontier-conditioned continuation DP (FC §5.4 / §9.6).

Atom 4c.C: this module is now a thin adapter over the canonical
``timing_span._run_dp_density_trace_from_ledger`` core. The adapter:

1. Translates the FC's basis-keyed input ledger
   ``[node][bucket][basis_int] -> mass`` into the canonical
   per-(node, bucket, provenance) shape using the synthetic
   provenance key ``frontier@{basis_int}`` — FC carries no upstream
   lineage beyond basis (plan §1031-1036), so the provenance key
   encodes the basis directly and nothing else.

2. Delegates to the canonical core with caller-declared
   ``execution_policy``. Production callers in
   ``model_span_spine._project_frontier_continuation_surfaces`` declare
   ``TOEPLITZ_APPLY`` because the predictive and residual providers
   expose ``batched_op`` — the operator-apply contract the
   ``TOEPLITZ_APPLY`` applier consumes directly.

3. Extracts the basis-keyed continuation result from the canonical
   ``SpanDPTrace`` by grouping per-(node, bucket) provenance entries
   under their basis.

Per FC plan §5.2 / §9.6 mass with the same ``(role, node, bucket)``
is NOT lineage-tagged (no upstream-path labels), but basis IS
preserved at the bucket level — basis is a kernel-dispatch property
(POINT_AT_ENDPOINT vs BUCKET_DISTRIBUTED select different conditioned
kernels) so masses with different bases at the same (node, bucket)
coexist as separate inner-dict entries and the next-hop kernel fires
once per basis.

No mode branching (FC §9.10): identity carrier degenerates to empty
ledger → empty trace; single-hop / multi-hop subject share the same
loop; Dirac kernels degenerate via the kernel provider. The DP
algebra lives in the canonical core; this module owns only the
input/output shape translation between the FC's basis-keyed view and
the canonical per-provenance view.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, Mapping, Tuple

import numpy as np

from .bucket_transition import BucketSourceBasis
from .span_kernel import ConcreteEdge, SpanTopology
from .timing_span import (
    DPExecutionPolicy,
    SpanDPTrace,
    _run_dp_density_trace_from_ledger,
)


__all__ = [
    "ContinuationDPResult",
    "run_dp_from_node_source_ledgers",
]


# Kernel-provider contract is uniform: always returns
# ``(kernel, out_basis)``. The kernel is broadcastable with shape
# ``(cohort_count, draw_count, horizon - source_index)`` — either the
# full ``(C, D, T-u)`` for cohort-dependent providers (e.g. the
# frontier-residual wrapper, which inflects on each cohort's own
# ``f_c``) or ``(D, T-u)`` for cohort-invariant providers (e.g. the
# conditioned predictive kernel maps). The DP relies on numpy
# broadcasting so it does not branch on shape.
KernelReturn = Tuple[np.ndarray, BucketSourceBasis]
KernelProvider = Callable[
    [ConcreteEdge, int, BucketSourceBasis], KernelReturn,
]


@dataclass(frozen=True)
class ContinuationDPResult:
    """Per-(node, bucket, basis) mass produced by the FC DP.

    Same shape as the input ledger. Basis lives as the inner dict key
    — masses with the same (role, node, bucket) and the same basis
    merge by addition; masses at the same (node, bucket) but different
    bases coexist as separate entries so the next hop fires one
    kernel per basis.
    """
    node_density_by_node_bucket: Mapping[
        str, Mapping[int, Mapping[int, np.ndarray]]
    ]
    draw_count: int
    horizon_len: int

    def node_density(self, node: str) -> np.ndarray:
        out = np.zeros(
            (int(self.draw_count), int(self.horizon_len)),
            dtype=np.float32,
        )
        for arrival_col, basis_map in self.node_density_by_node_bucket[node].items():
            for col_mass in basis_map.values():
                out[:, int(arrival_col)] += col_mass
        return out


def _basis_keyed_ledger_to_provenance(
    initial_ledger_mass: Mapping[str, Mapping[int, Mapping[int, np.ndarray]]],
) -> Tuple[
    Dict[str, Dict[int, Dict[str, np.ndarray]]],
    Dict[str, Dict[int, Dict[str, int]]],
]:
    """Translate the FC basis-keyed input ledger to the canonical
    per-(node, bucket, provenance) shape the canonical core consumes.

    One provenance per (bucket, basis): the FC continuation has no
    notion of upstream lineage beyond basis (plan §1031-1036), so the
    provenance key ``frontier@{basis_int}`` is both the lineage label
    and the basis carrier. The associated basis surface lands at the
    same key with the same basis value.
    """
    node_provenance_mass: Dict[str, Dict[int, Dict[str, np.ndarray]]] = {}
    node_provenance_basis: Dict[str, Dict[int, Dict[str, int]]] = {}
    for node, bucket_map in initial_ledger_mass.items():
        node_mass: Dict[int, Dict[str, np.ndarray]] = {}
        node_basis: Dict[int, Dict[str, int]] = {}
        for bucket, basis_map in bucket_map.items():
            bucket_int = int(bucket)
            prov_mass: Dict[str, np.ndarray] = {}
            prov_basis: Dict[str, int] = {}
            for basis, mass in basis_map.items():
                basis_int = int(basis)
                prov_key = f'frontier@{basis_int}'
                prov_mass[prov_key] = np.asarray(mass, dtype=np.float32).copy()
                prov_basis[prov_key] = basis_int
            node_mass[bucket_int] = prov_mass
            node_basis[bucket_int] = prov_basis
        node_provenance_mass[node] = node_mass
        node_provenance_basis[node] = node_basis
    return node_provenance_mass, node_provenance_basis


def _canonical_trace_to_basis_keyed(
    canonical_trace: SpanDPTrace,
    *,
    on_path,
) -> Mapping[str, Mapping[int, Mapping[int, np.ndarray]]]:
    """Extract the FC basis-keyed per-(node, bucket, basis) view from
    the canonical ``SpanDPTrace``.

    The canonical core stores mass as
    ``node_mass_by_provenance[node][bucket][prov_key]`` with prov_keys
    of the form ``frontier@{basis_int}`` (FC seed) or
    ``{edge_key}@{basis_int}`` (edge contribution). For each entry the
    associated basis lives at ``node_basis_by_node_bucket[node][bucket]
    [prov_key]``. Summing provenance mass under each basis per
    (node, bucket) recovers the basis-collapsed view consumers expect.
    """
    node_density_by_node_bucket: Dict[
        str, Dict[int, Dict[int, np.ndarray]]
    ] = {}
    for node in on_path:
        bucket_provenance_map = canonical_trace.node_mass_by_provenance.get(
            node, {},
        )
        if not bucket_provenance_map:
            node_density_by_node_bucket[node] = {}
            continue
        bucket_basis_map = canonical_trace.node_basis_by_node_bucket[node]
        bucket_out: Dict[int, Dict[int, np.ndarray]] = {}
        for bucket_int, prov_mass_map in bucket_provenance_map.items():
            prov_basis_map = bucket_basis_map[bucket_int]
            basis_to_mass: Dict[int, np.ndarray] = {}
            for prov_key, mass in prov_mass_map.items():
                basis_int = int(prov_basis_map[prov_key])
                existing = basis_to_mass.get(basis_int)
                if existing is None:
                    basis_to_mass[basis_int] = mass.copy()
                else:
                    existing += mass
            bucket_out[int(bucket_int)] = basis_to_mass
        node_density_by_node_bucket[node] = bucket_out
    return node_density_by_node_bucket


def run_dp_from_node_source_ledgers(
    *,
    topology: SpanTopology,
    initial_ledger_mass: Mapping[str, Mapping[int, Mapping[int, np.ndarray]]],
    kernel_provider: KernelProvider,
    cohort_count: int,
    draw_count: int,
    horizon: int,
    execution_policy: DPExecutionPolicy,
) -> ContinuationDPResult:
    """Forward DAG DP from a per-(node, bucket, basis) frontier ledger.

    Thin adapter over ``timing_span._run_dp_density_trace_from_ledger``:
    translates the FC basis-keyed input ledger to canonical
    per-(node, bucket, provenance) shape, delegates to the canonical
    core under the caller-declared ``execution_policy``, and extracts
    the basis-keyed continuation surface from the canonical trace.

    Production callers in
    ``model_span_spine._project_frontier_continuation_surfaces`` declare
    ``DPExecutionPolicy.TOEPLITZ_APPLY``. The predictive and residual
    providers expose ``batched_op(ce, source_basis, source_mass_3d) ->
    (out_3d, out_basis)`` — the canonical TOEPLITZ_APPLY applier
    consumes that contract directly with no signature wrapping. Atom
    4b's perf budget is preserved by construction (the canonical
    TOEPLITZ_APPLY applier IS one matmul per (edge, basis)).

    Test callers may declare ``SCALAR`` provided the supplied provider
    satisfies the matching contract. Missing capability raises
    ``AttributeError`` at applier construction (no silent fallback to
    a different policy).
    """
    C = int(cohort_count)
    D = int(draw_count)
    S_total = C * D
    T = int(horizon) + 1

    node_provenance_mass, node_provenance_basis = _basis_keyed_ledger_to_provenance(
        initial_ledger_mass,
    )

    canonical_trace = _run_dp_density_trace_from_ledger(
        topology,
        kernel_provider,
        initial_node_provenance_mass=node_provenance_mass,
        initial_node_provenance_basis=node_provenance_basis,
        S=S_total,
        T=T,
        execution_policy=execution_policy,
        cohort_count=C,
    )

    node_density_by_node_bucket = _canonical_trace_to_basis_keyed(
        canonical_trace, on_path=topology.on_path,
    )

    return ContinuationDPResult(
        node_density_by_node_bucket=node_density_by_node_bucket,
        draw_count=S_total,
        horizon_len=T,
    )
