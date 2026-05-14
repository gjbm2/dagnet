"""Pure span readout core.

    L_next = L_current ⊗ K        for each operator K (in order)
    prefix = cumulative projection of L_end onto (cohort, tau)

Three parallel streams run through the same convolution operator:

  - **value** carries propagated conversion mass;
  - **support** carries `value × mask` so a covered zero is distinct
    from absence;
  - **exposure** carries `exposure_shape × mask` so observed cells with
    zero conversion mass remain distinguishable from absent cells at
    cumulative zero.

All three streams use one ``_apply_kernel`` operator; the per-cell
observation mask is baked into the per-operator kernels at primitive
preparation time, never at convolution time. The DP does not branch on
observed-positive versus covered-zero versus absent.

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
    root_exposures    : np.ndarray[float] | None       shape  = (n_cohorts,)
                                                         (defaults to
                                                         ``root_supports``
                                                         per Phase 6 §4.8 —
                                                         the anchor cohort
                                                         itself is the
                                                         observation at the
                                                         chain root)
    operators[k].value:    np.ndarray[float]           shape  = (rows, K_k)
                                                         rows ∈ {1, days}
                                                         K_k <= days
    operators[k].support:  same shape contract as .value
    operators[k].exposure: same shape contract as .value
    days              : int   >= max(root_days) + max_tau + 1
    max_tau           : int   >= 0
    provenance        : Mapping[str, object]           (use ``{}`` for none)

Any violation raises naturally from numpy or Python; the engine does not
catch, clip, cap, coerce, or default.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Mapping, Optional

import numpy as np


_EMPTY_PROVENANCE: Mapping[str, object] = MappingProxyType({})


def _empty_kernel() -> np.ndarray:
    return np.zeros((1, 0), dtype=float)


@dataclass(frozen=True)
class SpanOperator:
    """Per-operator kernel triplet.

    ``value`` carries propagated conversion mass. ``support`` carries
    ``value × mask`` (the value-weighted support kernel of Phase 6 §4.8).
    ``exposure`` carries ``exposure_shape × mask`` (the value-independent
    exposure kernel of Phase 6 §4.8 that preserves the covered-zero /
    absent distinction at cumulative-zero cells). All three share the
    same ``(rows, kernel_length)`` shape contract.

    ``exposure`` defaults to an empty kernel so legacy operator
    constructors continue to compile; the convolution against an empty
    kernel produces a zero ledger — visibly absent rather than silently
    fabricated.
    """
    name: str
    value: np.ndarray
    support: np.ndarray
    family: str = "evidence"
    exposure: np.ndarray = field(default_factory=_empty_kernel)


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
    coverage_by_cohort_tau: np.ndarray
    exposure_by_cohort_tau: np.ndarray
    value_ledgers: tuple[np.ndarray, ...]
    support_ledgers: tuple[np.ndarray, ...]
    exposure_ledgers: tuple[np.ndarray, ...]
    provenance: Mapping[str, object]

    def mass_at(self, cohort_id: str, tau: int) -> float:
        return float(self.value_by_cohort_tau[self.cohort_ids.index(cohort_id), tau])

    def coverage_at(self, cohort_id: str, tau: int) -> float:
        return float(self.coverage_by_cohort_tau[self.cohort_ids.index(cohort_id), tau])

    def exposure_at(self, cohort_id: str, tau: int) -> float:
        return float(self.exposure_by_cohort_tau[self.cohort_ids.index(cohort_id), tau])

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
    root_exposures: Optional[np.ndarray] = None,
    provenance: Mapping[str, object] = _EMPTY_PROVENANCE,
) -> PrefixSurface:
    n_cohorts = len(cohort_ids)
    exposure_seed = root_supports if root_exposures is None else root_exposures
    value_ledgers = [np.zeros((n_cohorts, days), dtype=float)]
    support_ledgers = [np.zeros((n_cohorts, days), dtype=float)]
    exposure_ledgers = [np.zeros((n_cohorts, days), dtype=float)]
    indices = np.arange(n_cohorts)
    value_ledgers[0][indices, root_days] = root_counts
    support_ledgers[0][indices, root_days] = root_supports
    exposure_ledgers[0][indices, root_days] = exposure_seed
    for operator in operators:
        value_ledgers.append(_apply_kernel(value_ledgers[-1], operator.value))
        support_ledgers.append(_apply_kernel(support_ledgers[-1], operator.support))
        exposure_ledgers.append(_apply_kernel(exposure_ledgers[-1], operator.exposure))

    tau_values = np.arange(max_tau + 1)
    cumulative_value = np.cumsum(value_ledgers[-1], axis=1)
    cumulative_support = np.cumsum(support_ledgers[-1], axis=1)
    cumulative_exposure = np.cumsum(exposure_ledgers[-1], axis=1)
    columns = root_days[:, None] + tau_values[None, :]
    return PrefixSurface(
        cohort_ids=cohort_ids,
        max_tau=max_tau,
        value_by_cohort_tau=np.take_along_axis(cumulative_value, columns, axis=1),
        coverage_by_cohort_tau=np.take_along_axis(cumulative_support, columns, axis=1),
        exposure_by_cohort_tau=np.take_along_axis(cumulative_exposure, columns, axis=1),
        value_ledgers=tuple(value_ledgers),
        support_ledgers=tuple(support_ledgers),
        exposure_ledgers=tuple(exposure_ledgers),
        provenance={
            "kernel_count": len(operators),
            "kernel_families": tuple(operator.family for operator in operators),
            **provenance,
        },
    )
