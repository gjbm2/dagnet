/**
 * Unit tests for the FE topo Step 1 §3.9 mirror-contract helpers in
 * modelVarsResolution.ts (doc 73b Stage 2 atom 5).
 *
 * - `momentMatchAnalyticBeta(mean, stdev)` returns `{ alpha, beta, n_effective }`
 *   when inputs yield a valid Beta; returns `{}` otherwise.
 * - `buildAnalyticProbabilityBlock(mean, stdev, opts)` returns the §3.9
 *   probability sub-block: always `{ mean, stdev }`, plus the moment-matched
 *   Beta shape and provenance label when valid.
 */

import { describe, it, expect } from 'vitest';
import {
  momentMatchAnalyticBeta,
  buildAnalyticProbabilityBlock,
} from '../modelVarsResolution';

describe('momentMatchAnalyticBeta', () => {
  it('returns valid Beta(α, β) shape from a feasible (mean, stdev)', () => {
    // Beta(20, 80): mean = 0.2, var = 0.2·0.8 / 101 = 0.001584...
    // stdev = sqrt(0.001584...) ≈ 0.0398
    // concentration = (0.16 / 0.001584) - 1 = 99
    const result = momentMatchAnalyticBeta(0.2, 0.0398);
    expect(result.alpha).toBeDefined();
    expect(result.beta).toBeDefined();
    expect(result.n_effective).toBeDefined();
    // n_effective = α + β ≈ 99 (Beta(α, β) recovers itself)
    expect(result.n_effective!).toBeGreaterThan(95);
    expect(result.n_effective!).toBeLessThan(105);
    expect(result.alpha! / (result.alpha! + result.beta!)).toBeCloseTo(0.2, 3);
  });

  it('rejects mean at the [0, 1] boundary', () => {
    expect(momentMatchAnalyticBeta(0, 0.05)).toEqual({});
    expect(momentMatchAnalyticBeta(1, 0.05)).toEqual({});
  });

  it('rejects non-positive stdev', () => {
    expect(momentMatchAnalyticBeta(0.4, 0)).toEqual({});
    expect(momentMatchAnalyticBeta(0.4, -0.01)).toEqual({});
  });

  it('rejects non-finite inputs', () => {
    expect(momentMatchAnalyticBeta(NaN, 0.05)).toEqual({});
    expect(momentMatchAnalyticBeta(0.4, Infinity)).toEqual({});
  });

  it('rejects variance exceeding the Beta-feasible upper bound', () => {
    // mean·(1-mean) at mean=0.5 is 0.25 → stdev_max = 0.5
    // stdev = 0.5 means variance = 0.25 (degenerate concentration = 0)
    expect(momentMatchAnalyticBeta(0.5, 0.5)).toEqual({});
    expect(momentMatchAnalyticBeta(0.5, 0.6)).toEqual({});
  });
});

describe('buildAnalyticProbabilityBlock', () => {
  it('always returns mean and stdev; adds Beta shape when valid', () => {
    const block = buildAnalyticProbabilityBlock(0.2, 0.04);
    expect(block.mean).toBe(0.2);
    expect(block.stdev).toBe(0.04);
    expect(block.alpha).toBeDefined();
    expect(block.beta).toBeDefined();
    expect(block.n_effective).toBeDefined();
    expect(block.provenance).toBe('analytic_window_baseline');
  });

  it('omits Beta shape and provenance when stdev is invalid', () => {
    const block = buildAnalyticProbabilityBlock(0.5, 0);
    expect(block.mean).toBe(0.5);
    expect(block.stdev).toBe(0);
    expect(block.alpha).toBeUndefined();
    expect(block.beta).toBeUndefined();
    expect(block.n_effective).toBeUndefined();
    expect(block.provenance).toBeUndefined();
  });

  it('honours an explicit n_effective override when caller has source mass', () => {
    const block = buildAnalyticProbabilityBlock(0.3, 0.05, {
      n_effective: 500,
      provenance: 'analytic_mature_window_degraded',
    });
    expect(block.n_effective).toBe(500);
    expect(block.provenance).toBe('analytic_mature_window_degraded');
    expect(block.alpha).toBeDefined();
    expect(block.beta).toBeDefined();
  });

  it('does not touch evidence — same (mean, stdev) yields same shape regardless of caller-side context', () => {
    // §3.3.3 layer-isolation invariant: the analytic source-layer
    // shape is computed from aggregate (mean, stdev) only. The
    // current-answer p.evidence.{n, k} is not consulted here.
    const a = buildAnalyticProbabilityBlock(0.25, 0.05);
    const b = buildAnalyticProbabilityBlock(0.25, 0.05);
    expect(a).toEqual(b);
  });
});
