"""Operator constructors for the span readout core.

Two input kinds: raw arrays (delay kernels, CDFs, n/k rows) and primitive
surfaces (one edge's reach + timing data, mean or per-draw). Primitive
builders dispatch on ``timing_family`` via one helper.

All constructors emit the canonical ``(rows, kernel_length)`` form expected
by the span readout: ``rows == 1`` for shift-invariant operators,
``rows == days`` for source-day-specific operators. Representation
choice and any conversion logic lives here at the perimeter; the
evaluator itself is shape-agnostic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

import numpy as np

from .span_readout import SpanOperator


def identity_operator(name: str, *, days: int, family: str = "identity") -> SpanOperator:
    kernel = np.array([[1.0]], dtype=float)
    return SpanOperator(name=name, value=kernel, support=kernel.copy(), family=family)


def delay_operator(
    name: str,
    increments: Sequence[float],
    *,
    days: int,
    family: str,
    support_increments: Sequence[float],
) -> SpanOperator:
    increment_values = np.asarray(increments, dtype=float).reshape(1, -1)
    support_values = np.asarray(support_increments, dtype=float).reshape(1, -1)
    return SpanOperator(
        name=name,
        value=increment_values,
        support=support_values,
        family=family,
    )


def model_operator_from_cdf(
    name: str,
    *,
    reach: float,
    conditional_cdf: Sequence[float],
    days: int,
    family: str = "model",
) -> SpanOperator:
    cdf = np.asarray(conditional_cdf, dtype=float)
    increments = np.diff(cdf, prepend=0.0)
    return delay_operator(
        name,
        reach * increments,
        days=days,
        family=family,
        support_increments=(increments != 0.0).astype(float),
    )


def evidence_operator_from_cumulative_rate(
    name: str,
    *,
    cumulative_rate_by_age: Sequence[float],
    days: int,
    support_by_age: Sequence[float],
    family: str = "evidence",
) -> SpanOperator:
    rate = np.asarray(cumulative_rate_by_age, dtype=float)
    return delay_operator(
        name,
        np.diff(rate, prepend=0.0),
        days=days,
        family=family,
        support_increments=np.asarray(support_by_age, dtype=float),
    )


def evidence_operator_from_nk_by_age(
    name: str,
    *,
    n_by_age: Sequence[float],
    k_by_age: Sequence[float],
    days: int,
    family: str = "evidence",
) -> SpanOperator:
    n_values = np.asarray(n_by_age, dtype=float)
    k_values = np.asarray(k_by_age, dtype=float)
    return evidence_operator_from_cumulative_rate(
        name,
        cumulative_rate_by_age=k_values / n_values,
        support_by_age=(n_values != 0.0).astype(float),
        days=days,
        family=family,
    )


def source_day_specific_evidence_operator(
    name: str,
    *,
    n_by_source_age: np.ndarray,
    k_by_source_age: np.ndarray,
    source_days: Sequence[int],
    days: int,
    family: str = "evidence_source_day_specific",
) -> SpanOperator:
    source = np.asarray(source_days, dtype=int)
    kernel_length = n_by_source_age.shape[1]
    increments = np.diff(k_by_source_age / n_by_source_age, axis=1, prepend=0.0)
    support_increments = (n_by_source_age != 0.0).astype(float)
    value = np.zeros((days, kernel_length), dtype=float)
    support = np.zeros((days, kernel_length), dtype=float)
    value[source] = increments
    support[source] = support_increments
    return SpanOperator(name=name, value=value, support=support, family=family)


@dataclass(frozen=True)
class PrimitiveModelSurface:
    edge_id: str
    p: float
    conditional_cdf: Sequence[float] = field(default_factory=tuple)
    timing_family: str = "latent"
    deterministic_shift_days: int = 0


@dataclass(frozen=True)
class PrimitiveDrawSurface:
    edge_id: str
    p_draws: np.ndarray
    conditional_cdf_draws: np.ndarray = field(default_factory=lambda: np.empty((0, 0), dtype=float))
    timing_family: str = "latent"
    deterministic_shift_days: int = 0


def _primitive_kernels(
    probability: float,
    cdf: Sequence[float],
    timing_family: str,
    deterministic_shift_days: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert one primitive edge into value and support increments."""
    if timing_family == "non_latent":
        return np.array([float(probability)]), np.array([1.0])
    if timing_family == "deterministic":
        increments = np.zeros(int(deterministic_shift_days) + 1, dtype=float)
        support = np.zeros_like(increments)
        increments[int(deterministic_shift_days)] = float(probability)
        support[int(deterministic_shift_days)] = 1.0
        return increments, support

    cdf_values = np.asarray(cdf, dtype=float)
    increments = float(probability) * np.diff(cdf_values, prepend=0.0)
    return increments, np.ones_like(increments)


def model_primitive_operator(primitive: PrimitiveModelSurface, *, days: int) -> SpanOperator:
    increments, support = _primitive_kernels(
        primitive.p,
        primitive.conditional_cdf,
        primitive.timing_family,
        primitive.deterministic_shift_days,
    )
    return delay_operator(
        primitive.edge_id,
        increments,
        support_increments=support,
        days=days,
        family=f"primitive_model_{primitive.timing_family}",
    )


def draw_model_primitive_operators(primitive: PrimitiveDrawSurface, *, days: int) -> tuple[SpanOperator, ...]:
    p_draws = np.asarray(primitive.p_draws, dtype=float)
    cdfs = np.asarray(primitive.conditional_cdf_draws, dtype=float)
    has_cdf = primitive.timing_family == "latent"
    operators = []
    for draw_index, probability in enumerate(p_draws):
        increments, support = _primitive_kernels(
            probability,
            cdfs[draw_index] if has_cdf else (),
            primitive.timing_family,
            primitive.deterministic_shift_days,
        )
        operators.append(
            delay_operator(
                f"{primitive.edge_id}::draw:{draw_index}",
                increments,
                support_increments=support,
                days=days,
                family=f"primitive_model_draw_{primitive.timing_family}",
            )
        )
    return tuple(operators)


def operators_for_path(
    edge_ids: Sequence[str],
    operator_by_edge_id: Mapping[str, SpanOperator],
) -> tuple[SpanOperator, ...]:
    return tuple(operator_by_edge_id[edge_id] for edge_id in edge_ids)
