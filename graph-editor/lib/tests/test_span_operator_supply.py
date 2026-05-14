"""Tests for production span draw operator supply."""

from __future__ import annotations

import numpy as np

from runner.span_operator_supply import (
    PrimitiveDrawSurface,
    draw_model_primitive_operators,
)


def test_latent_draw_primitive_compiles_one_operator_per_draw():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.2, 0.5]),
            conditional_cdf_draws=np.asarray([[0.0, 1.0], [0.0, 0.5]]),
        )
    )
    assert len(operators) == 2
    np.testing.assert_allclose(operators[0].value[0, 1], 0.2)
    np.testing.assert_allclose(operators[1].value[0, 1], 0.25)


def test_deterministic_draw_primitive_compiles_shifted_delta():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.2, 0.5]),
            timing_family="deterministic",
            deterministic_shift_days=2,
        )
    )
    assert len(operators) == 2
    np.testing.assert_array_equal(operators[0].value, np.array([[0.0, 0.0, 0.2]]))
    np.testing.assert_array_equal(operators[1].value, np.array([[0.0, 0.0, 0.5]]))


def test_nonlatent_draw_primitive_is_delta_zero():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface("A-B", p_draws=np.asarray([0.2, 0.5]), timing_family="non_latent")
    )
    assert len(operators) == 2
    np.testing.assert_array_equal(operators[0].value, np.array([[0.2]]))
    np.testing.assert_array_equal(operators[1].value, np.array([[0.5]]))

