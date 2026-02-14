"""
Snapshot Write Integration Tests

These tests write to the REAL production database (Neon) to verify
the snapshot write path works end-to-end.

Test Categories:
- CD-*: Composite/Dual-Query Tests (5 tests)
- MS-*: Multi-Slice Tests (3 tests)
- AMP-*: Real Amplitude Fixture Tests (5 tests)

All test data uses a unique prefix and is cleaned up after each test.

Run with: pytest lib/tests/test_snapshot_integration.py -v
"""

import os
import sys
import json
import pytest
from datetime import datetime, timezone
from typing import List, Dict, Any
from pathlib import Path

# Add lib/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))

from snapshot_service import append_snapshots as append_snapshots_flexi, get_db_connection

# Test prefix to identify and clean up test data
TEST_PREFIX = 'pytest-snapshot-integration'
TEST_TIMESTAMP = datetime.now(timezone.utc)
SIG_ALGO = "sig_v1_sha256_trunc128_b64url"


def append_snapshots(*, param_id: str, core_hash: str, context_def_hashes, slice_key: str, retrieved_at: datetime, rows, diagnostic: bool = False):
    """
    Compatibility wrapper for integration tests.

    The flexi-sigs backend write contract is:
      append_snapshots(param_id, canonical_signature, inputs_json, sig_algo, slice_key, retrieved_at, rows, ...)

    These tests historically passed `core_hash` strings directly; we now treat them as the
    canonical_signature input and let the backend derive the short DB core_hash.
    """
    assert context_def_hashes is None
    return append_snapshots_flexi(
        param_id=param_id,
        canonical_signature=core_hash,
        inputs_json={
            "schema": "pytest_flexi_sigs_v1",
            "param_id": param_id,
            "canonical_signature": core_hash,
        },
        sig_algo=SIG_ALGO,
        slice_key=slice_key,
        retrieved_at=retrieved_at,
        rows=rows,
        diagnostic=diagnostic,
    )

# Path to Amplitude fixtures
FIXTURE_ROOT = Path(__file__).parent.parent.parent.parent / 'param-registry' / 'test' / 'amplitude'


def make_test_param_id(name: str) -> str:
    """Create a unique test param_id that can be cleaned up."""
    return f'{TEST_PREFIX}-{name}-{TEST_TIMESTAMP.strftime("%Y%m%d%H%M%S")}'


def query_snapshots(param_id: str) -> List[Dict[str, Any]]:
    """Query snapshots from the database for verification."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT param_id, core_hash, slice_key, anchor_day, 
                   A, X, Y, 
                   median_lag_days, mean_lag_days,
                   anchor_median_lag_days, anchor_mean_lag_days,
                   onset_delta_days
            FROM snapshots
            WHERE param_id = %s
            ORDER BY anchor_day, slice_key
        """, (param_id,))
        columns = [desc[0] for desc in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def cleanup_test_data(param_id: str):
    """Delete test data from the database."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id = %s", (param_id,))
        cur.execute("DELETE FROM snapshots WHERE param_id = %s", (param_id,))
        deleted = cur.rowcount
        conn.commit()
        return deleted
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def cleanup_all_test_data():
    """Clean up any test data before and after each test."""
    # Clean up before
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        conn.commit()
    finally:
        conn.close()
    
    yield
    
    # Clean up after
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        conn.commit()
    finally:
        conn.close()


# =============================================================================
# CD-*: Composite/Dual-Query Tests
# =============================================================================

class TestCompositeQueries:
    """Tests for dual-query and composite query scenarios."""
    
    def test_CD_001_dual_query_latency_preserved(self):
        """
        CD-001: Dual query (n_query + k_query) - latency from k_query preserved.
        
        In dual-query mode, X comes from n_query and Y+latency from k_query.
        Verify that latency columns are correctly stored.
        """
        param_id = make_test_param_id('cd001')
        
        # Simulate dual-query result: X from n_query, Y and latency from k_query
        rows = [
            {
                'anchor_day': '2025-12-01',
                'X': 100,  # From n_query
                'Y': 15,   # From k_query
                'median_lag_days': 5.2,  # From k_query
                'mean_lag_days': 6.1,
                'anchor_median_lag_days': 3.5,
                'anchor_mean_lag_days': 4.2,
            },
            {
                'anchor_day': '2025-12-02',
                'X': 110,
                'Y': 17,
                'median_lag_days': 5.0,
                'mean_lag_days': 5.9,
                'anchor_median_lag_days': 3.3,
                'anchor_mean_lag_days': 4.0,
            },
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='dual-query-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['inserted'] == 2
        assert result['diagnostic']['has_latency'] is True
        
        # Verify data in database
        stored = query_snapshots(param_id)
        assert len(stored) == 2
        
        # Check latency preserved
        assert stored[0]['median_lag_days'] == pytest.approx(5.2)
        assert stored[0]['mean_lag_days'] == pytest.approx(6.1)
        assert stored[0]['anchor_median_lag_days'] == pytest.approx(3.5)
        assert stored[0]['anchor_mean_lag_days'] == pytest.approx(4.2)
    
    def test_CD_002_dual_query_x_from_n(self):
        """
        CD-002: Dual query - X column comes from n_query result.
        
        Verify X is stored correctly when it comes from a separate n_query.
        """
        param_id = make_test_param_id('cd002')
        
        rows = [
            {'anchor_day': '2025-12-01', 'X': 1000, 'Y': 150},  # Large X from n_query
            {'anchor_day': '2025-12-02', 'X': 1100, 'Y': 165},
            {'anchor_day': '2025-12-03', 'X': 1050, 'Y': 158},
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='dual-query-x-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['inserted'] == 3
        
        stored = query_snapshots(param_id)
        assert stored[0]['x'] == 1000
        assert stored[1]['x'] == 1100
        assert stored[2]['x'] == 1050
    
    def test_CD_003_composite_minus_query(self):
        """
        CD-003: Composite minus query (from().to().minus()).
        
        Verify synthesised Y values from minus() are stored correctly.
        Y = base_conversions - excluded_conversions
        """
        param_id = make_test_param_id('cd003')
        
        # Simulate composite result: Y is synthesised from minus()
        rows = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 12},  # 15 - 3 excluded
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 14},  # 17 - 3 excluded
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='composite-minus-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        
        stored = query_snapshots(param_id)
        assert len(stored) == 2
        assert stored[0]['y'] == 12
        assert stored[1]['y'] == 14
    
    def test_CD_004_composite_plus_query(self):
        """
        CD-004: Composite plus query (from().to().plus()).
        
        Verify combined Y values from plus() are stored correctly.
        Y = base_conversions + additional_conversions
        """
        param_id = make_test_param_id('cd004')
        
        # Simulate composite result: Y is synthesised from plus()
        rows = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 20},  # 15 + 5 additional
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 23},  # 17 + 6 additional
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='composite-plus-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        
        stored = query_snapshots(param_id)
        assert len(stored) == 2
        assert stored[0]['y'] == 20
        assert stored[1]['y'] == 23
    
    def test_CD_005_composite_latency_source(self):
        """
        CD-005: Composite query with latency - latency from base query preserved.
        
        In composite queries, latency should come from the base query only.
        """
        param_id = make_test_param_id('cd005')
        
        rows = [
            {
                'anchor_day': '2025-12-01',
                'X': 100,
                'Y': 12,  # Synthesised from composite
                'median_lag_days': 5.2,  # From base query
                'mean_lag_days': 6.1,
            },
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='composite-latency-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['diagnostic']['has_latency'] is True
        
        stored = query_snapshots(param_id)
        assert stored[0]['median_lag_days'] == pytest.approx(5.2)
        assert stored[0]['mean_lag_days'] == pytest.approx(6.1)


# =============================================================================
# MS-*: Multi-Slice Tests
# =============================================================================

class TestMultiSlice:
    """Tests for multi-slice (contexted) scenarios."""
    
    def test_MS_001_write_multiple_slices(self):
        """
        MS-001: Write multiple context slices.
        
        Three slices should result in 3 × N rows (one set per slice).
        """
        param_id = make_test_param_id('ms001')
        core_hash = 'multi-slice-hash'
        
        slices = [
            ('context(channel:google)', [
                {'anchor_day': '2025-12-01', 'X': 100, 'Y': 15},
                {'anchor_day': '2025-12-02', 'X': 110, 'Y': 17},
            ]),
            ('context(channel:facebook)', [
                {'anchor_day': '2025-12-01', 'X': 80, 'Y': 10},
                {'anchor_day': '2025-12-02', 'X': 85, 'Y': 12},
            ]),
            ('context(channel:organic)', [
                {'anchor_day': '2025-12-01', 'X': 50, 'Y': 8},
                {'anchor_day': '2025-12-02', 'X': 55, 'Y': 9},
            ]),
        ]
        
        total_inserted = 0
        for slice_key, rows in slices:
            result = append_snapshots(
                param_id=param_id,
                core_hash=core_hash,
                context_def_hashes=None,
                slice_key=slice_key,
                retrieved_at=TEST_TIMESTAMP,
                rows=rows,
                diagnostic=True
            )
            assert result['success'] is True
            total_inserted += result['inserted']
        
        assert total_inserted == 6  # 3 slices × 2 days
        
        stored = query_snapshots(param_id)
        assert len(stored) == 6
        
        # Verify each slice is present
        slice_keys = set(row['slice_key'] for row in stored)
        assert slice_keys == {'context(channel:google)', 'context(channel:facebook)', 'context(channel:organic)'}
    
    def test_MS_002_mece_slices_complete(self):
        """
        MS-002: MECE partition - slices sum to uncontexted total.
        
        Verify that MECE slices can be stored and their X/Y sum to uncontexted.
        """
        param_id = make_test_param_id('ms002')
        core_hash = 'mece-hash'
        
        # Uncontexted total
        uncontexted_rows = [
            {'anchor_day': '2025-12-01', 'X': 200, 'Y': 30},
        ]
        
        # MECE slices that sum to total
        mece_slices = [
            ('context(channel:google)', [{'anchor_day': '2025-12-01', 'X': 100, 'Y': 15}]),
            ('context(channel:facebook)', [{'anchor_day': '2025-12-01', 'X': 60, 'Y': 10}]),
            ('context(channel:organic)', [{'anchor_day': '2025-12-01', 'X': 40, 'Y': 5}]),
        ]
        
        # Write uncontexted
        result = append_snapshots(
            param_id=param_id,
            core_hash=core_hash,
            context_def_hashes=None,
            slice_key='',  # Uncontexted
            retrieved_at=TEST_TIMESTAMP,
            rows=uncontexted_rows,
        )
        assert result['success'] is True
        
        # Write MECE slices
        for slice_key, rows in mece_slices:
            result = append_snapshots(
                param_id=param_id,
                core_hash=core_hash,
                context_def_hashes=None,
                slice_key=slice_key,
                retrieved_at=TEST_TIMESTAMP,
                rows=rows,
            )
            assert result['success'] is True
        
        stored = query_snapshots(param_id)
        assert len(stored) == 4  # 1 uncontexted + 3 slices
        
        # Verify MECE: slices sum to uncontexted
        uncontexted = [r for r in stored if r['slice_key'] == ''][0]
        slices = [r for r in stored if r['slice_key'] != '']
        
        assert sum(s['x'] for s in slices) == uncontexted['x']
        assert sum(s['y'] for s in slices) == uncontexted['y']
    
    def test_MS_003_slice_key_encoding(self):
        """
        MS-003: Complex slice DSL encoding.
        
        Verify that complex slice_key DSL is stored exactly as provided.
        """
        param_id = make_test_param_id('ms003')
        
        complex_slices = [
            'context(channel:google)',
            'context(channel:google,region:uk)',
            'context(channel:google).context(region:emea)',
            'cohort(1-Dec-25:7-Dec-25).context(channel:paid)',
        ]
        
        for slice_key in complex_slices:
            result = append_snapshots(
                param_id=param_id,
                core_hash=f'slice-{hash(slice_key)}',
                context_def_hashes=None,
                slice_key=slice_key,
                retrieved_at=TEST_TIMESTAMP,
                rows=[{'anchor_day': '2025-12-01', 'X': 100, 'Y': 15}],
                diagnostic=True
            )
            assert result['success'] is True
            assert result['diagnostic']['slice_key'] == slice_key
        
        stored = query_snapshots(param_id)
        stored_slices = set(row['slice_key'] for row in stored)
        
        # Verify exact encoding preserved
        for expected_slice in complex_slices:
            assert expected_slice in stored_slices, f"Slice key not preserved: {expected_slice}"


# =============================================================================
# Additional Tests: Onset and Cohort Mode
# =============================================================================

class TestOnsetAndCohortMode:
    """Additional tests for onset_delta_days and cohort mode."""
    
    def test_onset_delta_days_stored(self):
        """Verify onset_delta_days is stored correctly."""
        param_id = make_test_param_id('onset')
        
        rows = [
            {
                'anchor_day': '2025-12-01',
                'X': 100,
                'Y': 15,
                'onset_delta_days': 3.5,
            },
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='onset-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
        )
        
        assert result['success'] is True
        
        stored = query_snapshots(param_id)
        assert stored[0]['onset_delta_days'] == pytest.approx(3.5)
    
    def test_cohort_mode_with_anchor(self):
        """Verify cohort mode (A column populated) is stored correctly."""
        param_id = make_test_param_id('cohort')
        
        rows = [
            {'anchor_day': '2025-12-01', 'A': 1000, 'X': 800, 'Y': 100},
            {'anchor_day': '2025-12-02', 'A': 950, 'X': 760, 'Y': 95},
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='cohort-hash',
            context_def_hashes=None,
            slice_key='cohort(1-Dec-25:7-Dec-25)',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['diagnostic']['has_anchor'] is True
        
        stored = query_snapshots(param_id)
        assert stored[0]['a'] == 1000
        assert stored[1]['a'] == 950


# =============================================================================
# IC-*: Insert Count Accuracy Tests
# =============================================================================

class TestInsertCountAccuracy:
    """
    Tests that verify the 'inserted' count returned by append_snapshots
    is accurate and not the buggy psycopg2 rowcount.
    
    These tests are critical because the session log displays this count.
    """
    
    def test_IC_001_inserted_count_matches_rows_written(self):
        """
        IC-001: Inserted count matches actual rows written to DB.
        
        Write N rows, verify inserted == N, verify DB has N rows.
        """
        param_id = make_test_param_id('ic001')
        
        rows = [
            {'anchor_day': f'2025-12-{str(i).zfill(2)}', 'X': 100 + i, 'Y': 10 + i}
            for i in range(1, 21)  # 20 rows
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='ic001-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['inserted'] == 20, f"Expected 20 inserted, got {result['inserted']}"
        assert result['diagnostic']['rows_attempted'] == 20
        assert result['diagnostic']['rows_inserted'] == 20
        assert result['diagnostic']['duplicates_skipped'] == 0
        
        # Verify DB has exactly 20 rows
        stored = query_snapshots(param_id)
        assert len(stored) == 20, f"Expected 20 rows in DB, got {len(stored)}"
    
    def test_IC_002_duplicate_rows_not_counted(self):
        """
        IC-002: Duplicate rows (ON CONFLICT DO NOTHING) not counted in inserted.
        
        Write N rows, then write the same N rows again.
        Second write should report 0 inserted.
        """
        param_id = make_test_param_id('ic002')
        
        rows = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 10},
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 12},
            {'anchor_day': '2025-12-03', 'X': 120, 'Y': 14},
        ]
        
        # First write
        result1 = append_snapshots(
            param_id=param_id,
            core_hash='ic002-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result1['success'] is True
        assert result1['inserted'] == 3
        
        # Second write with same data (same retrieved_at = same unique key)
        result2 = append_snapshots(
            param_id=param_id,
            core_hash='ic002-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,  # Same timestamp
            rows=rows,
            diagnostic=True
        )
        
        assert result2['success'] is True
        assert result2['inserted'] == 0, f"Expected 0 inserted (duplicates), got {result2['inserted']}"
        assert result2['diagnostic']['duplicates_skipped'] == 3
        
        # DB should still have only 3 rows
        stored = query_snapshots(param_id)
        assert len(stored) == 3
    
    def test_IC_003_partial_duplicates_counted_correctly(self):
        """
        IC-003: Mix of new and duplicate rows counted correctly.
        
        Write 3 rows, then write 5 rows (3 duplicates + 2 new).
        Second write should report 2 inserted.
        """
        param_id = make_test_param_id('ic003')
        
        # First write: days 1-3
        rows1 = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 10},
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 12},
            {'anchor_day': '2025-12-03', 'X': 120, 'Y': 14},
        ]
        
        result1 = append_snapshots(
            param_id=param_id,
            core_hash='ic003-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows1,
        )
        assert result1['inserted'] == 3
        
        # Second write: days 1-5 (1-3 are duplicates, 4-5 are new)
        rows2 = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 10},  # duplicate
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 12},  # duplicate
            {'anchor_day': '2025-12-03', 'X': 120, 'Y': 14},  # duplicate
            {'anchor_day': '2025-12-04', 'X': 130, 'Y': 16},  # new
            {'anchor_day': '2025-12-05', 'X': 140, 'Y': 18},  # new
        ]
        
        result2 = append_snapshots(
            param_id=param_id,
            core_hash='ic003-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows2,
            diagnostic=True
        )
        
        assert result2['success'] is True
        assert result2['inserted'] == 2, f"Expected 2 inserted (2 new), got {result2['inserted']}"
        assert result2['diagnostic']['rows_attempted'] == 5
        assert result2['diagnostic']['duplicates_skipped'] == 3
        
        # DB should have 5 rows total
        stored = query_snapshots(param_id)
        assert len(stored) == 5
    
    def test_IC_004_large_batch_count_accurate(self):
        """
        IC-004: Large batch (100+ rows) has accurate count.
        
        This tests that execute_values with RETURNING works for larger batches.
        """
        param_id = make_test_param_id('ic004')
        
        # 101 rows to exceed typical page sizes
        rows = [
            {'anchor_day': f'2025-{str((i // 28) + 1).zfill(2)}-{str((i % 28) + 1).zfill(2)}', 
             'X': 100 + i, 'Y': 10 + i}
            for i in range(101)
        ]
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='ic004-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['inserted'] == 101, f"Expected 101 inserted, got {result['inserted']}"
        
        stored = query_snapshots(param_id)
        assert len(stored) == 101
    
    def test_IC_005_different_retrieved_at_not_duplicates(self):
        """
        IC-005: Same data with different retrieved_at is NOT a duplicate.
        
        The unique constraint includes retrieved_at, so same anchor_day
        with different retrieved_at should insert as new rows.
        """
        param_id = make_test_param_id('ic005')
        from datetime import timedelta
        
        rows = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 10},
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 12},
        ]
        
        # First write at T
        result1 = append_snapshots(
            param_id=param_id,
            core_hash='ic005-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
        )
        assert result1['inserted'] == 2
        
        # Second write at T+1 hour (different retrieved_at = different unique key)
        result2 = append_snapshots(
            param_id=param_id,
            core_hash='ic005-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP + timedelta(hours=1),
            rows=rows,
        )
        assert result2['inserted'] == 2, f"Expected 2 inserted (new retrieved_at), got {result2['inserted']}"
        
        # DB should have 4 rows (2 from each write)
        stored = query_snapshots(param_id)
        assert len(stored) == 4


# =============================================================================
# AMP-*: Real Amplitude Fixture Tests
# =============================================================================

def load_amplitude_fixture(name: str) -> Dict[str, Any]:
    """Load an Amplitude response fixture."""
    path = FIXTURE_ROOT / f'{name}.amplitude-response.json'
    with open(path) as f:
        return json.load(f)


def extract_daily_rows_from_amplitude(response: Dict[str, Any], two_step: bool = True) -> List[Dict[str, Any]]:
    """
    Extract daily X/Y/latency rows from an Amplitude response.
    
    This mirrors the transformation done by the frontend DataOperationsService.
    """
    data = response.get('data', [{}])[0]
    day_funnels = data.get('dayFunnels', {})
    x_values = day_funnels.get('xValues', [])
    series = day_funnels.get('series', [])  # [[X, Y], [X, Y], ...] per day
    
    # Latency data (optional)
    day_median = data.get('dayMedianTransTimes', {}).get('series', [])
    day_avg = data.get('dayAvgTransTimes', {}).get('series', [])
    
    rows = []
    for i, date_str in enumerate(x_values):
        day_data = series[i] if i < len(series) else []
        
        # For 2-step funnel: [X, Y]
        # For 3-step funnel with anchor: [A, X, Y] - we need step indices 1 and 2
        if two_step:
            x_val = day_data[0] if len(day_data) > 0 else 0
            y_val = day_data[1] if len(day_data) > 1 else 0
            a_val = None
        else:
            # 3-step: A is step 0, X is step 1, Y is step 2
            a_val = day_data[0] if len(day_data) > 0 else 0
            x_val = day_data[1] if len(day_data) > 1 else 0
            y_val = day_data[2] if len(day_data) > 2 else 0
        
        # Latency: for 2-step, index 0 is the transition latency
        # For 3-step, we want index 1 (B→C transition)
        lat_idx = 0 if two_step else 1
        median_lag = day_median[i][lat_idx] if i < len(day_median) and len(day_median[i]) > lat_idx else None
        mean_lag = day_avg[i][lat_idx] if i < len(day_avg) and len(day_avg[i]) > lat_idx else None
        
        row = {
            'anchor_day': date_str,
            'X': x_val,
            'Y': y_val,
        }
        if a_val is not None:
            row['A'] = a_val
        if median_lag is not None:
            row['median_lag_days'] = median_lag / 86400000  # ms to days
        if mean_lag is not None:
            row['mean_lag_days'] = mean_lag / 86400000  # ms to days
        
        rows.append(row)
    
    return rows


class TestAmplitudeFixtures:
    """Tests using real Amplitude response fixtures."""
    
    def test_AMP_001_ab_smooth_lag_full_range(self):
        """
        AMP-001: Write full A→B smooth lag fixture to DB.
        
        The ab-smooth-lag fixture has 62 days (Jul-Aug 2025) with 50% conversion.
        """
        param_id = make_test_param_id('amp001-ab')
        
        # Load real Amplitude fixture
        fixture = load_amplitude_fixture('ab-smooth-lag')
        rows = extract_daily_rows_from_amplitude(fixture, two_step=True)
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='ab-smooth-lag-fixture-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['inserted'] == 62  # Jul + Aug 2025
        
        # Verify in DB
        stored = query_snapshots(param_id)
        assert len(stored) == 62
        
        # Verify data matches fixture cumulative totals
        total_x = sum(r['x'] for r in stored)
        total_y = sum(r['y'] for r in stored)
        
        # Fixture has cumulativeRaw: [12400, 6200] for July portion
        # Full fixture should have more
        assert total_x == 12400  # From fixture cumulativeRaw[0]
        assert total_y == 6200   # From fixture cumulativeRaw[1]
        assert total_y / total_x == pytest.approx(0.5, abs=0.01)  # 50% conversion
    
    def test_AMP_002_bc_smooth_lag_window_mode(self):
        """
        AMP-002: Write B→C 2-step (window mode) fixture to DB.
        
        The bc-smooth-lag fixture contains both 2-step and 3-step responses.
        Window mode uses the 2-step response.
        """
        param_id = make_test_param_id('amp002-bc-window')
        
        fixture = load_amplitude_fixture('bc-smooth-lag')
        two_step = fixture.get('two_step', fixture)  # May be nested
        rows = extract_daily_rows_from_amplitude(two_step, two_step=True)
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='bc-smooth-lag-2step-hash',
            context_def_hashes=None,
            slice_key='window(1-Jul-25:31-Aug-25)',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['inserted'] > 0
        
        stored = query_snapshots(param_id)
        assert len(stored) > 0
        
        # Verify slice_key preserved
        assert all(r['slice_key'] == 'window(1-Jul-25:31-Aug-25)' for r in stored)
    
    def test_AMP_003_bc_smooth_lag_cohort_mode(self):
        """
        AMP-003: Write B→C 3-step (cohort mode) fixture to DB.
        
        Cohort mode uses the 3-step response with A as anchor.
        """
        param_id = make_test_param_id('amp003-bc-cohort')
        
        fixture = load_amplitude_fixture('bc-smooth-lag')
        three_step = fixture.get('three_step', fixture)
        rows = extract_daily_rows_from_amplitude(three_step, two_step=False)
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='bc-smooth-lag-3step-hash',
            context_def_hashes=None,
            slice_key='cohort(1-Jul-25:31-Aug-25)',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['diagnostic']['has_anchor'] is True  # A column present
        
        stored = query_snapshots(param_id)
        
        # Verify anchor (A) values are present
        assert all(r['a'] is not None and r['a'] > 0 for r in stored)
    
    def test_AMP_004_latency_data_preserved(self):
        """
        AMP-004: Verify latency data from fixture is stored correctly.
        
        The fixtures include dayMedianTransTimes and dayAvgTransTimes.
        """
        param_id = make_test_param_id('amp004-latency')
        
        fixture = load_amplitude_fixture('ab-smooth-lag')
        rows = extract_daily_rows_from_amplitude(fixture, two_step=True)
        
        # Verify fixture has latency data
        has_latency = any(r.get('median_lag_days') is not None for r in rows)
        if not has_latency:
            pytest.skip('Fixture does not contain latency data')
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='ab-latency-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        assert result['diagnostic']['has_latency'] is True
        
        stored = query_snapshots(param_id)
        
        # At least some rows should have latency
        rows_with_latency = [r for r in stored if r['median_lag_days'] is not None]
        assert len(rows_with_latency) > 0
    
    def test_AMP_005_date_range_correct(self):
        """
        AMP-005: Verify date range in stored data matches fixture xValues.
        """
        param_id = make_test_param_id('amp005-dates')
        
        fixture = load_amplitude_fixture('ab-smooth-lag')
        rows = extract_daily_rows_from_amplitude(fixture, two_step=True)
        
        result = append_snapshots(
            param_id=param_id,
            core_hash='ab-dates-hash',
            context_def_hashes=None,
            slice_key='',
            retrieved_at=TEST_TIMESTAMP,
            rows=rows,
            diagnostic=True
        )
        
        assert result['success'] is True
        
        # Check diagnostic date range
        diag = result['diagnostic']
        assert diag['date_range'] is not None
        
        # Should match fixture's xValues range
        expected_dates = fixture['data'][0]['dayFunnels']['xValues']
        expected_start = expected_dates[0]
        expected_end = expected_dates[-1]
        
        # date_range is formatted as "start → end" string
        date_range_str = diag['date_range']
        assert expected_start in date_range_str
        assert expected_end in date_range_str


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
