/**
 * FE statistical-enhancement contract vectors.
 *
 * Canonical test vectors with hardcoded expected values for the FE
 * quick pass primitives (fitLagDistribution, logNormalCDF, etc.). Any
 * drift in these primitives breaks this test.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  fitLagDistribution,
  logNormalCDF,
  logNormalInverseCDF,
} from '../lagDistributionUtils';
import {
  computeBlendedMean,
  computePerDayBlendedMean,
  computeEdgeLatencyStats,
  enhanceGraphLatencies,
  type CohortData,
  type GraphForPath,
  type LAGHelpers,
  type ParameterValueForLAG,
} from '../statisticalEnhancementService';
import { aggregateLatencyStats } from '../windowAggregationService';

// ── Tolerances ──────────────────────────────────────────────────────────────
// These are tight: the implementations must agree to high precision.
const TOL = 1e-9;       // mu, sigma, blended mean (pure arithmetic)
const TOL_CDF = 1e-6;   // CDF (FE Acklam approx vs BE scipy — ~7 decimal agreement)
const TOL_T95 = 1e-4;   // t95 (exp amplifies CDF approximation differences)

// ── Vector 1: fitLagDistribution ────────────────────────────────────────────
describe('parity: fitLagDistribution', () => {
  it('median=7, mean=9.5, k=500 → mu/sigma from moments', () => {
    const fit = fitLagDistribution(7.0, 9.5, 500);
    expect(fit.mu).toBeCloseTo(1.945910149055313, 10);
    expect(fit.sigma).toBeCloseTo(0.781513467000002, 10);
    expect(fit.empirical_quality_ok).toBe(true);
  });

  it('median=3, mean=undefined, k=500 → default sigma', () => {
    const fit = fitLagDistribution(3.0, undefined, 500);
    expect(fit.mu).toBeCloseTo(1.098612288668110, 10);
    expect(fit.sigma).toBeCloseTo(0.5, 10); // LATENCY_DEFAULT_SIGMA
  });

  it('low k (k=10) → quality flag false', () => {
    const fit = fitLagDistribution(7.0, 9.5, 10);
    expect(fit.empirical_quality_ok).toBe(false);
    expect(fit.sigma).toBeCloseTo(0.5, 10); // falls back to default
  });
});

// ── Vector 2: logNormalCDF ──────────────────────────────────────────────────
describe('parity: logNormalCDF', () => {
  const mu = 1.945910149055313;
  const sigma = 0.781513467000002;

  it('CDF(18, mu, sigma) ≈ 0.8866 (mature cohort)', () => {
    expect(logNormalCDF(18, mu, sigma)).toBeCloseTo(0.886573137615063, 6);
  });

  it('CDF(3, mu, sigma) ≈ 0.1391 (immature cohort)', () => {
    expect(logNormalCDF(3, mu, sigma)).toBeCloseTo(0.139143465967953, 6);
  });

  it('CDF(0, mu, sigma) = 0', () => {
    expect(logNormalCDF(0, mu, sigma)).toBe(0);
  });

  it('CDF(-1, mu, sigma) = 0', () => {
    expect(logNormalCDF(-1, mu, sigma)).toBe(0);
  });
});

// ── Vector 3: logNormalInverseCDF (t95) ─────────────────────────────────────
describe('parity: logNormalInverseCDF', () => {
  it('t95 for fit1 (median=7, mean=9.5)', () => {
    const mu = 1.945910149055313;
    const sigma = 0.781513467000002;
    expect(logNormalInverseCDF(0.95, mu, sigma)).toBeCloseTo(25.314703926093792, 6);
  });

  it('t95 for fit2 (median=3, default sigma)', () => {
    const mu = 1.098612288668110;
    const sigma = 0.5;
    expect(logNormalInverseCDF(0.95, mu, sigma)).toBeCloseTo(6.828049825542952, 6);
  });

  it('inverseCDF(0) = 0', () => {
    expect(logNormalInverseCDF(0, 1.0, 0.5)).toBe(0);
  });

  it('inverseCDF(1) = Infinity', () => {
    expect(logNormalInverseCDF(1, 1.0, 0.5)).toBe(Infinity);
  });
});

// ── Vector 4: computeBlendedMean ────────────────────────────────────────────
describe('parity: computeBlendedMean', () => {
  const model = {
    FORECAST_BLEND_LAMBDA: 0.15,
    LATENCY_BLEND_COMPLETENESS_POWER: 2.25,
  };

  it('moderate completeness (0.6)', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.6,
      nQuery: 200,
      nBaseline: 1000,
    }, model);
    expect(result).toBeCloseTo(0.068537033909537, 10);
  });

  it('high completeness (0.95) → mostly evidence', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.95,
      nQuery: 200,
      nBaseline: 1000,
    }, model);
    expect(result).toBeCloseTo(0.052521182878623, 10);
  });

  it('zero completeness → pure forecast', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.0,
      nQuery: 200,
      nBaseline: 1000,
    }, model);
    expect(result).toBeCloseTo(0.08, 10);
  });

  it('nBaseline=0 → undefined', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.6,
      nQuery: 200,
      nBaseline: 0,
    }, model);
    expect(result).toBeUndefined();
  });
});

// ── Vector 4b: computePerDayBlendedMean ──────────────────────────────────────
// D2 parity: per-day blending must match between FE and BE.
// Uses the same cohort vector as Vector 6 plus CDF params from its fit.
describe('parity: computePerDayBlendedMean', () => {
  const cohorts: CohortData[] = [
    { date: '2025-11-01', age: 60, n: 100, k: 85, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-05', age: 56, n: 120, k: 98, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-10', age: 51, n: 90,  k: 72, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-15', age: 46, n: 110, k: 82, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-20', age: 41, n: 95,  k: 65, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-25', age: 36, n: 105, k: 60, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-01', age: 31, n: 80,  k: 38, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-05', age: 27, n: 115, k: 42, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-10', age: 22, n: 100, k: 28, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-15', age: 17, n: 90,  k: 15, median_lag_days: 5.0, mean_lag_days: 7.0 },
  ];

  // CDF params from the Vector 6 fit (mu=1.0986, sigma=1.0108, onset=2.0)
  const cdfMu = 1.0986122886681098;
  const cdfSigma = 1.0107676525947897;

  it('should produce blendedMean matching BE for mixed-maturity cohorts', () => {
    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean: 0.60,
      nBaseline: 500,
      cdfMu,
      cdfSigma,
      onsetDeltaDays: 2.0,
    });
    expect(result).toBeDefined();
    // Canonical FE value for observed-rate per-day blending. Completeness
    // affects per-day evidence weight, not the rate's k/n basis.
    expect(result!.blendedMean).toBeCloseTo(0.5882908253329786, 9);
    expect(result!.completenessAgg).toBeCloseTo(0.9864722632086734, 6);
  });

  it('nBaseline=0 → undefined', () => {
    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean: 0.60,
      nBaseline: 0,
      cdfMu,
      cdfSigma,
    });
    expect(result).toBeUndefined();
  });
});

// ── Vector 5: Fenton-Wilkinson composition ──────────────────────────────────
// FW composition is tested via its effect on t95: compose two edges,
// compute path_t95 from the composed distribution.
describe('parity: FW lognormal composition', () => {
  it('compose(mu=1.5,sigma=0.6) + (mu=2.0,sigma=0.4) → path mu/sigma', () => {
    // FW moment matching: X1 + X2 ≈ LN(mu_fw, sigma_fw)
    const mu_a = 1.5, sigma_a = 0.6;
    const mu_b = 2.0, sigma_b = 0.4;

    const mean_a = Math.exp(mu_a + sigma_a ** 2 / 2);
    const mean_b = Math.exp(mu_b + sigma_b ** 2 / 2);
    const var_a = (Math.exp(sigma_a ** 2) - 1) * Math.exp(2 * mu_a + sigma_a ** 2);
    const var_b = (Math.exp(sigma_b ** 2) - 1) * Math.exp(2 * mu_b + sigma_b ** 2);

    const m = mean_a + mean_b;
    const v = var_a + var_b;

    const sigma_sq = Math.log(1 + v / m ** 2);
    const sigma_fw = Math.sqrt(sigma_sq);
    const mu_fw = Math.log(m) - sigma_sq / 2;

    expect(mu_fw).toBeCloseTo(2.531031379595798, 10);
    expect(sigma_fw).toBeCloseTo(0.352090536095916, 10);

    // path_t95 from composed distribution
    const path_t95 = logNormalInverseCDF(0.95, mu_fw, sigma_fw);
    expect(path_t95).toBeCloseTo(22.424828829811858, 6);
  });
});

// ── Vector 6: Full pipeline — computeEdgeLatencyStats ───────────────────────
// This is the critical parity test: same cohorts + params through the full
// edge-level pipeline must produce the same outputs on FE and BE.
describe('parity: computeEdgeLatencyStats (full pipeline)', () => {
  const cohorts: CohortData[] = [
    { date: '2025-11-01', age: 60, n: 100, k: 85, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-05', age: 56, n: 120, k: 98, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-10', age: 51, n: 90,  k: 72, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-15', age: 46, n: 110, k: 82, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-20', age: 41, n: 95,  k: 65, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-25', age: 36, n: 105, k: 60, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-01', age: 31, n: 80,  k: 38, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-05', age: 27, n: 115, k: 42, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-10', age: 22, n: 100, k: 28, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-15', age: 17, n: 90,  k: 15, median_lag_days: 5.0, mean_lag_days: 7.0 },
  ];

  it('should produce mu/sigma/t95/completeness/p_evidence/p_infinity matching BE', () => {
    const result = computeEdgeLatencyStats(
      cohorts,
      /* aggregateMedianLag */ 5.0,
      /* aggregateMeanLag */ 7.0,
      /* defaultT95Days */ 30.0,
      /* anchorMedianLag */ 0,
      /* fitTotalKOverride */ undefined,
      /* pInfinityCohortsOverride */ undefined,
      /* edgeT95 */ undefined,
      /* recencyHalfLifeDays */ 30.0,
      /* onsetDeltaDays */ 2.0,
      /* maxMeanMedianRatioOverride */ undefined,
      /* applyAnchorAgeAdjustment */ false,
    );

    // These values are the BE's output for the same inputs.
    // If either side changes, its test breaks.
    expect(result.fit.mu).toBeCloseTo(1.0986122886681098, 6);
    expect(result.fit.sigma).toBeCloseTo(1.0107676525947897, 6);
    expect(result.fit.empirical_quality_ok).toBe(true);
    expect(result.t95).toBeCloseTo(17.8184523080876, 4);
    expect(result.completeness).toBeCloseTo(0.9864722632086734, 4);
    expect(result.p_evidence).toBeCloseTo(0.582089552238806, 6);
    expect(result.p_infinity).toBeCloseTo(0.5663243456570916, 4);
    expect(result.forecast_available).toBe(true);

    // Principled dispersion (EPISTEMIC_DISPERSION_DESIGN.md §3–§5) — must match BE.
    // mu_sd is the interval-matched effective SD of the t-posterior on μ; sigma_sd
    // is the interval-matched effective SD of the scaled inv-χ² posterior on σ.
    expect(result.p_sd).toBeCloseTo(0.015535674711082496, 9);
    expect(result.mu_sd).toBeCloseTo(0.041856495821805284, 9);
    expect(result.sigma_sd).toBeCloseTo(0.029648303064642403, 9);
    expect(result.onset_sd).toBeCloseTo(0.2, 9);
    expect(result.onset_mu_corr).toBeCloseTo(-0.3, 9);
  });
});

// ── Vector 7: Graph-level parity — enhanceGraphLatencies ──────────────────
// Same 3-edge linear graph A → B → C → D used in Python TestTopoPassSynthetic.
// Runs FE enhanceGraphLatencies and asserts field-by-field against BE outputs.
// If either side's orchestration drifts, the corresponding test breaks.
describe('parity: enhanceGraphLatencies (graph-level)', () => {
  function makeCohorts(
    median: number, mean: number, kRatio: number, nBase = 100, nDays = 10,
    anchorMedian?: number, anchorMean?: number,
  ): CohortData[] {
    const out: CohortData[] = [];
    for (let i = 0; i < nDays; i++) {
      const age = 30 - i * 2;
      const n = nBase + i * 5;
      const k = Math.floor(n * kRatio);
      out.push({
        date: `2026-03-${String(1 + i).padStart(2, '0')}`,
        age, n, k,
        median_lag_days: median, mean_lag_days: mean,
        ...(anchorMedian != null ? { anchor_median_lag_days: anchorMedian } : {}),
        ...(anchorMean != null ? { anchor_mean_lag_days: anchorMean } : {}),
      });
    }
    return out;
  }

  // Pre-built cohort data per edge (same as Python TestTopoPassSynthetic)
  const cohortsByEdge: Record<string, CohortData[]> = {
    e1: makeCohorts(7.0, 9.0, 0.65),
    e2: makeCohorts(10.0, 13.0, 0.42, 80, 8, 6.5, 8.5),
    e3: makeCohorts(12.0, 15.0, 0.28, 50, 6, 14.0, 18.0),
  };

  // NOTE: onset_delta_days set to 0 on all edges to avoid the onset fallback
  // discrepancy (FE uses 0 when no window slices; BE reads graph value).
  // See KNOWN ONSET FALLBACK DISCREPANCY in the Python test.
  const graph: any = {
    nodes: [
      { uuid: 'a', id: 'a', entry: { is_start: true }, event_id: 'ev-a' },
      { uuid: 'b', id: 'b', event_id: 'ev-b' },
      { uuid: 'c', id: 'c', event_id: 'ev-c' },
      { uuid: 'd', id: 'd', event_id: 'ev-d' },
    ],
    edges: [
      { uuid: 'e1', from: 'a', to: 'b', p: {
        id: 'param-ab', mean: 0.7,
        latency: { latency_parameter: true, t95: 15.0, onset_delta_days: 0.0 },
        forecast: { mean: 0.68 },
        evidence: { mean: 0.65, n: 200, k: 130 },
      }},
      { uuid: 'e2', from: 'b', to: 'c', p: {
        id: 'param-bc', mean: 0.5,
        latency: { latency_parameter: true, t95: 20.0, onset_delta_days: 0.0 },
        forecast: { mean: 0.48 },
        evidence: { mean: 0.42, n: 150, k: 63 },
      }},
      { uuid: 'e3', from: 'c', to: 'd', p: {
        id: 'param-cd', mean: 0.3,
        latency: { latency_parameter: true, t95: 25.0, onset_delta_days: 0.0 },
      }},
    ],
  };

  // Stub helpers: aggregateCohortData returns our pre-built cohorts.
  // aggregateLatencyStats uses the real implementation (imported at top).
  const paramLookup = new Map<string, ParameterValueForLAG[]>();
  // We store a sentinel ParameterValueForLAG per edge; the stub helper
  // ignores it and returns cohortsByEdge[edgeId] directly.
  for (const edgeId of ['e1', 'e2', 'e3']) {
    paramLookup.set(edgeId, [{ mean: 0 } as ParameterValueForLAG]);
  }

  const helpers: LAGHelpers = {
    aggregateCohortData: (_values, _queryDate, _cohortWindow) => {
      // We need to know which edge is being queried. enhanceGraphLatencies
      // calls helpers.aggregateCohortData(paramValues, ...) where paramValues
      // is the array from paramLookup.get(edgeId). Since we put a unique
      // sentinel per edge, match by reference.
      for (const [edgeId, pv] of paramLookup) {
        if (_values === pv) return cohortsByEdge[edgeId];
      }
      return [];
    },
    aggregateLatencyStats,
  };

  it('should produce per-edge values matching BE enhance_graph_latencies', () => {
    const queryDate = new Date('2026-04-01T00:00:00Z');
    const result = enhanceGraphLatencies(
      graph as GraphForPath,
      paramLookup,
      queryDate,
      helpers,
      undefined, // cohortWindow
      undefined, // whatIfDSL
      undefined, // pathT95Map
      'cohort',  // lagSliceSource
    );

    expect(result.edgeValues.length).toBeGreaterThanOrEqual(3);
    const byId = Object.fromEntries(
      result.edgeValues
        .filter(ev => ev.conditionalIndex == null) // base edges only
        .map(ev => [ev.edgeUuid, ev])
    );

    // FE is canonical — assert specific FE values, then pin BE to match.
    // If these assertions fail, the FE orchestration has changed.
    // The matching Python test in test_stats_parity_contract.py must produce
    // the same values (within BE rounding tolerance).

    // e1: A → B (first edge, no anchor)
    expect(byId.e1.latency.mu).toBeDefined();
    expect(byId.e1.latency.sigma).toBeDefined();
    expect(byId.e1.latency.t95).toBeGreaterThan(0);
    expect(byId.e1.latency.completeness).toBeGreaterThan(0);
    expect(byId.e1.latency.completeness).toBeLessThanOrEqual(1);

    // e2: B → C (with anchor lag data — has path composition)
    expect(byId.e2.latency.mu).toBeDefined();
    expect(byId.e2.latency.path_t95).toBeGreaterThan(byId.e2.latency.t95);
    expect(byId.e2.latency.path_mu).toBeDefined();
    expect(byId.e2.latency.path_sigma).toBeDefined();

    // e3: C → D (deepest edge — largest path_t95)
    expect(byId.e3.latency.path_t95).toBeGreaterThan(byId.e2.latency.path_t95);

    // FE canonical values — BE must match within rounding tolerance.
    // These are the SAME values the Python TestParityGraphLevel pins.

    // e1: A → B (first edge, no anchor)
    expect(byId.e1.latency.mu).toBeCloseTo(1.9459101490553132, 4);
    expect(byId.e1.latency.sigma).toBeCloseTo(0.7089632265229359, 4);
    expect(byId.e1.latency.t95).toBeCloseTo(22.467074508619845, 2);
    expect(byId.e1.latency.completeness).toBeCloseTo(0.9088372218074214, 3);

    // e2: B → C (with anchor lag data)
    expect(byId.e2.latency.mu).toBeCloseTo(2.302585092994046, 4);
    expect(byId.e2.latency.sigma).toBeCloseTo(0.7243814802540038, 4);
    expect(byId.e2.latency.path_t95).toBeCloseTo(46.55652145084939, 1);
    expect(byId.e2.latency.path_mu).toBeCloseTo(2.9131175840818324, 3);

    // e3: C → D (deepest edge)
    expect(byId.e3.latency.mu).toBeCloseTo(2.484906649788, 4);
    expect(byId.e3.latency.path_t95).toBeCloseTo(69.30190508017722, 0);
    expect(byId.e3.latency.completeness).toBeCloseTo(0.37542741520006523, 3);
  });
});
