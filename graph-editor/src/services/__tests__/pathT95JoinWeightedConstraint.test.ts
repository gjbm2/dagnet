import { describe, expect, it } from 'vitest';

import { enhanceGraphLatencies } from '../statisticalEnhancementService';
import type { GraphForPath, ParameterValueForLAG, LAGHelpers } from '../statisticalEnhancementService';
import { aggregateCohortData, aggregateLatencyStats, aggregateWindowData } from '../windowAggregationService';

describe('path_t95 join-aware constraint uses percentile horizons (not medians) and can be weighted', () => {
  const helpers: LAGHelpers = {
    aggregateCohortData,
    aggregateWindowData,
    aggregateLatencyStats,
  };

  it('does not treat inbound path_t95 as a median; it only pulls the A→X tail (one-way) and never shrinks below topo fallback', () => {
    // Graph: A (start) → X via two inbound edges with different masses and horizons; then X → Y.
    // The long inbound is light-mass; we still want to use it as a *tail* constraint (percentile),
    // not as a central tendency, and we must not allow anchor-moment bias to shrink horizons.
    const graph: GraphForPath = {
      nodes: [
        { id: 'A', entry: { is_start: true } },
        { id: 'U' },
        { id: 'V' },
        { id: 'X' },
        { id: 'Y' },
      ],
      edges: [
        // Connect start node so U/V paths are reachable.
        // NOTE: we deliberately set different upstream branch probabilities so the correct
        // join weights must be based on *topo flow mass* (product from start), not the
        // proximate inbound edge p.mean.
        { id: 'A-U', from: 'A', to: 'U', p: { mean: 0.01 } },
        { id: 'A-V', from: 'A', to: 'V', p: { mean: 0.99 } },
        // Inbound 1: local p.mean is high (misleading), but upstream branch is tiny => low arriving mass.
        { id: 'U-X', from: 'U', to: 'X', p: { mean: 0.8, latency: { latency_parameter: true, t95: 31, t95_overridden: true } } },
        // Inbound 2: local p.mean is lower, but upstream branch is huge => high arriving mass.
        { id: 'V-X', from: 'V', to: 'X', p: { mean: 0.4, latency: { latency_parameter: true, t95: 16, t95_overridden: true } } },
        // Downstream edge
        { id: 'X-Y', from: 'X', to: 'Y', p: { mean: 0.5, latency: { latency_parameter: true } } },
      ],
    };

    const dates: string[] = [];
    const nDaily: number[] = [];
    const kDaily: number[] = [];
    const medLag: number[] = [];
    const meanLag: number[] = [];
    const anchorMedianLag: number[] = [];
    const anchorMeanLag: number[] = [];
    for (let d = 1; d <= 16; d += 1) {
      const dd = String(d).padStart(2, '0');
      dates.push(`2025-07-${dd}`);
      nDaily.push(100);
      kDaily.push(25);
      medLag.push(5);
      meanLag.push(5.5);
      // Biased-fast anchor moments (immature case): pretend A→X median is only ~5d.
      anchorMedianLag.push(5);
      anchorMeanLag.push(5.5);
    }

    const xyCohort: ParameterValueForLAG = {
      sliceDSL: 'cohort(1-Jul-25:16-Jul-25)',
      dates,
      n_daily: nDaily,
      k_daily: kDaily,
      median_lag_days: medLag,
      mean_lag_days: meanLag,
      anchor_n_daily: nDaily,
      anchor_median_lag_days: anchorMedianLag,
      anchor_mean_lag_days: anchorMeanLag,
    } as any;

    const paramLookup = new Map<string, ParameterValueForLAG[]>();
    // Minimal upstream cohort slices so the topo pass computes and propagates their t95 (even though
    // their t95 is overridden on the graph).
    const uxCohort: ParameterValueForLAG = {
      sliceDSL: 'cohort(1-Jul-25:16-Jul-25)',
      dates,
      n_daily: nDaily,
      k_daily: kDaily,
      median_lag_days: medLag,
      mean_lag_days: meanLag,
    } as any;
    const vxCohort: ParameterValueForLAG = structuredClone(uxCohort);
    paramLookup.set('U-X', [uxCohort]);
    paramLookup.set('V-X', [vxCohort]);
    paramLookup.set('X-Y', [xyCohort]);

    const queryDate = new Date('2025-08-31T12:00:00.000Z');
    const cohortWindow = { start: new Date('2025-07-01T00:00:00.000Z'), end: new Date('2025-07-16T00:00:00.000Z') };

    const result = enhanceGraphLatencies(graph, paramLookup, queryDate, helpers, cohortWindow, undefined, undefined, 'cohort');
    const xy = result.edgeValues.find((v) => v.edgeUuid === 'X-Y');
    expect(xy).toBeDefined();
    // The key properties:
    // - path_t95 must not collapse to the biased-fast anchor moments (immaturity protection)
    // - join weighting must be based on arriving mass (topo flow product), so the tiny-mass long
    //   branch must NOT dominate the 95th percentile horizon at X.
    //
    // Therefore, path_t95 should remain "moderately large" (above ~20) but not explode to the
    // max-branch + edge t95 (~40+), which would happen if we treated local p.mean as the weight.
    expect(xy!.latency.path_t95).toBeGreaterThan(20);
    expect(xy!.latency.path_t95).toBeLessThan(35);
  });
});


