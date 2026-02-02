"""
Histogram Derivation Tests (DR-001, DR-002)

Tests for derive_lag_histogram() from snapshot data.
"""

import pytest
import sys
import os

# Add lib directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, datetime, timedelta
from runner.histogram_derivation import derive_lag_histogram


class TestHistogramDerivation:
    """DR-001, DR-002: Histogram derivation tests."""
    
    def test_dr001_histogram_simple(self):
        """
        DR-001: histogram_simple
        
        5 snapshots with increasing Y - lag bins sum to total delta Y.
        """
        anchor_day = date(2025, 10, 1)
        
        # Simulate 5 snapshots at different retrieval times
        # Each snapshot shows Y accumulating over time
        rows = [
            # Day 1 after anchor: Y=5 (5 new conversions)
            {'anchor_day': anchor_day.isoformat(), 'y': 5, 
             'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            # Day 3 after anchor: Y=12 (7 more conversions)
            {'anchor_day': anchor_day.isoformat(), 'y': 12, 
             'retrieved_at': datetime(2025, 10, 4, 12, 0, 0)},
            # Day 5 after anchor: Y=18 (6 more conversions)
            {'anchor_day': anchor_day.isoformat(), 'y': 18, 
             'retrieved_at': datetime(2025, 10, 6, 12, 0, 0)},
            # Day 7 after anchor: Y=22 (4 more conversions)
            {'anchor_day': anchor_day.isoformat(), 'y': 22, 
             'retrieved_at': datetime(2025, 10, 8, 12, 0, 0)},
            # Day 10 after anchor: Y=25 (3 more conversions)
            {'anchor_day': anchor_day.isoformat(), 'y': 25, 
             'retrieved_at': datetime(2025, 10, 11, 12, 0, 0)},
        ]
        
        result = derive_lag_histogram(rows)
        
        assert result['analysis_type'] == 'lag_histogram'
        assert result['total_conversions'] == 25  # Final Y value
        assert result['cohorts_analysed'] == 1
        
        # Check lag bins
        data = result['data']
        lag_map = {d['lag_days']: d['conversions'] for d in data}
        
        # Lag 1 day: 5 conversions (first snapshot)
        assert lag_map.get(1, 0) == 5
        # Lag 3 days: 7 conversions (delta from 5 to 12)
        assert lag_map.get(3, 0) == 7
        # Lag 5 days: 6 conversions (delta from 12 to 18)
        assert lag_map.get(5, 0) == 6
        # Lag 7 days: 4 conversions (delta from 18 to 22)
        assert lag_map.get(7, 0) == 4
        # Lag 10 days: 3 conversions (delta from 22 to 25)
        assert lag_map.get(10, 0) == 3
        
        # Total should match
        total_from_bins = sum(d['conversions'] for d in data)
        assert total_from_bins == result['total_conversions']
    
    def test_dr002_histogram_negative_delta(self):
        """
        DR-002: histogram_negative_delta
        
        Y decreases between snapshots - clamped to 0 (no negative conversions).
        """
        anchor_day = date(2025, 10, 1)
        
        rows = [
            # Day 1: Y=10
            {'anchor_day': anchor_day.isoformat(), 'y': 10, 
             'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            # Day 3: Y=15 (5 more)
            {'anchor_day': anchor_day.isoformat(), 'y': 15, 
             'retrieved_at': datetime(2025, 10, 4, 12, 0, 0)},
            # Day 5: Y=12 (decreased by 3 - data correction or error)
            {'anchor_day': anchor_day.isoformat(), 'y': 12, 
             'retrieved_at': datetime(2025, 10, 6, 12, 0, 0)},
            # Day 7: Y=20 (8 more)
            {'anchor_day': anchor_day.isoformat(), 'y': 20, 
             'retrieved_at': datetime(2025, 10, 8, 12, 0, 0)},
        ]
        
        result = derive_lag_histogram(rows)
        
        # All conversions in bins should be non-negative
        for bin_data in result['data']:
            assert bin_data['conversions'] >= 0, f"Negative conversions at lag {bin_data['lag_days']}"
        
        # Total should only count positive deltas: 10 + 5 + 0 + 8 = 23
        # (The decrease from 15 to 12 is clamped to 0)
        assert result['total_conversions'] == 23
    
    def test_histogram_multi_cohort(self):
        """
        Multiple anchor days (cohorts) - bins aggregate across cohorts.
        """
        rows = [
            # Cohort 1: Oct 1
            {'anchor_day': '2025-10-01', 'y': 5, 'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            {'anchor_day': '2025-10-01', 'y': 10, 'retrieved_at': datetime(2025, 10, 4, 12, 0, 0)},
            
            # Cohort 2: Oct 2
            {'anchor_day': '2025-10-02', 'y': 3, 'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},
            {'anchor_day': '2025-10-02', 'y': 8, 'retrieved_at': datetime(2025, 10, 5, 12, 0, 0)},
        ]
        
        result = derive_lag_histogram(rows)
        
        assert result['cohorts_analysed'] == 2
        
        # Cohort 1: lag 1 = 5, lag 3 = 5
        # Cohort 2: lag 1 = 3, lag 3 = 5
        # Total: lag 1 = 8, lag 3 = 10
        data = result['data']
        lag_map = {d['lag_days']: d['conversions'] for d in data}
        
        assert lag_map.get(1, 0) == 8  # 5 + 3
        assert lag_map.get(3, 0) == 10  # 5 + 5
        assert result['total_conversions'] == 18
    
    def test_histogram_empty_rows(self):
        """
        Empty input - empty histogram.
        """
        result = derive_lag_histogram([])
        
        assert result['analysis_type'] == 'lag_histogram'
        assert result['total_conversions'] == 0
        assert result['data'] == []
        assert result['cohorts_analysed'] == 0
    
    def test_histogram_percentages(self):
        """
        Percentages sum to 1.0 (within rounding tolerance).
        """
        rows = [
            {'anchor_day': '2025-10-01', 'y': 10, 'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},
            {'anchor_day': '2025-10-01', 'y': 30, 'retrieved_at': datetime(2025, 10, 5, 12, 0, 0)},
            {'anchor_day': '2025-10-01', 'y': 60, 'retrieved_at': datetime(2025, 10, 10, 12, 0, 0)},
        ]
        
        result = derive_lag_histogram(rows)
        
        total_pct = sum(d['pct'] for d in result['data'])
        assert abs(total_pct - 1.0) < 0.001, f"Percentages sum to {total_pct}, expected ~1.0"

    def test_histogram_multi_slice_mece_safe(self):
        """
        Multiple slices for the same anchor_day MUST NOT interfere with lag deltas.
        Deltas must be computed per (anchor_day, slice_key) series and then aggregated.
        """
        anchor_day = date(2025, 10, 1)

        rows = [
            # Slice A: Y goes 0 -> 5 with lag 1 then lag 2
            {'anchor_day': anchor_day.isoformat(), 'slice_key': 'context(channel:a)', 'y': 2,
             'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},  # lag 1, +2
            {'anchor_day': anchor_day.isoformat(), 'slice_key': 'context(channel:a)', 'y': 5,
             'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},  # lag 2, +3

            # Slice B: Y goes 0 -> 7 with lag 1 then lag 2
            {'anchor_day': anchor_day.isoformat(), 'slice_key': 'context(channel:b)', 'y': 3,
             'retrieved_at': datetime(2025, 10, 2, 12, 0, 0)},  # lag 1, +3
            {'anchor_day': anchor_day.isoformat(), 'slice_key': 'context(channel:b)', 'y': 7,
             'retrieved_at': datetime(2025, 10, 3, 12, 0, 0)},  # lag 2, +4
        ]

        result = derive_lag_histogram(rows)
        lag_map = {d['lag_days']: d['conversions'] for d in result['data']}

        assert lag_map.get(1, 0) == 5  # 2 + 3
        assert lag_map.get(2, 0) == 7  # 3 + 4
        assert result['total_conversions'] == 12
