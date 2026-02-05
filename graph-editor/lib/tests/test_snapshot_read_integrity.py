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
    get_db_connection,
    get_batch_inventory_v2,
    short_core_hash_from_canonical_signature,
    create_equivalence_link,
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
            slice_key='',
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
            slice_key='context(channel:google)',
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
            slice_key='context(channel:facebook)',
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
            slice_keys=['context(channel:google)']
        )
        
        # Should only return google slice rows
        assert len(rows) == 2
        
        for row in rows:
            assert row['slice_key'] == 'context(channel:google)'
    
    def test_read_inventory(self):
        """
        Inventory returns correct summary stats.
        """
        inv = get_batch_inventory_v2(
            param_ids=[self.param_id],
            current_signatures={self.param_id: self.canonical_signature},
            slice_keys_by_param={self.param_id: ['', 'context(channel:google)', 'context(channel:facebook)']},
            include_equivalents=True,
            limit_families_per_param=10,
            limit_slices_per_family=10,
        )
        pid_inv = inv[self.param_id]
        overall = pid_inv["overall_all_families"]

        assert overall["row_count"] == 9
        assert overall["unique_anchor_days"] == 5  # Oct 1-5
        assert overall["unique_retrievals"] == 1  # All inserted with same retrieved_at

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
        sig_a = '{"c":"sig-A","x":{}}'
        sig_b = '{"c":"sig-B","x":{}}'
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
        sig_a = '{"c":"eq-A","x":{}}'
        sig_b = '{"c":"eq-B","x":{}}'
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

    def test_ri009_inventory_v2_groups_equivalent_signatures_into_one_family(self):
        """
        RI-009: inventory V2 groups equivalence closure into a signature family.
        """
        pid = f'{TEST_PREFIX}param-inv-eq'
        sig_a = '{"c":"inv-eq-A","x":{}}'
        sig_b = '{"c":"inv-eq-B","x":{}}'
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
