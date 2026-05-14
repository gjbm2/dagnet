"""Diagnostic helpers for shadowing candidate model curves against production.

Off the evaluation path: consumes a ``PrefixSurface`` and a production-like
``composed_span`` and produces differences and edge-grid signals.
"""

from __future__ import annotations

import numpy as np

from span_readout_candidate import PrefixSurface


def candidate_curve(surface: PrefixSurface) -> np.ndarray:
    return surface.aggregate_mass_by_tau()


def compare_candidate_curve(surface: PrefixSurface, expected) -> np.ndarray:
    return candidate_curve(surface) - np.asarray(expected, dtype=float)


def _pad_cdf(cdf, length):
    return np.pad(cdf, (0, max(0, int(length) - int(cdf.shape[0]))), mode="edge")[: int(length)]


def expected_curve_from_composed_span_mean(composed, max_tau):
    return float(composed.span_p_mean) * _pad_cdf(np.asarray(composed.cdf_mean, dtype=float), int(max_tau) + 1)


def expected_curve_from_composed_span_draw(composed, draw_index, max_tau):
    p = float(np.asarray(composed.span_p_draws)[int(draw_index)])
    return p * _pad_cdf(np.asarray(composed.cdf_draws)[int(draw_index)], int(max_tau) + 1)


def carrier_horizon_from_composed_span(composed):
    return int(composed.max_tau)


def grid_edge_mass(surface: PrefixSurface) -> float:
    """Mass on the final day cell of the final value ledger; diagnostic only."""
    return float(surface.value_ledgers[-1][:, -1].sum())
