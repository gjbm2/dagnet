"""
Stage 1 contract tests for the typed shared evidence merge library.

Tests target the design in
docs/current/project-bayes/73h-shared-evidence-merge-design.md, sections:
  - Identity And Observation Coordinates Before Counts
  - Population Identity
  - Snapshot And File Are Candidate Sources, Not Separate Evidence Objects
  - As-At Is An Admission Boundary
  - Dedupe Is By Logical Observation Identity
  - Merge Algorithm (Steps 1-6)
  - Test Plan -> Unit / Contract Tests For The Shared Library

The library under test is graph-editor/lib/evidence_merge.py and is
imported as `evidence_merge` (lib is on the pythonpath via pytest.ini).

Tests are deliberately blind: expected E and skip-reason counts come
from fixture intent, not from the implementation's own merge output.
"""

from __future__ import annotations

import pytest

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    PROVENANCE_SCHEMA_VERSION,
    SliceFamily,
    SourceKind,
    TemporalBasis,
    derive_population_identity,
    evidence_dedupe_key,
    evidence_set_to_response_provenance,
    merge_evidence_candidates,
)


# ─── Fixture helpers ───────────────────────────────────────────────────


def _window_scope(
    *,
    date_from: str = "2026-01-01",
    date_to: str = "2026-01-31",
    as_at: str | None = "2026-02-01",
    context_key: str | None = None,
    regime_key: str | None = None,
    scenario_id: str | None = "scn-1",
    role: EvidenceRole = EvidenceRole.WINDOW_SUBJECT_HELPER,
) -> EvidenceScope:
    return EvidenceScope(
        role=role,
        subject_from="C",
        subject_to="D",
        date_from=date_from,
        date_to=date_to,
        as_at=as_at,
        scenario_id=scenario_id,
        anchor=None,
        context_key=context_key,
        regime_key=regime_key,
    )


def _direct_cohort_scope(
    *,
    anchor: str = "B",
    population_universe_key: str | None = None,
    date_from: str = "2026-01-01",
    date_to: str = "2026-01-31",
    as_at: str | None = "2026-02-01",
    selected_anchor_days: tuple[str, ...] = (),
) -> EvidenceScope:
    return EvidenceScope(
        role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
        subject_from="C",
        subject_to="D",
        date_from=date_from,
        date_to=date_to,
        as_at=as_at,
        scenario_id="scn-1",
        anchor=anchor,
        population_universe_key=population_universe_key,
        selected_anchor_days=selected_anchor_days,
    )


def _make_candidate(
    *,
    source: SourceKind,
    slice_family: SliceFamily,
    role: EvidenceRole,
    observed_date: str,
    n: int,
    k: int,
    subject_from: str = "C",
    subject_to: str = "D",
    anchor: str | None = None,
    context_key: str | None = None,
    regime_key: str | None = None,
    population_identity: str | None = None,
    retrieved_at: str | None = "2026-02-01",
    temporal_basis: TemporalBasis = TemporalBasis.WINDOW_DAY,
    asat_materialised: bool = False,
    provenance: dict | None = None,
) -> EvidenceCandidate:
    identity = EvidenceIdentity(
        role=role,
        subject_from=subject_from,
        subject_to=subject_to,
        anchor=anchor,
        slice_family=slice_family,
        context_key=context_key,
        regime_key=regime_key,
        population_identity=population_identity,
    )
    coordinate = ObservationCoordinate(
        observed_date=observed_date,
        retrieved_at=retrieved_at,
        temporal_basis=temporal_basis,
        asat_materialised=asat_materialised,
    )
    return EvidenceCandidate(
        source=source,
        identity=identity,
        coordinate=coordinate,
        n=n,
        k=k,
        provenance=provenance or {},
    )


def _window_snapshot(date: str, n: int, k: int, **kw) -> EvidenceCandidate:
    return _make_candidate(
        source=SourceKind.SNAPSHOT,
        slice_family=SliceFamily.WINDOW,
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        observed_date=date,
        n=n,
        k=k,
        **kw,
    )


def _window_file(date: str, n: int, k: int, **kw) -> EvidenceCandidate:
    return _make_candidate(
        source=SourceKind.FILE,
        slice_family=SliceFamily.WINDOW,
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        observed_date=date,
        n=n,
        k=k,
        **kw,
    )


def _cohort_file(anchor: str, date: str, n: int, k: int, **kw) -> EvidenceCandidate:
    return _make_candidate(
        source=SourceKind.FILE,
        slice_family=SliceFamily.COHORT,
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,  # role on identity is irrelevant; merge re-checks against scope
        observed_date=date,
        n=n,
        k=k,
        anchor=anchor,
        **kw,
    )


def _skip_reasons(merged) -> dict[str, int]:
    return dict(merged.provenance.skipped_counts_by_reason)


# ─── Test 1: snapshot/file overlap by day ───────────────────────────────


def test_file_supplements_only_uncovered_days():
    scope = _window_scope()
    candidates = [
        # Snapshot covers days 3-5
        _window_snapshot("2026-01-03", n=10, k=4),
        _window_snapshot("2026-01-04", n=10, k=5),
        _window_snapshot("2026-01-05", n=10, k=6),
        # File covers days 1-5
        _window_file("2026-01-01", n=20, k=8),
        _window_file("2026-01-02", n=20, k=9),
        _window_file("2026-01-03", n=99, k=99),  # covered by snapshot
        _window_file("2026-01-04", n=99, k=99),  # covered by snapshot
        _window_file("2026-01-05", n=99, k=99),  # covered by snapshot
    ]
    merged = merge_evidence_candidates(scope, candidates)

    # E = snapshot 3,4,5 (10+10+10=30, k 4+5+6=15) + file 1,2 (20+20=40, k 8+9=17)
    assert merged.totals.n == 70
    assert merged.totals.k == 32
    assert {p.candidate.coordinate.observed_date for p in merged.points} == {
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
        "2026-01-05",
    }
    reasons = _skip_reasons(merged)
    assert reasons.get("covered_by_snapshot") == 3
    # snapshot contributes 30, file contributes 40
    assert merged.totals_by_source[SourceKind.SNAPSHOT].n == 30
    assert merged.totals_by_source[SourceKind.FILE].n == 40


# ─── Test 2: role filters cohort file under window_subject_helper ───────


def test_window_role_skips_cohort_file_entries():
    scope = _window_scope()
    candidates = [
        _window_snapshot("2026-01-03", n=10, k=5),
        _window_file("2026-01-01", n=20, k=10),
        _cohort_file("A", "2026-01-02", n=99, k=99),
        _cohort_file("B", "2026-01-02", n=99, k=99),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    # E = snapshot 1 day + window-file 1 day; both cohort entries skipped
    assert merged.totals.n == 30
    assert merged.totals.k == 15
    reasons = _skip_reasons(merged)
    assert reasons.get("wrong_role") == 2


# ─── Test 3: direct cohort role with anchor B ───────────────────────────


def test_direct_cohort_role_admits_only_matching_anchor():
    pop_id = derive_population_identity(
        role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
        anchor="B",
        subject_from="C",
        subject_to="D",
        date_from="2026-01-01",
        date_to="2026-01-31",
        selected_anchor_days=("2026-01-02",),
    )
    scope = _direct_cohort_scope(
        anchor="B",
        date_from="2026-01-01",
        date_to="2026-01-31",
        selected_anchor_days=("2026-01-02",),
    )
    candidates = [
        _make_candidate(
            source=SourceKind.FILE,
            slice_family=SliceFamily.COHORT,
            role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
            observed_date="2026-01-02",
            anchor="A",
            population_identity=pop_id,  # population identity matches but anchor doesn't
            n=99,
            k=99,
        ),
        _make_candidate(
            source=SourceKind.FILE,
            slice_family=SliceFamily.COHORT,
            role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
            observed_date="2026-01-02",
            anchor="B",
            population_identity=pop_id,
            n=15,
            k=7,
        ),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 15
    assert merged.totals.k == 7
    reasons = _skip_reasons(merged)
    assert reasons.get("wrong_cohort_anchor") == 1


# ─── Test 4: equivalent snapshot duplicates count once ─────────────────


def test_equivalent_snapshot_duplicates_count_once():
    scope = _window_scope()
    candidates = [
        # Two snapshot rows for the same identity + observed date,
        # different retrieved_at; later one wins, earlier is superseded.
        _window_snapshot("2026-01-03", n=10, k=5, retrieved_at="2026-01-10"),
        _window_snapshot("2026-01-03", n=10, k=5, retrieved_at="2026-01-20"),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 10
    assert merged.totals.k == 5
    assert len(merged.points) == 1
    reasons = _skip_reasons(merged)
    assert reasons.get("superseded_by_later_retrieval") == 1


# ─── Test 5: direct cohort rejects mismatched population_identity ──────


def test_direct_cohort_rejects_population_identity_mismatch():
    pop_a = "pop-A"
    pop_b = "pop-B"
    scope = EvidenceScope(
        role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
        subject_from="C",
        subject_to="D",
        date_from="2026-01-01",
        date_to="2026-01-31",
        as_at="2026-02-01",
        scenario_id="scn-1",
        anchor="B",
        population_universe_key="universe-A",
        selected_anchor_days=("2026-01-02",),
        scope_population_identity=pop_a,
    )
    candidates = [
        _make_candidate(
            source=SourceKind.FILE,
            slice_family=SliceFamily.COHORT,
            role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
            observed_date="2026-01-02",
            anchor="B",
            population_identity=pop_b,  # mismatches scope
            n=99,
            k=99,
        ),
        _make_candidate(
            source=SourceKind.FILE,
            slice_family=SliceFamily.COHORT,
            role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT,
            observed_date="2026-01-02",
            anchor="B",
            population_identity=pop_a,  # matches scope
            n=15,
            k=7,
        ),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 15
    assert merged.totals.k == 7
    reasons = _skip_reasons(merged)
    assert reasons.get("wrong_population_identity") == 1


# ─── Test 6: as-at boundary admission ──────────────────────────────────


def test_two_scenarios_with_different_as_at_produce_different_E():
    early_scope = _window_scope(as_at="2026-01-15", scenario_id="scn-early")
    late_scope = _window_scope(as_at="2026-02-01", scenario_id="scn-late")
    candidates = [
        _window_file("2026-01-05", n=10, k=4, retrieved_at="2026-01-10"),
        _window_file("2026-01-08", n=10, k=4, retrieved_at="2026-01-25"),  # invisible to early
    ]
    early = merge_evidence_candidates(early_scope, candidates)
    late = merge_evidence_candidates(late_scope, candidates)

    assert early.totals.n == 10  # only the 2026-01-10 retrieval is visible
    assert late.totals.n == 20  # both retrievals are visible
    early_reasons = _skip_reasons(early)
    assert early_reasons.get("after_as_at") == 1


# ─── Test 7: scenarios with different context keys do not share E ───────


def test_two_scenarios_with_different_context_do_not_share_E():
    scope_x = _window_scope(context_key="ctx-x")
    scope_y = _window_scope(context_key="ctx-y")
    candidates = [
        _window_file("2026-01-05", n=10, k=4, context_key="ctx-x"),
        _window_file("2026-01-05", n=20, k=8, context_key="ctx-y"),
    ]
    merged_x = merge_evidence_candidates(scope_x, candidates)
    merged_y = merge_evidence_candidates(scope_y, candidates)

    assert merged_x.totals.n == 10
    assert merged_y.totals.n == 20


# ─── Test 8: observed_date > retrieved_at is rejected ──────────────────


def test_observed_date_after_retrieved_at_is_skipped():
    scope = _window_scope()
    candidates = [
        _window_file("2026-01-05", n=10, k=5, retrieved_at="2026-01-04"),
        _window_file("2026-01-05", n=20, k=8, retrieved_at="2026-01-06"),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 20
    assert merged.totals.k == 8
    reasons = _skip_reasons(merged)
    assert reasons.get("after_retrieved_at") == 1


# ─── Test 9: row after scope as-at boundary is skipped ─────────────────


def test_raw_row_after_as_at_boundary_is_skipped():
    scope = _window_scope(as_at="2026-01-15")
    candidates = [
        _window_file("2026-01-05", n=10, k=4, retrieved_at="2026-01-20"),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 0
    reasons = _skip_reasons(merged)
    assert reasons.get("after_as_at") == 1


# ─── Test 10: as-at materialised candidate coexists with raw file ──────


def test_asat_materialised_candidate_coexists_with_raw_file():
    scope = _window_scope(as_at="2026-01-15")
    candidates = [
        # raw file with retrieved_at after as_at: must be rejected
        _window_file("2026-01-05", n=99, k=99, retrieved_at="2026-01-25"),
        # reconstructed candidate marked as already materialised at as_at
        _make_candidate(
            source=SourceKind.RECONSTRUCTED,
            slice_family=SliceFamily.WINDOW,
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            observed_date="2026-01-05",
            n=10,
            k=5,
            retrieved_at=None,
            asat_materialised=True,
        ),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    # raw file rejected, reconstructed admitted
    assert merged.totals.n == 10
    assert merged.totals.k == 5
    assert merged.totals_by_source[SourceKind.RECONSTRUCTED].n == 10
    reasons = _skip_reasons(merged)
    assert reasons.get("after_as_at") == 1
    assert merged.provenance.asat_materialised_present is True


# ─── Test 11: context-qualified row is skipped under non-context role ──


def test_context_qualified_row_is_skipped_under_window_role():
    scope = _window_scope(context_key=None)
    candidates = [
        _make_candidate(
            source=SourceKind.FILE,
            slice_family=SliceFamily.CONTEXT,
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            observed_date="2026-01-05",
            n=99,
            k=99,
            context_key="ctx-x",
        ),
        _window_file("2026-01-05", n=10, k=4),
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 10
    reasons = _skip_reasons(merged)
    assert reasons.get("unsupported_context") == 1


# ─── Test 12: skipped rows always carry a reason ───────────────────────


def test_every_skipped_candidate_has_a_reason():
    scope = _window_scope()
    candidates = [
        _window_file("2025-12-01", n=10, k=4),  # out_of_date_bounds (before)
        _window_file("2026-03-01", n=10, k=4),  # out_of_date_bounds (after)
        _window_file("2026-01-05", n=0, k=0),  # non_positive_n
        _cohort_file("A", "2026-01-05", n=10, k=4),  # wrong_role
        _window_snapshot("2026-01-10", n=10, k=4),  # included
    ]
    merged = merge_evidence_candidates(scope, candidates)

    assert merged.totals.n == 10
    for skipped in merged.skipped:
        assert skipped.reason and isinstance(skipped.reason, str)
    reasons = _skip_reasons(merged)
    assert reasons.get("out_of_date_bounds", 0) >= 2
    assert reasons.get("non_positive_n", 0) >= 1
    assert reasons.get("wrong_role", 0) >= 1


# ─── Test 13: Q4 fixture contract under WP8-off ────────────────────────


def test_q4_synth_lat4_fixture_under_wp8_off():
    """Blind fixture for the Q4 synth-lat4 case from doc 73h.

    Snapshot window: n=26206, k=13740 over covered anchor days
    File window uncovered: n=27976, k=18680
    File cohort(A) uncovered: n=27976, k=18680  (must be skipped: wrong_role)
    File cohort(B) uncovered: n=30287, k=20030  (must be skipped: wrong_role under WP8-off)

    Expected E: n=54182, k=32420 (snapshot covered + file window uncovered).
    Must NOT equal 71224/41700 (the legacy double-counted total).
    """
    scope = _window_scope(
        date_from="2025-10-30",
        date_to="2026-01-28",
        as_at="2026-01-29",
    )
    snapshot_dates = [f"2025-11-{d:02d}" for d in range(1, 16)]  # 15 covered days
    file_window_dates = [f"2025-12-{d:02d}" for d in range(1, 16)]  # 15 uncovered days
    file_cohort_a_dates = list(file_window_dates)
    file_cohort_b_dates = list(file_window_dates)

    candidates: list[EvidenceCandidate] = []
    # snapshot window rows: 26206 / 13740 spread across the snapshot dates
    snap_n_total, snap_k_total = 26206, 13740
    for i, d in enumerate(snapshot_dates):
        n_i = snap_n_total // len(snapshot_dates) + (1 if i < snap_n_total % len(snapshot_dates) else 0)
        k_i = snap_k_total // len(snapshot_dates) + (1 if i < snap_k_total % len(snapshot_dates) else 0)
        candidates.append(_window_snapshot(d, n=n_i, k=k_i, retrieved_at="2026-01-25"))
    # file window uncovered rows: 27976 / 18680
    fw_n_total, fw_k_total = 27976, 18680
    for i, d in enumerate(file_window_dates):
        n_i = fw_n_total // len(file_window_dates) + (1 if i < fw_n_total % len(file_window_dates) else 0)
        k_i = fw_k_total // len(file_window_dates) + (1 if i < fw_k_total % len(file_window_dates) else 0)
        candidates.append(_window_file(d, n=n_i, k=k_i, retrieved_at="2026-01-25"))
    # file cohort(A) rows: 27976 / 18680
    ca_n_total, ca_k_total = 27976, 18680
    for i, d in enumerate(file_cohort_a_dates):
        n_i = ca_n_total // len(file_cohort_a_dates) + (1 if i < ca_n_total % len(file_cohort_a_dates) else 0)
        k_i = ca_k_total // len(file_cohort_a_dates) + (1 if i < ca_k_total % len(file_cohort_a_dates) else 0)
        candidates.append(_cohort_file("A", d, n=n_i, k=k_i, retrieved_at="2026-01-25"))
    # file cohort(B) rows: 30287 / 20030
    cb_n_total, cb_k_total = 30287, 20030
    for i, d in enumerate(file_cohort_b_dates):
        n_i = cb_n_total // len(file_cohort_b_dates) + (1 if i < cb_n_total % len(file_cohort_b_dates) else 0)
        k_i = cb_k_total // len(file_cohort_b_dates) + (1 if i < cb_k_total % len(file_cohort_b_dates) else 0)
        candidates.append(_cohort_file("B", d, n=n_i, k=k_i, retrieved_at="2026-01-25"))

    merged = merge_evidence_candidates(scope, candidates)

    # Expected E: snapshot window + file window uncovered
    expected_n = snap_n_total + fw_n_total
    expected_k = snap_k_total + fw_k_total
    assert merged.totals.n == expected_n  # 54182
    assert merged.totals.k == expected_k  # 32420
    # Must NOT equal the legacy double-counted total
    assert merged.totals.n != 71224
    assert merged.totals.k != 41700
    # Both cohort slices must be fully skipped as wrong_role
    reasons = _skip_reasons(merged)
    expected_skipped_wrong_role = len(file_cohort_a_dates) + len(file_cohort_b_dates)
    assert reasons.get("wrong_role") == expected_skipped_wrong_role


# ─── Bonus: provenance schema version is present and stable ────────────


def test_provenance_schema_version_is_present():
    scope = _window_scope()
    merged = merge_evidence_candidates(scope, [_window_snapshot("2026-01-10", n=10, k=4)])
    assert merged.provenance.schema_version
    assert merged.provenance.role == EvidenceRole.WINDOW_SUBJECT_HELPER


# ─── Bonus: subject mismatch is rejected ───────────────────────────────


def test_subject_mismatch_is_rejected():
    scope = _window_scope()
    candidates = [
        _window_snapshot("2026-01-10", n=10, k=4, subject_from="X", subject_to="Y"),
        _window_snapshot("2026-01-10", n=20, k=8),
    ]
    merged = merge_evidence_candidates(scope, candidates)
    assert merged.totals.n == 20
    reasons = _skip_reasons(merged)
    assert reasons.get("subject_mismatch") == 1


# ─── Test 14: supplement-mode snapshot_covered_observations parameter ─


def test_snapshot_covered_observations_filters_non_snapshot_candidates():
    """Stage 2-3 transitional path: caller supplies covered (key, date) set
    instead of real snapshot candidates."""
    scope = _window_scope(date_from="2026-01-01", date_to="2026-01-10")
    candidates = [
        _window_file("2026-01-01", n=10, k=4),  # uncovered, included
        _window_file("2026-01-02", n=20, k=8),  # covered, skipped
        _window_file("2026-01-03", n=30, k=12),  # uncovered, included
    ]
    # Build the covered set keyed exactly the way the merge will look it up
    covered_identity = candidates[1].identity
    covered = {
        (evidence_dedupe_key(covered_identity), "2026-01-02"),
    }
    merged = merge_evidence_candidates(
        scope, candidates, snapshot_covered_observations=covered
    )
    assert merged.totals.n == 40  # 10 + 30
    assert merged.totals.k == 16  # 4 + 12
    reasons = _skip_reasons(merged)
    assert reasons.get("covered_by_snapshot") == 1


# ─── Bonus: role on candidate identity must match scope role ───────────


# ─── Test 15: response provenance serialiser block contract ───────────


def test_response_provenance_block_has_documented_shape():
    """Per 73h §CF Response Provenance Contract: dedicated
    `evidence_provenance` block with stable schema version, role, scope key,
    raw E totals, source totals, included counts, selected families,
    skipped counts by reason, as-at boundary, and as-at-materialised marker.
    """
    scope = _window_scope(as_at="2026-01-15")
    candidates = [
        _window_snapshot("2026-01-05", n=20, k=8, retrieved_at="2026-01-10"),
        _window_file("2026-01-06", n=10, k=4, retrieved_at="2026-01-11"),
        _window_file("2026-01-08", n=99, k=99, retrieved_at="2026-01-25"),  # after as_at
        _cohort_file("A", "2026-01-07", n=999, k=999, retrieved_at="2026-01-12"),  # wrong_role
    ]
    merged = merge_evidence_candidates(scope, candidates)
    block = evidence_set_to_response_provenance(merged)

    assert block["schema_version"] == PROVENANCE_SCHEMA_VERSION
    assert block["role"] == EvidenceRole.WINDOW_SUBJECT_HELPER.value
    assert block["scope_key"].startswith("scope:")
    assert block["scenario_id"] == "scn-1"
    assert block["as_at"] == "2026-01-15"
    assert block["totals"] == {"n": 30, "k": 12, "mean": pytest.approx(0.4)}
    # only sources with non-zero totals appear
    assert "snapshot" in block["totals_by_source"]
    assert block["totals_by_source"]["snapshot"] == {"n": 20, "k": 8}
    assert block["totals_by_source"]["file"] == {"n": 10, "k": 4}
    assert "reconstructed" not in block["totals_by_source"]
    assert block["included_counts_by_source"]["snapshot"] == 1
    assert block["included_counts_by_source"]["file"] == 1
    assert block["selected_slice_families"] == ["window"]
    assert block["selected_snapshot_families"] == ["window"]
    assert block["skipped_counts_by_reason"].get("after_as_at", 0) >= 1
    assert block["skipped_counts_by_reason"].get("wrong_role", 0) >= 1
    assert block["asat_materialised_present"] is False


def test_response_provenance_block_marks_asat_materialised_when_present():
    scope = _window_scope(as_at="2026-01-15")
    candidates = [
        _make_candidate(
            source=SourceKind.RECONSTRUCTED,
            slice_family=SliceFamily.WINDOW,
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            observed_date="2026-01-05",
            n=10,
            k=4,
            retrieved_at=None,
            asat_materialised=True,
        ),
    ]
    merged = merge_evidence_candidates(scope, candidates)
    block = evidence_set_to_response_provenance(merged)

    assert block["asat_materialised_present"] is True
    assert block["totals_by_source"]["reconstructed"] == {"n": 10, "k": 4}


# ─── Bonus: role on candidate identity must match scope role ───────────


def test_candidate_role_must_match_scope_role():
    scope = _window_scope()
    candidates = [
        _make_candidate(
            source=SourceKind.SNAPSHOT,
            slice_family=SliceFamily.WINDOW,
            role=EvidenceRole.BAYES_PHASE2_COHORT,  # wrong role for this scope
            observed_date="2026-01-10",
            n=99,
            k=99,
        ),
        _window_snapshot("2026-01-10", n=10, k=4),
    ]
    merged = merge_evidence_candidates(scope, candidates)
    assert merged.totals.n == 10
    reasons = _skip_reasons(merged)
    # role mismatch surfaces as wrong_role at the merge boundary
    assert reasons.get("wrong_role", 0) >= 1
