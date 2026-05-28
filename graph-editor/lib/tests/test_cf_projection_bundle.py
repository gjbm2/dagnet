"""Phase 2 (73q) — the shared CF projection bundle.

The public row function becomes "build bundle → tau reducer"; the date
reducer (73q Phase 3) becomes "build bundle → date reducer". This suite
pins the Phase 2 "complete when" bundle contract:

  - the bundle's per-Cohort FC arrays cover ``fe.saturation_tau`` when it
    exceeds ``fe.max_tau``, while public cohort-maturity rows still emit
    only through ``fe.max_tau`` (§"Saturation tau");
  - the bundle exposes ``cf_mode`` / ``cf_reason`` / ``promoted_source``
    as explicit fields, sourced from the resolved model object (not by
    scraping ``runtime_provenance``);
  - active/observed Cohorts with no root-window carrier evidence stay
    present in an ordered per-Cohort projection-status list (aligned 1:1
    with cohort_list) with a reason and a null projection_index — the
    safe index map the date reducer needs (skipped-Cohort visibility AND
    alignment, §"Per-Cohort un-aggregation");
  - the bundle exposes the shared latency-band tau set and per-Cohort
    completeness;
  - the aggregate ``ef_*`` is the cohort-axis sum of the per-Cohort
    arrays the bundle carries.

Uses the inline (no-DB) cohort_maturity harness from
``test_cohort_maturity_v3_contract.py`` plus the ``_candidate`` builder
from the spine suite to admit a subset of Cohorts (mixed admitted /
skipped) — the realistic shape the alignment map must handle.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import (
    build_cf_projection_bundle,
    compute_cohort_maturity_rows_v3,
)
from runner.cf_projection_bundle import (
    CFProjectionBundle,
    latency_band_taus,
)

from test_cohort_maturity_v3_contract import (  # noqa: E402
    _build_single_edge_graph,
    _build_synth_frames,
)
from test_model_span_spine_selected_cohort import _candidate  # noqa: E402
from datetime import date


# Long-lag fixture so saturation_tau (≈ ceil(2·t95)) exceeds max_tau.
_LAT = dict(mu=3.0, sigma=0.8, onset=5.0)

# Synth cohorts at anchor_to − 2·c (n_cohorts=4): 03-10, 03-08, 03-06, 03-04.
_ADMITTED_ANCHORS = ('2026-03-10', '2026-03-06')
_SKIPPED_ANCHORS = ('2026-03-08', '2026-03-04')


def _candidates_for(anchors):
    # Root-window evidence on the window subject (X = node-a) for the
    # given anchor days — admits exactly those Cohorts.
    return [
        _candidate(
            from_id='node-a', to_id='node-b',
            observed_date=a, retrieved_at='2026-03-31', n=300, k=60,
        )
        for a in anchors
    ]


def _build_bundle():
    """Single-edge window bundle over 4 synth Cohorts, with root-window
    evidence for 2 of them — a mixed admitted/skipped shape."""
    graph = _build_single_edge_graph(latency_parameter=True, **_LAT)
    frames, anchor_from, sweep_to = _build_synth_frames(
        anchor_to=date(2026, 3, 10), sweep_days=36, n_cohorts=4,
    )
    bundle = build_cf_projection_bundle(
        frames=frames,
        graph=graph,
        target_edge_id='e1',
        query_from_node='node-a',
        query_to_node='node-b',
        anchor_from='2026-03-01',
        anchor_to=anchor_from,
        sweep_to=sweep_to,
        is_window=True,
        evidence_candidates=_candidates_for(_ADMITTED_ANCHORS),
        scenario_id='bundle-test',
    )
    return bundle, graph, frames, anchor_from, sweep_to


class TestBundleSaturationHorizon:

    def test_per_cohort_arrays_cover_latent_extent_below_ceiling(self):
        bundle, *_ = _build_bundle()
        assert isinstance(bundle, CFProjectionBundle)
        fe = bundle.frame_evidence
        # The per-Cohort projection is sized to the latent chart extent
        # (bundle.max_tau, read off the conditioned span), strictly below the
        # composition ceiling fe.saturation_tau. That decoupling — compose at
        # a safe ceiling, project only to the data-latent reach — is the cost
        # saving; the arrays no longer carry the full ceiling-width grid.
        assert bundle.max_tau < fe.saturation_tau
        T_ext = bundle.max_tau + 1
        sp = bundle.selected_projection
        # tau dimension covers the latent extent; cohort dim == admitted count.
        assert sp.ef_x_draws_by_cohort.shape == (
            len(_ADMITTED_ANCHORS), sp.ef_x_draws.shape[0], T_ext,
        )
        assert sp.ef_y_draws_by_cohort.shape[2] == T_ext
        assert sp.ef_rate_draws_by_cohort.shape[2] == T_ext
        assert sp.ef_forecast_y_by_cohort.shape[2] == T_ext

    def test_public_rows_stop_at_latent_extent_not_ceiling(self):
        bundle, graph, frames, anchor_from, sweep_to = _build_bundle()
        fe = bundle.frame_evidence
        rows = compute_cohort_maturity_rows_v3(
            frames=frames, graph=graph, target_edge_id='e1',
            query_from_node='node-a', query_to_node='node-b',
            anchor_from='2026-03-01', anchor_to=anchor_from,
            sweep_to=sweep_to, is_window=True, scenario_id='bundle-test',
            evidence_candidates=_candidates_for(_ADMITTED_ANCHORS),
        )
        assert rows
        max_row_tau = max(r['tau_days'] for r in rows)
        # Rows extend to the latent chart extent (bundle.max_tau): at least
        # the observed calendar reach (fe.max_tau), strictly below the
        # composition ceiling (fe.saturation_tau).
        assert max_row_tau == bundle.max_tau
        assert max_row_tau >= fe.max_tau
        assert max_row_tau < fe.saturation_tau


class TestBundleScalarMetadata:

    def test_cf_mode_and_reason_present(self):
        bundle, *_ = _build_bundle()
        assert bundle.cf_mode == 'sweep'
        assert bundle.cf_reason is None

    def test_promoted_source_from_resolved_model(self):
        # The fixture carries a single analytic model_vars source.
        bundle, *_ = _build_bundle()
        assert bundle.promoted_source == 'analytic'


class TestBundleProjectionStatusAlignment:
    """The per-Cohort projection-status list is the safe bridge from
    cohort_list rows to projection rows. (Findings: skipped Cohorts must
    align with — not be silently dropped from — the projection arrays.)"""

    def test_status_aligned_1to1_with_cohort_list(self):
        bundle, *_ = _build_bundle()
        cohort_list = bundle.frame_evidence.cohort_list
        status = bundle.cohort_projection_status
        assert len(status) == len(cohort_list)

    def test_every_row_maps_to_a_projection_index_or_a_null_reason(self):
        bundle, *_ = _build_bundle()
        sp = bundle.selected_projection
        n_proj = sp.ef_x_draws_by_cohort.shape[0]
        admitted_indices = []
        for entry in bundle.cohort_projection_status:
            idx = entry['projection_index']
            if idx is None:
                # Skipped Cohort: must carry a reason so the date reducer
                # can emit a null-projection row rather than guess.
                assert entry['reason'] is not None
            else:
                # Admitted Cohort: index points at a real projection row.
                assert 0 <= idx < n_proj
                admitted_indices.append(idx)
        # The admitted indices are a complete, distinct 0..k-1 cover of
        # the projection rows — no projection row is orphaned.
        assert sorted(admitted_indices) == list(range(n_proj))

    def test_mixed_admitted_and_skipped_reasons(self):
        bundle, *_ = _build_bundle()
        by_anchor = {
            e['anchor_day']: e for e in bundle.cohort_projection_status
        }
        for a in _ADMITTED_ANCHORS:
            assert by_anchor[a]['projection_index'] is not None
            assert by_anchor[a]['reason'] == 'root_window_carrier_n'
        for a in _SKIPPED_ANCHORS:
            assert by_anchor[a]['projection_index'] is None
            assert by_anchor[a]['reason'] == 'no_root_window_evidence'
        # Projection carries exactly the admitted Cohorts.
        assert bundle.selected_projection.ef_x_draws_by_cohort.shape[0] == len(
            _ADMITTED_ANCHORS,
        )


class TestBundleSharedAccessors:

    def test_latency_band_taus_matches_accessor(self):
        bundle, *_ = _build_bundle()
        expected = latency_band_taus(_LAT['mu'], _LAT['sigma'], _LAT['onset'])
        assert bundle.latency_band_taus == expected

    def test_per_cohort_completeness_aligned_to_cohort_list(self):
        bundle, *_ = _build_bundle()
        comp = bundle.completeness_by_cohort
        assert comp is not None
        # Completeness is cohort_list-aligned (C_all), not projection-aligned.
        assert comp.shape == (len(bundle.frame_evidence.cohort_list),)
        assert np.all(comp >= 0.0) and np.all(comp <= 1.0)


class TestBundleAggregateConsistency:

    def test_aggregate_ef_equals_sum_of_per_cohort(self):
        bundle, *_ = _build_bundle()
        sp = bundle.selected_projection
        np.testing.assert_allclose(
            sp.ef_x_draws, sp.ef_x_draws_by_cohort.sum(axis=0),
            rtol=0, atol=0,
        )
        np.testing.assert_allclose(
            sp.ef_y_draws, sp.ef_y_draws_by_cohort.sum(axis=0),
            rtol=0, atol=0,
        )
        # Non-vacuous: the admitted Cohorts carry real projected mass.
        assert np.any(sp.ef_x_draws_by_cohort > 0.0)


class TestApiHandlersDailyConversionsCutover:
    """Static check (73q Phase 4 cutover): daily_conversions no longer runs
    the inline legacy trajectory enrichment in api_handlers.py. It is served
    by ``_handle_daily_conversions``, which builds the shared
    ``CFProjectionBundle`` and applies the date reducer. (Inverts the Phase-2
    canary that asserted the legacy block was still present.)"""

    def _src(self):
        api = os.path.join(os.path.dirname(__file__), '..', 'api_handlers.py')
        with open(api, 'r') as f:
            return f.read()

    def test_no_inline_daily_conversions_trajectory_sweep(self):
        src = self._src()
        # The legacy inline daily-conversions sweep and its annotate_rows
        # fallback are deleted. compute_forecast_trajectory itself survives
        # for surprise_gauge (Phase 5a), so we assert the daily-conversions-
        # specific markers are gone, not the symbol entirely.
        assert '_sweep = compute_forecast_trajectory(' not in src
        assert '_dc_annotated' not in src

    def test_daily_conversions_routes_to_shared_boundary(self):
        src = self._src()
        assert 'def _handle_daily_conversions(' in src
        assert 'return _handle_daily_conversions(data)' in src
