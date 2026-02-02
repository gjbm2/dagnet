"""
Daily Conversions Derivation Tests (DR-003, DR-004)

Tests for derive_daily_conversions() from snapshot data.
"""

import pytest
import sys
import os

# Add lib directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, datetime
from runner.daily_conversions_derivation import derive_daily_conversions


class TestDailyConversionsDerivation:
    """DR-003, DR-004: Daily conversions derivation tests."""
    
    def test_dr003_daily_conversions_simple(self):
        """
        DR-003: daily_conversions_simple
        
        5 snapshots → ΔY attributed to correct retrieval dates.
        """
        anchor_day = date(2025, 10, 1)
        
        rows = [
            # Retrieved Oct 2: Y=5 (5 conversions attributed to Oct 2)
            {'anchor_day': anchor_day.isoformat(), 'y': 5, 
             'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            # Retrieved Oct 4: Y=12 (7 conversions attributed to Oct 4)
            {'anchor_day': anchor_day.isoformat(), 'y': 12, 
             'retrieved_at': datetime(2025, 10, 4, 14, 0, 0)},
            # Retrieved Oct 6: Y=18 (6 conversions attributed to Oct 6)
            {'anchor_day': anchor_day.isoformat(), 'y': 18, 
             'retrieved_at': datetime(2025, 10, 6, 9, 0, 0)},
            # Retrieved Oct 8: Y=22 (4 conversions attributed to Oct 8)
            {'anchor_day': anchor_day.isoformat(), 'y': 22, 
             'retrieved_at': datetime(2025, 10, 8, 16, 0, 0)},
            # Retrieved Oct 10: Y=25 (3 conversions attributed to Oct 10)
            {'anchor_day': anchor_day.isoformat(), 'y': 25, 
             'retrieved_at': datetime(2025, 10, 10, 11, 0, 0)},
        ]
        
        result = derive_daily_conversions(rows)
        
        assert result['analysis_type'] == 'daily_conversions'
        assert result['total_conversions'] == 25
        
        # Check date attribution
        date_map = {d['date']: d['conversions'] for d in result['data']}
        
        assert date_map.get('2025-10-02', 0) == 5
        assert date_map.get('2025-10-04', 0) == 7
        assert date_map.get('2025-10-06', 0) == 6
        assert date_map.get('2025-10-08', 0) == 4
        assert date_map.get('2025-10-10', 0) == 3
        
        # Date range should be correct
        assert result['date_range']['from'] == '2025-10-02'
        assert result['date_range']['to'] == '2025-10-10'
    
    def test_dr004_daily_conversions_multi_cohort(self):
        """
        DR-004: daily_conversions_multi_cohort
        
        10 cohorts x 5 snapshots - daily totals aggregated correctly.
        """
        rows = []
        
        # Create 10 cohorts, each with 5 snapshots
        # Each cohort starts at Y=0, deltas are 2,3,4,5,6 per snapshot
        for cohort_offset in range(10):
            anchor_day = date(2025, 10, 1 + cohort_offset)
            
            # 5 snapshots per cohort with cumulative Y values
            cumulative_y = 0
            for snap_idx, (retrieval_day, delta) in enumerate([
                (15, 2),
                (16, 3),
                (17, 4),
                (18, 5),
                (19, 6),
            ]):
                cumulative_y += delta
                rows.append({
                    'anchor_day': anchor_day.isoformat(),
                    'y': cumulative_y,
                    'retrieved_at': datetime(2025, 10, retrieval_day, 12, 0, 0),
                })
        
        result = derive_daily_conversions(rows)
        
        # 10 cohorts x (2+3+4+5+6) = 10 x 20 = 200 total conversions
        assert result['total_conversions'] == 200
        
        # Each day should have conversions from all 10 cohorts
        date_map = {d['date']: d['conversions'] for d in result['data']}
        
        # Oct 15: 10 cohorts x 2 = 20
        assert date_map.get('2025-10-15', 0) == 20
        # Oct 16: 10 cohorts x 3 = 30
        assert date_map.get('2025-10-16', 0) == 30
        # Oct 17: 10 cohorts x 4 = 40
        assert date_map.get('2025-10-17', 0) == 40
        # Oct 18: 10 cohorts x 5 = 50
        assert date_map.get('2025-10-18', 0) == 50
        # Oct 19: 10 cohorts x 6 = 60
        assert date_map.get('2025-10-19', 0) == 60
    
    def test_daily_conversions_negative_delta_clamped(self):
        """
        Y decreases → delta clamped to 0 (no negative daily conversions).
        """
        rows = [
            {'anchor_day': '2025-10-01', 'y': 10, 'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            {'anchor_day': '2025-10-01', 'y': 8, 'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},  # Decrease
            {'anchor_day': '2025-10-01', 'y': 15, 'retrieved_at': datetime(2025, 10, 4, 12, 0, 0)},
        ]
        
        result = derive_daily_conversions(rows)
        
        date_map = {d['date']: d['conversions'] for d in result['data']}
        
        # Oct 2: 10 conversions
        assert date_map.get('2025-10-02', 0) == 10
        # Oct 3: 0 conversions (decrease clamped)
        assert date_map.get('2025-10-03', 0) == 0
        # Oct 4: 7 conversions (15 - 8)
        assert date_map.get('2025-10-04', 0) == 7
        
        assert result['total_conversions'] == 17
    
    def test_daily_conversions_empty_rows(self):
        """
        Empty input → empty result.
        """
        result = derive_daily_conversions([])
        
        assert result['analysis_type'] == 'daily_conversions'
        assert result['total_conversions'] == 0
        assert result['data'] == []
        assert result['date_range']['from'] is None
        assert result['date_range']['to'] is None
    
    def test_daily_conversions_same_day_multiple_snapshots(self):
        """
        Multiple snapshots on same day → only last delta counted for that day.
        """
        rows = [
            # Morning snapshot: Y=5
            {'anchor_day': '2025-10-01', 'y': 5, 'retrieved_at': datetime(2025, 10, 2, 9, 0, 0)},
            # Afternoon snapshot: Y=8
            {'anchor_day': '2025-10-01', 'y': 8, 'retrieved_at': datetime(2025, 10, 2, 15, 0, 0)},
            # Evening snapshot: Y=10
            {'anchor_day': '2025-10-01', 'y': 10, 'retrieved_at': datetime(2025, 10, 2, 21, 0, 0)},
            # Next day: Y=15
            {'anchor_day': '2025-10-01', 'y': 15, 'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},
        ]
        
        result = derive_daily_conversions(rows)
        
        date_map = {d['date']: d['conversions'] for d in result['data']}
        
        # Oct 2: 5 + 3 + 2 = 10 (all deltas within same day)
        assert date_map.get('2025-10-02', 0) == 10
        # Oct 3: 5 conversions
        assert date_map.get('2025-10-03', 0) == 5
        
        assert result['total_conversions'] == 15

    def test_daily_conversions_multi_slice_mece_safe(self):
        """
        Multiple slices for the same anchor_day MUST NOT interfere with deltas.

        This simulates MECE partitions (e.g. channel=A, channel=B) where each slice is a
        separate cumulative Y series over retrieved_at.
        """
        rows = [
            # Slice A: Y goes 0 -> 5
            {'anchor_day': '2025-10-01', 'slice_key': 'context(channel:a)', 'y': 2, 'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            {'anchor_day': '2025-10-01', 'slice_key': 'context(channel:a)', 'y': 5, 'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},
            # Slice B: Y goes 0 -> 7
            {'anchor_day': '2025-10-01', 'slice_key': 'context(channel:b)', 'y': 3, 'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            {'anchor_day': '2025-10-01', 'slice_key': 'context(channel:b)', 'y': 7, 'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},
        ]

        result = derive_daily_conversions(rows)

        # Oct 2: 2 + 3 = 5, Oct 3: (5-2) + (7-3) = 7
        date_map = {d['date']: d['conversions'] for d in result['data']}
        assert date_map.get('2025-10-02', 0) == 5
        assert date_map.get('2025-10-03', 0) == 7
        assert result['total_conversions'] == 12
