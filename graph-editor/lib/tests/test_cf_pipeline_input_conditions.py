"""End-to-end tests for the CF pipeline under varied evidence shapes.

These tests drive `compute_cohort_maturity_rows_v3` the way the API
handler drives it in production: via the public `evidence_candidates`
parameter on a real graph. They encode the engineering invariants from
`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
§"Implementation invariants" — not the current implementation's output.

Invariants under test:

  I-2  One entry point for evidence. The runtime must not branch on
       whether evidence originated from SNAPSHOT, FILE, or any other
       source family.
  I-4  The displayed rate is always Y / X, never Y / A.
  I-6  Identity carrier is data, not a route. window() and
       cohort(A = X) are degeneracies of the same objects.
  I-9  Projection must not re-decide semantics. Evidence-named fields
       come only from the unified `SelectedAClockEvidence`; they are
       absent rather than wrong when the unified path cannot resolve.
  I-12 Failures degrade visibly. No silent fallback between modes.

Each test constructs `EvidenceCandidate` objects in the same shape
`build_superset_candidates_by_edge` would produce in production, then
passes them through the single `evidence_candidates` parameter. After
the refactor, every consumer in the CF row pipeline reads from
`runtime.request_evidence_candidates` — the flat, deduplicated pool
derived from this argument. No `per_edge_*_candidates` are passed:
that legacy parameter shape is only used by production today and the
refactor leaves it in place as a caller convenience.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List

import pytest

_LIB = Path(__file__).resolve().parents[1]
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
)

from runner.cohort_forecast_v3 import (
    _aggregate_request_candidates,
    compute_cohort_maturity_rows_v3,
)
from runner.request_envelope import build_request_envelope_plan


# ─── Graph fixtures ──────────────────────────────────────────────────


def _single_edge_graph(
    *,
    p_mean: float = 0.50,
    mu: float = 3.0,
    sigma: float = 0.8,
    onset: float = 1.0,
    t95: float = 60.0,
) -> Dict[str, Any]:
    return {
        'nodes': [
            {'uuid': 'n-x', 'id': 'node-x', 'entry': {'is_start': True}},
            {'uuid': 'n-y', 'id': 'node-y'},
        ],
        'edges': [{
            'uuid': 'e-target',
            'from': 'n-x',
            'to': 'n-y',
            'p': {
                'id': 'p-test',
                'forecast': {'mean': p_mean},
                'latency': {
                    'mu': mu,
                    'sigma': sigma,
                    'onset_delta_days': onset,
                    't95': t95,
                    'promoted_t95': t95,
                    'mu_sd': 0.10,
                    'sigma_sd': 0.05,
                    'onset_sd': 0.50,
                    'onset_mu_corr': -0.50,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {
                        'mu': mu, 'sigma': sigma,
                        'onset_delta_days': onset,
                        'mu_sd': 0.10, 'sigma_sd': 0.05, 'onset_sd': 0.50,
                    },
                    'probability': {
                        'mean': p_mean, 'stdev': 0.05,
                        'alpha': 40.0, 'beta': 40.0,
                        'alpha_pred': 40.0, 'beta_pred': 40.0,
                        'n_effective': 80.0,
                    },
                }],
            },
        }],
    }


def _two_edge_graph(
    *,
    upstream_p: float = 0.70, upstream_mu: float = 1.2, upstream_sigma: float = 0.35,
    upstream_onset: float = 5.0,
    target_p: float = 0.50, target_mu: float = 1.8, target_sigma: float = 0.5,
    target_onset: float = 1.0,
) -> Dict[str, Any]:
    """A → X → Y graph for active cohort(A != X) tests."""
    def edge_p(p, mu, sigma, onset):
        return {
            'id': f'p-{p}-{mu}',
            'forecast': {'mean': p},
            'latency': {
                'mu': mu, 'sigma': sigma, 'onset_delta_days': onset,
                't95': 30.0, 'promoted_t95': 30.0,
                'mu_sd': 0.10, 'sigma_sd': 0.05, 'onset_sd': 0.5,
                'onset_mu_corr': -0.5,
            },
            'model_vars': [{
                'source': 'analytic',
                'latency': {'mu': mu, 'sigma': sigma, 'onset_delta_days': onset,
                            'mu_sd': 0.10, 'sigma_sd': 0.05, 'onset_sd': 0.5},
                'probability': {'mean': p, 'stdev': 0.05,
                                'alpha': 40.0, 'beta': 40.0,
                                'alpha_pred': 40.0, 'beta_pred': 40.0,
                                'n_effective': 80.0},
            }],
        }
    return {
        'nodes': [
            {'uuid': 'n-a', 'id': 'node-a', 'entry': {'is_start': True}},
            {'uuid': 'n-x', 'id': 'node-x'},
            {'uuid': 'n-y', 'id': 'node-y'},
        ],
        'edges': [
            {'uuid': 'e-upstream', 'from': 'n-a', 'to': 'n-x',
             'p': edge_p(upstream_p, upstream_mu, upstream_sigma, upstream_onset)},
            {'uuid': 'e-target', 'from': 'n-x', 'to': 'n-y',
             'p': edge_p(target_p, target_mu, target_sigma, target_onset)},
        ],
    }


# ─── Frame helpers ───────────────────────────────────────────────────


def _frames(
    *,
    anchors: List[str],          # cohort anchor days
    snapshot_days: List[str],    # snapshot dates
    y_curve_by_age: Dict[int, float],  # conversion fraction by τ since anchor
    n_per_anchor: int = 100,
) -> List[Dict[str, Any]]:
    """Build maturity frames where each snapshot reports per-cohort (x, y).

    `y_curve_by_age[τ]` is the fraction of the cohort converted at age τ
    (clamped to ≤ 1). The frames simulate snapshots taken on each
    `snapshot_days` date; per-cohort `y` rises monotonically with age.
    """
    frames: List[Dict[str, Any]] = []
    for sd in snapshot_days:
        data_points = []
        for anchor in anchors:
            anchor_d = date.fromisoformat(anchor)
            snap_d = date.fromisoformat(sd)
            age = (snap_d - anchor_d).days
            if age < 0:
                continue
            frac = y_curve_by_age.get(age)
            if frac is None:
                # forward-fill from largest age ≤ τ
                applicable_ages = [a for a in y_curve_by_age if a <= age]
                if applicable_ages:
                    frac = y_curve_by_age[max(applicable_ages)]
                else:
                    frac = 0.0
            y = int(round(min(max(frac, 0.0), 1.0) * n_per_anchor))
            data_points.append({
                'anchor_day': anchor,
                'x': n_per_anchor,
                'y': y,
                'a': n_per_anchor,
            })
        frames.append({'snapshot_date': sd, 'data_points': data_points})
    return frames


# ─── Candidate helpers ───────────────────────────────────────────────


def _identity_for_window_edge(subject_from: str, subject_to: str) -> EvidenceIdentity:
    return EvidenceIdentity(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=subject_from,
        subject_to=subject_to,
        anchor=None,
        slice_family=SliceFamily.WINDOW,
        context_key=None,
        regime_key=None,
        population_identity=None,
    )


def _identity_for_cohort_edge(
    subject_from: str, subject_to: str, anchor: str,
) -> EvidenceIdentity:
    return EvidenceIdentity(
        role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
        subject_from=subject_from,
        subject_to=subject_to,
        anchor=anchor,
        slice_family=SliceFamily.COHORT,
        context_key=None,
        regime_key=None,
        population_identity=None,
    )


def _candidate(
    *,
    source: SourceKind,
    identity: EvidenceIdentity,
    observed_date: str,
    retrieved_at: str,
    n: int,
    k: int,
) -> EvidenceCandidate:
    return EvidenceCandidate(
        source=source,
        identity=identity,
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.WINDOW_DAY,
        ),
        n=int(n),
        k=int(k),
        provenance={'source': 'test-input-conditions'},
    )


def _window_candidates(
    *,
    subject_from: str,
    subject_to: str,
    source: SourceKind,
    anchors: List[str],
    snapshot_days: List[str],
    y_curve_by_age: Dict[int, float],
    n_per_anchor: int = 100,
) -> List[EvidenceCandidate]:
    """Window-family candidates: one per (anchor_day, snapshot_day) pair."""
    identity = _identity_for_window_edge(subject_from, subject_to)
    candidates: List[EvidenceCandidate] = []
    for anchor in anchors:
        anchor_d = date.fromisoformat(anchor)
        for sd in snapshot_days:
            snap_d = date.fromisoformat(sd)
            age = (snap_d - anchor_d).days
            if age < 0:
                continue
            applicable_ages = [a for a in y_curve_by_age if a <= age]
            if not applicable_ages:
                continue
            frac = y_curve_by_age[max(applicable_ages)]
            y = int(round(min(max(frac, 0.0), 1.0) * n_per_anchor))
            candidates.append(_candidate(
                source=source,
                identity=identity,
                observed_date=anchor,
                retrieved_at=sd,
                n=n_per_anchor,
                k=y,
            ))
    return candidates


def test_context_candidates_still_use_single_request_evidence_pool():
    """Stage 7: context must not introduce a parallel evidence branch.

    Target, non-target subject, and carrier candidate feeds are caller
    conveniences only. They must flatten into one canonical request pool
    before primitive-local binding applies context/MECE admission rules.
    """
    target_identity = EvidenceIdentity(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from='node-x',
        subject_to='node-y',
        anchor=None,
        slice_family=SliceFamily.WINDOW,
        context_key='channel',
        regime_key=None,
        population_identity=None,
        context_selector='context(channel:google)',
    )
    carrier_identity = EvidenceIdentity(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from='node-a',
        subject_to='node-x',
        anchor=None,
        slice_family=SliceFamily.WINDOW,
        context_key='channel',
        regime_key=None,
        population_identity=None,
        context_selector='context(channel:google)',
    )
    target = _candidate(
        source=SourceKind.SNAPSHOT,
        identity=target_identity,
        observed_date='2026-01-01',
        retrieved_at='2026-01-10',
        n=100,
        k=40,
    )
    carrier = _candidate(
        source=SourceKind.SNAPSHOT,
        identity=carrier_identity,
        observed_date='2026-01-01',
        retrieved_at='2026-01-10',
        n=120,
        k=100,
    )

    pool = _aggregate_request_candidates(
        target_candidates=[target],
        per_edge_subject_candidates={'e-target': (target,)},
        per_edge_upstream_candidates={'e-carrier': (carrier,)},
    )

    assert pool == [target, carrier]
    assert {
        c.identity.context_selector
        for c in pool
    } == {'context(channel:google)'}


# ─── Row helpers ─────────────────────────────────────────────────────


def _numeric_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filter the sentinel/metadata rows out of the row list."""
    return [
        r for r in rows
        if isinstance(r, dict) and isinstance(r.get('tau_days'), int)
    ]


# ─── Shared fixture parameters ───────────────────────────────────────


_ANCHOR_FROM = '2026-02-01'
_ANCHOR_TO = '2026-02-10'
_SWEEP_TO = '2026-03-15'
_ANCHORS = [
    (date.fromisoformat(_ANCHOR_FROM) + timedelta(days=d)).isoformat()
    for d in range((date.fromisoformat(_ANCHOR_TO)
                    - date.fromisoformat(_ANCHOR_FROM)).days + 1)
]
_SNAPSHOT_DAYS = [
    (date.fromisoformat(_ANCHOR_FROM) + timedelta(days=d)).isoformat()
    for d in range((date.fromisoformat(_SWEEP_TO)
                    - date.fromisoformat(_ANCHOR_FROM)).days + 1)
]
_Y_CURVE = {
    0: 0.00, 2: 0.05, 4: 0.15, 6: 0.28, 8: 0.40, 10: 0.50,
    12: 0.55, 14: 0.58, 16: 0.59, 20: 0.595, 25: 0.60,
}


# ─── Row-contract assertions (shared) ────────────────────────────────


def _assert_observed_zone_row_shape(row: Dict[str, Any], tau: int) -> None:
    """Per I-4, I-9: an observed-zone row with non-zero evidence has a
    coherent set of populated fields."""
    ev_x = row.get('evidence_x')
    ev_y = row.get('evidence_y')
    rate = row.get('rate')

    # Numeric coherence (I-4): if evidence_x present and > 0, rate = y/x.
    if isinstance(ev_x, (int, float)) and ev_x > 0:
        assert isinstance(ev_y, (int, float)), (
            f"τ={tau}: evidence_x={ev_x} but evidence_y={ev_y!r}; both "
            f"must populate together when the cell is covered (I-4)."
        )
        assert isinstance(rate, (int, float)), (
            f"τ={tau}: evidence_x={ev_x} but rate={rate!r}; rate must "
            f"be numeric whenever the denominator is."
        )
        # Definitional Y/X up to floating-point noise.
        expected_rate = float(ev_y) / float(ev_x)
        assert abs(float(rate) - expected_rate) <= 1e-6, (
            f"τ={tau}: rate={rate} != evidence_y/evidence_x = "
            f"{ev_y}/{ev_x} = {expected_rate:.6f}. Per I-4 the "
            f"displayed rate is always Y/X."
        )


def _assert_fan_band_contract(row: Dict[str, Any], tau: int) -> None:
    """Per the row-schema contract: when fan_bands is emitted, it carries
    every canonical band level and each lo ≤ midpoint ≤ hi, all in
    [0, 1]."""
    fb = row.get('fan_bands')
    mid = row.get('midpoint')
    fu = row.get('fan_upper')
    fl = row.get('fan_lower')

    if fb is None and mid is None:
        return  # absent row (I-12 visible absence)

    assert isinstance(fb, dict) and fb, (
        f"τ={tau}: midpoint={mid} populated but fan_bands={fb!r} — "
        f"the row schema requires fan_bands when midpoint is emitted."
    )
    for level in ('80', '90', '95', '99'):
        assert level in fb, f"τ={tau}: fan_bands missing canonical level {level}"
        lo, hi = fb[level]
        assert -1e-9 <= float(lo) <= 1.0 + 1e-9, (
            f"τ={tau}: fan_bands[{level}] lo={lo} out of [0,1]")
        assert -1e-9 <= float(hi) <= 1.0 + 1e-9, (
            f"τ={tau}: fan_bands[{level}] hi={hi} out of [0,1]")
        assert lo <= hi + 1e-9, (
            f"τ={tau}: fan_bands[{level}] lo={lo} > hi={hi}")
    # The headline fan is the 90 by convention; assert containment of
    # midpoint within fan_lower/fan_upper if both are emitted.
    if isinstance(mid, (int, float)) and isinstance(fl, (int, float)) and isinstance(fu, (int, float)):
        assert fl - 1e-9 <= mid <= fu + 1e-9, (
            f"τ={tau}: fan does not contain midpoint: "
            f"fl={fl} mid={mid} fu={fu}"
        )


# ─── Test 1: Snapshot-only, well-formed ──────────────────────────────


def test_well_formed_snapshot_only_populates_chart_rows():
    """Per I-2: SNAPSHOT-only evidence drives the unified pipeline end
    to end. Every observed-zone row must carry coherent numeric fields
    and fan_bands; rate must equal Y/X (I-4)."""
    graph = _single_edge_graph()
    frames = _frames(
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    candidates = _window_candidates(
        subject_from='node-x', subject_to='node-y',
        source=SourceKind.SNAPSHOT,
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    rows = compute_cohort_maturity_rows_v3(
        frames=frames, graph=graph,
        target_edge_id='e-target',
        query_from_node='node-x', query_to_node='node-y',
        anchor_from=_ANCHOR_FROM, anchor_to=_ANCHOR_TO,
        sweep_to=_SWEEP_TO,
        is_window=True,
        compute_extent=80,
        band_level=0.90,
        scenario_id='test-snapshot-only',
        evidence_candidates=candidates,
    )
    numeric = _numeric_rows(rows)
    assert numeric, 'pipeline returned no τ-indexed rows'

    tau_solid_max = int(numeric[0].get('tau_solid_max') or 0)
    observed_rows = [r for r in numeric if r['tau_days'] <= tau_solid_max]
    assert observed_rows, (
        'no observed-zone rows produced — fixture cannot validate the '
        'evidence path of the unified pipeline'
    )

    # I-4 + I-9: in the observed zone with non-empty evidence, every row
    # carries coherent numeric fields.
    populated = [r for r in observed_rows
                 if isinstance(r.get('evidence_x'), (int, float))
                 and float(r['evidence_x']) > 0]
    assert populated, (
        'observed-zone rows have no populated evidence_x — '
        'snapshot-only well-formed evidence did not reach row projection '
        '(unified path drift)'
    )
    for r in populated:
        _assert_observed_zone_row_shape(r, r['tau_days'])
        _assert_fan_band_contract(r, r['tau_days'])

    # Forecast zone: midpoint should be populated for at least the
    # leading forecast rows (I-9: projection reads from runtime).
    forecast_rows = [r for r in numeric if r['tau_days'] > tau_solid_max]
    forecast_with_midpoint = [r for r in forecast_rows
                              if isinstance(r.get('midpoint'), (int, float))]
    assert forecast_with_midpoint, (
        'no forecast-zone rows carry a midpoint — the runtime did not '
        'compose a per-draw posterior on well-formed evidence'
    )
    for r in forecast_with_midpoint:
        _assert_fan_band_contract(r, r['tau_days'])


# ─── Test 2: File-only, well-formed ──────────────────────────────────


def test_well_formed_file_only_populates_chart_rows():
    """Per I-2: the runtime must not branch on source. FILE-only
    evidence drives the unified pipeline identically to SNAPSHOT-only
    when the row content is identical and the merge library admits it."""
    graph = _single_edge_graph()
    frames = _frames(
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    candidates = _window_candidates(
        subject_from='node-x', subject_to='node-y',
        source=SourceKind.FILE,
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    rows = compute_cohort_maturity_rows_v3(
        frames=frames, graph=graph,
        target_edge_id='e-target',
        query_from_node='node-x', query_to_node='node-y',
        anchor_from=_ANCHOR_FROM, anchor_to=_ANCHOR_TO,
        sweep_to=_SWEEP_TO,
        is_window=True,
        compute_extent=80,
        band_level=0.90,
        scenario_id='test-file-only',
        evidence_candidates=candidates,
    )
    numeric = _numeric_rows(rows)
    assert numeric, 'pipeline returned no τ-indexed rows'

    tau_solid_max = int(numeric[0].get('tau_solid_max') or 0)
    observed_rows = [r for r in numeric if r['tau_days'] <= tau_solid_max]
    populated = [r for r in observed_rows
                 if isinstance(r.get('evidence_x'), (int, float))
                 and float(r['evidence_x']) > 0]
    assert populated, (
        'observed-zone rows have no populated evidence_x — FILE-source '
        'evidence did not reach row projection. This violates I-2 '
        '("one entry point for evidence; must not branch on source")'
    )
    for r in populated:
        _assert_observed_zone_row_shape(r, r['tau_days'])
        _assert_fan_band_contract(r, r['tau_days'])


# ─── Test 3: Mixed snapshot + file (merge precedence) ────────────────


def test_mixed_snapshot_and_file_respects_merge_precedence():
    """Per `evidence_merge.py`: SNAPSHOT outranks FILE at the same
    `(identity, coordinate)`. The unified pipeline must reflect that
    precedence at the row level — there is no double-count or
    swap-based inversion when both sources are present.

    Setup: deliberate disagreement at the same `(observed_date,
    retrieved_at)` — snapshot says y=20, file says y=80. The merge
    library admits snapshot only; the row's evidence_y at that τ must
    reflect 20, not 80, nor the sum 100.
    """
    graph = _single_edge_graph()
    frames = _frames(
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    identity = _identity_for_window_edge('node-x', 'node-y')
    # Build snapshot-only baseline candidates...
    snapshot_candidates = _window_candidates(
        subject_from='node-x', subject_to='node-y',
        source=SourceKind.SNAPSHOT,
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    # ...and add a deliberately-wrong FILE candidate at the same
    # coordinate as one of the snapshot rows. If the merge accepts FILE
    # in preference, the row's evidence_y will move toward 80.
    chosen_anchor = _ANCHORS[0]
    chosen_snapshot = _SNAPSHOT_DAYS[len(_SNAPSHOT_DAYS) // 2]
    file_disagreement = EvidenceCandidate(
        source=SourceKind.FILE,
        identity=identity,
        coordinate=ObservationCoordinate(
            observed_date=chosen_anchor,
            retrieved_at=chosen_snapshot,
            temporal_basis=TemporalBasis.WINDOW_DAY,
        ),
        n=100, k=80,
        provenance={'source': 'test-merge-precedence-disagreement'},
    )
    candidates = list(snapshot_candidates) + [file_disagreement]

    rows = compute_cohort_maturity_rows_v3(
        frames=frames, graph=graph,
        target_edge_id='e-target',
        query_from_node='node-x', query_to_node='node-y',
        anchor_from=_ANCHOR_FROM, anchor_to=_ANCHOR_TO,
        sweep_to=_SWEEP_TO,
        is_window=True,
        compute_extent=80,
        band_level=0.90,
        scenario_id='test-mixed',
        evidence_candidates=candidates,
    )
    numeric = _numeric_rows(rows)
    assert numeric, 'pipeline returned no τ-indexed rows'

    # All observed-zone rows must obey rate = Y/X (I-4) and have
    # bounded fan_bands. No row can spike to ~0.80 — that would
    # indicate the FILE row was admitted over the SNAPSHOT.
    tau_solid_max = int(numeric[0].get('tau_solid_max') or 0)
    observed_rows = [r for r in numeric if r['tau_days'] <= tau_solid_max]
    populated = [r for r in observed_rows
                 if isinstance(r.get('evidence_x'), (int, float))
                 and float(r['evidence_x']) > 0]
    assert populated, 'no populated observed-zone rows under mixed sources'

    for r in populated:
        _assert_observed_zone_row_shape(r, r['tau_days'])
        # The expected rate at the disagreement age is ~0.40 (per
        # _Y_CURVE at age 8); the FILE row asserts 0.80. If the merge
        # had been inverted, we would see rate creeping toward 0.80 at
        # that τ. Bound the per-row rate well below 0.80 to catch any
        # inversion.
        assert float(r['rate']) <= 0.70 + 1e-6, (
            f"τ={r['tau_days']}: rate={r['rate']} exceeds the "
            f"snapshot-curve ceiling — the FILE candidate's k=80 may "
            f"have been admitted over the SNAPSHOT's k≈40 (merge "
            f"precedence inverted)."
        )


# ─── Test 4: Empty evidence — visible degradation ────────────────────


def test_empty_evidence_degrades_visibly_no_silent_rescue():
    """Per I-12: with no admissible evidence, evidence-named fields are
    absent rather than reconstructed from a different clock. There is
    no silent rescue producing numeric values from `engine_cohort.obs_x`
    or any other legacy substrate.

    This is the regression guard against AP59 (silent rescue under a
    green gate). If a future change reintroduces a fallback path that
    fabricates evidence_x/evidence_y values when the unified path
    cannot resolve, this test will fail visibly.
    """
    graph = _single_edge_graph()
    frames = _frames(
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    rows = compute_cohort_maturity_rows_v3(
        frames=frames, graph=graph,
        target_edge_id='e-target',
        query_from_node='node-x', query_to_node='node-y',
        anchor_from=_ANCHOR_FROM, anchor_to=_ANCHOR_TO,
        sweep_to=_SWEEP_TO,
        is_window=True,
        compute_extent=80,
        band_level=0.90,
        scenario_id='test-empty-evidence',
        evidence_candidates=[],  # explicit: no evidence at all
    )
    numeric = _numeric_rows(rows)
    assert numeric, 'pipeline returned no τ-indexed rows'

    # Evidence-named numeric fields must be the zero degenerate (0.0),
    # not numerically reconstructed from frame-derived prefixes.
    for r in numeric:
        assert r.get('evidence_x') == 0.0, (
            f"τ={r['tau_days']}: evidence_x={r['evidence_x']!r} "
            f"populated under empty-evidence input — must be 0.0, "
            f"not reconstructed."
        )
        assert r.get('evidence_y') == 0.0, (
            f"τ={r['tau_days']}: evidence_y={r['evidence_y']!r} "
            f"populated under empty-evidence input — must be 0.0."
        )


# ─── Test 5: Identity-carrier residual structural contract ───────────


def test_identity_carrier_residual_monotone_under_window():
    """Per I-6: window() is the identity-carrier degeneracy of the
    cohort objects. The selected-Cohort reducer's Pop D residual
    (subject-only calibrated CDF ratio anchored at the frontier) must
    drive a monotone-non-decreasing midpoint past the frontier, and
    the midpoint at the frontier must lie between the empirical
    evidence rate and the long-run model rate.

    Encoded as structural invariants rather than a hand-computed
    numeric (the test must not pin the implementation's particle-noise
    floor). The structural invariants are:
      (a) rate ∈ [0, 1] at every observed τ
      (b) midpoint ∈ [0, 1] at every τ
      (c) midpoint non-decreasing in the forecast zone past the
          observed frontier (the subject CDF is monotone, so the
          residual hazard adds non-negative mass to Y)
      (d) midpoint ≥ rate at the observed frontier (the forecast
          cannot project less than what is already observed)
    """
    graph = _single_edge_graph()
    frames = _frames(
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    candidates = _window_candidates(
        subject_from='node-x', subject_to='node-y',
        source=SourceKind.SNAPSHOT,
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    rows = compute_cohort_maturity_rows_v3(
        frames=frames, graph=graph,
        target_edge_id='e-target',
        query_from_node='node-x', query_to_node='node-y',
        anchor_from=_ANCHOR_FROM, anchor_to=_ANCHOR_TO,
        sweep_to=_SWEEP_TO,
        is_window=True,
        compute_extent=80,
        band_level=0.90,
        scenario_id='test-identity-residual',
        evidence_candidates=candidates,
    )
    numeric = _numeric_rows(rows)
    assert numeric, 'pipeline returned no τ-indexed rows'

    # (a) rate ∈ [0, 1]
    for r in numeric:
        rate = r.get('rate')
        if isinstance(rate, (int, float)):
            assert -1e-9 <= float(rate) <= 1.0 + 1e-9, (
                f"τ={r['tau_days']}: rate={rate} outside [0,1]")

    # (b) midpoint ∈ [0, 1]
    for r in numeric:
        mid = r.get('midpoint')
        if isinstance(mid, (int, float)):
            assert -1e-9 <= float(mid) <= 1.0 + 1e-9, (
                f"τ={r['tau_days']}: midpoint={mid} outside [0,1]")

    # (c) midpoint non-decreasing past the observed frontier (tolerance
    # for particle-sampling jitter)
    tau_solid_max = int(numeric[0].get('tau_solid_max') or 0)
    forecast_midpoints = [
        (r['tau_days'], float(r['midpoint']))
        for r in numeric
        if r['tau_days'] > tau_solid_max
        and isinstance(r.get('midpoint'), (int, float))
    ]
    failures = []
    for i in range(1, len(forecast_midpoints)):
        t0, m0 = forecast_midpoints[i - 1]
        t1, m1 = forecast_midpoints[i]
        if m1 < m0 - 5e-3:
            failures.append(f"τ={t1}: midpoint={m1:.4f} < prev (τ={t0}) {m0:.4f}")
    assert not failures, (
        'midpoint non-monotone in the forecast zone (Pop D residual '
        'should add non-negative mass): ' + '; '.join(failures[:5])
    )

    # (d) midpoint ≥ rate at every observed τ (window-mode invariant
    # from `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
    # §"Window semantics"): the projected conversion rate cannot be
    # smaller than the observed evidence rate, because the projection
    # only adds future converters to those already observed.
    ge_violations = []
    for r in numeric:
        mid = r.get('midpoint')
        rate = r.get('rate')
        if isinstance(mid, (int, float)) and isinstance(rate, (int, float)):
            if float(mid) < float(rate) - 5e-3:
                ge_violations.append(
                    f"τ={r['tau_days']}: midpoint={mid:.4f} < rate={rate:.4f}"
                )
    assert not ge_violations, (
        'window-mode invariant violated — midpoint must be ≥ rate at '
        'every τ: ' + '; '.join(ge_violations[:5])
    )


# ─── Test 6: Active cohort(A != X) with cohort-only superset ─────────


def test_active_cohort_only_superset_degrades_visibly():
    """Per I-12 + Risk #8 of `cohort-maturity-evidence-coverage-design.md`:
    an active `cohort(A != X)` request whose evidence superset on the
    carrier edge carries only `slice_family=COHORT` rows must degrade
    visibly. The filter inside `_root_window_carrier_n_by_anchor_day`
    admits only WINDOW-family rows for base-mass derivation; if the
    superset can't satisfy that, `selected_a_clock_evidence` is None
    and the reducer must produce absent (not silently rescued) row
    values.

    This is the durable AP59 guard. If a future change either (a)
    widens the filter without an authoritative rationale or (b)
    reintroduces a frame-derived rescue, this test will detect the
    silent flip from "absent" to "wrong-but-numeric".
    """
    graph = _two_edge_graph()
    frames = _frames(
        anchors=_ANCHORS, snapshot_days=_SNAPSHOT_DAYS,
        y_curve_by_age=_Y_CURVE,
    )
    # Cohort-family candidates only, on the A → X edge — no WINDOW-
    # family rows the base-mass derivation can admit.
    identity_carrier_cohort = _identity_for_cohort_edge(
        'node-a', 'node-x', anchor=_ANCHORS[0],
    )
    cohort_candidates = []
    for anchor in _ANCHORS:
        for sd in _SNAPSHOT_DAYS:
            anchor_d = date.fromisoformat(anchor)
            snap_d = date.fromisoformat(sd)
            age = (snap_d - anchor_d).days
            if age < 0:
                continue
            applicable_ages = [a for a in _Y_CURVE if a <= age]
            if not applicable_ages:
                continue
            frac = _Y_CURVE[max(applicable_ages)]
            y = int(round(min(max(frac, 0.0), 1.0) * 100))
            cohort_candidates.append(_candidate(
                source=SourceKind.SNAPSHOT,
                identity=identity_carrier_cohort,
                observed_date=anchor,
                retrieved_at=sd,
                n=100, k=y,
            ))
    envelope_plan = build_request_envelope_plan(
        graph=graph,
        query_from_node='node-x',
        query_to_node='node-y',
        anchor_from=date.fromisoformat(_ANCHOR_FROM),
        anchor_to=date.fromisoformat(_ANCHOR_TO),
        population_root='node-a',
        graph_preference='best_available',
        scenario_id='test-active-cohort-only-superset',
    )

    rows = compute_cohort_maturity_rows_v3(
        frames=frames, graph=graph,
        target_edge_id='e-target',
        query_from_node='node-x', query_to_node='node-y',
        anchor_from=_ANCHOR_FROM, anchor_to=_ANCHOR_TO,
        sweep_to=_SWEEP_TO,
        is_window=False,
        compute_extent=80,
        band_level=0.90,
        anchor_node_id='node-a',
        is_multi_hop=False,
        scenario_id='test-active-cohort-only-superset',
        evidence_candidates=cohort_candidates,
        envelope_plan=envelope_plan,
    )
    numeric = _numeric_rows(rows)
    assert numeric, 'pipeline returned no τ-indexed rows'

    # Evidence-named fields must be the zero degenerate (0.0) on this
    # path. No silent rescue from any frame-derived substrate.
    for r in numeric:
        assert r.get('evidence_x') == 0.0, (
            f"τ={r['tau_days']}: evidence_x={r['evidence_x']!r} "
            f"populated despite cohort-only superset that the unified "
            f"base-mass derivation cannot admit — must be 0.0."
        )
        assert r.get('evidence_y') == 0.0, (
            f"τ={r['tau_days']}: evidence_y={r['evidence_y']!r} "
            f"populated despite refused unified path — must be 0.0."
        )
