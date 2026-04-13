"""
Adversarial blind tests for snapshot regime selection.

Written from the CONTRACT (doc 30 §7) without reading the implementation
beyond function signatures. Goal: find actual defects by probing edge
cases that real data could produce.

Every test has rows from multiple regimes — a single-regime test proves nothing.

Run with:
    cd graph-editor && . venv/bin/activate
    pytest lib/tests/test_regime_selection_adversarial.py -v
"""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from snapshot_regime_selection import (
    CandidateRegime,
    RegimeSelection,
    select_regime_rows,
    validate_mece_for_aggregation,
)


# ── Helpers ───────────────────────────────────────────────────

def row(anchor_day: str, retrieved_at: str, core_hash: str,
        slice_key: str = "", x: int = 100, y: int = 50, a: int = 0,
        **extra) -> dict:
    """Build a synthetic snapshot row."""
    r = dict(
        anchor_day=anchor_day,
        retrieved_at=retrieved_at,
        core_hash=core_hash,
        slice_key=slice_key,
        x=x, y=y, a=a,
    )
    r.update(extra)
    return r


# ── Hash constants ────────────────────────────────────────────

H1 = "hash-regime-1"
H2 = "hash-regime-2"
H3 = "hash-regime-3"
H4 = "hash-regime-4"


# ═══════════════════════════════════════════════════════════════
# Suite A: Malformed / missing field edge cases
# ═══════════════════════════════════════════════════════════════

class TestRegimeSelectionMalformedInputs:
    """What happens when real-world data has missing/malformed fields?"""

    def test_none_retrieved_at(self):
        """Row with retrieved_at=None. Should not crash.
        str(None)[:10] = "None" — could collide dates.
        """
        rows = [
            row("2025-01-01", None, H1, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, x=100, y=50),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)
        # Should not crash. The None-date row might be grouped oddly
        # but should not cause an exception.
        assert isinstance(result, RegimeSelection)

    def test_empty_string_retrieved_at(self):
        """Row with retrieved_at=''. Date truncation ''[:10] = ''."""
        rows = [
            row("2025-01-01", "", H1, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, x=100, y=50),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)
        assert isinstance(result, RegimeSelection)

    def test_none_core_hash_in_row(self):
        """Row with core_hash=None. str(None) = "None" — matches nothing."""
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", None, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, x=100, y=50),
        ]
        candidates = [CandidateRegime(core_hash=H1)]
        result = select_regime_rows(rows, candidates)
        # Only H1 rows should survive
        assert len(result.rows) >= 1
        for r in result.rows:
            assert r["core_hash"] == H1

    def test_empty_candidate_regimes(self):
        """No candidate regimes. Should return empty, not crash."""
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, x=100, y=50),
        ]
        result = select_regime_rows(rows, [])
        assert result.rows == []
        assert result.regime_per_date == {}

    def test_empty_rows(self):
        """No rows. Should return empty."""
        result = select_regime_rows(
            [],
            [CandidateRegime(core_hash=H1)],
        )
        assert result.rows == []

    def test_no_matching_rows_for_any_regime(self):
        """Rows exist but none match any candidate regime's hashes."""
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", "hash-unknown", x=100, y=50),
            row("2025-01-02", "2025-03-01T12:00:00Z", "hash-other", x=100, y=50),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)
        assert result.rows == []


# ═══════════════════════════════════════════════════════════════
# Suite B: Regime preference ordering (first-match-wins)
# ═══════════════════════════════════════════════════════════════

class TestRegimePreferenceOrdering:
    """The candidate list is preference-ordered. First match wins per date."""

    def test_preferred_regime_wins_when_both_present(self):
        """Both H1 and H2 have data on same date. H1 is preferred (index 0).
        All H2 rows for that date should be discarded.
        """
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, x=200, y=100),
            row("2025-01-02", "2025-03-01T12:00:00Z", H1, x=100, y=50),
            row("2025-01-02", "2025-03-01T12:00:00Z", H2, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),  # preferred
            CandidateRegime(core_hash=H2),  # fallback
        ]
        result = select_regime_rows(rows, candidates)
        # Only H1 rows should survive
        for r in result.rows:
            assert r["core_hash"] == H1, f"Non-preferred regime row survived: {r['core_hash']}"
        # Sum of x should be 200 (2 × 100), not 600 (100+200+100+200)
        total_x = sum(r["x"] for r in result.rows)
        assert total_x == 200, f"Expected 200 (H1 only), got {total_x} — double-counting!"

    def test_fallback_regime_used_when_preferred_absent(self):
        """H1 has no data. H2 is the fallback and should be used."""
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),  # preferred, no data
            CandidateRegime(core_hash=H2),  # fallback
        ]
        result = select_regime_rows(rows, candidates)
        assert len(result.rows) == 1
        assert result.rows[0]["core_hash"] == H2

    def test_per_date_regime_switching(self):
        """Different regimes win on different dates (epoch transition).
        Date 2025-03-01: only H1 data (old epoch)
        Date 2025-06-01: both H1 and H2 (H1 preferred → H1 wins)
        Date 2025-09-01: only H2 data (new epoch, H1 ceased)
        """
        rows = [
            # Date 2025-03-01: only H1
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, x=100, y=50),
            # Date 2025-06-01: both
            row("2025-01-01", "2025-06-01T12:00:00Z", H1, x=100, y=60),
            row("2025-01-01", "2025-06-01T12:00:00Z", H2, x=200, y=120),
            # Date 2025-09-01: only H2
            row("2025-01-01", "2025-09-01T12:00:00Z", H2, x=200, y=150),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)

        # Check per-date regime decisions
        assert result.regime_per_date.get("2025-03-01") is not None
        assert result.regime_per_date.get("2025-06-01") is not None
        assert result.regime_per_date.get("2025-09-01") is not None

        # 2025-03-01: H1 (only option)
        # 2025-06-01: H1 (preferred, both present)
        # 2025-09-01: H2 (only option)
        rows_by_date = {}
        for r in result.rows:
            d = str(r["retrieved_at"])[:10]
            rows_by_date.setdefault(d, []).append(r)

        assert all(r["core_hash"] == H1 for r in rows_by_date.get("2025-03-01", []))
        assert all(r["core_hash"] == H1 for r in rows_by_date.get("2025-06-01", []))
        assert all(r["core_hash"] == H2 for r in rows_by_date.get("2025-09-01", []))


# ═══════════════════════════════════════════════════════════════
# Suite C: Equivalence hash expansion
# ═══════════════════════════════════════════════════════════════

class TestRegimeEquivalenceHashes:
    """Regime matching should consider equivalent_hashes too."""

    def test_equivalent_hash_matches_rows(self):
        """Regime's core_hash is H1, but rows only exist under H2 (equivalent).
        Should still match.
        """
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H3, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1, equivalent_hashes=[H2]),  # H2 is equivalent
            CandidateRegime(core_hash=H3),  # fallback
        ]
        result = select_regime_rows(rows, candidates)
        # H1's equivalent H2 should be found → H1 regime wins
        # Only H2 rows should survive (not H3)
        for r in result.rows:
            assert r["core_hash"] == H2, (
                f"Expected H2 (equivalent of winning H1), got {r['core_hash']}"
            )

    def test_transitive_equivalence_not_resolved(self):
        """H1 equiv H2, H2 equiv H3. But CandidateRegime only lists direct equivalents.
        H3 rows should NOT match H1's regime unless H3 is in equivalent_hashes.
        """
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H3, x=100, y=50),  # only H3 data
            row("2025-01-01", "2025-03-01T12:00:00Z", H4, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1, equivalent_hashes=[H2]),  # no H3!
            CandidateRegime(core_hash=H4),  # fallback
        ]
        result = select_regime_rows(rows, candidates)
        # H1's regime should NOT match H3 (transitivity not resolved here)
        # H4 should win as fallback
        for r in result.rows:
            assert r["core_hash"] == H4, (
                f"Expected H4 (fallback), got {r['core_hash']}. "
                f"Transitive equivalence should not be resolved in regime selection."
            )


# ═══════════════════════════════════════════════════════════════
# Suite D: Date truncation and grouping edge cases
# ═══════════════════════════════════════════════════════════════

class TestRegimeDateGrouping:
    """Regime selection groups by retrieved_at[:10]. Test the consequences."""

    def test_same_date_different_times_grouped(self):
        """Two rows on same date, different times. Should be same regime decision.
        One row under H1 (morning), one under H2 (evening). Both on same date.
        Preferred regime = H1 → H2 row should be discarded.
        """
        rows = [
            row("2025-01-01", "2025-03-01T06:00:00Z", H1, x=100, y=50),
            row("2025-01-01", "2025-03-01T18:00:00Z", H2, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)
        # Same date (2025-03-01) → same regime decision → H1 wins
        for r in result.rows:
            assert r["core_hash"] == H1

    def test_timezone_offset_does_not_split_dates(self):
        """retrieved_at with timezone offset. Truncation [:10] extracts date.
        '2025-03-01T23:30:00+05:00' → '2025-03-01' (correct, matches UTC date)
        But if the actual UTC time is 2025-03-01T18:30:00Z, both should be same date.
        """
        rows = [
            row("2025-01-01", "2025-03-01T23:30:00+05:00", H1, x=100, y=50),
            row("2025-01-01", "2025-03-01T18:30:00Z", H2, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)
        # Both truncate to 2025-03-01 → same date → H1 wins
        assert len(result.regime_per_date) == 1

    def test_adjacent_dates_independent_regime_decisions(self):
        """Two adjacent dates with different available regimes.
        Each date should make its own independent regime decision.
        """
        rows = [
            # Date 2025-03-01: H1 only
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, x=100, y=50),
            # Date 2025-03-02: H2 only
            row("2025-01-01", "2025-03-02T12:00:00Z", H2, x=200, y=100),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
        ]
        result = select_regime_rows(rows, candidates)
        assert len(result.rows) == 2  # both dates have data
        assert len(result.regime_per_date) == 2  # independent decisions


# ═══════════════════════════════════════════════════════════════
# Suite E: Double-counting prevention
# ═══════════════════════════════════════════════════════════════

class TestRegimeDoubleCounting:
    """The core invariant: no double-counting across regimes."""

    def test_mece_dimensions_sum_preserved(self):
        """Two MECE regimes (channel, device) with known total.
        After selection, the surviving rows' X sum should equal one
        regime's total, not the sum of both regimes.
        """
        # Channel regime: x=100 per anchor day
        # Device regime: x=100 per anchor day (same people, different slicing)
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, slice_key="context(channel:a).window()", x=60, y=30),
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, slice_key="context(channel:b).window()", x=40, y=20),
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, slice_key="context(device:mobile).window()", x=70, y=35),
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, slice_key="context(device:desktop).window()", x=30, y=15),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),  # channel preferred
            CandidateRegime(core_hash=H2),  # device fallback
        ]
        result = select_regime_rows(rows, candidates)
        total_x = sum(r["x"] for r in result.rows)
        # Should be 100 (channel regime), not 200 (channel + device)
        assert total_x == 100, (
            f"Total x={total_x}. Expected 100 (one regime only). "
            f"Double-counting across MECE dimensions!"
        )

    def test_three_regimes_sparse_dates(self):
        """Three regimes with sparse, overlapping date coverage.
        Preferred: H1 (most granular)
        Fallback 1: H2 (medium)
        Fallback 2: H3 (bare)

        Date 1: H1+H2+H3 → H1 wins, H2+H3 discarded
        Date 2: H2+H3 → H2 wins, H3 discarded
        Date 3: H3 only → H3 wins
        """
        rows = [
            # Date 1: all three
            row("2025-01-01", "2025-03-01T12:00:00Z", H1, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H2, x=100, y=50),
            row("2025-01-01", "2025-03-01T12:00:00Z", H3, x=100, y=50),
            # Date 2: H2 + H3
            row("2025-01-01", "2025-06-01T12:00:00Z", H2, x=100, y=60),
            row("2025-01-01", "2025-06-01T12:00:00Z", H3, x=100, y=60),
            # Date 3: H3 only
            row("2025-01-01", "2025-09-01T12:00:00Z", H3, x=100, y=70),
        ]
        candidates = [
            CandidateRegime(core_hash=H1),
            CandidateRegime(core_hash=H2),
            CandidateRegime(core_hash=H3),
        ]
        result = select_regime_rows(rows, candidates)

        rows_by_date = {}
        for r in result.rows:
            d = str(r["retrieved_at"])[:10]
            rows_by_date.setdefault(d, []).append(r)

        # Date 1: only H1
        d1 = rows_by_date.get("2025-03-01", [])
        assert all(r["core_hash"] == H1 for r in d1), f"Date 1 should be H1 only: {[r['core_hash'] for r in d1]}"
        assert sum(r["x"] for r in d1) == 100

        # Date 2: only H2
        d2 = rows_by_date.get("2025-06-01", [])
        assert all(r["core_hash"] == H2 for r in d2), f"Date 2 should be H2 only: {[r['core_hash'] for r in d2]}"
        assert sum(r["x"] for r in d2) == 100

        # Date 3: only H3
        d3 = rows_by_date.get("2025-09-01", [])
        assert all(r["core_hash"] == H3 for r in d3), f"Date 3 should be H3 only: {[r['core_hash'] for r in d3]}"
        assert sum(r["x"] for r in d3) == 100

        # Total: 300 (one regime per date), not 600 (all regimes)
        total = sum(r["x"] for r in result.rows)
        assert total == 300, f"Expected 300, got {total}"


# ═══════════════════════════════════════════════════════════════
# Suite F: validate_mece_for_aggregation
# ═══════════════════════════════════════════════════════════════

class TestValidateMeceAdversarial:
    """Adversarial inputs for MECE validation."""

    def test_empty_rows(self):
        """No rows at all."""
        result = validate_mece_for_aggregation([], ["channel"])
        # Returns a list of warnings/issues — should not crash
        assert isinstance(result, list)

    def test_single_dimension_single_value(self):
        """One MECE dimension with one value. Trivially valid."""
        rows = [
            row("2025-01-01", "2025-03-01T12:00:00Z", H1,
                slice_key="context(channel:google).window()", x=100, y=50),
        ]
        result = validate_mece_for_aggregation(rows, ["channel"])
        assert isinstance(result, list)
