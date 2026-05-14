"""Pure span readout core.

    L_next = L_current @ K        for each operator K (in order)
    prefix = cumulative projection of L_end onto (cohort, tau)

Value and support are two parallel streams: value carries mass, support carries
coverage so a covered zero is distinct from absence. Everything else --
topology, mode, admission, family naming -- belongs outside this file.

Operators may supply value/support as either a 1D kernel (shift-invariant
delay) or a 2D (days, days) matrix; 1D applies via shift-and-add convolution,
2D via matmul. Outputs are numerically identical up to FP summation order.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np


@dataclass(frozen=True)
class SpanOperator:
    name: str
    value: np.ndarray
    support: np.ndarray
    family: str = "evidence"


def _apply_kernel(ledger: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    days = ledger.shape[1]
    result = np.zeros_like(ledger)
    effective_length = min(int(kernel.shape[0]), days)
    for offset in range(effective_length):
        weight = float(kernel[offset])
        if weight == 0.0:
            continue
        result[:, offset:] += ledger[:, : days - offset] * weight
    return result


def _apply_operator(ledger: np.ndarray, operator_array: np.ndarray) -> np.ndarray:
    if operator_array.ndim == 1:
        return _apply_kernel(ledger, operator_array)
    return ledger @ operator_array


@dataclass(frozen=True)
class PrefixSurface:
    cohort_ids: tuple[str, ...]
    max_tau: int
    value_by_cohort_tau: np.ndarray
    coverage_by_cohort_tau: np.ndarray
    value_ledgers: tuple[np.ndarray, ...]
    support_ledgers: tuple[np.ndarray, ...]
    provenance: Mapping[str, object]

    def mass_at(self, cohort_id: str, tau: int) -> float:
        return float(self.value_by_cohort_tau[self.cohort_ids.index(cohort_id), int(tau)])

    def coverage_at(self, cohort_id: str, tau: int) -> float:
        return float(self.coverage_by_cohort_tau[self.cohort_ids.index(cohort_id), int(tau)])

    def aggregate_mass_by_tau(self) -> np.ndarray:
        return self.value_by_cohort_tau.sum(axis=0)


def evaluate_span_readout(
    *,
    cohort_ids: Sequence[str],
    root_days: Sequence[int],
    root_counts: Sequence[float],
    root_supports: Sequence[float],
    operators: Sequence[SpanOperator] = (),
    days: int,
    max_tau: int,
    provenance: Mapping[str, object] | None = None,
) -> PrefixSurface:
    n_cohorts = len(cohort_ids)
    root_day_indices = np.asarray(root_days, dtype=int)
    value_ledgers = [np.zeros((n_cohorts, days), dtype=float)]
    support_ledgers = [np.zeros((n_cohorts, days), dtype=float)]
    value_ledgers[0][np.arange(n_cohorts), root_day_indices] = np.asarray(
        root_counts,
        dtype=float,
    )
    support_ledgers[0][np.arange(n_cohorts), root_day_indices] = np.asarray(
        root_supports,
        dtype=float,
    )
    for operator in operators:
        value_ledgers.append(_apply_operator(value_ledgers[-1], operator.value))
        support_ledgers.append(
            np.minimum(1.0, _apply_operator(support_ledgers[-1], operator.support))
        )

    tau_values = np.arange(max_tau + 1)
    cumulative_value = np.cumsum(value_ledgers[-1], axis=1)
    cumulative_support = np.cumsum(support_ledgers[-1], axis=1)
    columns = np.minimum(
        root_day_indices[:, None] + tau_values[None, :],
        days - 1,
    )
    return PrefixSurface(
        cohort_ids=tuple(str(cohort_id) for cohort_id in cohort_ids),
        max_tau=int(max_tau),
        value_by_cohort_tau=np.take_along_axis(cumulative_value, columns, axis=1),
        coverage_by_cohort_tau=np.minimum(
            1.0,
            np.take_along_axis(cumulative_support, columns, axis=1),
        ),
        value_ledgers=tuple(value_ledgers),
        support_ledgers=tuple(support_ledgers),
        provenance={
            "kernel_count": len(operators),
            "kernel_families": tuple(operator.family for operator in operators),
            **(provenance or {}),
        },
    )
