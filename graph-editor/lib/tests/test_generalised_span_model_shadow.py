"""Generalised span model-shadow engine tests."""

import os
import sys
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_shadow_engine_evaluates_carrier_subject_and_request_plans():
    from runner.generalised_span_model_shadow import build_generalised_span_model_shadow

    plans = _active_plans()
    shadow = build_generalised_span_model_shadow(plans=plans, max_tau=6)

    assert shadow["spans"]["carrier"]["operator_count"] == 1
    assert shadow["spans"]["subject"]["operator_count"] == 1
    assert shadow["spans"]["request"]["operator_count"] == 2
    assert shadow["spans"]["carrier"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["subject"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["request"]["value_max_abs_diff"] < 1e-12


def test_shadow_engine_treats_identity_as_empty_operator_plan():
    from runner.generalised_span_model_shadow import build_generalised_span_model_shadow

    plans = _identity_plans()
    shadow = build_generalised_span_model_shadow(plans=plans, max_tau=6)

    assert shadow["spans"]["carrier"]["operator_count"] == 0
    assert shadow["spans"]["request"]["operator_count"] == 1
    assert shadow["spans"]["carrier"]["candidate_value_tail"] == (
        1.0, 1.0, 1.0, 1.0, 1.0,
    )
    assert shadow["spans"]["carrier"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["request"]["value_max_abs_diff"] < 1e-12


def test_shadow_engine_evaluates_evidence_rate_operators():
    from runner.generalised_span_model_shadow import (
        SpanShadowPlan,
        build_generalised_span_model_shadow,
    )

    root_count = 100.0
    first = _operator("observed-A-B", (0.0, 0.3, 0.2))
    second = _operator("observed-B-C", (0.0, 0.5))
    plans = (
        SpanShadowPlan(
            label="single_hop_evidence",
            root_day=0,
            root_value=root_count,
            root_support=1.0,
            ordered_operators=(first,),
            expected_value_curve=np.asarray([0.0, 30.0, 50.0, 50.0, 50.0, 50.0, 50.0]),
            expected_support_curve=np.asarray([0.0, 0.3, 0.5, 0.5, 0.5, 0.5, 0.5]),
            metadata={"source": "observed_evidence"},
        ),
        SpanShadowPlan(
            label="multi_hop_evidence",
            root_day=0,
            root_value=root_count,
            root_support=1.0,
            ordered_operators=(first, second),
            expected_value_curve=np.asarray([0.0, 0.0, 15.0, 25.0, 25.0, 25.0, 25.0]),
            expected_support_curve=np.asarray([0.0, 0.0, 0.15, 0.25, 0.25, 0.25, 0.25]),
            metadata={"source": "observed_evidence"},
        ),
        SpanShadowPlan(
            label="covered_zero_evidence",
            root_day=0,
            root_value=root_count,
            root_support=1.0,
            ordered_operators=(
                _operator(
                    "covered-zero",
                    (0.0, 0.0),
                    support_increments=(0.0, 1.0),
                ),
            ),
            expected_value_curve=np.asarray([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            expected_support_curve=np.asarray([0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
            metadata={"source": "observed_evidence"},
        ),
    )

    shadow = build_generalised_span_model_shadow(plans=plans, max_tau=6)

    assert shadow["spans"]["single_hop_evidence"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["multi_hop_evidence"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["covered_zero_evidence"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["covered_zero_evidence"]["support_max_abs_diff"] < 1e-12
    assert shadow["spans"]["single_hop_evidence"]["metadata"]["source"] == "observed_evidence"


def test_shadow_engine_matches_promoted_core_for_saturating_support():
    from runner.generalised_span_model_shadow import (
        SpanShadowPlan,
        build_generalised_span_model_shadow,
    )

    from runner.span_readout import (  # pylint: disable=import-outside-toplevel
        SpanOperator as PromotedOperator,
        evaluate_span_readout,
    )

    from runner.generalised_span_model_shadow import (
        _per_source_kernel_from_forward_matrix,
    )

    op = _operator(
        "support-saturates",
        (0.0, 0.5, 0.25),
        support_increments=(0.0, 0.8, 0.8),
    )
    promoted_surface = evaluate_span_readout(
        cohort_ids=("c0",),
        root_days=np.asarray([0], dtype=int),
        root_counts=np.asarray([1.0], dtype=float),
        root_supports=np.asarray([1.0], dtype=float),
        operators=(
            PromotedOperator(
                name=op.name,
                value=_per_source_kernel_from_forward_matrix(op.value),
                support=_per_source_kernel_from_forward_matrix(op.support),
                family="test",
            ),
        ),
        days=7,
        max_tau=6,
    )
    plan = SpanShadowPlan(
        label="promoted_core_parity",
        root_day=0,
        root_value=1.0,
        root_support=1.0,
        ordered_operators=(op,),
        expected_value_curve=promoted_surface.value_by_cohort_tau[0],
        expected_support_curve=promoted_surface.coverage_by_cohort_tau[0],
        metadata={"source": "promoted_core"},
    )

    shadow = build_generalised_span_model_shadow(plans=(plan,), max_tau=6)

    assert shadow["spans"]["promoted_core_parity"]["value_max_abs_diff"] < 1e-12
    assert shadow["spans"]["promoted_core_parity"]["support_max_abs_diff"] < 1e-12
    # Engine no longer caps support at 1.0; cumulative coverage exceeds 1.0
    # when support kernels overlap. Caller-side cap is now caller's job.
    np.testing.assert_allclose(promoted_surface.coverage_by_cohort_tau[0, 2], 1.6)


def test_runtime_provenance_shadow_requires_exact_plans_when_diagnostics_are_on():
    from runner.cohort_forecast_v3 import (
        _runtime_provenance_with_generalised_span_shadow,
    )

    runtime = _runtime_with_exact_shadow_inputs()
    without_diagnostics = _runtime_provenance_with_generalised_span_shadow(
        runtime,
        max_tau=6,
        emit_diagnostics=False,
    )
    with_diagnostics = _runtime_provenance_with_generalised_span_shadow(
        runtime,
        max_tau=6,
        emit_diagnostics=True,
    )

    assert "generalised_span_model_shadow" not in without_diagnostics
    assert "spans" in with_diagnostics["generalised_span_model_shadow"]


def _active_plans():
    from runner.generalised_span_model_shadow import SpanShadowPlan

    carrier = _operator("A-B", (0.0, 0.5))
    subject = _operator("B-C", (0.0, 0.2, 0.2))
    return (
        SpanShadowPlan(
            label="carrier",
            root_day=0,
            root_value=1.0,
            root_support=1.0,
            ordered_operators=(carrier,),
            expected_value_curve=np.asarray([0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
            expected_support_curve=np.asarray([0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
            metadata={"role": "carrier"},
        ),
        SpanShadowPlan(
            label="subject",
            root_day=0,
            root_value=1.0,
            root_support=1.0,
            ordered_operators=(subject,),
            expected_value_curve=np.asarray([0.0, 0.2, 0.4, 0.4, 0.4, 0.4, 0.4]),
            expected_support_curve=np.asarray([0.0, 0.2, 0.4, 0.4, 0.4, 0.4, 0.4]),
            metadata={"role": "subject"},
        ),
        SpanShadowPlan(
            label="request",
            root_day=0,
            root_value=1.0,
            root_support=1.0,
            ordered_operators=(carrier, subject),
            expected_value_curve=np.asarray([0.0, 0.0, 0.1, 0.2, 0.2, 0.2, 0.2]),
            expected_support_curve=np.asarray([0.0, 0.0, 0.1, 0.2, 0.2, 0.2, 0.2]),
            metadata={"role": "request"},
        ),
    )


def _identity_plans():
    from runner.generalised_span_model_shadow import SpanShadowPlan

    subject = _operator("X-Y", (0.0, 0.2, 0.2))
    return (
        SpanShadowPlan(
            label="carrier",
            root_day=0,
            root_value=1.0,
            root_support=1.0,
            ordered_operators=(),
            expected_value_curve=np.asarray([1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
            expected_support_curve=np.asarray([1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
            metadata={"role": "carrier"},
        ),
        SpanShadowPlan(
            label="subject",
            root_day=0,
            root_value=1.0,
            root_support=1.0,
            ordered_operators=(subject,),
            expected_value_curve=np.asarray([0.0, 0.2, 0.4, 0.4, 0.4, 0.4, 0.4]),
            expected_support_curve=np.asarray([0.0, 0.2, 0.4, 0.4, 0.4, 0.4, 0.4]),
            metadata={"role": "subject"},
        ),
        SpanShadowPlan(
            label="request",
            root_day=0,
            root_value=1.0,
            root_support=1.0,
            ordered_operators=(subject,),
            expected_value_curve=np.asarray([0.0, 0.2, 0.4, 0.4, 0.4, 0.4, 0.4]),
            expected_support_curve=np.asarray([0.0, 0.2, 0.4, 0.4, 0.4, 0.4, 0.4]),
            metadata={"role": "request"},
        ),
    )


def _operator(name, increments, *, support_increments=None):
    from runner.generalised_span_model_shadow import SpanShadowOperator

    increments_arr = np.asarray(increments, dtype=float)
    support_arr = np.asarray(
        increments if support_increments is None else support_increments,
        dtype=float,
    )
    days = 7
    source = np.arange(days)[:, None]
    lag = np.arange(increments_arr.shape[0])[None, :]
    dest = source + lag
    value = np.zeros((days, days), dtype=float)
    support = np.zeros((days, days), dtype=float)
    np.add.at(
        value,
        (
            np.broadcast_to(source, dest.shape)[dest < days],
            dest[dest < days],
        ),
        np.broadcast_to(increments_arr, dest.shape)[dest < days],
    )
    np.add.at(
        support,
        (
            np.broadcast_to(source, dest.shape)[dest < days],
            dest[dest < days],
        ),
        np.broadcast_to(support_arr, dest.shape)[dest < days],
    )
    return SpanShadowOperator(name=name, value=value, support=support)


def _runtime_with_exact_shadow_inputs():
    transition_ab = SimpleNamespace(edge_id="A-B", source_node="A", destination_node="B")
    transition_bc = SimpleNamespace(edge_id="B-C", source_node="B", destination_node="C")
    primitive_ab = SimpleNamespace(
        transition=transition_ab,
        probability_draws=lambda: np.asarray([0.5, 0.5]),
        timing_draws=lambda: np.asarray([[0.0, 1.0], [0.0, 1.0]]),
    )
    primitive_bc = SimpleNamespace(
        transition=transition_bc,
        probability_draws=lambda: np.asarray([0.4, 0.4]),
        timing_draws=lambda: np.asarray([
            [0.0, 0.5, 1.0],
            [0.0, 0.5, 1.0],
        ]),
    )
    return SimpleNamespace(
        project_runtime_provenance=lambda: {"diagnostics": {"owner": "test"}},
        generalised_span_shadow_carrier_resolutions=(
            SimpleNamespace(transition=transition_ab),
        ),
        generalised_span_shadow_subject_resolutions=(
            SimpleNamespace(transition=transition_bc),
        ),
        conditioned_primitive_map={
            "carrier": primitive_ab,
            "subject": primitive_bc,
        },
        composed_carrier=SimpleNamespace(
            span_p_mean=0.5,
            cdf_mean=np.asarray([0.0, 1.0]),
        ),
        composed_subject=SimpleNamespace(
            span_p_mean=0.4,
            cdf_mean=np.asarray([0.0, 0.5, 1.0]),
        ),
    )
