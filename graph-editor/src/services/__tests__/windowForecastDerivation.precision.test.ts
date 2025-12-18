/**
 * Precision test: window() forecast baseline derivation (p∞)
 *
 * First-principles expectation:
 * - If recency weighting is removed (half-life = ∞), then all mature days are equally weighted.
 * - Therefore forecast = Σk_mature / Σn_mature, where "mature" excludes the last ceil(t95)+1 days.
 *
 * This test validates that our window-forecast recomputation implements that precisely.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';

// IMPORTANT: Mock must run before importing the module under test.
vi.mock('../../constants/latency', async () => {
  const actual = await vi.importActual<any>('../../constants/latency');
  return {
    ...actual,
    // Remove recency adjustments: w_i = exp(-ln2 * age / ∞) = 1
    RECENCY_HALF_LIFE_DAYS: Number.POSITIVE_INFINITY,
  };
});

import { mergeTimeSeriesIntoParameter, parseDate } from '../windowAggregationService';

function ukDate(d: Date): string {
  // d-MMM-yy (UK), as required across DagNet
  const dd = String(d.getUTCDate());
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mmm = months[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}-${mmm}-${yy}`;
}

describe('window() forecast derivation (precision)', () => {
  it('with half-life=∞, forecast equals Σk/Σn over mature days (excludes last ceil(t95)+1 days)', async () => {
    // Build 120 daily points ending at 30-Nov-25 (inclusive).
    // With t95=30, maturityDays = 31 → exclude the last 31 days (i.e. 31 most recent dates).
    const end = new Date(Date.UTC(2025, 10, 30)); // 30-Nov-25
    const days = 120;
    const points: Array<{ date: string; n: number; k: number; p: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setUTCDate(d.getUTCDate() - i);

      // Make mature region deliberately different from immature tail so the exclusion is observable.
      // - Mature days: p=0.20 (k=20, n=100)
      // - Immature tail (excluded): p=0.90 (k=90, n=100)
      const isInLast31Days = i < 31;
      const n = 100;
      const k = isInLast31Days ? 90 : 20;
      points.push({ date: ukDate(d), n, k, p: k / n });
    }

    const out = mergeTimeSeriesIntoParameter(
      [],
      points as any,
      { start: points[0].date, end: points[points.length - 1].date } as any,
      'sig',
      undefined,
      undefined,
      'amplitude',
      '',
      {
        isCohortMode: false,
        recomputeForecast: true,
        latencyConfig: { latency_parameter: true, t95: 30 },
      }
    );

    expect(out).toHaveLength(1);
    const v: any = out[0];
    expect(v.sliceDSL).toBe(`window(${points[0].date}:${points[points.length - 1].date})`);
    expect(Array.isArray(v.dates)).toBe(true);
    expect(Array.isArray(v.n_daily)).toBe(true);
    expect(Array.isArray(v.k_daily)).toBe(true);
    expect(typeof v.forecast).toBe('number');

    // Compute expected mature-only Σk/Σn with the SAME maturity cutoff rule.
    const maturityDays = 31; // ceil(30)+1
    const asOf = parseDate(points[points.length - 1].date);
    const cutoffMs = asOf.getTime() - maturityDays * 24 * 60 * 60 * 1000;

    let sumN = 0;
    let sumK = 0;
    for (let i = 0; i < points.length; i++) {
      const d = parseDate(points[i].date);
      if (d.getTime() > cutoffMs) continue; // excluded immature tail
      sumN += points[i].n;
      sumK += points[i].k;
    }

    expect(sumN).toBeGreaterThan(0);
    const expected = sumK / sumN;

    // With half-life=∞, weights are exactly 1, so this should match extremely tightly.
    expect(v.forecast).toBeCloseTo(expected, 14);
    // And it should equal the mature conversion rate (0.20) for this fixture.
    expect(v.forecast).toBeCloseTo(0.2, 14);
  });
});


