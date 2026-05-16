"""Small NumPy/stdlib statistical helpers for graph-editor runtime.

The Vercel production dependency set deliberately excludes heavy scientific
packages. Runtime code under `graph-editor` should use this module for the
small special-function surface it needs.
"""

from __future__ import annotations

import math
from typing import Tuple

import numpy as np


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
