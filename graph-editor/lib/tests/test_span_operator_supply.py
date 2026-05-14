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


# ─── Stage C — 3-stream kernels (value / support / exposure) ─────────


def test_latent_unit_mask_support_equals_value_and_exposure_is_pmf():
    """Phase 6 §4.8 under unit mask: support = value × 1 = value, and
    exposure = exposure_shape × 1 = Δcdf (the normalised PMF, no edge
    probability multiplier)."""
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.4]),
            conditional_cdf_draws=np.asarray([[0.0, 0.6, 1.0]]),
        )
    )
    op = operators[0]
    # value = p × Δcdf
    np.testing.assert_allclose(op.value[0], np.asarray([0.0, 0.24, 0.16]))
    # support = value × 1 (under unit mask)
    np.testing.assert_allclose(op.support[0], op.value[0])
    # exposure = Δcdf × 1 (PMF without p factor; sums to 1)
    np.testing.assert_allclose(op.exposure[0], np.asarray([0.0, 0.6, 0.4]))
    assert float(op.exposure[0].sum()) == 1.0


def test_latent_explicit_mask_zeros_out_support_and_exposure_at_absent_cells():
    """An absent cell (mask=0) zeros that cell in both support and
    exposure while value remains unaffected — the algebraic distinction
    that lets terminal value > 0 with terminal support = 0 mean
    'propagated mass reached the wavefront only through absent cells'.
    """
    mask = np.asarray([[1.0, 0.0, 1.0]])
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.5]),
            conditional_cdf_draws=np.asarray([[0.0, 0.6, 1.0]]),
            value_observation_mask_draws=mask,
        )
    )
    op = operators[0]
    np.testing.assert_allclose(op.value[0], np.asarray([0.0, 0.30, 0.20]))
    # mask zeros cell 1 in both support and exposure; cell 2 stays.
    np.testing.assert_allclose(op.support[0], np.asarray([0.0, 0.0, 0.20]))
    np.testing.assert_allclose(op.exposure[0], np.asarray([0.0, 0.0, 0.40]))


def test_nonlatent_unit_mask_exposes_unit_shape():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface("A-B", p_draws=np.asarray([0.3]), timing_family="non_latent")
    )
    op = operators[0]
    np.testing.assert_array_equal(op.value, np.array([[0.3]]))
    np.testing.assert_array_equal(op.support, np.array([[0.3]]))
    np.testing.assert_array_equal(op.exposure, np.array([[1.0]]))


def test_deterministic_unit_mask_places_exposure_unit_shape_at_shift():
    operators = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B",
            p_draws=np.asarray([0.4]),
            timing_family="deterministic",
            deterministic_shift_days=2,
        )
    )
    op = operators[0]
    np.testing.assert_array_equal(op.value, np.array([[0.0, 0.0, 0.4]]))
    np.testing.assert_array_equal(op.support, np.array([[0.0, 0.0, 0.4]]))
    # Exposure carries unit mass at the shift cell — independent of p.
    np.testing.assert_array_equal(op.exposure, np.array([[0.0, 0.0, 1.0]]))

