"""Operator constructors for the span readout core.

Two input kinds: raw arrays (delay kernels, CDFs, n/k rows) and primitive
surfaces (one edge's reach + timing data, mean or per-draw).  Primitive
builders dispatch on ``timing_family`` via one ``_primitive_kernels`` helper.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from span_readout_candidate import SpanOperator


# -- raw-array constructors --


def identity_operator(name: str, *, days: int, family: str = "identity") -> SpanOperator:
    eye = np.eye(days, dtype=float)
    return SpanOperator(name=name, value=eye, support=eye, family=family)


def delay_operator(name, increments, *, days, family, support_increments):
    inc = np.asarray(increments, dtype=float)
    sup = np.asarray(support_increments, dtype=float)
    source = np.arange(days)[:, None]
    dest = source + np.arange(inc.shape[0])[None, :]
    si = np.broadcast_to(source, dest.shape)
    ok = dest < days
    value = np.zeros((days, days), dtype=float)
    support = np.zeros((days, days), dtype=float)
    np.add.at(value, (si[ok], dest[ok]), np.broadcast_to(inc, dest.shape)[ok])
    np.add.at(support, (si[ok], dest[ok]), np.broadcast_to(sup, dest.shape)[ok])
    return SpanOperator(name=name, value=value, support=support, family=family)


def model_operator_from_cdf(name, *, reach, conditional_cdf, days, family="model"):
    cdf = np.asarray(conditional_cdf, dtype=float)
    inc = np.diff(cdf, prepend=0.0)
    return delay_operator(
        name, reach * inc, days=days, family=family,
        support_increments=(inc != 0.0).astype(float),
    )


def evidence_operator_from_cumulative_rate(name, *, cumulative_rate_by_age, days, family="evidence", support_by_age):
    rate = np.asarray(cumulative_rate_by_age, dtype=float)
    return delay_operator(
        name, np.diff(rate, prepend=0.0), days=days, family=family,
        support_increments=np.asarray(support_by_age, dtype=float),
    )


def evidence_operator_from_nk_by_age(name, *, n_by_age, k_by_age, days, family="evidence"):
    n = np.asarray(n_by_age, dtype=float)
    k = np.asarray(k_by_age, dtype=float)
    return evidence_operator_from_cumulative_rate(
        name, cumulative_rate_by_age=k / n, support_by_age=(n != 0.0).astype(float),
        days=days, family=family,
    )


def source_day_specific_evidence_operator(name, *, n_by_source_age, k_by_source_age, source_days,
                                          days, family="evidence_source_day_specific"):
    source = np.asarray(source_days, dtype=int)[:, None]
    dest = source + np.arange(n_by_source_age.shape[1])[None, :]
    si = np.broadcast_to(source, dest.shape)
    ok = dest < days
    inc = np.diff(k_by_source_age / n_by_source_age, axis=1, prepend=0.0)
    sup = (n_by_source_age != 0.0).astype(float)
    value = np.zeros((days, days), dtype=float)
    support = np.zeros((days, days), dtype=float)
    np.add.at(value, (si[ok], dest[ok]), inc[ok])
    np.add.at(support, (si[ok], dest[ok]), sup[ok])
    return SpanOperator(name=name, value=value, support=support, family=family)


# -- primitive surfaces --


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


def _primitive_kernels(p, cdf, family, shift):
    """One primitive edge -> (increments, support_increments) arrays."""
    if family == "non_latent":
        return np.array([float(p)]), np.array([1.0])
    if family == "deterministic":
        inc = np.zeros(int(shift) + 1, dtype=float)
        sup = np.zeros_like(inc)
        inc[int(shift)] = float(p)
        sup[int(shift)] = 1.0
        return inc, sup
    cdf_arr = np.asarray(cdf, dtype=float)
    inc = float(p) * np.diff(cdf_arr, prepend=0.0)
    return inc, np.ones_like(inc)


def model_primitive_operator(primitive: PrimitiveModelSurface, *, days: int) -> SpanOperator:
    inc, sup = _primitive_kernels(
        primitive.p, primitive.conditional_cdf,
        primitive.timing_family, primitive.deterministic_shift_days,
    )
    return delay_operator(
        primitive.edge_id, inc, support_increments=sup, days=days,
        family=f"primitive_model_{primitive.timing_family}",
    )


def draw_model_primitive_operators(primitive: PrimitiveDrawSurface, *, days: int) -> tuple[SpanOperator, ...]:
    p_draws = np.asarray(primitive.p_draws, dtype=float)
    cdfs = np.asarray(primitive.conditional_cdf_draws, dtype=float)
    has_cdf = primitive.timing_family == "latent"
    ops = []
    for i, p in enumerate(p_draws):
        inc, sup = _primitive_kernels(
            p, cdfs[i] if has_cdf else (),
            primitive.timing_family, primitive.deterministic_shift_days,
        )
        ops.append(delay_operator(
            f"{primitive.edge_id}::draw:{i}", inc, support_increments=sup, days=days,
            family=f"primitive_model_draw_{primitive.timing_family}",
        ))
    return tuple(ops)


def operators_for_path(edge_ids, operator_by_edge_id):
    return tuple(operator_by_edge_id[e] for e in edge_ids)
