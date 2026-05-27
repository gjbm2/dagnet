"""Bucket-boundary convention tests for the §10.1 bucket-K algebra.

These are focused seam tests for the current runtime's placement
convention. They assert that model/operator placement is centralised in
the bucket transition helper while strict empirical counts remain
endpoint-exact.
The wider outside-in canaries remain in ``test_cohort_factorised_outside_in``.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.bucket_transition import (
    cumulative_empirical_rate_to_transition,
    dirac_transition,
    endpoint_cdf_to_transition,
    to_span_operator,
)
from runner.primitives import TimingFamily
from runner.span_kernel import ConcreteEdge
from runner.subject_span_composer import _conditioned_kernel_maps
from runner.timing_particles import EdgeTimingParticles, build_per_draw_edge_cdf


class _FakeLatentPrimitive:
    timing_family = TimingFamily.LATENT

    def __init__(self, cdf_draws: np.ndarray):
        self._cdf_draws = np.asarray(cdf_draws, dtype=np.float64)

    def probability_draws(self) -> np.ndarray:
        return np.ones(self._cdf_draws.shape[0], dtype=np.float64)

    def timing_draws(self) -> np.ndarray:
        return self._cdf_draws


def test_bucket_transition_endpoint_cdf_contract():
    transition = endpoint_cdf_to_transition(
        'edge',
        np.asarray([0.0, 0.25, 0.75, 1.0], dtype=np.float64),
        family='model',
        probability=0.8,
    )

    assert transition.name == 'edge'
    assert transition.family == 'model'
    np.testing.assert_allclose(
        transition.value,
        np.asarray([[0.0, 0.2, 0.4, 0.2]], dtype=np.float64),
    )


def test_bucket_transition_empirical_cumulative_contract():
    transition = cumulative_empirical_rate_to_transition(
        'empirical',
        np.asarray([0.0, 0.1, 0.1, 0.4], dtype=np.float64),
    )

    np.testing.assert_allclose(
        transition.value,
        np.asarray([[0.05, 0.05, 0.15, 0.15]], dtype=np.float64),
    )


def test_endpoint_empirical_transition_preserves_age_zero_mass():
    """Endpoint empirical reads must keep instant/non-latent mass at lag 0."""

    transition = cumulative_empirical_rate_to_transition(
        'instant-empirical',
        np.asarray([0.5, 0.5, 0.5, 0.5], dtype=np.float64),
        read_offset=0.0,
    )

    np.testing.assert_allclose(
        transition.value,
        np.asarray([[0.5, 0.0, 0.0, 0.0]], dtype=np.float64),
    )


def test_bucket_transition_dirac_and_span_adapter_contract():
    transition = dirac_transition(
        'instant',
        lag=2,
        probability=0.7,
        family='deterministic',
    )
    operator = to_span_operator(transition)

    np.testing.assert_allclose(
        operator.value,
        np.asarray([[0.0, 0.0, 0.7]], dtype=np.float64),
    )
    assert operator.name == 'instant'
    assert operator.family == 'deterministic'


def test_timing_particles_emit_bucket_transition_cdf_for_output_path():
    particles = EdgeTimingParticles(
        mu_draws=np.asarray([np.log(1.0)], dtype=np.float64),
        sigma_draws=np.asarray([0.5], dtype=np.float64),
        onset_draws=np.asarray([0.0], dtype=np.float64),
        draw_count=1,
    )

    cdf = build_per_draw_edge_cdf(particles, horizon_len=4)

    assert cdf.shape == (1, 4)
    assert cdf[0, 0] > 0.0
    assert cdf[0, 1] > cdf[0, 0]
    assert cdf[0, 2] > cdf[0, 1]


def test_model_kernel_supply_uses_endpoint_differencing_for_model_composition():
    edge = ConcreteEdge(
        edge_key='x->y#0',
        from_id='x',
        to_id='y',
        edge_data={},
    )
    primitive = _FakeLatentPrimitive(
        np.asarray([[0.0, 0.25, 0.75, 1.0]], dtype=np.float64),
    )

    native, propagated = _conditioned_kernel_maps(
        edge_primitives=((edge, primitive),),
        S=1,
        T=4,
        cdf_renorm_tolerance=1e-12,
    )

    endpoint_expected = np.asarray([[0.0, 0.25, 0.5, 0.25]], dtype=np.float64)
    bucket_expected = np.asarray(
        [[0.09230769230769231, 0.4, 0.4, 0.1076923076923077]],
        dtype=np.float64,
    )
    np.testing.assert_allclose(native['x->y#0'], endpoint_expected)
    np.testing.assert_allclose(propagated['x->y#0'], bucket_expected)


# `test_rate_attributed_prefix_uses_bucket_k_without_overshoot` removed at
# Stage 4 Atom 4.2: it exercised the deleted `_SelectedSourceDayMass` /
# `_SubjectChainEvidenceBuckets` / `_build_evidence_local_rate_attributed_subject_prefix`
# legacy quadrature prefix. Bucket-K placement is now owned by the empirical
# operator; the live bucket_transition contract is covered by the tests above
# plus the outside-in oracle.
