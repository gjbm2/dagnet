"""Pure span readout core.

    L_next = L_current ⊗ K        for each operator K (in order)
    prefix = cumulative projection of L_end onto (cohort, tau)

The readout carries only propagated value mass. The former support /
exposure streams were part of the removed coverage-through-DP design.

Everything else -- topology, mode, admission, family naming, representation
choice, type discipline, shape refusal -- belongs at the perimeter and not
in this file.

Operator canonical form: ``(rows, kernel_length)`` where ``rows`` is 1 for
shift-invariant operators and ``days`` for source-day-specific operators.
Numpy broadcasting unifies both storage variants in one code path.

Caller-supplied invariants the engine relies on (defended at the perimeter,
not here):

    cohort_ids        : tuple[str, ...]                length = n_cohorts
    root_days         : np.ndarray[int]                shape  = (n_cohorts,)
    root_counts       : np.ndarray[float]              shape  = (n_cohorts,)
    root_supports     : np.ndarray[float]              shape  = (n_cohorts,)
                                                         retained as a
                                                         compatibility
                                                         parameter; ignored
                                                         by value readout
    operators[k].value:    np.ndarray[float]           shape  = (rows, K_k)
                                                         rows ∈ {1, days}
                                                         K_k <= days
    days              : int   >= max(root_days) + max_tau + 1
    max_tau           : int   >= 0
    provenance        : Mapping[str, object]           (use ``{}`` for none)

Any violation raises naturally from numpy or Python; the engine does not
catch, clip, cap, coerce, or default.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

import numpy as np


_EMPTY_PROVENANCE: Mapping[str, object] = MappingProxyType({})


@dataclass(frozen=True)
class SpanOperator:
    """Per-operator value kernel."""
    name: str
    value: np.ndarray
    family: str = "evidence"


def _apply_kernel(ledger: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    days = ledger.shape[1]
    kernel_length = kernel.shape[1]
    result = np.zeros_like(ledger)
    for offset in range(kernel_length):
        result[:, offset:] += ledger[:, : days - offset] * kernel[: days - offset, offset]
    return result


@dataclass(frozen=True)
class PrefixSurface:
    cohort_ids: tuple[str, ...]
    max_tau: int
    value_by_cohort_tau: np.ndarray
    value_ledgers: tuple[np.ndarray, ...]
    provenance: Mapping[str, object]

    def mass_at(self, cohort_id: str, tau: int) -> float:
        return float(self.value_by_cohort_tau[self.cohort_ids.index(cohort_id), tau])

    def aggregate_mass_by_tau(self) -> np.ndarray:
        return self.value_by_cohort_tau.sum(axis=0)


def evaluate_span_readout(
    *,
    cohort_ids: tuple[str, ...],
    root_days: np.ndarray,
    root_counts: np.ndarray,
    root_supports: np.ndarray,
    operators: tuple[SpanOperator, ...] = (),
    days: int,
    max_tau: int,
    provenance: Mapping[str, object] = _EMPTY_PROVENANCE,
) -> PrefixSurface:
    n_cohorts = len(cohort_ids)
    value_ledgers = [np.zeros((n_cohorts, days), dtype=float)]
    indices = np.arange(n_cohorts)
    value_ledgers[0][indices, root_days] = root_counts
    for operator in operators:
        value_ledgers.append(_apply_kernel(value_ledgers[-1], operator.value))

    tau_values = np.arange(max_tau + 1)
    cumulative_value = np.cumsum(value_ledgers[-1], axis=1)
    columns = root_days[:, None] + tau_values[None, :]
    return PrefixSurface(
        cohort_ids=cohort_ids,
        max_tau=max_tau,
        value_by_cohort_tau=np.take_along_axis(cumulative_value, columns, axis=1),
        value_ledgers=tuple(value_ledgers),
        provenance={
            "kernel_count": len(operators),
            "kernel_families": tuple(operator.family for operator in operators),
            **provenance,
        },
    )
