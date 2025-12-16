import { describe, expect, it } from 'vitest';
import type { GraphForPath, LAGHelpers, ParameterValueForLAG } from '../statisticalEnhancementService';
import { enhanceGraphLatencies } from '../statisticalEnhancementService';

describe('Cohort path-anchored evidence de-biasing (right-censor correction)', () => {
  const queryDate = new Date('2025-12-16T00:00:00.000Z');

  const mockHelpers: LAGHelpers = {
    aggregateCohortData: (values: ParameterValueForLAG[], qd: Date) => {
      return values.flatMap((v) => {
        if (!v.dates) return [];
        return v.dates.map((date, i) => ({
          date,
          n: v.n_daily?.[i] ?? 0,
          k: v.k_daily?.[i] ?? 0,
          age: Math.floor((qd.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)),
          median_lag_days: v.median_lag_days?.[i],
          mean_lag_days: v.mean_lag_days?.[i],
          anchor_median_lag_days: v.anchor_median_lag_days?.[i],
          anchor_mean_lag_days: v.anchor_mean_lag_days?.[i],
        }));
      });
    },
    aggregateLatencyStats: (cohorts) => {
      const withLag = cohorts.filter((c) => typeof c.median_lag_days === 'number' && c.median_lag_days > 0);
      if (withLag.length === 0) return undefined;
      const totalK = withLag.reduce((sum, c) => sum + c.k, 0);
      const weightedMedian = withLag.reduce((sum, c) => sum + c.k * (c.median_lag_days ?? 0), 0);
      const weightedMean = withLag.reduce((sum, c) => sum + c.k * (c.mean_lag_days ?? c.median_lag_days ?? 0), 0);
      return {
        median_lag_days: totalK > 0 ? weightedMedian / totalK : 0,
        mean_lag_days: totalK > 0 ? weightedMean / totalK : 0,
      };
    },
  };

  it('de-biases evidenceMean for blending in cohort_path_anchored mode', () => {
    const graph: GraphForPath = {
      nodes: [
        { id: 'A', entry: { is_start: true } },
        { id: 'X' },
        { id: 'Y' },
      ],
      edges: [
        {
          id: 'A-to-X',
          from: 'A',
          to: 'X',
          p: { mean: 0.5, latency: { latency_parameter: true, t95: 20 } },
        },
        {
          id: 'X-to-Y',
          from: 'X',
          to: 'Y',
          p: {
            mean: 0.8,
            evidence: { mean: 0.344, n: 302, k: 104 },
            forecast: { mean: 0.797 },
            latency: {
              latency_parameter: true,
              t95: 13.12,
              path_t95: 40,
              path_t95_overridden: true,
            } as any,
          },
        },
      ],
    };

    const dates = ['2025-11-16', '2025-11-26', '2025-12-06']; // ages 30, 20, 10 days

    const paramLookup = new Map<string, ParameterValueForLAG[]>([
      ['X-to-Y', [{
        mean: 0,
        dates,
        n_daily: [120, 100, 82],
        k_daily: [40, 35, 29], // totalK = 104 (enough for fit)
        median_lag_days: [6.4, 6.4, 6.4],
        mean_lag_days: [6.8, 6.8, 6.8],
        // A→X cumulative lag (anchor to edge source) – enables cohort_path_anchored completeness
        anchor_median_lag_days: [12, 12, 12],
        anchor_mean_lag_days: [14, 14, 14],
      }]],
    ]);

    const result = enhanceGraphLatencies(graph, paramLookup, queryDate, mockHelpers);
    const edgeValue = result.edgeValues.find((v) => v.edgeUuid === 'X-to-Y');
    expect(edgeValue).toBeDefined();
    expect(edgeValue?.debug?.completenessMode).toBe('cohort_path_anchored');
    expect(edgeValue?.debug?.evidenceMeanDebiasedByCompleteness).toBe(true);

    const completeness = edgeValue!.latency.completeness;
    const evidenceRaw = edgeValue!.debug!.evidenceMeanRaw!;
    const evidenceUsed = edgeValue!.debug!.evidenceMeanUsedForBlend!;
    const wEvidence = edgeValue!.debug!.wEvidence!;
    const forecastMean = edgeValue!.debug!.forecastMeanUsed!;

    // Evidence used for blend should be approximately (k/n)/completeness (capped to 1).
    expect(evidenceUsed).toBeGreaterThan(evidenceRaw);
    expect(evidenceUsed).toBeCloseTo(Math.min(1, evidenceRaw / completeness), 3);

    // Blended mean should reflect evidenceUsed (not evidenceRaw).
    const blended = edgeValue!.blendedMean!;
    const blendedUsingRaw = wEvidence * evidenceRaw + (1 - wEvidence) * forecastMean;
    const blendedUsingUsed = wEvidence * evidenceUsed + (1 - wEvidence) * forecastMean;
    expect(blended).toBeCloseTo(blendedUsingUsed, 6);
    expect(blended).toBeGreaterThan(blendedUsingRaw);
  });

  it('does not de-bias evidenceMean in window mode', () => {
    const graph: GraphForPath = {
      nodes: [{ id: 'start', entry: { is_start: true } }, { id: 'end' }],
      edges: [
        {
          id: 'start-to-end',
          from: 'start',
          to: 'end',
          p: {
            mean: 0.5,
            evidence: { mean: 0.2, n: 1000, k: 200 },
            forecast: { mean: 0.6 },
            latency: { latency_parameter: true, t95: 30 },
          },
        },
      ],
    };

    const dates = ['2025-12-15']; // age 1 day
    const paramLookup = new Map<string, ParameterValueForLAG[]>([
      ['start-to-end', [{
        mean: 0,
        dates,
        n_daily: [1000],
        k_daily: [200],
        median_lag_days: [10],
        mean_lag_days: [12],
        // Even if anchor arrays existed, window mode must not apply cohort de-biasing.
        anchor_median_lag_days: [5],
        anchor_mean_lag_days: [6],
      }]],
    ]);

    const result = enhanceGraphLatencies(graph, paramLookup, queryDate, mockHelpers, undefined, undefined, undefined, 'window');
    const edgeValue = result.edgeValues[0];
    expect(edgeValue.debug?.completenessMode).toBe('window_edge');
    expect(edgeValue.debug?.evidenceMeanDebiasedByCompleteness).not.toBe(true);
    expect(edgeValue.debug?.evidenceMeanUsedForBlend).toBe(edgeValue.debug?.evidenceMeanRaw);
  });
});


