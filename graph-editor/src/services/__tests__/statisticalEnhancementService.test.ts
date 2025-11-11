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
    it('should enhance with default "none" method (pass-through)', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.metadata.enhancement_method).toBe('none');
    });

    it('should enhance with explicit "none" method', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = await statisticalEnhancementService.enhance(raw, 'none');

      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.metadata.enhancement_method).toBe('none');
    });

    it('should fallback to "none" for unknown method', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await statisticalEnhancementService.enhance(raw, 'bayesian');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown enhancement method: bayesian')
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
  });
});

