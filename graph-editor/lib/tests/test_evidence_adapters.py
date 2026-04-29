"""
Contract tests for the typed candidate adapters.

Tests target docs/current/project-bayes/73h-shared-evidence-merge-design.md.
- Stage 2 — `bayes_file_evidence_to_candidates`: engorged dict shape.
- Stage 5 — `bayes_parameter_file_evidence_to_candidates`: parameter file
  values[] shape, with Phase-2 provenance per §`bayes_phase2_cohort`.
- Stage 6 — `reconstructed_asat_to_candidates`: virtual-snapshot rows
  emitted as `RECONSTRUCTED` candidates with `asat_materialised=True`.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from evidence_merge import (
    EvidenceRole,
    EvidenceScope,
    SliceFamily,
    SourceKind,
    TemporalBasis,
    evidence_dedupe_key,
    merge_evidence_candidates,
)
from runner.evidence_adapters import (
    bayes_file_evidence_to_candidates,
    bayes_parameter_file_evidence_to_candidates,
    reconstructed_asat_to_candidates,
)


def _scope(
    *,
    role: EvidenceRole = EvidenceRole.WINDOW_SUBJECT_HELPER,
    subject_from: str = "C",
    subject_to: str = "D",
    date_from: str = "2026-01-01",
    date_to: str = "2026-12-31",
    as_at: str | None = "2026-12-31",
    anchor: str | None = None,
    context_key: str | None = None,
    regime_key: str | None = None,
    scope_population_identity: str | None = None,
) -> EvidenceScope:
    return EvidenceScope(
        role=role,
        subject_from=subject_from,
        subject_to=subject_to,
        date_from=date_from,
        date_to=date_to,
        as_at=as_at,
        scenario_id="scn-1",
        anchor=anchor,
        context_key=context_key,
        regime_key=regime_key,
        scope_population_identity=scope_population_identity,
    )


# ─── Adapter classifies window vs cohort vs context-qualified slices ──


def test_adapter_classifies_window_section_as_window_family():
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(1-Apr-26:4-Apr-26)",
                "dates": ["2026-04-01", "2026-04-02"],
                "n_daily": [10, 20],
                "k_daily": [4, 8],
                "retrieved_at": "2026-12-01",
            }
        ],
        "cohort": [],
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    assert len(candidates) == 2
    assert all(c.identity.slice_family == SliceFamily.WINDOW for c in candidates)
    assert all(c.source == SourceKind.FILE for c in candidates)
    assert all(c.coordinate.retrieved_at == "2026-12-01" for c in candidates)
    assert all(c.coordinate.temporal_basis == TemporalBasis.WINDOW_DAY for c in candidates)


def test_adapter_extracts_cohort_anchor_from_slice_dsl():
    bayes_evidence = {
        "window": [],
        "cohort": [
            {
                "sliceDSL": "cohort(B,1-Apr-26:4-Apr-26)",
                "dates": ["2026-04-01"],
                "n_daily": [15],
                "k_daily": [7],
                "retrieved_at": "2026-12-01",
            },
            {
                "sliceDSL": "cohort(1-Apr-26:4-Apr-26)",  # no explicit anchor
                "dates": ["2026-04-01"],
                "n_daily": [12],
                "k_daily": [3],
                "retrieved_at": "2026-12-01",
            },
        ],
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    assert len(candidates) == 2
    anchors = sorted(c.identity.anchor for c in candidates if c.identity.anchor)
    assert anchors == ["B"]
    # the bare cohort entry has anchor None
    bare = [c for c in candidates if c.identity.anchor is None]
    assert len(bare) == 1
    assert all(c.coordinate.temporal_basis == TemporalBasis.ANCHOR_DAY for c in candidates)


def test_adapter_marks_context_qualified_slices_as_context_family():
    bayes_evidence = {
        "cohort": [
            {
                "sliceDSL": "cohort(1-Apr-26:4-Apr-26).context(channel:paid)",
                "dates": ["2026-04-01"],
                "n_daily": [99],
                "k_daily": [99],
            }
        ]
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    assert len(candidates) == 1
    assert candidates[0].identity.slice_family == SliceFamily.CONTEXT


# ─── Adapter handles missing/malformed input gracefully ───────────────


def test_adapter_handles_none_input():
    assert bayes_file_evidence_to_candidates(None, scope=_scope()) == []


def test_adapter_handles_empty_dict():
    assert bayes_file_evidence_to_candidates({}, scope=_scope()) == []


def test_adapter_skips_entries_with_mismatched_array_lengths():
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(1-Apr-26:4-Apr-26)",
                "dates": ["2026-04-01", "2026-04-02"],
                "n_daily": [10],  # length 1 != len(dates)=2
                "k_daily": [4],
            },
            {
                "sliceDSL": "window(1-Apr-26:4-Apr-26)",
                "dates": ["2026-04-03"],
                "n_daily": [20],
                "k_daily": [8],
            },
        ]
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    # only the well-formed entry produces candidates
    assert len(candidates) == 1
    assert candidates[0].coordinate.observed_date == "2026-04-03"


def test_adapter_normalises_d_mmm_yy_dates():
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(...)",
                "dates": ["1-Apr-26", "2-Apr-26"],  # UK format
                "n_daily": [10, 20],
                "k_daily": [4, 8],
            }
        ]
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    assert len(candidates) == 2
    dates = sorted(c.coordinate.observed_date for c in candidates)
    assert dates == ["2026-04-01", "2026-04-02"]


def test_adapter_pulls_retrieved_at_from_data_source_when_missing_at_top():
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(...)",
                "dates": ["2026-04-01"],
                "n_daily": [10],
                "k_daily": [4],
                "data_source": {"retrieved_at": "2026-05-01"},
            }
        ]
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    assert len(candidates) == 1
    assert candidates[0].coordinate.retrieved_at == "2026-05-01"


# ─── End-to-end: adapter feeds the merge for the documented Q4 shape ──


def test_adapter_q4_window_subject_helper_under_wp8_off():
    """The fixture from test_conditioned_forecast_response_contract.py
    `test_wp8_off_supplements_only_uncovered_window_subject_helper_days`
    flowed through the typed merge:

    - window file rows on days 1-4 (n=10,20,30,40, k=1,2,3,4)
    - cohort file rows on days 1-4 (n=10,20,30,40, k=1,2,3,4) — wrong role
    - cohort.context(channel:paid) on days 1,3 — unsupported_context
    - snapshot covered days = {2026-04-02, 2026-04-04}

    Expected: only window rows on days 1 and 3 are admitted.
    Totals: n=40 (10+30), k=4 (1+3). Two days reported as covered.
    Two cohort entries are skipped as wrong_role (one per day each).
    The context-qualified entry contributes two unsupported_context skips.
    """
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(1-Apr-26:4-Apr-26)",
                "dates": [
                    "2026-04-01",
                    "2026-04-02",
                    "2026-04-03",
                    "2026-04-04",
                ],
                "n_daily": [10, 20, 30, 40],
                "k_daily": [1, 2, 3, 4],
                "retrieved_at": "2026-04-30",
            }
        ],
        "cohort": [
            {
                "sliceDSL": "cohort(1-Apr-26:4-Apr-26)",
                "dates": [
                    "2026-04-01",
                    "2026-04-02",
                    "2026-04-03",
                    "2026-04-04",
                ],
                "n_daily": [10, 20, 30, 40],
                "k_daily": [1, 2, 3, 4],
                "retrieved_at": "2026-04-30",
            },
            {
                "sliceDSL": "cohort(1-Apr-26:4-Apr-26).context(channel:paid)",
                "dates": ["2026-04-01", "2026-04-03"],
                "n_daily": [999, 999],
                "k_daily": [999, 999],
                "retrieved_at": "2026-04-30",
            },
        ],
    }

    scope = _scope(
        date_from="2026-04-01",
        date_to="2026-04-04",
        as_at="2026-04-30",
    )
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=scope
    )
    # 4 window + 4 cohort + 2 context = 10 candidates from the adapter
    assert len(candidates) == 10

    # Build snapshot covered set: window-family identity, days 2 and 4
    window_window_ident = next(
        c.identity for c in candidates if c.identity.slice_family == SliceFamily.WINDOW
    )
    covered = {
        (evidence_dedupe_key(window_window_ident), "2026-04-02"),
        (evidence_dedupe_key(window_window_ident), "2026-04-04"),
    }

    merged = merge_evidence_candidates(
        scope, candidates, snapshot_covered_observations=covered
    )

    # Only window days 1 and 3 are admitted (4 cohort + 2 context skipped, 2 covered)
    assert merged.totals.n == 40  # 10 + 30
    assert merged.totals.k == 4  # 1 + 3
    reasons = dict(merged.provenance.skipped_counts_by_reason)
    assert reasons.get("wrong_role") == 4
    assert reasons.get("unsupported_context") == 2
    assert reasons.get("covered_by_snapshot") == 2


# ─── Stage 5: bayes_parameter_file_evidence_to_candidates ──────────────


class _FakeEdge:
    """Minimal stub for the EdgeTopology interface the adapter inspects."""

    def __init__(
        self,
        *,
        edge_id: str = "edge-xy",
        from_node: str = "X",
        to_node: str = "Y",
        path_edge_ids: list[str] | None = None,
    ):
        self.edge_id = edge_id
        self.from_node = from_node
        self.to_node = to_node
        self.path_edge_ids = list(path_edge_ids if path_edge_ids is not None else [edge_id])


def _phase2_scope(
    *,
    subject_from: str = "X",
    subject_to: str = "Y",
    date_from: str = "0001-01-01",
    date_to: str = "9999-12-31",
) -> EvidenceScope:
    return EvidenceScope(
        role=EvidenceRole.BAYES_PHASE2_COHORT,
        subject_from=subject_from,
        subject_to=subject_to,
        date_from=date_from,
        date_to=date_to,
    )


def test_bayes_pf_adapter_emits_cohort_observations_under_phase2_role():
    """Design §Bayes Binder Tests #2: Phase 2 emits cohort observations
    under the explicit bayes_phase2_cohort role.
    """
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01", "2026-04-02"],
            "n_daily": [10, 11],
            "k_daily": [1, 2],
            "data_source": {"retrieved_at": "2026-04-30"},
        }
    ]
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=_phase2_scope(), edge_topology=_FakeEdge()
    )
    assert len(candidates) == 2
    assert all(c.identity.role == EvidenceRole.BAYES_PHASE2_COHORT for c in candidates)
    assert all(c.identity.slice_family == SliceFamily.COHORT for c in candidates)
    assert all(c.identity.anchor == "simple-a" for c in candidates)
    assert all(c.coordinate.temporal_basis == TemporalBasis.ANCHOR_DAY for c in candidates)


def test_bayes_pf_adapter_skips_window_entries_for_phase2_role_via_merge():
    """Design §Bayes Binder Tests #1: Phase 1 does not supplement cohort
    slices into window evidence — the dual: under Phase 2, window file
    rows are skipped as `wrong_role` by the merge.
    """
    values = [
        {
            "sliceDSL": "window(-30d:)",
            "dates": ["2026-04-01"],
            "n_daily": [99],
            "k_daily": [9],
            "data_source": {"retrieved_at": "2026-04-30"},
        },
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01"],
            "n_daily": [10],
            "k_daily": [1],
            "data_source": {"retrieved_at": "2026-04-30"},
        },
    ]
    scope = _phase2_scope(date_from="2026-01-01", date_to="2026-12-31")
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=scope, edge_topology=_FakeEdge()
    )
    merged = merge_evidence_candidates(scope, candidates)
    # Only the cohort row makes it through; window is wrong_role.
    assert merged.totals.n == 10
    assert merged.totals.k == 1
    reasons = dict(merged.provenance.skipped_counts_by_reason)
    assert reasons.get("wrong_role") == 1


def test_bayes_pf_adapter_first_edge_marked_in_provenance():
    """Design §Bayes Binder Tests #3: first-edge cohort daily observations
    remain eligible for native daily likelihoods. The adapter must mark
    first-edge candidates unambiguously so model.py can route them
    without re-parsing slice strings.
    """
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01"],
            "n_daily": [10],
            "k_daily": [1],
            "data_source": {"retrieved_at": "2026-04-30"},
        }
    ]
    edge_first = _FakeEdge(edge_id="e1", path_edge_ids=["e1"])  # depth 1
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=_phase2_scope(), edge_topology=edge_first
    )
    assert len(candidates) == 1
    prov = candidates[0].provenance
    assert prov["edge_depth_from_anchor"] == 1
    assert prov["is_first_edge"] is True
    assert prov["path_edge_ids"] == ("e1",)


def test_bayes_pf_adapter_downstream_edge_not_marked_first_edge():
    """Design §Bayes Binder Tests #4: downstream cohort observations
    remain trajectory/path observations and are not silently promoted to
    unrestricted per-edge daily likelihoods. Provenance must distinguish
    downstream edges from first-edge ones.
    """
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01"],
            "n_daily": [10],
            "k_daily": [1],
            "data_source": {"retrieved_at": "2026-04-30"},
        }
    ]
    edge_downstream = _FakeEdge(edge_id="e3", path_edge_ids=["e1", "e2", "e3"])
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=_phase2_scope(), edge_topology=edge_downstream
    )
    assert len(candidates) == 1
    prov = candidates[0].provenance
    assert prov["edge_depth_from_anchor"] == 3
    assert prov["is_first_edge"] is False
    assert prov["path_edge_ids"] == ("e1", "e2", "e3")


def test_bayes_pf_adapter_phase2_provenance_is_complete():
    """Design §Bayes Binder Tests #5: Phase 2 provenance includes cohort
    anchor, cohort selector, edge depth from anchor, subject span,
    temporal basis, path identity, and population identity.
    """
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01"],
            "n_daily": [10],
            "k_daily": [1],
            "data_source": {"retrieved_at": "2026-04-30"},
        }
    ]
    edge = _FakeEdge(edge_id="e2", from_node="X", to_node="Y", path_edge_ids=["e1", "e2"])
    candidates = bayes_parameter_file_evidence_to_candidates(
        values,
        scope=_phase2_scope(),
        edge_topology=edge,
        anchor_node="simple-a",
    )
    assert len(candidates) == 1
    c = candidates[0]
    prov = c.provenance
    # Required Phase 2 provenance keys.
    assert prov["cohort_anchor"] == "simple-a"
    assert prov["cohort_selector"] == "cohort(simple-a, 1-Apr-26:5-Apr-26)"
    assert prov["edge_depth_from_anchor"] == 2
    assert prov["is_first_edge"] is False
    assert prov["subject_edge_id"] == "e2"
    assert prov["subject_edge_from"] == "X"
    assert prov["subject_edge_to"] == "Y"
    assert prov["temporal_basis"] == TemporalBasis.ANCHOR_DAY.value
    assert prov["path_edge_ids"] == ("e1", "e2")
    assert prov["anchor_node"] == "simple-a"
    # Population identity is carried via EvidenceIdentity, not provenance, by design.
    # For Phase 2 cohort role with no scope-level population identity, identity
    # carries None (matches the merge's default; the cohort anchor lives separately).
    assert c.identity.anchor == "simple-a"


def test_bayes_pf_adapter_skips_context_qualified_cohort():
    """Design §Bayes Binder Tests #6: existing MECE/context behaviour
    unchanged. Context-qualified entries flow through as CONTEXT family
    so the merge skips them as `unsupported_context` for Stage-1 roles.
    """
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26).context(channel:google)",
            "dates": ["2026-04-01"],
            "n_daily": [50],
            "k_daily": [10],
            "data_source": {"retrieved_at": "2026-04-30"},
        }
    ]
    scope = _phase2_scope()
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=scope, edge_topology=_FakeEdge()
    )
    assert len(candidates) == 1
    assert candidates[0].identity.slice_family == SliceFamily.CONTEXT
    merged = merge_evidence_candidates(scope, candidates)
    assert merged.totals.n == 0
    assert merged.totals.k == 0
    reasons = dict(merged.provenance.skipped_counts_by_reason)
    assert reasons.get("unsupported_context") == 1


def test_bayes_pf_adapter_handles_empty_and_malformed_inputs():
    """The adapter must gracefully handle None, empty list, and entries
    with mismatched array lengths or missing arrays.
    """
    scope = _phase2_scope()
    edge = _FakeEdge()
    assert bayes_parameter_file_evidence_to_candidates(None, scope=scope, edge_topology=edge) == []
    assert bayes_parameter_file_evidence_to_candidates([], scope=scope, edge_topology=edge) == []
    # Mismatched array lengths -> entry silently dropped.
    bad_values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01", "2026-04-02"],
            "n_daily": [10],  # length mismatch
            "k_daily": [1, 2],
        }
    ]
    assert bayes_parameter_file_evidence_to_candidates(bad_values, scope=scope, edge_topology=edge) == []


def test_bayes_pf_adapter_emits_documented_q4_fixture_phase2_supplement():
    """Phase 2 supplement contract: under role `BAYES_PHASE2_COHORT`,
    the typed merge admits cohort daily points that are NOT covered by
    snapshot, skipping window rows (wrong role) and context-qualified
    rows (unsupported context). This was originally the byte-equality
    target against the now-retired `merge_file_evidence_for_role`.
    """
    from evidence_merge import normalise_iso_date

    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"],
            "n_daily": [10, 11, 12, 13],
            "k_daily": [1, 2, 3, 4],
            "data_source": {"retrieved_at": "2026-04-30"},
        },
        {
            "sliceDSL": "cohort(simple-b, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01", "2026-04-02", "2026-04-03"],
            "n_daily": [20, 21, 22],
            "k_daily": [5, 6, 7],
            "data_source": {"retrieved_at": "2026-04-30"},
        },
        {
            "sliceDSL": "window(-30d:)",
            "dates": ["2026-04-01"],
            "n_daily": [99],
            "k_daily": [1],
            "data_source": {"retrieved_at": "2026-04-30"},
        },
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26).context(channel:google)",
            "dates": ["2026-04-01"],
            "n_daily": [50],
            "k_daily": [10],
            "data_source": {"retrieved_at": "2026-04-30"},
        },
    ]
    snapshot_covered_days = {"2026-04-02", "2026-04-04"}

    scope = _phase2_scope()
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=scope, edge_topology=_FakeEdge()
    )
    covered_iso = {
        iso for iso in (normalise_iso_date(d) for d in snapshot_covered_days) if iso
    }
    candidate_keys = {evidence_dedupe_key(c.identity) for c in candidates}
    covered_obs = {(k, d) for k in candidate_keys for d in covered_iso}
    typed = merge_evidence_candidates(
        scope, candidates, snapshot_covered_observations=covered_obs
    )
    typed_points = sorted(
        (
            p.candidate.coordinate.observed_date,
            p.n,
            p.k,
            p.candidate.provenance.get("sliceDSL"),
        )
        for p in typed.points
    )

    expected_points = [
        ("2026-04-01", 10, 1, "cohort(simple-a, 1-Apr-26:5-Apr-26)"),
        ("2026-04-01", 20, 5, "cohort(simple-b, 1-Apr-26:5-Apr-26)"),
        ("2026-04-03", 12, 3, "cohort(simple-a, 1-Apr-26:5-Apr-26)"),
        ("2026-04-03", 22, 7, "cohort(simple-b, 1-Apr-26:5-Apr-26)"),
    ]
    assert typed_points == expected_points
    assert typed.totals.n == 64  # 10 + 20 + 12 + 22
    assert typed.totals.k == 16  # 1 + 5 + 3 + 7
    reasons = dict(typed.provenance.skipped_counts_by_reason)
    assert reasons.get("wrong_role") == 1  # window row
    assert reasons.get("unsupported_context") == 1
    assert reasons.get("covered_by_snapshot") == 3  # 2 cohort-a + 1 cohort-b


# ─── Stage 6: reconstructed_asat_to_candidates ─────────────────────────


def _virtual_snapshot_row(
    *,
    anchor_day: str,
    slice_key: str,
    a: int,
    x: int,
    y: int,
    retrieved_at: str | datetime = "2026-04-30",
    core_hash: str = "abc123",
) -> dict:
    return {
        "anchor_day": anchor_day,
        "slice_key": slice_key,
        "core_hash": core_hash,
        "retrieved_at": retrieved_at,
        "a": a,
        "x": x,
        "y": y,
        "median_lag_days": 5.0,
        "mean_lag_days": 5.5,
        "anchor_median_lag_days": 0.0,
        "anchor_mean_lag_days": 0.0,
        "onset_delta_days": 0.0,
    }


def test_reconstructed_asat_adapter_emits_reconstructed_kind_and_asat_materialised():
    """The Stage 6 adapter must emit `SourceKind.RECONSTRUCTED` candidates
    with `asat_materialised=True` so the merge admits them past its
    `as_at` boundary as the materialisation point itself.
    """
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="window(-90d:)",
            a=100, x=80, y=10,
        )
    ]
    scope = _scope(role=EvidenceRole.WINDOW_SUBJECT_HELPER, as_at="2026-04-15")
    candidates = reconstructed_asat_to_candidates(rows, scope=scope)
    assert len(candidates) == 1
    c = candidates[0]
    assert c.source == SourceKind.RECONSTRUCTED
    assert c.coordinate.asat_materialised is True
    assert c.coordinate.observed_date == "2026-04-01"


def test_reconstructed_asat_adapter_window_uses_x_as_denominator():
    """For window slices the adapter must use `x` (from-node arrivals)
    as the denominator and `y` as the numerator — edge-local semantics.
    """
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="window(-90d:)",
            a=999, x=80, y=10,
        )
    ]
    scope = _scope(role=EvidenceRole.WINDOW_SUBJECT_HELPER)
    candidates = reconstructed_asat_to_candidates(rows, scope=scope)
    assert candidates[0].n == 80  # x
    assert candidates[0].k == 10  # y
    assert candidates[0].identity.slice_family == SliceFamily.WINDOW
    assert candidates[0].coordinate.temporal_basis == TemporalBasis.WINDOW_DAY


def test_reconstructed_asat_adapter_cohort_defaults_to_x_as_denominator():
    """For cohort slices the adapter defaults to `n=x, k=y` — edge rate
    evidence (Y/X), not anchor-rooted Y/A. This is the correct mapping
    for general cohort(A, X→Y) where the displayed/conditioned edge
    rate is Y/X. The anchor entrants count `a` is preserved on
    provenance for callers that need carrier-side counts.
    """
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="cohort(simple-a, 1-Apr-26:30-Apr-26)",
            a=500, x=80, y=10,
        )
    ]
    scope = _scope(role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT, anchor="simple-a")
    candidates = reconstructed_asat_to_candidates(rows, scope=scope)
    assert len(candidates) == 1
    c = candidates[0]
    assert c.n == 80  # x — edge rate denominator
    assert c.k == 10  # y
    assert c.identity.slice_family == SliceFamily.COHORT
    assert c.identity.anchor == "simple-a"
    assert c.coordinate.temporal_basis == TemporalBasis.ANCHOR_DAY
    # Anchor entrants preserved for carrier-side use.
    assert c.provenance["anchor_entrants"] == 500


def test_reconstructed_asat_adapter_is_window_false_forces_n_a_for_wp8_first_edge():
    """Explicit `is_window=False` forces `n=a` — the WP8 first-edge
    identity case where the rate IS genuinely Y/A because anchor==X
    so a==x. This override must remain available."""
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="cohort(simple-a, 1-Apr-26:30-Apr-26)",
            a=500, x=500, y=10,
        )
    ]
    scope = _scope(role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT, anchor="simple-a")
    candidates = reconstructed_asat_to_candidates(rows, scope=scope, is_window=False)
    assert candidates[0].n == 500  # a — first-edge identity


def test_reconstructed_asat_adapter_skips_unknown_slice_keys():
    """Rows whose slice_key is neither window/cohort/context are dropped."""
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="garbage",
            a=1, x=1, y=0,
        )
    ]
    scope = _scope()
    assert reconstructed_asat_to_candidates(rows, scope=scope) == []


def test_reconstructed_asat_adapter_marks_context_qualified_rows_as_context():
    """Context-qualified slice_keys must produce CONTEXT-family candidates
    so the merge skips them as `unsupported_context` for Stage-1 roles
    (mirrors the file-side adapter's behaviour).
    """
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="window(-90d:).context(channel:google)",
            a=10, x=10, y=2,
        )
    ]
    scope = _scope(role=EvidenceRole.WINDOW_SUBJECT_HELPER)
    candidates = reconstructed_asat_to_candidates(rows, scope=scope)
    assert len(candidates) == 1
    assert candidates[0].identity.slice_family == SliceFamily.CONTEXT


def test_reconstructed_asat_adapter_handles_datetime_retrieved_at():
    """`query_virtual_snapshot` returns retrieved_at as datetime when
    invoked from Python; the adapter must normalise it to ISO date.
    """
    dt = datetime(2026, 4, 15, 12, 30, 0)
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="window(-90d:)",
            a=10, x=10, y=2,
            retrieved_at=dt,
        )
    ]
    scope = _scope(role=EvidenceRole.WINDOW_SUBJECT_HELPER)
    candidates = reconstructed_asat_to_candidates(rows, scope=scope)
    assert candidates[0].coordinate.retrieved_at == "2026-04-15"


def test_reconstructed_asat_adapter_admitted_past_as_at_boundary():
    """A reconstructed candidate must NOT be skipped as `after_as_at`
    even when its retrieved_at is after the scope's as_at — the
    reconstruction IS the as_at materialisation point. This is the
    distinction between RECONSTRUCTED and FILE candidates per design.
    """
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="window(-90d:)",
            a=100, x=80, y=10,
            retrieved_at="2026-12-31",  # after the as_at below
        )
    ]
    scope = EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from="C",
        subject_to="D",
        date_from="2026-01-01",
        date_to="2026-12-31",
        as_at="2026-06-30",
    )
    candidates = reconstructed_asat_to_candidates(rows, scope=scope)
    merged = merge_evidence_candidates(scope, candidates)
    # The reconstructed row is admitted despite retrieved_at > as_at.
    assert merged.totals.n == 80
    assert merged.totals.k == 10
    assert merged.provenance.asat_materialised_present is True


def test_reconstructed_asat_adapter_handles_none_and_empty_inputs():
    scope = _scope()
    assert reconstructed_asat_to_candidates(None, scope=scope) == []
    assert reconstructed_asat_to_candidates([], scope=scope) == []


def test_reconstructed_asat_adapter_is_window_override():
    """The explicit `is_window` override forces the denominator mapping
    even when the slice_key would suggest the other family. Useful for
    WP8-off cohort-anchor rows being read as window helpers.
    """
    rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="cohort(simple-a, 1-Apr-26:30-Apr-26)",
            a=500, x=80, y=10,
        )
    ]
    scope = _scope(role=EvidenceRole.WINDOW_SUBJECT_HELPER)
    # Force window denominator (x) even though slice_key is cohort.
    candidates = reconstructed_asat_to_candidates(
        rows, scope=scope, is_window=True
    )
    assert candidates[0].n == 80  # x, not a


def test_bayes_file_adapter_emits_reconstructed_for_fe_asat_markers():
    """When the FE has reconstructed an entry from the snapshot DB
    (`fileToGraphSync.ts` writes `_asat` and `_asat_retrieved_at` markers
    onto the values[] entry), the Stage 2 adapter must emit
    `SourceKind.RECONSTRUCTED` candidates with `asat_materialised=True`.
    Otherwise the merge would treat them as raw file rows and skip them
    as `after_as_at` when their nominal retrieved_at exceeds scope.as_at.
    """
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(-90d:)",
                "dates": ["2026-04-01", "2026-04-02"],
                "n_daily": [10, 20],
                "k_daily": [4, 8],
                "_asat": "1-Apr-26",
                "_asat_retrieved_at": "2026-04-01",
            }
        ],
        "cohort": [],
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope(as_at="2026-04-15")
    )
    assert len(candidates) == 2
    for c in candidates:
        assert c.source == SourceKind.RECONSTRUCTED
        assert c.coordinate.asat_materialised is True
        assert c.provenance["asat_reconstructed"] is True
        assert c.provenance["asat"] == "1-Apr-26"
        assert c.provenance["asat_retrieved_at"] == "2026-04-01"


def test_bayes_file_adapter_emits_file_for_unmarked_entries():
    """Sanity check: entries without the FE asat markers stay as
    `SourceKind.FILE` with `asat_materialised=False`. This is the
    pre-existing Stage 2 behaviour."""
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(-90d:)",
                "dates": ["2026-04-01"],
                "n_daily": [10],
                "k_daily": [4],
                "retrieved_at": "2026-04-15",
            }
        ],
        "cohort": [],
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope()
    )
    assert len(candidates) == 1
    assert candidates[0].source == SourceKind.FILE
    assert candidates[0].coordinate.asat_materialised is False
    assert candidates[0].provenance["asat_reconstructed"] is False


def test_bayes_file_adapter_asat_reconstructed_admitted_past_as_at():
    """End-to-end: an FE-asat-reconstructed entry merges past the
    scope's `as_at` boundary. A naive raw file entry with the same
    nominal retrieved_at would be skipped as `after_as_at`.
    """
    # FE-reconstructed: as_at=2026-06-30, retrieved_at marker reflects
    # the latest snapshot used (could be days/weeks earlier — what
    # matters is that the entry IS the as-at materialisation).
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(-90d:)",
                "dates": ["2026-06-01"],
                "n_daily": [50],
                "k_daily": [10],
                "_asat": "30-Jun-26",
                "_asat_retrieved_at": "2026-06-30",
            }
        ],
        "cohort": [],
    }
    scope = EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from="C",
        subject_to="D",
        date_from="2026-01-01",
        date_to="2026-12-31",
        as_at="2026-06-30",
    )
    candidates = bayes_file_evidence_to_candidates(bayes_evidence, scope=scope)
    merged = merge_evidence_candidates(scope, candidates)
    assert merged.totals.n == 50
    assert merged.totals.k == 10
    assert merged.provenance.asat_materialised_present is True


def test_bayes_pf_adapter_emits_reconstructed_for_fe_asat_markers():
    """Stage 5 parameter-file adapter must also recognise FE asat markers
    and emit RECONSTRUCTED. Bayes consumes parameter files directly, and
    the same FE-reconstructed values can land via that path.
    """
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01"],
            "n_daily": [10],
            "k_daily": [1],
            "_asat": "5-Apr-26",
            "_asat_retrieved_at": "2026-04-05",
        }
    ]
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=_phase2_scope(), edge_topology=_FakeEdge()
    )
    assert len(candidates) == 1
    c = candidates[0]
    assert c.source == SourceKind.RECONSTRUCTED
    assert c.coordinate.asat_materialised is True
    assert c.provenance["asat_reconstructed"] is True
    assert c.provenance["asat"] == "5-Apr-26"
    assert c.provenance["asat_retrieved_at"] == "2026-04-05"


def test_bayes_file_adapter_treats_tier2_truncation_as_raw_file():
    """Tier-2 FE truncation writes `_asat` + `_asat_truncated=true` but
    NOT `_asat_retrieved_at`. These entries are an approximation —
    cohorts appear too mature because Y values are the latest
    observation. They MUST NOT bypass `retrieved_at`/`as_at` admission;
    they are raw file evidence subject to the merge's standard gates.
    """
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(-90d:)",
                "dates": ["2026-04-01"],
                "n_daily": [10],
                "k_daily": [4],
                "_asat": "30-Apr-26",
                "_asat_truncated": True,
                # No _asat_retrieved_at — distinguishes tier-2 from tier-1.
                # No data_source.retrieved_at either: tier-2 has no
                # retrieved_at to enforce against.
            }
        ],
        "cohort": [],
    }
    candidates = bayes_file_evidence_to_candidates(
        bayes_evidence, scope=_scope(as_at="2026-04-30")
    )
    assert len(candidates) == 1
    c = candidates[0]
    assert c.source == SourceKind.FILE
    assert c.coordinate.asat_materialised is False


def test_bayes_file_adapter_tier2_truncation_skipped_when_as_at_set():
    """End-to-end: a tier-2 truncated entry without retrieved_at gets
    skipped by the merge as `missing_retrieved_at` when the scope has
    an as_at boundary. This is the correct fail-closed behaviour for
    an approximation that cannot be admitted historically.
    """
    bayes_evidence = {
        "window": [
            {
                "sliceDSL": "window(-90d:)",
                "dates": ["2026-04-01"],
                "n_daily": [10],
                "k_daily": [4],
                "_asat": "30-Apr-26",
                "_asat_truncated": True,
            }
        ],
        "cohort": [],
    }
    scope = EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from="C",
        subject_to="D",
        date_from="2026-01-01",
        date_to="2026-12-31",
        as_at="2026-06-30",
    )
    candidates = bayes_file_evidence_to_candidates(bayes_evidence, scope=scope)
    merged = merge_evidence_candidates(scope, candidates)
    assert merged.totals.n == 0
    assert merged.totals.k == 0
    assert merged.provenance.skipped_counts_by_reason.get("missing_retrieved_at") == 1


def test_evidence_dedupe_key_includes_role():
    """Role is part of the summability identity per 73h. Two candidates
    with the same family/subject/anchor/context but different roles
    MUST have different dedupe keys; otherwise BAYES_PHASE1_WINDOW and
    WINDOW_SUBJECT_HELPER could collide.
    """
    from evidence_merge import (
        EvidenceIdentity,
        SliceFamily as SF,
    )

    def _ident(role):
        return EvidenceIdentity(
            role=role,
            subject_from="C",
            subject_to="D",
            anchor=None,
            slice_family=SF.WINDOW,
            context_key=None,
            regime_key=None,
            population_identity=None,
        )

    helper_key = evidence_dedupe_key(_ident(EvidenceRole.WINDOW_SUBJECT_HELPER))
    bayes_key = evidence_dedupe_key(_ident(EvidenceRole.BAYES_PHASE1_WINDOW))
    assert helper_key != bayes_key


def test_bayes_pf_adapter_emits_file_for_unmarked_entries():
    """Sanity check: Stage 5 adapter still emits FILE for unmarked entries."""
    values = [
        {
            "sliceDSL": "cohort(simple-a, 1-Apr-26:5-Apr-26)",
            "dates": ["2026-04-01"],
            "n_daily": [10],
            "k_daily": [1],
            "data_source": {"retrieved_at": "2026-04-30"},
        }
    ]
    candidates = bayes_parameter_file_evidence_to_candidates(
        values, scope=_phase2_scope(), edge_topology=_FakeEdge()
    )
    assert len(candidates) == 1
    assert candidates[0].source == SourceKind.FILE
    assert candidates[0].coordinate.asat_materialised is False
    assert candidates[0].provenance["asat_reconstructed"] is False


def test_reconstructed_asat_adapter_coexists_with_raw_file_in_one_merge():
    """Reconstructed-as-at candidates must coexist with raw FILE
    candidates whose own `retrieved_at` is still enforced. This is the
    design's mode-1 mixed merge: RECONSTRUCTED rows materialise the
    as-at boundary; FILE rows must still pass the freshness gates.
    """
    # Reconstructed window row at 2026-04-01 (a=100, x=80, y=10).
    rec_rows = [
        _virtual_snapshot_row(
            anchor_day="2026-04-01",
            slice_key="window(-90d:)",
            a=100, x=80, y=10,
            retrieved_at="2026-12-31",
        )
    ]
    # File row also at 2026-04-01 (n=70, k=12, retrieved_at within scope).
    file_evidence = {
        "window": [
            {
                "sliceDSL": "window(-90d:)",
                "dates": ["2026-04-01", "2026-04-02"],
                "n_daily": [70, 30],
                "k_daily": [12, 5],
                "retrieved_at": "2026-04-30",
            }
        ],
        "cohort": [],
    }
    scope = EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from="C",
        subject_to="D",
        date_from="2026-01-01",
        date_to="2026-12-31",
        as_at="2026-06-30",
    )
    rec_candidates = reconstructed_asat_to_candidates(rec_rows, scope=scope)
    file_candidates = bayes_file_evidence_to_candidates(file_evidence, scope=scope)
    merged = merge_evidence_candidates(scope, [*rec_candidates, *file_candidates])

    # The reconstructed row wins for 2026-04-01 (snapshot/reconstructed
    # beats file when they share an identity+date). The file row for
    # 2026-04-02 contributes uniquely.
    assert merged.totals.n == 80 + 30
    assert merged.totals.k == 10 + 5
    assert merged.provenance.asat_materialised_present is True
    counts = dict(merged.provenance.included_counts_by_source)
    assert counts.get(SourceKind.RECONSTRUCTED, 0) == 1
    assert counts.get(SourceKind.FILE, 0) == 1
