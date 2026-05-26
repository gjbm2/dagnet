"""Blind contract tests for CF context/MECE evidence admission.

Expected values in this file come from
docs/current/project-generalise/cf-context-mece-evidence-admission-fix-plan-26-May-26.md
Stage 8, not from the implementation under test.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
    evidence_set_to_response_provenance,
    merge_evidence_candidates,
)
from runner.evidence_adapters import (
    bayes_file_evidence_to_candidates,
    classify_contextual_slice,
    reconstructed_asat_to_candidates,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
_BAYES_ROOT = _REPO_ROOT / "bayes"
if str(_BAYES_ROOT) not in sys.path:
    sys.path.insert(0, str(_BAYES_ROOT))

from bayes.compiler.evidence import _bind_from_snapshot_rows
from bayes.compiler.types import (
    EdgeEvidence,
    EdgeTopology,
    LatencyPrior,
    PathLatency,
    ProbabilityPrior,
)


def _scope(
    *,
    context_key: str | None = None,
    context_selector: str | None = None,
    mece_dimensions: tuple[str, ...] = (),
) -> EvidenceScope:
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from="X",
        subject_to="Y",
        date_from="2026-01-01",
        date_to="2026-01-31",
        as_at="2026-02-15",
        scenario_id="contract-scenario",
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=mece_dimensions,
    )


def _candidate(
    *,
    observed_date: str,
    n: int,
    k: int,
    context_key: str | None = None,
    context_selector: str | None = None,
    slice_family: SliceFamily = SliceFamily.WINDOW,
    retrieved_at: str = "2026-02-01",
) -> EvidenceCandidate:
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from="X",
            subject_to="Y",
            anchor=None,
            slice_family=slice_family,
            context_key=context_key,
            context_selector=context_selector,
            regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.WINDOW_DAY,
        ),
        n=n,
        k=k,
        provenance={"fixture": "blind-contract"},
    )


def _bayes_edge_topology() -> EdgeTopology:
    return EdgeTopology(
        edge_id="edge-1",
        from_node="X",
        to_node="Y",
        param_id="param-1",
        is_solo=True,
        has_latency=True,
        onset_delta_days=2.0,
        mu_prior=2.0,
        sigma_prior=0.5,
        t95_days=30.0,
        path_edge_ids=["edge-1"],
        path_latency=PathLatency(path_delta=2.0, path_mu=2.0, path_sigma=0.5),
        path_alternatives=[],
    )


def _bayes_edge_evidence() -> EdgeEvidence:
    return EdgeEvidence(
        edge_id="edge-1",
        param_id="param-1",
        file_path="parameters/param-1.yaml",
        prob_prior=ProbabilityPrior(alpha=1.0, beta=1.0, source="uninformative"),
        latency_prior=LatencyPrior(
            onset_delta_days=2.0,
            mu=2.0,
            sigma=0.5,
            onset_uncertainty=1.0,
        ),
    )


def _snapshot_row(
    *,
    anchor_day: str,
    retrieved_at: str,
    x: int,
    y: int,
    slice_key: str,
    core_hash: str = "hash-1",
) -> dict:
    return {
        "anchor_day": anchor_day,
        "retrieved_at": retrieved_at,
        "x": x,
        "y": y,
        "a": x,
        "slice_key": slice_key,
        "core_hash": core_hash,
    }


def _bayes_window_totals(rows: list[dict], *, mece_dimensions: tuple[str, ...]) -> tuple[int, int]:
    ev = _bayes_edge_evidence()
    _bind_from_snapshot_rows(
        ev,
        _bayes_edge_topology(),
        rows,
        datetime(2026, 3, 1),
        [],
        mece_dimensions=list(mece_dimensions),
    )
    n_total = 0
    k_total = 0
    for obs in ev.cohort_obs:
        if "window" not in obs.slice_dsl or "context" in obs.slice_dsl:
            continue
        for trajectory in obs.trajectories:
            n_total += int(trajectory.n)
            if trajectory.cumulative_y:
                k_total += int(trajectory.cumulative_y[-1])
        for daily in obs.daily:
            n_total += int(daily.n)
            k_total += int(daily.k)
    return n_total, k_total


def test_classifier_treats_context_prefixed_window_and_cohort_as_temporal_families():
    window = classify_contextual_slice("context(channel:google).window(1-Jan-26:31-Jan-26)")
    cohort = classify_contextual_slice(
        "context(channel:google).cohort(anchor-a, 1-Jan-26:31-Jan-26)"
    )

    assert window.family == SliceFamily.WINDOW
    assert window.context_selector == "context(channel:google)"
    assert cohort.family == SliceFamily.COHORT
    assert cohort.cohort_anchor == "anchor-a"
    assert cohort.context_selector == "context(channel:google)"


def test_adapters_emit_temporal_family_with_context_metadata_for_context_rows():
    file_candidates = bayes_file_evidence_to_candidates(
        {
            "window": [
                {
                    "sliceDSL": "context(channel:google).window(1-Jan-26:31-Jan-26)",
                    "dates": ["2026-01-05"],
                    "n_daily": [100],
                    "k_daily": [40],
                    "retrieved_at": "2026-02-01",
                }
            ],
        },
        scope=_scope(),
    )
    snapshot_candidates = reconstructed_asat_to_candidates(
        [
            {
                "anchor_day": "2026-01-05",
                "slice_key": "context(channel:google).window(1-Jan-26:31-Jan-26)",
                "core_hash": "hash-channel",
                "retrieved_at": datetime(2026, 2, 1),
                "a": 100,
                "x": 100,
                "y": 40,
            }
        ],
        scope=_scope(),
        asat_materialised=False,
    )

    for candidate in [*file_candidates, *snapshot_candidates]:
        assert candidate.identity.slice_family == SliceFamily.WINDOW
        assert candidate.identity.context_key == "channel"
        assert candidate.identity.context_selector == "context(channel:google)"


def test_adapter_emits_context_qualified_cohort_as_cohort_with_context_metadata():
    candidates = bayes_file_evidence_to_candidates(
        {
            "cohort": [
                {
                    "sliceDSL": "context(channel:google).cohort(anchor-a, 1-Jan-26:31-Jan-26)",
                    "dates": ["2026-01-05"],
                    "n_daily": [100],
                    "k_daily": [40],
                    "retrieved_at": "2026-02-01",
                }
            ],
        },
        scope=_scope(),
    )

    assert len(candidates) == 1
    assert candidates[0].identity.slice_family == SliceFamily.COHORT
    assert candidates[0].identity.anchor == "anchor-a"
    assert candidates[0].identity.context_key == "channel"
    assert candidates[0].identity.context_selector == "context(channel:google)"


def test_exact_context_scope_admits_matching_rows_and_rejects_wrong_values():
    merged = merge_evidence_candidates(
        _scope(
            context_key="channel",
            context_selector="context(channel:google)",
        ),
        [
            _candidate(
                observed_date="2026-01-05",
                n=100,
                k=40,
                context_key="channel",
                context_selector="context(channel:google)",
            ),
            _candidate(
                observed_date="2026-01-06",
                n=90,
                k=18,
                context_key="channel",
                context_selector="context(channel:meta)",
            ),
        ],
    )

    assert merged.totals.n == 100
    assert merged.totals.k == 40
    assert merged.provenance.skipped_counts_by_reason == {"context_mismatch": 1}
    assert merged.provenance.included_context_selectors == ("context(channel:google)",)


def test_uncontexted_scope_aggregates_mece_context_rows_and_refuses_non_mece_rows():
    merged_mece = merge_evidence_candidates(
        _scope(mece_dimensions=("channel",)),
        [
            _candidate(
                observed_date="2026-01-05",
                n=60,
                k=24,
                context_key="channel",
                context_selector="context(channel:google)",
            ),
            _candidate(
                observed_date="2026-01-05",
                n=40,
                k=12,
                context_key="channel",
                context_selector="context(channel:meta)",
            ),
        ],
    )
    merged_non_mece = merge_evidence_candidates(
        _scope(mece_dimensions=("channel",)),
        [
            _candidate(
                observed_date="2026-01-05",
                n=100,
                k=30,
                context_key="device",
                context_selector="context(device:mobile)",
            )
        ],
    )

    assert merged_mece.totals.n == 100
    assert merged_mece.totals.k == 36
    assert merged_mece.provenance.skipped_counts_by_reason == {}
    assert merged_non_mece.totals.n == 0
    assert merged_non_mece.provenance.skipped_counts_by_reason == {
        "unsafe_mece_aggregation": 1,
    }


def test_contract_oracle_bare_precedence_cross_dimension_guard_and_regime_labels():
    bare_precedence = merge_evidence_candidates(
        _scope(mece_dimensions=("channel",)),
        [
            _candidate(observed_date="2026-01-05", n=101, k=41),
            _candidate(
                observed_date="2026-01-05",
                n=60,
                k=24,
                context_key="channel",
                context_selector="context(channel:google)",
            ),
        ],
    )
    cross_dimension = merge_evidence_candidates(
        _scope(mece_dimensions=("channel", "device")),
        [
            _candidate(
                observed_date="2026-01-06",
                n=60,
                k=24,
                context_key="channel",
                context_selector="context(channel:google)",
                retrieved_at="2026-02-02",
            ),
            _candidate(
                observed_date="2026-01-06",
                n=55,
                k=22,
                context_key="device",
                context_selector="context(device:mobile)",
                retrieved_at="2026-02-02",
            ),
        ],
    )

    assert bare_precedence.totals.n == 101
    assert bare_precedence.totals.k == 41
    assert bare_precedence.provenance.skipped_counts_by_reason == {
        "bare_aggregate_precedence": 1,
    }
    assert bare_precedence.provenance.selected_regime_kind_by_retrieved_date == {
        "2026-02-01": "uncontexted",
    }

    assert cross_dimension.totals.n == 60
    assert cross_dimension.totals.k == 24
    assert cross_dimension.provenance.skipped_counts_by_reason == {
        "unsafe_mece_aggregation": 1,
    }
    assert cross_dimension.provenance.selected_regime_kind_by_retrieved_date == {
        "2026-02-02": "mece_partition",
    }


def test_shared_merge_totals_match_bayes_oracle_for_mece_and_bare_precedence():
    mece_rows = [
        _snapshot_row(
            anchor_day="2026-01-05",
            retrieved_at="2026-02-01T12:00:00Z",
            x=60,
            y=24,
            slice_key="context(channel:google).window(1-Jan-26:31-Jan-26)",
        ),
        _snapshot_row(
            anchor_day="2026-01-05",
            retrieved_at="2026-02-01T12:00:00Z",
            x=40,
            y=12,
            slice_key="context(channel:meta).window(1-Jan-26:31-Jan-26)",
        ),
    ]
    shared = merge_evidence_candidates(
        _scope(mece_dimensions=("channel",)),
        [
            _candidate(
                observed_date="2026-01-05",
                retrieved_at="2026-02-01",
                n=60,
                k=24,
                context_key="channel",
                context_selector="context(channel:google)",
            ),
            _candidate(
                observed_date="2026-01-05",
                retrieved_at="2026-02-01",
                n=40,
                k=12,
                context_key="channel",
                context_selector="context(channel:meta)",
            ),
        ],
    )
    assert (shared.totals.n, shared.totals.k) == _bayes_window_totals(
        mece_rows,
        mece_dimensions=("channel",),
    )

    bare_rows = [
        _snapshot_row(
            anchor_day="2026-01-06",
            retrieved_at="2026-02-02T12:00:00Z",
            x=101,
            y=41,
            slice_key="window(1-Jan-26:31-Jan-26)",
        ),
        _snapshot_row(
            anchor_day="2026-01-06",
            retrieved_at="2026-02-02T12:00:00Z",
            x=60,
            y=24,
            slice_key="context(channel:google).window(1-Jan-26:31-Jan-26)",
        ),
    ]
    shared_bare = merge_evidence_candidates(
        _scope(mece_dimensions=("channel",)),
        [
            _candidate(observed_date="2026-01-06", retrieved_at="2026-02-02", n=101, k=41),
            _candidate(
                observed_date="2026-01-06",
                retrieved_at="2026-02-02",
                n=60,
                k=24,
                context_key="channel",
                context_selector="context(channel:google)",
            ),
        ],
    )
    assert (shared_bare.totals.n, shared_bare.totals.k) == _bayes_window_totals(
        bare_rows,
        mece_dimensions=("channel",),
    )


def test_shared_merge_totals_match_bayes_oracle_for_non_mece_and_cross_dimension():
    non_mece_rows = [
        _snapshot_row(
            anchor_day="2026-01-07",
            retrieved_at="2026-02-03T12:00:00Z",
            x=90,
            y=27,
            slice_key="context(device:mobile).window(1-Jan-26:31-Jan-26)",
        )
    ]
    shared_non_mece = merge_evidence_candidates(
        _scope(mece_dimensions=("channel",)),
        [
            _candidate(
                observed_date="2026-01-07",
                retrieved_at="2026-02-03",
                n=90,
                k=27,
                context_key="device",
                context_selector="context(device:mobile)",
            )
        ],
    )
    assert (shared_non_mece.totals.n, shared_non_mece.totals.k) == _bayes_window_totals(
        non_mece_rows,
        mece_dimensions=("channel",),
    )

    cross_dim_rows = [
        _snapshot_row(
            anchor_day="2026-01-08",
            retrieved_at="2026-02-04T12:00:00Z",
            x=60,
            y=24,
            slice_key="context(channel:google).window(1-Jan-26:31-Jan-26)",
        ),
        _snapshot_row(
            anchor_day="2026-01-08",
            retrieved_at="2026-02-04T12:00:00Z",
            x=55,
            y=22,
            slice_key="context(device:mobile).window(1-Jan-26:31-Jan-26)",
        ),
    ]
    shared_cross_dim = merge_evidence_candidates(
        _scope(mece_dimensions=("channel", "device")),
        [
            _candidate(
                observed_date="2026-01-08",
                retrieved_at="2026-02-04",
                n=60,
                k=24,
                context_key="channel",
                context_selector="context(channel:google)",
            ),
            _candidate(
                observed_date="2026-01-08",
                retrieved_at="2026-02-04",
                n=55,
                k=22,
                context_key="device",
                context_selector="context(device:mobile)",
            ),
        ],
    )
    assert (shared_cross_dim.totals.n, shared_cross_dim.totals.k) == _bayes_window_totals(
        cross_dim_rows,
        mece_dimensions=("channel", "device"),
    )


def test_response_provenance_names_context_admission_not_only_unsupported_context():
    merged = merge_evidence_candidates(
        _scope(
            context_key="channel",
            context_selector="context(channel:google)",
        ),
        [
            _candidate(
                observed_date="2026-01-05",
                n=100,
                k=40,
                context_key="channel",
                context_selector="context(channel:google)",
            )
        ],
    )

    block = evidence_set_to_response_provenance(merged)

    assert block["totals"]["n"] == 100
    assert block["included_context_selectors"] == ["context(channel:google)"]
    assert block["skipped_counts_by_reason"] == {}
    assert block["skipped_context_selectors_by_reason"] == {}
