"""
Stage 5c tests for multi-hop window readout (73n) — TOMBSTONE MODULE.

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5c — Multi-Hop Window Cutover".

Mended from `_attic/test_multi_hop_window_readout.py` per
docs/current/project-bayes/73-attic-mending-process.md.

The 73n CF generalisation (commit e15e9a9b) replaced the per-surface
readout entry point `compute_multi_hop_window_readout` (and its
eligibility helper `is_multi_hop_window_eligible`) with a unified
`compute_resolved_runtime_readout`. The unified entry has a different
surface, so the attic-style unit tests cannot translate by mechanical
mend.

Audit File 4 — 4 OBSOLETE rows (eligibility helpers), 4 PARTIAL,
5 GAP. Notable load-bearing GAP: `test_on_flag_does_not_collapse_to_
terminal_edge` (Tier A.7 in the audit's Gap workplan — anti-collapse-
to-terminal §709 invariant). The Tier A item remains in the workplan;
the attic test is tombstoned because its API is gone and the live
target (`test_primitive_readout_integration.py`) needs a fresh test
written against the unified entry.
"""

from __future__ import annotations

import pytest


_OBSOLETE_REASON = (
    "OBSOLETE under 73n CF generalisation (commit e15e9a9b): the per-"
    "surface entry `compute_multi_hop_window_readout` and its "
    "eligibility helper `is_multi_hop_window_eligible` were removed "
    "when the four legacy readout entry points were unified into "
    "`compute_resolved_runtime_readout`. Live cover for the surviving "
    "intent: `test_primitive_readout_integration.py` (integration "
    "level) and `test_subject_span_composer.py` (composer level). "
    "Audit File 4 — tombstoned per 73-attic-mending-process.md §6.2. "
    "Note: `test_on_flag_does_not_collapse_to_terminal_edge` was "
    "Tier A.7 of the audit's Gap workplan (§709 anti-collapse) and "
    "remains a live workplan item to write at the unified entry."
)


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_eligible_multi_hop_window():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_multi_hop_cohort_deferred_to_stage_5b():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_single_hop_window_deferred_to_stage_5a():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_ineligible_single_hop_cohort():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_on_flag_substitutes_with_composed_moments():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_on_flag_does_not_collapse_to_terminal_edge():
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
