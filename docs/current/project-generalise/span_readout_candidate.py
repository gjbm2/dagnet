"""Pure dense span readout core.

    L_next = L_current @ K        for each operator K (in order)
    prefix = cumulative projection of L_end onto (cohort, tau)

Value and support are two parallel streams: value carries mass, support carries
coverage (so a covered zero is distinct from absent).  Everything else --
topology, mode, admission, family naming -- belongs outside this file.
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


@dataclass(frozen=True)
class PrefixSurface:
    cohort_ids: tuple
    max_tau: int
    value_by_cohort_tau: np.ndarray
    coverage_by_cohort_tau: np.ndarray
    value_ledgers: tuple
    support_ledgers: tuple
    provenance: Mapping[str, object]

    def mass_at(self, cohort_id, tau):
        return float(self.value_by_cohort_tau[self.cohort_ids.index(cohort_id), int(tau)])

    def coverage_at(self, cohort_id, tau):
        return float(self.coverage_by_cohort_tau[self.cohort_ids.index(cohort_id), int(tau)])

    def aggregate_mass_by_tau(self):
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
    n = len(cohort_ids)
    rdi = np.asarray(root_days, dtype=int)
    L = [np.zeros((n, days), dtype=float)]
    S = [np.zeros((n, days), dtype=float)]
    L[0][np.arange(n), rdi] = np.asarray(root_counts, dtype=float)
    S[0][np.arange(n), rdi] = np.asarray(root_supports, dtype=float)
    for op in operators:
        L.append(L[-1] @ op.value)
        S.append(np.minimum(1.0, S[-1] @ op.support))
    tau = np.arange(max_tau + 1)
    mask = (np.arange(days)[None, None, :] <= (rdi[:, None, None] + tau[None, :, None])).astype(float)
    return PrefixSurface(
        cohort_ids=tuple(str(c) for c in cohort_ids),
        max_tau=int(max_tau),
        value_by_cohort_tau=(L[-1][:, None, :] * mask).sum(axis=2),
        coverage_by_cohort_tau=np.minimum(1.0, (S[-1][:, None, :] * mask).sum(axis=2)),
        value_ledgers=tuple(L),
        support_ledgers=tuple(S),
        provenance={
            "kernel_count": len(operators),
            "kernel_families": tuple(op.family for op in operators),
            **(provenance or {}),
        },
    )
