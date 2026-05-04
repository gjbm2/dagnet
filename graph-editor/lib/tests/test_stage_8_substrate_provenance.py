"""
Stage 8 cross-surface substrate provenance tests (73n) — TOMBSTONE MODULE.

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 8 — Substrate Closure".

Mended from `_attic/test_stage_8_substrate_provenance.py` per
docs/current/project-bayes/73-attic-mending-process.md.

The 73n CF generalisation (commit e15e9a9b) replaced the four per-
surface readout entry points (`compute_single_hop_readout`,
`compute_multi_hop_subject_readout`, `compute_multi_hop_window_readout`,
`compute_active_cohort_carrier_readout`) with the unified
`compute_resolved_runtime_readout`. All 10 tests in this file drove
those four deleted entry points to assert the closure-required
substrate inventory (per plan §745) on each surface's diagnostics
block. The tests cannot translate by mechanical mend.

Audit File 10 — 0 OBSOLETE rows declared (the audit treated this file
as PARTIAL/GAP because the substrate inventory is still emitted by
the unified entry), but on mend every test imports a deleted symbol,
so all are tombstoned. The retained intent (closure-required substrate
keys are populated at the primitive level) is pinned by
`test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_
closure_required_items`. The wrapping at the readout-level diag —
`diagnostics['primitive_provenance']` for single-hop,
`diagnostics['primitives']` per-primitive list for multi-hop / Stage 6,
the `composed_carrier` / `composed_subject` topology summaries, the
`cache_status` snapshot, JSON-serialisability, p_conditioning_evidence
refusal, PreparedConditioningEvidence compatibility-metadata note —
remains a live workplan item (audit Gap workplan rows §745 family) to
be written against the unified entry diag.
"""

from __future__ import annotations

import pytest


_OBSOLETE_REASON = (
    "OBSOLETE under 73n CF generalisation (commit e15e9a9b): every "
    "test in this file drove one of the four deleted per-surface "
    "readout entry points (`compute_single_hop_readout`, "
    "`compute_multi_hop_subject_readout`, "
    "`compute_multi_hop_window_readout`, "
    "`compute_active_cohort_carrier_readout`) to inspect the "
    "closure-required substrate keys in their diagnostics blocks. "
    "Those entries were unified into `compute_resolved_runtime_readout`, "
    "whose diagnostics block has a different shape. The primitive-"
    "level substrate inventory (per plan §745) is pinned live by "
    "`test_primitive_contract.py::test_to_provenance_dict_carries_"
    "stage_8_closure_required_items`. Audit File 10 — tombstoned per "
    "73-attic-mending-process.md §6.2; see the audit's Gap workplan "
    "for the remaining readout-level wrapping items to be written at "
    "the unified entry layer."
)


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_single_hop_diag_carries_primitive_substrate_provenance():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_multi_hop_subject_readout_per_primitive_substrate_provenance():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_multi_hop_window_readout_per_primitive_substrate_provenance():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_active_cohort_carrier_readout_substrate_provenance_for_both_spans():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_stage_8_substrate_blocks_are_json_serialisable():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_single_hop_diag_carries_cache_status_snapshot():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_multi_hop_subject_readout_carries_cache_status_snapshot():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_active_cohort_carrier_readout_carries_cache_status_snapshot():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_readouts_do_not_accept_p_conditioning_evidence_parameter():
    pass


@pytest.mark.skip(reason=_OBSOLETE_REASON)
def test_prepared_conditioning_evidence_to_dict_marks_compatibility_metadata():
    pass
