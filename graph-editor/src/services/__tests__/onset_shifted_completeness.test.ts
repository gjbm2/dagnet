/**
 * Onset Delta Days - Shifted Completeness Tests
 * 
 * Tests for completeness calculation with onset shift (dead-time before conversions begin).
 * 
 * DESIGN (from implementation-plan.md §0.3.6 K):
 * When onset_delta_days > 0, completeness should be calculated using shifted age:
 * - If age < onset: completeness = 0 (dead-time period)
 * - If age >= onset: completeness = LogNormalCDF(age - onset, μ, σ)
 * 
 * IMPLEMENTATION STATUS: ✅ COMPLETE (3-Feb-26)
 * The calculateCompleteness function now accepts an optional onsetDeltaDays parameter.
 * 
 * Test Case Matrix:
 * | Test ID   | age | onset | μ   | σ   | Expected completeness    | Notes                    |
 * |-----------|-----|-------|-----|-----|--------------------------|--------------------------|
 * | COMP-001  | 5   | 0     | 2.0 | 0.5 | LogNormalCDF(5)          | No shift                 |
 * | COMP-002  | 3   | 5     | 2.0 | 0.5 | 0                        | age < onset → dead-time  |
 * | COMP-003  | 5   | 5     | 2.0 | 0.5 | 0                        | age = onset → boundary   |
 * | COMP-004  | 7   | 5     | 2.0 | 0.5 | LogNormalCDF(2)          | shifted age = 7-5 = 2    |
 * | COMP-005  | 10  | 3     | 2.0 | 0.5 | LogNormalCDF(7)          | shifted age = 10-3 = 7   |
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  logNormalCDF,
  calculateCompleteness,
  type CohortData,
} from '../statisticalEnhancementService';

describe('onset_delta_days Shifted Completeness', () => {
  // Helper to create cohort data for a single cohort
  const createSingleCohort = (age: number, n: number = 100): CohortData[] => [
    { date: '2025-01-01', age, n, k: Math.round(n * 0.5) },
  ];

  // Standard test parameters
  const MU = 2.0;
  const SIGMA = 0.5;

  describe('Reference: LogNormalCDF calculations (for verification)', () => {
    it('should compute LogNormalCDF correctly for various ages', () => {
      // These are reference values to verify the test assertions below
      expect(logNormalCDF(5, MU, SIGMA)).toBeGreaterThan(0);
      expect(logNormalCDF(5, MU, SIGMA)).toBeLessThan(1);
      expect(logNormalCDF(2, MU, SIGMA)).toBeGreaterThan(0);
      expect(logNormalCDF(7, MU, SIGMA)).toBeGreaterThan(logNormalCDF(5, MU, SIGMA));
    });
  });

  describe('COMP-001: No shift (onset = 0)', () => {
    it('should calculate completeness using raw age when onset is 0', () => {
      const cohorts = createSingleCohort(5);
      const completeness = calculateCompleteness(cohorts, MU, SIGMA);
      
      // Expected: LogNormalCDF(5, 2.0, 0.5)
      const expected = logNormalCDF(5, MU, SIGMA);
      expect(completeness).toBeCloseTo(expected, 5);
    });
  });

  describe('COMP-002: Dead-time (age < onset)', () => {
    it('should return completeness = 0 when age < onset (dead-time period)', () => {
      // age=3, onset=5 → effectiveAge = 0 → completeness = 0
      const cohorts = createSingleCohort(3);
      const onset = 5;
      const completeness = calculateCompleteness(cohorts, MU, SIGMA, onset);
      expect(completeness).toBe(0);
    });
  });

  describe('COMP-003: Boundary (age = onset)', () => {
    it('should return completeness = 0 at the boundary when age equals onset', () => {
      // age=5, onset=5 → effectiveAge = 0 → completeness = LogNormalCDF(0) ≈ 0
      const cohorts = createSingleCohort(5);
      const onset = 5;
      const completeness = calculateCompleteness(cohorts, MU, SIGMA, onset);
      expect(completeness).toBeCloseTo(0, 5);
    });
  });

  describe('COMP-004: Shifted age (age > onset)', () => {
    it('should calculate completeness using shifted age when age > onset', () => {
      // age=7, onset=5 → effectiveAge = 2 → completeness = LogNormalCDF(2, 2.0, 0.5)
      const cohorts = createSingleCohort(7);
      const onset = 5;
      const completeness = calculateCompleteness(cohorts, MU, SIGMA, onset);
      const expected = logNormalCDF(2, MU, SIGMA);
      expect(completeness).toBeCloseTo(expected, 5);
    });
  });

  describe('COMP-005: Larger shift', () => {
    it('should correctly shift larger age values', () => {
      // age=10, onset=3 → effectiveAge = 7 → completeness = LogNormalCDF(7, 2.0, 0.5)
      const cohorts = createSingleCohort(10);
      const onset = 3;
      const completeness = calculateCompleteness(cohorts, MU, SIGMA, onset);
      const expected = logNormalCDF(7, MU, SIGMA);
      expect(completeness).toBeCloseTo(expected, 5);
    });
  });

  describe('Backwards compatibility (onset omitted)', () => {
    it('should calculate completeness without shift when onset is not provided', () => {
      // When onset is omitted, behaviour should match onset=0
      const cohorts = createSingleCohort(7);
      const completeness = calculateCompleteness(cohorts, MU, SIGMA);
      
      // Uses raw age (7), no shift
      const expected = logNormalCDF(7, MU, SIGMA);
      expect(completeness).toBeCloseTo(expected, 5);
    });
  });
});
