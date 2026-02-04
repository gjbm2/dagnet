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
from snapshot_service import (
    query_snapshots, 
    get_snapshot_inventory, 
    append_snapshots,
    query_virtual_snapshot,
    get_db_connection
)

# Skip all tests if DB_CONNECTION not available
pytestmark = pytest.mark.skipif(
    not os.environ.get('DB_CONNECTION'),
    reason="DB_CONNECTION not configured"
)

# Test prefix for cleanup
TEST_PREFIX = 'pytest-ri-'


def cleanup_test_data():
    """Delete all test data with our prefix."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
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
        self.core_hash = 'test-hash-abc123'
        
        # Insert rows with different dates and slices
        rows_uncontexted = [
            {'anchor_day': '2025-10-01', 'X': 100, 'Y': 10},
            {'anchor_day': '2025-10-02', 'X': 110, 'Y': 12},
            {'anchor_day': '2025-10-03', 'X': 120, 'Y': 15},
            {'anchor_day': '2025-10-04', 'X': 130, 'Y': 18},
            {'anchor_day': '2025-10-05', 'X': 140, 'Y': 20},
        ]
        
        append_snapshots(
            param_id=self.param_id,
            core_hash=self.core_hash,
            context_def_hashes=None,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=rows_uncontexted
        )
        
        # Insert slice data
        rows_google = [
            {'anchor_day': '2025-10-01', 'X': 50, 'Y': 5},
            {'anchor_day': '2025-10-02', 'X': 55, 'Y': 6},
        ]
        
        append_snapshots(
            param_id=self.param_id,
            core_hash=self.core_hash,
            context_def_hashes=None,
            slice_key='context(channel:google)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=rows_google
        )
        
        rows_facebook = [
            {'anchor_day': '2025-10-01', 'X': 50, 'Y': 5},
            {'anchor_day': '2025-10-02', 'X': 55, 'Y': 6},
        ]
        
        append_snapshots(
            param_id=self.param_id,
            core_hash=self.core_hash,
            context_def_hashes=None,
            slice_key='context(channel:facebook)',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=rows_facebook
        )
        
        yield
        
        # Cleanup this test's data
        try:
            conn = get_db_connection()
            cur = conn.cursor()
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
        inventory = get_snapshot_inventory(self.param_id)
        
        assert inventory['has_data'] == True
        assert inventory['row_count'] == 9
        assert inventory['unique_days'] == 5  # Oct 1-5
        assert inventory['unique_slices'] == 3  # '', google, facebook
        assert inventory['unique_retrievals'] == 1  # All inserted with same retrieved_at

    def test_ri005_signature_is_part_of_key(self):
        """
        RI-005: signature_keying

        Same param_id, different core_hash => isolated rows.
        """
        other_hash = 'test-hash-OTHER-999'
        append_snapshots(
            param_id=self.param_id,
            core_hash=other_hash,
            context_def_hashes=None,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 999, 'Y': 99},
            ]
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
        sig_a = 'sig-A'
        sig_b = 'sig-B'

        # Day 0 retrieval (older)
        append_snapshots(
            param_id=pid,
            core_hash=sig_a,
            context_def_hashes=None,
            slice_key='',
            retrieved_at=datetime(2025, 10, 10, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 1, 'Y': 1},
                {'anchor_day': '2025-10-02', 'X': 2, 'Y': 2},
            ]
        )
        # Day 1 retrieval (newer) only overlaps one day
        append_snapshots(
            param_id=pid,
            core_hash=sig_a,
            context_def_hashes=None,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-02', 'X': 222, 'Y': 22},
            ]
        )
        # Another signature under same param_id (should not be returned when querying sig_a)
        append_snapshots(
            param_id=pid,
            core_hash=sig_b,
            context_def_hashes=None,
            slice_key='',
            retrieved_at=datetime(2025, 10, 11, 12, 0, 0),
            rows=[
                {'anchor_day': '2025-10-01', 'X': 999, 'Y': 99},
            ]
        )

        res = query_virtual_snapshot(
            param_id=pid,
            as_at=datetime(2025, 10, 12, 0, 0, 0),
            anchor_from=date(2025, 10, 1),
            anchor_to=date(2025, 10, 2),
            core_hash=sig_a,
            slice_keys=[''],
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
            core_hash='sig-NOT-THERE',
            slice_keys=[''],
            limit=10000,
        )
        assert res_wrong['success'] is True
        assert res_wrong['count'] == 0
        assert res_wrong['has_any_rows'] is True
        assert res_wrong['has_matching_core_hash'] is False
