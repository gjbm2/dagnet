"""Model-only oracle tests for the production span modules."""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_operator_supply import PrimitiveModelSurface, model_primitive_operator
from runner.span_readout import evaluate_span_readout


def run_model_span(operators, *, root_count=1.0, max_tau=8):
    kernel_extent = sum(op.value.shape[0] for op in operators)
    days = max(max_tau + 1, kernel_extent + 1)
    return evaluate_span_readout(
        cohort_ids=("C0",),
        root_days=(0,),
        root_counts=(root_count,),
        root_supports=(1.0,),
        operators=tuple(operators),
        days=days,
        max_tau=max_tau,
    )


def joint_pmf(probability, cdf):
    return float(probability) * np.diff(np.asarray(cdf, dtype=float), prepend=0.0)


def cumulative_convolution(*pmfs, horizon):
    density = np.asarray([1.0])
    for pmf in pmfs:
        density = np.convolve(density, np.asarray(pmf, dtype=float))
    density = np.pad(density, (0, max(0, horizon + 1 - density.shape[0])))
    return np.cumsum(density[: horizon + 1])


def latent(edge_id, probability, cdf, *, days=8):
    return model_primitive_operator(
        PrimitiveModelSurface(edge_id, p=probability, conditional_cdf=cdf),
        days=days,
    )


def nonlatent(edge_id, probability, *, days=5):
    return model_primitive_operator(
        PrimitiveModelSurface(edge_id, p=probability, timing_family="non_latent"),
        days=days,
    )


def test_single_hop_model_equals_p_times_cdf():
    cdf = np.asarray([0.0, 0.25, 0.75, 1.0])
    probability = 0.4
    surface = run_model_span((latent("A-B", probability, cdf),), max_tau=5)
    expected = probability * np.pad(cdf, (0, 6 - cdf.shape[0]), constant_values=1.0)
    np.testing.assert_allclose(surface.value_by_cohort_tau[0], expected[:6])


def test_two_hop_instant_model_equals_product_at_tau_zero():
    surface = run_model_span((nonlatent("A-B", 0.5), nonlatent("B-C", 0.2)), max_tau=2)
    np.testing.assert_allclose(surface.value_by_cohort_tau[0], [0.1, 0.1, 0.1])


def test_two_hop_latent_model_equals_independent_convolution_oracle():
    cdf_1 = (0.0, 0.20, 1.0)
    cdf_2 = (0.0, 0.50, 1.0)
    p_1 = 0.5
    p_2 = 0.4
    surface = run_model_span(
        (latent("A-B", p_1, cdf_1), latent("B-C", p_2, cdf_2)),
        max_tau=5,
    )
    expected = cumulative_convolution(joint_pmf(p_1, cdf_1), joint_pmf(p_2, cdf_2), horizon=5)
    np.testing.assert_allclose(surface.value_by_cohort_tau[0], expected)


def test_carrier_plus_subject_is_same_ordered_operator_chain():
    surface = run_model_span(
        (
            latent("A-X", 0.6, (0.0, 1.0)),
            latent("X-Y", 0.5, (0.0, 0.25, 1.0)),
        ),
        root_count=100.0,
        max_tau=5,
    )
    expected = 100.0 * cumulative_convolution(
        joint_pmf(0.6, (0.0, 1.0)),
        joint_pmf(0.5, (0.0, 0.25, 1.0)),
        horizon=5,
    )
    np.testing.assert_allclose(surface.value_by_cohort_tau[0], expected)


def test_identity_carrier_omission_equals_window_subject_span():
    subject = latent("X-Y", 0.5, (0.0, 0.3, 1.0))
    window = run_model_span((subject,), root_count=100.0, max_tau=4)
    identity_cohort = run_model_span((subject,), root_count=100.0, max_tau=4)
    np.testing.assert_allclose(window.value_by_cohort_tau, identity_cohort.value_by_cohort_tau)


def test_nonlatent_active_carrier_with_multihop_subject_collapses_to_window_seed():
    a_u = nonlatent("A-U", 0.25, days=12)
    u_x = nonlatent("U-X", 0.40, days=12)
    x_m = latent("X-M", 0.50, (0.0, 0.2, 1.0), days=12)
    m_z = latent("M-Z", 0.30, (0.0, 0.4, 1.0), days=12)
    active = run_model_span((a_u, u_x, x_m, m_z), root_count=1000.0, max_tau=8)
    window_seed = run_model_span((x_m, m_z), root_count=1000.0 * 0.25 * 0.40, max_tau=8)
    np.testing.assert_allclose(active.value_by_cohort_tau, window_seed.value_by_cohort_tau)
