"""
MECE Aggregation Derivation Tests

Tests for aggregating MECE (Mutually Exclusive, Collectively Exhaustive) slices.

Test Categories:
- DR-005: MECE aggregation sum (X, Y summed correctly)
- DR-006: MECE latency weighted average (weighted by X, not simple mean)

Run with: pytest lib/tests/test_mece_aggregation.py -v
"""

import os
import sys
import pytest
from typing import List, Dict, Any

# Add lib/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.mece_aggregation import aggregate_mece_slices


class TestMeceAggregation:
    """Tests for MECE slice aggregation."""
    
    def test_dr005_mece_aggregation_sum(self):
        """
        DR-005: MECE partition - X and Y sum correctly.
        
        Given 3 MECE slices, the aggregated X and Y should equal the sum.
        """
        slices = [
            {
                'slice_key': 'context(channel:google)',
                'rows': [
                    {'anchor_day': '2025-12-01', 'X': 100, 'Y': 15},
                    {'anchor_day': '2025-12-02', 'X': 110, 'Y': 17},
                ]
            },
            {
                'slice_key': 'context(channel:facebook)',
                'rows': [
                    {'anchor_day': '2025-12-01', 'X': 60, 'Y': 10},
                    {'anchor_day': '2025-12-02', 'X': 65, 'Y': 12},
                ]
            },
            {
                'slice_key': 'context(channel:organic)',
                'rows': [
                    {'anchor_day': '2025-12-01', 'X': 40, 'Y': 5},
                    {'anchor_day': '2025-12-02', 'X': 45, 'Y': 6},
                ]
            },
        ]
        
        result = aggregate_mece_slices(slices)
        
        # Day 1: X = 100 + 60 + 40 = 200, Y = 15 + 10 + 5 = 30
        # Day 2: X = 110 + 65 + 45 = 220, Y = 17 + 12 + 6 = 35
        assert len(result) == 2
        
        day1 = next(r for r in result if r['anchor_day'] == '2025-12-01')
        day2 = next(r for r in result if r['anchor_day'] == '2025-12-02')
        
        assert day1['X'] == 200
        assert day1['Y'] == 30
        assert day2['X'] == 220
        assert day2['Y'] == 35
    
    def test_dr006_mece_aggregation_latency_weighted(self):
        """
        DR-006: MECE latency aggregation - weighted average by X, not simple mean.
        
        Latency should be weighted by the number of users (X) in each slice,
        not a simple average of the latencies.
        
        Formula: weighted_latency = Σ(Xi × latency_i) / Σ(Xi)
        """
        slices = [
            {
                'slice_key': 'context(channel:google)',
                'rows': [
                    {
                        'anchor_day': '2025-12-01',
                        'X': 100,  # Weight: 100
                        'Y': 15,
                        'median_lag_days': 5.0,  # Contributes 100 × 5.0 = 500
                        'mean_lag_days': 6.0,
                    },
                ]
            },
            {
                'slice_key': 'context(channel:facebook)',
                'rows': [
                    {
                        'anchor_day': '2025-12-01',
                        'X': 50,  # Weight: 50
                        'Y': 10,
                        'median_lag_days': 10.0,  # Contributes 50 × 10.0 = 500
                        'mean_lag_days': 12.0,
                    },
                ]
            },
        ]
        
        result = aggregate_mece_slices(slices)
        
        assert len(result) == 1
        row = result[0]
        
        # X and Y sums
        assert row['X'] == 150  # 100 + 50
        assert row['Y'] == 25   # 15 + 10
        
        # Weighted latency:
        # median_lag = (100 × 5.0 + 50 × 10.0) / (100 + 50) = 1000 / 150 = 6.67
        # mean_lag = (100 × 6.0 + 50 × 12.0) / (100 + 50) = 1200 / 150 = 8.0
        assert row['median_lag_days'] == pytest.approx(6.666667, rel=0.01)
        assert row['mean_lag_days'] == pytest.approx(8.0, rel=0.01)
    
    def test_mece_aggregation_preserves_missing_latency(self):
        """
        Aggregation should handle slices with missing latency data.
        
        If some slices have latency and others don't, only aggregate
        from slices that have latency data.
        """
        slices = [
            {
                'slice_key': 'context(channel:google)',
                'rows': [
                    {
                        'anchor_day': '2025-12-01',
                        'X': 100,
                        'Y': 15,
                        'median_lag_days': 5.0,
                    },
                ]
            },
            {
                'slice_key': 'context(channel:facebook)',
                'rows': [
                    {
                        'anchor_day': '2025-12-01',
                        'X': 50,
                        'Y': 10,
                        # No latency data
                    },
                ]
            },
        ]
        
        result = aggregate_mece_slices(slices)
        
        assert len(result) == 1
        row = result[0]
        
        # X and Y should still sum
        assert row['X'] == 150
        assert row['Y'] == 25
        
        # Latency should be weighted from available data only
        # Only google has latency, so weighted average = 5.0 (100/100 weight)
        assert row.get('median_lag_days') == pytest.approx(5.0, rel=0.01)
    
    def test_mece_aggregation_empty_slices(self):
        """Aggregating empty slices returns empty list."""
        result = aggregate_mece_slices([])
        assert result == []
    
    def test_mece_aggregation_single_slice(self):
        """Aggregating single slice returns that slice's data."""
        slices = [
            {
                'slice_key': 'context(channel:google)',
                'rows': [
                    {'anchor_day': '2025-12-01', 'X': 100, 'Y': 15},
                ]
            },
        ]
        
        result = aggregate_mece_slices(slices)
        
        assert len(result) == 1
        assert result[0]['X'] == 100
        assert result[0]['Y'] == 15


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
