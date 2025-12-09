/**
 * addEvidenceAndForecastScalars – Evidence & Forecast Semantics Tests
 * 
 * Tests the private method via the __test_only__ harness exported from
 * dataOperationsService. This ensures we test the ACTUAL production logic,
 * not a diverging clone.
 * 
 * Key paths tested:
 * 1. EXACT MATCH: sliceDSL === targetSlice → use header n/k for evidence
 * 2. COHORT EVIDENCE: cohort() query → restrict to cohort window
 * 3. WINDOW SUPER-RANGE: query window contains base window → use full base totals
 * 4. FORECAST FROM WINDOW: cohort query → copy forecast from matching window slice
 * 5. FORECAST FALLBACK: no window slice → compute from cohort data
 * 
 * Strategy: Create param file data, call the REAL transformation via harness,
 * assert outputs.
 */

import { describe, it, expect } from 'vitest';
import { __test_only__ } from '../dataOperationsService';
import type { ParameterValue } from '../paramRegistryService';

// =============================================================================
// Test Infrastructure
// =============================================================================

const REFERENCE_DATE = new Date('2025-12-09T12:00:00Z');

function daysAgo(n: number): string {
  const d = new Date(REFERENCE_DATE);
  d.setDate(d.getDate() - n);
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day}-${months[d.getMonth()]}-${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

// Alias to harness for brevity
const addEvidenceAndForecastScalars = __test_only__.addEvidenceAndForecastScalars;

// =============================================================================
// Fixtures
// =============================================================================

function createWindowValue(options: {
  startDaysAgo: number;
  endDaysAgo: number;
  n: number;
  k: number;
  context?: string;
  forecast?: number;
}): ParameterValue {
  const { startDaysAgo, endDaysAgo, n, k, context, forecast } = options;
  
  const dates: string[] = [];
  for (let i = startDaysAgo; i >= endDaysAgo; i--) {
    dates.push(daysAgo(i));
  }
  
  const numDays = dates.length;
  const contextSuffix = context ? `.context(${context})` : '';
  
  const value: ParameterValue = {
    mean: n > 0 ? k / n : 0,
    n,
    k,
    dates,
    n_daily: dates.map(() => Math.floor(n / numDays)),
    k_daily: dates.map(() => Math.floor(k / numDays)),
    window_from: dates[0],
    window_to: dates[dates.length - 1],
    sliceDSL: `window(${dates[0]}:${dates[dates.length - 1]})${contextSuffix}`,
  };
  
  if (forecast !== undefined) {
    (value as any).forecast = forecast;
  }
  
  return value;
}

function createCohortValue(options: {
  dates: string[];
  n: number;
  k: number;
  context?: string;
  medianLag?: number;
  meanLag?: number;
}): ParameterValue {
  const { dates, n, k, context, medianLag, meanLag } = options;
  
  const numDays = dates.length;
  const contextSuffix = context ? `.context(${context})` : '';
  
  const value: ParameterValue = {
    mean: n > 0 ? k / n : 0,
    n,
    k,
    dates,
    n_daily: dates.map(() => Math.floor(n / numDays)),
    k_daily: dates.map(() => Math.floor(k / numDays)),
    cohort_from: dates[0],
    cohort_to: dates[dates.length - 1],
    sliceDSL: `cohort(anchor,${dates[0]}:${dates[dates.length - 1]})${contextSuffix}`,
  };
  
  if (medianLag !== undefined) {
    value.median_lag_days = dates.map(() => medianLag);
  }
  if (meanLag !== undefined) {
    value.mean_lag_days = dates.map(() => meanLag);
  }
  
  return value;
}

// =============================================================================
// 1. EXACT MATCH: Use Header n/k
// =============================================================================

describe('Evidence: Exact Slice Match', () => {
  
  it('uses header n/k when sliceDSL exactly matches targetSlice', () => {
    const sliceDSL = `window(${daysAgo(20)}:${daysAgo(10)})`;
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 1000, k: 350 });
    value.sliceDSL = sliceDSL;
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      sliceDSL // Exact match
    );
    
    const outputValue = result.values[0] as any;
    
    expect(outputValue.evidence).toBeDefined();
    expect(outputValue.evidence.mean).toBeCloseTo(0.35, 5); // 350/1000
    expect(outputValue.evidence.stdev).toBeCloseTo(
      Math.sqrt((0.35 * 0.65) / 1000), 
      5
    );
  });
  
  it('ignores daily arrays for exact match evidence', () => {
    const sliceDSL = `window(${daysAgo(20)}:${daysAgo(10)})`;
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 1000, k: 350 });
    value.sliceDSL = sliceDSL;
    
    // Corrupt daily arrays (shouldn't matter for exact match)
    value.n_daily = [999, 999]; // Wrong sum
    value.k_daily = [999, 999]; // Wrong sum
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      sliceDSL
    );
    
    const outputValue = result.values[0] as any;
    
    // Should still use header n/k
    expect(outputValue.evidence.mean).toBeCloseTo(0.35, 5);
  });
});

// =============================================================================
// 2. DEFAULT PATH: Evidence from Value's n/k
// =============================================================================

describe('Evidence: Default Path (Non-Exact Match)', () => {
  
  it('computes evidence from each value n/k when not exact match', () => {
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 500, k: 200 });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      'window(-30d:-5d)' // Different from sliceDSL
    );
    
    const outputValue = result.values[0] as any;
    
    expect(outputValue.evidence).toBeDefined();
    expect(outputValue.evidence.mean).toBeCloseTo(0.4, 5); // 200/500
  });
  
  it('does not add evidence mean if n is 0', () => {
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 0, k: 0 });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      'window(-30d:-5d)'
    );
    
    const outputValue = result.values[0] as any;
    
    // With n=0, evidence should not have valid mean (NaN or undefined)
    // The real implementation returns the value unchanged when n=0
    expect(outputValue.evidence?.mean).toBeUndefined();
  });
  
  it('preserves existing evidence fields while adding mean/stdev', () => {
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 500, k: 200 });
    (value as any).evidence = { n: 500, k: 200, existing_field: 'preserved' };
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      'window(-30d:-5d)'
    );
    
    const outputValue = result.values[0] as any;
    
    // Should add mean/stdev but preserve existing_field
    expect(outputValue.evidence.mean).toBeDefined();
    expect(outputValue.evidence.existing_field).toBe('preserved');
  });
});

// =============================================================================
// 3. Non-Probability Parameters Passthrough
// =============================================================================

describe('Non-Probability Parameters', () => {
  
  it('returns unchanged for cost parameters', () => {
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 500, k: 200 });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'cost', values: [value] },
      { values: [value] },
      'window(-30d:-5d)'
    );
    
    const outputValue = result.values[0] as any;
    
    // Should NOT have evidence added
    expect(outputValue.evidence).toBeUndefined();
  });
  
  it('returns unchanged for parameters without type', () => {
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 500, k: 200 });
    
    const result = addEvidenceAndForecastScalars(
      { values: [value] }, // No type
      { values: [value] },
      'window(-30d:-5d)'
    );
    
    const outputValue = result.values[0] as any;
    
    expect(outputValue.evidence).toBeUndefined();
  });
});

// =============================================================================
// 4. FORECAST: Copy from Window Slice
// =============================================================================

describe('Forecast: From Window Slice', () => {
  
  it('copies forecast from matching window slice for cohort query', () => {
    // Cohort value (no forecast)
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80), daysAgo(70)],
      n: 300,
      k: 150,
    });
    
    // Window value with forecast (same context = '')
    const windowVal = createWindowValue({
      startDaysAgo: 30,
      endDaysAgo: 20,
      n: 1000,
      k: 450,
      forecast: 0.52, // Pre-computed forecast
    });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { values: [cohortVal, windowVal] },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(70)})` // Cohort query
    );
    
    const outputValue = result.values[0] as any;
    
    expect(outputValue.forecast).toBe(0.52);
  });
  
  it('selects most recent window slice when multiple exist', () => {
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80)],
      n: 200,
      k: 100,
    });
    
    // Older window
    const oldWindow = createWindowValue({
      startDaysAgo: 60,
      endDaysAgo: 50,
      n: 500,
      k: 200,
      forecast: 0.40,
    });
    oldWindow.data_source = { 
      type: 'api', 
      retrieved_at: '2025-12-01T00:00:00Z' 
    };
    
    // Newer window
    const newWindow = createWindowValue({
      startDaysAgo: 30,
      endDaysAgo: 20,
      n: 500,
      k: 250,
      forecast: 0.55,
    });
    newWindow.data_source = { 
      type: 'api', 
      retrieved_at: '2025-12-08T00:00:00Z' // More recent
    };
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { values: [cohortVal, oldWindow, newWindow] },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(80)})`
    );
    
    const outputValue = result.values[0] as any;
    
    // Should use newer window's forecast
    expect(outputValue.forecast).toBe(0.55);
  });
  
  it('does not overwrite existing forecast on cohort value', () => {
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80)],
      n: 200,
      k: 100,
    });
    (cohortVal as any).forecast = 0.60; // Already has forecast
    
    const windowVal = createWindowValue({
      startDaysAgo: 30,
      endDaysAgo: 20,
      n: 500,
      k: 200,
      forecast: 0.45, // Different forecast
    });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { values: [cohortVal, windowVal] },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(80)})`
    );
    
    const outputValue = result.values[0] as any;
    
    // Should keep original forecast
    expect(outputValue.forecast).toBe(0.60);
  });
  
  it('only uses window slices with matching context', () => {
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80)],
      n: 200,
      k: 100,
      context: 'geo=UK',
    });
    
    // Window with different context
    const usWindow = createWindowValue({
      startDaysAgo: 30,
      endDaysAgo: 20,
      n: 500,
      k: 200,
      context: 'geo=US',
      forecast: 0.45,
    });
    
    // Window with matching context
    const ukWindow = createWindowValue({
      startDaysAgo: 30,
      endDaysAgo: 20,
      n: 500,
      k: 275,
      context: 'geo=UK',
      forecast: 0.62,
    });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { values: [cohortVal, usWindow, ukWindow] },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(80)}).context(geo=UK)`
    );
    
    const outputValue = result.values[0] as any;
    
    // Should use UK window's forecast
    expect(outputValue.forecast).toBe(0.62);
  });
});

// =============================================================================
// 5. FORECAST FALLBACK: Compute from Cohort Data
// =============================================================================

describe('Forecast: Fallback from Cohort Data', () => {
  
  it('computes forecast from cohort when no window slice exists', () => {
    // Cohort with lag data for statistical computation
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80), daysAgo(70), daysAgo(60), daysAgo(50)],
      n: 500,
      k: 250,
      medianLag: 6,
      meanLag: 7,
    });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { 
        values: [cohortVal], // No window slices
        latency: { maturity_days: 30 },
      },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(50)})`
    );
    
    const outputValue = result.values[0] as any;
    
    // Forecast should be computed from cohort data
    // Exact value depends on statisticalEnhancementService
    // Key contract: forecast is produced when latency data + maturity are present
    expect(outputValue.forecast).toBeDefined();
    expect(typeof outputValue.forecast).toBe('number');
    expect(outputValue.forecast).toBeGreaterThan(0);
    expect(outputValue.forecast).toBeLessThanOrEqual(1);
  });
  
  it('prefers window forecast over computed fallback', () => {
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80)],
      n: 200,
      k: 100,
      medianLag: 6,
      meanLag: 7,
    });
    
    const windowVal = createWindowValue({
      startDaysAgo: 30,
      endDaysAgo: 20,
      n: 1000,
      k: 480,
      forecast: 0.52,
    });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { 
        values: [cohortVal, windowVal],
        latency: { maturity_days: 30 },
      },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(80)})`
    );
    
    const outputValue = result.values[0] as any;
    
    // Should use window forecast, not computed fallback
    expect(outputValue.forecast).toBe(0.52);
  });
  
  it('does not add forecast if cohort lacks lag data', () => {
    // Cohort without lag data
    const cohortVal = createCohortValue({
      dates: [daysAgo(90), daysAgo(80)],
      n: 200,
      k: 100,
      // No medianLag or meanLag
    });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { 
        values: [cohortVal], // No window slices
        latency: { maturity_days: 30 },
      },
      `cohort(anchor,${daysAgo(90)}:${daysAgo(80)})`
    );
    
    const outputValue = result.values[0] as any;
    
    // Forecast should be undefined (no lag data to compute from)
    expect(outputValue.forecast).toBeUndefined();
  });
});

// =============================================================================
// 6. COHORT Evidence: Restricted to Query Window
// =============================================================================

describe('Cohort Evidence: Restricted to Query Window', () => {
  
  it('filters cohorts to requested window for evidence calculation', () => {
    // Create cohort with daily data spanning 90-50 days ago
    // But query only asks for cohorts 70-60 days ago
    const dates = [daysAgo(90), daysAgo(80), daysAgo(70), daysAgo(60), daysAgo(50)];
    const cohortVal: ParameterValue = {
      mean: 0.5,
      n: 500, // Total across all cohorts
      k: 250,
      dates,
      // Each cohort has n=100, k=50 (for simplicity)
      n_daily: [100, 100, 100, 100, 100],
      k_daily: [50, 50, 50, 50, 50],
      cohort_from: dates[0],
      cohort_to: dates[dates.length - 1],
      sliceDSL: `cohort(anchor,${dates[0]}:${dates[dates.length - 1]})`,
    };
    
    // Query for narrower cohort window: only 70-60 days ago
    // Should filter to cohorts at daysAgo(70) and daysAgo(60) = 2 cohorts
    // n = 200, k = 100 → evidence.mean = 0.5
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { values: [cohortVal] },
      `cohort(anchor,${daysAgo(70)}:${daysAgo(60)})`
    );
    
    const outputValue = result.values[0] as any;
    
    expect(outputValue.evidence).toBeDefined();
    // Filtered evidence: 2 cohorts × 100n = 200n, 2 × 50k = 100k → mean = 0.5
    expect(outputValue.evidence.mean).toBeCloseTo(0.5, 5);
    // Stdev should be based on filtered n=200
    expect(outputValue.evidence.stdev).toBeCloseTo(
      Math.sqrt((0.5 * 0.5) / 200),
      5
    );
  });
  
  it('returns empty evidence when query window has no matching cohorts', () => {
    // Cohorts from 90-80 days ago
    const dates = [daysAgo(90), daysAgo(85), daysAgo(80)];
    const cohortVal: ParameterValue = {
      mean: 0.5,
      n: 300,
      k: 150,
      dates,
      n_daily: [100, 100, 100],
      k_daily: [50, 50, 50],
      cohort_from: dates[0],
      cohort_to: dates[dates.length - 1],
      sliceDSL: `cohort(anchor,${dates[0]}:${dates[dates.length - 1]})`,
    };
    
    // Query for cohorts 30-20 days ago (no overlap with stored data)
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [cohortVal] },
      { values: [cohortVal] },
      `cohort(anchor,${daysAgo(30)}:${daysAgo(20)})`
    );
    
    const outputValue = result.values[0] as any;
    
    // No matching cohorts → evidence should be absent or unchanged
    // The implementation leaves evidence unchanged when totalN=0
    expect(outputValue.evidence?.mean).toBeUndefined();
  });
});

// =============================================================================
// 7. WINDOW Super-Range: Use Full Base Totals
// =============================================================================

describe('Window Evidence: Super-Range Queries', () => {
  
  it('uses full base window totals when query window contains stored window', () => {
    // Stored window: 25-Nov to 1-Dec (days 14-8 ago)
    const baseValue = createWindowValue({
      startDaysAgo: 14,
      endDaysAgo: 8,
      n: 700, // Full stored n
      k: 280, // Full stored k → mean = 0.4
    });
    
    // Query for wider window: 24-Nov to 2-Dec (days 15-7 ago)
    // This CONTAINS the base window
    const queryDSL = `window(${daysAgo(15)}:${daysAgo(7)})`;
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [baseValue] },
      { values: [baseValue] },
      queryDSL
    );
    
    const outputValue = result.values[0] as any;
    
    // Evidence should use FULL base window totals, not partial daily data
    expect(outputValue.evidence).toBeDefined();
    expect(outputValue.evidence.mean).toBeCloseTo(0.4, 5); // 280/700
    expect(outputValue.evidence.stdev).toBeCloseTo(
      Math.sqrt((0.4 * 0.6) / 700),
      5
    );
  });
  
  it('does not apply super-range logic when query is narrower than stored', () => {
    // Stored window: days 20-10 ago (wide)
    const baseValue = createWindowValue({
      startDaysAgo: 20,
      endDaysAgo: 10,
      n: 1100,
      k: 440,
    });
    
    // Query for narrower window: days 18-12 ago
    // This is CONTAINED BY the base window, not containing it
    const queryDSL = `window(${daysAgo(18)}:${daysAgo(12)})`;
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [baseValue] },
      { values: [baseValue] },
      queryDSL
    );
    
    const outputValue = result.values[0] as any;
    
    // Evidence should use default path (value's own n/k), not super-range
    expect(outputValue.evidence).toBeDefined();
    expect(outputValue.evidence.mean).toBeCloseTo(0.4, 5); // 440/1100
  });
});

// =============================================================================
// 8. Edge Cases
// =============================================================================

describe('Evidence & Forecast Edge Cases', () => {
  
  it('handles empty values array gracefully', () => {
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [] },
      { values: [] },
      'window(-30d:-20d)'
    );
    
    expect(result.values).toEqual([]);
  });
  
  it('handles null aggregatedData gracefully', () => {
    const result = addEvidenceAndForecastScalars(
      null,
      { values: [] },
      'window(-30d:-20d)'
    );
    
    expect(result).toBeNull();
  });
  
  it('handles undefined targetSlice', () => {
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 500, k: 200 });
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      undefined
    );
    
    const outputValue = result.values[0] as any;
    
    // Should still compute evidence via default path
    expect(outputValue.evidence).toBeDefined();
    expect(outputValue.evidence.mean).toBeCloseTo(0.4, 5);
  });
  
  it('binomial stdev formula is correct', () => {
    // p = 0.3, n = 1000
    // stdev = sqrt(p * (1-p) / n) = sqrt(0.3 * 0.7 / 1000) = sqrt(0.00021) ≈ 0.01449
    const value = createWindowValue({ startDaysAgo: 20, endDaysAgo: 10, n: 1000, k: 300 });
    const sliceDSL = value.sliceDSL!;
    
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: [value] },
      { values: [value] },
      sliceDSL
    );
    
    const outputValue = result.values[0] as any;
    
    expect(outputValue.evidence.mean).toBeCloseTo(0.3, 5);
    expect(outputValue.evidence.stdev).toBeCloseTo(
      Math.sqrt(0.3 * 0.7 / 1000),
      5
    );
  });
  
  it('handles values array that is not an array gracefully', () => {
    const result = addEvidenceAndForecastScalars(
      { type: 'probability', values: 'not an array' },
      { values: [] },
      'window(-30d:-20d)'
    );
    
    // Should return input unchanged
    expect(result.values).toBe('not an array');
  });
});
