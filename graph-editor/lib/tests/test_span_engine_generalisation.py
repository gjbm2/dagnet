"""Engine-level tests for the subgraph-reducer engine generalisation
(``docs/current/project-generalise/subgraph-reducer-engine-generalisation-proposal.md``).

Focuses on the integration surfaces the proposal's acceptance criteria
call out:

  - active-cohort carrier-to-subject handoff (the new spine helper);
  - Phase 6 §4.8 covered-zero / absent distinction at engine cells where
    the value-weighted support ratio collapses;
  - coverage / cumulative-exposure projections from the per-draw
    surfaces.

Per-node / per-edge stacking, identity-span surfaces, and sibling
separability are exercised in ``test_span_kernel.py`` (Stage A) and
``test_subject_span_composer.py`` (Stages B + D). Per-primitive kernel
construction with masks is exercised in ``test_span_operator_supply.py``
and ``test_span_readout.py`` (Stage C).
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.model_span_spine import (
    project_coverage_draws,
    project_cumulative_exposure_draws,
    seed_subject_from_carrier,
)
from runner.span_readout import SpanOperator, evaluate_span_readout
from runner.subject_span_composer import ComposedPrimitiveSpan


# ─── Carrier-to-subject handoff (proposal §5) ────────────────────────


def _identity_carrier(draw_count: int = 4, max_tau: int = 8) -> ComposedPrimitiveSpan:
    """Synthesise a zero-edge identity carrier (window / cohort(A=X))."""
    return ComposedPrimitiveSpan.identity(
        x_node_id='X',
        end_node_id='X',
        max_tau=max_tau,
        draw_count=draw_count,
        provenance={'note': 'synthetic identity carrier'},
    )


def _make_synthetic_active_carrier(
    *, draw_count: int, max_tau: int, x_arrival_pmf: np.ndarray,
) -> ComposedPrimitiveSpan:
    """Build a composed carrier whose per-draw arrival density at X
    equals the given pmf. Synthetic — bypasses the per-draw DP path for
    unit-test isolation of `seed_subject_from_carrier`.
    """
    T = int(max_tau) + 1
    pmf = np.asarray(x_arrival_pmf, dtype=np.float64).reshape(1, T)
    pmf_per_draw = np.repeat(pmf, draw_count, axis=0)
    root_delta = np.zeros((draw_count, T), dtype=np.float64)
    root_delta[:, 0] = 1.0
    reach = float(pmf.sum())
    return ComposedPrimitiveSpan(
        x_node_id='A',
        end_node_id='X',
        primitive_count=1,
        draw_count=draw_count,
        span_p_mean=reach,
        span_p_sd=0.0,
        span_p_draws=np.full(draw_count, reach, dtype=np.float64),
        cdf_mean=np.cumsum(pmf[0]) / reach if reach > 0 else np.zeros(T),
        cdf_draws=(np.cumsum(pmf_per_draw, axis=1) / reach) if reach > 0 else np.zeros((draw_count, T)),
        max_tau=max_tau,
        node_density_draws={'A': root_delta, 'X': pmf_per_draw},
        edge_contribution_draws={'A->X#0': pmf_per_draw.copy()},
        node_support_draws={'A': root_delta.copy(), 'X': pmf_per_draw.copy()},
        edge_support_contribution_draws={'A->X#0': pmf_per_draw.copy()},
        node_exposure_draws={'A': root_delta.copy(), 'X': pmf_per_draw.copy()},
        edge_exposure_contribution_draws={'A->X#0': pmf_per_draw.copy()},
        concrete_edges=(),
        provenance={'note': 'synthetic active carrier'},
    )


def test_identity_carrier_handoff_returns_seed_at_anchor_days():
    """A zero-edge identity carrier reproduces an anchor cohort directly
    at X — the subject's seed equals the anchor counts placed at each
    anchor day."""
    S = 3
    carrier = _identity_carrier(draw_count=S, max_tau=10)
    days = 12
    value_seed, support_seed, exposure_seed = seed_subject_from_carrier(
        carrier=carrier,
        x_node_id='X',
        anchor_days=[0, 4],
        anchor_counts=[100.0, 50.0],
        days=days,
    )
    # Anchor 0: 100 at day 0 across all draws.
    # Anchor 4: 50 at day 4 across all draws.
    # No mass elsewhere (identity carrier transfers δ(0) at the root).
    expected = np.zeros((S, days), dtype=np.float64)
    expected[:, 0] = 100.0
    expected[:, 4] = 50.0
    np.testing.assert_array_equal(value_seed, expected)
    np.testing.assert_array_equal(support_seed, expected)
    np.testing.assert_array_equal(exposure_seed, expected)


def test_active_carrier_handoff_smears_anchor_counts_via_arrival_pmf():
    """An active A→X carrier with a non-trivial arrival PMF spreads
    each anchor cohort across multiple source days at X, scaled by the
    cohort count and shifted by the anchor day."""
    S = 2
    max_tau = 4
    # PMF: 0.6 at day 0, 0.4 at day 1.
    pmf = np.asarray([0.6, 0.4, 0.0, 0.0, 0.0])
    carrier = _make_synthetic_active_carrier(
        draw_count=S, max_tau=max_tau, x_arrival_pmf=pmf,
    )
    value_seed, _, _ = seed_subject_from_carrier(
        carrier=carrier,
        x_node_id='X',
        anchor_days=[0, 2],
        anchor_counts=[100.0, 50.0],
        days=8,
    )
    # Anchor 0 contributes 60 at day 0 and 40 at day 1.
    # Anchor 2 contributes 30 at day 2 and 20 at day 3.
    expected = np.zeros((S, 8))
    expected[:, 0] = 60.0
    expected[:, 1] = 40.0
    expected[:, 2] = 30.0
    expected[:, 3] = 20.0
    np.testing.assert_allclose(value_seed, expected, atol=1e-12)


def test_active_carrier_handoff_out_of_horizon_anchor_contributes_zero():
    """Anchor days outside [0, days) are perimeter cases. The handoff
    silently drops them — they're not algebraic refusals, just bounded
    horizon."""
    S = 2
    pmf = np.asarray([1.0, 0.0, 0.0, 0.0, 0.0])
    carrier = _make_synthetic_active_carrier(
        draw_count=S, max_tau=4, x_arrival_pmf=pmf,
    )
    value_seed, _, _ = seed_subject_from_carrier(
        carrier=carrier,
        x_node_id='X',
        anchor_days=[-1, 5],   # both out of horizon for days=4
        anchor_counts=[100.0, 100.0],
        days=4,
    )
    np.testing.assert_array_equal(value_seed, np.zeros((S, 4)))


# ─── Coverage and cumulative-exposure projections (proposal §5) ──────


def test_coverage_projection_one_at_fully_observed_paths():
    """Fully observed wavefront: cumulative support == cumulative value
    at every cell where value > 0 → coverage == 1.0."""
    value = np.asarray([[0.0, 0.4, 0.3, 0.2]])
    coverage = project_coverage_draws(value, value.copy())
    # Wherever cumulative_value > 0, coverage = 1.
    assert coverage[0, 1] == pytest.approx(1.0)
    assert coverage[0, 2] == pytest.approx(1.0)
    assert coverage[0, 3] == pytest.approx(1.0)
    # At τ=0 the cumulative is zero → 0/0 cell emits 0 (Phase 6 policy).
    assert coverage[0, 0] == 0.0


def test_coverage_projection_zero_at_absent_paths():
    """Wavefront passes only through absent cells: cumulative support
    is identically zero → coverage = 0/value = 0 wherever value > 0."""
    value = np.asarray([[0.0, 0.4, 0.3, 0.2]])
    support = np.zeros_like(value)
    coverage = project_coverage_draws(value, support)
    np.testing.assert_array_equal(coverage, np.zeros_like(value))


def test_coverage_projection_zero_zero_emits_zero():
    """Phase 6 §4.8 0/0 policy: wavefront has not arrived → coverage = 0
    (the cell is undefined; the engine emits 0 algebraically)."""
    value = np.zeros((1, 4))
    support = np.zeros((1, 4))
    coverage = project_coverage_draws(value, support)
    np.testing.assert_array_equal(coverage, np.zeros((1, 4)))


def test_cumulative_exposure_projection_is_a_running_sum():
    exposure = np.asarray([[0.0, 0.5, 0.5, 0.0]])
    cum = project_cumulative_exposure_draws(exposure)
    np.testing.assert_array_equal(cum, np.asarray([[0.0, 0.5, 1.0, 1.0]]))


# ─── Phase 6 §4.8 covered-zero vs absent distinction at engine level ─


def _stream_ledger_op(name, lag, *, value_frac, support_frac, exposure_frac):
    """Build a single-lag operator with explicit (value, support, exposure)
    kernels for unit-testing the three-stream propagation."""
    value = np.zeros((1, lag + 1))
    support = np.zeros((1, lag + 1))
    exposure = np.zeros((1, lag + 1))
    value[0, lag] = value_frac
    support[0, lag] = support_frac
    exposure[0, lag] = exposure_frac
    return SpanOperator(
        name=name, value=value, support=support, exposure=exposure,
        family="evidence",
    )


def test_covered_zero_terminal_has_exposure_but_no_value_or_support():
    """Phase 6 §4.8 covered-zero case: the (UV, s, age) cell has
    mask=1 but Δcdf=0, so value and support contribute 0 while exposure
    (mask × exposure_shape with exposure_shape > 0) is positive.

    Engine-level realisation: operator with value=0, support=0,
    exposure>0 — the cumulative_value collapses to zero at the terminal
    while cumulative_exposure > 0. This is the algebraic distinction
    the value-weighted support stream alone cannot preserve.
    """
    covered_zero_op = _stream_ledger_op(
        "covered-zero", lag=1,
        value_frac=0.0, support_frac=0.0, exposure_frac=1.0,
    )
    surface = evaluate_span_readout(
        cohort_ids=("C0",),
        root_days=np.asarray([0], dtype=int),
        root_counts=np.asarray([100.0], dtype=float),
        root_supports=np.asarray([100.0], dtype=float),
        operators=(covered_zero_op,),
        days=8,
        max_tau=4,
    )
    # Value at τ=1 is 0 (Δcdf was zero — covered with zero mass).
    assert surface.mass_at("C0", 1) == 0.0
    # Coverage = 0/0 → 0 by policy; can't distinguish from absent.
    assert surface.coverage_at("C0", 1) == 0.0
    # Exposure is positive: the wavefront DID reach observed cells.
    # This is what tells us "we observed, the answer is zero" rather
    # than "we have no observation".
    assert surface.exposure_at("C0", 1) == 100.0


def test_absent_terminal_has_zero_in_all_three_streams():
    """Absent cell: mask=0, so value × mask = 0, exposure_shape × mask = 0.
    All three streams collapse to zero. Distinguishable from
    covered-zero at the engine level via the exposure column."""
    absent_op = _stream_ledger_op(
        "absent", lag=1,
        value_frac=0.4, support_frac=0.0, exposure_frac=0.0,
    )
    surface = evaluate_span_readout(
        cohort_ids=("C0",),
        root_days=np.asarray([0], dtype=int),
        root_counts=np.asarray([100.0], dtype=float),
        root_supports=np.asarray([100.0], dtype=float),
        operators=(absent_op,),
        days=8,
        max_tau=4,
    )
    # Value at τ=1: 100 × 0.4 = 40 (mass propagates regardless of mask).
    assert surface.mass_at("C0", 1) == 40.0
    # Coverage = cum_support / cum_value = 0 / 40 = 0.
    assert surface.coverage_at("C0", 1) == 0.0
    # Exposure = 0 at the absent terminal → algebraically distinct from
    # the covered-zero case where exposure was 100.
    assert surface.exposure_at("C0", 1) == 0.0


def test_mixed_path_yields_intermediate_coverage():
    """A path where some cells are observed and some are absent yields
    coverage in (0, 1) — the mass-weighted fraction of the wavefront
    routed through observed cells. Computed via the Phase 6 §4.8 ratio
    projection from the value and support ledgers."""
    half_observed = SpanOperator(
        name="half-observed", family="evidence",
        value=np.array([[0.5]]),
        support=np.array([[0.25]]),   # 50% of the cell observed
        exposure=np.array([[0.5]]),
    )
    surface = evaluate_span_readout(
        cohort_ids=("C0",),
        root_days=np.asarray([0], dtype=int),
        root_counts=np.asarray([100.0], dtype=float),
        root_supports=np.asarray([100.0], dtype=float),
        operators=(half_observed,),
        days=4,
        max_tau=2,
    )
    # Value at τ=0: 100 × 0.5 = 50. Support: 100 × 0.25 = 25.
    assert surface.mass_at("C0", 0) == 50.0
    # Phase 6 §4.8 coverage projection from the value+support ledgers.
    coverage = project_coverage_draws(
        surface.value_ledgers[-1], surface.support_ledgers[-1],
    )
    # Coverage at the root_day + τ=0 cell: 25 / 50 = 0.5.
    assert coverage[0, 0] == pytest.approx(0.5)
    # Exposure: 100 × 0.5 = 50. Positive → wavefront reached an
    # observed cell; combined with coverage = 0.5 we read this as
    # "half the mass flowed through observed cells".
    assert surface.exposure_at("C0", 0) == 50.0
