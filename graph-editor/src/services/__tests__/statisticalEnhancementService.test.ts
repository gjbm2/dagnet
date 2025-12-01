/**
 * StatisticalEnhancementService Unit Tests
 * 
 * Tests the statistical enhancement service (currently NoOp pass-through).
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import {
  statisticalEnhancementService,
  NoOpEnhancer,
} from '../statisticalEnhancementService';
import type { RawAggregation } from '../windowAggregationService';
import type { DateRange } from '../../types';

describe('StatisticalEnhancementService', () => {
  const createMockRawAggregation = (
    n: number = 1000,
    k: number = 300
  ): RawAggregation => ({
    method: 'naive',
    n,
    k,
    mean: k / n,
    stdev: Math.sqrt((k / n) * (1 - k / n) / n),
    raw_data: [],
    window: { start: '2024-11-01', end: '2024-11-07' } as DateRange,
    days_included: 7,
    days_missing: 0,
    missing_dates: [],
    gaps: [],
    missing_at_start: false,
    missing_at_end: false,
    has_middle_gaps: false,
  });

  describe('NoOpEnhancer', () => {
    it('should pass through raw aggregation unchanged', () => {
      const enhancer = new NoOpEnhancer();
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = enhancer.enhance(raw);

      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.stdev).toBeCloseTo(raw.stdev, 5);
      expect(result.confidence_interval).toBeNull();
      expect(result.trend).toBeNull();
      expect(result.metadata.raw_method).toBe('naive');
      expect(result.metadata.enhancement_method).toBe('none');
      expect(result.metadata.data_points).toBe(7);
    });

    it('should preserve all raw values exactly', () => {
      const enhancer = new NoOpEnhancer();
      const raw: RawAggregation = {
        method: 'naive',
        n: 5000,
        k: 1750,
        mean: 0.35,
        stdev: 0.0067,
        raw_data: [
          { date: '2024-11-01', n: 1000, k: 350, p: 0.35 },
          { date: '2024-11-02', n: 1000, k: 350, p: 0.35 },
        ],
        window: { start: '2024-11-01', end: '2024-11-02' } as DateRange,
        days_included: 2,
        days_missing: 0,
        missing_dates: [],
        gaps: [],
        missing_at_start: false,
        missing_at_end: false,
        has_middle_gaps: false,
      };

      const result = enhancer.enhance(raw);

      expect(result.n).toBe(5000);
      expect(result.k).toBe(1750);
      expect(result.mean).toBe(0.35);
      expect(result.stdev).toBe(0.0067);
    });
  });

  describe('StatisticalEnhancementService', () => {
    it('should enhance with default "inverse-variance" method', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.method).toBe('inverse-variance');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.metadata.enhancement_method).toBe('inverse-variance');
    });

    it('should enhance with explicit "none" method', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = await statisticalEnhancementService.enhance(raw, 'none');

      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.metadata.enhancement_method).toBe('none');
    });

    it('should fallback to "none" for unknown method (non-Python)', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Use a method that doesn't exist and isn't a Python method
      const result = await statisticalEnhancementService.enhance(raw, 'unknown-method' as any);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown enhancement method: unknown-method')
      );
      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.metadata.enhancement_method).toBe('none');

      consoleSpy.mockRestore();
    });

    it('should register and use custom enhancer', async () => {
      const customEnhancer = {
        enhance(raw: RawAggregation) {
          return {
            method: 'custom',
            n: raw.n,
            k: raw.k,
            mean: raw.mean,
            stdev: raw.stdev,
            confidence_interval: [0.25, 0.35] as [number, number],
            trend: null,
            metadata: {
              raw_method: raw.method,
              enhancement_method: 'custom',
              data_points: raw.days_included,
            },
          };
        },
      };

      statisticalEnhancementService.registerEnhancer('custom', customEnhancer);

      const raw: RawAggregation = createMockRawAggregation(1000, 300);
      const result = await statisticalEnhancementService.enhance(raw, 'custom');

      expect(result.method).toBe('custom');
      expect(result.confidence_interval).toEqual([0.25, 0.35]);
      expect(result.metadata.enhancement_method).toBe('custom');
    });

    it('should handle edge case: zero conversions', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 0);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.n).toBe(1000);
      expect(result.k).toBe(0);
      expect(result.mean).toBe(0);
      expect(result.stdev).toBe(0);
    });

    it('should handle edge case: perfect conversion rate', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 1000);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.n).toBe(1000);
      expect(result.k).toBe(1000);
      expect(result.mean).toBe(1);
      expect(result.stdev).toBe(0);
    });

    it('should preserve days_included in metadata', async () => {
      const raw: RawAggregation = {
        method: 'naive',
        n: 5000,
        k: 1500,
        mean: 0.3,
        stdev: 0.0065,
        raw_data: [],
        window: { start: '2024-11-01', end: '2024-11-10' } as DateRange,
        days_included: 10,
        days_missing: 0,
        missing_dates: [],
        gaps: [],
        missing_at_start: false,
        missing_at_end: false,
        has_middle_gaps: false,
      };

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.metadata.data_points).toBe(10);
    });

    it('should use simple mean (k/n) and preserve k as actual observed count', async () => {
      // This test validates two critical fixes:
      // 1. k must be preserved as the actual observed success count, not derived from any estimate
      // 2. mean must be the simple mean (k/n), not a weighted mean that can be distorted
      //
      // Background: Inverse-variance weighting was causing issues because:
      // - Days with p=0 (weekends, data lag) aren't "estimates of 0%" - they're outliers
      // - These days got massive weight: n/0.01 = 100×n when p=0
      // - This distorted the weighted mean (e.g., actual 56% → weighted 16%)
      //
      // FIX: Use simple mean (k/n) which is the CORRECT observed conversion rate
      const raw: RawAggregation = {
        method: 'naive',
        n: 645,
        k: 361,
        mean: 361 / 645, // 0.5596...
        stdev: Math.sqrt((361/645) * (1 - 361/645) / 645),
        raw_data: [
          // High volume days with LOW conversion (would have dominated weighted average)
          { date: '2024-11-01', n: 83, k: 0, p: 0 },
          { date: '2024-11-02', n: 52, k: 40, p: 0.769 },
          { date: '2024-11-03', n: 47, k: 35, p: 0.745 },
          { date: '2024-11-04', n: 41, k: 33, p: 0.805 },
          { date: '2024-11-05', n: 40, k: 27, p: 0.675 },
          { date: '2024-11-06', n: 38, k: 4, p: 0.105 },  // Low conversion
          { date: '2024-11-07', n: 36, k: 28, p: 0.778 },
          { date: '2024-11-08', n: 33, k: 25, p: 0.758 },
          { date: '2024-11-09', n: 32, k: 30, p: 0.938 },
          { date: '2024-11-10', n: 32, k: 15, p: 0.469 },
          // More days...
          { date: '2024-11-11', n: 28, k: 0, p: 0 },
          { date: '2024-11-12', n: 25, k: 18, p: 0.72 },
          { date: '2024-11-13', n: 25, k: 17, p: 0.68 },
          { date: '2024-11-14', n: 23, k: 22, p: 0.957 },
          { date: '2024-11-15', n: 22, k: 16, p: 0.727 },
          { date: '2024-11-16', n: 20, k: 16, p: 0.8 },
          { date: '2024-11-17', n: 19, k: 13, p: 0.684 },
          { date: '2024-11-18', n: 18, k: 0, p: 0 },
          { date: '2024-11-19', n: 17, k: 11, p: 0.647 },
          { date: '2024-11-20', n: 14, k: 11, p: 0.786 },
        ],
        window: { start: '2024-11-01', end: '2024-11-20' } as DateRange,
        days_included: 20,
        days_missing: 0,
        missing_dates: [],
        gaps: [],
        missing_at_start: false,
        missing_at_end: false,
        has_middle_gaps: false,
      };

      const result = await statisticalEnhancementService.enhance(raw);

      // CRITICAL: k must be the actual observed count (361), NOT derived from any estimate
      expect(result.k).toBe(361);
      expect(result.n).toBe(645);
      
      // CRITICAL: mean must be the simple mean (k/n), NOT a weighted mean
      // Simple mean: 361/645 = 0.5596... ≈ 0.56 (rounded to 3 decimal places)
      expect(result.mean).toBeCloseTo(0.56, 2);
      
      // Verify k was NOT recalculated from mean (k should equal mean * n since mean = k/n)
      expect(result.k).toBe(Math.round(result.mean * result.n));
    });
  });
});

