/**
 * WindowAggregationService Unit Tests
 * 
 * Tests aggregation of daily time-series data into aggregate statistics.
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  WindowAggregationService,
  parameterToTimeSeries,
  mergeTimeSeriesIntoParameter,
} from '../windowAggregationService';

const windowAggregationService = new WindowAggregationService();
import type { TimeSeriesPoint, DateRange } from '../../types';

describe('WindowAggregationService', () => {
  describe('parameterToTimeSeries', () => {
    it('should convert parameter arrays to time series', () => {
      const n_daily = [1000, 2000, 1500];
      const k_daily = [300, 600, 450];
      const dates = ['2024-11-01', '2024-11-02', '2024-11-03'];

      const result = parameterToTimeSeries(n_daily, k_daily, dates);

      expect(result).toEqual([
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 2000, k: 600, p: 0.3 },
        { date: '2024-11-03', n: 1500, k: 450, p: 0.3 },
      ]);
    });

    it('should return empty array if arrays are undefined', () => {
      const result = parameterToTimeSeries(undefined, undefined, undefined);
      expect(result).toEqual([]);
    });

    it('should throw if array lengths mismatch', () => {
      const n_daily = [1000, 2000];
      const k_daily = [300];
      const dates = ['2024-11-01', '2024-11-02'];

      expect(() => {
        parameterToTimeSeries(n_daily, k_daily, dates);
      }).toThrow('n_daily, k_daily, and dates arrays must have the same length');
    });

    it('should handle zero n values (p = 0)', () => {
      const n_daily = [1000, 0, 500];
      const k_daily = [300, 0, 150];
      const dates = ['2024-11-01', '2024-11-02', '2024-11-03'];

      const result = parameterToTimeSeries(n_daily, k_daily, dates);

      expect(result[1].p).toBe(0);
    });
  });

  describe('aggregateWindow', () => {
    it('should aggregate simple case: 7 days, each with n=1000, k=300', () => {
      const timeSeries: TimeSeriesPoint[] = [];
      for (let i = 1; i <= 7; i++) {
        timeSeries.push({
          date: `2024-11-${String(i).padStart(2, '0')}`,
          n: 1000,
          k: 300,
          p: 0.3,
        });
      }

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-07',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(7000);
      expect(result.k).toBe(2100);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.days_included).toBe(7);
      expect(result.days_missing).toBe(0);
      expect(result.raw_data.length).toBe(7);
    });

    it('should aggregate variable sample sizes', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 500, k: 150, p: 0.3 },
        { date: '2024-11-03', n: 2000, k: 600, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-03',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(3500);
      expect(result.k).toBe(1050);
      expect(result.mean).toBeCloseTo(0.3, 10);
    });

    it('should throw error for empty window (no data)', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 1000, k: 300, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-20',
        end: '2024-11-30',
      };

      expect(() => {
        windowAggregationService.aggregateWindow(timeSeries, window);
      }).toThrow('No data available for window');
    });

    it('should handle partial window (some days missing)', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-05', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-06', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-07', n: 1000, k: 300, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-07',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(5000); // Only 5 days included
      expect(result.k).toBe(1500);
      expect(result.days_included).toBe(5);
      expect(result.days_missing).toBe(2); // Missing Nov 3 and 4
    });

    it('should handle single day window', () => {
      const timeSeries: TimeSeriesPoint[] = [];
      // Generate 30 days of data (November has 30 days)
      for (let i = 1; i <= 30; i++) {
        timeSeries.push({
          date: `2024-11-${String(i).padStart(2, '0')}`,
          n: 1000,
          k: 300,
          p: 0.3,
        });
      }

      const window: DateRange = {
        start: '2024-11-15',
        end: '2024-11-15',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.days_included).toBe(1);
      expect(result.days_missing).toBe(0);
    });

    it('should handle zero conversions', () => {
      const timeSeries: TimeSeriesPoint[] = [];
      for (let i = 1; i <= 7; i++) {
        timeSeries.push({
          date: `2024-11-${String(i).padStart(2, '0')}`,
          n: 1000,
          k: 0,
          p: 0,
        });
      }

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-07',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(7000);
      expect(result.k).toBe(0);
      expect(result.mean).toBe(0);
      expect(result.stdev).toBe(0);
    });

    it('should handle zero sample size (n=0) - includes them in aggregation', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 0, k: 0, p: 0 },
        { date: '2024-11-03', n: 500, k: 150, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-03',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(1500); // Includes the zero day
      expect(result.k).toBe(450);
      expect(result.mean).toBeCloseTo(0.3, 10);
    });

    it('should handle extreme values correctly', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 1000000, k: 500000, p: 0.5 },
        { date: '2024-11-03', n: 1000, k: 300, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-03',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      expect(result.n).toBe(1002000);
      expect(result.k).toBe(500600);
      // Weighted mean: (300 + 500000 + 300) / (1000 + 1000000 + 1000) ≈ 0.4997
      expect(result.mean).toBeCloseTo(500600 / 1002000, 5);
    });

    it('should normalize ISO 8601 dates to YYYY-MM-DD', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01T00:00:00Z', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02T12:34:56Z', n: 1000, k: 300, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-01T00:00:00Z',
        end: '2024-11-02T23:59:59Z',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      // Window dates now returned in UK format (d-MMM-yy)
      expect(result.window.start).toBe('1-Nov-24');
      expect(result.window.end).toBe('2-Nov-24');
      expect(result.days_included).toBe(2);
    });

    it('should calculate standard deviation correctly', () => {
      const timeSeries: TimeSeriesPoint[] = [
        { date: '2024-11-01', n: 100, k: 30, p: 0.3 },
      ];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-01',
      };

      const result = windowAggregationService.aggregateWindow(timeSeries, window);

      // Binomial stdev: sqrt(p * (1-p) / n) = sqrt(0.3 * 0.7 / 100) ≈ 0.0458
      const expectedStdev = Math.sqrt((0.3 * 0.7) / 100);
      expect(result.stdev).toBeCloseTo(expectedStdev, 5);
    });
  });

  describe('aggregateFromParameter', () => {
    it('should aggregate from parameter file format', () => {
      const n_daily = [1000, 2000, 1500];
      const k_daily = [300, 600, 450];
      const dates = ['2024-11-01', '2024-11-02', '2024-11-03'];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-03',
      };

      const result = windowAggregationService.aggregateFromParameter(
        n_daily,
        k_daily,
        dates,
        window
      );

      expect(result.n).toBe(4500);
      expect(result.k).toBe(1350);
      expect(result.mean).toBeCloseTo(0.3, 10);
    });

    it('should handle partial window with parameter format', () => {
      const n_daily = [1000, 1000, 1000, 1000, 1000];
      const k_daily = [300, 300, 300, 300, 300];
      const dates = ['2024-11-01', '2024-11-02', '2024-11-05', '2024-11-06', '2024-11-07'];

      const window: DateRange = {
        start: '2024-11-01',
        end: '2024-11-07',
      };

      const result = windowAggregationService.aggregateFromParameter(
        n_daily,
        k_daily,
        dates,
        window
      );

      expect(result.days_included).toBe(5);
      expect(result.days_missing).toBe(2);
    });
  });

  // ============================================================
  // Cohort Mode Tests (C2-T.4)
  // ============================================================

  describe('mergeTimeSeriesIntoParameter - Cohort Mode', () => {
    it('should set cohort_from/cohort_to when isCohortMode is true', () => {
      const existingValues: any[] = [];
      const newTimeSeries = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
        { date: '2024-11-02', n: 1200, k: 360, p: 0.3 },
      ];
      const newWindow = { start: '1-Nov-24', end: '2-Nov-24' };
      
      const result = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        newWindow,
        'test-sig',
        {},
        'test-query',
        'amplitude',
        undefined,
        { isCohortMode: true } // mergeOptions with cohort mode enabled
      );
      
      expect(result.length).toBe(1);
      // In cohort mode, uses cohort_from/cohort_to instead of window_from/window_to
      expect(result[0].cohort_from).toBe('1-Nov-24');
      expect(result[0].cohort_to).toBe('2-Nov-24');
      // In cohort mode, window_from/window_to should NOT be set
      expect(result[0].window_from).toBeUndefined();
      expect(result[0].window_to).toBeUndefined();
    });

    it('should store latency arrays when provided in time series', () => {
      const existingValues: any[] = [];
      const newTimeSeries = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3, median_lag_days: 2.5, mean_lag_days: 3.1 },
        { date: '2024-11-02', n: 1200, k: 360, p: 0.3, median_lag_days: 2.8, mean_lag_days: 3.4 },
      ];
      const newWindow = { start: '1-Nov-24', end: '2-Nov-24' };
      
      const result = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        newWindow,
        'test-sig'
      );
      
      expect(result.length).toBe(1);
      expect(result[0].median_lag_days).toEqual([2.5, 2.8]);
      expect(result[0].mean_lag_days).toEqual([3.1, 3.4]);
    });

    it('should store latency summary block when provided via mergeOptions', () => {
      const existingValues: any[] = [];
      const newTimeSeries = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
      ];
      const newWindow = { start: '1-Nov-24', end: '1-Nov-24' };
      
      const result = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        newWindow,
        'test-sig',
        {},
        'test-query',
        'amplitude',
        undefined,
        { 
          isCohortMode: true,
          latencySummary: {
            median_lag_days: 2.5,
            mean_lag_days: 3.1,
            completeness: 0.85,
            t95: 14.2
          }
        }
      );
      
      expect(result.length).toBe(1);
      expect(result[0].latency).toBeDefined();
      expect(result[0].latency.median_lag_days).toBe(2.5);
      expect(result[0].latency.mean_lag_days).toBe(3.1);
      expect(result[0].latency.completeness).toBe(0.85);
      expect(result[0].latency.t95).toBe(14.2);
    });

    it('should use window_from/window_to when isCohortMode is false (default)', () => {
      const existingValues: any[] = [];
      const newTimeSeries = [
        { date: '2024-11-01', n: 1000, k: 300, p: 0.3 },
      ];
      const newWindow = { start: '1-Nov-24', end: '1-Nov-24' };
      
      const result = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        newWindow,
        'test-sig'
        // No mergeOptions - defaults to window mode
      );
      
      expect(result.length).toBe(1);
      expect(result[0].cohort_from).toBeUndefined();
      expect(result[0].cohort_to).toBeUndefined();
      // Window dates should be set
      expect(result[0].window_from).toBe('1-Nov-24');
      expect(result[0].window_to).toBe('1-Nov-24');
    });

    it('should preserve existing values when adding new cohort data', () => {
      const existingValues = [
        {
          window_from: '1-Oct-24',
          window_to: '31-Oct-24',
          n_daily: [500, 600],
          k_daily: [150, 180],
          query_signature: 'existing-sig'
        }
      ];
      // Multiple dates to test proper cohort range
      const newTimeSeries = [
        { date: '2024-11-01', n: 500, k: 150, p: 0.3 },
        { date: '2024-11-15', n: 500, k: 150, p: 0.3 },
        { date: '2024-11-30', n: 500, k: 150, p: 0.3 },
      ];
      const newWindow = { start: '1-Nov-24', end: '30-Nov-24' };
      
      const result = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        newWindow,
        'new-sig',
        {},
        'test-query',
        'amplitude',
        undefined,
        { isCohortMode: true }
      );
      
      // Should have both existing and new values
      expect(result.length).toBe(2);
      expect(result[0].window_from).toBe('1-Oct-24'); // Existing value preserved
      // Cohort dates reflect actual data range
      expect(result[1].cohort_from).toBe('1-Nov-24'); // First date with data
      expect(result[1].cohort_to).toBe('30-Nov-24');  // Last date with data
    });
  });
});

