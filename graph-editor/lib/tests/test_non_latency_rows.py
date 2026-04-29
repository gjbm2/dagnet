"""
Unit tests for Class B (non-latency) row builder in cohort_forecast_v3.

Covers doc 50 §2 Class B. Branch selection is driven by the
resolver's `alpha_beta_query_scoped` semantic property — NOT by
source name — so the conjugate-update logic stays correct if new
sources are introduced (per STATS_SUBSYSTEMS.md §5 Confusion 8).

- **alpha_beta_query_scoped=False** (aggregate prior, e.g. bayesian /
  manual): conjugate Beta-Binomial update with query-scoped Σk, Σn.
- **alpha_beta_query_scoped=True** (already query-scoped posterior,
  e.g. analytic): direct read, no update (double-counting
  avoidance).
- Class C (no evidence in window): update degenerates to prior mean.
- Class D (no usable prior and no evidence): returns [].

Pure unit tests — no DB fixtures, no handler pipeline. Feeds mocked
ResolvedModelParams and FrameEvidence directly to _non_latency_rows.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pytest

import sys
from pathlib import Path
_LIB = Path(__file__).resolve().parent.parent
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from runner.cohort_forecast_v3 import _non_latency_rows, FrameEvidence, NonLatencyResult
from runner.model_resolver import ResolvedModelParams, ResolvedLatency


def _rows(*args, **kwargs) -> List[Dict[str, Any]]:
    """Thin wrapper: call _non_latency_rows and return just the rows.

    Tests that inspect the blend provenance (`r`, `m_G`, `applied`,
    `skip_reason`) call `_non_latency_rows` directly and read the
    `NonLatencyResult` fields.
    """
    res = _non_latency_rows(*args, **kwargs)
    return res.rows


def _make_resolved(
    source: str,
    alpha: float,
    beta: float,
    n_effective: Optional[float] = None,
) -> ResolvedModelParams:
    """Construct a ResolvedModelParams with sigma=0 (non-latency).

    The `source` string drives `alpha_beta_query_scoped` via the
    resolver's property mapping:
      - 'bayesian', 'manual' → False (aggregate prior, needs update)
      - 'analytic' → True (already query-scoped)
    Tests should cover both branches by picking an appropriate source.

    `n_effective` (doc 52 §14.3) drives the engine-level subset blend.
    Leave None to suppress the blend (default for pre-doc-52 tests).
    """
    return ResolvedModelParams(
        p_mean=alpha / (alpha + beta) if (alpha + beta) > 0 else 0.0,
        p_sd=0.0,
        alpha=alpha,
        beta=beta,
        alpha_pred=alpha,
        beta_pred=beta,
        n_effective=n_effective,
        edge_latency=ResolvedLatency(mu=0.0, sigma=0.0, onset_delta_days=0.0),
        source=source,
    )


def _make_fe(cohorts: List[Dict[str, float]], max_tau: int = 30) -> FrameEvidence:
    """Build a minimal FrameEvidence from a list of cohort dicts.

    Each cohort dict needs x_frozen (n) and y_frozen (k).
    """
    cohort_list = [
        dict(c, anchor_day=None, tau_max=max_tau, tau_observed=max_tau)
        for c in cohorts
    ]
    return FrameEvidence(
        engine_cohorts=[],
        cohort_list=cohort_list,
        cohort_at_tau={},
        evidence_by_tau={},
        max_tau=max_tau,
        saturation_tau=max_tau,
        tau_solid_max=max_tau,
        tau_future_max=max_tau,
    )


# ── Aggregate-prior path — conjugate update with query evidence ────


def test_aggregate_prior_conjugate_update_bayesian():
    """Aggregate prior (bayesian source): α/β + query evidence → posterior."""
    resolved = _make_resolved(source='bayesian', alpha=10.0, beta=20.0)
    assert resolved.alpha_beta_query_scoped is False  # guard the property
    fe = _make_fe([{'x_frozen': 100.0, 'y_frozen': 30.0}])

    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')

    assert len(rows) > 0
    row = rows[0]
    # Posterior: α' = 10 + 30 = 40, β' = 20 + 70 = 90, p = 40/130
    assert row['p_infinity_mean'] == pytest.approx(40.0 / 130.0)
    s = 130.0
    expected_sd = math.sqrt(40.0 * 90.0 / (s * s * (s + 1)))
    assert row['p_infinity_sd'] == pytest.approx(expected_sd)
    assert row['completeness'] == 1.0
    assert row['completeness_sd'] == 0.0
    assert row['evidence_y'] == 30.0
    assert row['evidence_x'] == 100.0


def test_aggregate_prior_conjugate_update_manual():
    """Manual source is also aggregate-prior semantics — same rule."""
    resolved = _make_resolved(source='manual', alpha=8.0, beta=12.0)
    assert resolved.alpha_beta_query_scoped is False
    fe = _make_fe([{'x_frozen': 40.0, 'y_frozen': 16.0}])

    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    # Posterior: α' = 8 + 16 = 24, β' = 12 + 24 = 36, p = 24/60
    assert rows[0]['p_infinity_mean'] == pytest.approx(24.0 / 60.0)


def test_aggregate_prior_aggregates_across_cohorts():
    """Aggregate prior sums evidence across cohorts before updating."""
    resolved = _make_resolved(source='bayesian', alpha=5.0, beta=5.0)
    fe = _make_fe([
        {'x_frozen': 50.0, 'y_frozen': 10.0},
        {'x_frozen': 30.0, 'y_frozen': 9.0},
        {'x_frozen': 20.0, 'y_frozen': 1.0},
    ])  # Σn=100, Σk=20

    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')

    # Posterior: α' = 5 + 20 = 25, β' = 5 + 80 = 85, p = 25/110
    assert rows[0]['p_infinity_mean'] == pytest.approx(25.0 / 110.0)
    assert rows[0]['cohorts_covered_base'] == 3


# ── Class C — no evidence in the window ─────────────────────────────


def test_class_c_aggregate_prior_no_evidence_returns_prior():
    """Class C via aggregate-prior branch: update-by-zero = prior."""
    resolved = _make_resolved(source='bayesian', alpha=8.0, beta=12.0)
    fe = _make_fe([])  # empty cohort list

    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')

    # Posterior = prior: 8/20 = 0.4
    assert rows[0]['p_infinity_mean'] == pytest.approx(0.4)
    assert rows[0]['cohorts_covered_base'] == 0


def test_class_c_query_scoped_no_evidence_returns_prior():
    """Class C via query-scoped branch: α/β is already the answer."""
    resolved = _make_resolved(source='analytic', alpha=8.0, beta=12.0)
    fe = _make_fe([])

    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert rows[0]['p_infinity_mean'] == pytest.approx(0.4)


def test_class_c_fe_is_none_returns_prior():
    """When build_cohort_evidence returns None (no frames), fall through to prior."""
    resolved = _make_resolved(source='bayesian', alpha=8.0, beta=12.0)

    rows = _rows(fe=None, resolved=resolved, sweep_to='2026-04-01', axis_tau_max=20)
    assert len(rows) == 21  # default range 0..20
    assert rows[0]['p_infinity_mean'] == pytest.approx(0.4)
    assert rows[0]['evidence_y'] is None  # no fe → no evidence scalar


# ── Class D — no usable prior AND no evidence ───────────────────────


def test_class_d_returns_empty():
    """No prior and no evidence: return [] (caller emits skipped_edges)."""
    resolved = _make_resolved(source='', alpha=0.0, beta=0.0)
    rows = _rows(fe=None, resolved=resolved, sweep_to='2026-04-01')
    assert rows == []


# ── Row schema parity with Class A ──────────────────────────────────


def test_row_schema_matches_class_a():
    """Row fields must match the schema compute_cohort_maturity_rows_v3 emits
    for Class A, so downstream chart/CF consumers work unchanged."""
    expected_fields = {
        'tau_days', 'rate', 'rate_pure', 'evidence_y', 'evidence_x',
        'projected_rate', 'forecast_y', 'forecast_x', 'midpoint',
        'fan_upper', 'fan_lower', 'fan_bands', 'model_midpoint',
        'model_fan_upper', 'model_fan_lower', 'model_bands',
        'tau_solid_max', 'tau_future_max', 'boundary_date',
        'cohorts_covered_base', 'cohorts_covered_projected',
        'completeness', 'completeness_sd',
        'p_infinity_mean', 'p_infinity_sd', 'p_infinity_sd_epistemic',
    }
    resolved = _make_resolved(source='bayesian', alpha=5.0, beta=5.0)
    fe = _make_fe([{'x_frozen': 10.0, 'y_frozen': 3.0}])
    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert len(rows) > 0
    assert set(rows[0].keys()) == expected_fields


def test_rows_flat_in_tau():
    """τ-dependent fields must be identical across rows (σ→0 degeneration)."""
    resolved = _make_resolved(source='analytic', alpha=20.0, beta=30.0)
    fe = _make_fe([{'x_frozen': 50.0, 'y_frozen': 15.0}], max_tau=10)
    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')

    first_midpoint = rows[0]['midpoint']
    first_fan_upper = rows[0]['fan_upper']
    first_fan_lower = rows[0]['fan_lower']
    for row in rows[1:]:
        assert row['midpoint'] == first_midpoint
        assert row['fan_upper'] == first_fan_upper
        assert row['fan_lower'] == first_fan_lower


def test_aggregate_prior_model_bands_reflect_prior():
    """Aggregate-prior branch: model_* reflects the pre-update prior."""
    resolved = _make_resolved(source='bayesian', alpha=4.0, beta=6.0)
    fe = _make_fe([{'x_frozen': 100.0, 'y_frozen': 50.0}])  # heavy evidence
    rows = _rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')

    # Prior mean: 4/10 = 0.4
    # Posterior mean: 54/110 ≈ 0.49 — distinct from prior
    assert rows[0]['model_midpoint'] == pytest.approx(0.4)
    assert rows[0]['midpoint'] == pytest.approx(54.0 / 110.0)
    assert rows[0]['model_midpoint'] != rows[0]['midpoint']


# ── Doc 52: subset-conditioning blend (non-latency path) ──────────
#
# Five test cases per doc 52 §14.9. Aggregate prior with a known
# n_effective drives the blend.


def test_blend_non_latency_r06():
    """r = 0.6: blended posterior mean lies between conditioned and aggregate.

    Resolved α=40, β=60, n_effective=100; six Cohorts each x=10, y=4
    (m_S=60, r=0.6). B1 update gives α'=40+24=64, β'=60+36=96, mean
    64/160 = 0.4. Aggregate mean is also 40/100 = 0.4 (by construction
    in this fixture), so the blended mean equals 0.4 for both inputs
    — validate the blend produces the right provenance and the
    variance is bounded by the linear blend identity.
    """
    resolved = _make_resolved(source='bayesian', alpha=40.0, beta=60.0, n_effective=100.0)
    fe = _make_fe([{'x_frozen': 10.0, 'y_frozen': 4.0}] * 6)  # m_S = 60
    res = _non_latency_rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert res.blend_applied is True
    assert res.r == pytest.approx(0.6)
    assert res.m_S == pytest.approx(60.0)
    assert res.m_G == pytest.approx(100.0)
    assert res.blend_skip_reason is None
    # Both inputs have mean 0.4 → blended mean is 0.4 exactly.
    assert res.rows[0]['p_infinity_mean'] == pytest.approx(0.4, abs=1e-4)


def test_blend_non_latency_small_r():
    """r ≈ 0.05: blended output ≈ fully-conditioned (today's behaviour)."""
    resolved = _make_resolved(source='bayesian', alpha=40.0, beta=60.0, n_effective=1000.0)
    fe = _make_fe([{'x_frozen': 10.0, 'y_frozen': 7.0}] * 5)  # m_S = 50, r = 0.05
    res = _non_latency_rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert res.blend_applied is True
    # Conditioned: α' = 40+35 = 75, β' = 60+15 = 75, mean = 0.5
    # Aggregate: mean = 0.4
    # Blended mean ≈ 0.95·0.5 + 0.05·0.4 = 0.495
    assert res.rows[0]['p_infinity_mean'] == pytest.approx(0.495, abs=1e-3)


def test_blend_non_latency_full_r():
    """r = 1: blended output equals the aggregate (no re-conditioning)."""
    resolved = _make_resolved(source='bayesian', alpha=40.0, beta=60.0, n_effective=60.0)
    fe = _make_fe([{'x_frozen': 10.0, 'y_frozen': 9.0}] * 6)  # m_S = 60, r = 1
    res = _non_latency_rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert res.blend_applied is True
    assert res.r == pytest.approx(1.0)
    # r=1 → blended Beta matches aggregate (α=40, β=60, mean=0.4).
    assert res.rows[0]['p_infinity_mean'] == pytest.approx(0.4, abs=1e-4)


def test_blend_non_latency_analytic_source_uses_same_blend_contract():
    """Analytic aggregate α/β uses the same blend contract as bayesian."""
    resolved = _make_resolved(source='analytic', alpha=20.0, beta=30.0, n_effective=50.0)
    fe = _make_fe([{'x_frozen': 10.0, 'y_frozen': 4.0}] * 3)
    res = _non_latency_rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert res.blend_applied is True
    assert res.r == pytest.approx(0.6)
    assert res.m_S == pytest.approx(30.0)
    assert res.m_G == pytest.approx(50.0)
    assert res.blend_skip_reason is None
    # Aggregate and scoped evidence have the same mean in this fixture.
    assert res.rows[0]['p_infinity_mean'] == pytest.approx(20.0 / 50.0)


def test_blend_non_latency_skip_missing_n_effective():
    """bayesian source without n_effective skips blend with n_effective_missing."""
    resolved = _make_resolved(source='bayesian', alpha=40.0, beta=60.0, n_effective=None)
    fe = _make_fe([{'x_frozen': 10.0, 'y_frozen': 4.0}] * 3)
    res = _non_latency_rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    assert res.blend_applied is False
    assert res.blend_skip_reason == 'n_effective_missing'
    # Falls through to B1 update: α' = 40+12 = 52, β' = 60+18 = 78, mean = 52/130.
    assert res.rows[0]['p_infinity_mean'] == pytest.approx(52.0 / 130.0)


# ── Reviewer fix #4: extra_conditioning_evidence (typed-merge file E) ────


def test_extras_pooled_into_conjugate_update_with_fe():
    """File-derived merged-E points pool with snapshot fe into Σk/Σn.

    Reviewer #4: pre-fix, the bundle reported `total_x = fe + extras`
    while the engine conditioned only on `fe`. With the parameter
    threaded through, both the bundle and the conjugate update see the
    same Σ totals.
    """
    resolved = _make_resolved(source='bayesian', alpha=10.0, beta=20.0)
    fe = _make_fe([{'x_frozen': 50.0, 'y_frozen': 10.0}])
    extras = [
        (5.0, 30.0, 6.0),   # n=30, k=6
        (10.0, 20.0, 4.0),  # n=20, k=4
    ]
    res = _non_latency_rows(
        fe=fe, resolved=resolved, sweep_to='2026-04-01',
        extra_conditioning_evidence=extras,
    )
    # Σn = 50 + 30 + 20 = 100; Σk = 10 + 6 + 4 = 20
    # α' = 10 + 20 = 30; β' = 20 + (100 - 20) = 100; p = 30/130
    row = res.rows[0]
    assert row['p_infinity_mean'] == pytest.approx(30.0 / 130.0)
    assert row['evidence_x'] == pytest.approx(100.0)
    assert row['evidence_y'] == pytest.approx(20.0)
    assert res.conditioned is True


def test_extras_only_no_fe_still_conditions():
    """Extras without fe still drive the conjugate update and `conditioned=True`.

    Pre-fix, `conditioned = (fe is not None and sum_x > 0)` would have
    returned False here even though extras moved the posterior.
    """
    resolved = _make_resolved(source='bayesian', alpha=10.0, beta=20.0)
    extras = [(0.0, 40.0, 8.0)]
    res = _non_latency_rows(
        fe=None, resolved=resolved, sweep_to='2026-04-01',
        extra_conditioning_evidence=extras,
    )
    # α' = 10 + 8 = 18; β' = 20 + 32 = 52; p = 18/70
    row = res.rows[0]
    assert row['p_infinity_mean'] == pytest.approx(18.0 / 70.0)
    assert row['evidence_x'] == pytest.approx(40.0)
    assert row['evidence_y'] == pytest.approx(8.0)
    assert res.conditioned is True


def test_no_extras_preserves_legacy_behaviour():
    """Without extras, the function behaves identically to the pre-fix path.

    Guards against accidental regression of the fe-only conditioning
    case — the most common production path until the snapshot adapter
    starts populating extras for snapshot-only edges.
    """
    resolved = _make_resolved(source='bayesian', alpha=10.0, beta=20.0)
    fe = _make_fe([{'x_frozen': 100.0, 'y_frozen': 30.0}])
    res = _non_latency_rows(fe=fe, resolved=resolved, sweep_to='2026-04-01')
    # α' = 10 + 30 = 40; β' = 20 + 70 = 90; p = 40/130
    row = res.rows[0]
    assert row['p_infinity_mean'] == pytest.approx(40.0 / 130.0)
    assert row['evidence_x'] == pytest.approx(100.0)
    assert res.conditioned is True


def test_malformed_extras_skipped_silently():
    """Tuples with wrong arity are skipped; valid tuples still fold in."""
    resolved = _make_resolved(source='bayesian', alpha=10.0, beta=20.0)
    fe = _make_fe([{'x_frozen': 50.0, 'y_frozen': 10.0}])
    extras = [
        (5.0, 30.0, 6.0),
        ('garbage', None),  # arity-2, ValueError on unpack — must be skipped
        None,               # not a tuple — must be skipped
    ]
    res = _non_latency_rows(
        fe=fe, resolved=resolved, sweep_to='2026-04-01',
        extra_conditioning_evidence=extras,
    )
    # Only the valid (5.0, 30.0, 6.0) entry contributes.
    # Σn = 50 + 30 = 80; Σk = 10 + 6 = 16
    # α' = 26; β' = 20 + 64 = 84; p = 26/110
    assert res.rows[0]['p_infinity_mean'] == pytest.approx(26.0 / 110.0)
