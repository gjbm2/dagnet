"""
Read Integrity Tests (RI-001 through RI-004)

Tests for snapshot query operations.
"""

import pytest
import sys
import os

# Add lib directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, datetime
from dotenv import load_dotenv

# Load DB_CONNECTION for integration tests (local dev / CI secrets).
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))
from snapshot_service import (
    query_snapshots, 
    append_snapshots,
    query_virtual_snapshot,
    query_snapshot_retrievals,
    query_snapshots_for_sweep,
    get_db_connection,
    get_batch_inventory_v2,
    short_core_hash_from_canonical_signature,
    create_equivalence_link,
    deactivate_equivalence_link,
    resolve_equivalent_hashes,
)

# Skip all tests if DB_CONNECTION not available
pytestmark = pytest.mark.skipif(
    not os.environ.get('DB_CONNECTION'),
    reason="DB_CONNECTION not configured"
)

# Test prefix for cleanup
TEST_PREFIX = 'pytest-ri-'

SIG_ALGO = "sig_v1_sha256_trunc128_b64url"


def append_snapshots_for_test(*, param_id: str, canonical_signature: str, slice_key: str, retrieved_at: datetime, rows, diagnostic: bool = False):
    """
    Test helper: append snapshots using the flexi-sigs write contract.
    """
    return append_snapshots(
        param_id=param_id,
        canonical_signature=canonical_signature,
        inputs_json={
            "schema": "pytest_flexi_sigs_v1",
            "param_id": param_id,
            "canonical_signature": canonical_signature,
        },
        sig_algo=SIG_ALGO,
        slice_key=slice_key,
        retrieved_at=retrieved_at,
        rows=rows,
        diagnostic=diagnostic,
    )


def cleanup_test_data():
    """Delete all test data with our prefix."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_equivalence WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        conn.commit()
        conn.close()
    except Exception:
        pass


@pytest.fixture(scope='module', autouse=True)
def setup_and_cleanup():
    """Clean up before and after all tests in this module."""
    cleanup_test_data()
    yield
    cleanup_test_data()


class TestReadIntegrity:
    """RI-001 through RI-004: Read path integrity tests."""
    
    @pytest.fixture(autouse=True)
    def setup_test_data(self):
        """Insert test data before each test."""
        # Insert test data for querying
        self.param_id = f'{TEST_PREFIX}param-a'
        self.canonical_signature = '{"c":"pytest-ri","x":{}}'
        self.core_hash = short_core_hash_from_canonical_signature(self.canonical_signature)
        
        # Insert rows with different dates and slices
        rows_uncontexted = [
            {'anchor_day': '2025-10-01', 'X': 100, 'Y': 10},
            {'anchor_day': '2025-10-02', 'X': 110, 'Y': 12},
            {'anchor_day': '2025-10-03', 'X': 120, 'Y': 15},
            {'anchor_day': '2025-10-04', 'X': 130, 'Y': 18},
            {'anchor_day': '2025-10-05', 'X': 140, 'Y': 20},
        ]
        
        append_snapshots_for_test(
            param_id=self.param_id,
            # Uncontexted refers to "no context dims" (context axis only).
            # Slice identity still includes temporal mode; args are incidental.
            slice_key='cohort(1-Oct-25:5-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            canonical_signature=self.canonical_signature,
            rows=rows_uncontexted,
        )
        
        # Insert slice data
        rows_google = [
            {'anchor_day': '2025-10-01', 'X': 50, 'Y': 5},
            {'anchor_day': '2025-10-02', 'X': 55, 'Y': 6},
        ]
        
        append_snapshots_for_test(
            param_id=self.param_id,
            slice_key='context(channel:google).cohort(1-Oct-25:5-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            canonical_signature=self.canonical_signature,
            rows=rows_google,
        )
        
        rows_facebook = [
            {'anchor_day': '2025-10-01', 'X': 50, 'Y': 5},
            {'anchor_day': '2025-10-02', 'X': 55, 'Y': 6},
        ]
        
        append_snapshots_for_test(
            param_id=self.param_id,
            slice_key='context(channel:facebook).cohort(1-Oct-25:5-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            canonical_signature=self.canonical_signature,
            rows=rows_facebook,
        )
        
        yield
        
        # Cleanup this test's data
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("DELETE FROM signature_equivalence WHERE param_id = %s", (self.param_id,))
            cur.execute("DELETE FROM signature_registry WHERE param_id = %s", (self.param_id,))
            cur.execute("DELETE FROM snapshots WHERE param_id = %s", (self.param_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass
    
    def test_ri001_read_single_param(self):
        """
        RI-001: read_single_param
        
        Query by param_id + core_hash returns expected rows.
        """
        rows = query_snapshots(
            param_id=self.param_id,
            core_hash=self.core_hash
        )
        
        # Should return all rows (5 uncontexted + 2 google + 2 facebook = 9)
        assert len(rows) == 9
        
        # All rows should have correct param_id
        for row in rows:
            assert row['param_id'] == self.param_id
    
    def test_ri002_read_date_range_filter(self):
        """
        RI-002: read_date_range_filter
        
        Filter by anchor_day range - only dates in range returned.
        """
        rows = query_snapshots(
            param_id=self.param_id,
            anchor_from=date(2025, 10, 2),
            anchor_to=date(2025, 10, 4)
        )
        
        # Check all returned rows are within range
        for row in rows:
            anchor = row['anchor_day']
            if isinstance(anchor, str):
                anchor = date.fromisoformat(anchor)
            assert anchor >= date(2025, 10, 2), f"Row {anchor} before range start"
            assert anchor <= date(2025, 10, 4), f"Row {anchor} after range end"
        
        # Uncontexted: Oct 2, 3, 4 = 3 rows
        # Google: Oct 2 = 1 row
        # Facebook: Oct 2 = 1 row
        # Total = 5 rows
        assert len(rows) == 5
    
    def test_ri003_read_empty_graceful(self):
        """
        RI-003: read_empty_graceful
        
        Non-existent param returns empty array, no error.
        """
        rows = query_snapshots(
            param_id='nonexistent-param-xyz-123',
            core_hash='nonexistent-hash'
        )
        
        assert rows == []
        assert isinstance(rows, list)
    
    def test_ri004_read_slice_filter(self):
        """
        RI-004: read_slice_filter
        
        Multiple slices in DB, query one - only requested slice returned.
        """
        rows = query_snapshots(
            param_id=self.param_id,
            slice_keys=['context(channel:google).cohort()']
        )
        
        # Should only return google slice rows
        assert len(rows) == 2
        
        for row in rows:
            assert row['slice_key'].startswith('context(channel:google).cohort(')
    
    def test_read_inventory(self):
        """
        Inventory returns correct summary stats.
        """
        inv = get_batch_inventory_v2(
            param_ids=[self.param_id],
            current_signatures={self.param_id: self.canonical_signature},
            slice_keys_by_param={self.param_id: ['cohort()', 'context(channel:google).cohort()', 'context(channel:facebook).cohort()']},
            include_equivalents=True,
            limit_families_per_param=10,
            limit_slices_per_family=10,
        )
        pid_inv = inv[self.param_id]
        overall = pid_inv["overall_all_families"]

        assert overall["row_count"] == 9
        assert overall["unique_anchor_days"] == 5  # Oct 1-5
        assert overall["unique_retrievals"] == 1  # All inserted with same retrieved_at

    def test_ri006_virtual_snapshot_latest_wins_across_slice_family_variants(self):
        """
        RI-006: virtual_snapshot_latest_wins_across_variants

        Multiple stored slice_key strings can represent the same logical slice family
        (e.g. different cohort(...) args). Virtual snapshot must apply "latest wins"
        across the *normalised* slice family key, not per raw slice_key string.
        """
        # Insert a later retrieval for the SAME logical family, but with different cohort args.
        rows_google_newer = [
            {'anchor_day': '2025-10-01', 'X': 500, 'Y': 50},
            {'anchor_day': '2025-10-02', 'X': 600, 'Y': 60},
        ]
        append_snapshots_for_test(
            param_id=self.param_id,
            slice_key='context(channel:google).cohort(-100d:)',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            canonical_signature=self.canonical_signature,
            rows=rows_google_newer,
        )

        res = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 12, 12, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=self.core_hash,
            slice_keys=['context(channel:google).cohort()'],
            include_equivalents=True,
        )

        assert res["success"] is True
        assert res["count"] == 2
        # Ensure we took the newer retrieval boundary across the family.
        assert res.get("latest_retrieved_at_used") is not None
        assert "2025-10-11" in str(res.get("latest_retrieved_at_used"))

        # Verify values came from the newer write
        xs = [r.get("x") for r in res.get("rows", [])]
        ys = [r.get("y") for r in res.get("rows", [])]
        assert xs == [500, 600]
        assert ys == [50, 60]

    def test_ri007_mode_only_selector_is_uncontexted_only(self):
        """
        RI-007: mode_only_selector_is_uncontexted_only

        Backend selector contract:
        - "cohort()" / "window()" MUST mean uncontexted-only (no context/case dims),
          not "any context in this mode".

        Broad reads across all slices remain available via the empty selector "".
        """
        res = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 12, 12, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=self.core_hash,
            slice_keys=['cohort()'],
            include_equivalents=True,
        )
        assert res["success"] is True
        # Only the uncontexted cohort() series should match (2 anchor days in range).
        assert res["count"] == 2
        assert all(isinstance(r.get("slice_key"), str) and r["slice_key"].startswith("cohort(") for r in res.get("rows", []))

    def test_ri008_inverted_anchor_bounds_are_treated_as_unordered(self):
        """
        RI-008: inverted_anchor_bounds

        Frontend UI bugs can occasionally produce anchor_from > anchor_to.
        Read path must be defensive and treat bounds as unordered.
        """
        res = query_virtual_snapshot(
            param_id=self.param_id,
            as_at=datetime(2025, 10, 12, 12, 0, 0),
            anchor_from=date(2025, 10, 2),
            anchor_to=date(2025, 10, 1),
            core_hash=self.core_hash,
            slice_keys=['cohort()'],
            include_equivalents=True,
        )
        assert res["success"] is True
        assert res["count"] > 0

    def test_ri005_signature_is_part_of_key(self):
        """
        RI-005: signature_keying

        Same param_id, different core_hash => isolated rows.
        """
        other_sig = '{"c":"pytest-ri-other","x":{}}'
        other_hash = short_core_hash_from_canonical_signature(other_sig)
        append_snapshots_for_test(
            param_id=self.param_id,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            canonical_signature=other_sig,
            rows=[
                {'anchor_day': '2025-10-01', 'X': 999, 'Y': 99},
            ],
        )

        rows_a = query_snapshots(param_id=self.param_id, core_hash=self.core_hash)
        assert all(r['core_hash'] == self.core_hash for r in rows_a)
        assert all(r.get('x') != 999 for r in rows_a)

        rows_b = query_snapshots(param_id=self.param_id, core_hash=other_hash)
        assert len(rows_b) == 1
        assert rows_b[0]['core_hash'] == other_hash
        assert rows_b[0]['x'] == 999

    def test_ri006_query_virtual_latest_per_day_keyed_by_signature(self):
        """
        RI-006: query_virtual_snapshot

        - latest-per-(anchor_day,slice_key) as-of works
        - keyed by (param_id, core_hash, slice_key, anchor_day) identity
        """
        pid = f'{TEST_PREFIX}param-virtual'
        sig_a = '{"c":"sig-A","x":{}}'
        sig_b = '{"c":"sig-B","x":{}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        # Day 0 retrieval (older)
        append_snapshots_for_test(
            param_id=pid,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            canonical_signature=sig_a,
            rows=[
                {'anchor_day': '2025-10-01', 'X': 1, 'Y': 1},
                {'anchor_day': '2025-10-02', 'X': 2, 'Y': 2},
            ],
        )
        # Day 1 retrieval (newer) only overlaps one day
        append_snapshots_for_test(
            param_id=pid,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            canonical_signature=sig_a,
            rows=[
                {'anchor_day': '2025-10-02', 'X': 222, 'Y': 22},
            ],
        )
        # Another signature under same param_id (should not be returned when querying sig_a)
        append_snapshots_for_test(
            param_id=pid,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            canonical_signature=sig_b,
            rows=[
                {'anchor_day': '2025-10-01', 'X': 999, 'Y': 99},
            ],
        )

        res = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=hash_a,
            slice_keys=[''],
            include_equivalents=False,
            limit=10000,
        )
        assert res['success'] is True
        assert res['count'] == 2
        # 10-01 comes from older retrieval (only row), 10-02 from newer retrieval
        by_day = {r['anchor_day']: r for r in res['rows']}
        assert by_day['2025-10-01']['x'] == 1
        assert by_day['2025-10-02']['x'] == 222

        # Wrong signature => empty rows, but has_any_rows should be true
        res_wrong = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=short_core_hash_from_canonical_signature('{"c":"sig-NOT-THERE","x":{}}'),
            slice_keys=[''],
            include_equivalents=False,
            limit=10000,
        )
        assert res_wrong['success'] is True
        assert res_wrong['count'] == 0
        assert res_wrong['has_any_rows'] is True
        assert res_wrong['has_matching_core_hash'] is False

    def test_ri007_retrievals_distinct_bounded_and_filtered(self):
        """
        RI-007: query_snapshot_retrievals

        - returns distinct retrieved_at values (desc)
        - supports core_hash and slice_key filtering without per-slice queries
        - supports anchor_day scoping
        """
        pid = f'{TEST_PREFIX}param-retrievals'
        # Use signatures unique to this test to avoid collisions in shared DBs.
        sig_a = f'{{"c":"{TEST_PREFIX}ri007-sig-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}ri007-sig-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        # Two retrievals for sig_a (same slice)
        append_snapshots_for_test(
            param_id=pid,
            slice_key='context(channel:google)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            canonical_signature=sig_a,
            rows=[
                {'anchor_day': '2025-10-01', 'X': 10, 'Y': 1},
            ],
        )
        append_snapshots_for_test(
            param_id=pid,
            slice_key='context(channel:google)',
            retrieved_at=datetime(2025, 10, 12, 12, 0, 0),
            canonical_signature=sig_a,
            rows=[
                {'anchor_day': '2025-10-02', 'X': 20, 'Y': 2},
            ],
        )

        # A different signature (should be excluded when core_hash filter applied)
        append_snapshots_for_test(
            param_id=pid,
            slice_key='context(channel:google)',
            retrieved_at=datetime(2025, 10, 13, 12, 0, 0),
            canonical_signature=sig_b,
            rows=[
                {'anchor_day': '2025-10-02', 'X': 999, 'Y': 99},
            ],
        )

        # Unfiltered: should include all distinct retrievals (3)
        res_all = query_snapshot_retrievals(param_id=pid, limit=10)
        assert res_all['success'] is True
        assert res_all['count'] == 3
        assert res_all['retrieved_at'][0].startswith('2025-10-13')
        assert res_all['retrieved_at'][1].startswith('2025-10-12')
        assert res_all['retrieved_at'][2].startswith('2025-10-10')

        # Filtered by signature: only sig_a's retrievals (2)
        res_sig = query_snapshot_retrievals(param_id=pid, core_hash=hash_a, include_equivalents=False, limit=10)
        assert res_sig['success'] is True
        assert res_sig['count'] == 2
        assert res_sig['retrieved_at'][0].startswith('2025-10-12')
        assert res_sig['retrieved_at'][1].startswith('2025-10-10')

        # Anchor scoping: only rows with anchor_day >= 2025-10-02 should keep 10-12/10-13
        res_anchor = query_snapshot_retrievals(param_id=pid, anchor_from=date(2025, 10, 2), limit=10)
        assert res_anchor['success'] is True
        assert res_anchor['count'] == 2
        assert res_anchor['retrieved_at'][0].startswith('2025-10-13')
        assert res_anchor['retrieved_at'][1].startswith('2025-10-12')

    def test_ri008_equivalence_closure_affects_virtual_and_retrievals(self):
        """
        RI-008: equivalence closure affects signature-keyed reads.

        - With include_equivalents=False, reads are strict by core_hash.
        - With include_equivalents=True, an equivalence link expands matching to the closure.
        """
        pid = f'{TEST_PREFIX}param-eq'
        # Use unique signatures to avoid collisions in shared DBs now that core_hash reads
        # are not bucketed by param_id.
        sig_a = f'{{"c":"{TEST_PREFIX}eq-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}eq-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 999, 'Y': 99}],
        )

        # Strict: core_hash A should NOT return B rows.
        strict = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            core_hash=hash_a,
            slice_keys=[''],
            include_equivalents=False,
            limit=1000,
        )
        assert strict["success"] is True
        assert strict["count"] == 1
        assert strict["rows"][0]["x"] == 1

        # Link A ≡ B, then closure-enabled read should include B.
        res_link = create_equivalence_link(
            param_id=pid,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="equivalence closure integration test",
        )
        assert res_link["success"] is True

        closure = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            core_hash=hash_a,
            slice_keys=[''],
            include_equivalents=True,
            limit=1000,
        )
        assert closure["success"] is True
        # Both signatures have a row for the same day; virtual query returns latest-per-day as-of,
        # so the newer retrieval (sig_b, x=999) should win.
        assert closure["count"] == 1
        assert closure["rows"][0]["x"] == 999

        # Retrievals: strict filter should only see sig_a's retrieval; closure should see both.
        strict_r = query_snapshot_retrievals(param_id=pid, core_hash=hash_a, include_equivalents=False, limit=10)
        assert strict_r["success"] is True
        assert strict_r["count"] == 1
        assert strict_r["retrieved_at"][0].startswith("2025-10-10")

        closure_r = query_snapshot_retrievals(param_id=pid, core_hash=hash_a, include_equivalents=True, limit=10)
        assert closure_r["success"] is True
        assert closure_r["count"] == 2
        assert closure_r["retrieved_at"][0].startswith("2025-10-11")
        assert closure_r["retrieved_at"][1].startswith("2025-10-10")

    def test_ri008c_equivalence_closure_cross_param_reads_source_param(self):
        """
        RI-008c: equivalence closure can reference snapshots stored under a different param_id.

        This matches the production scenario: a signature link created on param A points at a
        core_hash whose snapshots live under param B (via source_param_id).
        """
        pid_a = f'{TEST_PREFIX}param-eq-x-a'
        pid_b = f'{TEST_PREFIX}param-eq-x-b'
        sig_a = f'{{"c":"{TEST_PREFIX}eq-x-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}eq-x-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(
            param_id=pid_a,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        append_snapshots_for_test(
            param_id=pid_b,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 999, 'Y': 99}],
        )

        # Link A ≡ B on pid_a, but indicate B's data lives under pid_b.
        res_link = create_equivalence_link(
            param_id=pid_a,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="cross-param equivalence read test",
            source_param_id=pid_b,
        )
        assert res_link["success"] is True

        # Retrievals for A should include B's retrieval timestamp.
        closure_r = query_snapshot_retrievals(param_id=pid_a, core_hash=hash_a, include_equivalents=True, limit=10)
        assert closure_r["success"] is True
        assert closure_r["count"] == 2
        assert closure_r["retrieved_at"][0].startswith("2025-10-11")
        assert closure_r["retrieved_at"][1].startswith("2025-10-10")

        # Virtual snapshot should "latest wins" to B's newer retrieval (even though stored under pid_b).
        closure = query_virtual_snapshot(
            param_id=pid_a,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            core_hash=hash_a,
            slice_keys=[''],
            include_equivalents=True,
            limit=1000,
        )
        assert closure["success"] is True
        assert closure["count"] == 1
        assert closure["rows"][0]["x"] == 999

    def test_ri008b_equivalence_closure_affects_query_full(self):
        """
        RI-008b: equivalence closure affects query_snapshots (query-full route).

        This is the test that was MISSING — the gap that allowed query-full
        to ship without equivalence support.

        - With include_equivalents=False, query_snapshots returns only exact core_hash rows.
        - With include_equivalents=True, linked signatures are included.
        """
        pid = f'{TEST_PREFIX}param-eq-full'
        sig_a = f'{{"c":"{TEST_PREFIX}eq-full-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}eq-full-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-02', 'X': 999, 'Y': 99}],
        )

        # Strict: only sig_a's row
        strict = query_snapshots(param_id=pid, core_hash=hash_a, include_equivalents=False)
        assert len(strict) == 1
        assert strict[0]['x'] == 1
        assert strict[0]['core_hash'] == hash_a

        # Link A ≡ B
        res_link = create_equivalence_link(
            param_id=pid,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="query-full equivalence test",
        )
        assert res_link["success"] is True

        # With equivalents: both rows returned
        closure = query_snapshots(param_id=pid, core_hash=hash_a, include_equivalents=True)
        assert len(closure) == 2
        hashes_returned = {r['core_hash'] for r in closure}
        assert hash_a in hashes_returned
        assert hash_b in hashes_returned

        # Verify strict still only returns sig_a
        strict_after = query_snapshots(param_id=pid, core_hash=hash_a, include_equivalents=False)
        assert len(strict_after) == 1
        assert strict_after[0]['core_hash'] == hash_a

    def test_ri009_inventory_v2_groups_equivalent_signatures_into_one_family(self):
        """
        RI-009: inventory V2 groups equivalence closure into a signature family.
        """
        pid = f'{TEST_PREFIX}param-inv-eq'
        sig_a = f'{{"c":"{TEST_PREFIX}inv-eq-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}inv-eq-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 1, 'Y': 1},
                {'anchor_day': '2025-10-02', 'X': 2, 'Y': 2},
            ],
        )
        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 10, 'Y': 10},
            ],
        )

        res_link = create_equivalence_link(
            param_id=pid,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="inventory family integration test",
        )
        assert res_link["success"] is True

        inv = get_batch_inventory_v2(
            param_ids=[pid],
            current_signatures={pid: sig_a},
            slice_keys_by_param={pid: ['']},
            include_equivalents=True,
            limit_families_per_param=10,
            limit_slices_per_family=10,
        )
        pid_inv = inv[pid]
        families = pid_inv.get("families") or []
        assert len(families) == 1
        fam = families[0]
        # Family should contain both hashes (order not important)
        member = set(fam.get("member_core_hashes") or [])
        assert hash_a in member
        assert hash_b in member
        assert fam["family_size"] == 2
        # Total row_count across both signatures: 2 + 1 = 3
        assert fam["overall"]["row_count"] == 3


class TestContextEpochs_SliceSelectorContract:
    """
    Integration tests for the slice selector contract required by context epochs.

    These are DB-backed (skip when DB_CONNECTION is not configured) and aim to
    prevent regressions in the selector semantics that epoch planning depends on.
    """

    @pytest.fixture(autouse=True)
    def cleanup(self):
        yield
        cleanup_test_data()

    def test_ce001_cohort_mode_selector_is_uncontexted_only_in_query_snapshots(self):
        pid = f'{TEST_PREFIX}ce001'
        sig = '{"c":"ce001","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 50, 'Y': 5}],
        )

        rows = query_snapshots(param_id=pid, core_hash=h, slice_keys=['cohort()'], include_equivalents=False)
        assert len(rows) == 1
        assert rows[0]['slice_key'].startswith('cohort(')

    def test_ce002_cohort_mode_selector_is_uncontexted_only_in_sweep_query(self):
        pid = f'{TEST_PREFIX}ce002'
        sig = '{"c":"ce002","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 50, 'Y': 5}],
        )

        rows = query_snapshots_for_sweep(
            param_id=pid,
            core_hash=h,
            slice_keys=['cohort()'],
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            sweep_from=date(2025, 10, 10),
            sweep_to=date(2025, 10, 10),
            include_equivalents=False,
            limit=10000,
        )
        assert len(rows) == 1
        assert rows[0]['slice_key'].startswith('cohort(')

    def test_ce003_explicit_context_family_selector_matches_only_that_family(self):
        pid = f'{TEST_PREFIX}ce003'
        sig = '{"c":"ce003","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 50, 'Y': 5}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:facebook).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 60, 'Y': 6}],
        )

        rows = query_snapshots(
            param_id=pid, core_hash=h,
            slice_keys=['context(channel:google).cohort()'],
            include_equivalents=False,
        )
        assert len(rows) == 1
        assert rows[0]['slice_key'].startswith('context(channel:google).cohort(')

    def test_ce004_empty_selector_is_broad_includes_all_slices(self):
        pid = f'{TEST_PREFIX}ce004'
        sig = '{"c":"ce004","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 50, 'Y': 5}],
        )

        rows = query_snapshots(param_id=pid, core_hash=h, slice_keys=[''], include_equivalents=False)
        assert len(rows) == 2

    def test_ce005_gap_slice_key_matches_no_rows(self):
        pid = f'{TEST_PREFIX}ce005'
        sig = '{"c":"ce005","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )

        rows = query_snapshots(param_id=pid, core_hash=h, slice_keys=['__epoch_gap__'], include_equivalents=False)
        assert rows == []

    def test_ce006_retrievals_include_summary_reports_slice_keys(self):
        pid = f'{TEST_PREFIX}ce006'
        sig = '{"c":"ce006","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:2-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:2-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-02', 'X': 2, 'Y': 2}],
        )

        res = query_snapshot_retrievals(
            param_id=pid,
            core_hash=h,
            include_equivalents=False,
            include_summary=True,
            limit=10,
        )
        assert res["success"] is True
        # With include_summary=True, the backend returns one row per (retrieved_at, slice_key),
        # so count reflects summary row count rather than distinct retrieved_at timestamps.
        assert len(set(res["retrieved_at"])) == 1
        assert isinstance(res.get("summary"), list)
        assert {s["slice_key"] for s in res["summary"]} == {
            'cohort(1-Oct-25:2-Oct-25)',
            'context(channel:google).cohort(1-Oct-25:2-Oct-25)',
        }

    def test_ce007_within_day_multiple_retrieved_at_are_distinct(self):
        pid = f'{TEST_PREFIX}ce007'
        sig = '{"c":"ce007","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 9, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 18, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 2, 'Y': 2}],
        )

        res = query_snapshot_retrievals(
            param_id=pid,
            core_hash=h,
            include_equivalents=False,
            include_summary=True,
            limit=10,
        )
        assert res["success"] is True
        assert res["count"] == 2
        assert res["retrieved_at"][0].startswith("2025-10-10T18")
        assert res["retrieved_at"][1].startswith("2025-10-10T09")

    def test_ce008_inventory_v2_slice_filter_respects_exact_uncontexted_selector(self):
        pid = f'{TEST_PREFIX}ce008'
        sig = '{"c":"ce008","x":{}}'

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 2, 'Y': 2}],
        )

        inv = get_batch_inventory_v2(
            param_ids=[pid],
            current_signatures={pid: sig},
            slice_keys_by_param={pid: ['cohort()']},
            include_equivalents=False,
            limit_families_per_param=10,
            limit_slices_per_family=50,
        )
        fam = inv[pid]["families"][0]
        slice_keys = {s["slice_key"] for s in fam.get("by_slice_key") or []}
        # Only uncontexted cohort family variants should be present.
        assert all(sk.startswith("cohort(") for sk in slice_keys)

    def test_ce009_sweep_query_with_explicit_partition_avoids_double_counting(self):
        """
        If both an uncontexted total and a context partition exist, explicit slice selection
        must allow choosing one regime without mixing.
        """
        pid = f'{TEST_PREFIX}ce009'
        sig = '{"c":"ce009","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        # Same retrieval day: uncontexted total (X=100,Y=10) AND MECE partition (two slices summing to X=100,Y=10).
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:a).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 40, 'Y': 4}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:b).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 60, 'Y': 6}],
        )

        # Uncontexted-only: one row
        rows_u = query_snapshots_for_sweep(
            param_id=pid, core_hash=h, slice_keys=['cohort()'],
            anchor_from=date(2025, 10, 1), anchor_to=date(2025, 10, 1),
            sweep_from=date(2025, 10, 10), sweep_to=date(2025, 10, 10),
            include_equivalents=False,
        )
        assert len(rows_u) == 1
        assert rows_u[0]["x"] == 100

        # Explicit partition: two rows (caller sums downstream if desired)
        rows_p = query_snapshots_for_sweep(
            param_id=pid, core_hash=h,
            slice_keys=['context(channel:a).cohort()', 'context(channel:b).cohort()'],
            anchor_from=date(2025, 10, 1), anchor_to=date(2025, 10, 1),
            sweep_from=date(2025, 10, 10), sweep_to=date(2025, 10, 10),
            include_equivalents=False,
        )
        assert len(rows_p) == 2
        assert sum(r["x"] for r in rows_p) == 100

    def test_ce010_broad_selector_returns_mixed_regimes(self):
        """
        Document the broad selector contract: [''] includes all slices (and therefore can mix regimes).
        Epoch planning MUST NOT use this for cohort maturity.
        """
        pid = f'{TEST_PREFIX}ce010'
        sig = '{"c":"ce010","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100, 'Y': 10}],
        )
        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:a).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 40, 'Y': 4}],
        )

        rows = query_snapshots(param_id=pid, core_hash=h, slice_keys=[''], include_equivalents=False)
        assert len(rows) == 2

    def test_ce011_slice_key_normalisation_for_matching_is_args_insensitive(self):
        pid = f'{TEST_PREFIX}ce011'
        sig = '{"c":"ce011","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).cohort(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        rows = query_snapshots(
            param_id=pid, core_hash=h,
            slice_keys=['context(channel:google).cohort()'],
            include_equivalents=False,
        )
        assert len(rows) == 1

    def test_ce012_mode_mismatch_is_excluded_by_exact_family_selectors(self):
        pid = f'{TEST_PREFIX}ce012'
        sig = '{"c":"ce012","x":{}}'
        h = short_core_hash_from_canonical_signature(sig)

        append_snapshots_for_test(
            param_id=pid, canonical_signature=sig,
            slice_key='context(channel:google).window(1-Oct-25:1-Oct-25)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
        )
        # Cohort selector should not match window slices.
        rows = query_snapshots(
            param_id=pid, core_hash=h,
            slice_keys=['context(channel:google).cohort()'],
            include_equivalents=False,
        )
        assert rows == []


class TestTierC_BackendContract:
    """
    Tier C — backend contract tests.

    Ensure the backend enforces invariants: no silent acceptance of bad writes,
    idempotent registry inserts, link create/deactivate behaviour.
    """

    @pytest.fixture(autouse=True)
    def cleanup(self):
        yield
        cleanup_test_data()

    def test_c001_append_missing_canonical_signature_rejected(self):
        """Missing canonical_signature must raise ValueError."""
        with pytest.raises(ValueError, match="canonical_signature"):
            append_snapshots(
                param_id=f'{TEST_PREFIX}c001',
                canonical_signature=None,
                inputs_json={"schema": "test"},
                sig_algo=SIG_ALGO,
                slice_key='',
                retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
                rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
            )

    def test_c002_append_missing_inputs_json_rejected(self):
        """Missing inputs_json must raise ValueError."""
        with pytest.raises(ValueError, match="inputs_json"):
            append_snapshots(
                param_id=f'{TEST_PREFIX}c002',
                canonical_signature='{"c":"c002","x":{}}',
                inputs_json=None,
                sig_algo=SIG_ALGO,
                slice_key='',
                retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
                rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
            )

    def test_c003_append_malformed_inputs_json_rejected(self):
        """inputs_json that is not a dict must raise ValueError."""
        with pytest.raises(ValueError, match="inputs_json"):
            append_snapshots(
                param_id=f'{TEST_PREFIX}c003',
                canonical_signature='{"c":"c003","x":{}}',
                inputs_json="not a dict",
                sig_algo=SIG_ALGO,
                slice_key='',
                retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
                rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
            )

    def test_c004_append_missing_sig_algo_rejected(self):
        """Missing sig_algo must raise ValueError."""
        with pytest.raises(ValueError, match="sig_algo"):
            append_snapshots(
                param_id=f'{TEST_PREFIX}c004',
                canonical_signature='{"c":"c004","x":{}}',
                inputs_json={"schema": "test"},
                sig_algo=None,
                slice_key='',
                retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
                rows=[{'anchor_day': '2025-10-01', 'X': 1, 'Y': 1}],
            )

    def test_c005_registry_insert_is_idempotent(self):
        """Repeated append with same signature must not duplicate registry rows."""
        pid = f'{TEST_PREFIX}c005'
        sig = '{"c":"c005-idem","x":{}}'
        core_hash = short_core_hash_from_canonical_signature(sig)

        for i in range(3):
            append_snapshots_for_test(
                param_id=pid,
                canonical_signature=sig,
                slice_key='',
                retrieved_at=datetime(2025, 10, 10 + i, 12, 0, 0),
                rows=[{'anchor_day': f'2025-10-0{i+1}', 'X': i, 'Y': i}],
            )

        # Check registry: should have exactly 1 row for this (param_id, core_hash)
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT count(*) FROM signature_registry WHERE param_id = %s AND core_hash = %s",
                (pid, core_hash),
            )
            count = cur.fetchone()[0]
            assert count == 1, f"Expected 1 registry row, got {count}"
        finally:
            conn.close()

    def test_c006_link_create_and_deactivate(self):
        """Create a link, verify it's active, deactivate it, verify it's inactive."""
        pid = f'{TEST_PREFIX}c006'
        hash_a = "AAAA"
        hash_b = "BBBB"

        # Create link
        res = create_equivalence_link(
            param_id=pid, core_hash=hash_a, equivalent_to=hash_b,
            created_by="pytest", reason="test create",
        )
        assert res["success"] is True

        # Verify active
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT active FROM signature_equivalence WHERE param_id=%s AND core_hash=%s AND equivalent_to=%s",
                (pid, hash_a, hash_b),
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] is True
        finally:
            conn.close()

        # Deactivate
        res2 = deactivate_equivalence_link(
            param_id=pid, core_hash=hash_a, equivalent_to=hash_b,
            created_by="pytest", reason="test deactivate",
        )
        assert res2["success"] is True

        # Verify inactive
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT active FROM signature_equivalence WHERE param_id=%s AND core_hash=%s AND equivalent_to=%s",
                (pid, hash_a, hash_b),
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] is False
        finally:
            conn.close()

    def test_c007_link_create_idempotent(self):
        """Creating the same link twice should succeed (upsert) without error."""
        pid = f'{TEST_PREFIX}c007'
        res1 = create_equivalence_link(
            param_id=pid, core_hash="X1", equivalent_to="X2",
            created_by="pytest", reason="first",
        )
        assert res1["success"] is True

        res2 = create_equivalence_link(
            param_id=pid, core_hash="X1", equivalent_to="X2",
            created_by="pytest", reason="second (idempotent)",
        )
        assert res2["success"] is True

    def test_c008_self_link_rejected(self):
        """Linking a hash to itself must fail."""
        pid = f'{TEST_PREFIX}c008'
        res = create_equivalence_link(
            param_id=pid, core_hash="SAME", equivalent_to="SAME",
            created_by="pytest", reason="self link",
        )
        assert res["success"] is False


class TestTierD_EquivalenceResolution:
    """
    Tier D — equivalence resolution correctness tests.

    Symmetry, multi-hop closure, deactivation, cycle robustness.
    """

    @pytest.fixture(autouse=True)
    def cleanup(self):
        yield
        cleanup_test_data()

    def _resolve(self, pid, core_hash):
        """Helper: resolve equivalence closure."""
        from snapshot_service import resolve_equivalent_hashes
        return resolve_equivalent_hashes(
            param_id=pid, core_hash=core_hash, include_equivalents=True,
        )

    def test_d001_symmetry(self):
        """Linking A→B: resolving from A includes B, and resolving from B includes A."""
        pid = f'{TEST_PREFIX}d001'
        create_equivalence_link(
            param_id=pid, core_hash="A", equivalent_to="B",
            created_by="pytest", reason="symmetry test",
        )

        res_a = self._resolve(pid, "A")
        assert set(res_a["core_hashes"]) == {"A", "B"}

        res_b = self._resolve(pid, "B")
        assert set(res_b["core_hashes"]) == {"A", "B"}

    def test_d002_multi_hop(self):
        """A↔B, B↔C: resolving A should yield {A, B, C}."""
        pid = f'{TEST_PREFIX}d002'
        create_equivalence_link(
            param_id=pid, core_hash="A", equivalent_to="B",
            created_by="pytest", reason="hop 1",
        )
        create_equivalence_link(
            param_id=pid, core_hash="B", equivalent_to="C",
            created_by="pytest", reason="hop 2",
        )

        res = self._resolve(pid, "A")
        assert set(res["core_hashes"]) == {"A", "B", "C"}

        # Also from C
        res_c = self._resolve(pid, "C")
        assert set(res_c["core_hashes"]) == {"A", "B", "C"}

    def test_d003_deactivated_edges_ignored(self):
        """Deactivated links must not be traversed."""
        pid = f'{TEST_PREFIX}d003'
        create_equivalence_link(
            param_id=pid, core_hash="A", equivalent_to="B",
            created_by="pytest", reason="will deactivate",
        )
        # Verify link works
        assert set(self._resolve(pid, "A")["core_hashes"]) == {"A", "B"}

        # Deactivate
        deactivate_equivalence_link(
            param_id=pid, core_hash="A", equivalent_to="B",
            created_by="pytest", reason="deactivate test",
        )

        # Now resolution should be just {A}
        res = self._resolve(pid, "A")
        assert set(res["core_hashes"]) == {"A"}

    def test_d004_cycle_robustness(self):
        """A↔B, B↔C, C↔A: cycles must not hang; result is {A, B, C} deduplicated."""
        pid = f'{TEST_PREFIX}d004'
        create_equivalence_link(param_id=pid, core_hash="A", equivalent_to="B", created_by="pytest", reason="cycle")
        create_equivalence_link(param_id=pid, core_hash="B", equivalent_to="C", created_by="pytest", reason="cycle")
        create_equivalence_link(param_id=pid, core_hash="C", equivalent_to="A", created_by="pytest", reason="cycle")

        res = self._resolve(pid, "A")
        assert res["success"] is True
        assert set(res["core_hashes"]) == {"A", "B", "C"}

    def test_d005_no_links_resolves_to_self(self):
        """A hash with no links resolves to just itself."""
        pid = f'{TEST_PREFIX}d005'
        res = self._resolve(pid, "LONELY")
        assert res["success"] is True
        assert res["core_hashes"] == ["LONELY"]

    def test_d006_cross_param_isolation(self):
        """Equivalence links are global: resolution does not depend on param_id."""
        pid_x = f'{TEST_PREFIX}d006-x'
        pid_y = f'{TEST_PREFIX}d006-y'
        a = f"{TEST_PREFIX}d006-A"
        b = f"{TEST_PREFIX}d006-B"
        create_equivalence_link(param_id=pid_x, core_hash=a, equivalent_to=b, created_by="pytest", reason="global link")

        res_x = self._resolve(pid_x, a)
        assert set(res_x["core_hashes"]) == {a, b}

        res_y = self._resolve(pid_y, a)
        assert set(res_y["core_hashes"]) == {a, b}


class TestTierE_NoDisappearance:
    """
    Tier E — end-to-end "no disappearance" test.

    Proves the full user story: old snapshots under old signature,
    new signature appears, equivalence link restores visibility.
    """

    @pytest.fixture(autouse=True)
    def cleanup(self):
        yield
        cleanup_test_data()

    def test_e001_full_no_disappearance_scenario(self):
        """
        1. Write snapshots under old signature.
        2. New signature appears (different hash).
        3. Strict query with new hash: sees nothing (mismatch).
        4. Create equivalence link old↔new.
        5. Query with new hash + include_equivalents=True: sees old data.
        6. Inventory shows both in one family, current matches.
        """
        pid = f'{TEST_PREFIX}e001'
        sig_old = f'{{"c":"{TEST_PREFIX}old-query","x":{{}}}}'
        sig_new = f'{{"c":"{TEST_PREFIX}new-query-after-trivial-change","x":{{}}}}'
        hash_old = short_core_hash_from_canonical_signature(sig_old)
        hash_new = short_core_hash_from_canonical_signature(sig_new)

        # 1. Write 5 days of history under old signature
        append_snapshots_for_test(
            param_id=pid,
            canonical_signature=sig_old,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': f'2025-10-0{d}', 'X': d * 10, 'Y': d}
                for d in range(1, 6)
            ],
        )

        # 2. Verify old signature has data
        old_rows = query_snapshots(param_id=pid, core_hash=hash_old, include_equivalents=False)
        assert len(old_rows) == 5

        # 3. Strict query with NEW hash: nothing (this is the "disappearance")
        new_strict = query_snapshots(param_id=pid, core_hash=hash_new, include_equivalents=False)
        assert len(new_strict) == 0

        # Virtual query also sees nothing with new hash
        virtual_strict = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 5),
            core_hash=hash_new,
            slice_keys=[''],
            include_equivalents=False,
        )
        assert virtual_strict["count"] == 0
        assert virtual_strict["has_any_rows"] is True
        assert virtual_strict["has_matching_core_hash"] is False

        # 4. Operator links old ≡ new
        link_res = create_equivalence_link(
            param_id=pid,
            core_hash=hash_new,
            equivalent_to=hash_old,
            created_by="pytest",
            reason="trivial graph change; semantically identical query",
        )
        assert link_res["success"] is True

        # 5a. query_snapshots with equivalents: old data reappears
        new_equiv = query_snapshots(param_id=pid, core_hash=hash_new, include_equivalents=True)
        assert len(new_equiv) == 5
        assert all(r['core_hash'] == hash_old for r in new_equiv)  # data is under old hash

        # 5b. query_virtual_snapshot with equivalents: old data reappears
        virtual_equiv = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 5),
            core_hash=hash_new,
            slice_keys=[''],
            include_equivalents=True,
        )
        assert virtual_equiv["count"] == 5

        # 5c. retrievals with equivalents: sees the retrieval
        retrievals_equiv = query_snapshot_retrievals(
            param_id=pid, core_hash=hash_new, include_equivalents=True, limit=10,
        )
        assert retrievals_equiv["count"] == 1
        assert retrievals_equiv["retrieved_at"][0].startswith("2025-10-10")

        # 6. Inventory: one family containing both hashes, current matches
        inv = get_batch_inventory_v2(
            param_ids=[pid],
            current_signatures={pid: sig_new},
            current_core_hashes={pid: short_core_hash_from_canonical_signature(sig_new)},
            slice_keys_by_param={pid: ['']},
            include_equivalents=True,
            limit_families_per_param=10,
            limit_slices_per_family=10,
        )
        pid_inv = inv[pid]

        # Overall should show the 5 rows
        assert pid_inv["overall_all_families"]["row_count"] == 5

        # Current signature should match
        current = pid_inv.get("current")
        assert current is not None
        assert current["match_mode"] in ("strict", "equivalent")

        # One family with both hashes
        families = pid_inv.get("families") or []
        assert len(families) == 1
        members = set(families[0]["member_core_hashes"])
        assert hash_old in members
        assert hash_new in members or current["match_mode"] == "strict"


class TestCrossParamDataContract:
    """
    Tests for the cross-param equivalence data contract (key-fixes.md §3).

    These cover gaps identified in the coverage audit:
    - resolve_equivalent_hashes returns correct param_ids (including source_param_id)
    - query_snapshots cross-param equivalence
    - query_snapshots_for_sweep cross-param equivalence
    - Multi-day latest-wins across params
    """

    def test_d007_resolve_returns_param_ids(self):
        """
        D-007: resolve_equivalent_hashes returns param_ids including source_param_id.

        When a cross-param equivalence link A→B exists (A on pid_a, B stored under
        pid_b via source_param_id), resolve should return both pid_a and pid_b in
        the param_ids list.
        """
        pid_a = f'{TEST_PREFIX}resolve-pid-a'
        pid_b = f'{TEST_PREFIX}resolve-pid-b'
        sig_a = f'{{"c":"{TEST_PREFIX}resolve-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}resolve-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        # Write data so hashes exist in signature_registry
        append_snapshots_for_test(
            param_id=pid_a,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1}],
        )
        append_snapshots_for_test(
            param_id=pid_b,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 2}],
        )

        # Create cross-param equivalence link
        res_link = create_equivalence_link(
            param_id=pid_a,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="d007 resolve param_ids test",
            source_param_id=pid_b,
        )
        assert res_link["success"] is True

        # Resolve from pid_a/hash_a should return both param_ids
        resolved = resolve_equivalent_hashes(
            param_id=pid_a, core_hash=hash_a, include_equivalents=True
        )
        assert resolved["success"] is True
        assert hash_a in resolved["core_hashes"]
        assert hash_b in resolved["core_hashes"]
        assert pid_a in resolved["param_ids"]
        assert pid_b in resolved["param_ids"]

        # Without equivalents, should return only the seed
        resolved_strict = resolve_equivalent_hashes(
            param_id=pid_a, core_hash=hash_a, include_equivalents=False
        )
        assert resolved_strict["core_hashes"] == [hash_a]
        assert resolved_strict["param_ids"] == [pid_a]

    def test_ri011_query_snapshots_cross_param_equivalence(self):
        """
        RI-011: query_snapshots with include_equivalents=True returns rows from
        a different param_id when linked via source_param_id.
        """
        pid_a = f'{TEST_PREFIX}qs-xp-a'
        pid_b = f'{TEST_PREFIX}qs-xp-b'
        sig_a = f'{{"c":"{TEST_PREFIX}qs-xp-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}qs-xp-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(
            param_id=pid_a,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 10}],
        )
        append_snapshots_for_test(
            param_id=pid_b,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-02', 'X': 20},
                {'anchor_day': '2025-10-03', 'X': 30},
            ],
        )

        # Strict: only pid_a's row
        strict = query_snapshots(param_id=pid_a, core_hash=hash_a, include_equivalents=False)
        assert len(strict) == 1
        assert strict[0]['x'] == 10

        # Link A ≡ B cross-param
        create_equivalence_link(
            param_id=pid_a,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="ri011 cross-param query_snapshots",
            source_param_id=pid_b,
        )

        # With equivalents: rows from BOTH param_ids
        closure = query_snapshots(param_id=pid_a, core_hash=hash_a, include_equivalents=True)
        assert len(closure) == 3
        hashes_returned = {r['core_hash'] for r in closure}
        assert hash_a in hashes_returned
        assert hash_b in hashes_returned
        pids_returned = {r['param_id'] for r in closure}
        assert pid_a in pids_returned
        assert pid_b in pids_returned

    def test_ri012_query_snapshots_for_sweep_cross_param_equivalence(self):
        """
        RI-012: query_snapshots_for_sweep returns rows across param_ids
        when linked via source_param_id.
        """
        pid_a = f'{TEST_PREFIX}sweep-xp-a'
        pid_b = f'{TEST_PREFIX}sweep-xp-b'
        sig_a = f'{{"c":"{TEST_PREFIX}sweep-xp-A","x":{{}}}}'
        sig_b = f'{{"c":"{TEST_PREFIX}sweep-xp-B","x":{{}}}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        # Two retrieval events on different days for the same anchor_day
        append_snapshots_for_test(
            param_id=pid_a,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 100}],
        )
        append_snapshots_for_test(
            param_id=pid_b,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 12, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 200}],
        )

        # Link A ≡ B cross-param
        create_equivalence_link(
            param_id=pid_a,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="ri012 cross-param sweep",
            source_param_id=pid_b,
        )

        # Sweep should return rows from BOTH param_ids
        sweep_rows = query_snapshots_for_sweep(
            param_id=pid_a,
            core_hash=hash_a,
            slice_keys=[''],
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            sweep_from=date(2025, 10, 9),
            sweep_to=date(2025, 10, 13),
            include_equivalents=True,
        )
        assert len(sweep_rows) == 2
        xs = sorted([r['x'] for r in sweep_rows])
        assert xs == [100, 200]
        pids_in_sweep = {r['param_id'] for r in sweep_rows}
        assert pid_a in pids_in_sweep
        assert pid_b in pids_in_sweep

        # Without equivalents: only pid_a's row
        strict_sweep = query_snapshots_for_sweep(
            param_id=pid_a,
            core_hash=hash_a,
            slice_keys=[''],
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 1),
            sweep_from=date(2025, 10, 9),
            sweep_to=date(2025, 10, 13),
            include_equivalents=False,
        )
        assert len(strict_sweep) == 1
        assert strict_sweep[0]['x'] == 100

    def test_ri013_latest_wins_across_params_multi_day(self):
        """
        RI-013: virtual snapshot "latest wins" works correctly across param_ids
        when there are multiple anchor_days and different retrieval histories.

        Scenario:
        - pid_a has anchor_days 1-Oct and 2-Oct, retrieved at t1
        - pid_b has anchor_days 2-Oct and 3-Oct, retrieved at t2 > t1
        - Link A ≡ B cross-param
        - Virtual snapshot as_at > t2 should:
          - Return pid_a data for 1-Oct (only source)
          - Return pid_b data for 2-Oct (latest wins, t2 > t1)
          - Return pid_b data for 3-Oct (only source)
        """
        pid_a = f'{TEST_PREFIX}lw-xp-a'
        pid_b = f'{TEST_PREFIX}lw-xp-b'
        sig_a = '{"c":"lw-xp-A","x":{}}'
        sig_b = '{"c":"lw-xp-B","x":{}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        # pid_a: 1-Oct and 2-Oct retrieved at t1
        append_snapshots_for_test(
            param_id=pid_a,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 1},
                {'anchor_day': '2025-10-02', 'X': 2},
            ],
        )
        # pid_b: 2-Oct and 3-Oct retrieved at t2 (later)
        append_snapshots_for_test(
            param_id=pid_b,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-02', 'X': 222},
                {'anchor_day': '2025-10-03', 'X': 333},
            ],
        )

        # Link A ≡ B cross-param
        create_equivalence_link(
            param_id=pid_a,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="ri013 multi-day latest wins",
            source_param_id=pid_b,
        )

        # Virtual snapshot as-at after both retrievals
        result = query_virtual_snapshot(
            param_id=pid_a,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 3),
            core_hash=hash_a,
            slice_keys=[''],
            include_equivalents=True,
            limit=1000,
        )
        assert result["success"] is True
        assert result["count"] == 3

        rows_by_day = {r['anchor_day'].isoformat() if hasattr(r['anchor_day'], 'isoformat') else r['anchor_day']: r for r in result["rows"]}

        # 1-Oct: only pid_a has data → X=1
        assert rows_by_day['2025-10-01']['x'] == 1

        # 2-Oct: pid_b's retrieval is newer → X=222 wins
        assert rows_by_day['2025-10-02']['x'] == 222

        # 3-Oct: only pid_b has data → X=333
        assert rows_by_day['2025-10-03']['x'] == 333

    def test_ri014_calendar_shows_linked_param_retrieval_days(self):
        """
        RI-014: query_snapshot_retrievals returns retrieval timestamps from a
        linked param_id, making them visible in the @ calendar.

        Scenario:
        - pid_a has retrievals on 10-Oct
        - pid_b has retrievals on 15-Oct (5 days later)
        - Cross-param link A ≡ B
        - Calendar query on pid_a should show BOTH days
        """
        pid_a = f'{TEST_PREFIX}cal-xp-a'
        pid_b = f'{TEST_PREFIX}cal-xp-b'
        sig_a = '{"c":"cal-xp-A","x":{}}'
        sig_b = '{"c":"cal-xp-B","x":{}}'
        hash_a = short_core_hash_from_canonical_signature(sig_a)
        hash_b = short_core_hash_from_canonical_signature(sig_b)

        append_snapshots_for_test(
            param_id=pid_a,
            canonical_signature=sig_a,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 1}],
        )
        append_snapshots_for_test(
            param_id=pid_b,
            canonical_signature=sig_b,
            slice_key='',
            retrieved_at=datetime(2025, 10, 15, 18, 0, 0),
            rows=[{'anchor_day': '2025-10-01', 'X': 999}],
        )

        # Link A ≡ B cross-param
        create_equivalence_link(
            param_id=pid_a,
            core_hash=hash_a,
            equivalent_to=hash_b,
            created_by="pytest",
            reason="ri014 calendar cross-param",
            source_param_id=pid_b,
        )

        # Calendar query for pid_a should show both retrieval days
        retrievals = query_snapshot_retrievals(
            param_id=pid_a, core_hash=hash_a, include_equivalents=True, limit=10
        )
        assert retrievals["success"] is True
        assert retrievals["count"] == 2
        # Should be sorted newest-first
        assert retrievals["retrieved_at"][0].startswith("2025-10-15")
        assert retrievals["retrieved_at"][1].startswith("2025-10-10")

        # Strict query should only see pid_a's retrieval
        strict = query_snapshot_retrievals(
            param_id=pid_a, core_hash=hash_a, include_equivalents=False, limit=10
        )
        assert strict["count"] == 1
        assert strict["retrieved_at"][0].startswith("2025-10-10")
