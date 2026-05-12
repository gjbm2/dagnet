"""Active-cohort display invariants — pure-Python pinning tests.

These tests pin four display-semantics invariants the cohort_maturity
chart must obey for active ``cohort(A, X→end)`` queries (A ≠ X). They
are intentionally *blind*: assertions are about structural relationships
the chart must preserve, not specific numerical values from a fixture.

The four invariants:

1. **Covered-day visibility** — for every selected A-day τ at which a
   snapshot was taken, the row must emit ``evidence_x`` and ``evidence_y``
   (each may be 0). "Covered" means a snapshot exists at
   ``retrieved_at = anchor_day + τ``; whether any cohort member has
   reached X yet at that retrieved_at is irrelevant. The chart cannot
   silently drop covered τs. The "no conversions on a covered day" case
   (denominator > 0, numerator = 0) must produce ``rate = 0``, not
   ``None``.

2. **Epoch-B tail** — past ``tau_solid_max``, every τ up to
   ``tau_future_max`` must emit ``evidence_x`` (latest as-of cumulative
   across selected anchors). Evidence does not vanish at the seam. Past
   the seam, the rate-pure denominator freezes at the boundary value
   while the rate (E+F) denominator continues with cumulative ``sum_x``.

3. **Natural seam coupling** — at τ = ``tau_solid_max`` the projected
   midpoint equals the evidence rate by construction. Coupling is
   implicit through the reducer consuming the same observed prefix that
   ``aggregate_by_tau`` emits; no row-builder code stitches the seam.

4. **Evidence-never-exceeds-F+E** — for every τ in epoch A, evidence
   ``rate ≤ midpoint`` within tolerance.

These tests live alongside other unit tests of ``cohort_forecast_v3``
rather than the outside-in oracle suite
(``test_cohort_factorised_outside_in.py``), because they pin pure
display-semantics contracts on the row builder and aggregate, not
numerical truth derivable from raw snapshot DB rows.

Some of these tests are expected to fail under the current
implementation — that is the point. They mark the gap between the
display contract and the live code so that subsequent fixes can land
without regressing the contract.
"""

import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ─── Fixtures ────────────────────────────────────────────────────────────


def _span(*, cdf_draws, p_draws):
    cdf_arr = np.asarray(cdf_draws, dtype=np.float64)
    return SimpleNamespace(
        is_draw_coherent=True,
        cdf_draws=cdf_arr,
        cdf_mean=cdf_arr.mean(axis=0),
        span_p_draws=np.asarray(p_draws, dtype=np.float64),
    )


def _active_runtime(*, subject_cdf, carrier_cdf, p_subj=0.5, p_car=1.0):
    return SimpleNamespace(
        population_root='node-a',
        denominator_node='node-x',
        subject_end='node-y',
        public_moments=SimpleNamespace(
            p_mean=p_subj,
            p_sd=0.05,
            p_sd_epistemic=0.03,
        ),
        unconditioned_overlays={},
        composed_subject=_span(cdf_draws=[subject_cdf], p_draws=[p_subj]),
        composed_carrier=_span(cdf_draws=[carrier_cdf], p_draws=[p_car]),
    )


def _active_cohort(*, a_pop=100.0, frontier_age=0):
    from runner.forecast_state import CohortEvidence

    return CohortEvidence(
        obs_x=[0.0] * (frontier_age + 1),
        obs_y=[0.0] * (frontier_age + 1),
        x_frozen=0.0,
        y_frozen=0.0,
        frontier_age=frontier_age,
        a_pop=a_pop,
    )


def _weighted_primitive(*, edge_id, source, dest, rows):
    """Construct a minimal ConditionedTransitionPrimitive for unit tests.

    Mirrors ``test_selected_cohort_pop_d_distribution._weighted_primitive``;
    duplicated locally to keep this file self-contained.
    """
    from runner.primitives import (
        ConditionedTransitionPrimitive,
        ConditioningStatus,
        DrawFamilyMode,
        PrimitiveScope,
        TimingFamily,
        TransitionIdentity,
        WeightedEvidenceRow,
        WeightedPrimitiveEvidenceView,
    )

    weighted_rows = tuple(
        WeightedEvidenceRow(
            observed_date=str(row['observed_date']),
            retrieved_at=row.get('retrieved_at'),
            n=int(row.get('n', 0)),
            k=int(row.get('k', 0)),
            arrival_weight=float(row.get('arrival_weight', 1.0)),
            n_weighted=float(row.get('n_weighted', row.get('n', 0))),
            k_weighted=float(row.get('k_weighted', row.get('k', 0))),
            root_day_shares=dict(row.get('root_day_shares', {})),
        )
        for row in rows
    )
    weighted = WeightedPrimitiveEvidenceView(
        n_weighted_total=float(sum(r.n_weighted for r in weighted_rows)),
        k_weighted_total=float(sum(r.k_weighted for r in weighted_rows)),
        rows=weighted_rows,
        arrival_weight_summary={'topology_case': 'test'},
        binding_policy='test_binding',
        evidence_scope_key=f'scope:{edge_id}',
    )
    return ConditionedTransitionPrimitive(
        transition=TransitionIdentity(
            source_node=source,
            destination_node=dest,
            edge_id=edge_id,
        ),
        scope=PrimitiveScope(
            scenario_id='test',
            evidence_role='window_subject_helper',
            date_from='2026-03-01',
            date_to='2026-03-31',
            as_at=None,
            context_key=None,
            regime_key=None,
            model_source_preference='best_available',
            resolved_source_identity='test',
        ),
        draw_count=1,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=f'scope:{edge_id}',
        weighted_evidence=weighted,
        effective_evidence_totals=(
            weighted.n_weighted_total, weighted.k_weighted_total,
        ),
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=None,
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=None,
        prior_source='test',
    )


# ─── INVARIANT 1 — covered-day visibility ────────────────────────────────


def test_aggregate_emits_bucket_for_covered_day_with_zero_denominator():
    """A snapshot-covered A-day must aggregate even when carrier mass is 0.

    'Covered' = a snapshot was taken at retrieved_at = anchor_day + τ. If
    at that retrieved_at no cohort member has reached X yet, the cell
    has ``x_at_query_x = 0`` but should still be reported. The chart needs
    to know the day was observed; the data layer cannot omit it.

    Failure today: ``aggregate_by_tau`` filters per-anchor cells with
    ``x_at_query_x <= 0`` and then filters buckets where ``sum_x <= 0``,
    so a covered-but-zero day is silently dropped.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
    )

    cells = {
        '2026-03-01': {
            2: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=2,
                x_at_query_x=0.0,
                y_at_subject_end=0.0,
                source='test_covered_zero',
            ),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='test_covered_zero',
    )

    aggregate = selected.aggregate_by_tau(tau_solid_max=2, max_tau=5)

    assert 2 in aggregate, (
        'Aggregate must emit a bucket for a covered τ even when carrier '
        'mass is zero. The chart must surface the fact that the day was '
        'observed; "no observations yet" and "not observed at all" are '
        'different states and the data layer cannot conflate them.'
    )
    bucket = aggregate[2]
    assert float(bucket['sum_x']) == 0.0
    assert float(bucket['sum_y']) == 0.0
    assert float(bucket.get('n_cohorts', 0.0)) >= 1.0, (
        'Bucket must record that at least one selected anchor day was '
        'covered at this τ.'
    )


def test_observed_span_surface_keeps_zero_k_weighted_rows():
    """Primitive rows with n_weighted > 0 but k_weighted = 0 must yield cells.

    A row represents one (observed_date, retrieved_at) snapshot. If the
    snapshot covered the cohort but no member has reached the destination
    yet, the cell must record ``observed_count = 0`` rather than be
    discarded as off-clock.

    Failure today: ``_build_observed_span_evidence_surface`` filters
    ``value <= 0`` (where ``value = k_weighted``) and ``count <= 0`` from
    the topology max-flow, so a covered snapshot with zero conversions is
    silently dropped.
    """
    from runner.cohort_forecast_v3 import (
        _build_observed_span_evidence_surface,
    )

    primitive = _weighted_primitive(
        edge_id='a-to-x',
        source='node-a',
        dest='node-x',
        rows=[{
            'observed_date': '2026-03-01',
            'retrieved_at': '2026-03-03',
            'n': 100,
            'k': 0,
            'n_weighted': 100.0,
            'k_weighted': 0.0,
            'root_day_shares': {'2026-03-01': 1.0},
        }],
    )
    graph = {
        'nodes': [{'id': 'node-a'}, {'id': 'node-x'}],
        'edges': [{'from': 'node-a', 'to': 'node-x', 'id': 'a-to-x'}],
    }
    runtime = SimpleNamespace(graph=graph)

    surface, _buckets = _build_observed_span_evidence_surface(
        runtime=runtime,
        role='carrier_a_to_x',
        root_node='node-a',
        end_node='node-x',
        primitives=[primitive],
        anchor_days=['2026-03-01'],
        max_tau=4,
    )

    assert surface is not None and surface.has_cells(), (
        'Surface must record a cell at the covered τ '
        '(snapshot - anchor) even when no cohort member has reached the '
        'destination yet. The "covered" signal cannot be conflated with '
        '"observed_count > 0".'
    )
    cells = surface.cells_by_anchor_day.get('2026-03-01', {})
    assert 2 in cells
    assert float(cells[2].observed_count) == 0.0


def test_active_row_emits_evidence_for_covered_day_with_zero_numerator():
    """An A-day with carrier x>0 but no conversions must show rate=0, not None.

    This is the common 'no conversions on a covered day' case: the cohort
    has reached X but not yet converted to Y. The row must emit
    ``evidence_y = 0`` (numeric) and ``rate = 0`` (numeric), not ``None``.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.0, 0.0, 0.0, 0.10, 0.30],
        carrier_cdf=[0.0, 0.50, 1.00, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-03',
                'data_points': [{
                    'anchor_day': '2026-03-01',
                    'x': 50.0,
                    'y': 0.0,
                    'data_retrieved_at': '2026-03-03',
                }],
            },
        ],
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=2,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}
    row = by_tau[2]

    assert isinstance(row['evidence_x'], (int, float)), (
        'Active row at covered τ must emit numeric evidence_x, '
        f'got {row["evidence_x"]!r}'
    )
    assert isinstance(row['evidence_y'], (int, float)), (
        'Active row with zero conversions must emit numeric evidence_y=0, '
        f'not None. Got {row["evidence_y"]!r}'
    )
    assert isinstance(row['rate'], (int, float)), (
        'Active row with zero conversions must emit numeric rate=0, not '
        f'None. Got {row["rate"]!r}'
    )
    assert float(row['evidence_y']) == 0.0
    assert float(row['rate']) == 0.0


def test_active_row_emits_evidence_for_covered_day_with_zero_denominator():
    """A covered A-day with no carrier mass yet must still emit an evidence row.

    Even when ``x_at_query_x = 0`` (no cohort member has reached X yet),
    the row must surface ``evidence_x`` and ``evidence_y`` as numeric
    zeros, not ``None``. ``rate`` may be ``None`` (0/0 undefined), but
    the row must still report the day was covered.

    Failure today: combination of the cell-builder filter, the aggregate
    filter, and the row builder's ``rate_x > 0 else None`` gate erases
    the covered day end-to-end.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.0, 0.0, 0.05, 0.20, 0.40],
        carrier_cdf=[0.0, 0.0, 0.10, 0.50, 0.90, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    cells = {
        '2026-03-01': {
            2: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=2,
                x_at_query_x=0.0,
                y_at_subject_end=0.0,
                source='test_covered_zero',
                data_retrieved_at='2026-03-03',
            ),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='test_covered_zero',
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=2,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}
    row = by_tau[2]

    assert isinstance(row['evidence_x'], (int, float)), (
        'Active row at covered τ must emit numeric evidence_x even when '
        f'no carrier mass has arrived yet. Got {row["evidence_x"]!r}. The '
        '"covered" signal must propagate through aggregate and row builder '
        'rather than being conflated with "observed_count > 0".'
    )
    assert isinstance(row['evidence_y'], (int, float)), (
        f'evidence_y must be numeric (0), not {row["evidence_y"]!r}'
    )


# ─── INVARIANT 2 — epoch-B tail ──────────────────────────────────────────


def test_aggregate_carries_forward_through_epoch_b():
    """Past tau_solid_max, latest-as-of cells per anchor still aggregate.

    ``aggregate_by_tau`` must continue emitting buckets through epoch B
    via cell carry-forward. Past the seam, ``denominator_pure`` freezes
    at the boundary while ``denominator_fe`` follows cumulative ``sum_x``.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
    )

    cells = {
        '2026-03-01': {
            5: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=5,
                x_at_query_x=80.0,
                y_at_subject_end=20.0,
                source='test',
            ),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='test',
    )

    aggregate = selected.aggregate_by_tau(tau_solid_max=10, max_tau=20)

    missing = [tau for tau in range(5, 21) if tau not in aggregate]
    assert not missing, (
        f'Aggregate must carry forward through epoch B; missing τ: {missing}. '
        'Once any anchor has its first observation, every later τ up to '
        'max_tau must contain a bucket.'
    )

    seam_x = aggregate[10]['sum_x']
    pure_failures: list[str] = []
    fe_failures: list[str] = []
    for tau in range(11, 21):
        bucket = aggregate[tau]
        if 'denominator_pure' in bucket and (
            float(bucket['denominator_pure']) != pytest.approx(float(seam_x))
        ):
            pure_failures.append(
                f'τ={tau}: denominator_pure={bucket["denominator_pure"]!r} '
                f'must freeze at boundary={seam_x!r}'
            )
        if 'denominator_fe' in bucket and (
            float(bucket['denominator_fe']) != pytest.approx(float(bucket['sum_x']))
        ):
            fe_failures.append(
                f'τ={tau}: denominator_fe={bucket["denominator_fe"]!r} '
                f'must equal cumulative sum_x={bucket["sum_x"]!r}'
            )
    assert not pure_failures, '\n'.join(pure_failures)
    assert not fe_failures, '\n'.join(fe_failures)


def test_active_row_emits_evidence_x_through_epoch_b():
    """Active rows must emit non-None evidence_x for every τ in epoch B.

    End-to-end pin: from the first observation tau through tau_future_max,
    every row must surface evidence_x. The line cannot vanish at the
    seam.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95, 1.00, 1.00],
        carrier_cdf=[0.0, 0.50, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-03',
                'data_points': [{
                    'anchor_day': '2026-03-01',
                    'x': 50.0,
                    'y': 5.0,
                    'data_retrieved_at': '2026-03-03',
                }],
            },
        ],
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=7,
        tau_solid_max=2,
        tau_future_max=7,
        sweep_to='2026-03-08',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}

    missing = [
        tau for tau in range(2, 8)
        if by_tau[tau]['evidence_x'] is None
    ]
    assert not missing, (
        f'Active row evidence_x must persist through epoch B; missing '
        f'(set to None): {missing}. Past the seam the latest-as-of '
        'observed denominator carries forward.'
    )


# ─── INVARIANT 3 — natural seam coupling ─────────────────────────────────


def test_seam_rate_equals_seam_midpoint_via_observed_prefix_coupling():
    """At τ = tau_solid_max, evidence rate equals projected midpoint.

    The reducer's pre-frontier loop seeds ``Y_total`` / ``X_total`` from
    the same observed selected prefix that ``aggregate_by_tau`` emits, so
    at τ = frontier the projection mechanically equals the observed
    rate. The row builder does not stitch this; equality emerges from
    the reducer consuming the same prefix object the aggregate publishes.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95],
        carrier_cdf=[0.0, 0.20, 0.50, 0.80, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-03',
                'data_points': [{
                    'anchor_day': '2026-03-01',
                    'x': 40.0,
                    'y': 4.0,
                    'data_retrieved_at': '2026-03-03',
                }],
            },
        ],
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=2,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    seam = next(r for r in rows if int(r['tau_days']) == 2)

    assert seam['rate'] is not None and seam['midpoint'] is not None, (
        'Seam row must produce both a rate and a midpoint when the '
        'cohort has selected A-clock observations.'
    )
    diff = abs(float(seam['rate']) - float(seam['midpoint']))
    assert diff < 1e-9, (
        f'Seam coupling violated: |rate - midpoint| = {diff:.9f}. '
        f'rate={seam["rate"]!r} midpoint={seam["midpoint"]!r}. '
        'The reducer must consume the same observed prefix the aggregate '
        'emits, so rate = midpoint at τ = tau_solid_max by construction.'
    )


def test_no_observed_prefix_means_no_coupling_and_no_evidence():
    """When SelectedAClockEvidence has no cells, both display and reducer
    fall back consistently — the chart shows no evidence row but the
    midpoint must still be produced.

    This pins the contract between aggregate-emits and reducer-consumes:
    when there is no observed prefix to couple them, the chart must
    degrade with evidence absent rather than producing a model line that
    visually impersonates evidence.
    """
    from runner.cohort_forecast_v3 import _project_runtime_rows

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95],
        carrier_cdf=[0.0, 0.20, 0.50, 0.80, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[0],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=0,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=None,
    )
    by_tau = {int(r['tau_days']): r for r in rows}

    for tau in range(6):
        row = by_tau[tau]
        assert row['evidence_x'] is None, (
            f'Without selected A-clock evidence the chart must not '
            f'fabricate evidence values; τ={tau} got '
            f'{row["evidence_x"]!r}'
        )
        assert row['evidence_y'] is None, (
            f'τ={tau} evidence_y must be None when there is no observed '
            f'selected evidence; got {row["evidence_y"]!r}'
        )


# ─── INVARIANT 4 — evidence ≤ F+E ────────────────────────────────────────


def test_evidence_rate_never_exceeds_midpoint_in_epoch_a():
    """In epoch A, evidence rate ≤ projected midpoint at every τ.

    Evidence rate is mass-first ``ΣY/ΣX`` over selected anchors using the
    aggregate's latest-as-of cells. Midpoint is mass-first ``ΣY/ΣX`` over
    selected cohorts using the reducer's per-particle output. Both
    consume the same observed prefix at τ ≤ frontier, so the projection
    cannot lie below observed within epoch A.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95, 1.00],
        carrier_cdf=[0.0, 0.30, 0.70, 1.00, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-02',
                'data_points': [{
                    'anchor_day': '2026-03-01',
                    'x': 30.0,
                    'y': 3.0,
                    'data_retrieved_at': '2026-03-02',
                }],
            },
            {
                'snapshot_date': '2026-03-04',
                'data_points': [{
                    'anchor_day': '2026-03-01',
                    'x': 70.0,
                    'y': 12.0,
                    'data_retrieved_at': '2026-03-04',
                }],
            },
        ],
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[3],
        cohort_weights=[100.0],
        max_tau=6,
        tau_solid_max=3,
        tau_future_max=6,
        sweep_to='2026-03-07',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )

    failures: list[str] = []
    for row in rows:
        tau = int(row['tau_days'])
        if tau > 3:
            continue
        rate = row['rate']
        midpoint = row['midpoint']
        if rate is None or midpoint is None:
            continue
        if float(rate) > float(midpoint) + 1e-9:
            failures.append(
                f'τ={tau}: evidence rate={float(rate):.6f} > '
                f'midpoint={float(midpoint):.6f}'
            )
    assert not failures, (
        'Evidence rate must not exceed the F+E midpoint in epoch A. '
        'Both surfaces consume the same observed selected prefix; if the '
        'projection falls below observed in epoch A, the reducer is not '
        'reading the same prefix the aggregate emits:\n'
        + '\n'.join(failures)
    )


def test_evidence_rate_never_exceeds_midpoint_at_any_tau():
    """Across the full row range, evidence rate ≤ midpoint within tolerance.

    A weaker but stricter-shaped invariant than the epoch-A version: the
    evidence circles must never land above the F+E line anywhere on the
    chart. Past the seam, the projection's epoch-B continuation
    monotonically adds Pop C numerator mass; observed rate carries
    forward but cannot overtake.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95, 1.00, 1.00],
        carrier_cdf=[0.0, 0.30, 0.70, 1.00, 1.00, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    selected = SelectedAClockEvidence.from_frames(
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        selected_evidence_frames=[
            {
                'snapshot_date': '2026-03-04',
                'data_points': [{
                    'anchor_day': '2026-03-01',
                    'x': 70.0,
                    'y': 14.0,
                    'data_retrieved_at': '2026-03-04',
                }],
            },
        ],
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[3],
        cohort_weights=[100.0],
        max_tau=7,
        tau_solid_max=3,
        tau_future_max=7,
        sweep_to='2026-03-08',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )

    failures: list[str] = []
    for row in rows:
        tau = int(row['tau_days'])
        rate = row['rate']
        midpoint = row['midpoint']
        if rate is None or midpoint is None:
            continue
        if float(rate) > float(midpoint) + 1e-9:
            failures.append(
                f'τ={tau}: evidence rate={float(rate):.6f} > '
                f'midpoint={float(midpoint):.6f}'
            )
    assert not failures, (
        'Evidence circles must not appear above the F+E line:\n'
        + '\n'.join(failures)
    )


# ─── INVARIANT 5 — coverage signal (design §2 + §3.2) ────────────────────


def test_coverage_is_one_in_epoch_a_with_dense_daily_snapshots():
    """Per design §2.4 property 1: with dense daily snapshots through
    epoch A, every selected cohort produces a fresh row at every τ ≤
    tau_solid_max. Per-cohort capped share = 1.0; aggregate
    coverage = sum / |admissible| = 1.0 across epoch A.

    Single-cohort fixture; two snapshots at τ=1 and τ=2 cover the entire
    pre-seam range. n_cohorts_in_scope = 1 since the cohort has positive
    a_pop. The chart's evidence-line symbol opacity should not be
    coverage-attenuated in this regime.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95],
        carrier_cdf=[0.0, 0.30, 0.70, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    cells = {
        '2026-03-01': {
            1: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=1,
                x_at_query_x=30.0,
                y_at_subject_end=3.0,
                source='dense_synth',
                data_retrieved_at='2026-03-02',
                carrier_landing_coverage=1.0,
                subject_landing_coverage=1.0,
            ),
            2: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=2,
                x_at_query_x=70.0,
                y_at_subject_end=14.0,
                source='dense_synth',
                data_retrieved_at='2026-03-03',
                carrier_landing_coverage=1.0,
                subject_landing_coverage=1.0,
            ),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='dense_synth',
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=2,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}

    for tau in (1, 2):
        row = by_tau[tau]
        assert row['coverage'] == pytest.approx(1.0), (
            f'τ={tau}: epoch-A coverage with dense daily snapshots must '
            f'be 1.0 (every admissible cohort contributing a fresh row). '
            f'Got {row["coverage"]!r}.'
        )
        assert row['evidence_x_coverage'] == pytest.approx(1.0)
        assert row['evidence_y_coverage'] == pytest.approx(1.0)


def test_coverage_decays_smoothly_as_cohorts_age_past_last_snapshot():
    """Per design §2.4 property 3: past tau_solid_max, cohorts age past
    their last snapshot one by one. Each running-out drops aggregate
    coverage by 1/|cohorts in scope|.

    Three cohorts; each has its own last-snapshot τ. At τ in epoch A,
    all three contribute fresh rows → coverage = 1. As τ moves past
    each cohort's last snapshot, coverage drops to 2/3, 1/3, 0.
    Forward-fill of value still works (sum_x carries forward), but
    `coverage` (a freshness signal) drops.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95, 1.00, 1.00],
        carrier_cdf=[0.0, 0.50, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00],
    )
    cohorts = [
        _active_cohort(a_pop=100.0, frontier_age=0),
        _active_cohort(a_pop=100.0, frontier_age=0),
        _active_cohort(a_pop=100.0, frontier_age=0),
    ]
    # Cohort 'A' last fresh snapshot at τ=1; 'B' at τ=2; 'C' at τ=3.
    # Past each cohort's last snapshot, no fresh row → 0 contribution
    # to coverage even though forward-filled value stays nonzero.
    def _cell(tau, x, y):
        return SelectedAClockEvidenceCell(
            anchor_day='unused',  # overwritten via dict key
            tau=tau,
            x_at_query_x=x,
            y_at_subject_end=y,
            source='decay_synth',
            carrier_landing_coverage=1.0,
            subject_landing_coverage=1.0,
        )

    cells = {
        '2026-03-01': {1: _cell(1, 50.0, 5.0)},
        '2026-03-02': {1: _cell(1, 50.0, 5.0), 2: _cell(2, 60.0, 8.0)},
        '2026-03-03': {
            1: _cell(1, 50.0, 5.0),
            2: _cell(2, 60.0, 8.0),
            3: _cell(3, 70.0, 12.0),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-03',
        source='decay_synth',
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=cohorts,
        cohort_list=[
            {'anchor_day': '2026-03-01'},
            {'anchor_day': '2026-03-02'},
            {'anchor_day': '2026-03-03'},
        ],
        cohort_eval_ages=[3, 3, 3],
        cohort_weights=[100.0, 100.0, 100.0],
        max_tau=5,
        tau_solid_max=3,
        tau_future_max=5,
        sweep_to='2026-03-08',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}

    # τ=1: all three cohorts have a fresh row → coverage = 3/3 = 1.
    assert by_tau[1]['coverage'] == pytest.approx(1.0)
    # τ=2: cohort A has aged past τ=1 (no exact-τ=2 cell), B and C have
    # τ=2 fresh rows → coverage = 2/3.
    assert by_tau[2]['coverage'] == pytest.approx(2.0 / 3.0)
    # τ=3: only cohort C has a fresh τ=3 row → coverage = 1/3.
    assert by_tau[3]['coverage'] == pytest.approx(1.0 / 3.0)
    # τ=4 and beyond: no cohort has a fresh row at exact τ. Bucket
    # still emits (forward-filled values), so coverage = 0/3 = 0.
    assert by_tau[4]['coverage'] == pytest.approx(0.0)
    assert by_tau[5]['coverage'] == pytest.approx(0.0)
    # Forward-filled value persists even when coverage = 0 (covered-
    # but-stale).
    assert by_tau[5]['evidence_x'] is not None
    assert float(by_tau[5]['evidence_x']) > 0


def test_coverage_is_fractional_under_partial_share_placement():
    """Per design §2.4 property 4: subject rows distributed across
    multiple anchors via the join-conditioned carrier backmap produce
    fractional per-cell shares. A cell with ``carrier_landing_coverage =
    0.4`` (sum of placement shares from rows landing at exactly that τ
    is 0.4) contributes 0.4 to the per-cohort sum; aggregated across
    cohorts and divided by |admissible|, the displayed coverage is
    fractional.

    Single cohort with a deliberately fractional landing coverage
    confirms the aggregate honours fractional contributions rather than
    binarising them.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95],
        carrier_cdf=[0.0, 0.30, 0.70, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    cells = {
        '2026-03-01': {
            2: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=2,
                x_at_query_x=30.0,
                y_at_subject_end=3.0,
                source='fractional_share_synth',
                # Partial backmap allocation — only 0.4 of the row's
                # placement weight landed onto this anchor at τ=2.
                carrier_landing_coverage=0.4,
                subject_landing_coverage=0.4,
            ),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='fractional_share_synth',
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=2,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}
    row = by_tau[2]

    assert row['coverage'] == pytest.approx(0.4), (
        f'Fractional landing coverage must surface at the row level. '
        f'sum_carrier_coverage = 0.4 / n_cohorts_in_scope = 1 → 0.4. '
        f'Got {row["coverage"]!r}.'
    )
    assert row['evidence_x_coverage'] == pytest.approx(0.4)
    assert row['evidence_y_coverage'] == pytest.approx(0.4)


def test_subject_coverage_source_day_support_sums_to_one_when_dense():
    """Coverage sums over required source-row support, not row mass.

    One A cohort can reach X on two source days before the same snapshot
    age: 40% on 2-Mar and 60% on 3-Mar. If both subject source rows are
    present at the snapshot, the subject-side coverage for that
    (cohort, τ) cell is 0.4 + 0.6 = 1.0 even though the observed subject
    count may be zero. This is the epoch-A clean-fixture contract:
    latency tells us which source rows are required; dense retrievals
    cover all of them.
    """
    from runner.cohort_forecast_v3 import (
        _PriorCarrierBackmap,
        _build_observed_span_evidence_surface,
    )

    primitive = _weighted_primitive(
        edge_id='b-to-c',
        source='node-b',
        dest='node-c',
        rows=[
            {
                'observed_date': '2026-03-02',
                'retrieved_at': '2026-03-03',
                'n': 100,
                'k': 0,
                'n_weighted': 100.0,
                'k_weighted': 0.0,
                'root_day_shares': {'2026-03-02': 1.0},
            },
            {
                'observed_date': '2026-03-03',
                'retrieved_at': '2026-03-03',
                'n': 100,
                'k': 0,
                'n_weighted': 100.0,
                'k_weighted': 0.0,
                'root_day_shares': {'2026-03-03': 1.0},
            },
        ],
    )
    runtime = SimpleNamespace(
        graph={
            'nodes': [{'id': 'node-b'}, {'id': 'node-c'}],
            'edges': [{'from': 'node-b', 'to': 'node-c', 'id': 'b-to-c'}],
        },
    )
    carrier_backmap = _PriorCarrierBackmap(
        anchor_days=('2026-03-01',),
        carrier_pmf_by_anchor={'2026-03-01': (0.0, 0.4, 0.6)},
    )

    surface, _buckets = _build_observed_span_evidence_surface(
        runtime=runtime,
        role='subject_x_to_end_on_a_clock',
        root_node='node-b',
        end_node='node-c',
        primitives=[primitive],
        anchor_days=['2026-03-01'],
        max_tau=3,
        root_day_to_anchor_weights=carrier_backmap,
    )

    assert surface is not None and surface.has_cells()
    cell = surface.cells_by_anchor_day['2026-03-01'][2]
    assert cell.observed_count == pytest.approx(0.0)
    assert cell.landing_coverage == pytest.approx(1.0), (
        'Dense source rows across the carrier latency support must cover '
        'the whole (cohort, τ) cell: 0.4 + 0.6 = 1.0. Coverage must not '
        'fade merely because the subject rows are zero-valued.'
    )


def test_subject_coverage_drops_when_source_day_support_is_missing():
    """Missing source rows reduce coverage by missing support weight.

    Same carrier support as the dense test (40% on 2-Mar, 60% on 3-Mar),
    but only the 2-Mar source row is present at the snapshot. Coverage is
    therefore 0.4, not 1.0. This is the real sparseness signal the chart
    should fade for.
    """
    from runner.cohort_forecast_v3 import (
        _PriorCarrierBackmap,
        _build_observed_span_evidence_surface,
    )

    primitive = _weighted_primitive(
        edge_id='b-to-c',
        source='node-b',
        dest='node-c',
        rows=[{
            'observed_date': '2026-03-02',
            'retrieved_at': '2026-03-03',
            'n': 100,
            'k': 0,
            'n_weighted': 100.0,
            'k_weighted': 0.0,
            'root_day_shares': {'2026-03-02': 1.0},
        }],
    )
    runtime = SimpleNamespace(
        graph={
            'nodes': [{'id': 'node-b'}, {'id': 'node-c'}],
            'edges': [{'from': 'node-b', 'to': 'node-c', 'id': 'b-to-c'}],
        },
    )
    carrier_backmap = _PriorCarrierBackmap(
        anchor_days=('2026-03-01',),
        carrier_pmf_by_anchor={'2026-03-01': (0.0, 0.4, 0.6)},
    )

    surface, _buckets = _build_observed_span_evidence_surface(
        runtime=runtime,
        role='subject_x_to_end_on_a_clock',
        root_node='node-b',
        end_node='node-c',
        primitives=[primitive],
        anchor_days=['2026-03-01'],
        max_tau=3,
        root_day_to_anchor_weights=carrier_backmap,
    )

    assert surface is not None and surface.has_cells()
    cell = surface.cells_by_anchor_day['2026-03-01'][2]
    assert cell.observed_count == pytest.approx(0.0)
    assert cell.landing_coverage == pytest.approx(0.4), (
        'Only the 40% source-day support row is present, so coverage must '
        'be 0.4. This catches regressions that binarise any observed row '
        'to full coverage.'
    )


def test_carrier_and_subject_coverage_vary_independently():
    """Per design §3.4 (field separation) and §2.3 (per-row min):
    `evidence_x_coverage` and `evidence_y_coverage` are semantically
    independent fields — the carrier-side and subject-side per-cohort
    placement shares can differ at the same (cohort, τ) cell. This
    happens whenever the join-conditioned carrier backmap distributes
    a subject row across multiple anchors (latency-distribution
    smoothing, §2.4 property 4): the carrier surface keeps full unit
    landing on each anchor, while the subject surface picks up only
    the backmap-allocated fraction.

    The row builder must surface both fields with their per-role values
    and compute `coverage = min(carrier, subject)`. A test that asserts
    `coverage_x == coverage_y` tautologically would not catch the
    pre-fix bug where both fields collapsed onto a single boolean
    freshness flag.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        SelectedAClockEvidenceCell,
        _project_runtime_rows,
    )

    runtime = _active_runtime(
        subject_cdf=[0.0, 0.10, 0.30, 0.60, 0.85, 0.95],
        carrier_cdf=[0.0, 0.30, 0.70, 1.00, 1.00, 1.00],
    )
    cohort = _active_cohort(a_pop=100.0, frontier_age=0)
    cells = {
        '2026-03-01': {
            2: SelectedAClockEvidenceCell(
                anchor_day='2026-03-01',
                tau=2,
                x_at_query_x=30.0,
                y_at_subject_end=3.0,
                source='asymmetric_share_synth',
                # Carrier landed in full (1.0) but the subject row's
                # share fanned across multiple anchors, leaving 0.6 on
                # this anchor at this τ.
                carrier_landing_coverage=1.0,
                subject_landing_coverage=0.6,
            ),
        },
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='asymmetric_share_synth',
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau={},
        engine_cohorts=[cohort],
        cohort_list=[{'anchor_day': '2026-03-01'}],
        cohort_eval_ages=[2],
        cohort_weights=[100.0],
        max_tau=5,
        tau_solid_max=2,
        tau_future_max=5,
        sweep_to='2026-03-06',
        band_level=0.90,
        selected_a_clock_evidence=selected,
    )
    by_tau = {int(r['tau_days']): r for r in rows}
    row = by_tau[2]

    assert row['evidence_x_coverage'] == pytest.approx(1.0), (
        f'Carrier-side coverage must reflect the carrier surface\'s '
        f'per-cohort landing share (1.0 here). '
        f'Got {row["evidence_x_coverage"]!r}.'
    )
    assert row['evidence_y_coverage'] == pytest.approx(0.6), (
        f'Subject-side coverage must reflect the post-backmap subject '
        f'surface share (0.6 here). '
        f'Got {row["evidence_y_coverage"]!r}.'
    )
    assert row['coverage'] == pytest.approx(0.6), (
        f'Per-row coverage = min(evidence_x_coverage, evidence_y_coverage) '
        f'per design §2.3. min(1.0, 0.6) = 0.6. '
        f'Got {row["coverage"]!r}.'
    )
    # Field independence (§3.4): the two role coverages MUST differ
    # under asymmetric per-role shares — a tautological equality would
    # mask the boolean-collapse bug.
    assert row['evidence_x_coverage'] != row['evidence_y_coverage'], (
        f'evidence_x_coverage and evidence_y_coverage must vary '
        f'independently per design §3.4. Got both = '
        f'{row["evidence_x_coverage"]!r}.'
    )
