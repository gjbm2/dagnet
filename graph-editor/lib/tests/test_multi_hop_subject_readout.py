"""
Stage 5b tests for multi-hop subject readout (73n) — TOMBSTONE MODULE.

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5b — Multi-Hop Subject Cutover".

Mended from `_attic/test_multi_hop_subject_readout.py` per
docs/current/project-bayes/73-attic-mending-process.md.

The 73n CF generalisation (commit e15e9a9b) replaced the per-surface
readout entry point `compute_multi_hop_subject_readout` (and its
eligibility helper `is_multi_hop_subject_eligible`) with a unified
`compute_resolved_runtime_readout`. The unified entry has a different
surface (graph + carrier/subject edge resolutions, not a per-surface
function), so all 13 attic-style unit tests at the deprecated entry
cannot translate by mechanical mend.

Audit File 3 — 5 OBSOLETE rows (1-5: eligibility helpers), 4 PARTIAL,
4 GAP. PARTIAL coverage is at the integration level
(`test_primitive_readout_integration.py`) and at the composer level
(`test_subject_span_composer.py`). The audit's Gap workplan retains
these as items to write at the unified-entry layer.
"""

from __future__ import annotations

import pytest


_OBSOLETE_REASON = (
    "OBSOLETE under 73n CF generalisation (commit e15e9a9b): the per-"
    "surface entry `compute_multi_hop_subject_readout` and its "
    "eligibility helper `is_multi_hop_subject_eligible` were removed "
    "when the four legacy readout entry points were unified into "
    "`compute_resolved_runtime_readout`. The unified entry consumes "
    "`subject_edge_resolutions` + `carrier_edge_resolutions` against a "
    "graph topology, not a per-surface function, so the attic-style "
    "unit tests cannot translate by mechanical mend. Live cover for "
    "the surviving intent: `test_primitive_readout_integration.py` "
    "(integration-level multi-hop substitution) and "
    "`test_subject_span_composer.py::test_two_hop_serial_composes_"
    "probability_via_doc_29b_dp` (composer-level multi-hop algebra). "
    "Audit File 3 — tombstoned per 73-attic-mending-process.md §6.2."
)


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_eligible_multi_hop_cohort_a_equals_x():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_multi_hop_window_deferred_to_stage_5c():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_multi_hop_cohort_a_not_x():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_single_hop():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_cohort_missing_anchor():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_on_flag_substitutes_with_composed_moments():
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
def test_composer_path_failure_returns_soft_skip():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_diagnostics_carry_full_provenance():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_non_target_edges_use_prior_only_primitives():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_should_substitute_property():
    pass
