"""
Stage 6 tests for active-cohort A!=X carrier readout (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 6 — Active Cohort A!=X Carrier Readout".

Mended from `_attic/test_active_cohort_carrier_readout.py` per
docs/current/project-bayes/73-attic-mending-process.md.

The 73n CF generalisation (commit e15e9a9b) replaced the per-surface
readout entry point `compute_active_cohort_carrier_readout` (and its
eligibility helper `is_active_cohort_carrier_eligible`) with a unified
`compute_resolved_runtime_readout`. The unified entry consumes
`subject_edge_resolutions` + `carrier_edge_resolutions` against a
graph topology, so the attic's per-surface unit tests cannot translate
by mechanical mend.

Audit File 1 — 5 OBSOLETE rows (eligibility helpers), 7 PARTIAL,
4 GAP. Notable load-bearing GAPs: `test_target_subject_only_change_
does_not_move_carrier` (Tier A.8) and `test_changing_upstream_resolved_
model_moves_carrier_reach` (Tier A.9). Both remain live items in the
audit's Gap workplan to write at the unified entry. The static-source
import-guard test (`test_module_does_not_import_trajectory_engine`)
is the one survivor — it inspects `runner/primitive_readout.py`'s
source text directly and depends on no deleted symbols.
"""

from __future__ import annotations

import os

import pytest


_OBSOLETE_REASON = (
    "OBSOLETE under 73n CF generalisation (commit e15e9a9b): the per-"
    "surface entry `compute_active_cohort_carrier_readout` and its "
    "eligibility helper `is_active_cohort_carrier_eligible` were "
    "removed when the four legacy readout entry points were unified "
    "into `compute_resolved_runtime_readout`. Live cover for the "
    "surviving intent: `test_active_cohort_carrier_audit.py` "
    "(reachability of the post-unification path), "
    "`test_carrier_object_contract.py` (carrier reach algebra), "
    "`test_subject_span_composer.py` (composer-level Stage 6 "
    "substitution math). Audit File 1 — tombstoned per "
    "73-attic-mending-process.md §6.2. Note: rows 11 and 12 of "
    "audit File 1 are Tier A.9 (`test_changing_upstream_resolved_"
    "model_moves_carrier_reach`) and Tier A.8 (`test_target_subject_"
    "only_change_does_not_move_carrier`) of the Gap workplan — those "
    "remain live items to write at the unified entry layer."
)


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_eligible_active_cohort_a_not_x():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_window():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_cohort_a_equals_x():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_missing_anchor():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_missing_query_from_node():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_on_flag_substitutes_with_composed_subject_moments():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_request_returns_diagnostic_skip():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_incomplete_inputs_returns_soft_skip():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_target_count_invalid_returns_soft_skip():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_carrier_no_path_surfaces_in_diagnostics_and_blocks_substitution():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_subject_no_path_returns_soft_skip():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_changing_upstream_resolved_model_moves_carrier_reach():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_target_subject_only_change_does_not_move_carrier():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_diagnostics_carry_full_provenance():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_carrier_and_subject_non_target_use_prior_only():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_should_substitute_property():
    pass


# ─── Static-source AP58 import guard (survives the API unification) ───────


def test_module_does_not_import_trajectory_engine():
    """Plan AP58 prevention (KNOWN_ANTI_PATTERNS §272): the readout
    layer must not import forecast_state / forecast_runtime /
    cohort_forecast_v3 — those would re-introduce the projection-vs-
    primitive duplication this stage exists to remove.

    The test inspects `runner/primitive_readout.py`'s source text
    directly, so it survives the API unification — the file still
    exists, the forbidden imports are still forbidden, and the path
    math resolves correctly when run from `lib/tests/`."""
    here = os.path.dirname(__file__)
    src_path = os.path.join(here, '..', 'runner', 'primitive_readout.py')
    with open(src_path) as fh:
        src = fh.read()
    # The forbidden imports.
    for forbidden in (
        'from .forecast_state',
        'from .forecast_runtime',
        'from .cohort_forecast_v3',
        'import forecast_state',
        'import forecast_runtime',
        'import cohort_forecast_v3',
    ):
        assert forbidden not in src, (
            f'primitive_readout.py imports {forbidden!r}; this would '
            f'break AP58 prevention. Only the unified primitive layer '
            f'(prefix_arrival, primitive_evidence, primitive_conditioning, '
            f'subject_span_composer, timing_span) is allowed.'
        )
