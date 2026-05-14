"""Tests for the pure span readout core."""

from __future__ import annotations

import numpy as np

from span_readout_candidate import SpanOperator, evaluate_span_readout


def lag_op(name, lag, fraction, *, days=8, family="evidence"):
    v = np.zeros((days, days)); s = np.zeros((days, days))
    for u in range(days - lag):
        v[u, u + lag] = fraction
        s[u, u + lag] = 1.0
    return SpanOperator(name=name, value=v, support=s, family=family)


def explicit_op(name, cells, *, days=8, family="evidence"):
    v = np.zeros((days, days)); s = np.zeros((days, days))
    for u, d, f, c in cells:
        v[u, d] = f; s[u, d] = c
    return SpanOperator(name=name, value=v, support=s, family=family)


def seed(masses=(1.0,), *, cohort_ids=("C0",), root_days=(0,), days=8, max_tau=4,
         operators=(), provenance=None):
    return dict(
        cohort_ids=cohort_ids, root_days=root_days, root_counts=masses,
        root_supports=tuple(float(m > 0.0) for m in masses),
        operators=operators, days=days, max_tau=max_tau, provenance=provenance,
    )


def test_zero_edge_identity_returns_input_mass_unchanged():
    s = evaluate_span_readout(**seed((100.0,), root_days=(3,), max_tau=3))
    assert s.provenance["kernel_count"] == 0
    assert s.mass_at("C0", 0) == 100.0
    assert s.mass_at("C0", 3) == 100.0
    assert s.coverage_at("C0", 0) == 1.0


def test_single_hop_evidence_recovers_direct_observed_k_over_n():
    s = evaluate_span_readout(**seed((100.0,), operators=(lag_op("X-Y", 2, 0.20),)))
    assert s.mass_at("C0", 0) == 0.0
    assert s.mass_at("C0", 1) == 0.0
    assert s.mass_at("C0", 2) == 20.0
    assert s.mass_at("C0", 4) == 20.0


def test_multi_hop_evidence_pushes_selected_mass_through_local_rates():
    s = evaluate_span_readout(**seed(
        (200.0,),
        operators=(lag_op("X-M", 5, 0.25, days=12), lag_op("M-Z", 2, 0.30, days=12)),
        days=12, max_tau=10,
    ))
    assert s.mass_at("C0", 6) == 0.0
    np.testing.assert_allclose(s.mass_at("C0", 7), 15.0)
    np.testing.assert_allclose(s.mass_at("C0", 10), 15.0)
    np.testing.assert_allclose(s.value_ledgers[1][0, 5], 50.0)


def test_non_latent_carrier_collapses_active_cohort_to_window_seed():
    carrier = evaluate_span_readout(**seed(
        (120.0,), root_days=(3,), max_tau=2,
        operators=(lag_op("A-X", 0, 1.0, family="evidence_delta0"),),
    ))
    window = evaluate_span_readout(**seed((120.0,), root_days=(3,), max_tau=2))
    assert carrier.mass_at("C0", 0) == window.mass_at("C0", 0)
    assert carrier.mass_at("C0", 2) == window.mass_at("C0", 2)


def test_latent_carrier_legitimately_differs_from_window_over_time():
    s = evaluate_span_readout(**seed(
        (100.0,), max_tau=5,
        operators=(explicit_op("A-X", ((0, 2, 0.40, 1.0), (0, 4, 0.60, 1.0))),),
    ))
    assert s.mass_at("C0", 0) == 0.0
    assert s.mass_at("C0", 1) == 0.0
    np.testing.assert_allclose(s.mass_at("C0", 2), 40.0)
    np.testing.assert_allclose(s.mass_at("C0", 4), 100.0)


def test_model_kernel_uses_same_readout_shape_as_evidence_kernel():
    s = evaluate_span_readout(**seed(
        max_tau=0,
        operators=(lag_op("X-M", 0, 0.5, family="model"), lag_op("M-Z", 0, 0.2, family="model")),
        provenance={"role": "subject_model"},
    ))
    np.testing.assert_allclose(s.mass_at("C0", 0), 0.1)
    assert s.provenance["kernel_families"] == ("model", "model")
    assert s.provenance["role"] == "subject_model"


def test_source_day_specific_kernels_are_supplied_by_operator_boundary():
    s = evaluate_span_readout(**seed(
        (100.0, 100.0), cohort_ids=("C0", "C1"), root_days=(0, 1), max_tau=2,
        operators=(explicit_op("X-Y", ((0, 1, 0.10, 1.0), (1, 2, 0.30, 1.0))),),
    ))
    np.testing.assert_allclose(s.mass_at("C0", 1), 10.0)
    np.testing.assert_allclose(s.mass_at("C1", 1), 30.0)


def test_covered_zero_is_distinct_from_absence():
    s = evaluate_span_readout(**seed(
        (100.0,), max_tau=1,
        operators=(explicit_op("X-Y", ((0, 0, 0.0, 1.0),)),),
    ))
    assert s.mass_at("C0", 0) == 0.0
    assert s.coverage_at("C0", 0) == 1.0


def test_negative_operator_mass_is_not_hidden_by_the_core():
    s = evaluate_span_readout(**seed(
        (100.0,), max_tau=0,
        operators=(explicit_op("bad", ((0, 0, -0.10, 1.0),)),),
    ))
    assert s.mass_at("C0", 0) == -10.0
