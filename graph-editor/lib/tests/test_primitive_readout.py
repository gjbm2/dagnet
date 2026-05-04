"""
Stage 5a tests for single-hop primitive readout (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle)".

Mended from `_attic/test_primitive_readout.py` per
docs/current/project-bayes/73-attic-mending-process.md.

The 73n CF generalisation (commit e15e9a9b) replaced the per-surface
readout entry points (`compute_single_hop_readout`,
`compute_multi_hop_subject_readout`, `compute_multi_hop_window_readout`,
`compute_active_cohort_carrier_readout`) and their eligibility helpers
(`is_single_hop_window_eligible` etc.) with a single unified
`compute_resolved_runtime_readout`. The unified entry has a
fundamentally different surface (it consumes `subject_edge_resolutions`
+ `carrier_edge_resolutions` against a graph topology, not a
single-edge `transition` + `evidence_set`), so the attic file's 14
unit-style tests at the deprecated entry cannot translate by
mechanical mend; their intent survives at the integration layer in
`test_primitive_readout_integration.py`.

Tombstones below cite the live coverage when one exists. The constants
check (`test_shadow_band_constants_match_stage_0c_contract`) survives
unchanged because the constants themselves are still exported.

Audit File 9 — 5 OBSOLETE rows (1-5), 5 PARTIAL rows (6, 7, 12, 13, 14),
4 GAP rows (8, 9, 10, 11). All but row 9 are tombstoned; row 9 (the
constants check) remains a live one-line assertion. The GAP rows
correspond to entries in the audit's Gap workplan (Tier F — readout
soft-skips, Tier A.4 — subset limits) where new tests at the
integration layer remain on the workplan.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

GRAPH_EDITOR_DIR = Path(__file__).resolve().parent.parent.parent
if str(GRAPH_EDITOR_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))
LIB_DIR = GRAPH_EDITOR_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from runner.primitive_readout import (
    ACCEPTANCE_ABS_BAND,
    SHADOW_ABS_BAND,
)


# ─── Constants check (the only attic test surviving the API unification) ──


def test_shadow_band_constants_match_stage_0c_contract():
    """Plan / Stage 0c §3.3. Stage 0c band constants are still exported
    from `runner.primitive_readout` even after the entry-point
    unification, so this test continues to pin them at the module
    level."""
    assert SHADOW_ABS_BAND == 0.005
    assert ACCEPTANCE_ABS_BAND == 0.002


# ─── Tombstones: tests that drove the deleted per-surface entry points ───
#
# All assertions below were authored against
# `compute_single_hop_readout` / `is_single_hop_window_eligible`, which
# the 73n CF generalisation removed. Per the mending process (§6.2),
# the test functions are retained as `pytest.skip` tombstones so the
# audit's classification is anchored in code; the bodies are inert
# (never executed under skip) so the deleted-symbol references are
# harmless.


_OBSOLETE_ELIGIBILITY_REASON = (
    "OBSOLETE under 73n CF generalisation (commit e15e9a9b): "
    "`is_single_hop_window_eligible` was removed when the per-surface "
    "readout entry points were unified into "
    "`compute_resolved_runtime_readout`. Eligibility is now decided "
    "internally by the unified function via the carrier/subject "
    "resolution shape (`subject_edge_resolutions`, "
    "`carrier_edge_resolutions`) rather than by a separate boolean "
    "helper. Audit File 9 rows 1-5 — confirmed OBSOLETE; tombstoned "
    "per 73-attic-mending-process.md §6.2. "
    "Live cover for the surviving intent is the integration-level "
    "test in `test_primitive_readout_integration.py`."
)


_OBSOLETE_SINGLE_HOP_READOUT_REASON = (
    "OBSOLETE under 73n CF generalisation (commit e15e9a9b): "
    "`compute_single_hop_readout` was removed when the per-surface "
    "readout entry points were unified into "
    "`compute_resolved_runtime_readout`. The unified entry has a "
    "different surface (graph + subject/carrier edge resolutions, not "
    "a single-edge transition + evidence_set), so the attic-style unit "
    "tests cannot translate by mechanical mend. The same intent (full "
    "subset limit / zero subset limit / posterior parity / skip "
    "reasons / diagnostics inventory / evidence-totals preservation / "
    "should_substitute property) is pinned at the integration layer "
    "by `test_primitive_readout_integration.py::TestStage5aSingleHop"
    "Integration::test_substitutes_identically_on_both_surfaces` and "
    "neighbouring tests. Audit File 9 rows 6-14 — tombstoned per "
    "73-attic-mending-process.md §6.2. The audit's Gap workplan items "
    "(Tier A subset-limit boundary, Tier F readout soft-skips) remain "
    "as live workplan entries to write at the unified-entry layer."
)


@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)
def test_eligible_single_hop_window():
    pass  # body retired with the helper


@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)
def test_eligible_single_hop_cohort_a_equals_x():
    pass


@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)
def test_ineligible_single_hop_cohort_a_not_x():
    pass


@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)
def test_ineligible_multi_hop_window():
    pass


@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)
def test_ineligible_multi_hop_cohort():
    pass


@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)
def test_ineligible_cohort_missing_anchor():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_single_hop_mean_matches_maturity_aware_primitive_posterior():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_full_subset_limit_returns_prior():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_zero_subset_limit_returns_full_conjugate():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_ineligible_request_returns_diagnostic_skip_not_substitution():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_eligible_but_inputs_missing_records_soft_skip():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_diagnostics_carry_full_provenance():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_canonical_binder_preserves_evidence_totals_under_identity_mask():
    pass


@pytest.mark.skip(reason=_OBSOLETE_SINGLE_HOP_READOUT_REASON)
def test_should_substitute_property_eligible_request_substitutes():
    pass
