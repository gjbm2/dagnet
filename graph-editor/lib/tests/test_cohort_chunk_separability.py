"""Cohort-axis chunk separability — the precondition for memory Lever A.

``docs/current/be-memory-budget-design.md`` §5 / §12 lists ONE open
engineering risk gating cohort-axis batching (Lever A): the FC-assembly DP
that builds the ``(C, S, T)`` surfaces inside
``project_selected_cohort_rows`` must be evaluable on a cohort *subset* and
yield bit-identical per-cohort rows — otherwise running cohorts in chunks
would change results. The reducers and the cross-cohort sums are obviously
additive; the surface-building DP is where the real work sits, so it is the
thing that must be *proven* separable before the chunk loop is buildable.

This module is that proof. It builds the four composed spans ONCE (kernels
are cohort-independent — they derive from the per-edge primitives and the
admitted evidence, not from the selected-cohort set), then drives
``project_selected_cohort_rows`` two ways over the SAME spans:

  * full   — all C cohorts in one call;
  * chunked — contiguous cohort chunks of size K, each a separate call,
              reassembled exactly as the real batch loop would.

It then asserts:

  1. **Per-cohort surfaces are bit-exact** (``assert_array_equal``, NaNs
     matched) between the full call and the concatenation of the chunk
     calls, for every ``*_by_cohort`` surface. This is the separability
     precondition: cohort ``c``'s row depends only on cohort ``c``'s seed /
     origin / frontier and the shared kernels — never on which other
     cohorts share the call. (The only cross-row operation in the DP is a
     sparsity gate over the flat row axis; a column that is zero for every
     row in a chunk contributes exactly ``0.0`` to those rows, so dropping
     it is bit-identical — which this test confirms empirically.)

  2. **Additive aggregates reconstruct** from sequential chunk
     accumulation, within a tight float tolerance. The full path reduces
     all C cohorts in a single ``.sum(axis=0)`` (numpy pairwise order); the
     batch loop adds chunk-sums sequentially. Those summation orders differ
     at the ULP, so the aggregate is *not* bit-exact by construction — only
     the per-cohort surfaces are. This is exactly the "bit-identical within
     float tolerance" the design doc (§10) specifies.

  3. **Derived rates reconstruct** by dividing the accumulated numerator and
     denominator sums ONCE (the sum-first / divide-once invariant), with the
     projection's NaN-on-0/0 policy preserved.

If (1) ever fails, Lever A is NOT buildable as designed and the chunk loop
must not be written — the failure names the surface that couples.

Fixtures are the blind-algebraic apparatus from
``test_model_span_spine_selected_cohort.py``; kept separate from the
outside-in oracle (whose modification needs explicit sign-off).
"""

from __future__ import annotations

import os
import sys
from typing import Any, List, Sequence

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.model_span_spine import project_selected_cohort_rows

from test_model_span_spine_selected_cohort import (  # noqa: E402
    _DRAW_COUNT,
    _HORIZON,
    _build_window_mode_spans,
    _candidate,
)


FLOAT32_AGG_RTOL = 2e-6
FLOAT32_AGG_ATOL = 1e-5


# ── Fixture: four observed window cohorts, varied frontier / extent ──────
#
# Distinct anchor days, distinct (N, k) evidence, and deliberately varied
# tau_observed / tau_max so the per-cohort branches that matter for
# separability — the strict-evidence τ-clamp, the FC frontier mask, the
# applicability fade — all fire with different boundaries per cohort. If the
# DP leaked any cross-cohort coupling, varied frontiers are where it would
# surface.

_COHORT_SPECS = [
    # (anchor_day, n, k, tau_observed, tau_max)
    ('2026-03-08', 80, 16, 3, 20),
    ('2026-03-10', 100, 25, 5, 25),
    ('2026-03-12', 120, 18, 7, 30),
    ('2026-03-15', 90, 27, 10, 30),
]


def _build_spans(*, sigma_xy: float = 0.8):
    """Build the four spans ONCE from every cohort's observed evidence.

    The kernels embedded in the returned spans are a function of the
    per-edge primitives and the admitted candidates — NOT of the
    selected-cohort set passed to the reducer. Reusing this one set of
    spans across the full and chunked calls is exactly the "reuse the one
    already-built runtime/spans" constraint the design doc places on the
    real chunk loop.
    """
    candidates = tuple(
        _candidate(
            from_id='X', to_id='Y',
            observed_date=anchor,
            # retrieved a week after the anchor (window helper convention)
            retrieved_at=_plus_days(anchor, 7),
            n=n, k=k,
        )
        for anchor, n, k, _to, _tm in _COHORT_SPECS
    )
    return _build_window_mode_spans(candidates_xy=candidates, sigma_xy=sigma_xy)


def _plus_days(iso_day: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso_day) + timedelta(days=days)).isoformat()


def _selected_cohorts() -> List[dict]:
    return [
        {'anchor_day': anchor, 'N_anchor': float(n), 'N_pop': float(n),
         'tau_max': tau_max, 'tau_observed': tau_obs}
        for anchor, n, _k, tau_obs, tau_max in _COHORT_SPECS
    ]


def _project(spans, cohorts: Sequence[dict]):
    carrier, subject, emp_carrier, emp_subject = spans
    return project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_carrier_predictive=carrier,
        composed_subject_predictive=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=list(cohorts),
        horizon=_HORIZON,
    )


def _chunks(seq: Sequence[Any], k: int) -> List[list]:
    return [list(seq[i:i + k]) for i in range(0, len(seq), k)]


# Per-cohort surfaces: cohort c's row must be identical regardless of which
# other cohorts shared the call. These are the separability witnesses.
_PER_COHORT_FIELDS = (
    'f_x_draws_by_cohort', 'f_y_draws_by_cohort', 'f_rate_draws_by_cohort',
    'ef_x_draws_by_cohort', 'ef_y_draws_by_cohort', 'ef_rate_draws_by_cohort',
    'ef_forecast_x_by_cohort', 'ef_forecast_y_by_cohort',
    'evidence_x_strict_by_cohort', 'evidence_y_strict_by_cohort',
)

# Additive aggregates: full == Σ over cohorts; reconstruct by adding chunk
# sums. Not bit-exact (summation order differs) — tight tolerance.
_ADDITIVE_AGG_FIELDS = (
    'f_x_draws', 'f_y_draws',
    'ef_x_draws', 'ef_y_draws',
    'ef_forecast_x', 'ef_forecast_y',
    'evidence_x_strict', 'evidence_y_strict',
    'applicable_cohort_count',
)


def _run_full_and_chunked(k: int):
    spans = _build_spans()
    full = _project(spans, _selected_cohorts())
    chunk_projections = [_project(spans, c) for c in _chunks(_selected_cohorts(), k)]
    return full, chunk_projections


# ── (1) The precondition: per-cohort surfaces are bit-exact ──────────────

def test_per_cohort_surfaces_bit_exact_under_chunking():
    """Each cohort's surface is identical whether evaluated alone, in a
    pair, or with the whole set — the FC-assembly DP is cohort-separable.

    Bit-exact (atol=0, rtol=0) with NaNs matched: the per-cohort row carries
    no float-order ambiguity because nothing sums across cohorts to build it.
    """
    for k in (1, 2, 3):
        full, chunk_projections = _run_full_and_chunked(k)
        for field in _PER_COHORT_FIELDS:
            full_arr = getattr(full, field)
            chunked_arr = np.concatenate(
                [getattr(p, field) for p in chunk_projections], axis=0,
            )
            assert full_arr.shape == chunked_arr.shape, (
                f'{field}: shape {full_arr.shape} != {chunked_arr.shape} at K={k}'
            )
            np.testing.assert_array_equal(
                chunked_arr, full_arr,
                err_msg=f'{field} not bit-identical under cohort chunk K={k} '
                        f'— FC-assembly DP is NOT cohort-separable; '
                        f'Lever A is not buildable as designed',
            )


def test_per_anchor_strict_maps_bit_exact_under_chunking():
    """The anchor-keyed strict-evidence maps the date reducer reads are also
    per-cohort independent and survive chunking bit-exactly."""
    for k in (1, 2, 3):
        full, chunk_projections = _run_full_and_chunked(k)
        merged_x: dict = {}
        merged_y: dict = {}
        for p in chunk_projections:
            merged_x.update(p.evidence_x_strict_by_anchor_tau)
            merged_y.update(p.evidence_y_strict_by_anchor_tau)
        assert set(merged_x) == set(full.evidence_x_strict_by_anchor_tau)
        for anchor, arr in full.evidence_x_strict_by_anchor_tau.items():
            np.testing.assert_array_equal(merged_x[anchor], arr)
            np.testing.assert_array_equal(
                merged_y[anchor], full.evidence_y_strict_by_anchor_tau[anchor],
            )


# ── (2) Additive aggregates reconstruct (sum-first), tight tolerance ─────

def test_additive_aggregates_reconstruct_from_chunk_sums():
    """The cross-cohort sums the chunk loop accumulates reproduce the full
    aggregate to a tight float tolerance.

    Sequential chunk accumulation (``acc += chunk_sum``) differs from the
    full path's single pairwise ``.sum(axis=0)`` only in summation order, so
    this is checked within tolerance, never bit-exact — the deliberate
    'within float tolerance' the design doc specifies for aggregates.
    """
    for k in (1, 2, 3):
        full, chunk_projections = _run_full_and_chunked(k)
        for field in _ADDITIVE_AGG_FIELDS:
            acc = np.zeros_like(getattr(full, field))
            for p in chunk_projections:
                acc = acc + getattr(p, field)
            np.testing.assert_allclose(
                acc, getattr(full, field),
                rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
                err_msg=f'{field} aggregate does not reconstruct from chunk '
                        f'sums at K={k}',
            )


# ── (3) Derived rates reconstruct by divide-once over accumulated sums ───

def test_derived_rates_reconstruct_divide_once():
    """Rates do not sum: they must be recomputed from the accumulated
    numerator and denominator sums, once, with the projection's NaN/zero
    policy. This pins the sum-first / divide-once arithmetic the chunk loop
    must implement for f_rate_draws, rate_strict and ef_rate_draws."""
    for k in (1, 2, 3):
        full, chunk_projections = _run_full_and_chunked(k)

        # f_rate_draws = f_y / f_x, zero where f_x == 0 (projection policy).
        f_x = sum(p.f_x_draws for p in chunk_projections)
        f_y = sum(p.f_y_draws for p in chunk_projections)
        f_rate = np.divide(
            f_y, f_x, out=np.zeros_like(f_y), where=f_x > 0.0,
        )
        np.testing.assert_allclose(
            f_rate, full.f_rate_draws,
            rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
            err_msg=f'f_rate_draws divide-once mismatch at K={k}',
        )

        # rate_strict = evidence_y_strict / evidence_x_strict, zero where 0.
        ex = sum(p.evidence_x_strict for p in chunk_projections)
        ey = sum(p.evidence_y_strict for p in chunk_projections)
        rate_strict = np.divide(
            ey, ex, out=np.zeros_like(ey), where=ex > 0.0,
        )
        np.testing.assert_allclose(
            rate_strict, full.rate_strict,
            rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
            err_msg=f'rate_strict divide-once mismatch at K={k}',
        )

        # ef_rate_draws = ef_y / ef_x, NaN on 0/0 (visible-undefined policy).
        ef_x = sum(p.ef_x_draws for p in chunk_projections)
        ef_y = sum(p.ef_y_draws for p in chunk_projections)
        with np.errstate(divide='ignore', invalid='ignore'):
            ef_rate = ef_y / ef_x
        np.testing.assert_allclose(
            ef_rate, full.ef_rate_draws,
            rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
            equal_nan=True,
            err_msg=f'ef_rate_draws divide-once mismatch at K={k}',
        )


def test_applicability_row_reconstructs_over_total_cohort_count():
    """applicability_row = applicable_cohort_count / C_total. The chunk loop
    accumulates the count then divides by the TOTAL cohort count once."""
    for k in (1, 2, 3):
        full, chunk_projections = _run_full_and_chunked(k)
        total_c = len(_COHORT_SPECS)
        acc_count = np.zeros_like(full.applicable_cohort_count)
        for p in chunk_projections:
            acc_count = acc_count + p.applicable_cohort_count
        applicability = acc_count / float(total_c)
        np.testing.assert_allclose(
            applicability, full.applicability_row,
            rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
            err_msg=f'applicability_row reconstruction mismatch at K={k}',
        )


def test_fixture_is_non_vacuous():
    """Guard: the fixture must project real mass, or the parity assertions
    above would be vacuously true on all-zero arrays."""
    full, _ = _run_full_and_chunked(1)
    assert np.any(full.f_x_draws_by_cohort > 0.0)
    assert np.any(full.ef_y_draws_by_cohort > 0.0)
    assert np.any(full.evidence_x_strict > 0.0)


# ── The PRODUCTION combine helper reproduces the single-call projection ──
#
# The tests above prove the *math* of chunk reassembly with inline combine
# logic. These pin the same guarantee against the real
# ``_combine_selected_cohort_projections`` shipped in cohort_forecast_v3, so
# the production code path — not a test re-implementation — is what's proven.

def test_production_combine_matches_full_projection():
    from runner.cohort_forecast_v3 import _combine_selected_cohort_projections

    spans = _build_spans()
    full = _project(spans, _selected_cohorts())
    total_c = len(_COHORT_SPECS)
    for k in (1, 2, 3, total_c):
        chunk_projs = [_project(spans, c) for c in _chunks(_selected_cohorts(), k)]
        combined = _combine_selected_cohort_projections(
            chunk_projs, total_cohort_count=total_c,
            draw_count=_DRAW_COUNT, horizon=_HORIZON,
        )
        # Per-cohort surfaces: bit-exact (nothing sums across cohorts to build them).
        for field in _PER_COHORT_FIELDS:
            np.testing.assert_array_equal(
                getattr(combined, field), getattr(full, field),
                err_msg=f'{field} production-combine mismatch at K={k}',
            )
        # Additive aggregates + divide-once rates: within summation-order tolerance.
        for field in _ADDITIVE_AGG_FIELDS + ('f_rate_draws', 'rate_strict'):
            np.testing.assert_allclose(
                getattr(combined, field), getattr(full, field),
                rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
                err_msg=f'{field} production-combine mismatch at K={k}',
            )
        np.testing.assert_allclose(
            combined.ef_rate_draws, full.ef_rate_draws,
            rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL, equal_nan=True,
            err_msg=f'ef_rate_draws production-combine mismatch at K={k}',
        )
        np.testing.assert_allclose(
            combined.applicability_row, full.applicability_row,
            rtol=FLOAT32_AGG_RTOL, atol=FLOAT32_AGG_ATOL,
            err_msg=f'applicability_row production-combine mismatch at K={k}',
        )
        assert (set(combined.evidence_x_strict_by_anchor_tau)
                == set(full.evidence_x_strict_by_anchor_tau))


def test_single_chunk_combine_is_bit_identical():
    """One chunk (the unbounded-default case) must reproduce the un-chunked
    projection bit-for-bit in every row-math field — this is what guarantees
    the default chunk size leaves production output unchanged."""
    from runner.cohort_forecast_v3 import _combine_selected_cohort_projections

    spans = _build_spans()
    full = _project(spans, _selected_cohorts())
    combined = _combine_selected_cohort_projections(
        [full], total_cohort_count=len(_COHORT_SPECS),
        draw_count=_DRAW_COUNT, horizon=_HORIZON,
    )
    fields = _PER_COHORT_FIELDS + _ADDITIVE_AGG_FIELDS + (
        'f_rate_draws', 'rate_strict', 'ef_rate_draws', 'applicability_row',
    )
    for field in fields:
        np.testing.assert_array_equal(
            getattr(combined, field), getattr(full, field),
            err_msg=f'{field} not bit-identical for single-chunk combine',
        )


# ─────────────────────────────────────────────────────────────────────────
# Memory-budget K-solver. ``_solve_cohort_chunk_size`` is pure arithmetic over
# the memory facts supplied by the caller (``budget_bytes`` = container
# ceiling, ``current_rss_bytes`` = already resident). These pin the load-bearing
# *behaviours* (clamp to [1, C]; degenerate to one chunk when it fits; chunk
# when it does not; tighter as cost or resident memory rises) rather than the
# exact coefficients, so re-tuning does not break the suite.
# ─────────────────────────────────────────────────────────────────────────

_GIB = 1024 * 1024 * 1024


def test_solver_always_in_domain_1_to_C():
    """K must be a valid chunk count: at least 1, never more than C, for a
    wide sweep of (C, S, T), budget and resident memory."""
    from runner.cohort_forecast_v3 import _solve_cohort_chunk_size
    for cohorts in (0, 1, 5, 30, 200, 5000):
        for draws in (1, 500, 2000, 8000):
            for horizon in (1, 30, 120):
                for budget, rss in ((2 * _GIB, 0), (2 * _GIB, _GIB), (256 * 1024 * 1024, 0)):
                    k = _solve_cohort_chunk_size(
                        total_cohorts=cohorts, draw_count=draws, horizon=horizon,
                        budget_bytes=budget, current_rss_bytes=rss,
                    )
                    assert isinstance(k, int)
                    assert 1 <= k <= max(cohorts, 1), (
                        f'K={k} out of [1, {max(cohorts, 1)}] for C={cohorts} '
                        f'S={draws} T={horizon} budget={budget} rss={rss}'
                    )


def test_solver_degenerates_to_unbounded_when_it_fits():
    """A request that comfortably fits the headroom must NOT be chunked: K = C,
    one chunk, bit-identical to the un-chunked projection. This is what keeps
    the oracle (small fixtures, or any roomy box) on the unbounded path."""
    from runner.cohort_forecast_v3 import _solve_cohort_chunk_size
    # C=14, S=2000, T=58 on a 2 GiB box with almost nothing resident: fits easily.
    k = _solve_cohort_chunk_size(
        total_cohorts=14, draw_count=2000, horizon=58,
        budget_bytes=2 * _GIB, current_rss_bytes=200 * 1024 * 1024,
    )
    assert k == 14, f'roomy request should run one chunk (K=C=14), got {k}'


def test_solver_chunks_the_oom_request():
    """The heavy C=21 / S=2000 request that OOMs unbounded, run on a 2 GiB box
    with ~0.8 GB already resident (mid cold sweep), must be chunked: 1 <= K < C."""
    from runner.cohort_forecast_v3 import _solve_cohort_chunk_size
    k = _solve_cohort_chunk_size(
        total_cohorts=21, draw_count=2000, horizon=57,
        budget_bytes=int(2 * _GIB * 0.85), current_rss_bytes=850 * 1024 * 1024,
    )
    assert 1 <= k < 21, f'OOM-scale request should chunk (K<C=21), got {k}'


def test_solver_K_tightens_as_resident_memory_rises():
    """The whole point of reading live memory: the more is already resident when
    the projection starts, the smaller the largest K that still fits. K must be
    monotone non-increasing in current_rss for a fixed chunk-eligible request."""
    from runner.cohort_forecast_v3 import _solve_cohort_chunk_size
    ks = [
        _solve_cohort_chunk_size(
            total_cohorts=40, draw_count=2000, horizon=57,
            budget_bytes=int(2 * _GIB * 0.85), current_rss_bytes=rss,
        )
        for rss in (300 * 1024 * 1024, 700 * 1024 * 1024,
                    1100 * 1024 * 1024, 1500 * 1024 * 1024)
    ]
    for earlier, later in zip(ks, ks[1:]):
        assert later <= earlier, f'K rose as resident memory grew: {ks}'


def test_solver_K_is_monotone_non_increasing_in_draw_count():
    """Higher draw count S means each cohort costs more, so the largest K that
    fits can only shrink (or hold) as S grows, for a fixed chunk-eligible C."""
    from runner.cohort_forecast_v3 import _solve_cohort_chunk_size
    ks = [
        _solve_cohort_chunk_size(
            total_cohorts=60, draw_count=s, horizon=58,
            budget_bytes=int(2 * _GIB * 0.85), current_rss_bytes=400 * 1024 * 1024,
        )
        for s in (1000, 2000, 4000, 8000)
    ]
    for earlier, later in zip(ks, ks[1:]):
        assert later <= earlier, f'K rose as S grew: {ks}'


def test_solver_never_zero_under_extreme_pressure():
    """When already-resident memory alone exceeds the budget, the solver returns
    K=1 (best effort), never 0 — a 0 step would hang the chunk loop."""
    from runner.cohort_forecast_v3 import _solve_cohort_chunk_size
    k = _solve_cohort_chunk_size(
        total_cohorts=500, draw_count=2000, horizon=120,
        budget_bytes=int(2 * _GIB * 0.85), current_rss_bytes=2 * _GIB,
    )
    assert k == 1, f'over-budget resident memory should floor at K=1, got {k}'


# ── runtime_memory: live readings the solver consumes ────────────────────────

def test_runtime_memory_readings_are_sane():
    """On the Linux box the suite runs on, both readings must be real positive
    bytes (the projection budget and the live RSS), so the solver consumes facts
    not zeros."""
    from runner import runtime_memory
    budget = runtime_memory.projection_memory_budget_bytes()
    rss = runtime_memory.current_rss_bytes()
    diag = runtime_memory.memory_budget_diagnostics()
    assert budget > 256 * 1024 * 1024, f'budget implausibly small: {budget}'
    assert rss > 0, f'current RSS should be readable on Linux, got {rss}'
    assert diag['budget_bytes'] == budget
    assert diag['current_rss_bytes'] > 0
    assert diag['current_hwm_bytes'] >= diag['current_rss_bytes']
    assert 'budget_source' in diag


def test_runtime_memory_budget_env_override():
    """The single knob: a number sets the budget exactly; 0 means no limit
    (effectively infinite so the solver never chunks); unset auto-detects."""
    import os
    from runner import runtime_memory
    key = 'DAGNET_COHORT_CHUNK_BUDGET_MB'
    saved = os.environ.get(key)
    try:
        os.environ[key] = '2000'
        assert runtime_memory.projection_memory_budget_bytes() == 2000 * 1024 * 1024
        diag = runtime_memory.memory_budget_diagnostics()
        assert diag['budget_source'] == 'override_mb'
        assert diag['budget_bytes'] == 2000 * 1024 * 1024
        os.environ[key] = '0'
        assert runtime_memory.projection_memory_budget_bytes() >= (1 << 62)
        assert runtime_memory.memory_budget_diagnostics()['budget_source'] == 'override_unlimited'
    finally:
        if saved is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = saved
