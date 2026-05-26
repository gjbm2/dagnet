"""Focused regression for the selected retrieval frontier (Stage 4 Atom 4.1).

Protects the behaviour-preserving re-source of the selected-Cohort
retrieval frontier out of ``SelectedAClockEvidence`` into the standalone
``_build_selected_retrieval_frontier`` helper.

The frontier is the one query-wide analysis observation date mapped to
each Cohort's age — NOT the frame-derived ``cohort_list['tau_observed']``,
which collapses to ``0`` for multi-hop ``window()`` even when admitted
evidence proves a later retrieval frontier. That collapse is the bug
Atom 4.1 fixes for the spine per-Cohort frontier ``f_c``; the row epoch
bounds and active completeness eval ages read the same surface so they
stay consistent.
"""

from runner.cohort_forecast_v3 import (
    SelectedRetrievalFrontier,
    _build_selected_retrieval_frontier,
)


def test_frontier_maps_query_wide_date_to_per_anchor_tau():
    # Two selected Cohorts, one query-wide frontier date. The frontier τ
    # is (frontier_date − anchor).days per Cohort, so the oldest anchor
    # yields the largest τ and the youngest the smallest. Mirrors the
    # multi-hop window() oracle where frame tau_observed == 0 for every
    # Cohort yet the real retrieval frontier spans (27, 40).
    cohort_list = [
        {'anchor_day': '2025-01-01', 'tau_max': 60, 'tau_observed': 0},
        {'anchor_day': '2025-01-14', 'tau_max': 60, 'tau_observed': 0},
    ]
    frontier = _build_selected_retrieval_frontier(
        analysis_observation_frontier_date='2025-02-10',
        cohort_list=cohort_list,
    )
    assert isinstance(frontier, SelectedRetrievalFrontier)
    # 2025-02-10 − 2025-01-01 = 40 days; 2025-02-10 − 2025-01-14 = 27 days.
    assert dict(frontier.paired_frontier_by_anchor) == {
        '2025-01-01': 40,
        '2025-01-14': 27,
    }
    assert frontier.bounds == (27, 40)


def test_frontier_ignores_frame_tau_observed_as_value():
    # The frame-derived tau_observed (here a misleading 5) must NOT be the
    # frontier value; only the query-wide date drives it. This is the
    # guard against regressing to the cohort_list['tau_observed'] source.
    cohort_list = [
        {'anchor_day': '2025-03-01', 'tau_max': 90, 'tau_observed': 5},
    ]
    frontier = _build_selected_retrieval_frontier(
        analysis_observation_frontier_date='2025-04-10',
        cohort_list=cohort_list,
    )
    assert dict(frontier.paired_frontier_by_anchor) == {'2025-03-01': 40}
    assert frontier.bounds == (40, 40)


def test_frontier_excludes_empty_frames_sentinel():
    # Empty-frames sentinel (tau_observed == -1) carries no observation
    # support; it must contribute no frontier and must not skew bounds.
    cohort_list = [
        {'anchor_day': '2025-01-01', 'tau_max': 60, 'tau_observed': 0},
        {'anchor_day': '2025-01-20', 'tau_max': 60, 'tau_observed': -1},
    ]
    frontier = _build_selected_retrieval_frontier(
        analysis_observation_frontier_date='2025-02-10',
        cohort_list=cohort_list,
    )
    assert dict(frontier.paired_frontier_by_anchor) == {'2025-01-01': 40}
    assert frontier.bounds == (40, 40)


def test_frontier_absent_without_observation_date():
    # No admitted-evidence frontier date → no frontier surface; callers
    # keep their frame-derived fallbacks (frame bounds / engine eval_age /
    # frame tau_observed).
    cohort_list = [
        {'anchor_day': '2025-01-01', 'tau_max': 60, 'tau_observed': 0},
    ]
    frontier = _build_selected_retrieval_frontier(
        analysis_observation_frontier_date=None,
        cohort_list=cohort_list,
    )
    assert dict(frontier.paired_frontier_by_anchor) == {}
    assert frontier.bounds is None
