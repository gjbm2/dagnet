"""Small NumPy/stdlib statistical helpers for graph-editor runtime.

The Vercel production dependency set deliberately excludes heavy scientific
packages. Runtime code under `graph-editor` should use this module for the
small special-function surface it needs.
"""

from __future__ import annotations

import math
from typing import Callable, Tuple, TypeVar

import numpy as np


_T = TypeVar("_T")


def curvature_corrected_interp(
    lookup: Callable[[int], _T],
    fractional_index: float,
) -> _T:
    """Symmetric 4-point fractional interpolator, tuned for midpoint reads.

    Given a function ``f`` sampled at integer indices via ``lookup(k)``,
    approximate ``f(fractional_index)`` using a 4-point stencil:

        ``f(k + w) ≈ (1 − w)·f(k) + w·f(k+1)
                     − 4·w·(1−w) · (1/16) · [f(k+2) − f(k+1) − f(k) + f(k−1)]``

    where ``k = floor(fractional_index)`` and ``w = fractional_index − k``.

    The first term is linear interpolation between the two enclosing
    integer samples — a chord, which lies above a convex curve and
    below a concave curve. The second is a symmetric Newton-Cotes-style
    second-difference correction that removes the chord's curvature
    bias.

    The coefficient ``1/16`` makes the stencil **exact for arbitrary
    quadratics at any** ``w ∈ [0, 1]``, and additionally **exact for
    cubics at the midpoint** ``w = 0.5`` (where the cubic error term
    vanishes by symmetry). At the midpoint the stencil collapses to the
    cubic Lagrange weights ``(−1/16, 9/16, 9/16, −1/16)`` on
    ``(f(k−1), f(k), f(k+1), f(k+2))``. Off-midpoint the outer weights
    remain symmetric, so this is not the true cubic Lagrange interpolant
    for arbitrary ``w``; the leading off-midpoint residual is
    ``O(w(1−w)(2w−1)·f‴)``, which vanishes at ``w ∈ {0, 0.5, 1}``.

    The ramp ``4·w·(1−w)`` peaks at the midpoint and vanishes at the
    endpoints, so integer-aligned reads (``w == 0`` or ``w == 1``)
    collapse to ``f(k)`` or ``f(k+1)`` exactly and inherit no
    correction.

    Live callers in this codebase evaluate at integer ages
    (root δ-seed, ``w == 0``) or at bucket midpoints (propagated mass,
    ``w == 0.5``); both are tightly handled. If a future caller reads
    at a quarter-point or other off-midpoint location, the result is
    still quadratic-exact but no longer cubic-exact — verify the
    accuracy budget at that call site, or use a true cubic Lagrange
    interpolant.

    Applies to any sigmoid-shaped curve interpolated at integer
    samples — CDF tables, cumulative empirical rates, completeness
    curves. ``lookup`` must handle out-of-range integers gracefully
    (the stencil reads ``k - 1`` and ``k + 2``); typical implementations
    return zero below the support and clamp to the saturation value
    above.

    Returns the same type ``lookup`` returns; both ``float`` and
    ``np.ndarray`` work because the arithmetic is broadcast-safe.
    """
    floor_k = int(fractional_index)
    frac = fractional_index - floor_k
    f_lo = lookup(floor_k)
    f_hi = lookup(floor_k + 1)
    linear = (1.0 - frac) * f_lo + frac * f_hi
    f_outer_lo = lookup(floor_k - 1)
    f_outer_hi = lookup(floor_k + 2)
    second_diff = (f_outer_hi - f_hi) - (f_lo - f_outer_lo)
    ramp = 4.0 * frac * (1.0 - frac)
    return linear - ramp * (1.0 / 16.0) * second_diff


def normal_cdf(z):
    """Vectorised standard normal CDF."""
    z_arr = np.asarray(z, dtype=np.float64)
    x = z_arr / np.sqrt(2.0)
    a1, a2, a3, a4, a5 = (
        0.254829592,
        -0.284496736,
        1.421413741,
        -1.453152027,
        1.061405429,
    )
    p = 0.3275911
    x_abs = np.abs(x)
    t = 1.0 / (1.0 + p * x_abs)
    erf_approx = (
        1.0
        - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1)
        * t
        * np.exp(-(x_abs ** 2))
    )
    result = 0.5 * (1.0 + np.sign(x) * erf_approx)
    return float(result) if np.isscalar(z) else result


def logit(p):
    p_arr = np.asarray(p, dtype=np.float64)
    clipped = np.clip(p_arr, 1e-15, 1.0 - 1e-15)
    result = np.log(clipped / (1.0 - clipped))
    return float(result) if np.isscalar(p) else result


def expit(x):
    x_arr = np.asarray(x, dtype=np.float64)
    result = np.empty_like(x_arr, dtype=np.float64)
    positive = x_arr >= 0
    result[positive] = 1.0 / (1.0 + np.exp(-x_arr[positive]))
    exp_x = np.exp(x_arr[~positive])
    result[~positive] = exp_x / (1.0 + exp_x)
    return float(result) if np.isscalar(x) else result


def beta_ppf(q: float, alpha: float, beta: float) -> float:
    """Inverse CDF for Beta(alpha, beta) via monotone bisection."""
    q_f = float(q)
    a = float(alpha)
    b = float(beta)
    if not 0.0 <= q_f <= 1.0:
        raise ValueError("q must be in [0, 1]")
    if a <= 0.0 or b <= 0.0:
        raise ValueError("beta parameters must be positive")
    if q_f == 0.0:
        return 0.0
    if q_f == 1.0:
        return 1.0
    lo = 0.0
    hi = 1.0
    for _ in range(90):
        mid = 0.5 * (lo + hi)
        if regularized_incomplete_beta(mid, a, b) < q_f:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def beta_interval(level: float, alpha: float, beta: float) -> Tuple[float, float]:
    tail = (1.0 - float(level)) / 2.0
    return (
        beta_ppf(tail, alpha, beta),
        beta_ppf(1.0 - tail, alpha, beta),
    )


def regularized_incomplete_beta(x: float, alpha: float, beta: float) -> float:
    """Regularized incomplete beta I_x(alpha,beta)."""
    x_f = float(x)
    a = float(alpha)
    b = float(beta)
    if a <= 0.0 or b <= 0.0:
        raise ValueError("beta parameters must be positive")
    if x_f <= 0.0:
        return 0.0
    if x_f >= 1.0:
        return 1.0
    log_bt = (
        math.lgamma(a + b)
        - math.lgamma(a)
        - math.lgamma(b)
        + a * math.log(x_f)
        + b * math.log1p(-x_f)
    )
    bt = math.exp(log_bt)
    if x_f < (a + 1.0) / (a + b + 2.0):
        return bt * _beta_continued_fraction(a, b, x_f) / a
    return 1.0 - bt * _beta_continued_fraction(b, a, 1.0 - x_f) / b


def _beta_continued_fraction(a: float, b: float, x: float) -> float:
    max_iter = 200
    eps = 3e-14
    fpmin = 1e-300
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h
