import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeTimeSeriesIntoParameter } from '../windowAggregationService';
import type { ParameterValue } from '../../types/parameterData';

describe('mergeTimeSeriesIntoParameter - duplicate slice robustness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-09T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('window mode: when duplicate window() slices exist for same dims, the most recent slice wins on overlapping dates', () => {
    const older: ParameterValue = {
      mean: 0.1,
      n: 10,
      k: 1,
      dates: ['1-Nov-25'],
      n_daily: [10],
      k_daily: [1],
      window_from: '1-Nov-25',
      window_to: '1-Nov-25',
      sliceDSL: 'window(1-Nov-25:1-Nov-25).context(geo=UK)',
      data_source: { type: 'amplitude', retrieved_at: '2025-12-01T00:00:00Z' },
    };

    const newer: ParameterValue = {
      mean: 0.1,
      n: 20,
      k: 2,
      dates: ['1-Nov-25'],
      n_daily: [20],
      k_daily: [2],
      window_from: '1-Nov-25',
      window_to: '1-Nov-25',
      sliceDSL: 'window(1-Nov-25:1-Nov-25).context(geo=UK)',
      data_source: { type: 'amplitude', retrieved_at: '2025-12-02T00:00:00Z' },
    };

    const out = mergeTimeSeriesIntoParameter(
      // Order intentionally “wrong”: older first, newer second.
      [older, newer],
      // New fetch does NOT include 1-Nov-25; we’re testing how existing duplicates are reconciled.
      [{ date: '2025-11-02T00:00:00Z', n: 5, k: 1, p: 0.2 }],
      { start: '2025-11-02T00:00:00Z', end: '2025-11-02T00:00:00Z' },
      'sig',
      undefined,
      undefined,
      'amplitude',
      'window(1-Nov-25:2-Nov-25).context(geo=UK)',
      { isCohortMode: false }
    );

    expect(out.length).toBe(1);
    const merged = out[0];
    expect(merged.sliceDSL).toContain('window(');
    expect(merged.dates).toEqual(['1-Nov-25', '2-Nov-25']);
    expect(merged.n_daily).toEqual([20, 5]);
    expect(merged.k_daily).toEqual([2, 1]);
  });

  it('cohort mode: when duplicate cohort() slices exist for same dims, the most recent slice wins on overlapping dates and union is preserved', () => {
    const older: ParameterValue = {
      mean: 0.1,
      n: 10,
      k: 1,
      dates: ['1-Nov-25'],
      n_daily: [10],
      k_daily: [1],
      cohort_from: '1-Nov-25',
      cohort_to: '1-Nov-25',
      sliceDSL: 'cohort(household-created,1-Nov-25:1-Nov-25).context(geo=UK)',
      data_source: { type: 'amplitude', retrieved_at: '2025-12-01T00:00:00Z' },
    };

    const newer: ParameterValue = {
      mean: 0.1,
      n: 20,
      k: 2,
      dates: ['1-Nov-25', '3-Nov-25'],
      n_daily: [20, 7],
      k_daily: [2, 1],
      cohort_from: '1-Nov-25',
      cohort_to: '3-Nov-25',
      sliceDSL: 'cohort(household-created,1-Nov-25:3-Nov-25).context(geo=UK)',
      data_source: { type: 'amplitude', retrieved_at: '2025-12-02T00:00:00Z' },
    };

    const out = mergeTimeSeriesIntoParameter(
      // Order intentionally “wrong”: older first, newer second.
      [older, newer],
      // New fetch adds a non-overlapping date to ensure the merge path executes.
      [{ date: '2025-11-02T00:00:00Z', n: 5, k: 1, p: 0.2 }],
      { start: '2025-11-02T00:00:00Z', end: '2025-11-02T00:00:00Z' },
      'sig',
      undefined,
      undefined,
      'amplitude',
      'cohort(household-created,1-Nov-25:3-Nov-25).context(geo=UK)',
      { isCohortMode: true, latencyConfig: { anchor_node_id: 'household-created' } as any }
    );

    expect(out.length).toBe(1);
    const merged = out[0];
    expect(merged.sliceDSL).toContain('cohort(');
    // Union of dates, with 1-Nov taken from NEWER slice (n=20, k=2).
    expect(merged.dates).toEqual(['1-Nov-25', '2-Nov-25', '3-Nov-25']);
    expect(merged.n_daily).toEqual([20, 5, 7]);
    expect(merged.k_daily).toEqual([2, 1, 1]);
  });
});


