/**
 * WindowAggregationService Unit Tests
 * 
 * Tests aggregation of daily time-series data into aggregate statistics.
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  windowAggregationService,
  parameterToTimeSeries,
} from '../windowAggregationService';
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

      expect(result.window.start).toBe('2024-11-01');
      expect(result.window.end).toBe('2024-11-02');
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
});

