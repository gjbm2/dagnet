import { describe, expect, it } from 'vitest';
import type { GraphForPath, LAGHelpers, ParameterValueForLAG } from '../statisticalEnhancementService';
import { enhanceGraphLatencies, fitLagDistribution, logNormalCDF } from '../statisticalEnhancementService';

describe('Cohort path-anchored evidence de-biasing (right-censor correction)', () => {
  const queryDate = new Date('2025-12-16T00:00:00.000Z');

  const mockHelpers: LAGHelpers = {
    aggregateCohortData: (values: ParameterValueForLAG[], qd: Date, cohortWindow?: { start: Date; end: Date }) => {
      const startMs = cohortWindow ? cohortWindow.start.getTime() : undefined;
      const endMs = cohortWindow ? cohortWindow.end.getTime() : undefined;
      return values.flatMap((v) => {
        if (!v.dates) return [];
        return v.dates
          .map((date, i) => {
            const cohortMs = new Date(`${date}T00:00:00.000Z`).getTime();
            if (startMs !== undefined && cohortMs < startMs) return undefined;
            if (endMs !== undefined && cohortMs > endMs) return undefined;

            return {
              date,
              n: v.n_daily?.[i] ?? 0,
              k: v.k_daily?.[i] ?? 0,
              age: Math.floor((qd.getTime() - cohortMs) / (1000 * 60 * 60 * 24)),
              median_lag_days: v.median_lag_days?.[i],
              mean_lag_days: v.mean_lag_days?.[i],
              anchor_median_lag_days: v.anchor_median_lag_days?.[i],
              anchor_mean_lag_days: v.anchor_mean_lag_days?.[i],
            };
          })
          .filter(Boolean) as any[];
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

  it('adjusts evidence.mean mildly by completeness in cohort_path_anchored mode', () => {
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
    expect(edgeValue?.debug?.evidenceMeanBayesAdjusted).toBe(true);

    const completeness = edgeValue!.latency.completeness;
    const evidenceRaw = edgeValue!.debug!.evidenceMeanRaw!;
    const evidenceUsed = edgeValue!.debug!.evidenceMeanUsedForBlend!;
    const wEvidence = edgeValue!.debug!.wEvidence!;
    const forecastMean = edgeValue!.debug!.forecastMeanUsed!;

    // Evidence used for blend should be Bayesian completeness-adjusted and (for immature cohorts)
    // pushed upward vs raw k/n, while remaining bounded and continuous.
    expect(evidenceUsed).toBeGreaterThanOrEqual(evidenceRaw);
    expect(evidenceUsed).toBeLessThanOrEqual(1);

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
    expect(edgeValue.debug?.evidenceMeanBayesAdjusted).not.toBe(true);
    expect(edgeValue.debug?.evidenceMeanUsedForBlend).toBe(edgeValue.debug?.evidenceMeanRaw);
  });

  it('steady inputs yield steady blended mean across varying cohort completeness', () => {
    // We want a stable, predictable system invariant:
    // - With steady inputs (forecast.mean and evidence.mean both constant),
    //   the output p.mean should remain stable even as completeness varies with cohort recency.
    //
    // This specifically protects against "spurious drift" from dividing evidence by completeness
    // when evidence does not actually look like a censored observation.

    const asOf = new Date('2025-08-31T12:00:00.000Z');

    const graph: GraphForPath = {
      nodes: [
        { id: 'A', entry: { is_start: true } },
        { id: 'X' },
        { id: 'Y' },
      ],
      edges: [
        // Anchor edge (A→X): path anchoring is enabled by providing anchor arrays on X→Y,
        // so this edge does not need param values for this test.
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
            mean: 0.123, // will be overwritten by blend
            // NOTE: we set evidence.n/k per window below to emulate production (right-censored observed k).
            evidence: { mean: 0.25, n: 0, k: 0 },
            forecast: { mean: 0.25 }, // steady baseline
            latency: {
              latency_parameter: true,
              // Path t95 must exist to enable cohort_path_anchored completeness semantics downstream.
              path_t95: 40,
              path_t95_overridden: true,
              t95: 13.5,
              t95_overridden: true,
            } as any,
          },
        },
      ],
    };

    // Build steady daily cohorts spanning 1-Aug-25..31-Aug-25.
    // Evidence and lag stats are constant; only recency (age) changes across cohort windows.
    const dates: string[] = [];
    const nDaily: number[] = [];
    const kDaily: number[] = [];
    const lagMedian: number[] = [];
    const lagMean: number[] = [];
    const anchorMedian: number[] = [];
    const anchorMean: number[] = [];
    for (let d = 1; d <= 31; d += 1) {
      const dd = String(d).padStart(2, '0');
      dates.push(`2025-08-${dd}`);
      nDaily.push(100);
      kDaily.push(25);
      lagMedian.push(5);
      lagMean.push(6);
      // Fixed upstream anchor lag so path anchoring can compute effective age.
      anchorMedian.push(10);
      anchorMean.push(12);
    }

    const paramLookup = new Map<string, ParameterValueForLAG[]>([
      ['X-to-Y', [
        // Cohort slice: used to compute completeness and carries evidence arrays.
        {
          mean: 0,
          dates,
          n_daily: nDaily,
          k_daily: kDaily,
          median_lag_days: lagMedian,
          mean_lag_days: lagMean,
          anchor_median_lag_days: anchorMedian,
          anchor_mean_lag_days: anchorMean,
          sliceDSL: 'cohort(1-Aug-25:31-Aug-25)',
        } as any,
        // Window slice: backs the forecast baseline sample size for blending.
        {
          mean: 0.25,
          n: 10_000,
          k: 2_500,
          forecast: 0.25,
          sliceDSL: 'window(1-Aug-25:31-Aug-25)',
        } as any,
      ]],
    ]);

    const windows = [
      { start: new Date('2025-08-01T00:00:00.000Z'), end: new Date('2025-08-31T00:00:00.000Z') },
      { start: new Date('2025-08-10T00:00:00.000Z'), end: new Date('2025-08-31T00:00:00.000Z') },
      { start: new Date('2025-08-20T00:00:00.000Z'), end: new Date('2025-08-31T00:00:00.000Z') },
    ];

    const means: number[] = [];
    const completenesses: number[] = [];
    const wEvidence: number[] = [];

    const daysBetween = (a: Date, b: Date) => (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
    const fit = fitLagDistribution(5, 6);
    const mu = fit.mu;
    const sigma = fit.sigma;

    for (const w of windows) {
      const graphRun = structuredClone(graph);

      // Emulate production observed evidence for this cohort window:
      // right-censor conversions by as-of date using the fitted lag CDF and path anchoring.
      // Since the input is steady (k_daily=25, n_daily=100), the eventual rate is 0.25,
      // and observed k/n should fall below that for immature cohorts, with Bayes adjustment
      // pulling it back towards the baseline.
      const edge = graphRun.edges.find((e) => e.id === 'X-to-Y')!;
      let nObs = 0;
      let kObs = 0;
      for (let i = 0; i < dates.length; i += 1) {
        const d = new Date(`${dates[i]}T00:00:00.000Z`);
        const ms = d.getTime();
        if (ms < w.start.getTime() || ms > w.end.getTime()) continue;

        const age = Math.max(0, Math.floor(daysBetween(asOf, d)));
        const adjustedAge = Math.max(0, age - 10); // anchor_median_lag_days is constant 10 in this test
        const cdf = logNormalCDF(adjustedAge, mu, sigma);

        nObs += 100;
        kObs += 25 * cdf;
      }
      edge.p = {
        ...edge.p,
        evidence: { mean: nObs > 0 ? kObs / nObs : 0, n: nObs, k: kObs },
      };

      const result = enhanceGraphLatencies(graphRun, paramLookup, asOf, mockHelpers, w, undefined, undefined, 'cohort');
      const edgeValue = result.edgeValues.find((v) => v.edgeUuid === 'X-to-Y');
      expect(edgeValue).toBeDefined();
      expect(edgeValue?.debug?.completenessMode).toBe('cohort_path_anchored');
      // Under the current semantics, evidence.mean is Bayesian completeness-adjusted in
      // cohort_path_anchored mode.
      expect(edgeValue?.debug?.evidenceMeanBayesAdjusted).toBe(true);

      means.push(edgeValue!.blendedMean!);
      completenesses.push(edgeValue!.latency.completeness);
      wEvidence.push(edgeValue!.debug!.wEvidence!);
    }

    // Ensure this test is meaningful: completeness must vary across windows.
    const minC = Math.min(...completenesses);
    const maxC = Math.max(...completenesses);
    expect(maxC - minC).toBeGreaterThan(0.05);

    // Core invariant: steady inputs => broadly steady output p.mean.
    // Lock this in as an acceptance envelope: ±10% of target.
    const target = 0.25;
    const lo = target * 0.9;
    const hi = target * 1.1;
    for (const m of means) {
      expect(m).toBeGreaterThan(lo);
      expect(m).toBeLessThan(hi);
    }

    // Design intent: evidence weight grows deterministically with completeness.
    const pairs = windows.map((_, i) => ({ c: completenesses[i], w: wEvidence[i] }))
      .sort((a, b) => a.c - b.c);
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i].w).toBeGreaterThanOrEqual(pairs[i - 1].w);
    }
  });
});


