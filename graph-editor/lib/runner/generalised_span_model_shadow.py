"""Strict operator-chain engine for generalised span shadow comparisons.

Inputs are already-resolved span plans: root value/support, ordered operators,
and the production curves to compare against.  This module does not inspect
production runtime objects, choose carrier/subject cases, compile model/evidence
surfaces, or repair missing data.  The algebra is the contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence, Tuple

import numpy as np

from .span_readout import SpanOperator, evaluate_span_readout


@dataclass(frozen=True)
class SpanShadowOperator:
    """One already-compiled day-to-day operator."""

    name: str
    value: np.ndarray
    support: np.ndarray


@dataclass(frozen=True)
class SpanShadowPlan:
    """One strict shadow comparison plan."""

    label: str
    root_day: int
    root_value: float
    root_support: float
    ordered_operators: Tuple[SpanShadowOperator, ...]
    expected_value_curve: np.ndarray
    expected_support_curve: np.ndarray
    metadata: Mapping[str, object]


def build_generalised_span_model_shadow(
    *,
    plans: Sequence[SpanShadowPlan],
    max_tau: int,
) -> Mapping[str, object]:
    """Evaluate all span plans with the same operator-chain algebra."""

    return {
        "max_tau": int(max_tau),
        "spans": {
            plan.label: _compare_plan(plan, max_tau=max_tau)
            for plan in plans
        },
    }


def _compare_plan(plan: SpanShadowPlan, *, max_tau: int) -> Mapping[str, object]:
    candidate_value, candidate_support = _evaluate_curves(
        root_day=plan.root_day,
        root_value=plan.root_value,
        root_support=plan.root_support,
        operators=plan.ordered_operators,
        max_tau=max_tau,
    )
    expected_value = np.asarray(plan.expected_value_curve, dtype=float)
    expected_support = np.asarray(plan.expected_support_curve, dtype=float)
    value_diff = candidate_value - expected_value
    support_diff = candidate_support - expected_support
    value_max_abs_idx = int(np.argmax(np.abs(value_diff)))
    support_max_abs_idx = int(np.argmax(np.abs(support_diff)))
    return {
        "label": plan.label,
        "operator_count": len(plan.ordered_operators),
        "metadata": dict(plan.metadata),
        "value_max_abs_diff": float(np.max(np.abs(value_diff))),
        "value_argmax_tau": value_max_abs_idx,
        "value_signed_diff_at_argmax": float(value_diff[value_max_abs_idx]),
        "candidate_value_tail": _tail(candidate_value),
        "expected_value_tail": _tail(expected_value),
        "value_diff_tail": _tail(value_diff),
        "support_max_abs_diff": float(np.max(np.abs(support_diff))),
        "support_argmax_tau": support_max_abs_idx,
        "support_signed_diff_at_argmax": float(support_diff[support_max_abs_idx]),
        "candidate_support_tail": _tail(candidate_support),
        "expected_support_tail": _tail(expected_support),
        "support_diff_tail": _tail(support_diff),
    }


def _evaluate_curves(
    *,
    root_day: int,
    root_value: float,
    root_support: float,
    operators: Sequence[SpanShadowOperator],
    max_tau: int,
) -> Tuple[np.ndarray, np.ndarray]:
    days = int(root_day) + int(max_tau) + 1
    surface = evaluate_span_readout(
        cohort_ids=("shadow",),
        root_days=(int(root_day),),
        root_counts=(float(root_value),),
        root_supports=(float(root_support),),
        operators=tuple(
            SpanOperator(
                name=operator.name,
                value=operator.value,
                support=operator.support,
                family="shadow",
            )
            for operator in operators
        ),
        days=days,
        max_tau=max_tau,
    )
    return surface.value_by_cohort_tau[0], surface.coverage_by_cohort_tau[0]


def _tail(values: Sequence[float], size: int = 5) -> Tuple[float, ...]:
    arr = np.asarray(values, dtype=float)
    return tuple(float(value) for value in arr[-int(size):])


__all__ = [
    "SpanShadowOperator",
    "SpanShadowPlan",
    "build_generalised_span_model_shadow",
]
