import { describe, expect, it } from 'vitest';

import { enhanceGraphLatencies } from '../statisticalEnhancementService';
import type { GraphForPath, ParameterValueForLAG, LAGHelpers } from '../statisticalEnhancementService';
import { aggregateCohortData, aggregateLatencyStats, aggregateWindowData } from '../windowAggregationService';

describe('path_t95 completeness constraint (cohort_path_anchored)', () => {
  const helpers: LAGHelpers = {
    aggregateCohortData,
    aggregateWindowData,
    aggregateLatencyStats,
  };

  it('does not let pre-pass DEFAULT_T95-derived path_t95 dominate completeness; uses stored or in-pass edgePathT95 instead', () => {
    // Graph: A → B → C, both edges latency-enabled but with no pre-set t95.
    // This is the key setup that previously caused computePathT95(...) to default to 30d per hop
    // and leak into completeness via edgePrecomputedPathT95.
    const graph: GraphForPath = {
      nodes: [
        { id: 'A', entry: { is_start: true } },
        { id: 'B' },
        { id: 'C' },
      ],
      edges: [
        { id: 'A-B', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true } } },
        { id: 'B-C', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true } } },
      ],
    };

    // Cohort window: 1-Jul-25..16-Jul-25, as-of 31-Aug-25.
    // Use stable lags: median=5, mean=5.5, and constant n/k so fits are quality-ok.
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
      // Downstream edge carries anchor arrays (A→B) so path anchoring is enabled.
      anchorMedianLag.push(5);
      anchorMeanLag.push(5.5);
    }

    const abCohort: ParameterValueForLAG = {
      sliceDSL: 'cohort(1-Jul-25:16-Jul-25)',
      dates,
      n_daily: nDaily,
      k_daily: kDaily,
      median_lag_days: medLag,
      mean_lag_days: meanLag,
    } as any;

    const bcCohort: ParameterValueForLAG = {
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
    paramLookup.set('A-B', [abCohort]);
    paramLookup.set('B-C', [bcCohort]);

    const queryDate = new Date('2025-08-31T12:00:00.000Z');
    const cohortWindow = { start: new Date('2025-07-01T00:00:00.000Z'), end: new Date('2025-07-16T00:00:00.000Z') };

    // Run with no stored path_t95 on B-C: completeness should use the in-pass edgePathT95 (~17–21d),
    // NOT a pre-pass 60d (DEFAULT_T95 per hop).
    const result = enhanceGraphLatencies(graph, paramLookup, queryDate, helpers, cohortWindow, undefined, undefined, 'cohort');
    const bc = result.edgeValues.find((v) => v.edgeUuid === 'B-C');
    expect(bc).toBeDefined();
    expect(bc?.debug?.completenessMode).toBe('cohort_path_anchored');
    expect(typeof bc?.debug?.completenessAuthoritativeT95Days).toBe('number');
    // This is the key regression assertion: it must not silently become 60 (30d per hop).
    expect(bc!.debug!.completenessAuthoritativeT95Days!).toBeLessThan(40);

    // Now set an explicit stored path_t95 on B-C and confirm it dominates.
    const graphWithOverride: GraphForPath = structuredClone(graph);
    const bcEdge = graphWithOverride.edges.find((e) => e.id === 'B-C') as any;
    bcEdge.p = bcEdge.p ?? {};
    bcEdge.p.latency = bcEdge.p.latency ?? {};
    bcEdge.p.latency.path_t95 = 60;
    bcEdge.p.latency.path_t95_overridden = true;

    const resultOverride = enhanceGraphLatencies(
      graphWithOverride,
      paramLookup,
      queryDate,
      helpers,
      cohortWindow,
      undefined,
      undefined,
      'cohort'
    );
    const bcOverride = resultOverride.edgeValues.find((v) => v.edgeUuid === 'B-C');
    expect(bcOverride).toBeDefined();
    expect(bcOverride?.debug?.completenessMode).toBe('cohort_path_anchored');
    expect(bcOverride!.debug!.completenessAuthoritativeT95Days).toBe(60);
    expect(bcOverride!.debug!.completenessTailConstraintApplied).toBe(true);
  });
});


