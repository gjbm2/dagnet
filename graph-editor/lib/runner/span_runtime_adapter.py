"""Adapter from live-runtime model shapes to production span modules.

The adapter normalises already-resolved runtime objects into
``span_operator_supply`` surfaces and provides thin evaluation entry points.
It is a perimeter layer: it may inspect object shape and refuse incomplete
inputs, while the span core remains pure algebra.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from .span_operator_supply import (
    PrimitiveDrawSurface,
    PrimitiveModelSurface,
    model_primitive_operator,
)
from .span_readout import PrefixSurface, SpanOperator, evaluate_span_readout


class RuntimeModelAdapterError(ValueError):
    """Typed perimeter refusal for incomplete runtime model surfaces."""


def _require(value, name: str):
    if value is None:
        raise RuntimeModelAdapterError(f"{name} is required")
    return value


@dataclass(frozen=True)
class RuntimeTopologyEdge:
    edge_id: str
    from_node: str
    to_node: str


@dataclass(frozen=True)
class RuntimeRootMass:
    cohort_ids: tuple[str, ...]
    root_days: np.ndarray
    root_counts: np.ndarray
    root_support: np.ndarray


def topology_edge_ids(ordered_edges: Sequence[RuntimeTopologyEdge]) -> tuple[str, ...]:
    return tuple(edge.edge_id for edge in ordered_edges)


def topology_edges_from_provenance(edges: Sequence[Mapping[str, object]]) -> tuple[RuntimeTopologyEdge, ...]:
    return tuple(
        RuntimeTopologyEdge(str(edge["edge_id"]), str(edge["from"]), str(edge["to"]))
        for edge in edges
    )


def days_for_root_tau(root_days, max_tau: int, carrier_horizon: int = 0) -> int:
    return int(
        np.max(np.asarray(root_days, dtype=int))
        + int(carrier_horizon)
        + int(max_tau)
        + 1
    )


def resolved_model(edge_id: str, src) -> PrimitiveModelSurface:
    """Normalise a dict- or attribute-shaped resolved model surface."""
    get = src.get if isinstance(src, dict) else lambda key, default=None: getattr(src, key, default)
    return PrimitiveModelSurface(
        edge_id=edge_id,
        p=float(get("p")),
        conditional_cdf=np.asarray(get("conditional_cdf"), dtype=float),
        timing_family=str(get("timing_family")),
        deterministic_shift_days=int(get("deterministic_shift_days", 0)),
    )


def resolved_model_from_conditioned_primitive(primitive, *, draws: bool = False):
    """Normalise a ``ConditionedTransitionPrimitive``-shaped object."""
    _require(primitive.probability_posterior, "probability_posterior")
    timing = _require(primitive.timing_posterior, "timing_posterior")
    family = str(primitive.timing_family.value)
    edge_id = str(primitive.transition.edge_id)
    shift = int(getattr(timing, "deterministic_shift_days", 0) or 0)
    if draws:
        return PrimitiveDrawSurface(
            edge_id=edge_id,
            p_draws=np.asarray(primitive.probability_posterior.draws, dtype=float),
            conditional_cdf_draws=np.asarray(primitive.timing_draws(), dtype=float),
            timing_family=family,
            deterministic_shift_days=shift,
        )

    cdf = np.asarray(timing.cdf_mean, dtype=float) if family == "latent" else np.asarray(())
    return PrimitiveModelSurface(
        edge_id=edge_id,
        p=float(primitive.probability_posterior.mean),
        conditional_cdf=cdf,
        timing_family=family,
        deterministic_shift_days=shift,
    )


def evaluate_with_operators(
    *,
    root_mass: RuntimeRootMass,
    operators: Sequence[SpanOperator],
    days: int,
    max_tau: int,
) -> PrefixSurface:
    """Lower-level entry: caller has already compiled operators."""
    return evaluate_span_readout(
        cohort_ids=root_mass.cohort_ids,
        root_days=root_mass.root_days,
        root_counts=root_mass.root_counts,
        root_supports=root_mass.root_support,
        operators=operators,
        days=days,
        max_tau=max_tau,
    )


def evaluate_model_span(
    *,
    ordered_edges: Sequence[RuntimeTopologyEdge],
    model_by_edge_id: Mapping[str, PrimitiveModelSurface],
    root_mass: RuntimeRootMass,
    days: int,
    max_tau: int,
) -> PrefixSurface:
    operators = tuple(
        model_primitive_operator(model_by_edge_id[edge.edge_id], days=days)
        for edge in ordered_edges
    )
    return evaluate_with_operators(
        root_mass=root_mass,
        operators=operators,
        days=days,
        max_tau=max_tau,
    )


def evaluate_window_model_span(
    *,
    subject_edges: Sequence[RuntimeTopologyEdge],
    model_by_edge_id: Mapping[str, PrimitiveModelSurface],
    root_mass: RuntimeRootMass,
    days: int,
    max_tau: int,
) -> PrefixSurface:
    return evaluate_model_span(
        ordered_edges=subject_edges,
        model_by_edge_id=model_by_edge_id,
        root_mass=root_mass,
        days=days,
        max_tau=max_tau,
    )


def evaluate_active_model_span(
    *,
    carrier_edges: Sequence[RuntimeTopologyEdge],
    subject_edges: Sequence[RuntimeTopologyEdge],
    model_by_edge_id: Mapping[str, PrimitiveModelSurface],
    root_mass: RuntimeRootMass,
    days: int,
    max_tau: int,
) -> PrefixSurface:
    return evaluate_model_span(
        ordered_edges=tuple(carrier_edges) + tuple(subject_edges),
        model_by_edge_id=model_by_edge_id,
        root_mass=root_mass,
        days=days,
        max_tau=max_tau,
    )
