"""Tests for operator supply (raw arrays + primitive surfaces)."""

from __future__ import annotations

import numpy as np

from span_readout_candidate import evaluate_span_readout
from span_operator_supply_candidate import (
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


def run(operators, *, root_counts=(100.0,), cohort_ids=("C0",), root_days=(0,),
        root_supports=None, days=5, max_tau=3):
    if root_supports is None:
        root_supports = tuple(1.0 for _ in root_counts)
    return evaluate_span_readout(
        cohort_ids=cohort_ids, root_days=root_days, root_counts=root_counts,
        root_supports=root_supports, operators=operators, days=days, max_tau=max_tau,
    )


# -- raw-array constructors --


def test_identity_operator_is_dense_identity_matrix():
    op = identity_operator("I", days=4)
    np.testing.assert_array_equal(op.value, np.eye(4))
    np.testing.assert_array_equal(op.support, np.eye(4))


def test_model_cdf_operator_splits_reach_from_timing():
    op = model_operator_from_cdf("model", reach=0.5, conditional_cdf=(0.0, 0.25, 1.0), days=5)
    s = run((op,))
    np.testing.assert_allclose(s.mass_at("C0", 0), 0.0)
    np.testing.assert_allclose(s.mass_at("C0", 1), 12.5)
    np.testing.assert_allclose(s.mass_at("C0", 2), 50.0)


def test_age_nk_operator_recovers_rate_attributed_single_hop():
    op = evidence_operator_from_nk_by_age(
        "X-Y", n_by_age=(100.0, 100.0, 100.0), k_by_age=(0.0, 10.0, 25.0), days=5,
    )
    s = run((op,), root_counts=(200.0,))
    np.testing.assert_allclose(s.mass_at("C0", 1), 20.0)
    np.testing.assert_allclose(s.mass_at("C0", 2), 50.0)


def test_source_day_specific_nk_operator_compiles_distinct_rows():
    op = source_day_specific_evidence_operator(
        "X-Y",
        n_by_source_age=np.asarray([[100.0, 100.0], [200.0, 200.0]]),
        k_by_source_age=np.asarray([[0.0, 10.0], [0.0, 60.0]]),
        source_days=(0, 1), days=5,
    )
    s = run((op,), cohort_ids=("C0", "C1"), root_days=(0, 1),
            root_counts=(100.0, 100.0), max_tau=2)
    np.testing.assert_allclose(s.mass_at("C0", 1), 10.0)
    np.testing.assert_allclose(s.mass_at("C1", 1), 30.0)


def test_supplied_operators_compose_through_core():
    first = delay_operator("X-M", (0.0, 0.25), support_increments=(0.0, 1.0), days=6, family="evidence")
    second = delay_operator("M-Z", (0.0, 0.0, 0.30), support_increments=(0.0, 0.0, 1.0), days=6, family="evidence")
    s = run((first, second), root_counts=(200.0,), days=6, max_tau=5)
    np.testing.assert_allclose(s.mass_at("C0", 2), 0.0)
    np.testing.assert_allclose(s.mass_at("C0", 3), 15.0)
    np.testing.assert_allclose(s.mass_at("C0", 5), 15.0)


def test_cumulative_rate_operator_and_nk_operator_have_same_shape():
    from_rate = evidence_operator_from_cumulative_rate(
        "rate", cumulative_rate_by_age=(0.0, 0.1, 0.25), support_by_age=(1.0, 1.0, 1.0), days=5,
    )
    from_nk = evidence_operator_from_nk_by_age(
        "nk", n_by_age=(100.0, 100.0, 100.0), k_by_age=(0.0, 10.0, 25.0), days=5,
    )
    np.testing.assert_allclose(from_rate.value, from_nk.value)


# -- primitive surfaces --


def test_latent_model_primitive_compiles_p_times_latency_increments():
    op = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.5, conditional_cdf=(0.0, 0.25, 1.0)), days=5,
    )
    np.testing.assert_allclose(op.value[0, 1], 0.125)
    np.testing.assert_allclose(op.value[0, 2], 0.375)


def test_nonlatent_model_primitive_is_delta_zero():
    op = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.3, timing_family="non_latent"), days=4,
    )
    np.testing.assert_allclose(op.value[0, 0], 0.3)
    np.testing.assert_allclose(op.value[1, 1], 0.3)
    np.testing.assert_allclose(op.value[0, 1], 0.0)


def test_deterministic_model_primitive_is_delta_at_shift():
    op = model_primitive_operator(
        PrimitiveModelSurface("A-B", p=0.3, timing_family="deterministic", deterministic_shift_days=2),
        days=5,
    )
    np.testing.assert_allclose(op.value[0, 0], 0.0)
    np.testing.assert_allclose(op.value[0, 2], 0.3)
    np.testing.assert_allclose(op.value[1, 3], 0.3)


def test_latent_draw_primitive_compiles_one_operator_per_draw():
    ops = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B", p_draws=np.asarray([0.2, 0.5]),
            conditional_cdf_draws=np.asarray([[0.0, 1.0], [0.0, 0.5]]),
        ),
        days=4,
    )
    assert len(ops) == 2
    np.testing.assert_allclose(ops[0].value[0, 1], 0.2)
    np.testing.assert_allclose(ops[1].value[0, 1], 0.25)


def test_deterministic_draw_primitive_compiles_shifted_delta():
    ops = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            "A-B", p_draws=np.asarray([0.2, 0.5]),
            timing_family="deterministic", deterministic_shift_days=2,
        ),
        days=5,
    )
    assert len(ops) == 2
    np.testing.assert_allclose(ops[0].value[0, 2], 0.2)
    np.testing.assert_allclose(ops[1].value[1, 3], 0.5)


def test_nonlatent_draw_primitive_is_delta_zero():
    ops = draw_model_primitive_operators(
        PrimitiveDrawSurface("A-B", p_draws=np.asarray([0.2, 0.5]), timing_family="non_latent"),
        days=3,
    )
    assert len(ops) == 2
    np.testing.assert_allclose(ops[0].value[0, 0], 0.2)
    np.testing.assert_allclose(ops[1].value[1, 1], 0.5)


def test_operators_for_path_preserves_supplied_path_order():
    a = model_primitive_operator(PrimitiveModelSurface("A-B", p=0.5, timing_family="non_latent"), days=3)
    b = model_primitive_operator(PrimitiveModelSurface("B-C", p=0.25, timing_family="non_latent"), days=3)
    ops = operators_for_path(("A-B", "B-C"), {"B-C": b, "A-B": a})
    assert tuple(op.name for op in ops) == ("A-B", "B-C")
