/**
 * mergeTimeSeriesIntoParameter – Structural Invariants Tests
 * 
 * This file exhaustively tests the invariants that must hold after any merge:
 * 
 * WINDOW MODE:
 * - Single canonical entry per slice family
 * - Dates, n_daily, k_daily are union with "new fetch wins" on overlap
 * - window_from/window_to span the full coverage
 * - sliceDSL is canonical: window(<from>:<to>)[.context(...)]
 * - Forecast and latency recomputation when configured
 * 
 * COHORT MODE:
 * - All previous cohort entries for family are removed
 * - Single new cohort entry with cohort_from/cohort_to
 * - sliceDSL includes anchor from latencyConfig
 * - No mixing of window and cohort entries
 * 
 * Philosophy: These tests verify DATA SHAPES, not behaviour.
 * Every assertion is about the structure of the output.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeTimeSeriesIntoParameter,
  isCohortModeValue,
  type TimeSeriesPointWithLatency,
} from '../windowAggregationService';
import { extractSliceDimensions } from '../sliceIsolation';
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

/** Create time series points for a date range */
function makeTimeSeries(
  startDaysAgo: number, 
  endDaysAgo: number, 
  options?: { n?: number; k?: number; withLatency?: boolean }
): TimeSeriesPointWithLatency[] {
  const { n = 100, k = 50, withLatency = false } = options || {};
  const points: TimeSeriesPointWithLatency[] = [];
  
  // Deterministic latency values based on day offset (no randomness!)
  // This makes tests stable while still varying per day
  const LATENCY_BASE_MEDIAN = 6;
  const LATENCY_BASE_MEAN = 7;
  
  for (let i = startDaysAgo; i >= endDaysAgo; i--) {
    const point: TimeSeriesPointWithLatency = {
      date: daysAgo(i),
      n,
      k,
      p: n > 0 ? k / n : 0,
    };
    
    if (withLatency) {
      // Deterministic variation: add small offset based on day index
      // This ensures reproducibility while varying per day
      const dayOffset = (i % 5) * 0.1; // 0, 0.1, 0.2, 0.3, 0.4
      point.median_lag_days = LATENCY_BASE_MEDIAN + dayOffset;
      point.mean_lag_days = LATENCY_BASE_MEAN + dayOffset;
    }
    
    points.push(point);
  }
  
  return points;
}

/** Create an existing window ParameterValue */
function windowValue(options: {
  startDaysAgo: number;
  endDaysAgo: number;
  context?: string;
  n?: number;
  k?: number;
}): ParameterValue {
  const { startDaysAgo, endDaysAgo, context, n = 1000, k = 500 } = options;
  
  const dates: string[] = [];
  for (let i = startDaysAgo; i >= endDaysAgo; i--) {
    dates.push(daysAgo(i));
  }
  
  const numDays = dates.length;
  const contextSuffix = context ? `.context(${context})` : '';
  
  return {
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
}

/** Create an existing cohort ParameterValue */
function cohortValue(options: {
  dates: string[];
  context?: string;
  anchor?: string;
  n?: number;
  k?: number;
}): ParameterValue {
  const { dates, context, anchor = 'anchor-node', n = 1000, k = 500 } = options;
  
  const numDays = dates.length;
  const contextSuffix = context ? `.context(${context})` : '';
  
  return {
    mean: n > 0 ? k / n : 0,
    n,
    k,
    dates,
    n_daily: dates.map(() => Math.floor(n / numDays)),
    k_daily: dates.map(() => Math.floor(k / numDays)),
    cohort_from: dates[0],
    cohort_to: dates[dates.length - 1],
    sliceDSL: `cohort(${anchor},${dates[0]}:${dates[dates.length - 1]})${contextSuffix}`,
  };
}

// =============================================================================
// 1. WINDOW MODE: Single Canonical Entry Invariant
// =============================================================================

describe('Window Mode: Single Canonical Entry', () => {
  
  it('merges multiple existing window values into ONE entry', () => {
    // Three existing window values for same slice family
    const existing: ParameterValue[] = [
      windowValue({ startDaysAgo: 30, endDaysAgo: 25 }),
      windowValue({ startDaysAgo: 24, endDaysAgo: 20 }),
      windowValue({ startDaysAgo: 19, endDaysAgo: 15 }),
    ];
    
    // New fetch for days 14-10
    const newTimeSeries = makeTimeSeries(14, 10);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(14), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      '' // No context filter
    );
    
    // Result should have EXACTLY ONE window value (all merged)
    const windowValues = result.filter(v => !isCohortModeValue(v));
    expect(windowValues.length).toBe(1);
    
    // Merged value should span full range
    const merged = windowValues[0];
    expect(merged.dates?.length).toBeGreaterThanOrEqual(21); // Days 30-10 = 21 days
  });
  
  it('preserves other slice families untouched', () => {
    // Existing values for TWO different context families
    const ukValue = windowValue({ startDaysAgo: 30, endDaysAgo: 25, context: 'geo=UK' });
    const usValue = windowValue({ startDaysAgo: 30, endDaysAgo: 25, context: 'geo=US' });
    
    // New fetch for UK context only
    const newTimeSeries = makeTimeSeries(20, 15);
    
    const result = mergeTimeSeriesIntoParameter(
      [ukValue, usValue],
      newTimeSeries,
      { start: daysAgo(20), end: daysAgo(15) },
      undefined,
      undefined,
      undefined,
      'api',
      'context(geo=UK)' // Only targeting UK
    );
    
    // Should have TWO values: one merged UK, one unchanged US
    expect(result.length).toBe(2);
    
    // US value should be unchanged
    const usResult = result.find(v => v.sliceDSL?.includes('geo=US'));
    expect(usResult).toBeDefined();
    expect(usResult!.dates).toEqual(usValue.dates);
  });
});

// =============================================================================
// 2. WINDOW MODE: Union with "New Fetch Wins" on Overlap
// =============================================================================

describe('Window Mode: Union with New Fetch Wins', () => {
  
  it('new data overwrites overlapping dates', () => {
    // Existing: days 30-25 with n=100 per day
    const existing = [windowValue({ startDaysAgo: 30, endDaysAgo: 25, n: 600, k: 300 })];
    
    // New fetch: days 27-22 with n=200 per day (overlaps 27-25)
    const newTimeSeries = makeTimeSeries(27, 22, { n: 200, k: 100 });
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(27), end: daysAgo(22) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // Find the overlapping date (e.g., day 26)
    const day26Index = merged.dates!.findIndex(d => d === daysAgo(26));
    expect(day26Index).toBeGreaterThanOrEqual(0);
    
    // Should have NEW value (200), not old (100)
    expect(merged.n_daily![day26Index]).toBe(200);
    expect(merged.k_daily![day26Index]).toBe(100);
  });
  
  it('preserves non-overlapping old dates', () => {
    // Existing: days 30-25
    const existing = [windowValue({ startDaysAgo: 30, endDaysAgo: 25, n: 600, k: 300 })];
    
    // New fetch: days 22-18 (no overlap)
    const newTimeSeries = makeTimeSeries(22, 18, { n: 500, k: 250 });
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(22), end: daysAgo(18) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // Old dates (30-25) should be preserved
    expect(merged.dates).toContain(daysAgo(30));
    expect(merged.dates).toContain(daysAgo(29));
    expect(merged.dates).toContain(daysAgo(25));
    
    // New dates should also be present
    expect(merged.dates).toContain(daysAgo(22));
    expect(merged.dates).toContain(daysAgo(18));
  });
  
  it('dates array is sorted chronologically after merge', () => {
    // Existing: days 30-28, then 22-20
    const existing: ParameterValue[] = [
      windowValue({ startDaysAgo: 30, endDaysAgo: 28 }),
      windowValue({ startDaysAgo: 22, endDaysAgo: 20 }),
    ];
    
    // New fetch: days 25-23 (fills gap)
    const newTimeSeries = makeTimeSeries(25, 23);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(25), end: daysAgo(23) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    const dates = merged.dates!;
    
    // Helper to parse UK date format to Date object
    const parseUKDate = (dateStr: string): Date => {
      const months: Record<string, number> = {
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
      };
      const [day, mon, year] = dateStr.split('-');
      return new Date(2000 + parseInt(year), months[mon], parseInt(day));
    };
    
    // Check ALL dates are sorted chronologically (oldest to newest)
    for (let i = 1; i < dates.length; i++) {
      const prevDate = parseUKDate(dates[i - 1]);
      const currDate = parseUKDate(dates[i]);
      expect(currDate.getTime()).toBeGreaterThanOrEqual(prevDate.getTime());
    }
    
    // Also verify endpoints
    expect(dates[0]).toBe(daysAgo(30));
    expect(dates[dates.length - 1]).toBe(daysAgo(20));
  });
});

// =============================================================================
// 3. WINDOW MODE: Canonical window_from/window_to
// =============================================================================

describe('Window Mode: Canonical window_from/window_to', () => {
  
  it('window_from is earliest date in merged data', () => {
    const existing = [windowValue({ startDaysAgo: 25, endDaysAgo: 20 })];
    const newTimeSeries = makeTimeSeries(35, 30); // Older dates
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(35), end: daysAgo(30) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // window_from should be day 35 (oldest)
    expect(merged.window_from).toBe(daysAgo(35));
  });
  
  it('window_to is latest date in merged data', () => {
    const existing = [windowValue({ startDaysAgo: 25, endDaysAgo: 20 })];
    const newTimeSeries = makeTimeSeries(15, 10); // Newer dates
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(15), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // window_to should be day 10 (newest)
    expect(merged.window_to).toBe(daysAgo(10));
  });
  
  it('window_from and window_to update on every merge', () => {
    // Start with narrow window
    let values: ParameterValue[] = [];
    let timeSeries = makeTimeSeries(20, 18);
    
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(20), end: daysAgo(18) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    expect(values[0].window_from).toBe(daysAgo(20));
    expect(values[0].window_to).toBe(daysAgo(18));
    
    // Extend with older dates
    timeSeries = makeTimeSeries(25, 22);
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(25), end: daysAgo(22) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    // window_from should now be 25
    expect(values[0].window_from).toBe(daysAgo(25));
    expect(values[0].window_to).toBe(daysAgo(18));
    
    // Extend with newer dates
    timeSeries = makeTimeSeries(15, 12);
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(15), end: daysAgo(12) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    // window_to should now be 12
    expect(values[0].window_from).toBe(daysAgo(25));
    expect(values[0].window_to).toBe(daysAgo(12));
  });
});

// =============================================================================
// 4. WINDOW MODE: Canonical sliceDSL
// =============================================================================

describe('Window Mode: Canonical sliceDSL', () => {
  
  it('sliceDSL format is window(<from>:<to>)', () => {
    const existing = [windowValue({ startDaysAgo: 20, endDaysAgo: 15 })];
    const newTimeSeries = makeTimeSeries(12, 10);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(12), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // sliceDSL should be canonical format
    expect(merged.sliceDSL).toMatch(/^window\(\d+-[A-Z][a-z]{2}-\d+:\d+-[A-Z][a-z]{2}-\d+\)$/);
    expect(merged.sliceDSL).toBe(`window(${merged.window_from}:${merged.window_to})`);
  });
  
  it('sliceDSL includes context suffix when present', () => {
    const existing = [windowValue({ startDaysAgo: 20, endDaysAgo: 15, context: 'channel=organic' })];
    const newTimeSeries = makeTimeSeries(12, 10);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(12), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      'context(channel=organic)'
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // Verify sliceDSL contains context info
    expect(merged.sliceDSL).toContain('context(');
    expect(merged.sliceDSL).toContain('channel=organic');
    // Format: window(<from>:<to>).<context_dims>
    expect(merged.sliceDSL).toMatch(/^window\([^)]+\)\.context\(/);
  });
  
  it('sliceDSL is stable on repeated merges with same data', () => {
    // Idempotence check
    let values: ParameterValue[] = [];
    const timeSeries = makeTimeSeries(20, 15);
    
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(20), end: daysAgo(15) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const firstSliceDSL = values[0].sliceDSL;
    
    // Merge same data again
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(20), end: daysAgo(15) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    // sliceDSL should be identical
    expect(values[0].sliceDSL).toBe(firstSliceDSL);
  });
});

// =============================================================================
// 5. COHORT MODE: Merge into Single Slice
// =============================================================================

describe('Cohort Mode: Merge into Single Slice', () => {
  
  it('merges new data into existing cohort slice for same family', () => {
    // Multiple existing cohort values
    const existing: ParameterValue[] = [
      cohortValue({ dates: [daysAgo(90), daysAgo(85)] }),
      cohortValue({ dates: [daysAgo(80), daysAgo(75)] }),
      cohortValue({ dates: [daysAgo(70), daysAgo(65)] }),
    ];
    
    // New cohort fetch
    const newTimeSeries = makeTimeSeries(60, 55);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(60), end: daysAgo(55) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { isCohortMode: true }
    );
    
    // Should have EXACTLY ONE cohort value (merged)
    const cohortValues = result.filter(v => isCohortModeValue(v));
    expect(cohortValues.length).toBe(1);
    
    // It should be MERGED: earliest from existing, latest from new
    expect(cohortValues[0].cohort_from).toBe(daysAgo(90)); // Earliest from existing
    expect(cohortValues[0].cohort_to).toBe(daysAgo(55));   // Latest from new fetch
  });
  
  it('preserves window values when replacing cohort', () => {
    // Mix of window and cohort values
    const existing: ParameterValue[] = [
      windowValue({ startDaysAgo: 30, endDaysAgo: 20 }),
      cohortValue({ dates: [daysAgo(90), daysAgo(80)] }),
    ];
    
    // New cohort fetch
    const newTimeSeries = makeTimeSeries(70, 60);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(70), end: daysAgo(60) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { isCohortMode: true }
    );
    
    // Should have: 1 window (unchanged) + 1 cohort (new)
    const windowValues = result.filter(v => !isCohortModeValue(v));
    const cohortValues = result.filter(v => isCohortModeValue(v));
    
    expect(windowValues.length).toBe(1);
    expect(cohortValues.length).toBe(1);
    
    // Window unchanged
    expect(windowValues[0].window_from).toBe(daysAgo(30));
  });
  
  it('only merges cohorts for matching context family', () => {
    // Cohorts for two different contexts
    const existing: ParameterValue[] = [
      cohortValue({ dates: [daysAgo(90), daysAgo(80)], context: 'geo=UK' }),
      cohortValue({ dates: [daysAgo(90), daysAgo(80)], context: 'geo=US' }),
    ];
    
    // New cohort for UK only
    const newTimeSeries = makeTimeSeries(70, 60);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(70), end: daysAgo(60) },
      undefined,
      undefined,
      undefined,
      'api',
      'context(geo=UK)',
      { isCohortMode: true }
    );
    
    // Should have: 1 merged UK cohort + 1 unchanged US cohort
    expect(result.length).toBe(2);
    
    const ukCohort = result.find(v => v.sliceDSL?.includes('geo=UK'));
    const usCohort = result.find(v => v.sliceDSL?.includes('geo=US'));
    
    expect(ukCohort!.cohort_from).toBe(daysAgo(90)); // Merged: earliest from existing
    expect(ukCohort!.cohort_to).toBe(daysAgo(60));   // Merged: latest from new
    expect(usCohort!.cohort_from).toBe(daysAgo(90)); // Unchanged
  });
});

// =============================================================================
// 6. COHORT MODE: Canonical sliceDSL with Anchor
// =============================================================================

describe('Cohort Mode: sliceDSL with Anchor', () => {
  
  it('sliceDSL includes anchor_node_id from latencyConfig', () => {
    const existing: ParameterValue[] = [];
    const newTimeSeries = makeTimeSeries(60, 55);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(60), end: daysAgo(55) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { 
        isCohortMode: true,
        latencyConfig: { anchor_node_id: 'my-anchor-node' },
      }
    );
    
    const cohort = result.find(v => isCohortModeValue(v))!;
    
    expect(cohort.sliceDSL).toContain('my-anchor-node');
    expect(cohort.sliceDSL).toBe(
      `cohort(my-anchor-node,${daysAgo(60)}:${daysAgo(55)})`
    );
  });
  
  it('sliceDSL omits anchor when not provided', () => {
    const existing: ParameterValue[] = [];
    const newTimeSeries = makeTimeSeries(60, 55);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(60), end: daysAgo(55) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { isCohortMode: true }
    );
    
    const cohort = result.find(v => isCohortModeValue(v))!;
    
    // Should still have cohort() format but no anchor prefix
    expect(cohort.sliceDSL).toMatch(/^cohort\(\d+-[A-Z][a-z]{2}-\d+:\d+-[A-Z][a-z]{2}-\d+\)$/);
  });
  
  it('sliceDSL includes context after anchor', () => {
    const existing: ParameterValue[] = [];
    const newTimeSeries = makeTimeSeries(60, 55);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(60), end: daysAgo(55) },
      undefined,
      undefined,
      undefined,
      'api',
      'context(channel=paid)',
      { 
        isCohortMode: true,
        latencyConfig: { anchor_node_id: 'start-node' },
      }
    );
    
    const cohort = result.find(v => isCohortModeValue(v))!;
    
    // Verify sliceDSL has correct structure
    expect(cohort.sliceDSL).toContain('start-node');
    expect(cohort.sliceDSL).toContain('context(');
    expect(cohort.sliceDSL).toContain('channel=paid');
    expect(cohort.sliceDSL).toMatch(/^cohort\(start-node,[^)]+\)\.context\(/);
  });
});

// =============================================================================
// 7. Forecast and Latency Recomputation
// =============================================================================

describe('Window Mode: Forecast/Latency Recomputation', () => {
  
  it('adds forecast when recomputeForecast is enabled', () => {
    const existing: ParameterValue[] = [];
    const newTimeSeries = makeTimeSeries(30, 10, { withLatency: true });
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(30), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { 
        recomputeForecast: true,
        latencyConfig: { maturity_days: 7 },
      }
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // Should have forecast field
    expect((merged as any).forecast).toBeDefined();
    expect(typeof (merged as any).forecast).toBe('number');
  });
  
  it('does NOT add latency at merge time (latency computed in graph-level topo pass)', () => {
    // NOTE: Per current design, LAG stats (completeness, t95, blended p) are computed
    // exclusively in the graph-level topo pass (enhanceGraphLatencies), NOT during merge.
    // This test verifies the current (correct) behavior.
    const existing: ParameterValue[] = [];
    const newTimeSeries = makeTimeSeries(30, 10, { withLatency: true });
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(30), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { 
        recomputeForecast: true,
        latencyConfig: { maturity_days: 7 },
      }
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // Latency is NOT added during merge - it's computed in the topo pass
    // The merge function only handles forecast (baseline p_infinity)
    expect((merged as any).latency).toBeUndefined();
    // But forecast SHOULD be present
    expect((merged as any).forecast).toBeDefined();
  });
  
  it('does not add forecast when recomputeForecast is false', () => {
    const existing: ParameterValue[] = [];
    const newTimeSeries = makeTimeSeries(30, 10);
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      newTimeSeries,
      { start: daysAgo(30), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { recomputeForecast: false }
    );
    
    const merged = result.find(v => !isCohortModeValue(v))!;
    
    // Should NOT have forecast field (unless it was already there)
    expect((merged as any).forecast).toBeUndefined();
  });
  
  it('forecast recomputation is idempotent on repeated merges', () => {
    let values: ParameterValue[] = [];
    const timeSeries = makeTimeSeries(30, 10, { withLatency: true });
    
    // First merge
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(30), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { 
        recomputeForecast: true,
        latencyConfig: { maturity_days: 7 },
      }
    );
    
    const firstForecast = (values[0] as any).forecast;
    expect(firstForecast).toBeDefined();
    
    // Second merge with same data
    values = mergeTimeSeriesIntoParameter(
      values,
      timeSeries,
      { start: daysAgo(30), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      '',
      { 
        recomputeForecast: true,
        latencyConfig: { maturity_days: 7 },
      }
    );
    
    // Forecast should be stable (latency is computed in topo pass, not here)
    expect((values[0] as any).forecast).toBeCloseTo(firstForecast, 5);
  });
});

// =============================================================================
// 8. Aggregate Totals (n, k, mean)
// =============================================================================

describe('Aggregate Totals Consistency', () => {
  
  it('n equals sum of n_daily', () => {
    const existing: ParameterValue[] = [];
    const timeSeries = makeTimeSeries(20, 10, { n: 100, k: 50 });
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      timeSeries,
      { start: daysAgo(20), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result[0];
    const sumN = merged.n_daily!.reduce((a, b) => a + b, 0);
    
    expect(merged.n).toBe(sumN);
  });
  
  it('k equals sum of k_daily', () => {
    const existing: ParameterValue[] = [];
    const timeSeries = makeTimeSeries(20, 10, { n: 100, k: 50 });
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      timeSeries,
      { start: daysAgo(20), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result[0];
    const sumK = merged.k_daily!.reduce((a, b) => a + b, 0);
    
    expect(merged.k).toBe(sumK);
  });
  
  it('mean equals k/n (rounded to 3 decimal places)', () => {
    const existing: ParameterValue[] = [];
    const timeSeries = makeTimeSeries(20, 10, { n: 100, k: 47 }); // Produces 0.47 mean
    
    const result = mergeTimeSeriesIntoParameter(
      existing,
      timeSeries,
      { start: daysAgo(20), end: daysAgo(10) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = result[0];
    const expectedMean = Math.round((merged.k! / merged.n!) * 1000) / 1000;
    
    expect(merged.mean).toBe(expectedMean);
  });
  
  it('aggregate totals remain consistent after multiple overlapping merges', () => {
    // Start with one range
    let values = mergeTimeSeriesIntoParameter(
      [],
      makeTimeSeries(30, 25, { n: 100, k: 40 }),
      { start: daysAgo(30), end: daysAgo(25) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    // Merge overlapping data (27-22) with different n/k
    values = mergeTimeSeriesIntoParameter(
      values,
      makeTimeSeries(27, 22, { n: 150, k: 75 }),
      { start: daysAgo(27), end: daysAgo(22) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    // Merge another overlapping range (24-18)
    values = mergeTimeSeriesIntoParameter(
      values,
      makeTimeSeries(24, 18, { n: 200, k: 80 }),
      { start: daysAgo(24), end: daysAgo(18) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = values[0];
    
    // Invariants must hold regardless of merge history
    const sumN = merged.n_daily!.reduce((a, b) => a + b, 0);
    const sumK = merged.k_daily!.reduce((a, b) => a + b, 0);
    
    expect(merged.n).toBe(sumN);
    expect(merged.k).toBe(sumK);
    expect(merged.mean).toBe(Math.round((sumK / sumN) * 1000) / 1000);
    
    // Also verify window bounds match actual dates
    expect(merged.window_from).toBe(merged.dates![0]);
    expect(merged.window_to).toBe(merged.dates![merged.dates!.length - 1]);
  });
  
  it('window_from/window_to are consistent with dates array after gap-filling merge', () => {
    // Create disjoint ranges
    let values = mergeTimeSeriesIntoParameter(
      [],
      makeTimeSeries(30, 28, { n: 100, k: 50 }),
      { start: daysAgo(30), end: daysAgo(28) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    values = mergeTimeSeriesIntoParameter(
      values,
      makeTimeSeries(20, 18, { n: 100, k: 50 }),
      { start: daysAgo(20), end: daysAgo(18) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    // Fill the gap
    values = mergeTimeSeriesIntoParameter(
      values,
      makeTimeSeries(27, 21, { n: 100, k: 50 }),
      { start: daysAgo(27), end: daysAgo(21) },
      undefined,
      undefined,
      undefined,
      'api',
      ''
    );
    
    const merged = values[0];
    
    // window_from should be oldest date
    expect(merged.window_from).toBe(daysAgo(30));
    // window_to should be newest date
    expect(merged.window_to).toBe(daysAgo(18));
    // These should match dates array endpoints
    expect(merged.window_from).toBe(merged.dates![0]);
    expect(merged.window_to).toBe(merged.dates![merged.dates!.length - 1]);
  });
});

