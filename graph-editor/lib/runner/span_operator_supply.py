"""Primitive draw operator supply for span readout."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from .span_readout import SpanOperator


def delay_operator(
    name: str,
    increments: np.ndarray,
    *,
    family: str,
    support_increments: np.ndarray,
) -> SpanOperator:
    increment_values = np.asarray(increments, dtype=float).reshape(1, -1)
    support_values = np.asarray(support_increments, dtype=float).reshape(1, -1)
    return SpanOperator(
        name=name,
        value=increment_values,
        support=support_values,
        family=family,
    )


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


def draw_model_primitive_operators(primitive: PrimitiveDrawSurface) -> tuple[SpanOperator, ...]:
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
                family=f"primitive_model_draw_{primitive.timing_family}",
            )
        )
    return tuple(operators)
