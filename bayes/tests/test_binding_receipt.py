"""Binding receipt contract tests — §16.11 fixtures 1-8.

Each test builds minimal TopologyAnalysis + BoundEvidence + FE expectations,
calls _build_binding_receipt, and asserts the receipt fields match.

No DB, no server, no MCMC. Pure logic tests on the receipt builder.
"""

import sys
from pathlib import Path

import pytest

# Ensure repo root is on path
repo_root = str(Path(__file__).resolve().parent.parent.parent)
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(repo_root) / "graph-editor" / "lib"))

from compiler.types import (
    EdgeTopology, TopologyAnalysis, BranchGroup,
    EdgeEvidence, BoundEvidence, ProbabilityPrior,
    CohortObservation, CohortDailyTrajectory, CohortDailyObs,
)
from snapshot_regime_selection import RegimeSelection, CandidateRegime
from worker import _build_binding_receipt


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _topo(edges: dict[str, dict]) -> TopologyAnalysis:
    """Build a minimal TopologyAnalysis from {edge_id: {param_id, ...}}."""
    topo_edges = {}
    for eid, props in edges.items():
        topo_edges[eid] = EdgeTopology(
            edge_id=eid,
            from_node="node-a",
            to_node="node-b",
            param_id=props.get("param_id", ""),
        )
    return TopologyAnalysis(
        anchor_node_id="node-a",
        edges=topo_edges,
        branch_groups={},
        topo_order=list(edges.keys()),
    )


def _evidence(edges: dict[str, dict]) -> BoundEvidence:
    """Build minimal BoundEvidence from {edge_id: {total_n, cohort_obs, ...}}."""
    ev_edges = {}
    for eid, props in edges.items():
        ev = EdgeEvidence(
            edge_id=eid,
            param_id=props.get("param_id", ""),
            file_path=props.get("file_path", ""),
        )
        ev.total_n = props.get("total_n", 0)
        ev.skipped = props.get("skipped", False)
        ev.skip_reason = props.get("skip_reason", "")
        ev.rows_received = props.get("rows_received", 0)
        ev.rows_post_aggregation = props.get("rows_post_aggregation", 0)
        ev.rows_aggregated = props.get("rows_aggregated", 0)
        ev.has_window = props.get("has_window", False)
        ev.has_cohort = props.get("has_cohort", False)

        for co_props in props.get("cohort_obs", []):
            co = CohortObservation(slice_dsl=co_props["slice_dsl"])
            for t in co_props.get("trajectories", []):
                co.trajectories.append(CohortDailyTrajectory(
                    date=t["date"],
                    n=t.get("n", 100),
                    obs_type=t.get("obs_type", "window"),
                ))
            for d in co_props.get("daily", []):
                co.daily.append(CohortDailyObs(
                    date=d["date"],
                    n=d.get("n", 100),
                    k=d.get("k", 50),
                    age_days=d.get("age_days", 30.0),
                ))
            ev.cohort_obs.append(co)

        ev_edges[eid] = ev
    return BoundEvidence(edges=ev_edges)


def _regime_sel(rows: list[dict], regime_hash: str) -> RegimeSelection:
    """Build a RegimeSelection with all rows assigned to one regime."""
    regime = CandidateRegime(core_hash=regime_hash)
    # One regime per unique retrieved_at date
    dates = set()
    for r in rows:
        ret = str(r.get("retrieved_at", ""))
        if ret:
            dates.add(ret)
    regime_per_date = {d: regime for d in dates}
    return RegimeSelection(rows=rows, regime_per_date=regime_per_date)


# ---------------------------------------------------------------------------
# Fixture 1: Happy path
# ---------------------------------------------------------------------------

class TestFixture01HappyPath:
    """FE expects 1 hash, DB has rows under that hash.
    Receipt: pass, zero divergences."""

    def test_happy_path(self):
        edge_id = "edge-1"
        core_hash = "hash-abc123"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": core_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-04-01"},
        ]
        candidate_regimes = {
            edge_id: [{"core_hash": core_hash}],
        }

        # DB returned 10 rows, regime selection kept all
        raw_rows = [{"core_hash": core_hash, "retrieved_at": f"2025-03-{i:02d}"}
                    for i in range(1, 11)]
        rows_raw = {edge_id: len(raw_rows)}
        hashes_seen = {edge_id: {core_hash}}
        regimes = {edge_id: _regime_sel(raw_rows, core_hash)}

        # Trajectories spanning most of the expected range
        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 5000,
            "rows_received": 10,
            "rows_post_aggregation": 10,
            "rows_aggregated": 0,
            "cohort_obs": [{
                "slice_dsl": "window(snapshot)",
                "trajectories": [
                    {"date": "2025-01-15", "n": 500, "obs_type": "window"},
                    {"date": "2025-03-15", "n": 500, "obs_type": "window"},
                ],
            }],
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        assert er.verdict == "pass"
        assert er.divergences == []
        assert er.hashes_with_data == [core_hash]
        assert er.hashes_empty == []
        assert er.evidence_source == "snapshot"
        assert er.total_n == 5000
        assert receipt.edges_failed == 0
        assert receipt.edges_bound == 1


# ---------------------------------------------------------------------------
# Fixture 2: Hash mismatch
# ---------------------------------------------------------------------------

class TestFixture02HashMismatch:
    """FE expects hash abc123, DB has rows only under def456.
    Receipt: fail, 'all expected hashes empty'."""

    def test_hash_mismatch(self):
        edge_id = "edge-1"
        expected_hash = "hash-abc123"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": expected_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {
            edge_id: [{"core_hash": expected_hash}],
        }

        # DB returned 0 rows for this edge (data under different hash)
        rows_raw = {edge_id: 0}
        hashes_seen = {edge_id: set()}
        regimes = {}

        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 0,
            "skipped": True,
            "skip_reason": "no observations",
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        assert er.verdict == "fail"
        assert er.hashes_empty == [expected_hash]
        assert er.hashes_with_data == []
        assert any("all expected hashes" in d for d in er.divergences)
        assert receipt.edges_failed == 1


# ---------------------------------------------------------------------------
# Fixture 3: Hash equivalence bridging
# ---------------------------------------------------------------------------

class TestFixture03HashEquivalence:
    """FE expects hash abc123 with equivalent def456. DB has rows under
    def456 only. Receipt: pass (equivalence bridges it)."""

    def test_equivalence(self):
        edge_id = "edge-1"
        primary_hash = "hash-abc123"
        equiv_hash = "hash-def456"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": primary_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-04-01"},
        ]
        # Candidate regimes list the primary hash
        candidate_regimes = {
            edge_id: [{"core_hash": primary_hash}],
        }

        # DB returned rows under equiv hash — but _query_snapshot_subjects
        # queries with equivalents so the rows are attributed to the edge.
        # hashes_seen shows what core_hash values appeared in the raw rows.
        raw_rows = [{"core_hash": equiv_hash, "retrieved_at": "2025-03-01"}]
        rows_raw = {edge_id: 1}
        hashes_seen = {edge_id: {equiv_hash}}
        regimes = {edge_id: _regime_sel(raw_rows, equiv_hash)}

        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 500,
            "rows_received": 1,
            "rows_post_aggregation": 1,
            "cohort_obs": [{
                "slice_dsl": "window(snapshot)",
                "trajectories": [
                    {"date": "2025-01-15", "n": 250, "obs_type": "window"},
                    {"date": "2025-03-15", "n": 250, "obs_type": "window"},
                ],
            }],
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        # The primary hash isn't in the raw rows — it's "empty" from the
        # receipt's perspective. But data was found (via equivalence) so
        # evidence_source is snapshot and total_n > 0.
        # This is NOT a fail because rows_raw > 0 and total_n > 0.
        assert er.total_n == 500
        assert er.evidence_source == "snapshot"
        # The primary hash shows as empty (data came via equivalent)
        assert er.hashes_empty == [primary_hash]
        # But verdict is warn (data arrived via equivalence), not fail
        assert er.verdict == "warn"
        assert any("all expected hashes" in d for d in er.divergences)
        assert receipt.edges_failed == 0


# ---------------------------------------------------------------------------
# Fixture 4: Multi-regime dedup
# ---------------------------------------------------------------------------

class TestFixture04MultiRegimeDedup:
    """DB has rows under 2 different hashes for the same edge (DSL era
    transition). FE sends both as candidate regimes. Receipt: pass,
    regimes_seen=2, rows_post_regime < rows_raw."""

    def test_multi_regime(self):
        edge_id = "edge-1"
        hash_old = "hash-old-era"
        hash_new = "hash-new-era"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": hash_old,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
            {"edge_id": edge_id, "core_hash": hash_new,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {
            edge_id: [{"core_hash": hash_old}, {"core_hash": hash_new}],
        }

        # 20 raw rows, regime selection kept 12 (from the new-era hash)
        raw_rows_all = (
            [{"core_hash": hash_old, "retrieved_at": f"2025-02-{i:02d}"} for i in range(1, 9)] +
            [{"core_hash": hash_new, "retrieved_at": f"2025-04-{i:02d}"} for i in range(1, 13)]
        )
        kept_rows = [r for r in raw_rows_all if r["core_hash"] == hash_new]

        rows_raw = {edge_id: 20}
        hashes_seen = {edge_id: {hash_old, hash_new}}

        # Regime selection: new hash won for most dates
        regime_new = CandidateRegime(core_hash=hash_new)
        regime_per_date = {r["retrieved_at"]: regime_new for r in kept_rows}
        regimes = {edge_id: RegimeSelection(rows=kept_rows, regime_per_date=regime_per_date)}

        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 3000,
            "rows_received": 12,
            "rows_post_aggregation": 12,
            "cohort_obs": [{
                "slice_dsl": "window(snapshot)",
                "trajectories": [
                    {"date": "2025-04-01", "n": 300, "obs_type": "window"},
                    {"date": "2025-04-05", "n": 300, "obs_type": "window"},
                ],
            }],
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        assert er.rows_raw == 20
        assert er.rows_post_regime == 12
        assert er.hashes_with_data == sorted([hash_new, hash_old])
        assert er.hashes_empty == []
        # No fail — data exists. Possibly warn if dedup >50%.
        assert er.verdict in ("pass", "warn")
        assert receipt.edges_failed == 0


# ---------------------------------------------------------------------------
# Fixture 5: Partial date coverage
# ---------------------------------------------------------------------------

class TestFixture05PartialDateCoverage:
    """FE expects anchors 1-Jan-25 to 1-Jun-25. DB has rows only from
    1-Mar-25 to 1-Apr-25. Receipt: warn, coverage gap."""

    def test_partial_coverage(self):
        edge_id = "edge-1"
        core_hash = "hash-abc123"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": core_hash,
             "slice_keys": [""],
             "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {edge_id: [{"core_hash": core_hash}]}

        raw_rows = [{"core_hash": core_hash, "retrieved_at": "2025-03-15"}]
        rows_raw = {edge_id: 1}
        hashes_seen = {edge_id: {core_hash}}
        regimes = {edge_id: _regime_sel(raw_rows, core_hash)}

        # Only 2 days of data in a 150-day expected range
        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 200,
            "rows_received": 1,
            "rows_post_aggregation": 1,
            "cohort_obs": [{
                "slice_dsl": "window(snapshot)",
                "trajectories": [
                    {"date": "2025-03-15", "n": 100, "obs_type": "window"},
                    {"date": "2025-03-16", "n": 100, "obs_type": "window"},
                ],
            }],
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        assert er.verdict == "warn"
        assert any("anchor range covers" in d and "<50%" in d for d in er.divergences)
        assert er.anchor_days_covered == 2


# ---------------------------------------------------------------------------
# Fixture 6: Silent fallback to param file
# ---------------------------------------------------------------------------

class TestFixture06SilentFallback:
    """FE sends snapshot_subjects for an edge, but DB returns zero rows.
    Evidence binder falls back to param file.
    Receipt: warn, evidence_source=param_file when snapshot expected."""

    def test_silent_fallback(self):
        edge_id = "edge-1"
        core_hash = "hash-abc123"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": core_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {edge_id: [{"core_hash": core_hash}]}

        # DB returned 0 rows — but param file has data
        rows_raw = {edge_id: 0}
        hashes_seen = {edge_id: set()}
        regimes = {}

        # Evidence binder used param file fallback — total_n > 0 but no
        # snapshot trajectories. The slice_dsl reflects param file source.
        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 1000,
            "cohort_obs": [{
                "slice_dsl": "cohort(param-file)",
                "daily": [
                    {"date": "2025-03-01", "n": 500, "k": 250, "age_days": 30},
                    {"date": "2025-03-15", "n": 500, "k": 250, "age_days": 15},
                ],
            }],
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        # All expected hashes empty → fail verdict. Param-file fallback
        # provides aggregate-only data and loses per-slice context info;
        # treating this as a warn hides real data loss, so keep it as a
        # hard fail (see journal: hash-mismatch binding defect).
        assert er.verdict == "fail"
        assert er.hashes_empty == [core_hash]
        assert any("all expected hashes" in d for d in er.divergences)


# ---------------------------------------------------------------------------
# Fixture 6b: Engorged graph — DB empty, data on the graph edge
# ---------------------------------------------------------------------------

class TestFixture06bEngorgedGraph:
    """Engorged graphs carry _bayes_evidence directly on graph edges,
    so the snapshot DB query legitimately returns zero rows for every
    expected hash. Evidence is bound from the engorged edge instead.

    Before the fix at worker.py:1932 the verdict used OR logic:
        all_hashes_empty AND (rows_raw == 0 OR total_n == 0)
    which flagged these as fail even when total_n > 0. That produced
    false-fail receipts and, after the devtooling update, mis-classified
    solo-lifecycle as an infrastructure failure despite a successful run.

    After the fix: hashes-empty + total_n > 0 is a warn, not a fail.
    """

    def test_engorged_graph_with_db_empty(self):
        edge_id = "edge-1"
        core_hash = "hash-engorged"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": core_hash,
             "slice_keys": [], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {edge_id: [{"core_hash": core_hash}]}

        # DB returned 0 rows for the expected hash — engorged evidence
        # bound from the graph edge instead.
        rows_raw = {edge_id: 0}
        hashes_seen = {edge_id: set()}
        regimes = {}

        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 200528,
            "has_window": True,
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        # Engorged data arrived, but all expected snapshot hashes
        # returned empty. That is a fail — the engorged fallback loses
        # per-slice context information and masks a real hash-mismatch
        # defect if treated as a warn.
        assert er.verdict == "fail"
        assert er.total_n == 200528
        assert er.rows_raw == 0
        assert receipt.edges_failed == 1


# ---------------------------------------------------------------------------
# Fixture 7: Total pipeline discard
# ---------------------------------------------------------------------------

class TestFixture07TotalPipelineDiscard:
    """DB has rows, regime selection keeps some, but all surviving rows
    have zero counts and get filtered. Receipt: fail, rows_raw > 0 but
    total_n = 0."""

    def test_pipeline_discard(self):
        edge_id = "edge-1"
        core_hash = "hash-abc123"

        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": core_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {edge_id: [{"core_hash": core_hash}]}

        raw_rows = [{"core_hash": core_hash, "retrieved_at": "2025-03-01"} for _ in range(5)]
        rows_raw = {edge_id: 5}
        hashes_seen = {edge_id: {core_hash}}
        regimes = {edge_id: _regime_sel(raw_rows, core_hash)}

        # Evidence binder processed 5 rows but all had zero counts →
        # total_n = 0, no trajectories built
        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 0,
            "rows_received": 5,
            "rows_post_aggregation": 5,
            "skipped": True,
            "skip_reason": "no observations",
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        er = receipt.edge_receipts[edge_id]
        assert er.verdict == "fail"
        assert er.rows_raw == 5
        assert er.total_n == 0
        assert any("rows_raw=5 but total_n=0" in d for d in er.divergences)
        assert receipt.edges_failed == 1


# ---------------------------------------------------------------------------
# Fixture 8: No FE subjects for edge
# ---------------------------------------------------------------------------

class TestFixture08NoSubjects:
    """Edge exists in topology but FE didn't send snapshot_subjects.
    Receipt: edge in edges_no_subjects, no divergence."""

    def test_no_subjects(self):
        edge_with_subjects = "edge-1"
        edge_without_subjects = "edge-2"
        core_hash = "hash-abc123"

        topo = _topo({
            edge_with_subjects: {"param_id": "param-1"},
            edge_without_subjects: {"param_id": ""},
        })

        # Only edge-1 has subjects
        snapshot_subjects = [
            {"edge_id": edge_with_subjects, "core_hash": core_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-04-01"},
        ]
        candidate_regimes = {edge_with_subjects: [{"core_hash": core_hash}]}

        raw_rows = [{"core_hash": core_hash, "retrieved_at": "2025-03-01"}]
        rows_raw = {edge_with_subjects: 1}
        hashes_seen = {edge_with_subjects: {core_hash}}
        regimes = {edge_with_subjects: _regime_sel(raw_rows, core_hash)}

        evidence = _evidence({
            edge_with_subjects: {
                "param_id": "param-1",
                "total_n": 500,
                "rows_received": 1,
                "rows_post_aggregation": 1,
                "cohort_obs": [{
                    "slice_dsl": "window(snapshot)",
                    "trajectories": [
                        {"date": "2025-01-15", "n": 250, "obs_type": "window"},
                        {"date": "2025-03-15", "n": 250, "obs_type": "window"},
                    ],
                }],
            },
            edge_without_subjects: {
                "param_id": "",
                "skipped": True,
                "skip_reason": "no param_id",
            },
        })

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="log",
        )

        assert receipt.edges_no_subjects >= 1
        er_no_subj = receipt.edge_receipts[edge_without_subjects]
        assert er_no_subj.divergences == []
        assert er_no_subj.verdict == "pass"

        # The edge with subjects should still pass
        er_with = receipt.edge_receipts[edge_with_subjects]
        assert er_with.verdict == "pass"
        assert er_with.evidence_source == "snapshot"


# ---------------------------------------------------------------------------
# Gate mode test
# ---------------------------------------------------------------------------

class TestGateMode:
    """Verify gate mode sets halted=True when there are failures."""

    def test_gate_halts_on_fail(self):
        edge_id = "edge-1"
        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": "hash-missing",
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {edge_id: [{"core_hash": "hash-missing"}]}

        rows_raw = {edge_id: 0}
        hashes_seen = {edge_id: set()}
        regimes = {}

        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 0,
            "skipped": True,
            "skip_reason": "no observations",
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="gate",
        )

        assert receipt.edges_failed == 1
        assert receipt.mode == "gate"

    def test_preflight_always_halts(self):
        """Preflight mode sets halted even when all edges pass."""
        edge_id = "edge-1"
        core_hash = "hash-ok"
        topo = _topo({edge_id: {"param_id": "param-1"}})

        snapshot_subjects = [
            {"edge_id": edge_id, "core_hash": core_hash,
             "slice_keys": [""], "anchor_from": "2025-01-01", "anchor_to": "2025-06-01"},
        ]
        candidate_regimes = {edge_id: [{"core_hash": core_hash}]}

        raw_rows = [{"core_hash": core_hash, "retrieved_at": "2025-03-01"}]
        rows_raw = {edge_id: 1}
        hashes_seen = {edge_id: {core_hash}}
        regimes = {edge_id: _regime_sel(raw_rows, core_hash)}

        evidence = _evidence({edge_id: {
            "param_id": "param-1",
            "total_n": 500,
            "rows_received": 1,
            "rows_post_aggregation": 1,
            "cohort_obs": [{
                "slice_dsl": "window(snapshot)",
                "trajectories": [{"date": "2025-03-01", "n": 500, "obs_type": "window"}],
            }],
        }})

        receipt = _build_binding_receipt(
            topo, evidence, snapshot_subjects, candidate_regimes,
            rows_raw, hashes_seen, regimes, mode="preflight",
        )

        assert receipt.edges_failed == 0
        assert receipt.mode == "preflight"
        # Note: halted is set by the worker, not the receipt builder.
        # The builder just reports mode and counts.
