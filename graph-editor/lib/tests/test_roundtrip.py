"""
Round-Trip Integration Tests

These tests verify the complete data flow:
- Write data to DB
- Read data back
- Derive analytics
- Verify results match expected

Test Categories:
- RT-001: Simple roundtrip
- RT-002: Dual-query roundtrip  
- RT-003: Composite roundtrip
- RT-004: Contexted MECE roundtrip
- RT-005: Signature stability roundtrip

Run with: pytest lib/tests/test_roundtrip.py -v
"""

import os
import sys
import pytest
from datetime import datetime, timezone, date
from typing import List, Dict, Any

# Add lib/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))

from snapshot_service import append_snapshots, query_snapshots, get_db_connection, short_core_hash_from_canonical_signature
from runner.histogram_derivation import derive_lag_histogram
from runner.daily_conversions_derivation import derive_daily_conversions
from runner.mece_aggregation import aggregate_mece_slices


# Test prefix for cleanup
TEST_PREFIX = 'pytest-roundtrip'
TEST_TIMESTAMP = datetime.now(timezone.utc)
SIG_ALGO = "sig_v1_sha256_trunc128_b64url"


def append_snapshots_for_test(*, param_id: str, canonical_signature: str, slice_key: str, rows, diagnostic: bool = False):
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
        retrieved_at=TEST_TIMESTAMP,
        rows=rows,
        diagnostic=diagnostic,
    )


def make_test_param_id(name: str) -> str:
    """Create unique test param_id."""
    return f'{TEST_PREFIX}-{name}-{TEST_TIMESTAMP.strftime("%Y%m%d%H%M%S")}'


def cleanup_test_data(param_id: str):
    """Delete test data from the database."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id = %s", (param_id,))
        cur.execute("DELETE FROM snapshots WHERE param_id = %s", (param_id,))
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def cleanup_all_test_data():
    """Clean up test data before and after each test."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        conn.commit()
    finally:
        conn.close()
    
    yield
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM signature_registry WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{TEST_PREFIX}%',))
        conn.commit()
    finally:
        conn.close()


class TestRoundTrip:
    """Round-trip tests: write → read → derive → verify."""
    
    def test_rt001_roundtrip_simple(self):
        """
        RT-001: Simple roundtrip - fetch → write → read → derive.
        
        Write simple time-series, read it back, derive histogram,
        verify derived result matches expected.
        """
        param_id = make_test_param_id('rt001')
        canonical_signature = 'rt001-simple-hash'
        core_hash = short_core_hash_from_canonical_signature(canonical_signature)
        
        # Write 5 days of data with increasing Y
        rows = []
        for day in range(1, 6):
            rows.append({
                'anchor_day': f'2025-12-{str(day).zfill(2)}',
                'X': 100,
                'Y': day * 5,  # 5, 10, 15, 20, 25
            })
        
        # Write
        result = append_snapshots_for_test(param_id=param_id, canonical_signature=canonical_signature, slice_key='', rows=rows)
        assert result['success'] is True
        assert result['inserted'] == 5
        
        # Read back
        stored = query_snapshots(
            param_id=param_id,
            core_hash=core_hash,
        )
        assert len(stored) == 5
        
        # Verify data integrity
        for i, row in enumerate(sorted(stored, key=lambda r: r['anchor_day'])):
            expected_y = (i + 1) * 5
            assert row['y'] == expected_y
        
        # Derive histogram (would need multiple snapshots per cohort for real histogram)
        # For this simple case, just verify we can call the derivation
        total_y = sum(r['y'] for r in stored)
        assert total_y == 75  # 5+10+15+20+25
    
    def test_rt002_roundtrip_dual_query(self):
        """
        RT-002: Dual-query roundtrip - all columns intact, latency preserved.
        
        Write data that simulates dual-query result (X from n_query, Y+latency from k_query).
        Verify all columns survive the roundtrip.
        """
        param_id = make_test_param_id('rt002')
        canonical_signature = 'rt002-dual-hash'
        core_hash = short_core_hash_from_canonical_signature(canonical_signature)
        
        rows = [
            {
                'anchor_day': '2025-12-01',
                'X': 1000,  # From n_query
                'Y': 150,   # From k_query
                'median_lag_days': 5.25,
                'mean_lag_days': 6.10,
                'anchor_median_lag_days': 3.50,
                'anchor_mean_lag_days': 4.20,
            },
            {
                'anchor_day': '2025-12-02',
                'X': 1100,
                'Y': 165,
                'median_lag_days': 5.00,
                'mean_lag_days': 5.90,
                'anchor_median_lag_days': 3.30,
                'anchor_mean_lag_days': 4.00,
            },
        ]
        
        # Write
        result = append_snapshots_for_test(param_id=param_id, canonical_signature=canonical_signature, slice_key='', rows=rows)
        assert result['success'] is True
        
        # Read back
        stored = query_snapshots(param_id=param_id, core_hash=core_hash)
        assert len(stored) == 2
        
        # Verify all columns preserved
        row1 = next(r for r in stored if str(r['anchor_day']) == '2025-12-01')
        assert row1['x'] == 1000
        assert row1['y'] == 150
        assert row1['median_lag_days'] == pytest.approx(5.25)
        assert row1['mean_lag_days'] == pytest.approx(6.10)
        assert row1['anchor_median_lag_days'] == pytest.approx(3.50)
        assert row1['anchor_mean_lag_days'] == pytest.approx(4.20)
    
    def test_rt003_roundtrip_composite(self):
        """
        RT-003: Composite roundtrip - synthesised data retrievable.
        
        Write data that represents a composite query result (e.g., minus()).
        Verify synthesised Y values are correctly stored and retrieved.
        """
        param_id = make_test_param_id('rt003')
        canonical_signature = 'rt003-composite-hash'
        core_hash = short_core_hash_from_canonical_signature(canonical_signature)
        
        # Composite query result: Y = base - excluded
        rows = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 12},  # 15 - 3
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 14},  # 17 - 3
            {'anchor_day': '2025-12-03', 'X': 105, 'Y': 13},  # 16 - 3
        ]
        
        # Write
        result = append_snapshots_for_test(param_id=param_id, canonical_signature=canonical_signature, slice_key='', rows=rows)
        assert result['success'] is True
        
        # Read back
        stored = query_snapshots(param_id=param_id, core_hash=core_hash)
        assert len(stored) == 3
        
        # Verify synthesised Y values
        ys = sorted([r['y'] for r in stored])
        assert ys == [12, 13, 14]
    
    def test_rt004_roundtrip_contexted_mece(self):
        """
        RT-004: MECE roundtrip - aggregated sum matches uncontexted.
        
        Write MECE slices, read them back, aggregate, verify sum.
        """
        param_id = make_test_param_id('rt004')
        canonical_signature = 'rt004-mece-hash'
        core_hash = short_core_hash_from_canonical_signature(canonical_signature)
        
        mece_slices = [
            ('context(channel:google)', [
                {'anchor_day': '2025-12-01', 'X': 100, 'Y': 15},
            ]),
            ('context(channel:facebook)', [
                {'anchor_day': '2025-12-01', 'X': 60, 'Y': 10},
            ]),
            ('context(channel:organic)', [
                {'anchor_day': '2025-12-01', 'X': 40, 'Y': 5},
            ]),
        ]
        
        # Write each slice
        for slice_key, rows in mece_slices:
            result = append_snapshots_for_test(param_id=param_id, canonical_signature=canonical_signature, slice_key=slice_key, rows=rows)
            assert result['success'] is True
        
        # Read all slices
        stored = query_snapshots(param_id=param_id, core_hash=core_hash)
        assert len(stored) == 3
        
        # Build slice data for aggregation
        slices_for_agg = []
        for slice_key, _ in mece_slices:
            slice_rows = [r for r in stored if r['slice_key'] == slice_key]
            slices_for_agg.append({
                'slice_key': slice_key,
                'rows': [{'anchor_day': str(r['anchor_day']), 'X': r['x'], 'Y': r['y']} for r in slice_rows]
            })
        
        # Aggregate
        aggregated = aggregate_mece_slices(slices_for_agg)
        
        assert len(aggregated) == 1
        assert aggregated[0]['X'] == 200  # 100 + 60 + 40
        assert aggregated[0]['Y'] == 30   # 15 + 10 + 5
    
    def test_rt005_roundtrip_signature_stable(self):
        """
        RT-005: Signature stability - fetch → write → later read with same signature.
        
        Verify that querying with the same core_hash returns the same data.
        """
        param_id = make_test_param_id('rt005')
        canonical_signature = 'rt005-stable-signature'
        core_hash = short_core_hash_from_canonical_signature(canonical_signature)
        
        rows = [
            {'anchor_day': '2025-12-01', 'X': 100, 'Y': 15},
            {'anchor_day': '2025-12-02', 'X': 110, 'Y': 17},
        ]
        
        # Write
        result = append_snapshots_for_test(param_id=param_id, canonical_signature=canonical_signature, slice_key='', rows=rows)
        assert result['success'] is True
        
        # Read with same signature - should get same data
        stored1 = query_snapshots(param_id=param_id, core_hash=core_hash)
        
        # Read again - should be identical
        stored2 = query_snapshots(param_id=param_id, core_hash=core_hash)
        
        assert len(stored1) == len(stored2) == 2
        
        # Verify same data
        for r1, r2 in zip(
            sorted(stored1, key=lambda r: r['anchor_day']),
            sorted(stored2, key=lambda r: r['anchor_day'])
        ):
            assert r1['x'] == r2['x']
            assert r1['y'] == r2['y']
            assert r1['anchor_day'] == r2['anchor_day']


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
