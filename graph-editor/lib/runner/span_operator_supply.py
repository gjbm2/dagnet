"""Primitive draw operator supply for span readout.

Builds the value kernel carried by :class:`span_readout.SpanOperator`.
The removed support/exposure coverage design used to live here; the
operator supply is now value-only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from .bucket_transition import (
    cumulative_empirical_rate_to_transition,
    dirac_transition,
    to_span_operator,
)
from .span_readout import SpanOperator


def delay_operator(
    name: str,
    increments: np.ndarray,
    *,
    family: str,
) -> SpanOperator:
    increment_values = np.asarray(increments, dtype=np.float32).reshape(1, -1)
    return SpanOperator(
        name=name,
        value=increment_values,
        family=family,
    )


@dataclass(frozen=True)
class PrimitiveDrawSurface:
    """Per-edge per-draw kernel inputs for the operator supply."""
    edge_id: str
    p_draws: np.ndarray
    conditional_cdf_draws: np.ndarray = field(default_factory=lambda: np.empty((0, 0), dtype=np.float32))
    timing_family: str = "latent"
    deterministic_shift_days: int = 0


def _primitive_kernels(
    probability: float,
    cdf: Sequence[float],
    timing_family: str,
    deterministic_shift_days: int,
) -> np.ndarray:
    """Convert one primitive edge into value increments."""
    if timing_family == "non_latent":
        return dirac_transition(
            "non_latent",
            lag=0,
            probability=float(probability),
            family="primitive_model_draw_non_latent",
        ).value[0]
    if timing_family == "deterministic":
        return dirac_transition(
            "deterministic",
            lag=int(deterministic_shift_days),
            probability=float(probability),
            family="primitive_model_draw_deterministic",
        ).value[0]

    cdf_values = np.asarray(cdf, dtype=np.float32)
    return cumulative_empirical_rate_to_transition(
        "latent",
        cdf_values,
        family="primitive_model_draw_latent",
    ).value[0] * float(probability)


def draw_model_primitive_operators(primitive: PrimitiveDrawSurface) -> tuple[SpanOperator, ...]:
    p_draws = np.asarray(primitive.p_draws, dtype=np.float32)
    cdfs = np.asarray(primitive.conditional_cdf_draws, dtype=np.float32)
    has_cdf = primitive.timing_family == "latent"
    operators = []
    for draw_index, probability in enumerate(p_draws):
        value = _primitive_kernels(
            probability,
            cdfs[draw_index] if has_cdf else (),
            primitive.timing_family,
            primitive.deterministic_shift_days,
        )
        operators.append(
            delay_operator(
                f"{primitive.edge_id}::draw:{draw_index}",
                value,
                family=f"primitive_model_draw_{primitive.timing_family}",
            )
        )
    return tuple(operators)
