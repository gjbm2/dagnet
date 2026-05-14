"""Primitive draw operator supply for span readout.

Builds the three parallel kernels (value, support, exposure) the
:class:`span_readout.SpanOperator` carries. Phase 6 contract §4.8:

- ``value`` = ``p_edge × Δcdf`` (the mass-transfer kernel under proper
  T1 conditioning, embedded structurally for cohort);
- ``support`` = ``value × observed_mask`` (the value-weighted support
  kernel — coverage projects from cumulative support / cumulative value);
- ``exposure`` = ``exposure_shape × observed_mask`` where
  ``exposure_shape`` is the unit-reach latency PMF independent of edge
  probability; preserves the covered-zero / absent distinction at
  cumulative-zero cells.

The per-cell observation mask is supplied by the primitive's evidence
binding (Phase 7 work for the live runtime). For this engine extension
the mask defaults to all-ones; callers needing the absent-cell algebra
in tests or downstream readers supply an explicit mask through
:class:`PrimitiveDrawSurface`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np

from .span_readout import SpanOperator


def delay_operator(
    name: str,
    increments: np.ndarray,
    *,
    family: str,
    support_increments: np.ndarray,
    exposure_increments: np.ndarray,
) -> SpanOperator:
    increment_values = np.asarray(increments, dtype=float).reshape(1, -1)
    support_values = np.asarray(support_increments, dtype=float).reshape(1, -1)
    exposure_values = np.asarray(exposure_increments, dtype=float).reshape(1, -1)
    return SpanOperator(
        name=name,
        value=increment_values,
        support=support_values,
        family=family,
        exposure=exposure_values,
    )


@dataclass(frozen=True)
class PrimitiveDrawSurface:
    """Per-edge per-draw kernel inputs for the operator supply.

    ``value_observation_mask_draws`` carries the per-(draw, τ) observation
    mask (1 = observed-positive or covered-zero per Phase 6 §4.7, 0 =
    absent). When ``None`` the mask is treated as all-ones — the
    fully-observed default that downstream tests overrides to exercise
    absent / covered-zero behaviour.
    """
    edge_id: str
    p_draws: np.ndarray
    conditional_cdf_draws: np.ndarray = field(default_factory=lambda: np.empty((0, 0), dtype=float))
    timing_family: str = "latent"
    deterministic_shift_days: int = 0
    value_observation_mask_draws: Optional[np.ndarray] = None


def _primitive_kernels(
    probability: float,
    cdf: Sequence[float],
    timing_family: str,
    deterministic_shift_days: int,
    mask: Optional[np.ndarray] = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Convert one primitive edge into (value, support, exposure) increments.

    ``mask`` is the per-cell observation mask aligned with the value
    increments. ``None`` (the default) is treated as all-ones — the
    fully-observed case where support equals value and exposure equals
    the unit-reach latency PMF.

    Phase 6 §4.8:
      value     = p_edge × Δcdf                 (mass-transfer kernel)
      support   = value × mask                  (value-weighted support)
      exposure  = exposure_shape × mask         (value-independent
                                                  exposure stream)

    ``exposure_shape`` is the normalised latency PMF: the per-cell
    arrival shape without the edge probability factor. For non-latent
    primitives it is δ at τ=0; for deterministic it is δ at the shift;
    for latent it is ``Δcdf`` (which sums to 1 over τ for a valid CDF
    saturating at 1.0).
    """
    if timing_family == "non_latent":
        value = np.array([float(probability)])
        exposure_shape = np.array([1.0])
        m = np.ones_like(value) if mask is None else np.asarray(mask, dtype=float)
        return value, value * m, exposure_shape * m
    if timing_family == "deterministic":
        value = np.zeros(int(deterministic_shift_days) + 1, dtype=float)
        exposure_shape = np.zeros_like(value)
        value[int(deterministic_shift_days)] = float(probability)
        exposure_shape[int(deterministic_shift_days)] = 1.0
        m = np.ones_like(value) if mask is None else np.asarray(mask, dtype=float)
        return value, value * m, exposure_shape * m

    cdf_values = np.asarray(cdf, dtype=float)
    exposure_shape = np.diff(cdf_values, prepend=0.0)
    value = float(probability) * exposure_shape
    m = np.ones_like(value) if mask is None else np.asarray(mask, dtype=float)
    return value, value * m, exposure_shape * m


def draw_model_primitive_operators(primitive: PrimitiveDrawSurface) -> tuple[SpanOperator, ...]:
    p_draws = np.asarray(primitive.p_draws, dtype=float)
    cdfs = np.asarray(primitive.conditional_cdf_draws, dtype=float)
    has_cdf = primitive.timing_family == "latent"
    mask_draws = (
        np.asarray(primitive.value_observation_mask_draws, dtype=float)
        if primitive.value_observation_mask_draws is not None
        else None
    )
    operators = []
    for draw_index, probability in enumerate(p_draws):
        mask_s = mask_draws[draw_index] if mask_draws is not None else None
        value, support, exposure = _primitive_kernels(
            probability,
            cdfs[draw_index] if has_cdf else (),
            primitive.timing_family,
            primitive.deterministic_shift_days,
            mask=mask_s,
        )
        operators.append(
            delay_operator(
                f"{primitive.edge_id}::draw:{draw_index}",
                value,
                support_increments=support,
                exposure_increments=exposure,
                family=f"primitive_model_draw_{primitive.timing_family}",
            )
        )
    return tuple(operators)
