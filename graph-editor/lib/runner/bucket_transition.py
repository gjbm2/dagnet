"""Canonical bucket-to-bucket transition algebra.

The value matrix convention is shared by model and empirical readouts:
row ``s`` is the source bucket, column ``l`` is the non-negative lag to
output bucket ``s + l``. Shift-invariant transitions use one row; source-
specific transitions may supply one row per source bucket.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from enum import IntEnum
from typing import Optional, Sequence

import numpy as np

from .numpy_stats import curvature_corrected_interp
from .span_readout import SpanOperator


class BucketSourceBasis(IntEnum):
    """How source mass is represented when a transition consumes it."""

    POINT_AT_ENDPOINT = 0
    BUCKET_DISTRIBUTED = 1
    OBSERVED_ENDPOINT = 2


@dataclass(frozen=True)
class BucketTransition:
    """Immutable transition value matrix."""

    name: str
    value: np.ndarray
    family: str


def endpoint_cdf_to_transition(
    name: str,
    endpoint_cdf: Sequence[float] | np.ndarray,
    *,
    family: str,
    probability: float = 1.0,
) -> BucketTransition:
    """Convert endpoint-labelled cumulative values to transition mass."""

    cdf = np.asarray(endpoint_cdf, dtype=np.float32)
    value = float(probability) * np.diff(cdf, prepend=0.0, axis=-1)
    return BucketTransition(
        name=name,
        value=np.atleast_2d(value),
        family=family,
    )


def cdf_to_bucket_transition(
    name: str,
    cumulative: Sequence[float] | np.ndarray,
    *,
    family: str,
    probability: float = 1.0,
    read_offset: float = 0.5,
    interpolation: str = "curvature",
    output_width: Optional[int] = None,
) -> BucketTransition:
    """Convert cumulative samples to bucket-centred transition mass.

    ``read_offset`` is applied to relative lag coordinates. For source-
    bucket-centred progression, ``read_offset=0.5`` reads exposure from
    the source bucket centre to the output endpoint. Endpoint-aligned
    carrier/root transitions use ``read_offset=0.0``.

    ``output_width`` truncates the emitted transition to the first W
    bucket positions. The caller (e.g. the DP loop in
    ``_run_dp_density_trace_from_seed``) sometimes only consumes the
    first ``T − source_index`` positions of the kernel; computing the
    tail it discards is pure waste. The cumulative input is read
    full-width (so the cubic Hermite stencil has correct boundary
    neighbours at τ = W − 1) but only W positions of ``shifted`` are
    produced. ``None`` (the default) emits full width.
    """

    cdf = np.atleast_2d(np.asarray(cumulative, dtype=np.float32))
    T_in = int(cdf.shape[1])
    W = T_in if output_width is None else min(int(output_width), T_in)

    if interpolation == "monotone_cubic":
        # Vectorised monotone-cubic read at fractional age τ + read_offset
        # for every τ in ``[0, W)`` in one pass. The per-τ Hermite read is
        # independent across τ, so the original Python ``for tau in
        # range(...)`` loop (T per-call numpy slices) is bit-identical to
        # one batched numpy operation — pure overhead removal, no
        # algorithmic change.
        #
        # Monotone cubic Hermite is monotonicity-preserving by
        # construction (the result is clipped to ``[min(y0, y1),
        # max(y0, y1)]`` inside ``_monotone_cubic_read_shifted``).
        # Therefore ``np.diff(shifted, prepend=0)`` sums exactly to
        # ``shifted[:, -1]`` with no overshoot — the row_sum/terminal
        # rescaling that the curvature path needs is a no-op for the
        # full-width case and would actively damage the truncated case
        # (rescaling a partial bucket transition up to the asymptote of
        # the full cumulative produces an incorrect kernel). Skip it.
        shifted = _monotone_cubic_read_shifted(
            cdf, float(read_offset), output_width=W,
        )
        value = float(probability) * np.diff(shifted, prepend=0.0, axis=1)
        return BucketTransition(name=name, value=value, family=family)

    def lookup(age_idx: int) -> np.ndarray:
        if age_idx < 0:
            return np.zeros(cdf.shape[0], dtype=np.float32)
        if age_idx >= cdf.shape[1]:
            return cdf[:, -1]
        return cdf[:, age_idx]

    def read_fractional(age: float) -> np.ndarray:
        if interpolation == "curvature":
            return curvature_corrected_interp(lookup, age)
        if interpolation == "monotone_curvature":
            floor_idx = math.floor(age)
            lo = lookup(floor_idx)
            hi = lookup(floor_idx + 1)
            raw = curvature_corrected_interp(lookup, age)
            return np.minimum(np.maximum(raw, np.minimum(lo, hi)), np.maximum(lo, hi))
        if interpolation == "linear":
            floor_idx = math.floor(age)
            frac = float(age) - float(floor_idx)
            return (1.0 - frac) * lookup(floor_idx) + frac * lookup(floor_idx + 1)
        raise ValueError(f"unknown bucket interpolation {interpolation!r}")

    shifted = np.zeros((cdf.shape[0], W), dtype=np.float32)
    for tau in range(W):
        shifted[:, tau] = read_fractional(float(tau) + float(read_offset))
    value = float(probability) * np.diff(shifted, prepend=0.0, axis=1)
    # Preserve the endpoint saturation carried by the input cumulative.
    # The midpoint stencil can overshoot near a clamped tail; scaling the
    # transition row back to the endpoint terminal mass keeps K as a
    # bucket placement operator without changing the observed asymptote.
    # When the output is truncated (``W < T_in``), the appropriate
    # terminal is the partial sum that ``shifted[:, W-1]`` already
    # represents — using the full cumulative's asymptote would
    # incorrectly rescale the partial kernel.
    terminal = cdf[:, -1] if W == T_in else shifted[:, -1]
    row_sum = value.sum(axis=1)
    scale = np.divide(
        terminal,
        row_sum,
        out=np.ones_like(terminal, dtype=np.float32),
        where=row_sum != 0.0,
    )
    value = value * scale[:, None]
    return BucketTransition(name=name, value=value, family=family)


# Sensitivity knob (temporary): set to True to force endpoint reads
# (read_offset=0.0) regardless of source basis, bypassing the midpoint
# cubic Hermite. Used to measure how much of cohort wall-clock comes
# from the midpoint correction vs. the underlying DP compute. Both
# window and cohort use the same convention, so divergence properties
# between them are preserved when this is flipped. PRODUCTION MUST KEEP
# THIS FALSE — midpoint is the load-bearing read for accurate bucket-
# centred mass exposure.
_FORCE_ENDPOINT_READS_FOR_SENSITIVITY = False


def empirical_read_offset_for_basis(source_basis: BucketSourceBasis) -> float:
    """Empirical K read offset implied by source mass representation.

    ``BUCKET_DISTRIBUTED`` source mass reads exposure from the bucket
    centre (read_offset=0.5), which fires the cubic Hermite path in
    ``cdf_to_bucket_transition``. ``POINT_AT_ENDPOINT`` reads at the
    endpoint (read_offset=0.0), which the h=0 fast-path returns directly
    from ``cdf`` without cubic interpolation work.

    See ``_FORCE_ENDPOINT_READS_FOR_SENSITIVITY`` above for the temporary
    sensitivity override.
    """

    if _FORCE_ENDPOINT_READS_FOR_SENSITIVITY:
        return 0.0
    if source_basis == BucketSourceBasis.BUCKET_DISTRIBUTED:
        return 0.5
    return 0.0


def _monotone_cubic_read(cdf: np.ndarray, age: float) -> np.ndarray:
    """Shape-preserving cubic Hermite read for monotone cumulative rows."""
    if age < 0.0:
        return np.zeros(cdf.shape[0], dtype=np.float32)
    max_idx = cdf.shape[1] - 1
    if age == 0.0:
        return cdf[:, 0]
    if age >= max_idx:
        return cdf[:, -1]

    i = math.floor(age)
    h = float(age) - float(i)
    y0 = cdf[:, i]
    y1 = cdf[:, i + 1]
    d0 = y1 - y0
    d_prev = y0 - (cdf[:, i - 1] if i > 0 else np.zeros(cdf.shape[0]))
    d_next = (cdf[:, i + 2] if i + 2 <= max_idx else cdf[:, -1]) - y1

    m0 = _monotone_slope(d_prev, d0)
    m1 = _monotone_slope(d0, d_next)

    h2 = h * h
    h3 = h2 * h
    value = (
        (2.0 * h3 - 3.0 * h2 + 1.0) * y0
        + (h3 - 2.0 * h2 + h) * m0
        + (-2.0 * h3 + 3.0 * h2) * y1
        + (h3 - h2) * m1
    )
    return np.minimum(np.maximum(value, np.minimum(y0, y1)), np.maximum(y0, y1))


def _monotone_slope(left_delta: np.ndarray, right_delta: np.ndarray) -> np.ndarray:
    same_sign = (left_delta > 0.0) & (right_delta > 0.0)
    harmonic = np.divide(
        2.0 * left_delta * right_delta,
        left_delta + right_delta,
        out=np.zeros_like(left_delta, dtype=np.float32),
        where=(left_delta + right_delta) != 0.0,
    )
    return np.where(same_sign, harmonic, 0.0)


def _monotone_cubic_read_shifted(
    cdf: np.ndarray,
    read_offset: float,
    *,
    output_width: Optional[int] = None,
) -> np.ndarray:
    """Monotone-cubic Hermite read at age = τ + read_offset for every τ.

    Returns ``(rows, W)`` shifted values bit-identical to looping
    ``_monotone_cubic_read(cdf, τ + read_offset)`` for τ in
    ``range(W)``. ``W`` defaults to ``T`` (full width); set
    ``output_width`` smaller to skip computing tail positions the caller
    will discard. The per-τ cubic Hermite read is independent across τ,
    so the scalar loop is pure call overhead — collapsing to one batched
    pass cuts cost from ``W × per-call`` to ``one × per-batch``.

    Boundary behaviour mirrors ``_monotone_cubic_read``:
      - ``age < 0`` (only possible if ``read_offset < 0``)         → 0
      - ``age == 0`` (only possible if ``read_offset == 0``, τ=0)  → cdf[:, 0]
      - ``age >= T - 1`` (clamps the tail)                          → cdf[:, -1]
      - interior τ                                                  → cubic Hermite

    The clamp-at-tail branch fires only at τ = T − 1 when ``W == T``.
    For ``W < T`` every output position uses cubic Hermite because the
    cumulative carries data past the requested output range; the cubic
    stencil reads ``cdf[τ + 2]`` correctly without falling off the end.
    """
    rows, T = cdf.shape
    W = T if output_width is None else min(int(output_width), T)
    if W <= 0:
        return np.empty((rows, 0), dtype=np.float32)
    if T <= 1:
        return np.broadcast_to(cdf[:, -1:], (rows, W)).copy()

    h = float(read_offset)
    if h == 0.0:
        # Endpoint read: at age = τ the cubic Hermite formula reduces
        # algebraically to ``b00 * y0 + 0 * (rest) = y0 = cdf[:, τ]``.
        # The original scalar path took the ``age == 0 → cdf[:, 0]`` and
        # ``age >= max_idx → cdf[:, -1]`` branches; interior τ at h=0
        # collapsed to y0. ``cdf[:, :W]`` reproduces all three: the
        # asymptote at τ=T-1 is ``cdf[:, T-1]`` either way (clamp or
        # cubic-with-h=0 both yield the same column). Skipping the cubic
        # compute removes ~50% of CPU on cohort runs whose carrier or
        # subject primitives use ``POINT_AT_ENDPOINT`` basis.
        return cdf[:, :W].copy()
    if h < 0.0:
        # τ=0 would hit the original ``age < 0`` zero branch — refuse
        # rather than silently degrade. Not used by current callers.
        raise ValueError(
            f"_monotone_cubic_read_shifted requires read_offset >= 0; got {h!r}"
        )

    # Number of output positions computed via cubic. When W == T the last
    # column is clamped (matches the original ``age >= max_idx`` branch);
    # for W < T every output position uses cubic because the cumulative
    # carries the boundary neighbours past the output range.
    if W == T:
        cubic_count = T - 1
    else:
        cubic_count = W

    if cubic_count == 0:
        # W == 1 and T == 1: handled above; W == T == 1 too. Reach here
        # only when W == T == 1, which the T <= 1 short-circuit caught.
        shifted = np.empty((rows, W), dtype=np.float32)
        shifted[:, -1] = cdf[:, -1]
        return shifted

    # Build per-τ slices for τ ∈ [0, cubic_count − 1]:
    #   y0[τ]      = cdf[:, τ]
    #   y1[τ]      = cdf[:, τ + 1]            (needs cdf index up to cubic_count)
    #   y_prev[τ]  = cdf[:, τ - 1] for τ ≥ 1, else 0       (zero-pad at τ=0)
    #   y_next2[τ] = cdf[:, τ + 2] when τ + 2 ≤ T − 1,
    #                 else cdf[:, -1]                        (right-edge clamp)
    y0 = cdf[:, :cubic_count]
    y1 = cdf[:, 1:cubic_count + 1]

    y_prev = np.empty_like(y0)
    y_prev[:, 0] = 0.0
    if cubic_count > 1:
        y_prev[:, 1:] = cdf[:, :cubic_count - 1]
    d_prev = y0 - y_prev

    d0 = y1 - y0

    y_next2 = np.empty_like(y0)
    # τ + 2 ∈ [2, cubic_count + 1]. Indices within ``cdf`` of width T are
    # valid up to T − 1, so ``τ + 2`` requires ``τ ≤ T − 3``. Above that
    # clamp to ``cdf[:, -1]``.
    safe_count = min(cubic_count, T - 2)
    if safe_count > 0:
        y_next2[:, :safe_count] = cdf[:, 2:safe_count + 2]
    if safe_count < cubic_count:
        y_next2[:, safe_count:] = cdf[:, -1:]
    d_next = y_next2 - y1

    m0 = _monotone_slope(d_prev, d0)
    m1 = _monotone_slope(d0, d_next)

    h2 = h * h
    h3 = h2 * h
    b00 = 2.0 * h3 - 3.0 * h2 + 1.0
    b10 = h3 - 2.0 * h2 + h
    b01 = -2.0 * h3 + 3.0 * h2
    b11 = h3 - h2

    value = b00 * y0 + b10 * m0 + b01 * y1 + b11 * m1
    lo = np.minimum(y0, y1)
    hi = np.maximum(y0, y1)
    value = np.minimum(np.maximum(value, lo), hi)

    shifted = np.empty((rows, W), dtype=np.float32)
    shifted[:, :cubic_count] = value
    if W == T:
        # Clamp τ = T − 1 to the cumulative asymptote — preserves the
        # original boundary behaviour and keeps row_sum(diff) = cdf[:, -1]
        # so callers that scale to the asymptote remain bit-identical.
        shifted[:, -1] = cdf[:, -1]
    return shifted


def cumulative_empirical_rate_to_transition(
    name: str,
    cumulative_rate: Sequence[float] | np.ndarray,
    *,
    family: str = "empirical",
    read_offset: float = 0.5,
    interpolation: str = "monotone_cubic",
    output_width: Optional[int] = None,
) -> BucketTransition:
    """Convert cumulative empirical rates to bucket transition mass."""

    return cdf_to_bucket_transition(
        name,
        cumulative_rate,
        family=family,
        read_offset=read_offset,
        interpolation=interpolation,
        output_width=output_width,
    )


def cumulative_empirical_rate_to_transition_for_basis(
    name: str,
    cumulative_rate: Sequence[float] | np.ndarray,
    *,
    source_basis: BucketSourceBasis,
    family: str = "empirical",
    interpolation: str = "monotone_cubic",
    output_width: Optional[int] = None,
) -> BucketTransition:
    """Convert empirical cumulative rates using the source mass basis."""

    return cumulative_empirical_rate_to_transition(
        name,
        cumulative_rate,
        family=family,
        read_offset=empirical_read_offset_for_basis(source_basis),
        interpolation=interpolation,
        output_width=output_width,
    )


def dirac_transition(
    name: str,
    *,
    lag: int,
    probability: float = 1.0,
    family: str,
) -> BucketTransition:
    """Construct an exact degenerate transition at integer lag."""

    value = np.zeros((1, int(lag) + 1), dtype=np.float32)
    value[0, int(lag)] = float(probability)
    return BucketTransition(name=name, value=value, family=family)


def to_span_operator(transition: BucketTransition) -> SpanOperator:
    """Adapt a bucket transition to the existing span readout operator."""

    return SpanOperator(
        name=transition.name,
        value=np.asarray(transition.value, dtype=np.float32),
        family=transition.family,
    )
