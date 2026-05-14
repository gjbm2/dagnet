"""Tests for production span operator supply."""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_operator_supply import (
    PrimitiveDrawSurface,
    PrimitiveModelSurface,
    delay_operator,
    draw_model_primitive_operators,
    evidence_operator_from_cumulative_rate,
    evidence_operator_from_nk_by_age,
    identity_operator,
    model_operator_from_cdf,
    model_primitive_operator,
    operators_for_path,
    source_day_specific_evidence_operator,
)
from runner.span_readout import evaluate_span_readout


def run(
    operators,
    *,
    root_counts=(100.0,),
    cohort_ids=("C0",),
    root_days=(0,),
    root_supports=None,
    days=5,
    max_tau=3,
):
    if root_supports is None:
        root_supports = tuple(1.0 for _ in root_counts)
    return evaluate_span_readout(
        cohort_ids=cohort_ids,
        root_days=root_days,
        root_counts=root_counts,
        root_supports=root_supports,
        operators=operators,
        days=days,
        max_tau=max_tau,
    )


def test_identity_operator_passes_mass_through_unchanged():
    operator = identity_operator("I", days=4)
    np.testing.assert_array_equal(operator.value, np.array([1.0]))
    np.testing.assert_array_equal(operator.support, np.array([1.0]))
    surface = run((operator,), root_counts=(100.0,), days=4, max_tau=3)
    np.testing.assert_allclose(surface.value_by_cohort_tau[0], [100.0, 100.0, 100.0, 100.0])


def test_model_cdf_operator_splits_reach_from_timing():
    operator = model_operator_from_cdf(
        "model",
        reach=0.5,
        conditional_cdf=(0.0, 0.25, 1.0),
        days=5,
    )
    surface = run((operator,))
    np.testing.assert_allclose(surface.mass_at("C0", 0), 0.0)
    np.testing.assert_allclose(surface.mass_at("C0", 1), 12.5)
    np.testing.assert_allclose(surface.mass_at("C0", 2), 50.0)


def test_age_nk_operator_recovers_rate_attributed_single_hop():
    operator = evidence_operator_from_nk_by_age(
        "X-Y",
        n_by_age=(100.0, 100.0, 100.0),
        k_by_age=(0.0, 10.0, 25.0),
        days=5,
    )
    surface = run((operator,), root_counts=(200.0,))
    np.testing.assert_allclose(surface.mass_at("C0", 1), 20.0)
    np.testing.assert_allclose(surface.mass_at("C0", 2), 50.0)


def test_source_day_specific_nk_operator_compiles_distinct_rows():
    operator = source_day_specific_evidence_operator(
        "X-Y",
        n_by_source_age=np.asarray([[100.0, 100.0], [200.0, 200.0]]),
        k_by_source_age=np.asarray([[0.0, 10.0], [0.0, 60.0]]),
        source_days=(0, 1),
        days=5,
    )
    surface = run(
        (operator,),
        cohort_ids=("C0", "C1"),
        root_days=(0, 1),
        root_counts=(100.0, 100.0),
        max_tau=2,
    )
    np.testing.assert_allclose(surface.mass_at("C0", 1), 10.0)
    np.testing.assert_allclose(surface.mass_at("C1", 1), 30.0)


def test_supplied_operators_compose_through_core():
    first = delay_operator(
        "X-M",
        (0.0, 0.25),
        support_increments=(0.0, 1.0),
        days=6,
        family="evidence",
    )
    second = delay_operator(
        "M-Z",
        (0.0, 0.0, 0.30),
        support_increments=(0.0, 0.0, 1.0),
        days=6,
        family="evidence",
    )
    surface = run((first, second), root_counts=(200.0,), days=6, max_tau=5)
    np.testing.assert_allclose(surface.mass_at("C0", 2), 0.0)
    np.testing.assert_allclose(surface.mass_at("C0", 3), 15.0)
    np.testing.assert_allclose(surface.mass_at("C0", 5), 15.0)


def test_cumulative_rate_operator_and_nk_operator_have_same_shape():
    from_rate = evidence_operator_from_cumulative_rate(
        "rate",
        cumulative_rate_by_age=(0.0, 0.1, 0.25),
        support_by_age=(1.0, 1.0, 1.0),
        days=5,
    )
    from_nk = evidence_operator_from_nk_by_age(
        "nk",
        n_by_age=(100.0, 100.0, 100.0),
        k_by_age=(0.0, 10.0, 25.0),
        days=5,
    )
    np.testing.assert_allclose(from_rate.value, from_nk.value)


def test_latent_model_primitive_compiles_p_times_latency_increments():
    operator = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.5, conditional_cdf=(0.0, 0.25, 1.0)),
        days=5,
    )
    np.testing.assert_allclose(operator.value[1], 0.125)
    np.testing.assert_allclose(operator.value[2], 0.375)


def test_nonlatent_model_primitive_is_delta_zero():
    operator = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.3, timing_family="non_latent"),
        days=4,
    )
    np.testing.assert_array_equal(operator.value, np.array([0.3]))


def test_deterministic_model_primitive_is_delta_at_shift():
    operator = model_primitive_operator(
        PrimitiveModelSurface(
            "A-B",
            p=0.3,
            timing_family="deterministic",
            deterministic_shift_days=2,
        ),
        days=5,
    )
    np.testing.assert_array_equal(operator.value, np.array([0.0, 0.0, 0.3]))


def test_latent_draw_primitive_compiles_one_operator_per_draw():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.2, 0.5]),
            conditional_cdf_draws=np.asarray([[0.0, 1.0], [0.0, 0.5]]),
        ),
        days=4,
    )
    assert len(operators) == 2
    np.testing.assert_allclose(operators[0].value[1], 0.2)
    np.testing.assert_allclose(operators[1].value[1], 0.25)


def test_deterministic_draw_primitive_compiles_shifted_delta():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.2, 0.5]),
            timing_family="deterministic",
            deterministic_shift_days=2,
        ),
        days=5,
    )
    assert len(operators) == 2
    np.testing.assert_array_equal(operators[0].value, np.array([0.0, 0.0, 0.2]))
    np.testing.assert_array_equal(operators[1].value, np.array([0.0, 0.0, 0.5]))


def test_nonlatent_draw_primitive_is_delta_zero():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface("A-B", p_draws=np.asarray([0.2, 0.5]), timing_family="non_latent"),
        days=3,
    )
    assert len(operators) == 2
    np.testing.assert_array_equal(operators[0].value, np.array([0.2]))
    np.testing.assert_array_equal(operators[1].value, np.array([0.5]))


def test_operators_for_path_preserves_supplied_path_order():
    first = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.5, timing_family="non_latent"),
        days=3,
    )
    second = model_primitive_operator(
        PrimitiveModelSurface("B-C", p=0.25, timing_family="non_latent"),
        days=3,
    )
    operators = operators_for_path(("A-B", "B-C"), {"B-C": second, "A-B": first})
    assert tuple(operator.name for operator in operators) == ("A-B", "B-C")
