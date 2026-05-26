"""Tests for the pure production span readout core."""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_readout import SpanOperator, evaluate_span_readout


def lag_op(name, lag, fraction, *, days=8, family="evidence"):
    """Shift-invariant single-lag operator in canonical ``(1, lag+1)`` form."""
    value = np.zeros((1, lag + 1))
    value[0, lag] = fraction
    return SpanOperator(name=name, value=value, family=family)


def explicit_op(name, cells, *, days=8, family="evidence"):
    """Per-source-day operator in canonical ``(days, max_lag+1)`` form."""
    max_lag = max((d - s for s, d, _, _ in cells), default=0)
    value = np.zeros((days, max_lag + 1))
    for source_day, destination_day, fraction, coverage in cells:
        lag = destination_day - source_day
        if lag < 0 or source_day + lag >= days:
            continue
        value[source_day, lag] = fraction
    return SpanOperator(name=name, value=value, family=family)


def seed(
    masses=(1.0,),
    *,
    cohort_ids=("C0",),
    root_days=(0,),
    days=8,
    max_tau=4,
    operators=(),
    provenance=None,
):
    kwargs = dict(
        cohort_ids=tuple(cohort_ids),
        root_days=np.asarray(root_days, dtype=int),
        root_counts=np.asarray(masses, dtype=float),
        root_supports=np.asarray([float(mass > 0.0) for mass in masses], dtype=float),
        operators=tuple(operators),
        days=int(days),
        max_tau=int(max_tau),
    )
    if provenance is not None:
        kwargs["provenance"] = provenance
    return kwargs


def test_zero_edge_identity_returns_input_mass_unchanged():
    surface = evaluate_span_readout(**seed((100.0,), root_days=(3,), max_tau=3))
    assert surface.provenance["kernel_count"] == 0
    assert surface.mass_at("C0", 0) == 100.0
    assert surface.mass_at("C0", 3) == 100.0


def test_single_hop_evidence_recovers_direct_observed_k_over_n():
    surface = evaluate_span_readout(**seed((100.0,), operators=(lag_op("X-Y", 2, 0.20),)))
    assert surface.mass_at("C0", 0) == 0.0
    assert surface.mass_at("C0", 1) == 0.0
    assert surface.mass_at("C0", 2) == 20.0
    assert surface.mass_at("C0", 4) == 20.0


def test_multi_hop_evidence_pushes_selected_mass_through_local_rates():
    surface = evaluate_span_readout(
        **seed(
            (200.0,),
            operators=(
                lag_op("X-M", 5, 0.25, days=12),
                lag_op("M-Z", 2, 0.30, days=12),
            ),
            days=12,
            max_tau=10,
        )
    )
    assert surface.mass_at("C0", 6) == 0.0
    np.testing.assert_allclose(surface.mass_at("C0", 7), 15.0)
    np.testing.assert_allclose(surface.mass_at("C0", 10), 15.0)
    np.testing.assert_allclose(surface.value_ledgers[1][0, 5], 50.0)


def test_non_latent_carrier_collapses_active_cohort_to_window_seed():
    carrier = evaluate_span_readout(
        **seed(
            (120.0,),
            root_days=(3,),
            max_tau=2,
            operators=(lag_op("A-X", 0, 1.0, family="evidence_delta0"),),
        )
    )
    window = evaluate_span_readout(**seed((120.0,), root_days=(3,), max_tau=2))
    assert carrier.mass_at("C0", 0) == window.mass_at("C0", 0)
    assert carrier.mass_at("C0", 2) == window.mass_at("C0", 2)


def test_latent_carrier_legitimately_differs_from_window_over_time():
    surface = evaluate_span_readout(
        **seed(
            (100.0,),
            max_tau=5,
            operators=(
                explicit_op("A-X", ((0, 2, 0.40, 1.0), (0, 4, 0.60, 1.0))),
            ),
        )
    )
    assert surface.mass_at("C0", 0) == 0.0
    assert surface.mass_at("C0", 1) == 0.0
    np.testing.assert_allclose(surface.mass_at("C0", 2), 40.0)
    np.testing.assert_allclose(surface.mass_at("C0", 4), 100.0)


def test_model_kernel_uses_same_readout_shape_as_evidence_kernel():
    surface = evaluate_span_readout(
        **seed(
            max_tau=0,
            operators=(
                lag_op("X-M", 0, 0.5, family="model"),
                lag_op("M-Z", 0, 0.2, family="model"),
            ),
            provenance={"role": "subject_model"},
        )
    )
    np.testing.assert_allclose(surface.mass_at("C0", 0), 0.1)
    assert surface.provenance["kernel_families"] == ("model", "model")
    assert surface.provenance["role"] == "subject_model"


def test_source_day_specific_kernels_are_supplied_by_operator_boundary():
    surface = evaluate_span_readout(
        **seed(
            (100.0, 100.0),
            cohort_ids=("C0", "C1"),
            root_days=(0, 1),
            max_tau=2,
            operators=(explicit_op("X-Y", ((0, 1, 0.10, 1.0), (1, 2, 0.30, 1.0))),),
        )
    )
    np.testing.assert_allclose(surface.mass_at("C0", 1), 10.0)
    np.testing.assert_allclose(surface.mass_at("C1", 1), 30.0)


def test_negative_operator_mass_is_not_hidden_by_the_core():
    surface = evaluate_span_readout(
        **seed(
            (100.0,),
            max_tau=0,
            operators=(explicit_op("bad", ((0, 0, -0.10, 1.0),)),),
        )
    )
    assert surface.mass_at("C0", 0) == -10.0


